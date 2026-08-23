/**
 * Unit tests for the entity-resolution benchmark's pure parts:
 * perturbation generator determinism/structure, metric math on synthetic
 * cases, and threshold-curve shape.
 */
import { describe, expect, it } from "vitest";

import {
  aliasCapture,
  countFalseMerges,
  OPERATING_THRESHOLD,
  predictsMatchAt,
  THRESHOLDS,
  thresholdSweep,
} from "../packages/research/src/benchmarks/entity-resolution/metrics.js";
import {
  DEFAULT_ER_SEED,
  mulberry32,
  stripLegalSuffixes,
  transposeNameOrder,
} from "../packages/research/src/benchmarks/entity-resolution/perturbations.js";
import type { ErCase, ErOutcome, GroundTruth } from "../packages/research/src/benchmarks/entity-resolution/types.js";

// ---------------------------------------------------------------------------
// Synthetic ground truth
// ---------------------------------------------------------------------------

function syntheticTruth(): GroundTruth {
  return {
    companies: [
      {
        companyId: "c-zephyr",
        legalName: "zephyr international llc",
        displayName: "Zephyr International",
        domains: ["zephyrintl.com"],
        aliases: ["ZI"],
        usState: "FL",
      },
      {
        companyId: "c-hitchiner",
        legalName: "Hitchiner Manufacturing Co., Inc.",
        displayName: "Hitchiner",
        domains: ["hitchiner.com"],
        aliases: ["HMC"],
        usState: "NH",
      },
    ],
    goldenMembers: [
      {
        snapshotId: "s-golden",
        snapshotName: "Golden Set v01",
        rawName: "Servotronics, Inc.",
        normalizedDomain: "servotronics.com",
      },
    ],
    pipelineMembers: [
      {
        snapshotId: "s-pipe",
        snapshotName: "Preliminary Pipeline v01",
        rawName: "ValveTech",
        normalizedDomain: "valvetech.net",
      },
    ],
    leads: [
      {
        leadId: "l-1",
        rawName: "YULISTA AVIATION, INC.",
        domain: null,
        resolvedCompanyId: null,
        status: "unresolved_lead",
      },
    ],
    goldenPipelineDomainOverlap: 0,
  };
}

describe("perturbation generator", () => {
  it("is deterministic for a fixed seed", async () => {
    const { buildPerturbationCases } = await import(
      "../packages/research/src/benchmarks/entity-resolution/perturbations.js"
    );
    const truth = syntheticTruth();
    const a = buildPerturbationCases(truth, DEFAULT_ER_SEED);
    const b = buildPerturbationCases(truth, DEFAULT_ER_SEED);
    expect(a).toEqual(b);
  });

  it("changes noise output under a different seed", async () => {
    const { buildPerturbationCases } = await import(
      "../packages/research/src/benchmarks/entity-resolution/perturbations.js"
    );
    const truth = syntheticTruth();
    const a = buildPerturbationCases(truth, 1);
    const b = buildPerturbationCases(truth, 2);
    expect(a.some((c, i) => c.rawName !== b[i]!.rawName)).toBe(true);
  });

  it("labels confusables as negatives with no expected company", async () => {
    const { buildPerturbationCases } = await import(
      "../packages/research/src/benchmarks/entity-resolution/perturbations.js"
    );
    const cases = buildPerturbationCases(syntheticTruth(), DEFAULT_ER_SEED);
    const zephyrTool = cases.find((c) => c.rawName.startsWith("Zephyr Tool"));
    expect(zephyrTool).toBeDefined();
    expect(zephyrTool?.kind).toBe("confusable_negative");
    expect(zephyrTool?.expectedCompanyId).toBeNull();
  });

  it("labels family siblings as distinct non-matching cases", async () => {
    const { buildPerturbationCases } = await import(
      "../packages/research/src/benchmarks/entity-resolution/perturbations.js"
    );
    const cases = buildPerturbationCases(syntheticTruth(), DEFAULT_ER_SEED);
    const siblings = cases.filter((c) => c.kind === "family_sibling");
    expect(siblings.length).toBeGreaterThan(0);
    for (const s of siblings) {
      expect(s.expectedCompanyId).toBeNull();
      expect(s.family).not.toBeNull();
    }
  });

  it("every positive case carries an expected company id", async () => {
    const { buildPerturbationCases } = await import(
      "../packages/research/src/benchmarks/entity-resolution/perturbations.js"
    );
    const cases = buildPerturbationCases(syntheticTruth(), DEFAULT_ER_SEED);
    for (const c of cases) {
      if (
        c.kind === "exact_name" ||
        c.kind === "legal_suffix_variant" ||
        c.kind === "whitespace_punct_noise" ||
        c.kind === "transposed_order" ||
        c.kind === "city_append" ||
        c.kind === "state_append" ||
        c.kind === "alias_short_name" ||
        c.kind === "former_name_style"
      ) {
        expect(c.expectedCompanyId).not.toBeNull();
      }
    }
  });
});

describe("PRNG + name helpers", () => {
  it("mulberry32 is deterministic and in [0,1)", () => {
    const r1 = mulberry32(42);
    const r2 = mulberry32(42);
    for (let i = 0; i < 100; i += 1) {
      const v = r1();
      expect(v).toBe(r2());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("stripLegalSuffixes removes stacked suffixes", () => {
    expect(stripLegalSuffixes("Acme Tool & Dye, Inc.")).toBe("Acme Tool & Dye");
    expect(stripLegalSuffixes("Zephyr International LLC")).toBe("Zephyr International");
    expect(stripLegalSuffixes("Spirit AeroSystems Holdings, Inc.")).toBe(
      "Spirit AeroSystems Holdings",
    );
  });

  it("transposeNameOrder swaps two central words", () => {
    expect(transposeNameOrder("Precision Castparts")).toBe("Castparts Precision");
    expect(transposeNameOrder("Boeing")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Metric math on synthetic outcomes
// ---------------------------------------------------------------------------

function caseOf(id: string, expected: string | null, kind: ErCase["kind"] = "exact_name"): ErCase {
  return {
    caseId: id,
    kind,
    rawName: id,
    domain: null,
    expectedCompanyId: expected,
    note: "",
    family: null,
  };
}

function outcomeOf(
  id: string,
  status: ErOutcome["matchStatus"],
  confidence: number | null,
  matched: string | null,
): [string, ErOutcome] {
  return [id, { caseId: id, matchStatus: status, confidence, matchedCompanyId: matched }];
}

describe("predictsMatchAt", () => {
  it("counts exact matches regardless of threshold", () => {
    const o = outcomeOf("x", "exact", null, "c1")[1];
    expect(predictsMatchAt(o, 0.95)).toBe(true);
  });

  it("gates probable matches on confidence >= threshold", () => {
    const o = outcomeOf("x", "probable", 0.74, "c1")[1];
    expect(predictsMatchAt(o, 0.75)).toBe(false);
    expect(predictsMatchAt(o, 0.72)).toBe(true);
  });
});

describe("thresholdSweep on synthetic cases", () => {
  const cases = [
    caseOf("p1", "c1"),
    caseOf("p2", "c1"),
    caseOf("n1", null),
    caseOf("n2", null),
  ];
  const outcomes = new Map([
    outcomeOf("p1", "probable", 0.85, "c1"),
    outcomeOf("p2", "probable", 0.7, "c1"),
    outcomeOf("n1", "none", null, null),
    outcomeOf("n2", "probable", 0.8, "c-other"),
  ]);

  it("computes precision/recall monotone across thresholds", () => {
    const sweep = thresholdSweep(cases, outcomes, THRESHOLDS);
    // Thresholds ascend, so recall must be non-INCREASING across the array.
    const recalls = sweep.map((p) => p.recall ?? 0);
    for (let i = 1; i < recalls.length; i += 1) {
      expect(recalls[i]!).toBeLessThanOrEqual(recalls[i - 1]!);
    }
    // At the top threshold nothing clears it.
    const top = sweep.find((p) => p.threshold === 0.9)!;
    expect(top.tp).toBe(0);
    expect(top.precision).toBeNull();
    expect(top.recall).toBe(0);
    // At 0.85 only p1 is predicted → precision 1, recall 1/2.
    const mid = sweep.find((p) => p.threshold === 0.85)!;
    expect(mid.tp).toBe(1);
    expect(mid.fp).toBe(0);
    expect(mid.precision).toBe(1);
    expect(mid.recall).toBeCloseTo(0.5);
    // At low threshold n2 leaks in → precision drops to 2/3.
    const bottom = sweep.find((p) => p.threshold === 0.6)!;
    expect(bottom.tp).toBe(2);
    expect(bottom.fp).toBe(1);
  });

  it("reports null precision and zero recall when nothing is predicted", () => {
    const cases = [caseOf("p1", "c1")];
    const outcomes = new Map([outcomeOf("p1", "none", null, null)]);
    const sweep = thresholdSweep(cases, outcomes, [0.6]);
    expect(sweep[0]?.precision).toBeNull();
    expect(sweep[0]?.recall).toBe(0);
    expect(sweep[0]?.f1).toBeNull();
  });
});

describe("countFalseMerges", () => {
  it("flags a confusable linked to any real company", () => {
    const cases = [caseOf("conf", null, "confusable_negative"), caseOf("pos", "c1")];
    const outcomes = new Map([
      outcomeOf("conf", "probable", 0.8, "c-zephyr"),
      outcomeOf("pos", "exact", 1, "c1"),
    ]);
    const report = countFalseMerges(cases, outcomes, OPERATING_THRESHOLD);
    expect(report.wrongCompanyMerges).toBe(1);
    expect(report.detail[0]?.reason).toContain("confusable");
  });

  it("flags siblings collapsed onto one company", () => {
    const sibA: ErCase = {
      ...caseOf("sibA", null, "family_sibling"),
      family: "yulista",
    };
    const sibB: ErCase = {
      ...caseOf("sibB", null, "family_sibling"),
      family: "yulista",
    };
    const outcomes = new Map([
      outcomeOf("sibA", "probable", 0.9, "c-x"),
      outcomeOf("sibB", "probable", 0.88, "c-x"),
    ]);
    const report = countFalseMerges([sibA, sibB], outcomes, OPERATING_THRESHOLD);
    expect(report.familySiblingMerges).toBe(2);
    expect(report.detail.some((d) => d.reason.includes("siblings collapsed"))).toBe(true);
  });

  it("counts zero when negatives stay unlinked", () => {
    const cases = [caseOf("conf", null, "confusable_negative")];
    const outcomes = new Map([outcomeOf("conf", "none", null, null)]);
    const report = countFalseMerges(cases, outcomes, OPERATING_THRESHOLD);
    expect(report.wrongCompanyMerges).toBe(0);
    expect(report.familySiblingMerges).toBe(0);
  });
});

describe("aliasCapture", () => {
  it("captures alias cases that hit the right company and lists misses", () => {
    const cases = [
      caseOf("a1", "c1", "alias_short_name"),
      caseOf("a2", "c1", "former_name_style"),
    ];
    const hit = new Map([
      outcomeOf("a1", "probable", 0.8, "c1"),
      outcomeOf("a2", "none", null, null),
    ]);
    const report = aliasCapture(cases, hit, OPERATING_THRESHOLD);
    expect(report.aliasCases).toBe(2);
    expect(report.captured).toBe(1);
    expect(report.rate).toBeCloseTo(0.5);
    expect(report.misses.map((m) => m.caseId)).toEqual(["a2"]);
  });
});
