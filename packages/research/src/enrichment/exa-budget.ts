import { createHash } from "node:crypto";

import {
  reserveResearchProviderUsage,
  settleResearchProviderUsage,
  type Database,
  type ResearchProviderUsageReceipt,
} from "@asi/database";

import {
  ExaApiKeyMissingError,
  ExaSearchError,
  type ExaContentsResult,
  type ExaProviderResult,
  type ExaSearchClient,
  type ExaSearchResult,
} from "../search/exa.js";

export const EXA_DAILY_BUDGET_ENV = "EXA_DAILY_BUDGET_USD";
export const EXA_BUDGET_SCOPE_ID_ENV = "EXA_BUDGET_SCOPE_ID";
export const DEFAULT_EXA_DAILY_BUDGET_USD = "0";
export const EXA_SEARCH_ESTIMATED_COST_USD = "0.007";
export const EXA_CREDITS_COOLDOWN_MS = 60 * 60 * 1_000;
export const EXA_CONTENTS_ESTIMATED_COST_USD = "0.01";

export interface ExaAccountingContext {
  readonly db: Database;
  readonly budgetScopeId: string;
  readonly sourceSignalId: string;
  readonly analystStepId?: string | null;
  readonly dailyCapUsd?: string;
  readonly now?: Date;
}

export type AccountedExaResult<T> =
  | {
      readonly outcome: "completed";
      readonly results: readonly T[];
      readonly receipt: ResearchProviderUsageReceipt;
      readonly providerCostUsd: string | null;
    }
  | {
      readonly outcome: "deferred";
      readonly reason:
        | "daily_cap_exceeded"
        | "provider_cooldown"
        | "scope_not_started"
        | "scope_paused"
        | "scope_closed"
        | "scope_cap_exceeded"
        | "source_not_permitted";
      readonly retryAt: Date | null;
      readonly detail: Readonly<Record<string, unknown>>;
      readonly receipt?: ResearchProviderUsageReceipt;
      readonly providerCostUsd?: string | null;
    }
  | {
      readonly outcome: "ambiguous";
      readonly receipt: ResearchProviderUsageReceipt;
      readonly reason: "reservation_reused_without_step_observation";
    };
export type AccountedExaDeferralReason =
  | Extract<AccountedExaResult<never>, { outcome: "deferred" }>["reason"]
  | Extract<AccountedExaResult<never>, { outcome: "ambiguous" }>["reason"];
interface DetailedExaClient {
  readonly searchWithMetadata: ExaSearchClient["searchWithMetadata"];
  readonly fetchContentsWithMetadata: ExaSearchClient["fetchContentsWithMetadata"];
}

export interface ExaFailureAccounting {
  readonly receipt: ResearchProviderUsageReceipt;
  readonly providerCostUsd: string | null;
}

const failureAccounting = new WeakMap<object, ExaFailureAccounting>();

export function exaFailureAccounting(
  error: unknown,
): ExaFailureAccounting | null {
  return typeof error === "object" && error !== null
    ? (failureAccounting.get(error) ?? null)
    : null;
}

export class ExaProviderDeferredError extends Error {
  override readonly name = "ExaProviderDeferredError";

  constructor(
    readonly reason: AccountedExaDeferralReason,
    readonly retryAt: Date | null,
  ) {
    super(`Exa request deferred: ${reason}`);
  }
}

export function createAccountedExaSearchClient(
  context: ExaAccountingContext,
  client: Pick<ExaSearchClient, "searchWithMetadata">,
): Pick<ExaSearchClient, "search"> {
  return {
    async search(query) {
      const result = await executeAccountedExaSearch(
        context,
        client,
        query,
      );
      if (result.outcome === "completed") return result.results;
      throw new ExaProviderDeferredError(
        result.reason,
        result.outcome === "deferred" ? result.retryAt : null,
      );
    },
  };
}

export function exaBudgetScopeId(): string {
  const scopeId = process.env[EXA_BUDGET_SCOPE_ID_ENV]?.trim();
  if (scopeId === undefined || scopeId.length === 0) {
    throw new Error(
      "EXA_BUDGET_SCOPE_ID must identify a pre-created active provider budget scope",
    );
  }
  return scopeId;
}

export function exaDailyBudgetCapUsd(): string {
  const raw = process.env[EXA_DAILY_BUDGET_ENV]?.trim();
  if (
    raw === undefined ||
    !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(raw)
  ) {
    return DEFAULT_EXA_DAILY_BUDGET_USD;
  }
  return raw;
}

export type ExaProviderOperation = "search" | "contents";
export type ExaProviderRequest =
  | { readonly query: string }
  | { readonly urls: readonly string[] };

/**
 * Canonical hash binding one journaled analyst action to its paid Exa request.
 * Keep this as the sole hash implementation used by both step creation and
 * provider accounting; callers cannot supply or override the resulting hash.
 */
export function exaProviderRequestHash(
  operation: ExaProviderOperation,
  request: ExaProviderRequest,
): string {
  const canonicalRequest =
    operation === "search"
      ? "query" in request
        ? { query: request.query }
        : null
      : "urls" in request
        ? { urls: [...request.urls] }
        : null;
  if (canonicalRequest === null) {
    throw new TypeError(`Invalid Exa ${operation} request shape`);
  }
  return createHash("sha256")
    .update(
      JSON.stringify({
        provider: "exa",
        operation,
        request: canonicalRequest,
      }),
    )
    .digest("hex");
}

export async function executeAccountedExaSearch(
  context: ExaAccountingContext,
  client: Pick<DetailedExaClient, "searchWithMetadata">,
  query: string,
): Promise<AccountedExaResult<ExaSearchResult>> {
  return executeAccountedExaRequest(
    context,
    "search",
    EXA_SEARCH_ESTIMATED_COST_USD,
    { query },
    () => client.searchWithMetadata(query),
  );
}

export async function executeAccountedExaContents(
  context: ExaAccountingContext,
  client: Pick<DetailedExaClient, "fetchContentsWithMetadata">,
  urls: readonly string[],
): Promise<AccountedExaResult<ExaContentsResult>> {
  return executeAccountedExaRequest(
    context,
    "contents",
    EXA_CONTENTS_ESTIMATED_COST_USD,
    { urls },
    () => client.fetchContentsWithMetadata(urls),
  );
}

async function executeAccountedExaRequest<T>(
  context: ExaAccountingContext,
  operation: ExaProviderOperation,
  estimatedCostUsd: string,
  request: ExaProviderRequest,
  call: () => Promise<ExaProviderResult<T>>,
): Promise<AccountedExaResult<T>> {
  const now = context.now ?? new Date();
  const requestHash = exaProviderRequestHash(operation, request);
  const reserved = await reserveResearchProviderUsage(context.db, {
    provider: "exa",
    operation,
    sourceSignalId: context.sourceSignalId,
    analystStepId: context.analystStepId ?? null,
    budgetScopeId: context.budgetScopeId,
    requestHash,
    estimatedCostUsd,
    dailyCapUsd: context.dailyCapUsd ?? exaDailyBudgetCapUsd(),
    now,
  });
  if (reserved.outcome === "deferred") {
    return {
      outcome: "deferred",
      reason: reserved.reason,
      retryAt:
        "retryAt" in reserved && reserved.retryAt instanceof Date
          ? reserved.retryAt
          : null,
      detail: { ...reserved },
    };
  }
  if (reserved.reused) {
    return {
      outcome: "ambiguous",
      receipt: reserved.reservation,
      reason: "reservation_reused_without_step_observation",
    };
  }

  try {
    const response = await call();
    const receipt = await settleResearchProviderUsage(
      context.db,
      reserved.reservation.id,
      {
        status: "succeeded",
        actualCostUsd: response.providerCostUsd,
        observedAt: new Date(),
      },
    );
    return {
      outcome: "completed",
      results: response.results,
      receipt,
      providerCostUsd: response.providerCostUsd,
    };
  } catch (error) {
    const providerCostUsd =
      error instanceof ExaSearchError ? error.providerCostUsd : null;
    const definitelyBeforeNetwork = error instanceof ExaApiKeyMissingError;
    const quotaExhausted =
      error instanceof ExaSearchError && error.code === "quota_exhausted";
    const retryAt = new Date(now.getTime() + EXA_CREDITS_COOLDOWN_MS);
    const receipt = await settleResearchProviderUsage(
      context.db,
      reserved.reservation.id,
      {
        status: "failed",
        actualCostUsd: definitelyBeforeNetwork ? "0" : providerCostUsd,
        observedAt: new Date(),
        error: boundedAccountingError(error),
        ...(quotaExhausted
          ? {
              providerCooldown: {
                reason: "credits_exhausted",
                retryAt,
              },
            }
          : {}),
      },
    );
    if (quotaExhausted) {
      return {
        outcome: "deferred",
        reason: "provider_cooldown",
        retryAt,
        detail: { cooldownReason: "credits_exhausted" },
        receipt,
        providerCostUsd,
      };
    }
    if (typeof error === "object" && error !== null) {
      failureAccounting.set(error, { receipt, providerCostUsd });
    }
    throw error;
  }
}

function boundedAccountingError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll("\u0000", "\\u0000").slice(0, 2_000);
}
