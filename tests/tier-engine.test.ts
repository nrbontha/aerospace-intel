/**
 * Unit suite for the tier engine mapping (REDESIGN_PLAN §2.1).
 * Pure functions only — no database.
 *
 *   npx vitest run tests/tier-engine.test.ts
 */
import { describe, expect, it } from "vitest";

import {
  candidateStatusValues,
  effectiveTierValues,
  engineStatusToTier,
  resolveEffectiveTier,
  tierOverrideValues,
  tierSourceValues,
  tierToInvestmentAction,
} from "@asi/contracts";

import { resolveTier } from "../apps/web/src/lib/candidate-scoring.js";

// Pinned engine routing→tier mapping from REDESIGN_PLAN §2.1 / review round 1.
const PINNED_ENGINE_MAPPINGS: Record<string, string> = {
  partner_review: "high_interest",
  research_ready: "evaluate",
  in_research: "researching",
  queued_research: "needs_research",
  rejected: "low_interest",
  watchlist: "watchlist",
  hold: "watchlist",
};

describe("tier engine mapping", () => {
  it("covers every candidate status exactly once", () => {
    expect(Object.keys(engineStatusToTier).sort()).toEqual(
      [...candidateStatusValues].sort(),
    );
    for (const status of candidateStatusValues) {
      expect(effectiveTierValues).toContain(engineStatusToTier[status]);
    }
  });

  it("matches every pinned routing→tier pair", () => {
    for (const [status, tier] of Object.entries(PINNED_ENGINE_MAPPINGS)) {
      expect(engineStatusToTier[status as keyof typeof engineStatusToTier]).toBe(
        tier,
      );
    }
  });

  it("extends shortlist to high_interest and archived to low_interest", () => {
    // Documented completions of the spec table (see contracts comment block).
    expect(engineStatusToTier.shortlist).toBe("high_interest");
    expect(engineStatusToTier.archived).toBe("low_interest");
  });

  it("gives the human override precedence over the engine route", () => {
    for (const override of tierOverrideValues) {
      for (const status of candidateStatusValues) {
        expect(resolveEffectiveTier(status, override)).toBe(override);
      }
    }
  });

  it("falls back to the engine route when no override is set", () => {
    expect(resolveEffectiveTier("partner_review", null)).toBe("high_interest");
    expect(resolveEffectiveTier("queued_research", null)).toBe("needs_research");
    expect(resolveEffectiveTier("hold", null)).toBe("watchlist");
  });

  it("maps every settable tier onto a legal investment feedback action", () => {
    expect(Object.keys(tierToInvestmentAction).sort()).toEqual(
      [...tierOverrideValues].sort(),
    );
    const investmentActions = [
      "strong_fit",
      "possible_fit",
      "shortlist",
      "hold",
      "needs_more_research",
      "reject",
      "historical_ideal_unactionable",
    ];
    for (const action of Object.values(tierToInvestmentAction)) {
      expect(investmentActions).toContain(action);
    }
    // Pinned pairs.
    expect(tierToInvestmentAction.high_interest).toBe("strong_fit");
    expect(tierToInvestmentAction.low_interest).toBe("reject");
    expect(tierToInvestmentAction.watchlist).toBe("hold");
    expect(tierToInvestmentAction.evaluate).toBe("needs_more_research");
  });

  it("exposes exactly engine|human as tier sources", () => {
    expect(tierSourceValues).toEqual(["engine", "human"]);
  });
});

describe("resolveTier (web scoring glue)", () => {
  it("prefers the stored human override regardless of routing", () => {
    expect(
      resolveTier(
        { status: "partner_review", tierOverride: "watchlist" },
        "queued_research",
      ),
    ).toBe("watchlist");
  });

  it("uses the routed status when no override exists", () => {
    expect(
      resolveTier({ status: "in_research", tierOverride: null }, "research_ready"),
    ).toBe("evaluate");
  });

  it("falls back to the row status when no routing is supplied", () => {
    expect(
      resolveTier({ status: "rejected", tierOverride: null }),
    ).toBe("low_interest");
  });
});
