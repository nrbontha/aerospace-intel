import type { CampaignStatus } from "@asi/contracts";
import {
  type FrontierItem,
  type ResearchCampaign,
  frontierItems,
  researchCampaigns,
} from "@asi/database";
import { getDatabase } from "@asi/database/client";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";

import {
  dailyBudgetCapUsd,
  evaluateBudgets,
  getDailySpendUsd,
  recordSpend,
} from "./budget.js";
import { toCampaignView } from "./planner.js";
import {
  type CampaignView,
  type DiscoveryStrategy,
  type FrontierItemView,
  type FrontierProposal,
  frontierIdempotencyKey,
} from "./types.js";

/** Backoff base for failed items. */
export const BACKOFF_BASE_MS = 15 * 60 * 1_000;
/** Upper bound for backoff. */
export const BACKOFF_MAX_MS = 24 * 60 * 60 * 1_000;
/** Attempts (inclusive) before an item is marked failed. */
export const MAX_ITEM_ATTEMPTS = 5;
/** Items stuck in_progress longer than this are reclaimable after a crash. */
export const DEFAULT_STALE_CLAIM_MS = 10 * 60 * 1_000;

/**
 * Exponential backoff: min(15min * 2^attempts, 24h), where attempts is the
 * number of attempts already consumed by the item.
 */
export function computeBackoffDelayMs(attempts: number): number {
  const clamped = Math.min(Math.max(0, Math.trunc(attempts)), 20);
  return Math.min(BACKOFF_BASE_MS * 2 ** clamped, BACKOFF_MAX_MS);
}

export type ProcessStopReason =
  | "slice_complete"
  | "not_running"
  | "campaign_completed"
  | "frontier_exhausted"
  | "budget_exhausted"
  | "aborted"
  | "nothing_due";

export interface ProcessDueResult {
  claimed: number;
  completed: number;
  failed: number;
  childrenInserted: number;
  stopReason: ProcessStopReason;
}

export interface ProcessDueOptions {
  strategy: DiscoveryStrategy;
  /** Max items processed in parallel per batch; defaults to campaign.concurrency. */
  maxConcurrent?: number;
  /** Wall-time budget for this invocation; defaults to 60s. */
  wallTimeMs?: number;
  /** Injectable clock (tests). */
  now?: () => Date;
  /** Injectable daily spend override; computed from model_usage otherwise. */
  dailySpendUsd?: number;
  maxAttempts?: number;
  staleClaimMs?: number;
  /** Cooperative cancellation (worker SIGTERM). */
  signal?: AbortSignal;
}

async function loadCampaignRow(
  campaignId: string,
): Promise<ResearchCampaign | null> {
  const [row] = await getDatabase()
    .select()
    .from(researchCampaigns)
    .where(eq(researchCampaigns.id, campaignId))
    .limit(1);
  return row ?? null;
}

/**
 * Claim due items atomically:
 * - pending whose next_attempt_at is due (or NULL), OR
 * - in_progress past the stale-claim window (crashed-worker recovery).
 * FOR UPDATE SKIP LOCKED makes concurrent workers safe; attempt_count is
 * incremented at claim time so a crash mid-execution still consumes an
 * attempt and is retried or eventually failed.
 */
async function claimDueItems(
  campaignId: string,
  limit: number,
  now: Date,
  staleClaimMs: number,
): Promise<FrontierItem[]> {
  const staleCutoff = new Date(now.getTime() - staleClaimMs);
  return getDatabase().transaction(async (tx) => {
    const claimed = await tx
      .select({ id: frontierItems.id })
      .from(frontierItems)
      .where(
        and(
          eq(frontierItems.campaignId, campaignId),
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
              lt(frontierItems.lastAttemptAt, staleCutoff),
            ),
          ),
        ),
      )
      .orderBy(desc(frontierItems.priority), asc(frontierItems.createdAt))
      .limit(limit)
      .for("update", { skipLocked: true });

    if (claimed.length === 0) return [];

    return tx
      .update(frontierItems)
      .set({
        status: "in_progress",
        attemptCount: sql`${frontierItems.attemptCount} + 1`,
        lastAttemptAt: now,
      })
      .where(inArray(frontierItems.id, claimed.map((row) => row.id)))
      .returning();
  });
}

type StopEvaluation =
  | { kind: "continue" }
  | { kind: "wait" }
  | { kind: "finalize"; status: "completed" | "frontier_exhausted"; reason: ProcessStopReason };

/**
 * Pure stopping-rule evaluation (unit-tested):
 * - explicit limits hit -> completed,
 * - no open items at all -> frontier_exhausted,
 * - open items exist but none are due (backed off or fresh in flight) ->
 *   wait,
 * - otherwise continue.
 * Stale in_progress items count as DUE: they are reclaimable abandoned
 * claims from a crashed worker, so the campaign must not finalize while
 * recovery work remains.
 */
export function evaluateStoppingRules(
  input: {
    totalItems: number;
    companyItems: number;
    dueItems: number;
    openItems: number;
  },
  rules: { maxFrontierItems?: number; targetCompanies?: number },
): StopEvaluation {
  if (
    rules.maxFrontierItems !== undefined &&
    input.totalItems >= rules.maxFrontierItems
  ) {
    return { kind: "finalize", status: "completed", reason: "campaign_completed" };
  }
  if (
    rules.targetCompanies !== undefined &&
    input.companyItems >= rules.targetCompanies
  ) {
    return { kind: "finalize", status: "completed", reason: "campaign_completed" };
  }
  if (input.openItems === 0) {
    return {
      kind: "finalize",
      status: "frontier_exhausted",
      reason: "frontier_exhausted",
    };
  }
  if (input.dueItems === 0) {
    return { kind: "wait" };
  }
  return { kind: "continue" };
}

async function finalizeCampaign(
  campaignId: string,
  status: Extract<CampaignStatus, "completed" | "frontier_exhausted">,
  now: Date,
): Promise<void> {
  await getDatabase()
    .update(researchCampaigns)
    .set({ status, completedAt: now })
    .where(
      and(
        eq(researchCampaigns.id, campaignId),
        eq(researchCampaigns.status, "running"),
      ),
    );
}

/** Roll back freshly-claimed items when the slice is aborted mid-flight. */
async function releaseClaimedToPending(itemIds: string[]): Promise<void> {
  if (itemIds.length === 0) return;
  await getDatabase()
    .update(frontierItems)
    .set({
      status: "pending",
      attemptCount: sql`${frontierItems.attemptCount} - 1`,
    })
    .where(
      and(
        inArray(frontierItems.id, itemIds),
        eq(frontierItems.status, "in_progress"),
      ),
    );
}

function childDiscoveryPath(parent: FrontierItem): string {
  const parentPath =
    parent.discoveryPath === null
      ? parent.normalizedValue
      : `${parent.discoveryPath} > ${parent.normalizedValue}`;
  // discovery_path stores ancestors; keep it under the 10k contract bound.
  return parentPath.slice(-10_000);
}

/**
 * Partition proposals into regular children and at most one SELF-
 * continuation: a proposal whose itemType AND normalizedValue equal the
 * parent's own identity. Strategies use it to paginate stateful sources —
 * "requeue me with this advanced payload" (next page / cursor) instead of
 * completing. Everything else is a normal child.
 */
function splitSelfContinuation(
  item: FrontierItem,
  proposals: FrontierProposal[],
): { children: FrontierProposal[]; continuationPayload: Record<string, unknown> | null } {
  let continuationPayload: Record<string, unknown> | null = null;
  const children: FrontierProposal[] = [];
  for (const proposal of proposals) {
    if (
      continuationPayload === null &&
      proposal.payload !== undefined &&
      proposal.itemType === item.itemType &&
      proposal.normalizedValue === item.normalizedValue
    ) {
      continuationPayload = proposal.payload;
      continue;
    }
    children.push(proposal);
  }
  return { children, continuationPayload };
}

/**
 * Deterministic JSON: object keys sorted, undefined dropped. Used to prove
 * a continuation actually advances the payload — a strategy bug that
 * re-proposes an identical payload would otherwise requeue forever.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Requeue an in-progress item as pending with an advanced payload. The
 * attempt budget resets: the slice made forward progress and the item
 * continues as a fresh unit (retry/backoff still applies when a future
 * slice THROWS). Guarded on status=in_progress so a concurrent stale
 * reclaim can never clobber an already re-claimed row — worst case there
 * is one redundant re-run, which child idempotency keys absorb.
 */
async function requeueItemWithPayload(
  item: FrontierItem,
  payload: Record<string, unknown>,
  now: Date,
): Promise<void> {
  await getDatabase()
    .update(frontierItems)
    .set({
      status: "pending",
      payload,
      attemptCount: 0,
      nextAttemptAt: null,
      lastAttemptAt: now,
      failureReason: null,
    })
    .where(
      and(
        eq(frontierItems.id, item.id),
        eq(frontierItems.status, "in_progress"),
      ),
    );
}

async function insertChildren(
  parent: FrontierItem,
  proposals: FrontierProposal[],
  maxDepth: number,
): Promise<number> {
  const childDepth = parent.depth + 1;
  const eligible = childDepth <= maxDepth ? proposals : [];
  if (eligible.length === 0) return 0;
  // Campaign-path invariant: expansion only runs on campaign-owned items.
  if (parent.campaignId === null) {
    throw new Error(
      "frontier expansion reached a frontier item without a campaign owner",
    );
  }
  const parentCampaignId = parent.campaignId;
  const values = eligible.map((proposal) => ({
    campaignId: parent.campaignId,
    itemType: proposal.itemType,
    normalizedValue: proposal.normalizedValue,
    parentItemId: parent.id,
    discoveryPath: childDiscoveryPath(parent),
    priority: String(proposal.priority ?? 0),
    estimatedCostUsd: String(proposal.estimatedCostUsd ?? 0),
    depth: childDepth,
    status: "pending" as const,
    idempotencyKey: frontierIdempotencyKey(
      parentCampaignId,
      proposal.itemType,
      proposal.normalizedValue,
    ),
    ...(proposal.payload === undefined ? {} : { payload: proposal.payload }),
  }));

  const inserted = await getDatabase()
    .insert(frontierItems)
    .values(values)
    .onConflictDoNothing({ target: frontierItems.idempotencyKey })
    .returning({ id: frontierItems.id });
  return inserted.length;
}

function toItemView(item: FrontierItem): FrontierItemView {
  // Campaign runner only claims campaign-owned rows; agent-owned items
  // (migration 0003) never enter this path.
  if (item.campaignId === null) {
    throw new Error("frontier item without a campaign owner reached the campaign runner");
  }
  return {
    id: item.id,
    campaignId: item.campaignId,
    itemType: item.itemType,
    normalizedValue: item.normalizedValue,
    parentItemId: item.parentItemId,
    discoveryPath: item.discoveryPath,
    depth: item.depth,
    payload: item.payload,
  };
}

async function completeItem(item: FrontierItem, now: Date): Promise<void> {
  await getDatabase()
    .update(frontierItems)
    .set({ status: "done", completedAt: now })
    .where(eq(frontierItems.id, item.id));
}

async function failOrRetryItem(
  item: FrontierItem,
  failureReason: string,
  now: Date,
  maxAttempts: number,
): Promise<"failed" | "retried"> {
  if (item.attemptCount >= maxAttempts) {
    await getDatabase()
      .update(frontierItems)
      .set({
        status: "failed",
        failureReason: failureReason.slice(0, 9_999),
      })
      .where(
        and(eq(frontierItems.id, item.id), eq(frontierItems.status, "in_progress")),
      );
    return "failed";
  }
  await getDatabase()
    .update(frontierItems)
    .set({
      status: "pending",
      failureReason: failureReason.slice(0, 9_999),
      nextAttemptAt: new Date(now.getTime() + computeBackoffDelayMs(item.attemptCount)),
    })
    .where(
      and(eq(frontierItems.id, item.id), eq(frontierItems.status, "in_progress")),
    );
  return "retried";
}

interface FrontierTotals {
  claimed: number;
  completed: number;
  failed: number;
  childrenInserted: number;
}

function resultOf(
  totals: FrontierTotals,
  stopReason: ProcessStopReason,
): ProcessDueResult {
  return { ...totals, stopReason };
}

interface DueCounts {
  totalItems: number;
  companyItems: number;
  /** Items claimable right now: due pending OR stale abandoned claims. */
  dueItems: number;
  /** Items that keep the campaign open: pending, backed off, or fresh in flight. */
  openItems: number;
}

async function loadDueCounts(
  campaignId: string,
  now: Date,
  staleClaimMs: number,
): Promise<DueCounts> {
  const nowIso = now.toISOString();
  const staleIso = new Date(now.getTime() - staleClaimMs).toISOString();
  const result = await getDatabase().execute<{
    total: string;
    companies: string;
    pending_due: string;
    pending_all: string;
    in_progress_all: string;
    stale_in_progress: string;
  }>(sql`
    SELECT
      COUNT(*)::text AS total,
      COUNT(*) FILTER (WHERE item_type = 'company')::text AS companies,
      COUNT(*) FILTER (
        WHERE status = 'pending'
          AND (next_attempt_at IS NULL OR next_attempt_at <= ${nowIso}::timestamptz)
      )::text AS pending_due,
      COUNT(*) FILTER (WHERE status = 'pending')::text AS pending_all,
      COUNT(*) FILTER (WHERE status = 'in_progress')::text AS in_progress_all,
      COUNT(*) FILTER (
        WHERE status = 'in_progress'
          AND last_attempt_at < ${staleIso}::timestamptz
      )::text AS stale_in_progress
    FROM frontier_items
    WHERE campaign_id = ${campaignId}
  `);
  const row = result.rows[0];
  const pendingDue = Number(row?.pending_due ?? "0");
  const staleInProgress = Number(row?.stale_in_progress ?? "0");
  return {
    totalItems: Number(row?.total ?? "0"),
    companyItems: Number(row?.companies ?? "0"),
    dueItems: pendingDue + staleInProgress,
    openItems:
      Number(row?.pending_all ?? "0") + Number(row?.in_progress_all ?? "0"),
  };
}

/**
 * Process one bounded slice of due frontier items for a running campaign.
 *
 * Crash safety: claims are single-statement transactions and strategy
 * execution happens outside them. A crash between claim and completion
 * leaves the item in_progress until the stale window elapses, then it is
 * reclaimed and re-run — children insert idempotently via idempotency
 * keys, so reruns cannot duplicate work.
 *
 * Pause semantics: only `running` campaigns claim work; items already
 * claimed when pause lands finish normally (in-flight completes).
 */
export async function processDueItems(
  campaignId: string,
  options: ProcessDueOptions,
): Promise<ProcessDueResult> {
  const nowFn = options.now ?? (() => new Date());
  const wallDeadline = Date.now() + (options.wallTimeMs ?? 60_000);
  const maxAttempts = options.maxAttempts ?? MAX_ITEM_ATTEMPTS;
  const staleClaimMs = options.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS;

  const totals: FrontierTotals = {
    claimed: 0,
    completed: 0,
    failed: 0,
    childrenInserted: 0,
  };

  while (true) {
    const now = nowFn();
    const campaignRow = await loadCampaignRow(campaignId);
    if (campaignRow === null || campaignRow.status !== "running") {
      return resultOf(totals, "not_running");
    }
    const campaign: CampaignView = toCampaignView(campaignRow);

    const counts = await loadDueCounts(campaignId, now, staleClaimMs);
    const evaluation = evaluateStoppingRules(counts, {
      ...(campaign.policy.stoppingRules.maxFrontierItems === undefined
        ? {}
        : { maxFrontierItems: campaign.policy.stoppingRules.maxFrontierItems }),
      ...(campaign.policy.stoppingRules.targetCompanies === undefined
        ? {}
        : { targetCompanies: campaign.policy.stoppingRules.targetCompanies }),
    });
    if (evaluation.kind === "finalize") {
      await finalizeCampaign(campaignId, evaluation.status, now);
      return resultOf(totals, evaluation.reason);
    }
    if (evaluation.kind === "wait") {
      return resultOf(totals, "nothing_due");
    }

    // Budget gate before claiming: campaign budget AND daily cap.
    const dailySpend = options.dailySpendUsd ?? (await getDailySpendUsd(now));
    const decision = evaluateBudgets(
      campaign,
      dailySpend,
      dailyBudgetCapUsd(),
    );
    if (!decision.ok) {
      if (decision.rejection === "campaign_budget_exceeded") {
        await getDatabase().execute(sql`
          UPDATE research_campaigns
          SET status = 'budget_exhausted',
              completed_at = ${now.toISOString()}::timestamptz
          WHERE id = ${campaignId}
            AND status IN ('running', 'paused', 'draft', 'queued')
        `);
        return resultOf(totals, "budget_exhausted");
      }
      // Daily cap hit: terminal for this slice, not for the campaign.
      return resultOf(totals, "budget_exhausted");
    }

    const batchSize = Math.max(
      1,
      Math.min(options.maxConcurrent ?? campaignRow.concurrency, 16),
    );
    const batch = await claimDueItems(campaignId, batchSize, now, staleClaimMs);
    if (batch.length === 0) {
      return resultOf(totals, "nothing_due");
    }
    totals.claimed += batch.length;

    const abortedIds: string[] = [];
    for (const item of batch) {
      if (options.signal?.aborted) {
        abortedIds.push(item.id);
        continue;
      }
      try {
        const freshRow = await loadCampaignRow(campaignId);
        if (freshRow === null) break;
        const proposals = await options.strategy.proposeFrontierItems(
          toCampaignView(freshRow),
          toItemView(item),
        );
        const { children, continuationPayload } =
          splitSelfContinuation(item, proposals);
        const inserted = await insertChildren(
          item,
          children,
          toCampaignView(freshRow).maxDepth,
        );
        totals.childrenInserted += inserted;
        // Complete only when the strategy did not ask to continue; a
        // continuation whose payload does not advance (strategy bug) is
        // treated as completion so the frontier always terminates.
        const advanced =
          continuationPayload !== null &&
          canonicalJson(continuationPayload) !== canonicalJson(item.payload);
        if (advanced && continuationPayload !== null) {
          await requeueItemWithPayload(item, continuationPayload, nowFn());
        } else {
          await completeItem(item, nowFn());
          totals.completed += 1;
        }
        if (Number(item.estimatedCostUsd) > 0) {
          // Book the item-level estimated cost; concrete strategies record
          // their actual model_usage spend through recordSpend separately.
          await recordSpend(campaignId, Number(item.estimatedCostUsd));
        }
      } catch (error) {
        const outcome = await failOrRetryItem(
          item,
          error instanceof Error ? error.message : "Unknown strategy failure",
          nowFn(),
          maxAttempts,
        );
        if (outcome === "failed") totals.failed += 1;
      }
    }

    if (abortedIds.length > 0) {
      await releaseClaimedToPending(abortedIds);
      totals.claimed -= abortedIds.length;
      return resultOf(totals, "aborted");
    }

    if (Date.now() >= wallDeadline) {
      return resultOf(totals, options.signal?.aborted ? "aborted" : "slice_complete");
    }
    if (options.signal?.aborted) {
      return resultOf(totals, "aborted");
    }
  }
}
