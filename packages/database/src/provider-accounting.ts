import { and, eq, sql } from "drizzle-orm";

import type { Database } from "./client.js";
import {
  researchProviderBudgetScopes,
  researchProviderBudgetScopeSignals,
  researchProviderCooldowns,
  researchProviderLegacyEstimates,
  researchProviderUsage,
  type ResearchProviderBudgetPermitStatus,
  type ResearchProviderBudgetScope,
  type ResearchProviderLegacyEstimate,
  type ResearchProviderUsageReceipt,
} from "./schema.js";

export type ResearchProviderUsd = string;
export type ResearchProviderSettlementStatus =
  | "succeeded"
  | "failed"
  | "ambiguous";

export interface ReserveResearchProviderUsageInput {
  provider: string;
  operation: string;
  sourceSignalId: string;
  analystStepId?: string | null;
  budgetScopeId: string;
  requestHash: string;
  estimatedCostUsd: ResearchProviderUsd;
  dailyCapUsd: ResearchProviderUsd;
  now?: Date;
}

export type ReserveResearchProviderUsageResult =
  | {
      outcome: "reserved";
      reused: boolean;
      reservation: ResearchProviderUsageReceipt;
    }
  | {
      outcome: "deferred";
      reason: "daily_cap_exceeded";
      provider: string;
      utcDay: string;
      committedCostUsd: ResearchProviderUsd;
      estimatedCostUsd: ResearchProviderUsd;
      dailyCapUsd: ResearchProviderUsd;
      retryAt: Date;
    }
  | {
      outcome: "deferred";
      reason: "provider_cooldown";
      provider: string;
      retryAt: Date;
      cooldownReason: string;
    }
  | {
      outcome: "deferred";
      reason:
        | "scope_not_started"
        | "scope_paused"
        | "scope_closed"
        | "scope_cap_exceeded";
      provider: string;
      budgetScopeId: string;
      committedCostUsd: ResearchProviderUsd;
      estimatedCostUsd: ResearchProviderUsd;
      totalCapUsd: ResearchProviderUsd;
      retryAt: Date | null;
    }
  | {
      outcome: "deferred";
      reason: "source_not_permitted";
      provider: string;
      budgetScopeId: string;
      sourceSignalId: string;
      retryAt: null;
    };

export interface SettleResearchProviderUsageInput {
  status: ResearchProviderSettlementStatus;
  actualCostUsd: ResearchProviderUsd | null;
  observedAt: Date;
  error?: string | null;
  providerCooldown?: {
    retryAt: Date;
    reason: string;
  };
}

export interface ImportLegacyResearchProviderEstimateInput {
  provider: string;
  utcDay: string;
  estimatedCostUsd: ResearchProviderUsd;
  idempotencyKey: string;
  importedAt?: Date;
}

export type ImportLegacyResearchProviderEstimateResult =
  | { outcome: "imported"; estimate: ResearchProviderLegacyEstimate }
  | { outcome: "existing"; estimate: ResearchProviderLegacyEstimate };

export interface CreateResearchProviderBudgetScopeInput {
  id: string;
  provider: string;
  startsAt: Date;
  totalCapUsd: ResearchProviderUsd;
  permitStatus: Exclude<ResearchProviderBudgetPermitStatus, "closed">;
  allowlistedSourceSignalIds: readonly string[];
}

export interface SetResearchProviderBudgetPermitInput {
  status: ResearchProviderBudgetPermitStatus;
  observedAt: Date;
}

export type ResearchProviderBudgetOperationalStatus =
  | "inactive"
  | "active"
  | "exhausted"
  | "closed";

export interface ResearchProviderBudgetScopeView {
  scope: ResearchProviderBudgetScope;
  allowlistedSourceSignalIds: string[];
  status: ResearchProviderBudgetOperationalStatus;
  knownActualCostUsd: ResearchProviderUsd;
  unknownEstimatedCostUsd: ResearchProviderUsd;
  committedCostUsd: ResearchProviderUsd;
  remainingCostUsd: ResearchProviderUsd;
  receiptCount: number;
  providerCooldown: { retryAt: Date; reason: string } | null;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u;
const UTC_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
export const MAX_RESEARCH_PROVIDER_BUDGET_SIGNALS = 100;

function nonempty(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${name} must not be empty`);
  return normalized;
}

function decimal(value: string, name: string): ResearchProviderUsd {
  if (!DECIMAL_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a nonnegative plain decimal string`);
  }
  const [integer = "0", fraction] = value.split(".");
  const normalizedInteger = integer.replace(/^0+(?=\d)/u, "");
  const normalizedFraction = fraction?.replace(/0+$/u, "");
  return normalizedFraction === undefined || normalizedFraction.length === 0
    ? normalizedInteger
    : `${normalizedInteger}.${normalizedFraction}`;
}

function utcDay(value: string): string {
  if (!UTC_DAY_PATTERN.test(value)) {
    throw new TypeError("utcDay must be an ISO UTC calendar date");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError("utcDay must be a valid ISO UTC calendar date");
  }
  return value;
}

function validDate(value: Date, name: string): Date {
  if (Number.isNaN(value.getTime())) throw new TypeError(`${name} must be valid`);
  return value;
}

function nextUtcDay(day: string): Date {
  const start = new Date(`${day}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() + 1);
  return start;
}

function asReceipt(
  row: typeof researchProviderUsage.$inferSelect,
): ResearchProviderUsageReceipt {
  return row as ResearchProviderUsageReceipt;
}

function asBudgetScope(
  row: typeof researchProviderBudgetScopes.$inferSelect,
): ResearchProviderBudgetScope {
  return row as ResearchProviderBudgetScope;
}

async function lockProvider(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  provider: string,
): Promise<void> {
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${provider}, 0))
  `);
}

/**
 * Explicitly create one immutable funded scope and its exact source allowlist.
 * Reserve never calls this function, so run IDs and worker restarts cannot mint
 * fresh allowance.
 */
export async function createResearchProviderBudgetScope(
  db: Database,
  input: CreateResearchProviderBudgetScopeInput,
): Promise<ResearchProviderBudgetScope> {
  const id = nonempty(input.id, "id");
  const provider = nonempty(input.provider, "provider");
  const startsAt = validDate(input.startsAt, "startsAt");
  const totalCapUsd = decimal(input.totalCapUsd, "totalCapUsd");
  if (input.allowlistedSourceSignalIds.length === 0) {
    throw new TypeError("allowlistedSourceSignalIds must not be empty");
  }
  if (
    input.allowlistedSourceSignalIds.length >
    MAX_RESEARCH_PROVIDER_BUDGET_SIGNALS
  ) {
    throw new TypeError(
      `allowlistedSourceSignalIds cannot exceed ${MAX_RESEARCH_PROVIDER_BUDGET_SIGNALS}`,
    );
  }
  const sourceSignalIds = [...new Set(input.allowlistedSourceSignalIds)].sort();
  if (sourceSignalIds.length !== input.allowlistedSourceSignalIds.length) {
    throw new TypeError("allowlistedSourceSignalIds must not contain duplicates");
  }

  return db.transaction(async (tx) => {
    await lockProvider(tx, provider);
    const inserted = await tx
      .insert(researchProviderBudgetScopes)
      .values({
        id,
        provider,
        startsAt,
        totalCapUsd,
        permitStatus: input.permitStatus,
        permitUpdatedAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      })
      .onConflictDoNothing({ target: researchProviderBudgetScopes.id })
      .returning();
    if (inserted[0] !== undefined) {
      await tx.insert(researchProviderBudgetScopeSignals).values(
        sourceSignalIds.map((sourceSignalId) => ({
          budgetScopeId: id,
          sourceSignalId,
        })),
      );
      const sealed = await tx
        .update(researchProviderBudgetScopes)
        .set({
          sealedAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(researchProviderBudgetScopes.id, id),
            sql`${researchProviderBudgetScopes.sealedAt} IS NULL`,
          ),
        )
        .returning();
      if (sealed[0] === undefined) {
        throw new Error(`provider budget scope ${id} was not sealed`);
      }
      return asBudgetScope(sealed[0]);
    }

    const existingRows = await tx
      .select()
      .from(researchProviderBudgetScopes)
      .where(eq(researchProviderBudgetScopes.id, id))
      .limit(1)
      .for("update");
    const existing = existingRows[0];
    if (existing === undefined) {
      throw new Error(`provider budget scope ${id} disappeared`);
    }
    if (existing.sealedAt === null) {
      throw new Error(`provider budget scope ${id} is not sealed`);
    }
    const existingSignals = await tx
      .select()
      .from(researchProviderBudgetScopeSignals)
      .where(eq(researchProviderBudgetScopeSignals.budgetScopeId, id));
    const existingSignalIds = existingSignals
      .map((row) => row.sourceSignalId)
      .sort();
    if (
      existing.provider !== provider ||
      existing.startsAt.getTime() !== startsAt.getTime() ||
      decimal(existing.totalCapUsd, "stored totalCapUsd") !== totalCapUsd ||
      JSON.stringify(existingSignalIds) !== JSON.stringify(sourceSignalIds)
    ) {
      throw new Error(
        `provider budget scope ${id} conflicts with its immutable definition`,
      );
    }
    return asBudgetScope(existing);
  });
}

/** Change only the live permit; a closed funded scope can never reopen. */
export async function setResearchProviderBudgetPermit(
  db: Database,
  budgetScopeId: string,
  input: SetResearchProviderBudgetPermitInput,
): Promise<ResearchProviderBudgetScope> {
  const id = nonempty(budgetScopeId, "budgetScopeId");
  const observedAt = validDate(input.observedAt, "observedAt");
  return db.transaction(async (tx) => {
    const providerRows = await tx
      .select({ provider: researchProviderBudgetScopes.provider })
      .from(researchProviderBudgetScopes)
      .where(eq(researchProviderBudgetScopes.id, id))
      .limit(1);
    const provider = providerRows[0]?.provider;
    if (provider === undefined) {
      throw new Error(`provider budget scope ${id} does not exist`);
    }
    await lockProvider(tx, provider);
    const existingRows = await tx
      .select()
      .from(researchProviderBudgetScopes)
      .where(eq(researchProviderBudgetScopes.id, id))
      .limit(1)
      .for("update");
    const existing = existingRows[0];
    if (existing === undefined) {
      throw new Error(`provider budget scope ${id} does not exist`);
    }
    if (existing.sealedAt === null) {
      throw new Error(`provider budget scope ${id} is not sealed`);
    }
    if (existing.permitStatus === "closed" && input.status !== "closed") {
      throw new Error(`closed provider budget scope ${id} cannot be reopened`);
    }
    if (observedAt < existing.permitUpdatedAt) {
      throw new Error(`provider budget scope ${id} permit update is stale`);
    }
    const updated = await tx
      .update(researchProviderBudgetScopes)
      .set({
        permitStatus: input.status,
        permitUpdatedAt: observedAt,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(researchProviderBudgetScopes.id, id))
      .returning();
    if (updated[0] === undefined) {
      throw new Error(`provider budget scope ${id} was not updated`);
    }
    return asBudgetScope(updated[0]);
  });
}

/** Inspect one funded scope without converting exact NUMERIC accounting. */
export async function readResearchProviderBudgetScope(
  db: Database,
  budgetScopeId: string,
  now: Date = new Date(),
): Promise<ResearchProviderBudgetScopeView | null> {
  const id = nonempty(budgetScopeId, "budgetScopeId");
  validDate(now, "now");
  const scopeRows = await db
    .select()
    .from(researchProviderBudgetScopes)
    .where(eq(researchProviderBudgetScopes.id, id))
    .limit(1);
  const scope = scopeRows[0];
  if (scope === undefined) return null;
  const [allowlist, accounting, cooldownRows] = await Promise.all([
    db
      .select({ sourceSignalId: researchProviderBudgetScopeSignals.sourceSignalId })
      .from(researchProviderBudgetScopeSignals)
      .where(eq(researchProviderBudgetScopeSignals.budgetScopeId, id)),
    db.execute<{
      known_actual_cost_usd: string;
      unknown_estimated_cost_usd: string;
      committed_cost_usd: string;
      remaining_cost_usd: string;
      receipt_count: number;
      exhausted: boolean;
    }>(sql`
      SELECT
        COALESCE(sum(actual_cost_usd)
          FILTER (WHERE actual_cost_usd IS NOT NULL), 0::numeric)::text
          AS known_actual_cost_usd,
        COALESCE(sum(estimated_cost_usd)
          FILTER (WHERE actual_cost_usd IS NULL), 0::numeric)::text
          AS unknown_estimated_cost_usd,
        COALESCE(sum(COALESCE(actual_cost_usd, estimated_cost_usd)),
          0::numeric)::text AS committed_cost_usd,
        GREATEST(
          ${scope.totalCapUsd}::numeric
            - COALESCE(sum(COALESCE(actual_cost_usd, estimated_cost_usd)),
                0::numeric),
          0::numeric
        )::text AS remaining_cost_usd,
        count(*)::integer AS receipt_count,
        COALESCE(sum(COALESCE(actual_cost_usd, estimated_cost_usd)),
          0::numeric) >= ${scope.totalCapUsd}::numeric AS exhausted
      FROM research_provider_usage
      WHERE budget_scope_id = ${id}
    `),
    db
      .select({
        retryAt: researchProviderCooldowns.retryAt,
        reason: researchProviderCooldowns.reason,
      })
      .from(researchProviderCooldowns)
      .where(eq(researchProviderCooldowns.provider, scope.provider))
      .limit(1),
  ]);
  const totals = accounting.rows[0];
  if (totals === undefined) {
    throw new Error(`provider budget scope ${id} accounting was unavailable`);
  }
  const status: ResearchProviderBudgetOperationalStatus =
    scope.permitStatus === "closed"
      ? "closed"
      : scope.sealedAt === null
        ? "inactive"
        : totals.exhausted
          ? "exhausted"
          : scope.permitStatus === "active" && scope.startsAt <= now
            ? "active"
            : "inactive";
  return {
    scope: asBudgetScope(scope),
    allowlistedSourceSignalIds: allowlist
      .map((row) => row.sourceSignalId)
      .sort(),
    status,
    knownActualCostUsd: decimal(
      totals.known_actual_cost_usd,
      "knownActualCostUsd",
    ),
    unknownEstimatedCostUsd: decimal(
      totals.unknown_estimated_cost_usd,
      "unknownEstimatedCostUsd",
    ),
    committedCostUsd: decimal(totals.committed_cost_usd, "committedCostUsd"),
    remainingCostUsd: decimal(totals.remaining_cost_usd, "remainingCostUsd"),
    receiptCount: totals.receipt_count,
    providerCooldown:
      cooldownRows[0] !== undefined && cooldownRows[0].retryAt > now
        ? cooldownRows[0]
        : null,
  };
}

async function committedProviderCost(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  provider: string,
  day: string,
): Promise<ResearchProviderUsd> {
  const total = await tx.execute<{ committed_cost_usd: string }>(sql`
    SELECT (
      COALESCE((
        SELECT sum(COALESCE(actual_cost_usd, estimated_cost_usd))
        FROM research_provider_usage
        WHERE provider = ${provider}
          AND usage_day = ${day}::date
      ), 0::numeric)
      + COALESCE((
        SELECT sum(estimated_cost_usd)
        FROM research_provider_legacy_estimates
        WHERE provider = ${provider}
          AND usage_day = ${day}::date
      ), 0::numeric)
    )::text AS committed_cost_usd
  `);
  return decimal(total.rows[0]?.committed_cost_usd ?? "0", "committedCostUsd");
}

async function committedScopeCost(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  budgetScopeId: string,
): Promise<ResearchProviderUsd> {
  const total = await tx.execute<{ committed_cost_usd: string }>(sql`
    SELECT COALESCE(
      sum(COALESCE(actual_cost_usd, estimated_cost_usd)),
      0::numeric
    )::text AS committed_cost_usd
    FROM research_provider_usage
    WHERE budget_scope_id = ${budgetScopeId}
  `);
  return decimal(total.rows[0]?.committed_cost_usd ?? "0", "scopeCommittedCostUsd");
}

/**
 * Reserve estimated provider spend before a network call. The provider/day
 * advisory lock serializes the exact NUMERIC admission decision across workers.
 * Unsettled and unknown-cost calls continue to consume their estimate.
 */
export async function reserveResearchProviderUsage(
  db: Database,
  input: ReserveResearchProviderUsageInput,
): Promise<ReserveResearchProviderUsageResult> {
  const provider = nonempty(input.provider, "provider");
  const operation = nonempty(input.operation, "operation");
  const budgetScopeId = nonempty(input.budgetScopeId, "budgetScopeId");
  const sourceSignalId = nonempty(input.sourceSignalId, "sourceSignalId");
  if (!SHA256_PATTERN.test(input.requestHash)) {
    throw new TypeError("requestHash must be a lowercase SHA-256 digest");
  }
  const estimatedCostUsd = decimal(
    input.estimatedCostUsd,
    "estimatedCostUsd",
  );
  const dailyCapUsd = decimal(input.dailyCapUsd, "dailyCapUsd");
  const now = validDate(input.now ?? new Date(), "now");
  const day = now.toISOString().slice(0, 10);

  return db.transaction(async (tx) => {
    await lockProvider(tx, provider);
    const analystStepId = input.analystStepId ?? null;
    if (analystStepId !== null) {
      const stepRows = await tx.execute<{
        status: string;
        request_hash: string;
        case_signal_id: string;
        executable: boolean;
      }>(sql`
        SELECT
          step.status,
          step.request_hash,
          analyst_case.signal_id AS case_signal_id,
          (
            step.status = 'in_progress'
            AND analyst_case.status = 'active'
            AND analyst_case.input_hash = step.claim_input_hash
            AND analyst_case.source_revision = source.review_revision
            AND review.source_revision = source.review_revision
            AND review.phase = step.claim_phase
            AND review.lease_token = step.claim_lease_token
            AND review.lease_expires_at > clock_timestamp()
            AND review.input_hash IS NOT NULL
            AND review.input_hash = step.claim_input_hash
          ) AS executable
        FROM signal_analyst_steps step
        JOIN signal_analyst_cases analyst_case
          ON analyst_case.id = step.case_id
        JOIN source_signals source
          ON source.id = analyst_case.signal_id
        LEFT JOIN signal_review_state review
          ON review.signal_id = analyst_case.signal_id
        WHERE step.id = ${analystStepId}::uuid
        FOR UPDATE OF step
      `);
      const step = stepRows.rows[0];
      if (step === undefined) {
        throw new Error(`analyst step ${analystStepId} does not exist`);
      }
      if (step.case_signal_id !== sourceSignalId) {
        throw new Error(
          `analyst step ${analystStepId} belongs to a different source signal`,
        );
      }
      if (step.request_hash !== input.requestHash) {
        throw new Error(
          `analyst step ${analystStepId} request hash does not match the provider request`,
        );
      }

      const priorRows = await tx
        .select()
        .from(researchProviderUsage)
        .where(eq(researchProviderUsage.analystStepId, analystStepId))
        .limit(1);
      const prior = priorRows[0];
      if (prior !== undefined) {
        if (
          prior.provider !== provider ||
          prior.operation !== operation ||
          prior.sourceSignalId !== sourceSignalId ||
          prior.budgetScopeId !== budgetScopeId ||
          prior.requestHash !== input.requestHash ||
          decimal(prior.estimatedCostUsd, "stored estimatedCostUsd") !==
            estimatedCostUsd
        ) {
          throw new Error(
            `analyst step ${analystStepId} has a conflicting provider reservation`,
          );
        }
        return {
          outcome: "reserved",
          reused: true,
          reservation: asReceipt(prior),
        };
      }
      if (!step.executable) {
        throw new Error(
          `analyst step ${analystStepId} is not executable under its current claim`,
        );
      }
    }
    const scopeRows = await tx
      .select()
      .from(researchProviderBudgetScopes)
      .where(eq(researchProviderBudgetScopes.id, budgetScopeId))
      .limit(1)
      .for("update");
    const scope = scopeRows[0];
    if (scope === undefined) {
      throw new Error(`provider budget scope ${budgetScopeId} does not exist`);
    }
    if (scope.sealedAt === null) {
      throw new Error(`provider budget scope ${budgetScopeId} is not sealed`);
    }
    if (scope.provider !== provider) {
      throw new Error(
        `provider budget scope ${budgetScopeId} is for ${scope.provider}, not ${provider}`,
      );
    }
    const scopeCommittedCostUsd = await committedScopeCost(tx, budgetScopeId);
    const scopeDeferral = (
      reason: "scope_not_started" | "scope_paused" | "scope_closed",
      retryAt: Date | null,
    ): ReserveResearchProviderUsageResult => ({
      outcome: "deferred",
      reason,
      provider,
      budgetScopeId,
      committedCostUsd: scopeCommittedCostUsd,
      estimatedCostUsd,
      totalCapUsd: decimal(scope.totalCapUsd, "stored totalCapUsd"),
      retryAt,
    });
    if (scope.startsAt > now) {
      return scopeDeferral("scope_not_started", scope.startsAt);
    }
    if (scope.permitStatus === "paused") {
      return scopeDeferral("scope_paused", null);
    }
    if (scope.permitStatus === "closed") {
      return scopeDeferral("scope_closed", null);
    }

    const permission = await tx
      .select({ sourceSignalId: researchProviderBudgetScopeSignals.sourceSignalId })
      .from(researchProviderBudgetScopeSignals)
      .where(
        and(
          eq(researchProviderBudgetScopeSignals.budgetScopeId, budgetScopeId),
          eq(researchProviderBudgetScopeSignals.sourceSignalId, sourceSignalId),
        ),
      )
      .limit(1);
    if (permission[0] === undefined) {
      return {
        outcome: "deferred",
        reason: "source_not_permitted",
        provider,
        budgetScopeId,
        sourceSignalId,
        retryAt: null,
      };
    }

    const cooldownRows = await tx
      .select()
      .from(researchProviderCooldowns)
      .where(eq(researchProviderCooldowns.provider, provider))
      .limit(1);
    const cooldown = cooldownRows[0];
    if (cooldown !== undefined && cooldown.retryAt > now) {
      return {
        outcome: "deferred",
        reason: "provider_cooldown",
        provider,
        retryAt: cooldown.retryAt,
        cooldownReason: cooldown.reason,
      };
    }
    if (cooldown !== undefined) {
      await tx
        .delete(researchProviderCooldowns)
        .where(eq(researchProviderCooldowns.provider, provider));
    }

    const scopeAdmission = await tx.execute<{ admitted: boolean }>(sql`
      SELECT (
        ${scopeCommittedCostUsd}::numeric + ${estimatedCostUsd}::numeric
        <= ${scope.totalCapUsd}::numeric
      ) AS admitted
    `);
    if (scopeAdmission.rows[0]?.admitted !== true) {
      return {
        outcome: "deferred",
        reason: "scope_cap_exceeded",
        provider,
        budgetScopeId,
        committedCostUsd: scopeCommittedCostUsd,
        estimatedCostUsd,
        totalCapUsd: decimal(scope.totalCapUsd, "stored totalCapUsd"),
        retryAt: null,
      };
    }

    const committedCostUsd = await committedProviderCost(tx, provider, day);
    const dailyAdmission = await tx.execute<{ admitted: boolean }>(sql`
      SELECT (
        ${committedCostUsd}::numeric + ${estimatedCostUsd}::numeric
        <= ${dailyCapUsd}::numeric
      ) AS admitted
    `);
    if (dailyAdmission.rows[0]?.admitted !== true) {
      return {
        outcome: "deferred",
        reason: "daily_cap_exceeded",
        provider,
        utcDay: day,
        committedCostUsd,
        estimatedCostUsd,
        dailyCapUsd,
        retryAt: nextUtcDay(day),
      };
    }

    const rows = await tx
      .insert(researchProviderUsage)
      .values({
        provider,
        operation,
        sourceSignalId,
        analystStepId,
        budgetScopeId,
        requestHash: input.requestHash,
        usageDay: day,
        estimatedCostUsd,
        status: "reserved",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const reservation = rows[0];
    if (reservation === undefined) {
      throw new Error("provider usage reservation was not persisted");
    }
    return {
      outcome: "reserved",
      reused: false,
      reservation: asReceipt(reservation),
    };
  });
}

async function persistProviderCooldown(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  provider: string,
  reservationId: string,
  status: ResearchProviderSettlementStatus,
  observedAt: Date,
  cooldown:
    | {
        retryAt: Date;
        reason: string;
      }
    | undefined,
): Promise<void> {
  if (cooldown !== undefined) {
    await tx
      .insert(researchProviderCooldowns)
      .values({
        provider,
        retryAt: cooldown.retryAt,
        reason: cooldown.reason,
        sourceReservationId: reservationId,
        observedAt,
        updatedAt: sql`clock_timestamp()`,
      })
      .onConflictDoUpdate({
        target: researchProviderCooldowns.provider,
        set: {
          retryAt: sql`GREATEST(${researchProviderCooldowns.retryAt}, excluded.retry_at)`,
          reason: sql`CASE
            WHEN excluded.retry_at >= ${researchProviderCooldowns.retryAt}
              THEN excluded.reason
            ELSE ${researchProviderCooldowns.reason}
          END`,
          sourceReservationId: sql`CASE
            WHEN excluded.retry_at >= ${researchProviderCooldowns.retryAt}
              THEN excluded.source_reservation_id
            ELSE ${researchProviderCooldowns.sourceReservationId}
          END`,
          observedAt: sql`CASE
            WHEN excluded.retry_at >= ${researchProviderCooldowns.retryAt}
              THEN excluded.observed_at
            ELSE ${researchProviderCooldowns.observedAt}
          END`,
          updatedAt: sql`clock_timestamp()`,
        },
      });
    return;
  }
  if (status === "succeeded") {
    await tx
      .delete(researchProviderCooldowns)
      .where(
        and(
          eq(researchProviderCooldowns.provider, provider),
          sql`${researchProviderCooldowns.retryAt} <= ${observedAt}`,
        ),
      );
  }
}

/**
 * Settle a reservation exactly once. A nullable actual is deliberately not
 * converted to zero: future admission continues to count the estimate.
 */
export async function settleResearchProviderUsage(
  db: Database,
  reservationId: string,
  input: SettleResearchProviderUsageInput,
): Promise<ResearchProviderUsageReceipt> {
  const observedAt = validDate(input.observedAt, "observedAt");
  const actualCostUsd =
    input.actualCostUsd === null
      ? null
      : decimal(input.actualCostUsd, "actualCostUsd");
  const error = input.error?.slice(0, 10_000) ?? null;
  const providerCooldown =
    input.providerCooldown === undefined
      ? undefined
      : {
          retryAt: validDate(
            input.providerCooldown.retryAt,
            "providerCooldown.retryAt",
          ),
          reason: nonempty(
            input.providerCooldown.reason,
            "providerCooldown.reason",
          ),
        };
  if (
    providerCooldown !== undefined &&
    providerCooldown.retryAt <= observedAt
  ) {
    throw new TypeError("providerCooldown.retryAt must be after observedAt");
  }

  return db.transaction(async (tx) => {
    const providerRows = await tx
      .select({ provider: researchProviderUsage.provider })
      .from(researchProviderUsage)
      .where(eq(researchProviderUsage.id, reservationId))
      .limit(1);
    const provider = providerRows[0]?.provider;
    if (provider === undefined) {
      throw new Error(`provider usage reservation ${reservationId} does not exist`);
    }
    await lockProvider(tx, provider);
    const rows = await tx
      .select()
      .from(researchProviderUsage)
      .where(eq(researchProviderUsage.id, reservationId))
      .limit(1)
      .for("update");
    const existing = rows[0];
    if (existing === undefined) {
      throw new Error(`provider usage reservation ${reservationId} does not exist`);
    }
    if (existing.status !== "reserved") {
      const existingActual =
        existing.actualCostUsd === null
          ? null
          : decimal(existing.actualCostUsd, "stored actualCostUsd");
      if (
        existing.status !== input.status ||
        existingActual !== actualCostUsd ||
        existing.observedAt?.getTime() !== observedAt.getTime() ||
        (existing.error ?? null) !== error ||
        existing.providerCooldownRetryAt?.getTime() !==
          providerCooldown?.retryAt.getTime() ||
        (existing.providerCooldownReason ?? undefined) !==
          providerCooldown?.reason
      ) {
        throw new Error(
          `provider usage reservation ${reservationId} has a conflicting settlement`,
        );
      }
      await persistProviderCooldown(
        tx,
        provider,
        reservationId,
        input.status,
        observedAt,
        providerCooldown,
      );
      return asReceipt(existing);
    }

    const updated = await tx
      .update(researchProviderUsage)
      .set({
        status: input.status,
        actualCostUsd,
        observedAt,
        error,
        providerCooldownRetryAt: providerCooldown?.retryAt ?? null,
        providerCooldownReason: providerCooldown?.reason ?? null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(researchProviderUsage.id, reservationId),
          eq(researchProviderUsage.status, "reserved"),
        ),
      )
      .returning();
    const receipt = updated[0];
    if (receipt === undefined) {
      throw new Error(`provider usage reservation ${reservationId} was not settled`);
    }
    await persistProviderCooldown(
      tx,
      provider,
      reservationId,
      input.status,
      observedAt,
      providerCooldown,
    );
    return asReceipt(receipt);
  });
}

/**
 * Import one legacy file-ledger estimate during a quiesced cutover. Replaying
 * the same key is idempotent; changing its day or amount is rejected rather
 * than silently rewriting historical estimated spend.
 */
export async function importLegacyResearchProviderEstimate(
  db: Database,
  input: ImportLegacyResearchProviderEstimateInput,
): Promise<ImportLegacyResearchProviderEstimateResult> {
  const provider = nonempty(input.provider, "provider");
  const day = utcDay(input.utcDay);
  const estimatedCostUsd = decimal(
    input.estimatedCostUsd,
    "estimatedCostUsd",
  );
  const idempotencyKey = nonempty(input.idempotencyKey, "idempotencyKey");
  const importedAt = validDate(input.importedAt ?? new Date(), "importedAt");

  return db.transaction(async (tx) => {
    await lockProvider(tx, provider);
    const inserted = await tx
      .insert(researchProviderLegacyEstimates)
      .values({
        provider,
        usageDay: day,
        estimatedCostUsd,
        idempotencyKey,
        importedAt,
      })
      .onConflictDoNothing({
        target: [
          researchProviderLegacyEstimates.provider,
          researchProviderLegacyEstimates.idempotencyKey,
        ],
      })
      .returning();
    if (inserted[0] !== undefined) {
      return { outcome: "imported", estimate: inserted[0] };
    }

    const existingRows = await tx
      .select()
      .from(researchProviderLegacyEstimates)
      .where(
        and(
          eq(researchProviderLegacyEstimates.provider, provider),
          eq(researchProviderLegacyEstimates.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    const existing = existingRows[0];
    if (existing === undefined) {
      throw new Error("legacy provider estimate disappeared during import");
    }
    if (
      existing.usageDay !== day ||
      decimal(existing.estimatedCostUsd, "stored estimatedCostUsd") !==
        estimatedCostUsd
    ) {
      throw new Error(
        `legacy provider estimate ${provider}/${idempotencyKey} conflicts with its prior import`,
      );
    }
    return { outcome: "existing", estimate: existing };
  });
}
