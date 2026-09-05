/**
 * FAA two-model ensemble qualification runner.
 *
 * High-recall filter over `source_signals` (default: FAA PMA holders awaiting
 * qualification). Each signal is evaluated independently by two models; the
 * deterministic ensemble rule accepts agreements, defaults research +
 * high_priority pairs to research, and adjudicates every other disagreement
 * (including malformed model output). API failures are recorded as errors
 * with retry — NEVER as decisions.
 *
 * The runner persists `faa_ensemble_evaluations` + `faa_ensemble_results`
 * rows only. It deliberately does NOT write candidates, leads, or
 * `source_signals.status` — promotion wiring is a later decision.
 *
 * Usage:
 *   npx tsx scripts/run-faa-ensemble.mts [--limit N] [--status S]
 *     [--source-key K] [--dry-run] [--sample N] [--concurrency N]
 *     [--include-known] [--benchmark-names a,b,c] [--failed-only]
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { z } from "zod";
import { sql } from "drizzle-orm";

import {
  closeDatabase,
  getDatabase,
  type Database,
} from "../packages/database/src/index.js";
import { OpenRouterClient } from "../packages/research/src/openrouter.js";

// ---------------------------------------------------------------------------
// env bootstrap (mirror scripts/bench-enrichment.ts: source .env.local)
// ---------------------------------------------------------------------------
for (const line of existsSync(".env.local")
  ? readFileSync(".env.local", "utf8").split("\n")
  : []) {
  const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/u);
  const key = match?.[1];
  const value = match?.[2];
  if (
    key !== undefined &&
    value !== undefined &&
    process.env[key] === undefined
  ) {
    process.env[key] = value;
  }
}

// ---------------------------------------------------------------------------
// Shared contract constants (MUST match EnsembleClient / EnsembleSchema)
// ---------------------------------------------------------------------------
export const FAA_EVALUATOR_PROMPT_VERSION = "faa_qualification_v1";
export const FAA_ADJUDICATOR_PROMPT_VERSION = "faa_adjudicator_v1";

export const DEFAULT_FAA_MODEL_A = "qwen/qwen3-30b-a3b:free";
export const DEFAULT_FAA_MODEL_B = "google/gemma-3-27b-it:free";
export const DEFAULT_FAA_SOURCE_KEY = "faa_pma_database";
export const DEFAULT_FAA_STATUS = "queued_qualification";
export const DEFAULT_FAA_CONCURRENCY = 5;
export const DEFAULT_FAA_REQUEST_DELAY_MS = 8000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface FaaEnsembleConfig {
  readonly modelA: string;
  readonly modelB: string;
  readonly adjudicatorModel: string;
  readonly concurrency: number;
  readonly requestDelayMs: number;
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
  return { modelA, modelB, adjudicatorModel, concurrency, requestDelayMs };
}

// ---------------------------------------------------------------------------
// Schemas (decision enum everywhere: reject | research | high_priority)
// ---------------------------------------------------------------------------
export const ensembleDecisionSchema = z.enum([
  "reject",
  "research",
  "high_priority",
]);
export type EnsembleDecision = z.infer<typeof ensembleDecisionSchema>;

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
});
export type FaaEvaluatorResult = z.infer<typeof evaluatorResultSchema>;

export const adjudicatorResultSchema = z.object({
  decision: ensembleDecisionSchema,
  confidence: z.number().int().min(0).max(100),
  reason: z.string().min(1),
});
export type FaaAdjudicatorResult = z.infer<typeof adjudicatorResultSchema>;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
export interface FaaEnsembleCliOptions {
  readonly limit: number;
  readonly status: string;
  readonly sourceKey: string;
  readonly dryRun: boolean;
  readonly sample: number | null;
  readonly concurrency: number;
  readonly delayMs: number | null;
  readonly includeKnown: boolean;
  readonly benchmarkNames: readonly string[];
  readonly failedOnly: boolean;
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const exact = argv.indexOf(flag);
  if (exact >= 0) return argv[exact + 1];
  const prefixed = argv.find((arg) => arg.startsWith(`${flag}=`));
  return prefixed === undefined ? undefined : prefixed.slice(flag.length + 1);
}

function hasFlag(argv: readonly string[], flag: string): boolean {
  return argv.includes(flag);
}

function parseNonNegativeInt(
  raw: string | undefined,
  flag: string,
): number | null {
  if (raw === undefined) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer (got ${raw})`);
  }
  return parsed;
}

export function parseEnsembleArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): FaaEnsembleCliOptions {
  const limit = parseNonNegativeInt(flagValue(argv, "--limit"), "--limit") ?? 0;
  const status = flagValue(argv, "--status") ?? DEFAULT_FAA_STATUS;
  const sourceKey = flagValue(argv, "--source-key") ?? DEFAULT_FAA_SOURCE_KEY;
  const dryRun = hasFlag(argv, "--dry-run");
  const sample = parseNonNegativeInt(flagValue(argv, "--sample"), "--sample");
  const concurrencyOverride = parseNonNegativeInt(
    flagValue(argv, "--concurrency"),
    "--concurrency",
  );
  const concurrency =
    concurrencyOverride === null || concurrencyOverride === 0
      ? resolveEnsembleConfig(env).concurrency
      : concurrencyOverride;
  const includeKnown = hasFlag(argv, "--include-known");
  const benchmarkRaw = flagValue(argv, "--benchmark-names") ?? "";
  const benchmarkNames = benchmarkRaw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const failedOnly = hasFlag(argv, "--failed-only");
  const delayMs = parseNonNegativeInt(
    flagValue(argv, "--delay-ms"),
    "--delay-ms",
  );
  return {
    limit,
    status,
    sourceKey,
    dryRun,
    sample,
    concurrency,
    delayMs,
    includeKnown,
    benchmarkNames,
    failedOnly,
  };
}

// ---------------------------------------------------------------------------
// Evidence package (compact; from source_signals row + source_payload)
// ---------------------------------------------------------------------------
export interface SourceSignalRowLike {
  readonly id: string;
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
  };
}

// ---------------------------------------------------------------------------
// Prompts (high-recall filter: reject ONLY on affirmative negative evidence;
// missing ownership/size/revenue -> research, never reject)
// ---------------------------------------------------------------------------
const HIGH_RECALL_POLICY = `You are a high-recall FAA PMA supplier filter. Reject ONLY on affirmative negative evidence (e.g. the holder is verifiably a distributor with no manufacturing, a foreign shell with no US presence, or the PMA record demonstrably belongs to a different company). Missing ownership, size, or revenue information MUST route to research, NEVER to reject. When in doubt, choose research.`;

export function buildEvaluatorPrompt(pkg: FaaEvidencePackage): string {
  return `${HIGH_RECALL_POLICY}

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
    const response = await client.generateStructured({
      route: "fast",
      models: { fast: modelId, deep: modelId, fallback: modelId },
      schemaName: FAA_EVALUATOR_PROMPT_VERSION,
      schema: evaluatorResultSchema,
      systemPrompt: FAA_EVALUATOR_SYSTEM_PROMPT,
      prompt: buildEvaluatorPrompt(pkg),
      maxAttempts: 3,
    });
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
    const response = await client.generateStructured({
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
    });
    return { ok: true, result: response.data };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Signal selection (resumable; deterministic id order)
// ---------------------------------------------------------------------------
export interface CandidateSignalRow extends SourceSignalRowLike {
  readonly id: string;
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
      ss.source_payload
    FROM source_signals ss
    WHERE ss.source_key = ${options.sourceKey}
      AND ss.status::text = ${options.status}
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
    ORDER BY ss.id ASC
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
          ss.source_payload
        FROM source_signals ss
        WHERE ss.source_key = ${options.sourceKey}
          AND position(lower(${name}) in lower(ss.raw_name)) > 0
          AND NOT EXISTS (
            SELECT 1 FROM faa_ensemble_results r WHERE r.signal_id = ss.id
          )
        ORDER BY ss.id ASC
      `);
      for (const row of matched.rows) {
        if (!seen.has(row.id)) {
          seen.add(row.id);
          rows.push(row);
        }
      }
    }
    rows.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  }
  return rows;
}

async function loadKnownNames(db: Database): Promise<Set<string>> {
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
      error = EXCLUDED.error
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
  for (const outcome of outcomes) {
    if (outcome.agreed) agreed += 1;
    if (outcome.adjudicated) adjudications += 1;
    apiCalls += outcome.apiCalls;
    failures += outcome.failures;
    perModel.a[outcome.modelADecision ?? "error"] += 1;
    perModel.b[outcome.modelBDecision ?? "error"] += 1;
    finalDistribution[outcome.finalDecision] += 1;
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
  };
}

export function formatEnsembleMetrics(metrics: EnsembleMetrics): string {
  const pct = (rate: number): string => `${(rate * 100).toFixed(1)}%`;
  const lines = [
    `signals=${metrics.total} agreed=${metrics.agreed} agreement=${pct(metrics.agreementRate)} disagreement=${pct(metrics.disagreementRate)}`,
    `model_a: reject=${metrics.perModel.a.reject} research=${metrics.perModel.a.research} high_priority=${metrics.perModel.a.high_priority} error=${metrics.perModel.a.error}`,
    `model_b: reject=${metrics.perModel.b.reject} research=${metrics.perModel.b.research} high_priority=${metrics.perModel.b.high_priority} error=${metrics.perModel.b.error}`,
    `final: reject=${metrics.finalDistribution.reject} research=${metrics.finalDistribution.research} high_priority=${metrics.finalDistribution.high_priority}`,
    `adjudications=${metrics.adjudications} api_calls=${metrics.apiCalls} failures=${metrics.failures}`,
  ];
  return lines.join("\n");
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
}

export interface FaaEnsembleSummary {
  readonly signals: number;
  readonly metrics: EnsembleMetrics;
}

async function qualifySignal(
  row: CandidateSignalRow,
  config: FaaEnsembleConfig,
  deps: FaaEnsembleDependencies,
  db: Database,
  client: OpenRouterClient | null,
): Promise<EnsembleSignalOutcome> {
  const pkg = buildEvidencePackage(row);
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

  const rows = await selectCandidateSignals(db, options);

  if (options.dryRun) {
    const packages = rows.map((row) => buildEvidencePackage(row));
    for (const pkg of packages.slice(0, 2)) {
      console.log(JSON.stringify(pkg, null, 2));
    }
    console.log(
      `dry-run: signals=${rows.length} status=${options.status} source_key=${options.sourceKey}`,
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

  const outcomes = await runWithConcurrency(rows, options.concurrency, (row) =>
    qualifySignal(row, config, dependencies, db, client),
  );
  const metrics = summarizeEnsembleOutcomes(outcomes);
  console.log(formatEnsembleMetrics(metrics));
  return { signals: rows.length, metrics };
}

async function main(): Promise<void> {
  const options = parseEnsembleArgs(process.argv.slice(2));
  if (!options.includeKnown && !options.dryRun) {
    // Surface the known-name filter size without disturbing the hot path.
    const db = getDatabase();
    try {
      const known = await loadKnownNames(db);
      console.log(
        `known-name filter: ${known.size} names (golden_examples + companies)`,
      );
    } finally {
      await closeDatabase();
    }
  }
  const summary = await runFaaEnsemble(options);
  console.log(`signals=${summary.signals}`);
  await closeDatabase();
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  await main();
}
