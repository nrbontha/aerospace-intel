/**
 * Always-on unit tests for the campaign lifecycle, frontier runner math,
 * and budget gates. No database, no network.
 */
import { describe, expect, it } from "vitest";

import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  computeBackoffDelayMs,
  evaluateStoppingRules,
} from "../packages/research/src/campaigns/frontier-runner.js";
import { applyLifecycleAction } from "../packages/research/src/campaigns/lifecycle.js";
import { canTransition } from "../packages/research/src/campaigns/lifecycle.js";
import {
  DEFAULT_DAILY_BUDGET_USD,
  dailyBudgetCapUsd,
  evaluateBudgets,
} from "../packages/research/src/campaigns/budget.js";
import {
  CompositeDiscoveryStrategy,
  PassthroughStrategy,
  frontierIdempotencyKey,
} from "../packages/research/src/campaigns/types.js";

describe("campaign lifecycle transition table", () => {
  it("allows legal transitions", () => {
    expect(canTransition("draft", "start")).toBe(true);
    expect(canTransition("queued", "start")).toBe(true);
    expect(canTransition("running", "pause")).toBe(true);
    expect(canTransition("paused", "resume")).toBe(true);
    expect(canTransition("running", "cancel")).toBe(true);
    expect(canTransition("budget_exhausted", "cancel")).toBe(true);
    expect(canTransition("frontier_exhausted", "cancel")).toBe(true);
  });

  it("rejects illegal transitions", () => {
    // Terminal states accept nothing.
    for (const terminal of ["completed", "failed", "cancelled"] as const) {
      for (const action of ["start", "pause", "resume", "cancel"] as const) {
        expect(canTransition(terminal, action)).toBe(false);
      }
    }
    expect(canTransition("paused", "start")).toBe(false);
    expect(canTransition("running", "resume")).toBe(false);
    expect(canTransition("running", "start")).toBe(false);
    expect(canTransition("draft", "pause")).toBe(false);
    expect(canTransition("budget_exhausted", "resume")).toBe(false);
  });

  it("documents that routes audit transitions", () => {
    // The lifecycle module never writes audit_events; the caller (route)
    // must audit with before/after. This assertion guards the contract:
    // applyLifecycleAction source must not insert into auditEvents.
    const source = applyLifecycleAction.toString();
    expect(source.includes("auditEvents")).toBe(false);
    void canTransition;
  });
});

describe("frontier backoff math", () => {
  it("doubles per attempt from a 15 minute base", () => {
    expect(computeBackoffDelayMs(0)).toBe(BACKOFF_BASE_MS);
    expect(computeBackoffDelayMs(1)).toBe(2 * BACKOFF_BASE_MS);
    expect(computeBackoffDelayMs(2)).toBe(4 * BACKOFF_BASE_MS);
  });

  it("caps at 24 hours", () => {
    expect(computeBackoffDelayMs(10)).toBe(BACKOFF_MAX_MS);
    expect(computeBackoffDelayMs(50)).toBe(BACKOFF_MAX_MS);
  });

  it("clamps negative attempt counts to the base delay", () => {
    expect(computeBackoffDelayMs(-3)).toBe(BACKOFF_BASE_MS);
  });
});

describe("stopping rules", () => {
  const base = {
    totalItems: 0,
    companyItems: 0,
    dueItems: 0,
    openItems: 0,
  };

  it("completes when maxFrontierItems is reached", () => {
    const result = evaluateStoppingRules(
      { ...base, totalItems: 100 },
      { maxFrontierItems: 100 },
    );
    expect(result).toEqual({
      kind: "finalize",
      status: "completed",
      reason: "campaign_completed",
    });
  });

  it("completes when targetCompanies is reached", () => {
    const result = evaluateStoppingRules(
      { ...base, totalItems: 40, companyItems: 5 },
      { targetCompanies: 5 },
    );
    expect(result).toEqual({
      kind: "finalize",
      status: "completed",
      reason: "campaign_completed",
    });
  });

  it("reports frontier exhaustion when nothing remains", () => {
    const result = evaluateStoppingRules(base, {});
    expect(result).toEqual({
      kind: "finalize",
      status: "frontier_exhausted",
      reason: "frontier_exhausted",
    });
  });

  it("waits when items exist but none are due", () => {
    const result = evaluateStoppingRules(
      { ...base, totalItems: 3, openItems: 3 },
      {},
    );
    expect(result).toEqual({ kind: "wait" });
  });

  it("continues while work is due", () => {
    const result = evaluateStoppingRules(
      { ...base, totalItems: 1, openItems: 1, dueItems: 1 },
      {},
    );
    expect(result).toEqual({ kind: "continue" });
  });

  it("keeps going while an abandoned claim remains reclaimable", () => {
    const result = evaluateStoppingRules(
      { ...base, totalItems: 2, openItems: 2, dueItems: 1 },
      {},
    );
    expect(result).toEqual({ kind: "continue" });
  });
});

describe("budget gate", () => {
  it("passes under budget and under the daily cap", () => {
    expect(
      evaluateBudgets({ spendUsd: 4, budgetUsd: 10 }, 0.5, 1),
    ).toEqual({ ok: true });
  });

  it("rejects on campaign budget exceeded", () => {
    const decision = evaluateBudgets({ spendUsd: 10.01, budgetUsd: 10 }, 0, 1);
    expect(decision.ok).toBe(false);
    expect(decision.rejection).toBe("campaign_budget_exceeded");
  });

  it("rejects at exactly the budget boundary", () => {
    const decision = evaluateBudgets({ spendUsd: 10, budgetUsd: 10 }, 0, 1);
    expect(decision.ok).toBe(false);
  });

  it("rejects on daily cap exceeded", () => {
    const decision = evaluateBudgets(
      { spendUsd: 1, budgetUsd: null },
      1.0,
      DEFAULT_DAILY_BUDGET_USD,
    );
    expect(decision.ok).toBe(false);
    expect(decision.rejection).toBe("daily_cap_exceeded");
  });

  it("treats a null campaign budget as unlimited", () => {
    expect(evaluateBudgets({ spendUsd: 9_999, budgetUsd: null }, 0, 1)).toEqual({
      ok: true,
    });
  });

  it("defaults the daily cap to $1.00 and honors env overrides", () => {
    delete process.env.OPENROUTER_MAX_COST_PER_DAY_USD;
    expect(dailyBudgetCapUsd()).toBe(DEFAULT_DAILY_BUDGET_USD);
    expect(DEFAULT_DAILY_BUDGET_USD).toBe(1.0);
    process.env.OPENROUTER_MAX_COST_PER_DAY_USD = "12.5";
    expect(dailyBudgetCapUsd()).toBe(12.5);
    delete process.env.OPENROUTER_MAX_COST_PER_DAY_USD;
  });
});

describe("discovery strategies", () => {
  const campaign = {
    id: "00000000-0000-0000-0000-000000000001",
    name: "test",
    objective: null,
    thesisVersion: "thesis-v0",
    policyVersion: "policy-v0",
    seeds: { sources: [], platforms: [], capabilities: [], geography: [] },
    excludedSources: [],
    budgetUsd: 10,
    spendUsd: 0,
    maxDepth: 2,
    policy: {
      version: "policy-v0",
      enabledSources: [],
      sourcePriorities: {},
      maxDepth: 2,
      maxDocumentsPerCandidate: 25,
      stoppingRules: { stopWhenBudgetExhausted: true },
    },
  };

  const item = {
    id: "00000000-0000-0000-0000-000000000002",
    campaignId: campaign.id,
    itemType: "query" as const,
    normalizedValue: "aerospace fasteners europe",
    parentItemId: null,
    discoveryPath: null,
    depth: 0,
    payload: {
      children: [
        { itemType: "url", normalizedValue: "https://example.com/a" },
        { itemType: "company", normalizedValue: "Example Aero GmbH" },
        "not-an-object",
      ],
    },
  };

  it("passthrough echoes valid children and drops malformed ones", async () => {
    const strategy = new PassthroughStrategy();
    const proposals = await strategy.proposeFrontierItems(campaign, item);
    expect(proposals).toHaveLength(2);
    expect(proposals[0]?.itemType).toBe("url");
    expect(proposals[1]?.itemType).toBe("company");
    expect(await strategy.proposeFrontierItems(campaign, { ...item, payload: {} })).toHaveLength(0);
  });

  it("composite merges proposals across strategies", async () => {
    const extra = {
      id: "extra",
      seedsSupported: () => true,
      proposeFrontierItems: async () => [
        { itemType: "domain" as const, normalizedValue: "example.com" },
      ],
    };
    const composite = new CompositeDiscoveryStrategy([
      new PassthroughStrategy(),
      extra,
    ]);
    const proposals = await composite.proposeFrontierItems(campaign, item);
    expect(proposals).toHaveLength(3);
    expect(composite.seedsSupported(campaign.seeds)).toBe(true);
  });

  it("derives stable idempotency keys", () => {
    const keyA = frontierIdempotencyKey(campaign.id, "company", "Example Aero GmbH");
    const keyB = frontierIdempotencyKey(campaign.id, "company", "Example Aero GmbH");
    const keyC = frontierIdempotencyKey(campaign.id, "url", "Example Aero GmbH");
    expect(keyA).toBe(keyB);
    expect(keyA).not.toBe(keyC);
    expect(keyA).toMatch(/^[a-f0-9]{64}$/);
  });
});
