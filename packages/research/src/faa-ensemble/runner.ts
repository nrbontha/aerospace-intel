/**
 * FAA two-model ensemble screening core (library).
 *
 * Owns every piece of ensemble logic: config, evidence packages, prompts,
 * the ensemble rule, candidate selection, model invocation, persistence,
 * metrics, and orchestration. `scripts/run-faa-ensemble.mts` is a thin CLI
 * wrapper (arg parsing + main) that re-exports this module.
 *
 * Decision enum (`reject | research | high_priority`) and prompt-version
 * constants are shared with `./schemas.js` / `./prompts.js` via re-export —
 * never duplicated here. The evaluator/adjudicator payload schemas below
 * are the runner's wire contract (loose string fields); they intentionally
 * differ from the graded spec schemas in `./schemas.js`.
 *
 * NO-DEFAULT RULE: when both evaluator outcomes are null and no adjudicated
 * decision exists, the error evaluations are persisted but NO
 * `faa_ensemble_results` row is written (the signal stays retryable). Such
 * signals count as `metrics.skippedNoJudgment`. Research-default rows are
 * never written without a successful eval.
 */
import { z } from "zod";

import { ensembleDecisionSchema, type EnsembleDecision } from "./schemas.js";

import { getDatabase, type Database } from "@asi/database";
import { sql } from "drizzle-orm";
import { OpenRouterClient } from "../openrouter.js";
import { callJev, JEV_MODEL } from "./jev.js";
import {
  EMPTY_WEBSITE_EVIDENCE,
  WEBSITE_EVIDENCE_EXTRACTION_METHOD,
  WEBSITE_EVIDENCE_METADATA_KEYS,
  type WebsiteEvidence,
  type WebsiteOffering,
} from "../enrichment/website.js";

export { ensembleDecisionSchema, type EnsembleDecision };
import {
  FAA_ADJUDICATOR_PROMPT_VERSION,
  FAA_QUALIFICATION_PROMPT_VERSION,
} from "./prompts.js";
export { FAA_ADJUDICATOR_PROMPT_VERSION };
export const FAA_EVALUATOR_PROMPT_VERSION = FAA_QUALIFICATION_PROMPT_VERSION;
// ---------------------------------------------------------------------------
// Shared contract constants (MUST match EnsembleClient / EnsembleSchema)
// ---------------------------------------------------------------------------
export const DEFAULT_FAA_MODEL_A = "meta/muse-spark-1.3-contributor";
export const DEFAULT_FAA_MODEL_B = "meta/muse-spark-1.3-contributor";
export const FAA_PMA_SOURCE_KEY = "faa_pma_database";
export const DEFAULT_FAA_STATUS = "queued_qualification";
export const DEFAULT_FAA_CONCURRENCY = 5;
export const DEFAULT_FAA_REQUEST_DELAY_MS = 8000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const RATE_LIMIT_MAX_RETRIES = 5;
export const RATE_LIMIT_BASE_DELAY_MS = 30_000;
export const RATE_LIMIT_MAX_DELAY_MS = 300_000;

export function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /rate[.\s-]*limit|429|quota|temporarily throttled/i.test(message);
}

function rateLimitDelayMs(retryIndex: number): number {
  const capped = Math.min(
    RATE_LIMIT_MAX_DELAY_MS,
    RATE_LIMIT_BASE_DELAY_MS * 2 ** Math.max(0, retryIndex),
  );
  return Math.floor(capped / 2 + Math.random() * (capped / 2));
}
export async function withRateLimitPatience<T>(
  call: () => Promise<T>,
  sleepFn: (ms: number) => Promise<void> = sleep,
): Promise<T> {
  let retryIndex = 0;
  for (;;) {
    try {
      return await call();
    } catch (error) {
      if (!isRateLimitError(error) || retryIndex >= RATE_LIMIT_MAX_RETRIES) {
        throw error;
      }
      await sleepFn(rateLimitDelayMs(retryIndex));
      retryIndex += 1;
    }
  }
}

export interface FaaEnsembleConfig {
  readonly modelA: string;
  readonly modelB: string;
  readonly adjudicatorModel: string;
  readonly concurrency: number;
  readonly requestDelayMs: number;
  /** JEv cheap pre-screen before any Muse call. Env JEV_PRESCREEN, default on. */
  readonly jevPrescreen: boolean;
  /** JEv model id. Env FAA_JEV_MODEL, default typesafe/jev-1.13. */
  readonly jevModel: string;
  /** JEv reject confidence at/above which one Muse call confirms. Default 0.85. */
  readonly jevRejectConfirmThreshold: number;
  /** Fraction of JEv-fast-path signals routed to full Muse screening anyway. Default 0.05. */
  readonly jevAuditSampleRate: number;
}

export function resolveEnsembleConfig(
  env: NodeJS.ProcessEnv = process.env,
): FaaEnsembleConfig {
  const modelA =
    env["FAA_MODEL_A"]?.trim() === undefined ||
    (env["FAA_MODEL_A"] ?? "").trim() === ""
      ? DEFAULT_FAA_MODEL_A
      : (env["FAA_MODEL_A"] ?? "").trim();
  const modelB =
    (env["FAA_MODEL_B"] ?? "").trim() === ""
      ? DEFAULT_FAA_MODEL_B
      : (env["FAA_MODEL_B"] ?? "").trim();
  const adjudicatorModel =
    (env["FAA_ADJUDICATOR_MODEL"] ?? "").trim() === ""
      ? modelA
      : (env["FAA_ADJUDICATOR_MODEL"] ?? "").trim();
  const rawConcurrency = (env["FAA_QUALIFICATION_CONCURRENCY"] ?? "").trim();
  const parsed = rawConcurrency === "" ? Number.NaN : Number(rawConcurrency);
  const concurrency =
    Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_FAA_CONCURRENCY;
  const rawDelay = (env["FAA_REQUEST_DELAY_MS"] ?? "").trim();
  const parsedDelay = rawDelay === "" ? Number.NaN : Number(rawDelay);
  const requestDelayMs =
    Number.isInteger(parsedDelay) && parsedDelay >= 0
      ? parsedDelay
      : DEFAULT_FAA_REQUEST_DELAY_MS;
  const jevPrescreen = (env["JEV_PRESCREEN"] ?? "true").trim() !== "false";
  const jevModel =
    (env["FAA_JEV_MODEL"] ?? "").trim() === ""
      ? JEV_MODEL
      : (env["FAA_JEV_MODEL"] ?? "").trim();
  const rejectThreshold = Number(env["JEV_REJECT_CONFIRM_THRESHOLD"] ?? "");
  const jevRejectConfirmThreshold =
    rejectThreshold >= 0 && rejectThreshold <= 1 ? rejectThreshold : 0.85;
  const auditRate = Number(env["JEV_AUDIT_SAMPLE_RATE"] ?? "");
  const jevAuditSampleRate =
    auditRate >= 0 && auditRate <= 1 ? auditRate : 0.05;
  return {
    modelA,
    modelB,
    adjudicatorModel,
    concurrency,
    requestDelayMs,
    jevPrescreen,
    jevModel,
    jevRejectConfirmThreshold,
    jevAuditSampleRate,
  };
}

// ---------------------------------------------------------------------------
// Schemas (decision enum everywhere: reject | research | high_priority)
// ---------------------------------------------------------------------------
const investorFeedbackShape = {
  proprietary_product_evidence: z
    .enum(["none", "weak", "strong"])
    .default("none"),
  proprietary_process_only: z.boolean().default(false),
  website_products_menu: z.boolean().nullable().default(null),
  size_indicators: z.array(z.string()).default([]),
  likely_oversize: z.boolean().default(false),
  suggested_priority: z
    .union([z.literal(1), z.literal(2), z.literal(3)])
    .default(3),
};

export const evaluatorResultSchema = z.object({
  decision: ensembleDecisionSchema,
  confidence: z.number().int().min(0).max(100),
  company_type: z.string().min(1),
  aerospace_defense_relevance: z.string().min(1),
  manufacturing_evidence: z.string().min(1),
  thesis_signals: z.array(z.string()).default([]),
  disqualifiers: z.array(z.string()).default([]),
  missing_evidence: z.array(z.string()).default([]),
  false_negative_risk: z.string().min(1),
  reason: z.string().min(1),
  ...investorFeedbackShape,
});
export type FaaEvaluatorResult = z.infer<typeof evaluatorResultSchema>;

export const adjudicatorResultSchema = z.object({
  decision: ensembleDecisionSchema,
  confidence: z.number().int().min(0).max(100),
  reason: z.string().min(1),
  ...investorFeedbackShape,
});
export type FaaAdjudicatorResult = z.infer<typeof adjudicatorResultSchema>;

// ---------------------------------------------------------------------------
// JEv cheap pre-screen (verified cascade: JEv judges everything at ~$0.00002;
// Muse spends only on JEv-flagged cases plus a random audit sample)
// ---------------------------------------------------------------------------
export const JEV_DISPOSITION_QUESTION = {
  type: "choice",
  instructions:
    "Which pipeline disposition fits this aerospace/defense company as a potential sub-$50M acquisition target?",
  criteria: {
    high_priority:
      "Niche aerospace/defense manufacturer with proprietary manufactured products (patented or branded components, parts, systems; PMA/STC/TSO articles; product catalog) and small private indicators.",
    research:
      "Plausibly relevant aerospace manufacturer, or proprietary PROCESS only (kitting, assembly, repair, services), or key facts missing (ownership, size, website).",
    reject:
      "Clearly outside the thesis: airline, airport, government, university, major prime, obviously large strategic company or its named subsidiary, platform aircraft OEM, pure consultancy/software, distributor without manufacturing, unrelated industry, or dead company.",
  },
} as const;

export const JEV_MANUFACTURER_QUESTION = {
  type: "noul",
  instructions:
    "Does this company manufacture physical aerospace/defense products?",
  criteria: {
    true: "Designs or builds components, assemblies, parts, or systems.",
    false: "Services, distribution, software, or unrelated business only.",
  },
} as const;

export const JEV_OVERSIZE_QUESTION = {
  type: "noul",
  instructions:
    "Is there affirmative evidence this is a major prime, Fortune-scale aerospace group, named subsidiary thereof, or platform aircraft OEM?",
  criteria: {
    true: "Widely-known large strategic, prime, or subsidiary; or whole-aircraft OEM.",
    false: "Small or mid-size supplier, or size unknown.",
  },
} as const;

export interface JevScreenOutcome {
  readonly decision: EnsembleDecision;
  readonly confidence: number;
  readonly costUsd: number | null;
}

function jevChoiceToDecision(choice: unknown): EnsembleDecision | null {
  return choice === "reject" ||
    choice === "research" ||
    choice === "high_priority"
    ? choice
    : null;
}

export async function defaultScreenJev(
  apiKey: string,
  model: string,
  pkg: FaaEvidencePackage,
): Promise<JevScreenOutcome | null> {
  try {
    const result = await callJev(
      apiKey,
      {
        company_name: pkg.name,
        domain: pkg.domain,
        identifiers: { cage: pkg.cage, uei: pkg.uei },
        location: { city: pkg.city, state: pkg.state, country: pkg.country },
        address: pkg.address,
        part_count: pkg.partCount,
        makes: pkg.makes,
        models_sample: pkg.modelsSample,
        latest_supplement_date: pkg.supplementDate,
        guid_url: pkg.guidUrl,
        website_offering: pkg.websiteOffering,
        website_excerpts: pkg.websiteExcerpts,
        ownership_hints: pkg.ownershipHints,
        size_hints: pkg.sizeHints,
      },
      {
        disposition: JEV_DISPOSITION_QUESTION,
        manufacturer: JEV_MANUFACTURER_QUESTION,
        oversize: JEV_OVERSIZE_QUESTION,
      },
      { model },
    );
    const answer = result.answers["disposition"];
    const decision = jevChoiceToDecision(answer?.choice);
    if (decision === null) return null;
    const confidence =
      typeof answer?.confidence === "number"
        ? Math.max(0, Math.min(1, answer.confidence))
        : 0.5;
    return { decision, confidence, costUsd: result.costUsd };
  } catch {
    return null;
  }
}
// ---------------------------------------------------------------------------
// CLI options (parsed by the thin script wrapper; the batch entrypoint below
// maps the shared-contract options onto this shape)
// ---------------------------------------------------------------------------
export interface FaaEnsembleCliOptions {
  readonly limit: number;
  readonly status: string;
  readonly sourceKeys: readonly string[];
  readonly dryRun: boolean;
  readonly sample: number | null;
  readonly concurrency: number;
  readonly delayMs: number | null;
  readonly includeKnown: boolean;
  readonly benchmarkNames: readonly string[];
  readonly failedOnly: boolean;
}

// ---------------------------------------------------------------------------
// Evidence package (compact; from source_signals row + source_payload)
// ---------------------------------------------------------------------------
export interface SourceSignalRowLike {
  readonly id: string;
  readonly [key: string]: unknown;
  readonly raw_name?: unknown;
  readonly rawName?: unknown;
  readonly raw_domain?: unknown;
  readonly rawDomain?: unknown;
  readonly uei?: unknown;
  readonly cage?: unknown;
  readonly city?: unknown;
  readonly state?: unknown;
  readonly country?: unknown;
  readonly award_count?: unknown;
  readonly awardCount?: unknown;
  readonly freshest_award?: unknown;
  readonly freshestAward?: unknown;
  readonly source_payload?: unknown;
  readonly sourcePayload?: unknown;
}

export interface FaaEvidencePackage {
  readonly signalId: string;
  readonly name: string;
  readonly domain: string | null;
  readonly cage: string | null;
  readonly uei: string | null;
  readonly address: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly country: string | null;
  readonly partCount: number | null;
  readonly makes: readonly string[];
  readonly modelsSample: readonly string[];
  readonly supplementDate: string | null;
  readonly guidUrl: string | null;
  /** Official-site offering class (Exa website enrichment; null = unfetched). */
  readonly websiteOffering: WebsiteOffering | null;
  /** Combined website excerpts, capped at 2,000 chars (null = unfetched). */
  readonly websiteExcerpts: string | null;
  /** Ownership-hint excerpts from the official site (about page). */
  readonly ownershipHints: readonly string[];
  /** Size-hint excerpts from the official site (headcount/facility). */
  readonly sizeHints: readonly string[];
}
const MAKES_MAX = 12;
const MODELS_SAMPLE_MAX = 10;

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function asStringList(value: unknown, cap: number): readonly string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed === "" || out.includes(trimmed)) continue;
    out.push(trimmed);
    if (out.length >= cap) break;
  }
  return out;
}

export function buildEvidencePackage(
  row: SourceSignalRowLike,
  website: WebsiteEvidence = EMPTY_WEBSITE_EVIDENCE,
): FaaEvidencePackage {
  const payload =
    typeof row.source_payload === "object" && row.source_payload !== null
      ? (row.source_payload as Record<string, unknown>)
      : typeof row.sourcePayload === "object" && row.sourcePayload !== null
        ? (row.sourcePayload as Record<string, unknown>)
        : {};
  const awardCount =
    typeof row.award_count === "number"
      ? row.award_count
      : typeof row.awardCount === "number"
        ? row.awardCount
        : null;
  const freshest =
    asText(row.freshest_award) ?? asText(row.freshestAward) ?? null;
  return {
    signalId: row.id,
    name: asText(row.raw_name) ?? asText(row.rawName) ?? "",
    domain: asText(row.raw_domain) ?? asText(row.rawDomain),
    cage: asText(row.cage),
    uei: asText(row.uei),
    address: asText(payload["address"]),
    city: asText(row.city),
    state: asText(row.state),
    country: asText(row.country),
    partCount: awardCount,
    makes: asStringList(payload["makes"], MAKES_MAX),
    modelsSample: asStringList(
      payload["models_sample"] ?? payload["modelsSample"],
      MODELS_SAMPLE_MAX,
    ),
    supplementDate: asText(payload["latest_supplement_date"]) ?? freshest,
    guidUrl: asText(payload["guid_url"]) ?? asText(payload["guidUrl"]),
    websiteOffering: website.websiteOffering,
    websiteExcerpts: website.excerpts === "" ? null : website.excerpts,
    ownershipHints: website.ownershipHints,
    sizeHints: website.sizeHints,
  };
}

// ---------------------------------------------------------------------------
// Website-evidence lookup (per-signal; no schema changes)
// ---------------------------------------------------------------------------
interface WebsiteEvidenceRow {
  readonly quote: string | null;
  readonly metadata: unknown;
  readonly [key: string]: unknown;
}

function metadataText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function metadataStringList(value: unknown, cap: number): readonly string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed === "" || out.includes(trimmed)) continue;
    out.push(trimmed);
    if (out.length >= cap) break;
  }
  return out;
}

function websiteEvidenceFromRow(
  row: WebsiteEvidenceRow,
): WebsiteEvidence | null {
  if (typeof row.metadata !== "object" || row.metadata === null) {
    const quote = metadataText(row.quote);
    return quote === null
      ? null
      : { ...EMPTY_WEBSITE_EVIDENCE, excerpts: quote.slice(0, 2000) };
  }
  const meta = row.metadata as Record<string, unknown>;
  const offering = metadataText(meta[WEBSITE_EVIDENCE_METADATA_KEYS.offering]);
  const excerpts =
    metadataText(meta[WEBSITE_EVIDENCE_METADATA_KEYS.excerpts]) ??
    metadataText(row.quote);
  if (
    offering === null &&
    excerpts === null &&
    !Array.isArray(meta[WEBSITE_EVIDENCE_METADATA_KEYS.ownershipHints]) &&
    !Array.isArray(meta[WEBSITE_EVIDENCE_METADATA_KEYS.sizeHints])
  ) {
    return null;
  }
  return {
    websiteOffering:
      offering === "products_menu" || offering === "capabilities_only"
        ? offering
        : "unknown",
    excerpts: (excerpts ?? "").slice(0, 2000),
    ownershipHints: metadataStringList(
      meta[WEBSITE_EVIDENCE_METADATA_KEYS.ownershipHints],
      6,
    ),
    sizeHints: metadataStringList(
      meta[WEBSITE_EVIDENCE_METADATA_KEYS.sizeHints],
      6,
    ),
  };
}

/**
 * Load the latest website-enrichment evidence for one signal. Matches rows
 * the scheduler website step wrote (extraction_method =
 * WEBSITE_EVIDENCE_EXTRACTION_METHOD) by official domain in the document
 * URL, or by linked company when a companyId is known. Never throws:
 * missing/ambiguous evidence resolves to EMPTY_WEBSITE_EVIDENCE so screens
 * degrade to "unfetched" instead of failing.
 */
export async function loadWebsiteEvidence(
  db: Database,
  domain: string | null,
  companyId?: string | null,
): Promise<WebsiteEvidence> {
  try {
    const normalizedDomain = metadataText(domain)?.toLowerCase() ?? null;
    const normalizedCompany = metadataText(companyId ?? null);
    if (normalizedDomain === null && normalizedCompany === null) {
      return EMPTY_WEBSITE_EVIDENCE;
    }
    const result = await db.execute<WebsiteEvidenceRow>(sql`
      SELECT e.quote, e.metadata
      FROM evidence e
      JOIN source_documents sd ON sd.id = e.source_document_id
      WHERE e.extraction_method = ${WEBSITE_EVIDENCE_EXTRACTION_METHOD}
        AND (
          (${normalizedDomain} IS NOT NULL
            AND position(${normalizedDomain} in lower(sd.canonical_url)) > 0)
          OR (${normalizedCompany} IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM source_document_links sdl
              WHERE sdl.source_document_id = sd.id
                AND sdl.company_id = ${normalizedCompany}::uuid
            ))
        )
      ORDER BY e.created_at DESC
      LIMIT 8
    `);
    for (const row of result.rows) {
      const parsed = websiteEvidenceFromRow(row);
      if (parsed !== null) return parsed;
    }
    return EMPTY_WEBSITE_EVIDENCE;
  } catch {
    return EMPTY_WEBSITE_EVIDENCE;
  }
}

// ---------------------------------------------------------------------------
// Prompts (high-recall filter: reject ONLY on affirmative negative evidence;
// missing ownership/size/revenue -> research, never reject)
// ---------------------------------------------------------------------------
const HIGH_RECALL_POLICY = `You are a high-recall FAA PMA supplier filter. Reject ONLY on affirmative negative evidence (e.g. the holder is verifiably a distributor with no manufacturing, a foreign shell with no US presence, or the PMA record demonstrably belongs to a different company). Missing ownership, size, or revenue information MUST route to research, NEVER to reject. When in doubt, choose research.`;
const INVESTOR_RULES = `Investor rules: (1) Proprietary PRODUCT (patented/branded manufactured components, parts, systems, PMA/STC/TSO articles) is P1-grade evidence; proprietary PROCESS alone (kitting, assembly methods, repair processes, services) is never product evidence — Priority 2 at best. (2) A Products catalog/menu on the website is a strong fit signal; capabilities/services-only pages with no products lean build-to-print (Priority 3 hopper). No website fetched means research, never reject. (3) Scale from public knowledge: you MAY use widely-known public facts ONLY to recognize obviously large strategics (major primes, Fortune-scale aerospace groups, and their named subsidiaries) — mark likely_oversize, never high_priority on fame, and name the basis; never invent revenue, ownership, or customer facts beyond this. (4) Platform OEMs building whole aircraft are outside the thesis (reject). (5) Suggested priority: 1 = proprietary product + qualification + small/private indicators; 2 = capable manufacturer, no clear proprietary product; 3 = possible surprise or thin evidence.`;

export function buildEvaluatorPrompt(pkg: FaaEvidencePackage): string {
  return `${HIGH_RECALL_POLICY}

${INVESTOR_RULES}

Evidence for one FAA PMA holder (compact JSON):
${JSON.stringify(pkg)}

Decide: is this holder plausibly an aerospace/defense manufacturer worth deeper research (high_priority), a possible manufacturer needing more evidence (research), or affirmatively disqualified (reject)? Reply with exactly one JSON object matching the evaluator schema.`;
}

export const FAA_EVALUATOR_SYSTEM_PROMPT = `You qualify FAA PMA holders as aerospace supplier candidates. ${HIGH_RECALL_POLICY} Output contract: reply with exactly one raw JSON object matching the provided schema. No markdown fences, no prose.`;

export function buildAdjudicatorPrompt(
  pkg: FaaEvidencePackage,
  a: FaaEvaluatorResult | null,
  b: FaaEvaluatorResult | null,
): string {
  return `${HIGH_RECALL_POLICY}

${INVESTOR_RULES}

Two independent evaluators disagreed (or one produced malformed output) for this FAA PMA holder.

Evidence (compact JSON):
${JSON.stringify(pkg)}

Model A verdict: ${a === null ? "MALFORMED/UNAVAILABLE" : JSON.stringify(a)}
Model B verdict: ${b === null ? "MALFORMED/UNAVAILABLE" : JSON.stringify(b)}

Break the tie conservatively: reject ONLY on affirmative negative evidence; otherwise prefer research unless the combined evidence clearly shows an aerospace/defense manufacturer (then high_priority). Reply with exactly one JSON object matching the adjudicator schema.`;
}

export const FAA_ADJUDICATOR_SYSTEM_PROMPT = `You adjudicate disagreements between two FAA PMA holder evaluators. ${HIGH_RECALL_POLICY} Output contract: reply with exactly one raw JSON object matching the provided schema. No markdown fences, no prose.`;

// ---------------------------------------------------------------------------
// Ensemble rule (pure; API failures are errors, NEVER decisions — callers
// pass null for a failed/malformed evaluation)
// ---------------------------------------------------------------------------
export interface EnsembleResolution {
  readonly agreed: boolean;
  readonly adjudicationRequired: boolean;
  readonly finalDecision: EnsembleDecision;
  readonly finalConfidence: number | null;
  readonly reason: string;
}

export function resolveEnsemble(
  a: Pick<FaaEvaluatorResult, "decision" | "confidence"> | null,
  b: Pick<FaaEvaluatorResult, "decision" | "confidence"> | null,
): EnsembleResolution {
  if (a === null || b === null) {
    return {
      agreed: false,
      adjudicationRequired: true,
      finalDecision: "research",
      finalConfidence: null,
      reason: "malformed or missing evaluation requires adjudication",
    };
  }
  if (a.decision === b.decision) {
    return {
      agreed: true,
      adjudicationRequired: false,
      finalDecision: a.decision,
      finalConfidence: Math.max(a.confidence, b.confidence),
      reason: `models agree on ${a.decision}`,
    };
  }
  const pair = new Set([a.decision, b.decision]);
  if (pair.has("research") && pair.has("high_priority")) {
    return {
      agreed: false,
      adjudicationRequired: false,
      finalDecision: "research",
      finalConfidence: Math.min(a.confidence, b.confidence),
      reason:
        "near-agreement defaults to research absent clearly strong combined evidence",
    };
  }
  return {
    agreed: false,
    adjudicationRequired: true,
    finalDecision: "research",
    finalConfidence: null,
    reason: `reject-vs-${a.decision === "reject" ? b.decision : a.decision} requires adjudication`,
  };
}

// ---------------------------------------------------------------------------
// Concurrency (p-limit style worker pool; no external dependency)
// ---------------------------------------------------------------------------
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const workers = Math.max(
    1,
    Math.min(items.length === 0 ? 1 : items.length, Math.floor(limit) || 1),
  );
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results as R[];
}

// ---------------------------------------------------------------------------
// Model invocation (injectable for tests; default hits OpenRouter)
// ---------------------------------------------------------------------------
export type ModelEvalOutcome =
  | {
      readonly ok: true;
      readonly result: FaaEvaluatorResult;
      readonly rawResponse: string;
      readonly tokens: {
        input: number | null;
        output: number | null;
        total: number | null;
      };
      readonly costUsd: number | null;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly rawResponse: string | null;
    };

export type AdjudicatorOutcome =
  | { readonly ok: true; readonly result: FaaAdjudicatorResult }
  | { readonly ok: false; readonly error: string };

async function defaultEvaluateModel(
  client: OpenRouterClient,
  modelId: string,
  pkg: FaaEvidencePackage,
): Promise<ModelEvalOutcome> {
  try {
    const response = await withRateLimitPatience(() =>
      client.generateStructured({
        route: "fast",
        models: { fast: modelId, deep: modelId, fallback: modelId },
        schemaName: FAA_EVALUATOR_PROMPT_VERSION,
        schema: evaluatorResultSchema,
        systemPrompt: FAA_EVALUATOR_SYSTEM_PROMPT,
        prompt: buildEvaluatorPrompt(pkg),
        maxAttempts: 3,
      }),
    );
    return {
      ok: true,
      result: response.data,
      rawResponse: JSON.stringify(response.data),
      tokens: {
        input: response.telemetry.inputTokens,
        output: response.telemetry.outputTokens,
        total: response.telemetry.totalTokens,
      },
      costUsd: response.telemetry.costUsd,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      rawResponse: null,
    };
  }
}

async function defaultAdjudicate(
  client: OpenRouterClient,
  adjudicatorModel: string,
  pkg: FaaEvidencePackage,
  a: FaaEvaluatorResult | null,
  b: FaaEvaluatorResult | null,
): Promise<AdjudicatorOutcome> {
  try {
    const response = await withRateLimitPatience(() =>
      client.generateStructured({
        route: "fast",
        models: {
          fast: adjudicatorModel,
          deep: adjudicatorModel,
          fallback: adjudicatorModel,
        },
        schemaName: FAA_ADJUDICATOR_PROMPT_VERSION,
        schema: adjudicatorResultSchema,
        systemPrompt: FAA_ADJUDICATOR_SYSTEM_PROMPT,
        prompt: buildAdjudicatorPrompt(pkg, a, b),
        maxAttempts: 3,
      }),
    );
    return { ok: true, result: response.data };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Signal selection (resumable; FIFO by creation time)
// ---------------------------------------------------------------------------
function sourceKeyFilter(sourceKeys: readonly string[]) {
  if (sourceKeys.length === 0) return sql``;
  const values = sourceKeys.map((sourceKey) => sql`${sourceKey}`);
  return sql`AND ss.source_key IN (${sql.join(values, sql`, `)})`;
}

export interface CandidateSignalRow extends SourceSignalRowLike {
  readonly id: string;
  readonly created_at: Date | string;
}

export async function selectCandidateSignals(
  db: Database,
  options: FaaEnsembleCliOptions,
): Promise<CandidateSignalRow[]> {
  const trancheCap =
    options.sample ?? (options.limit === 0 ? null : options.limit);
  const base = await db.execute<CandidateSignalRow>(sql`
    SELECT
      ss.id,
      ss.raw_name,
      ss.raw_domain,
      ss.uei,
      ss.cage,
      ss.city,
      ss.state,
      ss.country,
      ss.award_count,
      ss.freshest_award,
      ss.created_at,
      ss.source_payload
    FROM source_signals ss
    WHERE ss.status::text = ${options.status}
      ${sourceKeyFilter(options.sourceKeys)}
      AND NOT EXISTS (
        SELECT 1 FROM faa_ensemble_results r WHERE r.signal_id = ss.id
      )
      ${
        options.failedOnly
          ? sql`AND EXISTS (
              SELECT 1 FROM faa_ensemble_evaluations e
              WHERE e.signal_id = ss.id AND e.error IS NOT NULL
            )`
          : sql``
      }
      ${
        options.includeKnown
          ? sql``
          : sql`AND NOT EXISTS (
              SELECT 1 FROM golden_examples g
              WHERE lower(g.name) = lower(ss.raw_name)
            )
            AND NOT EXISTS (
              SELECT 1 FROM companies c
              WHERE lower(c.legal_name) = lower(ss.raw_name)
            )`
      }
    ORDER BY ss.created_at ASC, ss.id ASC
    ${trancheCap === null ? sql`` : sql`LIMIT ${trancheCap}`}
  `);
  const rows = [...base.rows];
  if (options.benchmarkNames.length > 0) {
    const seen = new Set(rows.map((row) => row.id));
    for (const name of options.benchmarkNames) {
      const matched = await db.execute<CandidateSignalRow>(sql`
        SELECT
          ss.id,
          ss.raw_name,
          ss.raw_domain,
          ss.uei,
          ss.cage,
          ss.city,
          ss.state,
          ss.country,
          ss.award_count,
          ss.freshest_award,
          ss.created_at,
          ss.source_payload
        FROM source_signals ss
        WHERE position(lower(${name}) in lower(ss.raw_name)) > 0
          ${sourceKeyFilter(options.sourceKeys)}
          AND NOT EXISTS (
            SELECT 1 FROM faa_ensemble_results r WHERE r.signal_id = ss.id
          )
        ORDER BY ss.created_at ASC, ss.id ASC
      `);
      for (const row of matched.rows) {
        if (!seen.has(row.id)) {
          seen.add(row.id);
          rows.push(row);
        }
      }
    }
    rows.sort((x, y) => {
      const createdAt =
        x.created_at < y.created_at ? -1 : x.created_at > y.created_at ? 1 : 0;
      return createdAt === 0 ? x.id.localeCompare(y.id) : createdAt;
    });
  }
  return rows;
}

export async function loadKnownNames(db: Database): Promise<Set<string>> {
  const result = await db.execute<{ name: string }>(sql`
    SELECT lower(name) AS name FROM golden_examples
    UNION
    SELECT lower(legal_name) AS name FROM companies
  `);
  return new Set(result.rows.map((row) => row.name));
}

// ---------------------------------------------------------------------------
// Persistence (evaluations + results only; never candidates/leads/status)
// ---------------------------------------------------------------------------
async function persistEvaluation(
  db: Database,
  signalId: string,
  modelId: string,
  outcome: ModelEvalOutcome,
): Promise<void> {
  const result = outcome.ok ? outcome.result : null;
  await db.execute(sql`
    INSERT INTO faa_ensemble_evaluations (
      signal_id, model_id, prompt_version, raw_response, parsed,
      decision, confidence, company_type, aerospace_defense_relevance,
      manufacturing_evidence, thesis_signals, disqualifiers,
      missing_evidence, false_negative_risk, reason, tokens, cost_usd,
      error, retry_count
    ) VALUES (
      ${signalId}, ${modelId}, ${FAA_EVALUATOR_PROMPT_VERSION},
      ${outcome.ok ? outcome.rawResponse : outcome.rawResponse},
      ${result === null ? null : JSON.stringify(result)},
      ${result === null ? null : result.decision},
      ${result === null ? null : result.confidence},
      ${result === null ? null : result.company_type},
      ${result === null ? null : result.aerospace_defense_relevance},
      ${result === null ? null : result.manufacturing_evidence},
      ${result === null ? null : JSON.stringify(result.thesis_signals)},
      ${result === null ? null : JSON.stringify(result.disqualifiers)},
      ${result === null ? null : JSON.stringify(result.missing_evidence)},
      ${result === null ? null : result.false_negative_risk},
      ${result === null ? null : result.reason},
      ${outcome.ok ? JSON.stringify(outcome.tokens) : null},
      ${outcome.ok ? outcome.costUsd : null},
      ${outcome.ok ? null : outcome.error},
      0
    )
    ON CONFLICT (signal_id, model_id, prompt_version) DO UPDATE SET
      raw_response = EXCLUDED.raw_response,
      parsed = EXCLUDED.parsed,
      decision = EXCLUDED.decision,
      confidence = EXCLUDED.confidence,
      company_type = EXCLUDED.company_type,
      aerospace_defense_relevance = EXCLUDED.aerospace_defense_relevance,
      manufacturing_evidence = EXCLUDED.manufacturing_evidence,
      thesis_signals = EXCLUDED.thesis_signals,
      disqualifiers = EXCLUDED.disqualifiers,
      missing_evidence = EXCLUDED.missing_evidence,
      false_negative_risk = EXCLUDED.false_negative_risk,
      reason = EXCLUDED.reason,
      tokens = EXCLUDED.tokens,
      cost_usd = EXCLUDED.cost_usd,
      error = EXCLUDED.error,
      updated_at = now()
  `);
}

/**
 * Persist a JEv screen verdict as an evaluation row (model_id is the JEv
 * model). Other claim columns stay NULL: JEv returns no prose evidence.
 */
async function persistJevEvaluation(
  db: Database,
  signalId: string,
  modelId: string,
  outcome: JevScreenOutcome,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO faa_ensemble_evaluations (
      signal_id, model_id, prompt_version, raw_response, parsed,
      decision, confidence, company_type, aerospace_defense_relevance,
      manufacturing_evidence, thesis_signals, disqualifiers,
      missing_evidence, false_negative_risk, reason, tokens, cost_usd,
      error, retry_count, updated_at
    ) VALUES (
      ${signalId}, ${modelId}, ${FAA_EVALUATOR_PROMPT_VERSION},
      ${JSON.stringify({ decision: outcome.decision, confidence: outcome.confidence })},
      ${JSON.stringify({ decision: outcome.decision, confidence: outcome.confidence })},
      ${outcome.decision}, ${Math.round(outcome.confidence * 100)},
      null, null, null, '[]', '[]', '[]', null, 'jev-prescreen', null,
      ${outcome.costUsd}, null, 0, now()
    )
    ON CONFLICT (signal_id, model_id, prompt_version) DO UPDATE SET
      raw_response = EXCLUDED.raw_response,
      parsed = EXCLUDED.parsed,
      decision = EXCLUDED.decision,
      confidence = EXCLUDED.confidence,
      reason = EXCLUDED.reason,
      cost_usd = EXCLUDED.cost_usd,
      error = EXCLUDED.error,
      updated_at = now()
  `);
}

async function persistResult(
  db: Database,
  input: {
    signalId: string;
    modelAId: string;
    modelBId: string;
    modelADecision: string | null;
    modelBDecision: string | null;
    agreed: boolean;
    adjudicationRequired: boolean;
    adjudicatorModel: string | null;
    adjudicatorOutput: Record<string, unknown> | null;
    finalDecision: EnsembleDecision;
    finalConfidence: number | null;
    reason: string;
    falseNegativeRisk: string | null;
  },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO faa_ensemble_results (
      signal_id, prompt_version, adjudicator_prompt_version,
      model_a_id, model_b_id, model_a_decision, model_b_decision,
      agreed, adjudication_required, adjudicator_model, adjudicator_output,
      final_decision, final_confidence, reason, false_negative_risk,
      updated_at
    ) VALUES (
      ${input.signalId}, ${FAA_EVALUATOR_PROMPT_VERSION},
      ${FAA_ADJUDICATOR_PROMPT_VERSION}, ${input.modelAId}, ${input.modelBId},
      ${input.modelADecision}, ${input.modelBDecision},
      ${input.agreed}, ${input.adjudicationRequired},
      ${input.adjudicatorModel},
      ${input.adjudicatorOutput === null ? null : JSON.stringify(input.adjudicatorOutput)},
      ${input.finalDecision}, ${input.finalConfidence}, ${input.reason},
      ${input.falseNegativeRisk}, now()
    )
    ON CONFLICT (signal_id) DO UPDATE SET
      prompt_version = EXCLUDED.prompt_version,
      adjudicator_prompt_version = EXCLUDED.adjudicator_prompt_version,
      model_a_id = EXCLUDED.model_a_id,
      model_b_id = EXCLUDED.model_b_id,
      model_a_decision = EXCLUDED.model_a_decision,
      model_b_decision = EXCLUDED.model_b_decision,
      agreed = EXCLUDED.agreed,
      adjudication_required = EXCLUDED.adjudication_required,
      adjudicator_model = EXCLUDED.adjudicator_model,
      adjudicator_output = EXCLUDED.adjudicator_output,
      final_decision = EXCLUDED.final_decision,
      final_confidence = EXCLUDED.final_confidence,
      reason = EXCLUDED.reason,
      false_negative_risk = EXCLUDED.false_negative_risk,
      updated_at = now()
  `);
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
export interface EnsembleSignalOutcome {
  readonly modelADecision: EnsembleDecision | null;
  readonly modelBDecision: EnsembleDecision | null;
  readonly agreed: boolean;
  readonly adjudicationRequired: boolean;
  readonly adjudicated: boolean;
  readonly finalDecision: EnsembleDecision;
  readonly apiCalls: number;
  readonly failures: number;
  /** NO-DEFAULT RULE: no result row was written; the signal stays retryable. */
  readonly skippedNoJudgment?: boolean;
  /** JEv pre-screen verdict driving this outcome (null when prescreen off/failed). */
  readonly jevDecision?: EnsembleDecision | null;
  /** True when JEv resolved the signal with zero Muse calls. */
  readonly jevFastPath?: boolean;
}

export interface EnsembleMetrics {
  readonly total: number;
  readonly agreed: number;
  readonly agreementRate: number;
  readonly disagreementRate: number;
  readonly perModel: Record<
    "a" | "b",
    Record<EnsembleDecision | "error", number>
  >;
  readonly adjudications: number;
  readonly apiCalls: number;
  readonly failures: number;
  readonly finalDistribution: Record<EnsembleDecision, number>;
  readonly skippedNoJudgment: number;
  /** Signals where JEv ran (any verdict, including errors→null screen). */
  readonly jevScreened: number;
  /** Signals resolved with zero Muse calls (JEv research fast path). */
  readonly jevFastPath: number;
}

function emptyDecisionCount(): Record<EnsembleDecision | "error", number> {
  return { reject: 0, research: 0, high_priority: 0, error: 0 };
}

export function summarizeEnsembleOutcomes(
  outcomes: readonly EnsembleSignalOutcome[],
): EnsembleMetrics {
  const perModel = { a: emptyDecisionCount(), b: emptyDecisionCount() };
  const finalDistribution: Record<EnsembleDecision, number> = {
    reject: 0,
    research: 0,
    high_priority: 0,
  };
  let agreed = 0;
  let adjudications = 0;
  let apiCalls = 0;
  let failures = 0;
  let skippedNoJudgment = 0;
  let jevScreened = 0;
  let jevFastPath = 0;
  for (const outcome of outcomes) {
    if (outcome.agreed) agreed += 1;
    if (outcome.adjudicated) adjudications += 1;
    apiCalls += outcome.apiCalls;
    failures += outcome.failures;
    if (outcome.jevDecision !== undefined && outcome.jevDecision !== null) {
      jevScreened += 1;
    }
    if (outcome.jevFastPath === true) jevFastPath += 1;
    perModel.a[outcome.modelADecision ?? "error"] += 1;
    perModel.b[outcome.modelBDecision ?? "error"] += 1;
    if (outcome.skippedNoJudgment === true) {
      skippedNoJudgment += 1;
    } else {
      finalDistribution[outcome.finalDecision] += 1;
    }
  }
  const total = outcomes.length;
  return {
    total,
    agreed,
    agreementRate: total === 0 ? 0 : agreed / total,
    disagreementRate: total === 0 ? 0 : (total - agreed) / total,
    perModel,
    adjudications,
    apiCalls,
    failures,
    finalDistribution,
    skippedNoJudgment,
    jevScreened,
    jevFastPath,
  };
}

export function formatEnsembleMetrics(metrics: EnsembleMetrics): string {
  const pct = (rate: number): string => `${(rate * 100).toFixed(1)}%`;
  const lines = [
    `signals=${metrics.total} agreed=${metrics.agreed} agreement=${pct(metrics.agreementRate)} disagreement=${pct(metrics.disagreementRate)}`,
    `model_a: reject=${metrics.perModel.a.reject} research=${metrics.perModel.a.research} high_priority=${metrics.perModel.a.high_priority} error=${metrics.perModel.a.error}`,
    `model_b: reject=${metrics.perModel.b.reject} research=${metrics.perModel.b.research} high_priority=${metrics.perModel.b.high_priority} error=${metrics.perModel.b.error}`,
    `final: reject=${metrics.finalDistribution.reject} research=${metrics.finalDistribution.research} high_priority=${metrics.finalDistribution.high_priority}`,
    `adjudications=${metrics.adjudications} api_calls=${metrics.apiCalls} failures=${metrics.failures} skipped_no_judgment=${metrics.skippedNoJudgment}`,
    `jev: screened=${metrics.jevScreened} fast_path=${metrics.jevFastPath}`,
  ];

  return lines.join("\n");
}

interface QueueDepthRow {
  readonly source_key: string;
  readonly [key: string]: unknown;
  readonly status: string;
  readonly depth: number | string;
}

async function logQueueDepth(
  db: Database,
  options: FaaEnsembleCliOptions,
): Promise<void> {
  const queueDepth = await db.execute<QueueDepthRow>(sql`
    SELECT
      ss.source_key,
      ss.status::text AS status,
      count(*)::integer AS depth
    FROM source_signals ss
    WHERE ss.status::text = ${options.status}
      ${sourceKeyFilter(options.sourceKeys)}
      AND NOT EXISTS (
        SELECT 1 FROM faa_ensemble_results r WHERE r.signal_id = ss.id
      )
    GROUP BY ss.source_key, ss.status
    ORDER BY ss.source_key ASC, ss.status ASC
  `);
  const sourceKeys =
    options.sourceKeys.length === 0 ? "all" : options.sourceKeys.join(",");
  const summary = queueDepth.rows
    .map((row) => `${row.source_key}/${row.status}=${row.depth}`)
    .join(" ");
  console.log(`queue-depth: ${summary || "empty"} (source_keys=${sourceKeys})`);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
export interface FaaEnsembleDependencies {
  readonly db?: Database;
  readonly evaluateModel?: (
    modelId: string,
    pkg: FaaEvidencePackage,
  ) => Promise<ModelEvalOutcome>;
  readonly adjudicate?: (
    pkg: FaaEvidencePackage,
    a: FaaEvaluatorResult | null,
    b: FaaEvaluatorResult | null,
  ) => Promise<AdjudicatorOutcome>;
  /** JEv pre-screen override (tests/staging). Null result falls through to Muse. */
  readonly screenJev?: (
    pkg: FaaEvidencePackage,
  ) => Promise<JevScreenOutcome | null>;
}

export interface FaaEnsembleSummary {
  readonly signals: number;
  readonly metrics: EnsembleMetrics;
}

/**
 * Single-Muse second opinion for a JEv-flagged signal. Shared by the inline
 * cascade (runJevCascade) and the decoupled verification stage
 * (runMuseVerification): exactly one model-A call; a confirming verdict
 * retains the JEv decision, anything else falls back to research. A failed
 * Muse call persists the error evaluation and returns a research outcome
 * WITHOUT writing a result row (the signal stays retryable).
 */
export async function verifyJevFlagWithMuse(
  db: Database,
  signalId: string,
  pkg: FaaEvidencePackage,
  config: FaaEnsembleConfig,
  screened: JevScreenOutcome,
  evaluate: (
    modelId: string,
    evidence: FaaEvidencePackage,
  ) => Promise<ModelEvalOutcome>,
): Promise<EnsembleSignalOutcome> {
  await sleep(config.requestDelayMs);
  const outcome = await evaluate(config.modelA, pkg);
  if (!outcome.ok) {
    await persistEvaluation(db, signalId, config.modelA, outcome);
    return {
      modelADecision: null,
      modelBDecision: screened.decision,
      agreed: false,
      adjudicationRequired: true,
      adjudicated: false,
      finalDecision: "research",
      apiCalls: 1,
      failures: 1,
      jevDecision: screened.decision,
      jevFastPath: false,
    };
  }
  await persistEvaluation(db, signalId, config.modelA, outcome);
  const confirmed = outcome.result.decision === screened.decision;
  const finalDecision: EnsembleDecision = confirmed
    ? screened.decision
    : "research";
  await persistResult(db, {
    signalId,
    modelAId: config.jevModel,
    modelBId: config.modelA,
    modelADecision: screened.decision,
    modelBDecision: outcome.result.decision,
    agreed: confirmed,
    adjudicationRequired: false,
    adjudicatorModel: null,
    adjudicatorOutput: null,
    finalDecision,
    finalConfidence: outcome.result.confidence,
    reason: confirmed
      ? `jev-flagged ${screened.decision} confirmed by second opinion`
      : "jev flag overruled by second opinion; retained as research",
    falseNegativeRisk: outcome.result.false_negative_risk,
  });
  return {
    modelADecision: screened.decision,
    modelBDecision: outcome.result.decision,
    agreed: confirmed,
    adjudicationRequired: false,
    adjudicated: false,
    finalDecision,
    apiCalls: 1,
    failures: 0,
    jevDecision: screened.decision,
    jevFastPath: false,
  };
}

/**
 * JEv verified cascade for one signal. Returns an outcome when JEv resolves
 * it, or null to fall through to full two-model Muse screening (screen
 * error, or random audit sample).
 */
export async function runJevCascade(
  db: Database,
  row: CandidateSignalRow,
  pkg: FaaEvidencePackage,
  config: FaaEnsembleConfig,
  screen: (pkg: FaaEvidencePackage) => Promise<JevScreenOutcome | null>,
  evaluate: (
    modelId: string,
    evidence: FaaEvidencePackage,
  ) => Promise<ModelEvalOutcome>,
): Promise<EnsembleSignalOutcome | null> {
  let screened: JevScreenOutcome | null;
  try {
    screened = await screen(pkg);
  } catch {
    return null;
  }
  if (screened === null) return null;
  await persistJevEvaluation(db, row.id, config.jevModel, screened);
  const base = {
    jevDecision: screened.decision as EnsembleDecision,
    jevFastPath: false,
  };
  const audit = Math.random() < config.jevAuditSampleRate;
  if (audit) return null;
  if (screened.decision === "research") {
    const finalConfidence = Math.round(screened.confidence * 100);
    await persistResult(db, {
      signalId: row.id,
      modelAId: config.jevModel,
      modelBId: config.jevModel,
      modelADecision: "research",
      modelBDecision: "research",
      agreed: true,
      adjudicationRequired: false,
      adjudicatorModel: null,
      adjudicatorOutput: null,
      finalDecision: "research",
      finalConfidence,
      reason: "jev-fast-path: research accepted without Muse calls",
      falseNegativeRisk: "low",
    });
    return {
      modelADecision: "research",
      modelBDecision: "research",
      agreed: true,
      adjudicationRequired: false,
      adjudicated: false,
      finalDecision: "research",
      apiCalls: 0,
      failures: 0,
      ...base,
      jevFastPath: true,
    };
  }
  // Flagged cases get exactly one Muse second opinion (model A). Muse wins
  // ties toward retention: only a confirming verdict promotes/rejects.
  const needsConfirm =
    screened.decision === "high_priority" ||
    (screened.decision === "reject" &&
      screened.confidence >= config.jevRejectConfirmThreshold);
  if (!needsConfirm) {
    // Low-confidence reject: retain as research without spending Muse.
    await persistResult(db, {
      signalId: row.id,
      modelAId: config.jevModel,
      modelBId: config.jevModel,
      modelADecision: screened.decision,
      modelBDecision: "research",
      agreed: false,
      adjudicationRequired: false,
      adjudicatorModel: null,
      adjudicatorOutput: null,
      finalDecision: "research",
      finalConfidence: Math.round(screened.confidence * 100),
      reason: "jev-fast-path: low-confidence reject retained as research",
      falseNegativeRisk: "medium",
    });
    return {
      modelADecision: screened.decision,
      modelBDecision: "research",
      agreed: false,
      adjudicationRequired: false,
      adjudicated: false,
      finalDecision: "research",
      apiCalls: 0,
      failures: 0,
      ...base,
      jevFastPath: true,
    };
  }
  return verifyJevFlagWithMuse(db, row.id, pkg, config, screened, evaluate);
}

async function qualifySignal(
  row: CandidateSignalRow,
  config: FaaEnsembleConfig,
  deps: FaaEnsembleDependencies,
  db: Database,
  client: OpenRouterClient | null,
): Promise<EnsembleSignalOutcome> {
  const pkg = buildEvidencePackage(
    row,
    await loadWebsiteEvidence(
      db,
      asText(row.raw_domain) ?? asText(row.rawDomain),
      typeof row.company_id === "string" ? row.company_id : null,
    ),
  );
  const evaluate =
    deps.evaluateModel ??
    (client === null
      ? null
      : (modelId: string, evidence: FaaEvidencePackage) =>
          defaultEvaluateModel(client, modelId, evidence));
  if (evaluate === null) {
    throw new Error("OPENROUTER_API_KEY is required (no evaluate override)");
  }
  const adjudicate =
    deps.adjudicate ??
    (client === null
      ? null
      : (
          evidence: FaaEvidencePackage,
          a: FaaEvaluatorResult | null,
          b: FaaEvaluatorResult | null,
        ) =>
          defaultAdjudicate(client, config.adjudicatorModel, evidence, a, b));
  if (adjudicate === null) {
    throw new Error("OPENROUTER_API_KEY is required (no adjudicate override)");
  }

  // JEv verified cascade: a $0.00002 screen runs first. Muse spends only on
  // JEv-flagged cases (reject confirm / high_priority verify) plus a random
  // audit sample. JEv research accepts outright with zero Muse calls.
  if (config.jevPrescreen && deps.screenJev !== undefined) {
    const fastPath = await runJevCascade(
      db,
      row,
      pkg,
      config,
      deps.screenJev,
      evaluate,
    );
    if (fastPath !== null) return fastPath;
    // Fall through: screen errored, or the audit sample demands full Muse.
  }

  let apiCalls = 0;
  let failures = 0;
  // Persist Model A even if Model B fails: sequential, each persisted.
  await sleep(config.requestDelayMs);
  const outcomeA = await evaluate(config.modelA, pkg);
  apiCalls += 1;
  if (!outcomeA.ok) failures += 1;
  await persistEvaluation(db, row.id, config.modelA, outcomeA);

  await sleep(config.requestDelayMs);
  const outcomeB = await evaluate(config.modelB, pkg);
  apiCalls += 1;
  if (!outcomeB.ok) failures += 1;
  await persistEvaluation(db, row.id, config.modelB, outcomeB);

  const resultA = outcomeA.ok ? outcomeA.result : null;
  const resultB = outcomeB.ok ? outcomeB.result : null;
  const resolution = resolveEnsemble(resultA, resultB);

  let finalDecision = resolution.finalDecision;
  let finalConfidence = resolution.finalConfidence;
  let adjudicated = false;
  let adjudicatorOutput: Record<string, unknown> | null = null;
  if (resolution.adjudicationRequired) {
    await sleep(config.requestDelayMs);
    const adjudication = await adjudicate(pkg, resultA, resultB);
    apiCalls += 1;
    if (adjudication.ok) {
      adjudicated = true;
      finalDecision = adjudication.result.decision;
      finalConfidence = adjudication.result.confidence;
      adjudicatorOutput = adjudication.result as unknown as Record<
        string,
        unknown
      >;
    } else {
      failures += 1;
      adjudicatorOutput = { error: adjudication.error };
    }
  }

  // NO-DEFAULT RULE: zero successful evals and no adjudicated decision means
  // no judgment — the error evaluations above are persisted, but no result
  // row is written so the signal stays retryable.
  if (resultA === null && resultB === null && !adjudicated) {
    return {
      modelADecision: null,
      modelBDecision: null,
      agreed: resolution.agreed,
      adjudicationRequired: resolution.adjudicationRequired,
      adjudicated,
      finalDecision,
      apiCalls,
      failures,
      skippedNoJudgment: true,
    };
  }

  await persistResult(db, {
    signalId: row.id,
    modelAId: config.modelA,
    modelBId: config.modelB,
    modelADecision: resultA?.decision ?? null,
    modelBDecision: resultB?.decision ?? null,
    agreed: resolution.agreed,
    adjudicationRequired: resolution.adjudicationRequired,
    adjudicatorModel: resolution.adjudicationRequired
      ? config.adjudicatorModel
      : null,
    adjudicatorOutput,
    finalDecision,
    finalConfidence,
    reason: adjudicated
      ? `adjudicated: ${JSON.stringify(adjudicatorOutput)}`
      : resolution.reason,
    falseNegativeRisk:
      resultA?.false_negative_risk ?? resultB?.false_negative_risk ?? null,
  });

  return {
    modelADecision: resultA?.decision ?? null,
    modelBDecision: resultB?.decision ?? null,
    agreed: resolution.agreed,
    adjudicationRequired: resolution.adjudicationRequired,
    adjudicated,
    finalDecision,
    apiCalls,
    failures,
  };
}

export async function runFaaEnsemble(
  options: FaaEnsembleCliOptions,
  dependencies: FaaEnsembleDependencies = {},
): Promise<FaaEnsembleSummary> {
  const baseConfig = resolveEnsembleConfig(process.env);
  const config: FaaEnsembleConfig =
    options.delayMs === null
      ? baseConfig
      : { ...baseConfig, requestDelayMs: options.delayMs };
  const db = dependencies.db ?? getDatabase();
  await logQueueDepth(db, options);
  const rows = await selectCandidateSignals(db, options);

  if (options.dryRun) {
    const packages = rows.map((row) => buildEvidencePackage(row));
    for (const pkg of packages.slice(0, 2)) {
      console.log(JSON.stringify(pkg, null, 2));
    }
    console.log(
      `dry-run: signals=${rows.length} status=${options.status} source_keys=${
        options.sourceKeys.length === 0 ? "all" : options.sourceKeys.join(",")
      }`,
    );
    return {
      signals: rows.length,
      metrics: summarizeEnsembleOutcomes([]),
    };
  }

  const apiKey = process.env["OPENROUTER_API_KEY"] ?? "";
  const client =
    dependencies.evaluateModel !== undefined &&
    dependencies.adjudicate !== undefined
      ? null
      : new OpenRouterClient(apiKey);
  const effectiveDependencies =
    dependencies.screenJev !== undefined || client === null
      ? dependencies
      : {
          ...dependencies,
          screenJev: (pkg: FaaEvidencePackage) =>
            defaultScreenJev(apiKey, config.jevModel, pkg),
        };

  const outcomes = await runWithConcurrency(rows, options.concurrency, (row) =>
    qualifySignal(row, config, effectiveDependencies, db, client),
  );
  const metrics = summarizeEnsembleOutcomes(outcomes);
  console.log(formatEnsembleMetrics(metrics));
  return { signals: rows.length, metrics };
}

// ---------------------------------------------------------------------------
// Shared-contract batch entrypoint (worker/nightly refresh)
// ---------------------------------------------------------------------------
export interface EnsembleBatchOptions {
  /** 0 = all Signals. */
  readonly limit: number;
  readonly status?: string;
  /** undefined = all source keys. */
  readonly sourceKeys?: readonly string[];
  readonly concurrency: number;
  readonly delayMs: number;
  readonly dryRun?: boolean;
}

export async function runEnsembleBatch(
  options: EnsembleBatchOptions,
  dependencies: FaaEnsembleDependencies = {},
): Promise<FaaEnsembleSummary> {
  return runFaaEnsemble(
    {
      limit: options.limit,
      status: options.status ?? DEFAULT_FAA_STATUS,
      sourceKeys: options.sourceKeys ?? [],
      dryRun: options.dryRun ?? false,
      sample: null,
      concurrency: options.concurrency,
      delayMs: options.delayMs,
      includeKnown: false,
      benchmarkNames: [],
      failedOnly: false,
    },
    dependencies,
  );
}

// ---------------------------------------------------------------------------
// Decoupled two-stage ensemble (JEv sweep → Muse verification)
//
// Stage 1 (runJevSweep) screens the queue with JEv at full speed: zero Muse
// calls, no faa_ensemble_results rows — only JEv evaluation rows. Stage 2
// (runMuseVerification) independently spends one Muse call per JEv-flagged
// signal (high_priority, or reject at/above the confirm threshold) plus a
// small audit sample of JEv-research signals, writing the result row with
// the same confirmed→JEv-decision-else-research shape as the inline cascade
// second opinion. Selection mirrors selectCandidateSignals (status,
// source-key, and known-name exclusion filters, FIFO) plus the JEv-presence
// conditions each stage requires.
// ---------------------------------------------------------------------------
export interface JevSweepOptions {
  /** 0 (or omitted) = sweep the entire queue. */
  readonly limit?: number;
  readonly status?: string;
  readonly sourceKeys?: readonly string[];
  readonly concurrency?: number;
}

export interface JevSweepDependencies {
  /** JEv screen override (tests/staging); defaults to defaultScreenJev. */
  readonly screenJev?: (
    pkg: FaaEvidencePackage,
  ) => Promise<JevScreenOutcome | null>;
  readonly apiKey?: string;
  readonly config?: FaaEnsembleConfig;
}

export interface JevSweepSummary {
  /** Signals where JEv returned a verdict (evaluation row persisted). */
  readonly screened: number;
  /** Screened signals needing Muse confirmation. */
  readonly flagged: number;
  /** Screen misses (null verdict or throw); nothing persisted. */
  readonly errors: number;
}

export interface MuseVerificationOptions {
  /** Max flagged signals to verify; the audit sample is additional. */
  readonly limit?: number;
  readonly concurrency?: number;
  readonly status?: string;
  readonly sourceKeys?: readonly string[];
}

export interface MuseVerificationDependencies {
  /** Single-Muse evaluator override (tests/staging). */
  readonly evaluateModel?: (
    modelId: string,
    pkg: FaaEvidencePackage,
  ) => Promise<ModelEvalOutcome>;
  readonly apiKey?: string;
  readonly config?: FaaEnsembleConfig;
}

export interface MuseVerificationSummary {
  /** Signals where the Muse call succeeded (result row written). */
  readonly verified: number;
  /** Muse agreed with the stored JEv verdict. */
  readonly confirmed: number;
  /** Muse disagreed; retained as research. */
  readonly overruled: number;
  /** Failed Muse calls (error evaluation persisted, no result row). */
  readonly errors: number;
}

/**
 * Verification candidate carrying its stored JEv verdict. jev_confidence is
 * on the evaluation-table scale (0–100, see persistJevEvaluation) and may
 * arrive as a string from numeric columns.
 */
export interface VerificationCandidateRow extends CandidateSignalRow {
  readonly jev_decision: EnsembleDecision;
  readonly jev_confidence: number | string;
  readonly jev_cost: number | null;
}

async function selectSweepCandidates(
  db: Database,
  args: {
    status: string;
    sourceKeys: readonly string[];
    jevModel: string;
    /** 0 = all. */
    limit: number;
  },
): Promise<CandidateSignalRow[]> {
  const base = await db.execute<CandidateSignalRow>(sql`
    SELECT
      ss.id,
      ss.raw_name,
      ss.raw_domain,
      ss.uei,
      ss.cage,
      ss.city,
      ss.state,
      ss.country,
      ss.award_count,
      ss.freshest_award,
      ss.created_at,
      ss.source_payload
    FROM source_signals ss
    WHERE ss.status::text = ${args.status}
      ${sourceKeyFilter(args.sourceKeys)}
      AND NOT EXISTS (
        SELECT 1 FROM faa_ensemble_results r WHERE r.signal_id = ss.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM faa_ensemble_evaluations e
        WHERE e.signal_id = ss.id AND e.model_id = ${args.jevModel}
      )
      AND NOT EXISTS (
        SELECT 1 FROM golden_examples g
        WHERE lower(g.name) = lower(ss.raw_name)
      )
      AND NOT EXISTS (
        SELECT 1 FROM companies c
        WHERE lower(c.legal_name) = lower(ss.raw_name)
      )
    ORDER BY ss.created_at ASC, ss.id ASC
    ${args.limit <= 0 ? sql`` : sql`LIMIT ${args.limit}`}
  `);
  return [...base.rows];
}

async function selectVerificationCandidates(
  db: Database,
  args: {
    status: string;
    sourceKeys: readonly string[];
    jevModel: string;
    modelA: string;
    /** Confirm threshold on the evaluation-table confidence scale (0–100). */
    rejectThresholdDb: number;
    kind: "flagged" | "research";
    limit: number;
  },
): Promise<VerificationCandidateRow[]> {
  const base = await db.execute<VerificationCandidateRow>(sql`
    SELECT
      ss.id,
      ss.raw_name,
      ss.raw_domain,
      ss.uei,
      ss.cage,
      ss.city,
      ss.state,
      ss.country,
      ss.award_count,
      ss.freshest_award,
      ss.created_at,
      ss.source_payload,
      jev.decision AS jev_decision,
      jev.confidence AS jev_confidence,
      jev.cost_usd AS jev_cost
    FROM source_signals ss
    JOIN faa_ensemble_evaluations jev
      ON jev.signal_id = ss.id AND jev.model_id = ${args.jevModel}
      ${
        args.kind === "flagged"
          ? sql`AND (jev.decision = 'high_priority' OR (jev.decision = 'reject' AND jev.confidence >= ${args.rejectThresholdDb}))`
          : sql`AND jev.decision = 'research'`
      }
    WHERE ss.status::text = ${args.status}
      ${sourceKeyFilter(args.sourceKeys)}
      AND NOT EXISTS (
        SELECT 1 FROM faa_ensemble_evaluations e
        WHERE e.signal_id = ss.id AND e.model_id = ${args.modelA}
      )
      AND NOT EXISTS (
        SELECT 1 FROM faa_ensemble_results r WHERE r.signal_id = ss.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM golden_examples g
        WHERE lower(g.name) = lower(ss.raw_name)
      )
      AND NOT EXISTS (
        SELECT 1 FROM companies c
        WHERE lower(c.legal_name) = lower(ss.raw_name)
      )
    ORDER BY ss.created_at ASC, ss.id ASC
    LIMIT ${args.limit}
  `);
  return [...base.rows];
}

/**
 * Stage 1: sweep queued signals with JEv at full speed. Never calls Muse
 * and never writes faa_ensemble_results rows — only JEv evaluation rows.
 */
export async function runJevSweep(
  db: Database = getDatabase(),
  opts: JevSweepOptions = {},
  deps: JevSweepDependencies = {},
): Promise<JevSweepSummary> {
  const config = deps.config ?? resolveEnsembleConfig();
  const rows = await selectSweepCandidates(db, {
    status: opts.status ?? DEFAULT_FAA_STATUS,
    sourceKeys: opts.sourceKeys ?? [],
    jevModel: config.jevModel,
    limit: opts.limit ?? 0,
  });
  const apiKey = deps.apiKey ?? process.env["OPENROUTER_API_KEY"] ?? "";
  const screen =
    deps.screenJev ??
    ((pkg: FaaEvidencePackage) =>
      defaultScreenJev(apiKey, config.jevModel, pkg));
  let screened = 0;
  let flagged = 0;
  let errors = 0;
  await runWithConcurrency(
    rows,
    opts.concurrency ?? config.concurrency,
    async (row) => {
      const pkg = buildEvidencePackage(
        row,
        await loadWebsiteEvidence(
          db,
          asText(row.raw_domain) ?? asText(row.rawDomain),
          typeof row.company_id === "string" ? row.company_id : null,
        ),
      );
      let verdict: JevScreenOutcome | null;
      try {
        verdict = await screen(pkg);
      } catch {
        errors += 1;
        return;
      }
      if (verdict === null) {
        errors += 1;
        return;
      }
      await persistJevEvaluation(db, row.id, config.jevModel, verdict);
      screened += 1;
      if (
        verdict.decision === "high_priority" ||
        (verdict.decision === "reject" &&
          verdict.confidence >= config.jevRejectConfirmThreshold)
      ) {
        flagged += 1;
      }
    },
  );
  return { screened, flagged, errors };
}

/**
 * Stage 2: verify JEv-flagged signals with one Muse call each (model A),
 * plus an audit sample of JEv-research signals. Outcomes carry jevDecision
 * from the stored JEv eval with jevFastPath false, so EnsembleMetrics
 * (jevScreened, jevFastPath) summarize them like cascade outcomes.
 */
export async function runMuseVerification(
  db: Database = getDatabase(),
  opts: MuseVerificationOptions = {},
  deps: MuseVerificationDependencies = {},
): Promise<MuseVerificationSummary> {
  const config = deps.config ?? resolveEnsembleConfig();
  const limit = opts.limit ?? 120;
  const status = opts.status ?? DEFAULT_FAA_STATUS;
  const sourceKeys = opts.sourceKeys ?? [];
  const flagged = await selectVerificationCandidates(db, {
    status,
    sourceKeys,
    jevModel: config.jevModel,
    modelA: config.modelA,
    rejectThresholdDb: Math.round(config.jevRejectConfirmThreshold * 100),
    kind: "flagged",
    limit,
  });
  const auditCap = Math.max(1, Math.floor(limit * config.jevAuditSampleRate));
  const audit = await selectVerificationCandidates(db, {
    status,
    sourceKeys,
    jevModel: config.jevModel,
    modelA: config.modelA,
    rejectThresholdDb: Math.round(config.jevRejectConfirmThreshold * 100),
    kind: "research",
    limit: auditCap,
  });
  const seen = new Set(flagged.map((row) => row.id));
  const candidates = [...flagged];
  for (const row of audit) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      candidates.push(row);
    }
  }
  const apiKey = deps.apiKey ?? process.env["OPENROUTER_API_KEY"] ?? "";
  const client: OpenRouterClient | null =
    deps.evaluateModel === undefined ? new OpenRouterClient(apiKey) : null;
  const evaluate: (
    modelId: string,
    evidence: FaaEvidencePackage,
  ) => Promise<ModelEvalOutcome> =
    deps.evaluateModel ??
    ((modelId, evidence) => {
      if (client === null) {
        throw new Error(
          "OPENROUTER_API_KEY is required (no evaluate override)",
        );
      }
      return defaultEvaluateModel(client, modelId, evidence);
    });
  let verified = 0;
  let confirmed = 0;
  let overruled = 0;
  let errors = 0;
  await runWithConcurrency(
    candidates,
    opts.concurrency ?? config.concurrency,
    async (row) => {
      const pkg = buildEvidencePackage(
        row,
        await loadWebsiteEvidence(
          db,
          asText(row.raw_domain) ?? asText(row.rawDomain),
          typeof row.company_id === "string" ? row.company_id : null,
        ),
      );
      const outcome = await verifyJevFlagWithMuse(
        db,
        row.id,
        pkg,
        config,
        {
          decision: row.jev_decision,
          confidence: Math.max(
            0,
            Math.min(1, Number(row.jev_confidence) / 100),
          ),
          costUsd: typeof row.jev_cost === "number" ? row.jev_cost : null,
        },
        evaluate,
      );
      if (outcome.failures > 0) {
        errors += 1;
        return;
      }
      verified += 1;
      if (outcome.agreed) {
        confirmed += 1;
      } else {
        overruled += 1;
      }
    },
  );
  return { verified, confirmed, overruled, errors };
}
