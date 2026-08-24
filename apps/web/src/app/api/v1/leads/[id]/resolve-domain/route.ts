import { z } from "zod";

import type { ApiError } from "@asi/contracts";
import {
  LeadNotResolvableError,
  LeadNotFoundError,
  resolveLeadDomain,
  type DomainJudge,
  type DomainProber,
  type IdentityJudgment,
  type LeadDomainDeps,
  type ResolutionLogger,
} from "@asi/database";
import { getDatabase } from "@asi/database/client";
import { OpenRouterClient, SafeFetchError, safeFetchUrl } from "@asi/research";
import type { NextRequest } from "next/server";

import { jsonError, jsonSuccess, jsonValue } from "@/lib/api";
import { requireRole, verifyCsrfRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

// ---------------------------------------------------------------------------
// Prober: SSRF-safe homepage fetch → identity-relevant plain text.
// ---------------------------------------------------------------------------

/** Identity text is capped so model prompts and overlap math stay bounded. */
const MAX_IDENTITY_TEXT_CHARS = 2_000;
/** Hard cap on fetched HTML considered per page (safe-fetch allows 5 MiB). */
const MAX_HTML_BYTES = 256 * 1024;

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script/giu, " ")
    .replace(/<style[\s\S]*?<\/style/giu, " ")
    .replace(/<[^>]+>/gu, " ");
}

function collapse(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function matchAll(html: string, pattern: RegExp): string[] {
  const out: string[] = [];
  for (const match of html.matchAll(pattern)) {
    const text = collapse(decodeEntities(match[1] ?? ""));
    if (text.length > 0) out.push(text);
  }
  return out;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#0?39;/gu, "'")
    .replace(/&nbsp;/giu, " ");
}

/**
 * Homepage → identity text: title + meta description + h1/h2 first (~2000
 * chars); falls back to stripped body text for JS-shell pages whose markup
 * carries nothing else.
 */
export function homepageIdentityText(html: string): string {
  const parts = [
    ...matchAll(html, /<title[^>]*>([\s\S]*?)<\/title/giu),
    ...matchAll(
      html,
      /<meta[^>]+name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)["']/giu,
    ),
    ...matchAll(html, /<meta[^>]+content\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']description["']/giu),
    ...matchAll(html, /<h1[^>]*>([\s\S]*?)<\/h1/giu),
    ...matchAll(html, /<h2[^>]*>([\s\S]*?)<\/h2/giu),
  ];
  const focused = collapse(parts.join(" ")).slice(0, MAX_IDENTITY_TEXT_CHARS);
  if (focused.length >= 40) return focused;
  return collapse(stripTags(html)).slice(0, MAX_IDENTITY_TEXT_CHARS);
}

class SafeFetchDomainProber implements DomainProber {
  async fetchText(url: string) {
    try {
      // 10s ceiling comes from the operator signal below; safe-fetch itself
      // aborts at 15s but the faster deadline wins.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      let result;
      try {
        result = await safeFetchUrl(url, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      return {
        ok: true as const,
        finalUrl: result.finalUrl,
        text: homepageIdentityText(result.content.slice(0, MAX_HTML_BYTES)),
      };
    } catch (error) {
      if (error instanceof SafeFetchError) return { ok: false as const, error: error.code };
      if (error instanceof Error && error.name === "AbortError") {
        return { ok: false as const, error: "timeout" };
      }
      return { ok: false as const, error: "network_error" };
    }
  }
}

// ---------------------------------------------------------------------------
// Judge/proposer: OpenRouter prompt-contract + one fence-repair retry.
//
// The gateway's structured-output enforcement is provider-dependent; models
// that ignore `json_schema` still answer the PROMPT contract, and the client's
// parse layer repairs fenced JSON. Like planner-step, each call uses
// maxAttempts:1 and retry/repair policy stays owned here; cost goes to the
// console (not model_usage) for v1.
// ---------------------------------------------------------------------------

const proposedDomainsSchema = z.strictObject({
  domains: z.array(z.string().min(3)).max(5),
});

const identityJudgmentSchema = z.strictObject({
  matches: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(500),
});

const PROPOSE_SYSTEM_PROMPT =
  "You propose candidate website domains for an industrial company named by " +
  "the user. Small manufacturers frequently use compact forms, so cover " +
  "DIFFERENT styles across your proposals: the full word-mark (all words " +
  "joined), an initialism/acronym (initials joined, optionally prefixed by " +
  "the company's first word, e.g. \"York Precision Machining Hydraulics\" → " +
  "ypmh.com or yorkpmh.com), and one other plausible variant. Reply with " +
  "exactly ONE raw JSON object (no prose, no markdown fences) of shape " +
  '{"domains":["example.com", ...]} containing at most 3 plausible domains, ' +
  "most likely first. Never invent subdomains or paths.";

const JUDGE_SYSTEM_PROMPT =
  "You decide whether a fetched webpage belongs to the company named by the " +
  "user. Reply with exactly ONE raw JSON object (no prose, no markdown " +
  'fences) of shape {"matches":boolean,"confidence":number,"reason":string} ' +
  "where confidence is between 0 and 1. Be conservative: only matches=true " +
  "when the page clearly represents that specific company.";

interface ModelRuntime {
  readonly client: OpenRouterClient;
  readonly models: { readonly fast: string; readonly deep: string; readonly fallback: string };
}

function modelRuntime(): ModelRuntime | null {
  try {
    const client = new OpenRouterClient(process.env.OPENROUTER_API_KEY ?? "");
    return {
      client,
      models: {
        fast: process.env.OPENROUTER_MODEL_FAST ?? "openai/gpt-4.1-mini",
        deep: process.env.OPENROUTER_MODEL_DEEP ?? "openai/gpt-4.1",
        fallback: process.env.OPENROUTER_MODEL_FALLBACK ?? "anthropic/claude-sonnet-4",
      },
    };
  } catch {
    return null;
  }
}

/** One prompt-contract call: maxAttempts 1 here, exactly one repair retry outside. */
async function callModel<T>(
  runtime: ModelRuntime,
  schema: z.ZodType<T>,
  schemaName: string,
  systemPrompt: string,
  prompt: string,
): Promise<{ data: T; costUsd: number }> {
  const result = await runtime.client.generateStructured({
    route: "fast",
    models: runtime.models,
    schemaName,
    schema,
    systemPrompt,
    prompt,
    temperature: 0,
    maxOutputTokens: 512,
    maxAttempts: 1,
  });
  return { data: result.data, costUsd: result.telemetry.costUsd ?? 0 };
}

async function callWithRepair<T>(
  runtime: ModelRuntime,
  schema: z.ZodType<T>,
  schemaName: string,
  systemPrompt: string,
  prompt: string,
): Promise<T | null> {
  let lastError = "";
  let costUsd = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const fullPrompt =
      attempt === 0
        ? prompt
        : `${prompt}\n\nREPAIR: your previous reply failed validation (${lastError}). Reply again with exactly one raw JSON object matching the required shape.`;
    try {
      const result = await callModel(runtime, schema, schemaName, systemPrompt, fullPrompt);
      costUsd += result.costUsd;
      console.log(
        `[resolve-domain] ${schemaName} ok after ${attempt + 1} attempt(s), cost=$${costUsd.toFixed(6)}`,
      );
      return result.data;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  console.log(`[resolve-domain] ${schemaName} unusable after repair: ${lastError}`);
  return null;
}

class OpenRouterDomainJudge implements DomainJudge {
  constructor(private readonly runtime: ModelRuntime) {}

  async proposeDomains(leadName: string, locationHint?: string | null): Promise<string[]> {
    const prompt =
      `Company name: ${leadName}` +
      (locationHint === null || locationHint === undefined || locationHint.length === 0
        ? ""
        : `\nLocation hint: ${locationHint}`) +
      "\nPropose its most likely official website domains.";
    const parsed = await callWithRepair(
      this.runtime,
      proposedDomainsSchema,
      "lead_domain_proposal_v1",
      PROPOSE_SYSTEM_PROMPT,
      prompt,
    );
    return parsed?.domains ?? [];
  }

  async judgeIdentity(leadName: string, pageText: string): Promise<IdentityJudgment> {
    const prompt =
      `Company name: ${leadName}\n\nWebpage text:\n"""\n${pageText}\n"""` +
      "\nDoes this page represent that specific company?";
    const parsed = await callWithRepair(
      this.runtime,
      identityJudgmentSchema,
      "lead_identity_judgment_v1",
      JUDGE_SYSTEM_PROMPT,
      prompt,
    );
    // Conservative anti-fabrication default: no usable judgment ⇒ no match.
    return parsed ?? { matches: false, confidence: 0, reason: "identity judge unavailable" };
  }
}

const consoleLogger: ResolutionLogger = {
  debug: (message, meta) => console.debug(`[resolve-domain] ${message}`, meta ?? ""),
  info: (message, meta) => console.info(`[resolve-domain] ${message}`, meta ?? ""),
  warn: (message, meta) => console.warn(`[resolve-domain] ${message}`, meta ?? ""),
};

/** Production deps wired in the route layer where @asi/research is importable. */
export function buildDomainDeps(): LeadDomainDeps | null {
  const runtime = modelRuntime();
  if (runtime === null) return null;
  return {
    prober: new SafeFetchDomainProber(),
    judge: new OpenRouterDomainJudge(runtime),
    logger: consoleLogger,
  };
}

// ---------------------------------------------------------------------------
// POST /api/v1/leads/[id]/resolve-domain
// ---------------------------------------------------------------------------

const resolveDomainBodySchema = z.strictObject({
  force: z.boolean().optional(),
});

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  try {
    await requireRole("analyst", "admin");
    await verifyCsrfRequest(request);

    const id = z.string().uuid().safeParse((await context.params).id);
    if (!id.success) {
      return jsonError("validation_failed", "Invalid lead id", 400);
    }
    const body = resolveDomainBodySchema.safeParse(await request.json().catch(() => ({})));
    if (!body.success) {
      return jsonError("validation_failed", "Invalid payload", 400, body.error.flatten());
    }

    const deps = buildDomainDeps();
    if (deps === null) {
      return jsonError("internal_error", "Domain resolution model access is not configured", 503);
    }

    const result = await resolveLeadDomain(getDatabase(), id.data, deps, {
      ...(body.data.force === undefined ? {} : { force: body.data.force }),
    });

    if (result.outcome === "already_resolved") {
      return jsonError(
        "conflict",
        "Lead is already resolved",
        409,
        jsonValue(result) as ApiError["details"],
      );
    }
    return jsonSuccess(jsonValue(result), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof LeadNotFoundError) {
      return jsonError("not_found", error.message, 404);
    }
    if (error instanceof LeadNotResolvableError) {
      return jsonError("conflict", error.message, 409);
    }
    return jsonError("internal_error", "An internal error occurred", 500);
  }
}
