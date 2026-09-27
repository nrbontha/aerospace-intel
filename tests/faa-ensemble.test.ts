import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi, type Mock } from "vitest";

import { type Database } from "../packages/database/src/index.js";
import {
  adjudicatorResultSchema,
  buildEvidencePackage,
  ensembleDecisionSchema,
  evaluatorResultSchema,
  isRateLimitError,
  parseEnsembleArgs,
  resolveEnsemble,
  resolveEnsembleConfig,
  runJevCascade,
  runJevSweep,
  runMuseVerification,
  runWithConcurrency,
  selectCandidateSignals,
  summarizeEnsembleOutcomes,
  type EnsembleSignalOutcome,
  type FaaEvaluatorResult,
  withRateLimitPatience,
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
  it("defaults to every queued source key", () => {
    expect(parseEnsembleArgs([])).toMatchObject({
      limit: 0,
      status: "queued_qualification",
      sourceKeys: [],
      dryRun: false,
      sample: null,
      concurrency: 5,
      includeKnown: false,
      benchmarkNames: [],
      failedOnly: false,
    });
  });

  it("treats empty and all source-key values as every queued key", () => {
    expect(parseEnsembleArgs(["--source-key", ""]).sourceKeys).toEqual([]);
    expect(parseEnsembleArgs(["--source-key=all"]).sourceKeys).toEqual([]);
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
      sourceKeys: ["custom_key"],
      dryRun: true,
      sample: 10,
      concurrency: 3,
      includeKnown: true,
      benchmarkNames: ["Zephyr", "RAM", "Zitec"],
      failedOnly: true,
    });
  });

  it("parses comma-separated source keys", () => {
    expect(
      parseEnsembleArgs(["--source-key", "faa_pma_database, sam_entity"]),
    ).toMatchObject({
      sourceKeys: ["faa_pma_database", "sam_entity"],
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

describe("selectCandidateSignals", () => {
  it("filters multiple source keys and selects FIFO by creation time", async () => {
    const execute = vi.fn(async (_query: unknown) => ({ rows: [] }));
    await selectCandidateSignals(
      { execute } as unknown as Database,
      parseEnsembleArgs([
        "--source-key",
        "faa_pma_database,sam_entity",
        "--include-known",
      ]),
    );

    const query = new PgDialect().sqlToQuery(execute.mock.calls[0]![0] as SQL);
    expect(query.params).toEqual(
      expect.arrayContaining(["faa_pma_database", "sam_entity"]),
    );
    expect(query.sql).toMatch(/ss\.source_key IN \(\$\d+, \$\d+\)/);
    expect(query.sql).toContain("ORDER BY ss.created_at ASC, ss.id ASC");
  });
});

describe("resolveEnsembleConfig", () => {
  it("defaults to GLM single-model operation with adjudicator = model A", () => {
    expect(resolveEnsembleConfig({})).toMatchObject({
      modelA: "meta/muse-spark-1.3-contributor",
      modelB: "meta/muse-spark-1.3-contributor",
      adjudicatorModel: "meta/muse-spark-1.3-contributor",
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
      evaluatorResultSchema.parse(
        evaluatorResult({ decision: "maybe" as never }),
      ),
    ).toThrow();
    expect(() =>
      adjudicatorResultSchema.parse({
        decision: "maybe",
        confidence: 50,
        reason: "x",
      }),
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

describe("withRateLimitPatience", () => {
  it("classifies rate-limit errors", () => {
    expect(
      isRateLimitError(new Error("OpenRouter request was rate limited")),
    ).toBe(true);
    expect(isRateLimitError(new Error("429 Too Many Requests"))).toBe(true);
    expect(isRateLimitError(new Error("validation_failed"))).toBe(false);
  });

  it("retries rate limits then returns success", async () => {
    let calls = 0;
    const slept: number[] = [];
    const result = await withRateLimitPatience(
      () => {
        calls += 1;
        if (calls < 3) throw new Error("rate limited");
        return Promise.resolve("ok");
      },
      async (ms: number) => {
        slept.push(ms);
      },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(slept).toHaveLength(2);
  });

  it("throws non-rate-limit errors immediately", async () => {
    let calls = 0;
    await expect(
      withRateLimitPatience(() => {
        calls += 1;
        throw new Error("validation_failed");
      }),
    ).rejects.toThrow("validation_failed");
    expect(calls).toBe(1);
  });
});

describe("runJevCascade", () => {
  const row = { id: "signal-1" };
  const pkg = {
    signalId: "signal-1",
    name: "Acme Aero",
    domain: null,
    cage: null,
    uei: null,
    address: null,
    city: null,
    state: null,
    country: null,
    partCount: 10,
    makes: ["Boeing"],
    modelsSample: [],
    supplementDate: null,
    guidUrl: null,
  };
  const mockDb = () => ({ execute: vi.fn(async () => ({ rows: [] })) });
  const baseConfig = {
    ...resolveEnsembleConfig({}),
    jevAuditSampleRate: 0,
    jevRejectConfirmThreshold: 0.85,
    requestDelayMs: 0,
  };
  const museOk = (decision: "reject" | "research" | "high_priority") =>
    vi.fn(async () => ({
      ok: true as const,
      result: evaluatorResult({ decision }),
      rawResponse: "{}",
      tokens: { input: 1, output: 1, total: 2 },
      costUsd: null,
    }));

  it("accepts JEv research with zero Muse calls", async () => {
    const evaluate = museOk("research");
    const outcome = await runJevCascade(
      mockDb() as never,
      row as never,
      pkg,
      baseConfig,
      async () => ({ decision: "research", confidence: 0.7, costUsd: null }),
      evaluate,
    );
    expect(outcome).toMatchObject({
      finalDecision: "research",
      jevFastPath: true,
      jevDecision: "research",
      apiCalls: 0,
    });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("confirms JEv high_priority with one Muse call", async () => {
    const evaluate = museOk("high_priority");
    const outcome = await runJevCascade(
      mockDb() as never,
      row as never,
      pkg,
      baseConfig,
      async () => ({
        decision: "high_priority",
        confidence: 0.9,
        costUsd: null,
      }),
      evaluate,
    );
    expect(outcome).toMatchObject({
      finalDecision: "high_priority",
      apiCalls: 1,
    });
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it("overrules unconfirmed high_priority to research", async () => {
    const outcome = await runJevCascade(
      mockDb() as never,
      row as never,
      pkg,
      baseConfig,
      async () => ({
        decision: "high_priority",
        confidence: 0.9,
        costUsd: null,
      }),
      museOk("research"),
    );
    expect(outcome).toMatchObject({ finalDecision: "research" });
  });

  it("confirms high-confidence JEv reject with one Muse call", async () => {
    const outcome = await runJevCascade(
      mockDb() as never,
      row as never,
      pkg,
      baseConfig,
      async () => ({ decision: "reject", confidence: 0.95, costUsd: null }),
      museOk("reject"),
    );
    expect(outcome).toMatchObject({ finalDecision: "reject", apiCalls: 1 });
  });

  it("retains low-confidence reject without Muse calls", async () => {
    const evaluate = museOk("reject");
    const outcome = await runJevCascade(
      mockDb() as never,
      row as never,
      pkg,
      baseConfig,
      async () => ({ decision: "reject", confidence: 0.4, costUsd: null }),
      evaluate,
    );
    expect(outcome).toMatchObject({
      finalDecision: "research",
      jevFastPath: true,
    });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("falls through on screen error and on audit sample", async () => {
    expect(
      await runJevCascade(
        mockDb() as never,
        row as never,
        pkg,
        baseConfig,
        async () => null,
        museOk("research"),
      ),
    ).toBeNull();
    expect(
      await runJevCascade(
        mockDb() as never,
        row as never,
        pkg,
        { ...baseConfig, jevAuditSampleRate: 1 },
        async () => ({ decision: "research", confidence: 0.9, costUsd: null }),
        museOk("research"),
      ),
    ).toBeNull();
  });
});

describe("runJevSweep", () => {
  const sweepConfig = { ...resolveEnsembleConfig({}), requestDelayMs: 0 };
  const candidate = (id: string) => ({
    id,
    raw_name: `Supplier ${id}`,
    raw_domain: null,
    uei: null,
    cage: null,
    city: null,
    state: null,
    country: null,
    award_count: 3,
    freshest_award: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    source_payload: {},
  });
  const statementsOf = (execute: Mock) =>
    execute.mock.calls.map(([query]) => {
      const rendered = new PgDialect().sqlToQuery(query as SQL);
      return { ...rendered, sql: rendered.sql.trimStart() };
    });

  it("persists jev evals with zero Muse calls and no result rows", async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    execute.mockResolvedValueOnce({ rows: [candidate("s1"), candidate("s2")] });
    const screenJev = vi.fn(async (pkg: { signalId: string }) =>
      pkg.signalId === "s1"
        ? { decision: "high_priority" as const, confidence: 0.9, costUsd: null }
        : { decision: "research" as const, confidence: 0.7, costUsd: null },
    );
    const summary = await runJevSweep(
      { execute } as unknown as Database,
      { status: "queued_qualification", concurrency: 2 },
      { screenJev: screenJev as never, config: sweepConfig },
    );
    expect(summary).toEqual({ screened: 2, flagged: 1, errors: 0 });
    expect(screenJev).toHaveBeenCalledTimes(2);
    const inserts = statementsOf(execute).filter((s) =>
      s.sql.startsWith("INSERT"),
    );
    expect(inserts).toHaveLength(2);
    expect(
      inserts.every((s) => s.sql.includes("faa_ensemble_evaluations")),
    ).toBe(true);
    expect(inserts.some((s) => s.sql.includes("faa_ensemble_results"))).toBe(
      false,
    );
  });

  it("counts screen misses as errors without persisting", async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    execute.mockResolvedValueOnce({ rows: [candidate("s1")] });
    const summary = await runJevSweep(
      { execute } as unknown as Database,
      {},
      { screenJev: async () => null, config: sweepConfig },
    );
    expect(summary).toEqual({ screened: 0, flagged: 0, errors: 1 });
    expect(statementsOf(execute).some((s) => s.sql.startsWith("INSERT"))).toBe(
      false,
    );
  });
});

describe("runMuseVerification", () => {
  const verifyConfig = {
    ...resolveEnsembleConfig({}),
    requestDelayMs: 0,
    jevRejectConfirmThreshold: 0.85,
    jevAuditSampleRate: 0.05,
  };
  const stored = (
    id: string,
    jev_decision: "high_priority" | "reject" | "research",
    jev_confidence: number,
  ) => ({
    id,
    raw_name: `Supplier ${id}`,
    raw_domain: null,
    uei: null,
    cage: null,
    city: null,
    state: null,
    country: null,
    award_count: 3,
    freshest_award: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    source_payload: {},
    jev_decision,
    jev_confidence,
    jev_cost: null,
  });
  const museOk = (decision: "reject" | "research" | "high_priority") =>
    vi.fn(async () => ({
      ok: true as const,
      result: evaluatorResult({ decision }),
      rawResponse: "{}",
      tokens: { input: 1, output: 1, total: 2 },
      costUsd: null,
    }));
  const flaggedThenAudit = (
    execute: Mock,
    flagged: unknown[],
    audit: unknown[],
  ) => {
    execute.mockResolvedValueOnce({ rows: flagged });
    execute.mockResolvedValueOnce({ rows: audit });
  };

  it("confirms a JEv high_priority with one Muse call", async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    flaggedThenAudit(execute, [stored("hp1", "high_priority", 90)], []);
    const evaluateModel = museOk("high_priority");
    const summary = await runMuseVerification(
      { execute } as unknown as Database,
      { limit: 10, concurrency: 1 },
      { evaluateModel: evaluateModel as never, config: verifyConfig },
    );
    expect(summary).toEqual({
      verified: 1,
      confirmed: 1,
      overruled: 0,
      errors: 0,
    });
    expect(evaluateModel).toHaveBeenCalledTimes(1);
  });

  it("overrules a JEv reject the second opinion does not confirm", async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    flaggedThenAudit(execute, [stored("rj1", "reject", 95)], []);
    const evaluateModel = museOk("research");
    const summary = await runMuseVerification(
      { execute } as unknown as Database,
      { limit: 10, concurrency: 1 },
      { evaluateModel: evaluateModel as never, config: verifyConfig },
    );
    expect(summary).toEqual({
      verified: 1,
      confirmed: 0,
      overruled: 1,
      errors: 0,
    });
  });

  it("skips signals that already have Muse evals", async () => {
    const pool = [
      stored("hp1", "high_priority", 90),
      stored("hp2", "high_priority", 88),
    ];
    const museEvals = new Set(["hp1"]);
    const execute = vi.fn(async () => ({ rows: [] }));
    execute.mockImplementationOnce(async () => ({
      rows: pool.filter((row) => !museEvals.has(row.id)),
    }));
    execute.mockResolvedValueOnce({ rows: [] });
    const evaluateModel = museOk("high_priority");
    const summary = await runMuseVerification(
      { execute } as unknown as Database,
      { limit: 10, concurrency: 1 },
      { evaluateModel: evaluateModel as never, config: verifyConfig },
    );
    expect(summary).toEqual({
      verified: 1,
      confirmed: 1,
      overruled: 0,
      errors: 0,
    });
    expect(evaluateModel).toHaveBeenCalledTimes(1);
    expect(evaluateModel.mock.calls[0]![1]).toMatchObject({
      signalId: "hp2",
    });
  });

  it("verifies the audit sample of JEv-research signals", async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    flaggedThenAudit(execute, [], [stored("r1", "research", 70)]);
    const evaluateModel = museOk("research");
    const summary = await runMuseVerification(
      { execute } as unknown as Database,
      { limit: 20, concurrency: 1 },
      { evaluateModel: evaluateModel as never, config: verifyConfig },
    );
    expect(summary).toEqual({
      verified: 1,
      confirmed: 1,
      overruled: 0,
      errors: 0,
    });
    expect(evaluateModel).toHaveBeenCalledTimes(1);
    const auditQuery = new PgDialect().sqlToQuery(
      execute.mock.calls[1]![0] as SQL,
    );
    expect(auditQuery.sql).toContain("jev.decision = 'research'");
    expect(auditQuery.sql).toMatch(/LIMIT/);
  });

  it("records Muse failures without writing result rows", async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    flaggedThenAudit(execute, [stored("hp1", "high_priority", 90)], []);
    const evaluateModel = vi.fn(async () => ({
      ok: false as const,
      error: "boom",
      rawResponse: null,
    }));
    const summary = await runMuseVerification(
      { execute } as unknown as Database,
      { limit: 10, concurrency: 1 },
      { evaluateModel: evaluateModel as never, config: verifyConfig },
    );
    expect(summary).toEqual({
      verified: 0,
      confirmed: 0,
      overruled: 0,
      errors: 1,
    });
    const inserts = execute.mock.calls
      .map(([query]) => new PgDialect().sqlToQuery(query as SQL))
      .filter((s) => s.sql.startsWith("INSERT"));
    expect(inserts.some((s) => s.sql.includes("faa_ensemble_results"))).toBe(
      false,
    );
  });
});
