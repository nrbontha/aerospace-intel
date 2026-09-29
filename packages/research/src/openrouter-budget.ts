import { createHash } from "node:crypto";

import {
  reserveResearchProviderUsage,
  settleResearchProviderUsage,
  type Database,
  type ResearchProviderUsageReceipt,
} from "@asi/database";

import { analystModelRequestHash } from "./faa-ensemble/analyst-protocol.js";

export const OPENROUTER_BUDGET_SCOPE_ID_ENV = "OPENROUTER_BUDGET_SCOPE_ID";
export const OPENROUTER_MAX_COST_PER_DAY_ENV =
  "OPENROUTER_MAX_COST_PER_DAY_USD";
export const DEFAULT_OPENROUTER_MAX_COST_PER_DAY_USD = "5";
export const JEV_OPENROUTER_ESTIMATED_COST_USD = "0.0014";
export const MUSE_OPENROUTER_ESTIMATED_COST_USD = "0.106";

const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u;

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


export class OpenRouterBudgetDeferredError extends Error {
  override readonly name = "OpenRouterBudgetDeferredError";

  constructor(
    readonly reason: OpenRouterBudgetDeferralReason,
    readonly retryAt: Date | null,
    readonly detail: Readonly<Record<string, unknown>> = {},
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
    super(`OpenRouter provider accounting ${kind.replace("_", " ")}`, { cause });
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
    throw new OpenRouterBudgetDeferredError("missing_accounting_context", null, {
      configuration: `${OPENROUTER_BUDGET_SCOPE_ID_ENV} is not configured`,
    });
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
  return createHash("sha256").update(canonicalJson(requestBody), "utf8").digest("hex");
}

export function openRouterCostUsd(value: unknown): string | null {
  if (typeof value === "string") {
    return DECIMAL_PATTERN.test(value) ? normalizeDecimal(value) : null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  const rendered = value.toString();
  const exponent = rendered.match(
    /^(\d)(?:\.(\d+))?[eE]([+-]?\d+)$/u,
  );
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

export function openRouterEnvelopeCostUsd(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
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

export interface AccountedOpenRouterRequest {
  readonly context: OpenRouterAccountingContext;
  readonly operation: "openrouter_muse_structured" | "openrouter_jev_decision";
  readonly requestBody: unknown;
  readonly prompt: string;
  readonly estimatedCostUsd: string;
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
  let reserved;
  try {
    reserved = await reserveResearchProviderUsage(context.db, {
      provider: "openrouter",
      operation: input.operation,
      sourceSignalId: context.sourceSignalId,
      analystStepId: context.analystStepId ?? null,
      analystRequestHash: analystRequestHash ?? null,
      budgetScopeId: openRouterBudgetScopeId(),
      requestHash,
      estimatedCostUsd: input.estimatedCostUsd,
      dailyCapUsd: openRouterDailyBudgetCapUsd(),
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
    let body = "";
    try {
      body = await readBody(response);
    } catch (error) {
      const accounting = await settleOrThrow(
        context.db,
        reserved.reservation,
        "failed",
        null,
        error,
      );
      rememberFailure(error, accounting);
      throw error;
    }
    const providerCostUsd = openRouterEnvelopeCostUsd(body);
    const accounting = await settleOrThrow(
      context.db,
      reserved.reservation,
      response.ok ? "succeeded" : "failed",
      providerCostUsd,
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
  error: unknown,
): Promise<OpenRouterRequestAccounting> {
  try {
    const receipt = await settleResearchProviderUsage(db, reservation.id, {
      status,
      actualCostUsd: providerCostUsd,
      observedAt: new Date(),
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

function rememberFailure(error: unknown, accounting: OpenRouterRequestAccounting): void {
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
