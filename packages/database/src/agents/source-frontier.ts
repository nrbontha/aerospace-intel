import { createHash } from "node:crypto";

import {
  and,
  asc,
  desc,
  eq,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";

import { getDatabase } from "../client.js";
import { frontierItems, type FrontierItem } from "../schema.js";

/** A crashed claim becomes eligible for another worker before the next hourly tick. */
export const AGENT_QUERY_STALE_CLAIM_MS = 30 * 60_000;
/** A fifth consecutive failed attempt exhausts a monthly query. */
export const AGENT_QUERY_MAX_ATTEMPTS = 5;

export interface AgentQueryProposal {
  readonly itemType: "query";
  readonly normalizedValue: string;
  readonly priority?: number;
  readonly estimatedCostUsd?: number;
  readonly payload?: Record<string, unknown>;
}

export interface EnsureAgentMonthlyQueriesResult {
  readonly inserted: number;
  readonly total: number;
}

export interface AgentFrontierCursor {
  readonly sortValue: string;
  readonly uniqueId: number;
}

export interface AgentFrontierProgress {
  readonly total: number;
  readonly pending: number;
  readonly inProgress: number;
  readonly completed: number;
  readonly failed: number;
  /** Monthly windows still awaiting work, including the currently claimed one. */
  readonly pendingMonths: number;
  readonly completedMonths: number;
  readonly currentMonth: string | null;
  readonly currentPage: number | null;
  readonly currentCursor: AgentFrontierCursor | null;
  readonly lastAttemptAt: string | null;
}

function normalizeQueryValue(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/\s+/gu, " ");
}

/** Initial rows only: continuations mutate the same row and never mint another key. */
export function agentQueryIdempotencyKey(
  agentId: string,
  normalizedValue: string,
): string {
  return createHash("sha256")
    .update(`${agentId}|query|${normalizeQueryValue(normalizedValue)}`)
    .digest("hex");
}

/**
 * Persist the strategy's complete monthly expansion. Repeated or concurrent
 * expansion is harmless because each agent/month pair has one stable key.
 */
export async function ensureAgentMonthlyQueries(
  agentId: string,
  queryProposals: readonly AgentQueryProposal[],
): Promise<EnsureAgentMonthlyQueriesResult> {
  const values = queryProposals.map((proposal) => {
    const normalizedValue = normalizeQueryValue(proposal.normalizedValue);
    if (normalizedValue === "") {
      throw new Error("agent monthly query normalizedValue must not be empty");
    }
    return {
      agentId,
      campaignId: null,
      itemType: "query" as const,
      normalizedValue,
      priority: String(proposal.priority ?? 0),
      estimatedCostUsd: String(proposal.estimatedCostUsd ?? 0),
      depth: 1,
      status: "pending" as const,
      idempotencyKey: agentQueryIdempotencyKey(agentId, normalizedValue),
      payload: proposal.payload ?? {},
    };
  });

  if (values.length === 0) {
    const progress = await agentFrontierProgress(agentId);
    return { inserted: 0, total: progress.total };
  }

  const inserted = await getDatabase()
    .insert(frontierItems)
    .values(values)
    .onConflictDoNothing({ target: frontierItems.idempotencyKey })
    .returning({ id: frontierItems.id });
  const progress = await agentFrontierProgress(agentId);
  return { inserted: inserted.length, total: progress.total };
}

/**
 * Atomically claim exactly one due monthly query. SKIP LOCKED lets separate
 * supervisors advance different months without waiting on each other. A stale
 * in-progress row is reclaimed with its payload (and cursor) untouched.
 */
export async function claimNextAgentQuery(
  agentId: string,
): Promise<FrontierItem | null> {
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - AGENT_QUERY_STALE_CLAIM_MS);

  return getDatabase().transaction(async (tx) => {
    const [claimable] = await tx
      .select({ id: frontierItems.id })
      .from(frontierItems)
      .where(
        and(
          eq(frontierItems.agentId, agentId),
          isNull(frontierItems.campaignId),
          eq(frontierItems.itemType, "query"),
          or(
            and(
              eq(frontierItems.status, "pending"),
              or(
                isNull(frontierItems.nextAttemptAt),
                lte(frontierItems.nextAttemptAt, now),
              ),
            ),
            and(
              eq(frontierItems.status, "in_progress"),
              or(
                isNull(frontierItems.lastAttemptAt),
                lt(frontierItems.lastAttemptAt, staleCutoff),
              ),
            ),
          ),
        ),
      )
      .orderBy(
        desc(frontierItems.priority),
        asc(frontierItems.createdAt),
        asc(frontierItems.normalizedValue),
      )
      .limit(1)
      .for("update", { skipLocked: true });

    if (claimable === undefined) return null;
    const [claimed] = await tx
      .update(frontierItems)
      .set({
        status: "in_progress",
        attemptCount: sql`${frontierItems.attemptCount} + 1`,
        lastAttemptAt: now,
        nextAttemptAt: null,
      })
      .where(eq(frontierItems.id, claimable.id))
      .returning();
    return claimed ?? null;
  });
}

export async function completeAgentQuery(id: string): Promise<FrontierItem | null> {
  const [row] = await getDatabase()
    .update(frontierItems)
    .set({
      status: "done",
      completedAt: new Date(),
      nextAttemptAt: null,
      failureReason: null,
    })
    .where(and(eq(frontierItems.id, id), eq(frontierItems.status, "in_progress")))
    .returning();
  return row ?? null;
}

/** Requeue the claimed row in place with its advanced page/cursor payload. */
export async function continueAgentQuery(
  id: string,
  payload: Record<string, unknown>,
  nextAttemptAt?: Date,
): Promise<FrontierItem | null> {
  const [row] = await getDatabase()
    .update(frontierItems)
    .set({
      status: "pending",
      payload,
      attemptCount: 0,
      nextAttemptAt: nextAttemptAt ?? null,
      failureReason: null,
      completedAt: null,
    })
    .where(and(eq(frontierItems.id, id), eq(frontierItems.status, "in_progress")))
    .returning();
  return row ?? null;
}

/**
 * Back off a failed attempt without changing its payload. Once the claim-side
 * attempt counter reaches the maximum, the row becomes terminally failed.
 */
export async function failAgentQuery(
  id: string,
  error: string,
  backoff: number | Date,
): Promise<FrontierItem | null> {
  const now = new Date();
  const nextAttemptAt =
    backoff instanceof Date ? backoff : new Date(now.getTime() + Math.max(0, backoff));
  const [row] = await getDatabase()
    .update(frontierItems)
    .set({
      status: sql`CASE WHEN ${frontierItems.attemptCount} >= ${AGENT_QUERY_MAX_ATTEMPTS} THEN 'failed'::frontier_item_status ELSE 'pending'::frontier_item_status END`,
      failureReason: error.slice(0, 9_999),
      nextAttemptAt: sql`CASE WHEN ${frontierItems.attemptCount} >= ${AGENT_QUERY_MAX_ATTEMPTS} THEN NULL ELSE ${nextAttemptAt}::timestamptz END`,
      completedAt: sql`CASE WHEN ${frontierItems.attemptCount} >= ${AGENT_QUERY_MAX_ATTEMPTS} THEN ${now}::timestamptz ELSE NULL END`,
    })
    .where(and(eq(frontierItems.id, id), eq(frontierItems.status, "in_progress")))
    .returning();
  return row ?? null;
}

function integerPayloadValue(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function currentMonthOf(item: FrontierItem): string | null {
  const timePeriod = item.payload["timePeriod"];
  if (typeof timePeriod === "object" && timePeriod !== null && !Array.isArray(timePeriod)) {
    const startDate = (timePeriod as Record<string, unknown>)["startDate"];
    if (typeof startDate === "string" && /^\d{4}-\d{2}/u.test(startDate)) {
      return startDate.slice(0, 7);
    }
  }
  return /:(\d{4}-\d{2})$/u.exec(item.normalizedValue)?.[1] ?? null;
}

export async function agentFrontierProgress(
  agentId: string,
): Promise<AgentFrontierProgress> {
  const db = getDatabase();
  const [countsResult, activeRows] = await Promise.all([
    db.execute<{
      total: string;
      pending: string;
      in_progress: string;
      completed: string;
      failed: string;
      last_attempt_at: Date | string | null;
    }>(sql`
      SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE status = 'pending')::text AS pending,
        COUNT(*) FILTER (WHERE status = 'in_progress')::text AS in_progress,
        COUNT(*) FILTER (WHERE status = 'done')::text AS completed,
        COUNT(*) FILTER (WHERE status = 'failed')::text AS failed,
        MAX(last_attempt_at) AS last_attempt_at
      FROM ${frontierItems}
      WHERE ${frontierItems.agentId} = ${agentId}
        AND ${frontierItems.campaignId} IS NULL
        AND ${frontierItems.itemType} = 'query'
    `),
    db
      .select()
      .from(frontierItems)
      .where(
        and(
          eq(frontierItems.agentId, agentId),
          isNull(frontierItems.campaignId),
          eq(frontierItems.itemType, "query"),
          or(eq(frontierItems.status, "in_progress"), eq(frontierItems.status, "pending")),
        ),
      )
      .orderBy(
        sql`CASE WHEN ${frontierItems.status} = 'in_progress' THEN 0 ELSE 1 END`,
        desc(frontierItems.priority),
        asc(frontierItems.createdAt),
        asc(frontierItems.normalizedValue),
      )
      .limit(1),
  ]);

  const counts = countsResult.rows[0];
  const active = activeRows[0] ?? null;
  const pending = Number(counts?.pending ?? 0);
  const inProgress = Number(counts?.in_progress ?? 0);
  const lastAttempt = counts?.last_attempt_at ?? null;
  const cursorSortValue =
    active !== null && typeof active.payload["cursorSortValue"] === "string"
      ? active.payload["cursorSortValue"]
      : null;
  const cursorUniqueId =
    active === null ? null : integerPayloadValue(active.payload, "cursorUniqueId");

  return {
    total: Number(counts?.total ?? 0),
    pending,
    inProgress,
    completed: Number(counts?.completed ?? 0),
    failed: Number(counts?.failed ?? 0),
    pendingMonths: pending + inProgress,
    completedMonths: Number(counts?.completed ?? 0),
    currentMonth: active === null ? null : currentMonthOf(active),
    currentPage: active === null ? null : (integerPayloadValue(active.payload, "resumePage") ?? 1),
    currentCursor:
      cursorSortValue !== null && cursorUniqueId !== null
        ? { sortValue: cursorSortValue, uniqueId: cursorUniqueId }
        : null,
    lastAttemptAt:
      lastAttempt === null
        ? null
        : lastAttempt instanceof Date
          ? lastAttempt.toISOString()
          : new Date(lastAttempt).toISOString(),
  };
}
