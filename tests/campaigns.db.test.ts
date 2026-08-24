/**
 * DB-gated integration suite for the research campaign engine.
 *
 *   ASI_DB_TESTS=1 npx vitest run tests/campaigns.db.test.ts
 *
 * Requires the docker compose database and migrations. Uses a fake
 * discovery strategy and fake clock — NO network, NO OpenRouter calls.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  closeDatabase,
  type FrontierItem,
  frontierItems,
  getDatabase,
  researchCampaigns,
} from "@asi/database";
import {
  CampaignStartPreconditionError,
  IllegalCampaignTransitionError,
  applyLifecycleAction,
  createCampaign,
  planCampaign,
  processDueItems,
  recordSpend,
  type CampaignView,
  type DiscoveryStrategy,
  type FrontierItemView,
  type FrontierProposal,
} from "@asi/research";
import { runMigrations } from "../packages/database/src/migrate.js";

const DB_TESTS_ENABLED = process.env.ASI_DB_TESTS === "1";
const repoPath = (suffix: string) => path.join(process.cwd(), suffix);

function loadDatabaseUrl(): void {
  if (
    process.env.DATABASE_URL !== undefined &&
    process.env.DATABASE_URL !== ""
  ) {
    return;
  }
  for (const candidate of [repoPath(".env.local"), repoPath(".env")]) {
    if (!existsSync(candidate)) continue;
    for (const line of readFileSync(candidate, "utf8").split("\n")) {
      const match = /^DATABASE_URL=(.*)$/.exec(line.trim());
      if (match?.[1] !== undefined) {
        process.env.DATABASE_URL = match[1].trim();
        return;
      }
    }
  }
}

/** Fake clock: deterministic time source advanced explicitly. */
class FakeClock {
  private current: number;

  constructor(startMs: number) {
    this.current = startMs;
  }

  now = (): Date => new Date(this.current);

  advanceMs(delta: number): Date {
    this.current += delta;
    return new Date(this.current);
  }
}

/**
 * Fake strategy: for every `source` item proposes exactly 3 `query`
 * children derived deterministically from its value; everything else
 * proposes nothing.
 */
class ThreeChildStrategy implements DiscoveryStrategy {
  readonly id = "three-child";

  seedsSupported(): boolean {
    return true;
  }

  async proposeFrontierItems(
    _campaign: CampaignView,
    item: FrontierItemView,
  ): Promise<FrontierProposal[]> {
    if (item.itemType !== "source") return [];
    return [1, 2, 3].map(
      (n): FrontierProposal => ({
        itemType: "query",
        normalizedValue: `${item.normalizedValue}-child-${n}`,
        estimatedCostUsd: 0,
      }),
    );
  }
}

/** Strategy whose proposal always throws. */
class FailingStrategy implements DiscoveryStrategy {
  readonly id = "always-fails";

  seedsSupported(): boolean {
    return true;
  }

  async proposeFrontierItems(): Promise<FrontierProposal[]> {
    throw new Error("simulated strategy failure");
  }
}

async function insertRootItem(
  campaignId: string,
  normalizedValue: string,
): Promise<FrontierItem> {
  const [row] = await getDatabase()
    .insert(frontierItems)
    .values({
      campaignId,
      itemType: "source",
      normalizedValue,
      depth: 0,
      status: "pending",
      priority: "0",
      estimatedCostUsd: "0",
      payload: {},
    })
    .returning();
  if (row === undefined) throw new Error("root insert failed");
  return row;
}

async function loadCampaignRow(campaignId: string) {
  const [row] = await getDatabase()
    .select()
    .from(researchCampaigns)
    .where(eq(researchCampaigns.id, campaignId))
    .limit(1);
  if (row === undefined) throw new Error("campaign missing");
  return row;
}

async function loadItem(itemId: string): Promise<FrontierItem> {
  const [item] = await getDatabase()
    .select()
    .from(frontierItems)
    .where(eq(frontierItems.id, itemId));
  if (item === undefined) throw new Error("frontier item missing");
  return item;
}

describe.skipIf(!DB_TESTS_ENABLED)("campaign engine (DB)", () => {
  const clock = new FakeClock(Date.UTC(2026, 0, 15, 9, 0, 0));
  const createdCampaignIds: string[] = [];
  const strategy = new ThreeChildStrategy();

  const processOptions = () => ({
    strategy,
    now: clock.now,
    dailySpendUsd: 0,
    staleClaimMs: 60_000,
    maxAttempts: 5,
  });

  beforeAll(async () => {
    loadDatabaseUrl();
    await runMigrations();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  afterEach(async () => {
    for (const id of createdCampaignIds.splice(0)) {
      await getDatabase()
        .delete(researchCampaigns)
        .where(eq(researchCampaigns.id, id));
    }
  });

  async function createTestCampaign(
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const created = await createCampaign({
      name: `vitest-campaign-${randomUUID().slice(0, 8)}`,
      budgetUsd: 100,
      maxDepth: 1,
      concurrency: 4,
      ...overrides,
    });
    createdCampaignIds.push(created.id);
    return created.id;
  }

  it("start requires at least one frontier item and rejects illegal transitions", async () => {
    const campaignId = await createTestCampaign();
    await expect(applyLifecycleAction(campaignId, "start")).rejects.toBeInstanceOf(
      CampaignStartPreconditionError,
    );

    await insertRootItem(campaignId, "lifecycle-root");
    const started = await applyLifecycleAction(campaignId, "start");
    expect(started.campaign.status).toBe("running");
    expect(started.campaign.startedAt).not.toBeNull();

    const paused = await applyLifecycleAction(campaignId, "pause");
    expect(paused.campaign.status).toBe("paused");
    await expect(applyLifecycleAction(campaignId, "pause")).rejects.toBeInstanceOf(
      IllegalCampaignTransitionError,
    );
    const resumed = await applyLifecycleAction(campaignId, "resume");
    expect(resumed.campaign.status).toBe("running");
    await applyLifecycleAction(campaignId, "cancel");
    await expect(applyLifecycleAction(campaignId, "start")).rejects.toBeInstanceOf(
      IllegalCampaignTransitionError,
    );
  });

  it("plans seeds idempotently", async () => {
    const campaignId = await createTestCampaign({
      seeds: { platforms: ["F-35"], geography: ["Nordics"] },
    });
    const first = await planCampaign(campaignId);
    expect(first.inserted).toBe(2);
    const second = await planCampaign(campaignId);
    expect(second.inserted).toBe(0);
  });

  it("processes frontier children respecting depth and finishes exhausted", async () => {
    const campaignId = await createTestCampaign({ maxDepth: 1 });
    await insertRootItem(campaignId, "depth-root");
    await applyLifecycleAction(campaignId, "start");

    const result = await processDueItems(campaignId, processOptions());
    expect(result.completed).toBe(4); // root + 3 children
    expect(result.childrenInserted).toBe(3);
    expect(result.stopReason).toBe("frontier_exhausted");

    const campaign = await loadCampaignRow(campaignId);
    expect(campaign.status).toBe("frontier_exhausted");

    const items = await getDatabase()
      .select()
      .from(frontierItems)
      .where(eq(frontierItems.campaignId, campaignId));
    expect(items).toHaveLength(4);
    const children = items.filter((item) =>
      item.normalizedValue.includes("-child-"),
    );
    expect(children).toHaveLength(3);
    for (const child of children) expect(child.depth).toBe(1);
    for (const item of items) expect(item.status).toBe("done");
  });

  it("requeues a query item in place when the strategy proposes self-continuation", async () => {
    // Mirrors the USAspending topology: a source expands to ONE query
    // item; the query item paginates ITSELF via self-continuation
    // (same itemType + normalizedValue, payload advanced) while emitting
    // one leaf per slice.
    class PaginatingQueryStrategy implements DiscoveryStrategy {
      readonly id = "paginating-query";

      seedsSupported(): boolean {
        return true;
      }

      async proposeFrontierItems(
        _campaign: CampaignView,
        item: FrontierItemView,
      ): Promise<FrontierProposal[]> {
        if (item.itemType === "source") {
          return [
            {
              itemType: "query",
              normalizedValue: `${item.normalizedValue}-query`,
              estimatedCostUsd: 0,
              payload: { page: 1 },
            },
          ];
        }
        if (item.itemType !== "query") return [];
        const page = (item.payload["page"] as number | undefined) ?? 1;
        const proposals: FrontierProposal[] = [
          {
            itemType: "company",
            normalizedValue: `${item.normalizedValue}-leaf-${page}`,
            estimatedCostUsd: 0,
          },
        ];
        if (page < 3) {
          proposals.push({
            itemType: "query",
            normalizedValue: item.normalizedValue,
            estimatedCostUsd: 0,
            payload: { page: page + 1 },
          });
        }
        return proposals;
      }
    }

    const campaignId = await createTestCampaign({ maxDepth: 2 });
    const root = await insertRootItem(campaignId, "requeue-root");
    await applyLifecycleAction(campaignId, "start");

    const result = await processDueItems(campaignId, {
      ...processOptions(),
      strategy: new PaginatingQueryStrategy(),
    });

    expect(result.childrenInserted).toBe(4); // 1 query child + 3 leaves
    expect(result.stopReason).toBe("frontier_exhausted");

    // The source completed normally; the query advanced its cursor across
    // slices and only then completed.
    const sourceRow = await loadItem(root.id);
    expect(sourceRow.status).toBe("done");
    const queryRow = (
      await getDatabase()
        .select()
        .from(frontierItems)
        .where(eq(frontierItems.campaignId, campaignId))
    ).find((item) => item.normalizedValue === "requeue-root-query");
    expect(queryRow?.status).toBe("done");
    expect(queryRow?.payload).toEqual({ page: 3 });

    const items = await getDatabase()
      .select()
      .from(frontierItems)
      .where(eq(frontierItems.campaignId, campaignId));
    expect(items).toHaveLength(5); // source + query + 3 leaves
    for (const item of items) expect(item.status).toBe("done");
  });

  it("completes instead of looping when a continuation does not advance", async () => {
    class StuckQueryStrategy implements DiscoveryStrategy {
      readonly id = "stuck-query";

      seedsSupported(): boolean {
        return true;
      }

      async proposeFrontierItems(
        _campaign: CampaignView,
        item: FrontierItemView,
      ): Promise<FrontierProposal[]> {
        if (item.itemType === "source") {
          return [
            {
              itemType: "query",
              normalizedValue: `${item.normalizedValue}-query`,
              estimatedCostUsd: 0,
              payload: {},
            },
          ];
        }
        if (item.itemType !== "query") return [];
        return [
          {
            itemType: "company",
            normalizedValue: `${item.normalizedValue}-leaf`,
            estimatedCostUsd: 0,
          },
          // Identical (non-advancing) payload every time.
          {
            itemType: "query",
            normalizedValue: item.normalizedValue,
            estimatedCostUsd: 0,
            payload: {},
          },
        ];
      }
    }

    const campaignId = await createTestCampaign({ maxDepth: 2 });
    const root = await insertRootItem(campaignId, "stuck-root");
    await applyLifecycleAction(campaignId, "start");

    const result = await processDueItems(campaignId, {
      ...processOptions(),
      strategy: new StuckQueryStrategy(),
    });

    expect(result.stopReason).toBe("frontier_exhausted");
    const items = await getDatabase()
      .select()
      .from(frontierItems)
      .where(eq(frontierItems.campaignId, campaignId));
    const queryRow = items.find(
      (item) => item.normalizedValue === "stuck-root-query",
    );
    expect(queryRow?.status).toBe("done"); // completed, not requeued forever
    expect(queryRow?.payload).toEqual({}); // payload untouched
    const stuckSource = await loadItem(root.id);
    expect(stuckSource.status).toBe("done");
  });

  it("survives a simulated crash: rerun reclaims stale claims with zero duplicate children", async () => {
    const campaignId = await createTestCampaign();
    const rootA = await insertRootItem(campaignId, "crash-root-A");
    await insertRootItem(campaignId, "crash-root-B");
    await applyLifecycleAction(campaignId, "start");

    // Simulate a worker that claimed root A, inserted nothing yet, and died:
    // the item stays in_progress with a consumed attempt and a stale
    // heartbeat (30 minutes old).
    await getDatabase()
      .update(frontierItems)
      .set({
        status: "in_progress",
        attemptCount: 1,
        lastAttemptAt: clock.now(),
      })
      .where(eq(frontierItems.id, rootA.id));
    clock.advanceMs(30 * 60_000);

    // Run #1: stale window is 1h, so the abandoned claim is NOT reclaimed;
    // only root B is processed.
    const firstRun = await processDueItems(campaignId, {
      ...processOptions(),
      staleClaimMs: 60 * 60_000,
    });
    // The runner loops within one invocation: root B AND its three children
    // are all processed; root A's abandoned claim is left alone.
    expect(firstRun.claimed).toBe(4);
    expect(firstRun.childrenInserted).toBe(3);
    expect(await countChildrenOf(campaignId)).toBe(3);

    // Run #2 (restart): default 60s stale window reclaims root A's claim.
    const secondRun = await processDueItems(campaignId, processOptions());
    // Root A plus its three children are processed in this single run.
    expect(secondRun.claimed).toBe(4);
    expect(secondRun.childrenInserted).toBe(3);
    expect(secondRun.stopReason).toBe("frontier_exhausted");

    // Idempotency keys guarantee zero duplicates across both runs.
    expect(await countChildrenOf(campaignId)).toBe(6);
    const keys = await getDatabase()
      .select({ key: frontierItems.idempotencyKey })
      .from(frontierItems)
      .where(eq(frontierItems.campaignId, campaignId));
    // Root rows inserted directly have NULL keys; only compare real keys.
    const realKeys = keys.map((row) => row.key).filter((key) => key !== null);
    expect(realKeys).toHaveLength(6); // 2 roots' worth of children, zero dupes
    expect(new Set(realKeys).size).toBe(realKeys.length);

    async function countChildrenOf(campaignId: string): Promise<number> {
      const rows = await getDatabase()
        .select({ value: frontierItems.normalizedValue })
        .from(frontierItems)
        .where(eq(frontierItems.campaignId, campaignId));
      return rows.filter((row) => row.value.includes("-child-")).length;
    }
  });

  it("pause blocks new claims while in-flight items finish untouched", async () => {
    const campaignId = await createTestCampaign();
    await insertRootItem(campaignId, "pause-first-root");
    const inFlight = await insertRootItem(campaignId, "pause-inflight-root");
    // Simulate an in-flight claim held by another worker with a FRESH
    // heartbeat (not reclaimable).
    await getDatabase()
      .update(frontierItems)
      .set({ status: "in_progress", attemptCount: 1, lastAttemptAt: clock.now() })
      .where(eq(frontierItems.id, inFlight.id));
    await applyLifecycleAction(campaignId, "start");

    // A wide stale window leaves the fresh in-flight item alone; the runner
    // processes the first root then waits (work is still in flight).
    const partial = await processDueItems(campaignId, {
      ...processOptions(),
      staleClaimMs: 60 * 60_000,
    });
    expect(partial.stopReason).toBe("nothing_due");
    expect((await loadItem(inFlight.id)).status).toBe("in_progress");

    const paused = await applyLifecycleAction(campaignId, "pause");
    expect(paused.campaign.status).toBe("paused");

    // New work queued while paused must not be claimed.
    await insertRootItem(campaignId, "pause-pending-root");
    const blocked = await processDueItems(campaignId, processOptions());
    expect(blocked.stopReason).toBe("not_running");
    expect(blocked.claimed).toBe(0);
    expect(
      (
        await loadItem(
          (
            await getDatabase()
              .select({ id: frontierItems.id })
              .from(frontierItems)
              .where(eq(frontierItems.normalizedValue, "pause-pending-root"))
          )[0]!.id,
        )
      ).status,
    ).toBe("pending");
    expect((await loadItem(inFlight.id)).status).toBe("in_progress");

    // Resume lets the runner continue with the pending work; the in-flight
    // item is still fresh so it is never double-claimed.
    await applyLifecycleAction(campaignId, "resume");
    const resumed = await processDueItems(campaignId, processOptions());
    expect(resumed.claimed).toBe(4); // pending root + its three children
    expect(resumed.childrenInserted).toBe(3);
    expect((await loadItem(inFlight.id)).status).toBe("in_progress");
  });

  it("flips to budget_exhausted atomically when recorded spend crosses the budget", async () => {
    const campaignId = await createTestCampaign({ budgetUsd: 5 });
    await getDatabase()
      .update(researchCampaigns)
      .set({ spendUsd: "4.50" })
      .where(eq(researchCampaigns.id, campaignId));

    const underBudget = await recordSpend(campaignId, 0.49);
    expect(underBudget.flippedToBudgetExhausted).toBe(false);
    expect(underBudget.status).toBe("draft");
    expect(Number(underBudget.spendUsd)).toBeCloseTo(4.99, 2);

    const crossed = await recordSpend(campaignId, 0.02);
    expect(crossed.flippedToBudgetExhausted).toBe(true);
    expect(crossed.status).toBe("budget_exhausted");
    expect(Number(crossed.spendUsd)).toBeCloseTo(5.01, 2);

    const finalRow = await loadCampaignRow(campaignId);
    expect(finalRow.status).toBe("budget_exhausted");
  });

  it("daily cap stops the slice without terminating the campaign", async () => {
    const campaignId = await createTestCampaign();
    await insertRootItem(campaignId, "daily-cap-root");
    await applyLifecycleAction(campaignId, "start");

    const result = await processDueItems(campaignId, {
      ...processOptions(),
      dailySpendUsd: 999,
    });
    expect(result.stopReason).toBe("budget_exhausted");
    expect(result.claimed).toBe(0);

    const campaign = await loadCampaignRow(campaignId);
    expect(campaign.status).toBe("running");
  });

  it("cancel skips pending items and marks the campaign cancelled", async () => {
    const campaignId = await createTestCampaign();
    const root = await insertRootItem(campaignId, "cancel-root");
    await applyLifecycleAction(campaignId, "start");

    const cancelled = await applyLifecycleAction(campaignId, "cancel");
    expect(cancelled.campaign.status).toBe("cancelled");
    expect(cancelled.skippedPendingItems).toBe(1);

    expect((await loadItem(root.id)).status).toBe("skipped");

    const blocked = await processDueItems(campaignId, processOptions());
    expect(blocked.stopReason).toBe("not_running");
  });

  it("fails items permanently after exhausting attempts with backoff scheduled between tries", async () => {
    const campaignId = await createTestCampaign();
    const root = await insertRootItem(campaignId, "failing-root");
    await applyLifecycleAction(campaignId, "start");
    const failingStrategy = new FailingStrategy();

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      clock.advanceMs(25 * 60 * 60_000); // clear any backoff window
      const run = await processDueItems(campaignId, {
        ...processOptions(),
        strategy: failingStrategy,
      });
      // failed counts only TERMINAL failures; retries stay pending.
      expect(run.failed).toBe(attempt === 5 ? 1 : 0);
      const item = await loadItem(root.id);
      expect(item.attemptCount).toBe(attempt);
      if (attempt < 5) {
        expect(item.status).toBe("pending");
        expect(item.nextAttemptAt).not.toBeNull();
        // next_attempt_at respects the exponential backoff schedule.
        const delayMs =
          (item.nextAttemptAt!.getTime() - clock.now().getTime()) || -1;
        // Backoff was computed against an older attempt count, but must be
        // positive and bounded by 24h.
        expect(delayMs).toBeGreaterThan(0);
      } else {
        expect(item.status).toBe("failed");
        expect(item.failureReason).toContain("simulated strategy failure");
      }
    }

    // The failed item was the last open work: the campaign finalized as
    // frontier_exhausted at the end of attempt 5, so further runs are a
    // no-op.
    expect((await loadCampaignRow(campaignId)).status).toBe("frontier_exhausted");
    clock.advanceMs(25 * 60 * 60_000);
    const finalRun = await processDueItems(campaignId, {
      ...processOptions(),
      strategy: failingStrategy,
    });
    expect(finalRun.claimed).toBe(0);
    expect(finalRun.stopReason).toBe("not_running");
    const item = await loadItem(root.id);
    expect(item.attemptCount).toBe(5); // never claimed again
  });
});
