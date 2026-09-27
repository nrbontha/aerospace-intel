import { describe, expect, it } from "vitest";

import { normalizeUnifiedName } from "../scripts/populate-unified-targets.mts";
import {
  INVESTOR_VERDICT_SPLIT,
  INVESTOR_VERDICTS_V1,
} from "../packages/research/src/scoring-axial/fixtures/investor-verdicts.js";
import {
  MA_PRIORITIES_V1,
  MA_PRIORITY_SPLIT,
} from "../packages/research/src/scoring-axial/fixtures/ma-priorities.js";
import {
  ALL_GOLDEN_ENTRIES_V1,
  GOLDEN_DATASET_V1,
} from "../packages/research/src/scoring-axial/fixtures/golden-set.js";
import { DATASET_LABEL_VALUES } from "../packages/research/src/scoring-axial/evaluate.js";
import {
  DEV_PRIORITY_VOCAB,
  VERDICT_VOCAB,
  computeAccuracy,
  confusionMatrix,
  ensembleProbes,
  evaluateThreshold,
  goldenOwnershipText,
  parseValidationArgs,
  perClassMetrics,
  predictGoldenType,
  predictInvestorPriority,
  summarizeSplit,
  type ScoredOutcome,
} from "../scripts/run-validation.mts";

// ---------------------------------------------------------------------------
// Fixture integrity: frozen splits, valid vocab, no test/dev overlap
// ---------------------------------------------------------------------------

describe("frozen eval fixtures", () => {
  it("investor-verdicts test set covers all 29 rows with valid verdicts", () => {
    expect(INVESTOR_VERDICT_SPLIT).toBe("test");
    expect(INVESTOR_VERDICTS_V1).toHaveLength(29);
    for (const row of INVESTOR_VERDICTS_V1) {
      expect(row.name.trim()).not.toBe("");
      expect(VERDICT_VOCAB.includes(row.verdict)).toBe(true);
      expect(row.split).toBe("test");
      expect(VERDICT_VOCAB.includes(row.expectedPipelineDecision)).toBe(true);
    }
  });

  it("ma-priorities dev set covers all 36 rows with valid priorities", () => {
    expect(MA_PRIORITY_SPLIT).toBe("dev");
    expect(MA_PRIORITIES_V1).toHaveLength(36);
    for (const row of MA_PRIORITIES_V1) {
      expect(row.name.trim()).not.toBe("");
      expect([1, 2, 3]).toContain(row.priority);
      expect([1, 2, 3]).toContain(row.expectedInvestorPriority);
      expect(row.split).toBe("dev");
    }
  });

  it("dev sample is stratified across Priority 1/2/3", () => {
    const counts = new Map<number, number>();
    for (const row of MA_PRIORITIES_V1) {
      counts.set(row.priority, (counts.get(row.priority) ?? 0) + 1);
    }
    expect(counts.get(1)).toBeGreaterThan(0);
    expect(counts.get(2)).toBeGreaterThan(0);
    expect(counts.get(3)).toBeGreaterThan(0);
  });

  it("no company appears in both the test and dev splits", () => {
    const testNames: Record<string, true> = {};
    for (const row of INVESTOR_VERDICTS_V1) {
      testNames[normalizeUnifiedName(row.name)] = true;
    }
    const overlap = MA_PRIORITIES_V1.map((row) => row.name).filter(
      (name) => testNames[normalizeUnifiedName(name)] === true,
    );
    expect(overlap).toEqual([]);
  });

  it("golden-set entries carry valid dataset labels", () => {
    expect(ALL_GOLDEN_ENTRIES_V1.length).toBeGreaterThan(0);
    for (const entry of ALL_GOLDEN_ENTRIES_V1) {
      expect(DATASET_LABEL_VALUES.includes(entry.label)).toBe(true);
    }
    // Golden strong_positives exist so HP-equivalent recall has a denominator.
    expect(
      ALL_GOLDEN_ENTRIES_V1.filter((e) => e.label === "strong_positive").length,
    ).toBeGreaterThan(0);
    expect(GOLDEN_DATASET_V1.name).toBe("golden-v1");
  });
});

// ---------------------------------------------------------------------------
// Runner metric math on synthetic outcomes
// ---------------------------------------------------------------------------

const SYNTHETIC: ScoredOutcome[] = [
  { id: "a", actual: "add", predicted: "add" },
  { id: "b", actual: "add", predicted: "hold" },
  { id: "c", actual: "hold", predicted: "hold" },
  { id: "d", actual: "hold", predicted: "hold" },
];

describe("computeAccuracy", () => {
  it("scores exact-match fraction", () => {
    expect(computeAccuracy(SYNTHETIC)).toBe(0.75);
  });

  it("returns NaN on zero outcomes", () => {
    expect(Number.isNaN(computeAccuracy([]))).toBe(true);
  });
});

describe("perClassMetrics", () => {
  it("computes precision/recall/f1 per class", () => {
    const metrics = perClassMetrics(SYNTHETIC, ["add", "hold"]);
    expect(metrics["add"]).toMatchObject({
      support: 2,
      predicted: 1,
      tp: 1,
      fp: 0,
      fn: 1,
      precision: 1,
      recall: 0.5,
    });
    expect(metrics["add"]!.f1).toBeCloseTo(2 / 3, 10);
    expect(metrics["hold"]).toMatchObject({
      support: 2,
      predicted: 3,
      tp: 2,
      fp: 1,
      fn: 0,
      precision: 2 / 3,
      recall: 1,
    });
  });

  it("yields 0 on zero-division (never predicted / never actual)", () => {
    const metrics = perClassMetrics(SYNTHETIC, ["add", "pass_dead"]);
    expect(metrics["pass_dead"]).toMatchObject({
      support: 0,
      predicted: 0,
      tp: 0,
      precision: 0,
      recall: 0,
      f1: 0,
    });
  });
});

describe("confusionMatrix", () => {
  it("counts actual->predicted cells over the sorted label union", () => {
    const matrix = confusionMatrix(SYNTHETIC);
    expect(matrix.classes).toEqual(["add", "hold"]);
    expect(matrix.cells).toEqual([
      { actual: "add", predicted: "add", count: 1 },
      { actual: "add", predicted: "hold", count: 1 },
      { actual: "hold", predicted: "hold", count: 2 },
    ]);
  });

  it("includes predicted-only labels in the union", () => {
    const matrix = confusionMatrix([
      { id: "x", actual: "add", predicted: "unreviewed" },
    ]);
    expect(matrix.classes).toEqual(["add", "unreviewed"]);
    expect(matrix.cells).toEqual([
      { actual: "add", predicted: "unreviewed", count: 1 },
    ]);
  });
});

describe("summarizeSplit", () => {
  it("bundles n, accuracy, per-class metrics, and confusion", () => {
    const summary = summarizeSplit("synthetic", SYNTHETIC, ["add", "hold"]);
    expect(summary.n).toBe(4);
    expect(summary.accuracy).toBe(0.75);
    expect(Object.keys(summary.perClass).sort()).toEqual(["add", "hold"]);
    expect(summary.confusion.cells).toHaveLength(3);
  });

  it("reports null accuracy on zero outcomes", () => {
    const summary = summarizeSplit("empty", [], ["add"]);
    expect(summary.n).toBe(0);
    expect(summary.accuracy).toBeNull();
  });
});

describe("evaluateThreshold", () => {
  it("passes at the boundary, fails below, fails on missing accuracy", () => {
    expect(evaluateThreshold(0.5, 0.5).passed).toBe(true);
    expect(evaluateThreshold(0.49, 0.5).passed).toBe(false);
    expect(evaluateThreshold(null, 0.5).passed).toBe(false);
  });
});

describe("parseValidationArgs", () => {
  it("defaults min-accuracy to 0.5 with no JSON path", () => {
    expect(parseValidationArgs([])).toEqual({
      minAccuracy: 0.5,
      jsonPath: null,
    });
  });

  it("accepts --min-accuracy and --json", () => {
    expect(
      parseValidationArgs(["--min-accuracy", "0.9", "--json", "out/r.json"]),
    ).toEqual({ minAccuracy: 0.9, jsonPath: "out/r.json" });
  });

  it("rejects out-of-range, missing, and unknown flags", () => {
    expect(() => parseValidationArgs(["--min-accuracy", "2"])).toThrow();
    expect(() => parseValidationArgs(["--min-accuracy"])).toThrow();
    expect(() => parseValidationArgs(["--json"])).toThrow();
    expect(() => parseValidationArgs(["--bogus"])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Deterministic-logic wiring (current behavior, pinned against live imports)
// ---------------------------------------------------------------------------

describe("golden ownership bridge", () => {
  it("maps feature ownership types to rule-classified text", () => {
    expect(goldenOwnershipText("public_sub")).toBe("Public Subsidiary");
    expect(goldenOwnershipText("pe_owned")).toBe("Private Equity Add-On");
    expect(goldenOwnershipText("independent_founder")).toBe(
      "Private Independent",
    );
    expect(goldenOwnershipText("unknown")).toBeNull();
  });

  it("predicts HP-equivalent types through proposeLabels", () => {
    expect(predictGoldenType("public_sub")).toBe(
      "ideal_archetype_but_unactionable",
    );
    expect(predictGoldenType("pe_owned")).toBe("positive_with_caveat");
    expect(predictGoldenType("independent_founder")).toBe("strong_positive");
  });
});

describe("investor-rank prediction", () => {
  it("returns a Priority 1-3 rank for thin pipeline rows", () => {
    const rank = predictInvestorPriority({
      name: "Synthetic Co",
      domain: "synthetic.example.com",
      priority: 1,
      ownership: null,
      expectedInvestorPriority: 1,
    });
    expect([1, 2, 3]).toContain(rank);
    expect(DEV_PRIORITY_VOCAB).toEqual(["1", "2", "3"]);
  });

  it("demotes identity-thin rows without a website to Priority 3", () => {
    expect(
      predictInvestorPriority({
        name: "Thin Co",
        domain: null,
        priority: 1,
        ownership: null,
        expectedInvestorPriority: 1,
      }),
    ).toBe(3);
  });
});

describe("ensembleProbes", () => {
  it("documents current mapper behavior without scoring it", () => {
    const probes = ensembleProbes();
    const high = probes.find((p) => p.decision === "high_priority");
    const rejected = probes.find((p) => p.decision === "reject");
    expect(high!.predicted).toMatch(/^priority-1\//);
    expect(rejected!.predicted).toBe("excluded(null)");
  });
});
