import type { CampaignDto, CampaignStatus, CampaignLifecycleAction } from "@asi/contracts";
import { getDatabase } from "@asi/database/client";
import { frontierItems, researchCampaigns } from "@asi/database";
import { and, count, eq, inArray } from "drizzle-orm";

import {
  CampaignNotFoundError,
  serializeCampaign,
} from "./planner.js";

export class IllegalCampaignTransitionError extends Error {
  constructor(
    readonly campaignId: string,
    readonly action: CampaignLifecycleAction,
    readonly from: CampaignStatus,
  ) {
    super(
      `Cannot apply "${action}" to campaign ${campaignId} in status "${from}"`,
    );
    this.name = "IllegalCampaignTransitionError";
  }
}

export class CampaignStartPreconditionError extends Error {
  constructor(
    readonly campaignId: string,
    readonly reason: "no_frontier_items" | "budget_not_positive",
  ) {
    super(
      reason === "no_frontier_items"
        ? `Campaign ${campaignId} has no frontier items; run planCampaign first`
        : `Campaign ${campaignId} budget must be positive to start`,
    );
    this.name = "CampaignStartPreconditionError";
  }
}

/**
 * Allowed source statuses per lifecycle action. Terminal states
 * (completed, failed, cancelled) accept no transitions;
 * budget_exhausted/frontier_exhausted can still be cancelled.
 */
const ALLOWED_TRANSITIONS: Record<CampaignLifecycleAction, readonly CampaignStatus[]> = {
  start: ["draft", "queued"],
  pause: ["running"],
  resume: ["paused"],
  cancel: [
    "draft",
    "queued",
    "running",
    "paused",
    "budget_exhausted",
    "frontier_exhausted",
  ],
};

/** Pure transition-table predicate (unit-tested). */
export function canTransition(
  from: CampaignStatus,
  action: CampaignLifecycleAction,
): boolean {
  return ALLOWED_TRANSITIONS[action].includes(from);
}


export interface LifecycleResult {
  campaign: CampaignDto;
  skippedPendingItems?: number;
}


/**
 * Apply a lifecycle action. Auditing is the CALLER's responsibility:
 * routes must write an audit_events row with before/after campaign state
 * inside the same request. Transitions are enforced optimistically via a
 * conditional UPDATE so concurrent actors cannot double-apply.
 */
export async function applyLifecycleAction(
  campaignId: string,
  action: CampaignLifecycleAction,
): Promise<LifecycleResult> {
  return getDatabase().transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(researchCampaigns)
      .where(eq(researchCampaigns.id, campaignId))
      .for("update")
      .limit(1);
    if (current === undefined) throw new CampaignNotFoundError(campaignId);

    if (!canTransition(current.status, action)) {
      throw new IllegalCampaignTransitionError(
        campaignId,
        action,
        current.status,
      );
    }

    const now = new Date();

    if (action === "start") {
      const items = await tx
        .select({ c: count() })
        .from(frontierItems)
        .where(eq(frontierItems.campaignId, campaignId));
      if ((items[0]?.c ?? 0) === 0) {
        throw new CampaignStartPreconditionError(campaignId, "no_frontier_items");
      }
      if (current.budgetUsd !== null && Number(current.budgetUsd) <= 0) {
        throw new CampaignStartPreconditionError(campaignId, "budget_not_positive");
      }
      const [updated] = await tx
        .update(researchCampaigns)
        .set({
          status: "running",
          startedAt: current.startedAt ?? now,
          pausedAt: null,
        })
        .where(
          and(eq(researchCampaigns.id, campaignId), eq(researchCampaigns.status, current.status)),
        )
        .returning();
      if (updated === undefined) {
        throw new IllegalCampaignTransitionError(campaignId, action, current.status);
      }
      return { campaign: serializeCampaign(updated) };
    }

    if (action === "pause") {
      const [updated] = await tx
        .update(researchCampaigns)
        .set({ status: "paused", pausedAt: now })
        .where(
          and(eq(researchCampaigns.id, campaignId), eq(researchCampaigns.status, "running")),
        )
        .returning();
      if (updated === undefined) {
        throw new IllegalCampaignTransitionError(campaignId, action, current.status);
      }
      // In-flight items finish; no new claims occur while paused because the
      // runner refuses campaigns not in `running`.
      return { campaign: serializeCampaign(updated) };
    }

    if (action === "resume") {
      const [updated] = await tx
        .update(researchCampaigns)
        .set({ status: "running" })
        .where(
          and(eq(researchCampaigns.id, campaignId), eq(researchCampaigns.status, "paused")),
        )
        .returning();
      if (updated === undefined) {
        throw new IllegalCampaignTransitionError(campaignId, action, current.status);
      }
      return { campaign: serializeCampaign(updated) };
    }

    // cancel — flip pending frontier items to skipped in the same txn.
    const skipped = await tx
      .update(frontierItems)
      .set({ status: "skipped", completedAt: now })
      .where(
        and(
          eq(frontierItems.campaignId, campaignId),
          inArray(frontierItems.status, ["pending"]),
        ),
      )
      .returning({ id: frontierItems.id });
    const [updated] = await tx
      .update(researchCampaigns)
      .set({ status: "cancelled", completedAt: now })
      .where(
        and(
          eq(researchCampaigns.id, campaignId),
          eq(researchCampaigns.status, current.status),
        ),
      )
      .returning();
    if (updated === undefined) {
      throw new IllegalCampaignTransitionError(campaignId, action, current.status);
    }
    return {
      campaign: serializeCampaign(updated),
      skippedPendingItems: skipped.length,
    };
  });
}
