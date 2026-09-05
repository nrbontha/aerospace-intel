import type { z } from "zod";
import {
  adjudicatorResultSchema,
  ensembleDecisionSchema,
  evaluatorResultSchema,
  type AdjudicatorResult,
  type EnsembleDecision,
  type EvaluatorResult,
} from "./schemas.js";

/** Maximum API retries per call (5 attempts total). Failures stay errors. */
export const ENSEMBLE_MAX_RETRIES = 4;
export const ENSEMBLE_BASE_DELAY_MS = 1_000;
export const ENSEMBLE_MAX_DELAY_MS = 15_000;

/** Resolved ensemble model set; injected so this module never reads env. */
export interface EnsembleModels {
  readonly modelA: string;
  readonly modelB: string;
  readonly adjudicator: string;
}

/** Raw single-shot completion; the runner adapts the gateway to this. */
export interface EnsembleRawCompletion {
  readonly text: string | null;
  readonly tokens: EnsembleTokenUsage | null;
  readonly costUsd: number | null;
}

export interface EnsembleTokenUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

export interface EnsembleCallOptions {
  readonly signal?: AbortSignal;
  readonly maxOutputTokens?: number;
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Minimal injected client contract. `complete` resolves with the model's raw
 * text on success and throws on API failure. Thrown errors are retried unless
 * they carry `retryable: false` (or the call was aborted); a numeric
 * `retryAfterMs` prop is honored as a rate-limit hint. The client MUST NOT
 * throw a decision — API failures are errors with retry, never decisions —
 * and MUST NOT include API keys in messages.
 */
export interface EnsembleCompletionClient {
  complete(
    model: string,
    prompt: string,
    options?: EnsembleCallOptions,
  ): Promise<EnsembleRawCompletion>;
}

interface AttemptBase {
  readonly modelId: string;
  readonly models: EnsembleModels;
  readonly rawResponse: string | null;
  readonly tokens: EnsembleTokenUsage | null;
  readonly costUsd: number | null;
  /** Total API attempts made (1 + retries consumed). */
  readonly attempts: number;
  readonly retryCount: number;
}

export interface EvaluatorSuccess extends AttemptBase {
  readonly ok: true;
  readonly data: EvaluatorResult;
  readonly rawResponse: string;
}

export interface EvaluatorFailure extends AttemptBase {
  readonly ok: false;
  readonly error: string;
}

export type EvaluatorOutcome = EvaluatorSuccess | EvaluatorFailure;

export interface AdjudicatorSuccess extends AttemptBase {
  readonly ok: true;
  readonly data: AdjudicatorResult;
  readonly rawResponse: string;
}

export interface AdjudicatorFailure extends AttemptBase {
  readonly ok: false;
  readonly error: string;
}

export type AdjudicatorOutcome = AdjudicatorSuccess | AdjudicatorFailure;

export interface ComparisonResult {
  readonly agreed: boolean;
  readonly adjudicationRequired: boolean;
  /** Set when the pair resolves without an adjudicator; else null. */
  readonly provisionalDecision: EnsembleDecision | null;
}

/**
 * Shared-contract ensemble rule over two model decisions:
 * - agree → accept (no adjudication);
 * - research + high_priority → research default without adjudication (promote
 *   only on clearly strong combined evidence, decided downstream);
 * - any reject-vs-other split → adjudicate;
 * - malformed/unknown values → adjudicate, never coerce into a decision.
 */
export function compareDecisions(a: unknown, b: unknown): ComparisonResult {
  const first = ensembleDecisionSchema.safeParse(a);
  const second = ensembleDecisionSchema.safeParse(b);
  if (!first.success || !second.success) {
    return {
      agreed: false,
      adjudicationRequired: true,
      provisionalDecision: null,
    };
  }
  if (first.data === "reject" || second.data === "reject") {
    return {
      agreed: false,
      adjudicationRequired: true,
      provisionalDecision: null,
    };
  }
  return {
    agreed: false,
    adjudicationRequired: false,
    provisionalDecision: "research",
  };
}

/**
 * Run one evaluator model with bounded exponential backoff + rate-limit
 * retry. Malformed output (no parseable JSON object, or a JSON object that
 * fails the schema) marks the call failed without consuming API retries.
 */
export async function runEvaluator(
  client: EnsembleCompletionClient,
  models: EnsembleModels,
  modelId: string,
  prompt: string,
  schema: z.ZodType<EvaluatorResult> = evaluatorResultSchema,
  options?: EnsembleCallOptions,
): Promise<EvaluatorOutcome> {
  const completion = await completeWithRetry(
    client,
    modelId,
    prompt,
    options,
  );
  if (!completion.ok) {
    return {
      ok: false,
      modelId,
      models,
      rawResponse: completion.rawResponse,
      tokens: completion.tokens,
      costUsd: completion.costUsd,
      attempts: completion.attempts,
      retryCount: completion.retryCount,
      error: completion.error,
    };
  }
  const parsed = parseModelJson(completion.text, schema);
  if (!parsed.ok) {
    return {
      ok: false,
      modelId,
      models,
      rawResponse: completion.text,
      tokens: completion.tokens,
      costUsd: completion.costUsd,
      attempts: completion.attempts,
      retryCount: completion.retryCount,
      error: parsed.error,
    };
  }
  return {
    ok: true,
    modelId,
    models,
    data: parsed.data,
    rawResponse: completion.text,
    tokens: completion.tokens,
    costUsd: completion.costUsd,
    attempts: completion.attempts,
    retryCount: completion.retryCount,
  };
}

/** Same retry wrapper for the adjudicator call. */
export async function runAdjudicator(
  client: EnsembleCompletionClient,
  models: EnsembleModels,
  modelId: string,
  prompt: string,
  schema: z.ZodType<AdjudicatorResult> = adjudicatorResultSchema,
  options?: EnsembleCallOptions,
): Promise<AdjudicatorOutcome> {
  const completion = await completeWithRetry(
    client,
    modelId,
    prompt,
    options,
  );
  if (!completion.ok) {
    return {
      ok: false,
      modelId,
      models,
      rawResponse: completion.rawResponse,
      tokens: completion.tokens,
      costUsd: completion.costUsd,
      attempts: completion.attempts,
      retryCount: completion.retryCount,
      error: completion.error,
    };
  }
  const parsed = parseModelJson(completion.text, schema);
  if (!parsed.ok) {
    return {
      ok: false,
      modelId,
      models,
      rawResponse: completion.text,
      tokens: completion.tokens,
      costUsd: completion.costUsd,
      attempts: completion.attempts,
      retryCount: completion.retryCount,
      error: parsed.error,
    };
  }
  return {
    ok: true,
    modelId,
    models,
    data: parsed.data,
    rawResponse: completion.text,
    tokens: completion.tokens,
    costUsd: completion.costUsd,
    attempts: completion.attempts,
    retryCount: completion.retryCount,
  };
}

interface CompletionSuccess {
  readonly ok: true;
  readonly text: string;
  readonly tokens: EnsembleTokenUsage | null;
  readonly costUsd: number | null;
  readonly attempts: number;
  readonly retryCount: number;
}

interface CompletionFailure {
  readonly ok: false;
  readonly error: string;
  readonly rawResponse: string | null;
  readonly tokens: EnsembleTokenUsage | null;
  readonly costUsd: number | null;
  readonly attempts: number;
  readonly retryCount: number;
}

async function completeWithRetry(
  client: EnsembleCompletionClient,
  modelId: string,
  prompt: string,
  options?: EnsembleCallOptions,
): Promise<CompletionSuccess | CompletionFailure> {
  const maxRetries = Math.max(0, options?.maxRetries ?? ENSEMBLE_MAX_RETRIES);
  const baseDelayMs = options?.baseDelayMs ?? ENSEMBLE_BASE_DELAY_MS;
  const maxDelayMs = options?.maxDelayMs ?? ENSEMBLE_MAX_DELAY_MS;
  const sleep =
    options?.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let attempts = 0;
  // Failures stay errors: only the loop below retries, and only on failure.
  for (;;) {
    if (options?.signal?.aborted === true) {
      return {
        ok: false,
        error: "request aborted",
        rawResponse: null,
        tokens: null,
        costUsd: null,
        attempts,
        retryCount: Math.max(0, attempts - 1),
      };
    }
    attempts += 1;
    let completion: EnsembleRawCompletion;
    try {
      completion = await client.complete(modelId, prompt, options);
    } catch (error) {
      if (isPermanentFailure(error, options?.signal) || attempts > maxRetries) {
        return {
          ok: false,
          error: describeError(error),
          rawResponse: null,
          tokens: null,
          costUsd: null,
          attempts,
          retryCount: attempts - 1,
        };
      }
      await sleep(
        computeRetryDelayMs(attempts - 1, baseDelayMs, maxDelayMs, error),
      );
      continue;
    }
    if (completion.text === null) {
      if (attempts > maxRetries) {
        return {
          ok: false,
          error: "model returned no text",
          rawResponse: null,
          tokens: completion.tokens,
          costUsd: completion.costUsd,
          attempts,
          retryCount: attempts - 1,
        };
      }
      await sleep(computeRetryDelayMs(attempts - 1, baseDelayMs, maxDelayMs));
      continue;
    }
    return {
      ok: true,
      text: completion.text,
      tokens: completion.tokens,
      costUsd: completion.costUsd,
      attempts,
      retryCount: attempts - 1,
    };
  }
}

function parseModelJson<T>(
  text: string,
  schema: z.ZodType<T>,
): { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = extractJsonObject(text);
  }
  if (value === null || value === undefined) {
    return { ok: false, error: "response contained no parseable JSON object" };
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) return { ok: false, error: parsed.error.message };
  return { ok: true, data: parsed.data };
}

/**
 * Repair fallback: extract the first balanced `{...}` block (string-aware,
 * so braces inside quoted text do not end the scan) and JSON-parse it.
 * Returns null when there is no parseable object — the caller marks the
 * evaluation failed rather than coercing prose into a decision.
 */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Bounded exponential backoff with a rate-limit override: a numeric
 * `retryAfterMs` hint on the error wins, capped at `maxDelayMs`; otherwise
 * `baseDelayMs * 2^retryIndex` capped at `maxDelayMs`, with half-jitter.
 */
export function computeRetryDelayMs(
  retryIndex: number,
  baseDelayMs: number,
  maxDelayMs: number,
  error?: unknown,
): number {
  const hint =
    typeof error === "object" && error !== null && "retryAfterMs" in error
      ? (error as { readonly retryAfterMs?: unknown }).retryAfterMs
      : undefined;
  if (typeof hint === "number" && Number.isFinite(hint) && hint >= 0) {
    return Math.min(Math.floor(hint), Math.max(0, maxDelayMs));
  }
  const capped = Math.min(
    Math.max(0, maxDelayMs),
    Math.max(0, baseDelayMs) * 2 ** Math.max(0, retryIndex),
  );
  return Math.floor(capped / 2 + Math.random() * (capped / 2));
}

function isPermanentFailure(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  return (
    typeof error === "object" &&
    error !== null &&
    "retryable" in error &&
    (error as { readonly retryable?: unknown }).retryable === false
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "model request failed";
}
