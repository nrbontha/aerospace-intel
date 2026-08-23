/**
 * Pure unit tests for the enrichment-benchmark comparison engine.
 * Covers every verdict, every disagreement class, tolerance boundaries,
 * ownership keyword mapping, and aggregate math.
 */
import { describe, expect, it } from "vitest";

import {
  aggregateComparisons,
  compareProfiles,
  NUMERIC_TOLERANCE,
  type FieldComparison,
} from "../packages/research/src/benchmarks/compare.js";
import {
  classifyOwnership,
  enrichProfileSchema,
  normalizeState,
  type EnrichmentProfile,
} from "../packages/research/src/benchmarks/schema.js";

const BASE_PROFILE: EnrichmentProfile = enrichProfileSchema.parse({
  identity: { legalName: "ACMT", domain: "acmt-usa.com", hqState: "Connecticut", hqCity: "Manchester" },
  size: { revenueEstimateUsd: 26_000_000, revenueBasis: "FY2025 annual revenue", employees: 60 },
  ownership: { ownershipType: "founder-owned and operated" },
  business: {
    descriptionOneLiner: "Makes aerospace components.",
    manufacturesProducts: true,
    distributes: false,
    services: true,
    pmaMentioned: true,
    proprietaryLanguage: true,
  },
  provenance: [
    { field: "identity.hqState", url: "https://acmt-usa.com/", excerpt: "Headquartered in Manchester, Connecticut" },
  ],
});

const BASE_GRATA = {
  State: "Connecticut",
  City: "Manchester",
  "Revenue Estimate": 26_729_000,
  "Employee Estimate": 58,
  Ownership: "Bootstrapped",
  "Business Model": "Manufacturer",
  Description:
    "ACMT manufactures aerospace components and mentions FAA-PMA parts and proprietary automation technology.",
  "Misc. details": "",
};

const fieldVerdict = (comparisons: readonly FieldComparison[], field: string): FieldComparison => {
  const found = comparisons.find((comparison) => comparison.field === field);
  if (found === undefined) throw new Error(`no comparison for ${field}`);
  return found;
};

describe("normalizeState", () => {
  it("maps full names, USPS codes, and country suffixes", () => {
    expect(normalizeState("Connecticut")).toBe("connecticut");
    expect(normalizeState("CT")).toBe("connecticut");
    expect(normalizeState("New Jersey, USA")).toBe("new jersey");
    expect(normalizeState("NJ")).toBe("new jersey");
    expect(normalizeState("  Washington ")).toBe("washington");
  });
});


describe("classifyOwnership keyword rules", () => {
  it("maps grata taxonomy values", () => {
    expect(classifyOwnership("Bootstrapped")).toBe("bootstrapped");
    expect(classifyOwnership("Public Subsidiary")).toBe("public_subsidiary");
    expect(classifyOwnership("Private Subsidiary")).toBe("private_subsidiary");
    expect(classifyOwnership("Investor Backed")).toBe("sponsor_backed");
    expect(classifyOwnership("Private Equity Add-On")).toBe("sponsor_backed");
  });

  it("maps free-text ownership language to the same groups", () => {
    expect(classifyOwnership("wholly owned subsidiary of a public company")).toBe("public_subsidiary");
    expect(classifyOwnership("backed by private equity since 2019")).toBe("sponsor_backed");
    expect(classifyOwnership("family-owned, no external funding")).toBe("bootstrapped");
    expect(classifyOwnership("publicly traded on NASDAQ")).toBe("public");
    expect(classifyOwnership("subsidiary of Mollenhour Gross")).toBe("private_subsidiary");
    expect(classifyOwnership("")).toBe("unknown");
    expect(classifyOwnership(undefined)).toBe("unknown");
  });
});

describe("compareProfiles verdicts", () => {
  it("matches a faithful profile on every comparable field", () => {
    const comparisons = compareProfiles(BASE_PROFILE, BASE_GRATA);
    for (const comparableField of ["hq_state", "hq_city", "revenue_estimate_usd", "employees", "ownership_class"]) {
      expect(fieldVerdict(comparisons, comparableField).verdict).toBe("match");
    }
    expect(fieldVerdict(comparisons, "manufactures_products").verdict).toBe("match");
    expect(fieldVerdict(comparisons, "pma_mentioned").verdict).toBe("match");
    expect(fieldVerdict(comparisons, "proprietary_language").verdict).toBe("match");
  });

  it("marks grata-silent flags incomparable instead of mismatching", () => {
    const comparisons = compareProfiles(
      BASE_PROFILE,
      { ...BASE_GRATA, Description: "ACMT manufactures aerospace components." },
    );
    // Grata text no longer states PMA/proprietary: not comparable either way.
    expect(fieldVerdict(comparisons, "pma_mentioned").verdict).toBe("incomparable");
    expect(fieldVerdict(comparisons, "proprietary_language").verdict).toBe("incomparable");
    // services is never stated in the grata reference → incomparable.
    expect(fieldVerdict(comparisons, "services").verdict).toBe("incomparable");
  });

  it("enforces the ±35% band with boundary behavior at exactly 35%", () => {
    const atBoundary = compareProfiles(
      { ...BASE_PROFILE, size: { ...BASE_PROFILE.size, revenueEstimateUsd: 26_729_000 * (1 + NUMERIC_TOLERANCE) } },
      BASE_GRATA,
    );
    expect(fieldVerdict(atBoundary, "revenue_estimate_usd").verdict).toBe("match");

    const beyondBoundary = compareProfiles(
      { ...BASE_PROFILE, size: { ...BASE_PROFILE.size, revenueEstimateUsd: 26_729_000 * 1.36 } },
      BASE_GRATA,
    );
    expect(fieldVerdict(beyondBoundary, "revenue_estimate_usd").verdict).toBe("mismatch");
  });

  it("reports missing values on either side", () => {
    const oursMissing = compareProfiles(
      { ...BASE_PROFILE, identity: { ...BASE_PROFILE.identity, hqCity: undefined }, size: { revenueEstimateUsd: 26_000_000 } },
      BASE_GRATA,
    );
    expect(fieldVerdict(oursMissing, "hq_city").verdict).toBe("our_missing");
    expect(fieldVerdict(oursMissing, "employees").verdict).toBe("our_missing");

    const grataMissing = compareProfiles(BASE_PROFILE, { ...BASE_GRATA, City: "", State: null });
    expect(fieldVerdict(grataMissing, "hq_city").verdict).toBe("grata_missing");
    expect(fieldVerdict(grataMissing, "hq_state").verdict).toBe("grata_missing");

    const bothMissing = compareProfiles(
      { ...BASE_PROFILE, size: { revenueEstimateUsd: 26_000_000 } },
      {},
    );
    expect(fieldVerdict(bothMissing, "employees").verdict).toBe("incomparable");
  });
});

describe("disagreement classification", () => {
  it("classifies state and ownership conflicts as source_conflict", () => {
    const comparisons = compareProfiles(
      { ...BASE_PROFILE, identity: { ...BASE_PROFILE.identity, hqState: "Ohio" }, ownership: { ownershipType: "private equity backed" } },
      { ...BASE_GRATA, Ownership: "Bootstrapped" },
    );
    expect(fieldVerdict(comparisons, "hq_state").disagreement).toBe("source_conflict");
    expect(fieldVerdict(comparisons, "ownership_class").disagreement).toBe("source_conflict");
  });

  it("classifies dated revenue basis as date_mismatch", () => {
    const pastYear = new Date().getUTCFullYear() - 2;
    const comparisons = compareProfiles(
      { ...BASE_PROFILE, size: { revenueEstimateUsd: 10_000_000, revenueBasis: `reported ${pastYear} revenue` } },
      BASE_GRATA,
    );
    expect(fieldVerdict(comparisons, "revenue_estimate_usd").disagreement).toBe("date_mismatch");
  });

  it("classifies undated revenue disagreement as unresolved", () => {
    const comparisons = compareProfiles(
      { ...BASE_PROFILE, size: { revenueEstimateUsd: 10_000_000, revenueBasis: "management estimate" } },
      BASE_GRATA,
    );
    expect(fieldVerdict(comparisons, "revenue_estimate_usd").disagreement).toBe("unresolved");
  });

  it("blames our extraction when page text supports grata's PMA claim", () => {
    const pageText = "We hold FAA-PMA approvals for dozens of part numbers.";
    const comparisons = compareProfiles(
      { ...BASE_PROFILE, business: { ...BASE_PROFILE.business, pmaMentioned: false } },
      BASE_GRATA,
      { pageText },
    );
    expect(fieldVerdict(comparisons, "pma_mentioned").disagreement).toBe("our_likely_error");
  });

  it("falls back to unresolved without page context", () => {
    const comparisons = compareProfiles(
      { ...BASE_PROFILE, business: { ...BASE_PROFILE.business, pmaMentioned: false } },
      BASE_GRATA,
    );
    expect(fieldVerdict(comparisons, "pma_mentioned").disagreement).toBe("unresolved");
  });

  it("never scores free-text descriptions", () => {
    const comparisons = compareProfiles(BASE_PROFILE, BASE_GRATA);
    expect(fieldVerdict(comparisons, "description").verdict).toBe("incomparable");
    expect(fieldVerdict(comparisons, "description").disagreement).toBe("incomparable");
  });

  it("blames grata when page text supports our city but not grata's", () => {
    const comparisons = compareProfiles(
      { ...BASE_PROFILE, identity: { ...BASE_PROFILE.identity, hqCity: "Manchester" } },
      { ...BASE_GRATA, City: "Hartford" },
      { pageText: "Visit our headquarters in Manchester, Connecticut." },
    );
    expect(fieldVerdict(comparisons, "hq_city").disagreement).toBe("grata_likely_error");
  });

  it("blames our extraction when page text supports grata's city but not ours", () => {
    const comparisons = compareProfiles(
      { ...BASE_PROFILE, identity: { ...BASE_PROFILE.identity, hqCity: "Manchester" } },
      { ...BASE_GRATA, City: "Hartford" },
      { pageText: "Proudly located in Hartford." },
    );
    expect(fieldVerdict(comparisons, "hq_city").disagreement).toBe("our_likely_error");
  });
});

describe("aggregateComparisons", () => {
  it("computes coverage, per-field match rates, and disagreement counts", () => {
    const match = (field: FieldComparison["field"]): FieldComparison => ({
      field,
      ours: 1,
      grata: 1,
      verdict: "match",
      disagreement: null,
      note: "",
    });
    const mismatch = (
      field: FieldComparison["field"],
      disagreement: FieldComparison["disagreement"],
    ): FieldComparison => ({
      field,
      ours: 0,
      grata: 1,
      verdict: "mismatch",
      disagreement,
      note: "",
    });

    const aggregate = aggregateComparisons([
      {
        name: "A",
        domain: "a.test",
        comparisons: [
          match("hq_state"),
          match("hq_city"),
          mismatch("revenue_estimate_usd", "date_mismatch"),
          match("employees"),
          match("ownership_class"),
          match("pma_mentioned"),
          { field: "proprietary_language", ours: null, grata: null, verdict: "our_missing", disagreement: null, note: "" },
        ],
      },
      {
        name: "B",
        domain: "b.test",
        comparisons: [
          mismatch("hq_state", "source_conflict"),
          match("hq_city"),
          match("revenue_estimate_usd"),
          { field: "employees", ours: null, grata: null, verdict: "incomparable", disagreement: "incomparable", note: "" },
          match("ownership_class"),
        ],
      },
    ]);

    expect(aggregate.fieldCoverage.hq_state).toBe(1);
    expect(aggregate.matchRatesByField.employees).toBeCloseTo(1);
    expect(aggregate.matchRatesByField.hq_state).toBeCloseTo(0.5);
    expect(aggregate.matchRatesByField.revenue_estimate_usd).toBeCloseTo(0.5);
    expect(aggregate.matchRatesByField.employees).toBeCloseTo(1);
    expect(aggregate.matchRatesByField.proprietary_language).toBeNull();
    expect(aggregate.disagreementCounts.date_mismatch).toBe(1);
    expect(aggregate.disagreementCounts.source_conflict).toBe(1);
    expect(aggregate.overallMatchRate).not.toBeNull();
    const totals = Object.values(aggregate.comparableByField).reduce((a, b) => a + b, 0);
    expect(aggregate.overallMatchRate).toBeCloseTo(8 / totals);
  });

  it("returns null rates for an empty run", () => {
    const aggregate = aggregateComparisons([]);
    expect(aggregate.overallMatchRate).toBeNull();
    expect(Object.values(aggregate.matchRatesByField).every((rate) => rate === null)).toBe(true);
  });
});
