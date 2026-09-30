import { createHash } from "node:crypto";

import {
  readResearchProviderUsageReceipt,
  reconcileResearchProviderUsage,
  reserveResearchProviderUsage,
  settleResearchProviderUsage,
  type Database,
  type ReconcileResearchProviderUsageResult,
  type ReserveResearchProviderUsageResult,
  type SettleResearchProviderUsageReceiptMetadata,
  type ResearchProviderUsageReceipt,
} from "@asi/database";
import { LosslessNumber, parse as parseLosslessJson } from "lossless-json";

import { analystModelRequestHash } from "./faa-ensemble/analyst-protocol.js";

export const OPENROUTER_BUDGET_SCOPE_ID_ENV = "OPENROUTER_BUDGET_SCOPE_ID";
export const OPENROUTER_MAX_COST_PER_DAY_ENV =
  "OPENROUTER_MAX_COST_PER_DAY_USD";
export const DEFAULT_OPENROUTER_MAX_COST_PER_DAY_USD = "5";
export const JEV_OPENROUTER_ESTIMATED_COST_USD = "0.0014";
export const MUSE_OPENROUTER_ESTIMATED_COST_USD = "0.106";

const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const OPENROUTER_GENERATION_ID_PATTERN = /^gen-[A-Za-z0-9_-]+$/u;
const OPENROUTER_GENERATION_TIMEOUT_MS = 30_000;
const MAX_OPENROUTER_GENERATION_RESPONSE_BYTES = 1_048_576;
const MAX_OPENROUTER_GENERATION_EXPONENT_MAGNITUDE =
  MAX_OPENROUTER_GENERATION_RESPONSE_BYTES * 2;

export interface OpenRouterAccountingContext {
  readonly db: Database;
  readonly sourceSignalId: string;
  readonly analystStepId?: string | null;
  readonly caseId?: string | null;
  readonly inputHash?: string | null;
  readonly promptVersion?: string | null;
  readonly now?: Date;
}

export type OpenRouterBudgetDeferralReason =
  | "missing_accounting_context"
  | "reservation_reused_without_step_observation"
  | "daily_cap_exceeded"
  | "provider_cooldown"
  | "scope_not_started"
  | "scope_paused"
  | "scope_closed"
  | "scope_cap_exceeded"
  | "source_not_permitted";

export interface OpenRouterRequestAccounting {
  readonly providerReservationId: string;
  readonly receipt: ResearchProviderUsageReceipt;
  /** Null retains the full reserved bound in durable accounting. */
  readonly providerCostUsd: string | null;
}
export interface OpenRouterUnsettledAccounting {
  readonly providerReservationId: string;
  /** Persisted reservation whose settlement failed; it is not a receipt. */
  readonly reservation: ResearchProviderUsageReceipt;
  readonly providerCostUsd: string | null;
}

export interface OpenRouterBudgetDeferredAdmission {
  readonly budgetScopeId: string;
  readonly estimatedCostUsd: string;
  readonly dailyCapUsd: string;
}

export class OpenRouterBudgetDeferredError extends Error {
  override readonly name = "OpenRouterBudgetDeferredError";

  constructor(
    readonly reason: OpenRouterBudgetDeferralReason,
    readonly retryAt: Date | null,
    readonly detail: Readonly<Record<string, unknown>> = {},
    readonly admission?: OpenRouterBudgetDeferredAdmission,
  ) {
    super(`OpenRouter request deferred: ${reason}`);
  }
}

export class OpenRouterAccountingError extends Error {
  override readonly name = "OpenRouterAccountingError";

  constructor(
    readonly kind: "reservation_failed" | "settlement_failed",
    override readonly cause: unknown,
    readonly unsettledAccounting?: OpenRouterUnsettledAccounting,
  ) {
    super(`OpenRouter provider accounting ${kind.replace("_", " ")}`, {
      cause,
    });
  }
}

const failureAccounting = new WeakMap<object, OpenRouterRequestAccounting>();

export function openRouterFailureAccounting(
  error: unknown,
): OpenRouterRequestAccounting | null {
  return typeof error === "object" && error !== null
    ? (failureAccounting.get(error) ?? null)
    : null;
}

export function openRouterBudgetScopeConfigured(): boolean {
  return (process.env[OPENROUTER_BUDGET_SCOPE_ID_ENV]?.trim().length ?? 0) > 0;
}

export function openRouterBudgetScopeId(): string {
  const scopeId = process.env[OPENROUTER_BUDGET_SCOPE_ID_ENV]?.trim();
  if (scopeId === undefined || scopeId.length === 0) {
    throw new OpenRouterBudgetDeferredError(
      "missing_accounting_context",
      null,
      {
        configuration: `${OPENROUTER_BUDGET_SCOPE_ID_ENV} is not configured`,
      },
    );
  }
  return scopeId;
}

export function openRouterDailyBudgetCapUsd(): string {
  const raw = process.env[OPENROUTER_MAX_COST_PER_DAY_ENV]?.trim();
  return raw !== undefined && DECIMAL_PATTERN.test(raw)
    ? raw
    : DEFAULT_OPENROUTER_MAX_COST_PER_DAY_USD;
}

export function canonicalOpenRouterRequestHash(requestBody: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(requestBody), "utf8")
    .digest("hex");
}

/** SHA-256 of the exact API key; callers must never persist the raw key. */
export function openRouterKeyFingerprint(apiKey: string): string {
  if (apiKey.length === 0 || /[\r\n]/u.test(apiKey)) {
    throw new TypeError("OpenRouter API key must be nonempty and single-line");
  }
  return createHash("sha256").update(apiKey, "utf8").digest("hex");
}

export function openRouterCostUsd(value: unknown): string | null {
  if (typeof value === "string") {
    return DECIMAL_PATTERN.test(value) ? normalizeDecimal(value) : null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  const rendered = value.toString();
  const exponent = rendered.match(/^(\d)(?:\.(\d+))?[eE]([+-]?\d+)$/u);
  if (exponent === null) {
    return DECIMAL_PATTERN.test(rendered) ? normalizeDecimal(rendered) : null;
  }
  const digits = `${exponent[1]}${exponent[2] ?? ""}`;
  const decimalPosition = 1 + Number(exponent[3]);
  const expanded =
    decimalPosition <= 0
      ? `0.${"0".repeat(-decimalPosition)}${digits}`
      : decimalPosition >= digits.length
        ? `${digits}${"0".repeat(decimalPosition - digits.length)}`
        : `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
  return normalizeDecimal(expanded);
}

function openRouterGenerationCostUsd(value: unknown): string | null {
  if (!(value instanceof LosslessNumber)) {
    return openRouterCostUsd(value);
  }
  const raw = value.toString();
  const lowerExponentIndex = raw.indexOf("e");
  const upperExponentIndex = raw.indexOf("E");
  const exponentIndex =
    lowerExponentIndex === -1 ? upperExponentIndex : lowerExponentIndex;
  const rawExponent = exponentIndex === -1 ? "" : raw.slice(exponentIndex + 1);
  let exponentStart = 0;
  let exponentSign = 1;
  if (rawExponent.charAt(exponentStart) === "-") {
    exponentSign = -1;
    exponentStart += 1;
  } else if (rawExponent.charAt(exponentStart) === "+") {
    exponentStart += 1;
  }
  while (rawExponent.charCodeAt(exponentStart) === 48) {
    exponentStart += 1;
  }
  // Bound exact exponent expansion by the provider response size before
  // allocating.
  if (rawExponent.length - exponentStart > 7) return null;
  let exponentMagnitude = 0;
  for (let index = exponentStart; index < rawExponent.length; index += 1) {
    exponentMagnitude =
      exponentMagnitude * 10 + rawExponent.charCodeAt(index) - 48;
    if (exponentMagnitude > MAX_OPENROUTER_GENERATION_EXPONENT_MAGNITUDE) {
      return null;
    }
  }
  const exponent = exponentSign * exponentMagnitude;
  let mantissa = exponentIndex === -1 ? raw : raw.slice(0, exponentIndex);
  const negative = mantissa.charAt(0) === "-";
  if (negative) mantissa = mantissa.slice(1);
  const decimalIndex = mantissa.indexOf(".");
  const integerPart =
    decimalIndex === -1 ? mantissa : mantissa.slice(0, decimalIndex);
  const digits = integerPart.concat(
    decimalIndex === -1 ? "" : mantissa.slice(decimalIndex + 1),
  );
  let firstSignificantDigit = 0;
  while (digits.charCodeAt(firstSignificantDigit) === 48) {
    firstSignificantDigit += 1;
  }
  if (firstSignificantDigit === digits.length) return "0";
  if (negative) return null;
  const significantDigits = digits.slice(firstSignificantDigit);
  const decimalPosition = integerPart.length - firstSignificantDigit + exponent;
  if (decimalPosition <= 0) {
    const leadingZeros = -decimalPosition;
    if (
      leadingZeros + significantDigits.length + 2 >
      MAX_OPENROUTER_GENERATION_RESPONSE_BYTES
    ) {
      return null;
    }
    return normalizeDecimal(
      `0.${"0".repeat(leadingZeros)}${significantDigits}`,
    );
  }
  if (decimalPosition >= significantDigits.length) {
    if (decimalPosition > MAX_OPENROUTER_GENERATION_RESPONSE_BYTES) {
      return null;
    }
    return normalizeDecimal(
      `${significantDigits}${"0".repeat(
        decimalPosition - significantDigits.length,
      )}`,
    );
  }
  if (significantDigits.length + 1 > MAX_OPENROUTER_GENERATION_RESPONSE_BYTES) {
    return null;
  }
  return normalizeDecimal(
    `${significantDigits.slice(0, decimalPosition)}.${significantDigits.slice(
      decimalPosition,
    )}`,
  );
}

export function openRouterEnvelopeCostUsd(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const usage = (parsed as Record<string, unknown>)["usage"];
    if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
      return null;
    }
    return openRouterCostUsd((usage as Record<string, unknown>)["cost"]);
  } catch {
    return null;
  }
}

function openRouterGenerationIdFromBody(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const id = (parsed as Record<string, unknown>)["id"];
    return typeof id === "string" && OPENROUTER_GENERATION_ID_PATTERN.test(id)
      ? id
      : null;
  } catch {
    return null;
  }
}

async function readBoundedOpenRouterGenerationBody(
  response: Response,
): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > MAX_OPENROUTER_GENERATION_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("generation_response_limit");
    }
    chunks.push(next.value);
  }
  const merged = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export interface ReconcileOpenRouterGenerationCostInput {
  readonly db: Database;
  readonly reservationId: string;
  /** Used only for this authenticated provider lookup; never persisted. */
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  readonly now?: Date;
  readonly timeoutMs?: number;
}

export type OpenRouterGenerationReconciliationResult =
  | ({
      outcome: "reconciled" | "existing";
      receipt: ResearchProviderUsageReceipt;
    } & {
      providerHttpStatus: number;
    })
  | {
      outcome: "held";
      reason:
        | "receipt_not_found"
        | "not_openrouter"
        | "missing_provider_identity"
        | "provider_key_mismatch"
        | "provider_request_failed"
        | "provider_http_failure"
        | "provider_body_unreadable"
        | "provider_response_invalid"
        | "provider_identity_conflict"
        | "provider_cost_missing"
        | "provider_cost_invalid"
        | "provider_cost_conflict"
        | Extract<
            ReconcileResearchProviderUsageResult,
            { outcome: "held" }
          >["reason"];
      receipt: ResearchProviderUsageReceipt | null;
      providerHttpStatus: number | null;
    };

/**
 * Read an attributable receipt, retrieve its provider generation, and settle
 * only provider-reported exact cost. Missing IDs, key disagreement, malformed
 * provider data, and any identity/cost conflict deliberately remain held.
 */
export async function reconcileOpenRouterGenerationCost(
  input: ReconcileOpenRouterGenerationCostInput,
): Promise<OpenRouterGenerationReconciliationResult> {
  const receipt = await readResearchProviderUsageReceipt(
    input.db,
    input.reservationId,
  );
  if (receipt === null) {
    return {
      outcome: "held",
      reason: "receipt_not_found",
      receipt: null,
      providerHttpStatus: null,
    };
  }
  const held = (
    reason: Extract<
      OpenRouterGenerationReconciliationResult,
      { outcome: "held" }
    >["reason"],
    providerHttpStatus: number | null = null,
  ): OpenRouterGenerationReconciliationResult => ({
    outcome: "held",
    reason,
    receipt,
    providerHttpStatus,
  });
  if (receipt.provider !== "openrouter") return held("not_openrouter");
  if (
    receipt.providerGenerationId === null ||
    receipt.providerKeyFingerprint === null
  ) {
    return held("missing_provider_identity");
  }
  if (
    receipt.providerKeyFingerprint !== openRouterKeyFingerprint(input.apiKey)
  ) {
    return held("provider_key_mismatch");
  }

  const timeoutMs = input.timeoutMs ?? OPENROUTER_GENERATION_TIMEOUT_MS;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1_000 ||
    timeoutMs > 120_000
  ) {
    throw new TypeError("timeoutMs must be an integer between 1000 and 120000");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await (input.fetch ?? fetch)(
      `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(
        receipt.providerGenerationId,
      )}`,
      {
        headers: { authorization: `Bearer ${input.apiKey}` },
        signal: controller.signal,
      },
    );
  } catch {
    clearTimeout(timeout);
    return held("provider_request_failed");
  }
  if (!response.ok) {
    clearTimeout(timeout);
    await response.body?.cancel().catch(() => undefined);
    return held("provider_http_failure", response.status);
  }

  let payload: unknown;
  try {
    payload = parseLosslessJson(
      await readBoundedOpenRouterGenerationBody(response),
      null,
      { parseNumber: (raw) => new LosslessNumber(raw) },
    );
  } catch {
    clearTimeout(timeout);
    return held("provider_body_unreadable", response.status);
  }
  clearTimeout(timeout);
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return held("provider_response_invalid", response.status);
  }
  const generation = (payload as Record<string, unknown>)["data"];
  if (
    generation === null ||
    typeof generation !== "object" ||
    Array.isArray(generation)
  ) {
    return held("provider_response_invalid", response.status);
  }
  const data = generation as Record<string, unknown>;
  if (data["id"] !== receipt.providerGenerationId) {
    return held("provider_identity_conflict", response.status);
  }
  const hasTotalCost = Object.hasOwn(data, "total_cost");
  const totalCostUsd = hasTotalCost
    ? openRouterGenerationCostUsd(data["total_cost"])
    : null;
  if (hasTotalCost && totalCostUsd === null) {
    return held("provider_cost_invalid", response.status);
  }
  const usageCostUsd = Object.hasOwn(data, "usage")
    ? openRouterGenerationCostUsd(data["usage"])
    : null;
  if (
    totalCostUsd !== null &&
    usageCostUsd !== null &&
    totalCostUsd !== usageCostUsd
  ) {
    return held("provider_cost_conflict", response.status);
  }
  const actualCostUsd = totalCostUsd ?? usageCostUsd;
  if (actualCostUsd === null) {
    return held(
      hasTotalCost ? "provider_cost_invalid" : "provider_cost_missing",
      response.status,
    );
  }

  const reconciled = await reconcileResearchProviderUsage(input.db, {
    reservationId: receipt.id,
    providerGenerationId: receipt.providerGenerationId,
    providerKeyFingerprint: receipt.providerKeyFingerprint,
    actualCostUsd,
    reconciledAt: input.now ?? new Date(),
  });
  if (reconciled.outcome === "held") {
    return {
      ...reconciled,
      providerHttpStatus: response.status,
    };
  }
  return {
    ...reconciled,
    providerHttpStatus: response.status,
  };
}

export interface AccountedOpenRouterRequest {
  readonly context: OpenRouterAccountingContext;
  readonly operation: "openrouter_muse_structured" | "openrouter_jev_decision";
  readonly requestBody: unknown;
  readonly prompt: string;
  readonly estimatedCostUsd: string;
  /** SHA-256 fingerprint of the exact OpenRouter API key on the wire. */
  readonly providerKeyFingerprint: string;
}

export interface AccountedOpenRouterResponse {
  readonly response: Response;
  readonly body: string;
  readonly accounting: OpenRouterRequestAccounting;
}

/**
 * Reserve exactly once before one wire request and settle that receipt after its
 * body is read, before caller-level schema or postcondition validation.
 */
export async function executeAccountedOpenRouterRequest(
  input: AccountedOpenRouterRequest,
  call: () => Promise<Response>,
  readBody: (response: Response) => Promise<string>,
): Promise<AccountedOpenRouterResponse> {
  const context = input.context;
  const now = context.now ?? new Date();
  const requestHash = canonicalOpenRouterRequestHash(input.requestBody);
  const analystRequestHash = analystHash(context, input.prompt);
  if (!SHA256_PATTERN.test(input.providerKeyFingerprint)) {
    throw new TypeError(
      "providerKeyFingerprint must be a lowercase SHA-256 digest",
    );
  }
  const baseProviderReceipt = {
    providerKeyFingerprint: input.providerKeyFingerprint,
  };
  const estimatedCostUsd = input.estimatedCostUsd;
  let admission: OpenRouterBudgetDeferredAdmission;
  let reserved: ReserveResearchProviderUsageResult;
  try {
    admission = {
      budgetScopeId: openRouterBudgetScopeId(),
      estimatedCostUsd,
      dailyCapUsd: openRouterDailyBudgetCapUsd(),
    };
    reserved = await reserveResearchProviderUsage(context.db, {
      provider: "openrouter",
      operation: input.operation,
      sourceSignalId: context.sourceSignalId,
      analystStepId: context.analystStepId ?? null,
      analystRequestHash: analystRequestHash ?? null,
      budgetScopeId: admission.budgetScopeId,
      requestHash,
      estimatedCostUsd: admission.estimatedCostUsd,
      dailyCapUsd: admission.dailyCapUsd,
      now,
    });
  } catch (error) {
    throw new OpenRouterAccountingError("reservation_failed", error);
  }
  if (reserved.outcome === "deferred") {
    throw new OpenRouterBudgetDeferredError(
      reserved.reason,
      "retryAt" in reserved && reserved.retryAt instanceof Date
        ? reserved.retryAt
        : null,
      { ...reserved },
      admission,
    );
  }
  if (reserved.reused) {
    throw new OpenRouterBudgetDeferredError(
      "reservation_reused_without_step_observation",
      null,
      { providerReservationId: reserved.reservation.id },
    );
  }

  try {
    const response = await call();
    const headerGenerationId = response.headers.get("x-generation-id");
    const responseProviderReceipt = {
      ...baseProviderReceipt,
      providerGenerationId:
        headerGenerationId !== null &&
        OPENROUTER_GENERATION_ID_PATTERN.test(headerGenerationId)
          ? headerGenerationId
          : null,
      providerHttpStatus: response.status,
    };
    let body = "";
    try {
      body = await readBody(response);
    } catch (error) {
      const accounting = await settleOrThrow(
        context.db,
        reserved.reservation,
        "failed",
        null,
        responseProviderReceipt,
        error,
      );
      rememberFailure(error, accounting);
      throw error;
    }
    const providerCostUsd = openRouterEnvelopeCostUsd(body);
    const bodyGenerationId = openRouterGenerationIdFromBody(body);
    const providerReceipt = {
      ...responseProviderReceipt,
      providerGenerationId:
        responseProviderReceipt.providerGenerationId !== null &&
        bodyGenerationId !== null &&
        responseProviderReceipt.providerGenerationId !== bodyGenerationId
          ? null
          : (responseProviderReceipt.providerGenerationId ?? bodyGenerationId),
    };
    const accounting = await settleOrThrow(
      context.db,
      reserved.reservation,
      response.ok ? "succeeded" : "failed",
      providerCostUsd,
      providerReceipt,
      response.ok ? null : new Error(`OpenRouter HTTP ${response.status}`),
    );
    return { response, body, accounting };
  } catch (error) {
    if (
      error instanceof OpenRouterAccountingError ||
      error instanceof OpenRouterBudgetDeferredError ||
      openRouterFailureAccounting(error) !== null
    ) {
      throw error;
    }
    const accounting = await settleOrThrow(
      context.db,
      reserved.reservation,
      "failed",
      null,
      baseProviderReceipt,
      error,
    );
    rememberFailure(error, accounting);
    throw error;
  }
}

function analystHash(
  context: OpenRouterAccountingContext,
  prompt: string,
): string | undefined {
  if (context.analystStepId === undefined || context.analystStepId === null) {
    return undefined;
  }
  if (
    context.caseId === undefined ||
    context.caseId === null ||
    context.inputHash === undefined ||
    context.inputHash === null ||
    context.promptVersion === undefined ||
    context.promptVersion === null
  ) {
    throw new TypeError(
      "caseId, inputHash, and promptVersion are required with analystStepId",
    );
  }
  return analystModelRequestHash({
    caseId: context.caseId,
    inputHash: context.inputHash,
    promptVersion: context.promptVersion,
    prompt,
  });
}

async function settleOrThrow(
  db: Database,
  reservation: ResearchProviderUsageReceipt,
  status: "succeeded" | "failed",
  providerCostUsd: string | null,
  providerReceipt: SettleResearchProviderUsageReceiptMetadata,
  error: unknown,
): Promise<OpenRouterRequestAccounting> {
  try {
    const receipt = await settleResearchProviderUsage(db, reservation.id, {
      status,
      actualCostUsd: providerCostUsd,
      observedAt: new Date(),
      providerReceipt,
      ...(error === null ? {} : { error: boundedError(error) }),
    });
    return {
      providerReservationId: receipt.id,
      receipt,
      providerCostUsd,
    };
  } catch (settlementError) {
    throw new OpenRouterAccountingError("settlement_failed", settlementError, {
      providerReservationId: reservation.id,
      reservation,
      providerCostUsd,
    });
  }
}

function rememberFailure(
  error: unknown,
  accounting: OpenRouterRequestAccounting,
): void {
  if (typeof error === "object" && error !== null) {
    failureAccounting.set(error, accounting);
  }
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll("\u0000", "\\u0000").slice(0, 2_000);
}

function normalizeDecimal(value: string): string {
  const [integer, fraction] = value.split(".");
  const normalizedInteger = (integer ?? "0").replace(/^0+(?=\d)/u, "");
  const normalizedFraction = fraction?.replace(/0+$/u, "");
  return normalizedFraction === undefined || normalizedFraction.length === 0
    ? normalizedInteger
    : `${normalizedInteger}.${normalizedFraction}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
