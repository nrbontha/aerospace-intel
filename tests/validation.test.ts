import { describe, expect, it } from "vitest";

import {
  parseBenchmarkResultDocument,
  parseValidationArgs,
  summarizeBenchmark,
  type BenchmarkOutcome,
} from "../scripts/run-validation.mts";

const OUTCOMES: BenchmarkOutcome[] = [
  {
    id: "sourced-hp",
    cohort: "sourced_real",
    expected: "high_priority",
    actual: "high_priority",
    costUsd: 0.1,
    callCount: 4,
  },
  {
    id: "research-promoted",
    cohort: "sourced_real",
    expected: "research",
    actual: "high_priority",
    costUsd: 0.2,
    callCount: 4,
  },
  {
    id: "negative-promoted",
    cohort: "sourced_real",
    expected: "reject",
    actual: "high_priority",
    costUsd: 0.3,
    callCount: 4,
  },
  {
    id: "positive-rejected",
    cohort: "investor_review_report_only",
    expected: "high_priority",
    actual: "reject",
    costUsd: 0.4,
    callCount: 2,
  },
  {
    id: "research-rejected",
    cohort: "investor_review_report_only",
    expected: "research",
    actual: "reject",
    costUsd: 0.5,
    callCount: 2,
  },
  {
    id: "negative-abstained",
    cohort: "synthetic_control",
    expected: "reject",
    actual: "research",
    costUsd: 0.6,
    callCount: 3,
  },
  {
    id: "research-abstained",
    cohort: "synthetic_control",
    expected: "research",
    actual: "research",
    costUsd: 0.7,
    callCount: 3,
  },
  {
    id: "positive-error",
    cohort: "sourced_real",
    expected: "high_priority",
    actual: "error",
    costUsd: 0.8,
    callCount: 1,
  },
];

describe("production benchmark summary", () => {
  it("separately reports harmful promotions, rejects, abstentions, and errors", () => {
    const summary = summarizeBenchmark(OUTCOMES);

    expect(summary).toMatchObject({
      caseCount: 8,
      exactMatches: 2,
      exactMatchRate: 0.25,
      falsePromotions: 2,
      falseRejects: 2,
      missedHighPriority: 2,
      expectedResearchPromotions: 1,
      abstentions: 2,
      errors: 1,
      decisiveCases: 5,
      coverage: 0.625,
      totalCallCount: 23,
    });
    expect(summary.totalCostUsd).toBeCloseTo(3.6, 10);
    expect(summary.averageCostUsd).toBeCloseTo(0.45, 10);
  });

  it("does not treat expected research promoted to HP as correct", () => {
    const summary = summarizeBenchmark([
      {
        id: "research-to-hp",
        cohort: "sourced_real",
        expected: "research",
        actual: "high_priority",
        costUsd: 0,
        callCount: 1,
      },
    ]);

    expect(summary.exactMatches).toBe(0);
    expect(summary.falsePromotions).toBe(1);
    expect(summary.expectedResearchPromotions).toBe(1);
    expect(summary.coverage).toBe(1);
  });

  it("keeps sourced, synthetic, and prior-review cohorts distinct", () => {
    const summary = summarizeBenchmark(OUTCOMES);

    expect(summary.byCohort.sourced_real).toMatchObject({
      caseCount: 4,
      falsePromotions: 2,
      falseRejects: 0,
      errors: 1,
    });
    expect(summary.byCohort.synthetic_control).toMatchObject({
      caseCount: 2,
      abstentions: 2,
      coverage: 0,
    });
    expect(summary.byCohort.investor_review_report_only).toMatchObject({
      caseCount: 2,
      falseRejects: 2,
    });
  });

  it("rejects duplicate cases and invalid cost accounting", () => {
    expect(() => summarizeBenchmark([OUTCOMES[0]!, OUTCOMES[0]!])).toThrow(
      /duplicate benchmark outcome id/u,
    );
    expect(() =>
      summarizeBenchmark([
        {
          ...OUTCOMES[0]!,
          id: "negative-cost",
          costUsd: -0.1,
        },
      ]),
    ).toThrow(/invalid cost\/call count/u);
  });
});

describe("benchmark result boundary", () => {
  it("accepts the portable bakeoff result shape", () => {
    const document = parseBenchmarkResultDocument({
      version: "jev-bakeoff-v2",
      outcomes: OUTCOMES,
    });

    expect(document.version).toBe("jev-bakeoff-v2");
    expect(document.outcomes).toHaveLength(8);
  });

  it("rejects unknown cohorts and decisions", () => {
    expect(() =>
      parseBenchmarkResultDocument({
        version: "bad",
        outcomes: [
          {
            ...OUTCOMES[0],
            cohort: "holdout",
            actual: "maybe",
          },
        ],
      }),
    ).toThrow();
  });
});

describe("validation CLI", () => {
  it("rejects missing paths and unknown options", () => {
    expect(() => parseValidationArgs(["--input"])).toThrow();
    expect(() => parseValidationArgs(["--json"])).toThrow();
    expect(() => parseValidationArgs(["--minimum", "0.5"])).toThrow();
  });
});
