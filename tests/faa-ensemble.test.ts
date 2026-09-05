import { describe, expect, it } from "vitest";

import {
  adjudicatorResultSchema,
  buildEvidencePackage,
  ensembleDecisionSchema,
  evaluatorResultSchema,
  parseEnsembleArgs,
  resolveEnsemble,
  resolveEnsembleConfig,
  runWithConcurrency,
  summarizeEnsembleOutcomes,
  type EnsembleSignalOutcome,
  type FaaEvaluatorResult,
} from "../scripts/run-faa-ensemble.mts";

function evaluatorResult(
  overrides: Partial<FaaEvaluatorResult> = {},
): FaaEvaluatorResult {
  return {
    decision: "research",
    confidence: 60,
    company_type: "manufacturer",
    aerospace_defense_relevance: "PMA parts for aircraft models",
    manufacturing_evidence: "FAA PMA holder with part records",
    thesis_signals: ["pma_holder"],
    disqualifiers: [],
    missing_evidence: ["ownership", "revenue"],
    false_negative_risk: "low",
    reason: "fixture",
    ...overrides,
  };
}

describe("parseEnsembleArgs", () => {
  it("applies defaults", () => {
    expect(parseEnsembleArgs([])).toMatchObject({
      limit: 0,
      status: "queued_qualification",
      sourceKey: "faa_pma_database",
      dryRun: false,
      sample: null,
      concurrency: 5,
      includeKnown: false,
      benchmarkNames: [],
      failedOnly: false,
    });
  });

  it("parses every CLI flag", () => {
    const options = parseEnsembleArgs([
      "--limit",
      "25",
      "--status",
      "qualifying",
      "--source-key",
      "custom_key",
      "--dry-run",
      "--sample",
      "10",
      "--concurrency",
      "3",
      "--include-known",
      "--benchmark-names",
      "Zephyr,RAM,Zitec",
      "--failed-only",
    ]);
    expect(options).toMatchObject({
      limit: 25,
      status: "qualifying",
      sourceKey: "custom_key",
      dryRun: true,
      sample: 10,
      concurrency: 3,
      includeKnown: true,
      benchmarkNames: ["Zephyr", "RAM", "Zitec"],
      failedOnly: true,
    });
  });

  it("supports --flag=value form", () => {
    expect(parseEnsembleArgs(["--limit=7", "--sample=2"])).toMatchObject({
      limit: 7,
      sample: 2,
    });
  });

  it("rejects negative limits", () => {
    expect(() => parseEnsembleArgs(["--limit", "-1"])).toThrow("--limit");
  });
});

describe("resolveEnsembleConfig", () => {
  it("defaults to the free-tier pair with adjudicator = model A", () => {
    expect(resolveEnsembleConfig({})).toMatchObject({
      modelA: "qwen/qwen3-30b-a3b:free",
      modelB: "google/gemma-3-27b-it:free",
      adjudicatorModel: "qwen/qwen3-30b-a3b:free",
      concurrency: 5,
    });
  });

  it("honors additive env overrides", () => {
    expect(
      resolveEnsembleConfig({
        FAA_MODEL_A: "a/model",
        FAA_MODEL_B: "b/model",
        FAA_ADJUDICATOR_MODEL: "c/model",
        FAA_QUALIFICATION_CONCURRENCY: "2",
      }),
    ).toMatchObject({
      modelA: "a/model",
      modelB: "b/model",
      adjudicatorModel: "c/model",
      concurrency: 2,
    });
  });
});

describe("ensemble rule", () => {
  it.each(["reject", "research", "high_priority"] as const)(
    "accepts agreement on %s without adjudication",
    (decision) => {
      const resolution = resolveEnsemble(
        evaluatorResult({ decision, confidence: 70 }),
        evaluatorResult({ decision, confidence: 80 }),
      );
      expect(resolution).toMatchObject({
        agreed: true,
        adjudicationRequired: false,
        finalDecision: decision,
      });
    },
  );

  it("defaults research+high_priority to research without adjudication", () => {
    for (const [first, second] of [
      ["research", "high_priority"],
      ["high_priority", "research"],
    ] as const) {
      const resolution = resolveEnsemble(
        evaluatorResult({ decision: first }),
        evaluatorResult({ decision: second }),
      );
      expect(resolution).toMatchObject({
        agreed: false,
        adjudicationRequired: false,
        finalDecision: "research",
      });
    }
  });

  it.each([
    ["reject", "research"],
    ["research", "reject"],
    ["reject", "high_priority"],
    ["high_priority", "reject"],
  ] as const)("adjudicates reject-vs-%s vs %s", (first, second) => {
    const resolution = resolveEnsemble(
      evaluatorResult({ decision: first }),
      evaluatorResult({ decision: second }),
    );
    expect(resolution).toMatchObject({
      agreed: false,
      adjudicationRequired: true,
      finalDecision: "research",
    });
  });

  it("adjudicates malformed (null) evaluations", () => {
    expect(
      resolveEnsemble(null, evaluatorResult({ decision: "high_priority" })),
    ).toMatchObject({ adjudicationRequired: true, finalDecision: "research" });
    expect(
      resolveEnsemble(evaluatorResult({ decision: "reject" }), null),
    ).toMatchObject({ adjudicationRequired: true });
    expect(resolveEnsemble(null, null)).toMatchObject({
      adjudicationRequired: true,
    });
  });
});

describe("ensemble schemas", () => {
  it("accepts the three valid decisions", () => {
    for (const decision of ["reject", "research", "high_priority"] as const) {
      expect(ensembleDecisionSchema.parse(decision)).toBe(decision);
    }
  });

  it("rejects invalid decision enums like 'maybe'", () => {
    expect(() => ensembleDecisionSchema.parse("maybe")).toThrow();
    expect(() =>
      evaluatorResultSchema.parse(evaluatorResult({ decision: "maybe" as never })),
    ).toThrow();
    expect(() =>
      adjudicatorResultSchema.parse({ decision: "maybe", confidence: 50, reason: "x" }),
    ).toThrow();
  });

  it("bounds confidence to 0..100", () => {
    expect(() =>
      evaluatorResultSchema.parse(evaluatorResult({ confidence: 101 })),
    ).toThrow();
    expect(() =>
      evaluatorResultSchema.parse(evaluatorResult({ confidence: -1 })),
    ).toThrow();
  });
});

describe("buildEvidencePackage", () => {
  it("builds a compact package from a fixture source_signals row", () => {
    const pkg = buildEvidencePackage({
      id: "00000000-0000-0000-0000-000000000001",
      raw_name: "Zephyr Propulsion Labs",
      raw_domain: null,
      uei: null,
      cage: "8AZ11",
      city: "Mojave",
      state: "CA",
      country: "US",
      award_count: 14,
      freshest_award: "2024-03-01T00:00:00.000Z",
      source_payload: {
        address: "123 Flight Line",
        zip: "93501",
        makes: ["BOEING", "AIRBUS"],
        models_sample: ["737", "A320"],
        guid_url: "https://drs.faa.gov/browse/excelExternalWindow/abc",
      },
    });
    expect(pkg).toMatchObject({
      signalId: "00000000-0000-0000-0000-000000000001",
      name: "Zephyr Propulsion Labs",
      domain: null,
      cage: "8AZ11",
      city: "Mojave",
      state: "CA",
      partCount: 14,
      makes: ["BOEING", "AIRBUS"],
      modelsSample: ["737", "A320"],
      guidUrl: "https://drs.faa.gov/browse/excelExternalWindow/abc",
    });
  });

  it("caps makes/models and tolerates missing payload", () => {
    const pkg = buildEvidencePackage({
      id: "00000000-0000-0000-0000-000000000002",
      raw_name: "Sparse Co",
      source_payload: {
        makes: Array.from({ length: 30 }, (_, index) => `MAKE-${index}`),
        models_sample: "not-a-list",
      },
    });
    expect(pkg.makes).toHaveLength(12);
    expect(pkg.modelsSample).toEqual([]);
    expect(pkg.guidUrl).toBeNull();
  });
});

describe("runWithConcurrency", () => {
  it("preserves input order under concurrency", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const result = await runWithConcurrency(
      [1, 2, 3, 4, 5],
      2,
      async (item) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return item * 10;
      },
    );
    expect(result).toEqual([10, 20, 30, 40, 50]);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
});

describe("summarizeEnsembleOutcomes", () => {
  const outcomes: EnsembleSignalOutcome[] = [
    {
      modelADecision: "high_priority",
      modelBDecision: "high_priority",
      agreed: true,
      adjudicationRequired: false,
      adjudicated: false,
      finalDecision: "high_priority",
      apiCalls: 2,
      failures: 0,
    },
    {
      modelADecision: "research",
      modelBDecision: "high_priority",
      agreed: false,
      adjudicationRequired: false,
      adjudicated: false,
      finalDecision: "research",
      apiCalls: 2,
      failures: 0,
    },
    {
      modelADecision: "reject",
      modelBDecision: "research",
      agreed: false,
      adjudicationRequired: true,
      adjudicated: true,
      finalDecision: "research",
      apiCalls: 3,
      failures: 0,
    },
    {
      modelADecision: null,
      modelBDecision: "research",
      agreed: false,
      adjudicationRequired: true,
      adjudicated: false,
      finalDecision: "research",
      apiCalls: 3,
      failures: 2,
    },
  ];

  it("computes agreement rates, distributions, and call counts", () => {
    const metrics = summarizeEnsembleOutcomes(outcomes);
    expect(metrics.total).toBe(4);
    expect(metrics.agreed).toBe(1);
    expect(metrics.agreementRate).toBeCloseTo(0.25);
    expect(metrics.disagreementRate).toBeCloseTo(0.75);
    expect(metrics.perModel.a).toMatchObject({
      reject: 1,
      research: 1,
      high_priority: 1,
      error: 1,
    });
    expect(metrics.perModel.b).toMatchObject({
      reject: 0,
      research: 2,
      high_priority: 2,
      error: 0,
    });
    expect(metrics.finalDistribution).toMatchObject({
      reject: 0,
      research: 3,
      high_priority: 1,
    });
    expect(metrics.adjudications).toBe(1);
    expect(metrics.apiCalls).toBe(10);
    expect(metrics.failures).toBe(2);
  });
});
