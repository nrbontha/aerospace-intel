import { describe, expect, it } from "vitest";

import {
  computeConfidence,
  computeNovelty,
  confidenceBand,
} from "./axes.js";
import {
  FEATURE_SCHEMA_VERSION,
  extractFeatureVector,
} from "./features.js";
import {
  DEFAULT_ACTIONABILITY_PROGRAM,
  DEFAULT_FIT_PROGRAM,
  SEVERE_VETO_CAP,
  evaluateProgram,
  leakageScan,
  scoringProgramSchema,
  type ScoringProgram,
} from "./dsl.js";
import {
  bootstrapCI95,
  complexityScore,
  loocvStability,
  mulberry32,
  runEvaluation,
  scanProgramLeaks,
  strongVsNegativeSeparation,
  vetoAudit,
} from "./evaluate.js";
import {
  addInteraction,
  dropComponent,
  jitterWeights,
  moveThreshold,
} from "./mutate.js";
import {
  DEFAULT_PARTNER_REVIEW_PRIORITY_WEIGHTS,
  DEFAULT_RESEARCH_PRIORITY_WEIGHTS,
  partnerReviewPriority,
  researchPriority,
  routeCandidate,
} from "./priorities.js";
import { decidePromotion } from "./promote.js";

// ---------------------------------------------------------------------------
import {
  ALL_GOLDEN_ENTRIES_V1,
  BTP_VETO_RULE,
  DISTRIBUTOR_VETO_RULE,
  GOLDEN_DATASET_V1,
  OWNERSHIP_SEVERE_VETO_RULE,
} from "./fixtures/index.js";

// helpers
// ---------------------------------------------------------------------------

function fitScore(fv: Parameters<typeof evaluateProgram>[1]) {
  return evaluateProgram(DEFAULT_FIT_PROGRAM, fv);
}

function actionabilityScore(fv: Parameters<typeof evaluateProgram>[1]) {
  return evaluateProgram(DEFAULT_ACTIONABILITY_PROGRAM, fv);
}

function entryFeatures(id: string) {
  const entry = ALL_GOLDEN_ENTRIES_V1.find((e) => e.id === id);
  if (!entry) throw new Error(`missing fixture entry ${id}`);
  return entry.features;
}

/** Minimal one-component program for isolating single veto rules. */
function singleComponentProgram(feature: string) {
  return scoringProgramSchema.parse({
    name: `isolate-${feature}`,
    version: 1,
    axis: "fit",
    missingPolicy: "zero",
    complexityPenalty: 0,
    components: [{ feature, weight: 1 }],
  });
}

// ---------------------------------------------------------------------------
// features
// ---------------------------------------------------------------------------

describe("features", () => {
  it("pins the frozen schema version", () => {
    expect(FEATURE_SCHEMA_VERSION).toBe("v1");
  });

  it("rejects unknown keys (strict)", () => {
    expect(() =>
      extractFeatureVector({ domain: "x.com", pipeline_priority: 3 }),
    ).toThrow();
  });

  it("rejects an invalid enum value loudly", () => {
    expect(() =>
      extractFeatureVector({ domain: "x.com", ownership_type: "royal" }),
    ).toThrow(/ownership_type/);
  });

  it("maps missing facts to explicit 'unknown', never a guessed default", () => {
    const fv = extractFeatureVector({ domain: "x.com" });
    expect(fv.ownership.ownershipType).toBe("unknown");
    expect(fv.size.revenueBand).toBe("unknown");
    expect(fv.businessModel.distributesProducts).toBe("unknown");
    expect(fv.aftermarket).toBe("unknown");
    expect(fv.qualifications.pma).toBe("unknown");
    expect(fv.evidence.freshestObservationDaysOld).toBeNull();
  });

  it("coerces string booleans and integer strings", () => {
    const fv = extractFeatureVector({
      aftermarket: "true",
      source_count: "4",
      distributes_products: "false",
    });
    expect(fv.aftermarket).toBe(true);
    expect(fv.evidence.sourceCount).toBe(4);
    expect(fv.businessModel.distributesProducts).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dsl — vetoes
// ---------------------------------------------------------------------------

describe("dsl · severe vetoes", () => {
  it("caps sponsor/strategic/public ownership at 25 on actionability", () => {
    for (const owner of ["pe_owned", "strategic_sub", "public_sub"] as const) {
      const fv = {
        ...entryFeatures("adpma"),
        ownership: { ownershipType: owner },
      };
      const result = actionabilityScore(fv);
      expect(result.score).not.toBeNull();
      expect(result.score).toBeLessThanOrEqual(SEVERE_VETO_CAP);
      expect(result.veto?.rule).toBe(OWNERSHIP_SEVERE_VETO_RULE);
    }
  });

  it("severe caps are un-scoreable-around regardless of adversarial weights", () => {
    // A program that ignores ownership entirely and rewards aftermarket only:
    // the post-aggregation cap must still hold.
    const adversarial = scoringProgramSchema.parse({
      name: "adversarial-actionability",
      version: 1,
      axis: "actionability",
      missingPolicy: "zero",
      complexityPenalty: 0,
      hardVetoes: [
        {
          feature: "ownership.ownershipType",
          operator: "in",
          value: ["pe_owned", "strategic_sub", "public_sub"],
          severity: "severe",
        },
      ],
      components: [{ feature: "aftermarket", weight: 1 }],
    });
    const result = evaluateProgram(adversarial, entryFeatures("rosen-aviation"));
    expect(result.score).toBe(SEVERE_VETO_CAP);
  });

  it("nulls actionability when ownership is unknown (never invents a number)", () => {
    const result = actionabilityScore({
      ...entryFeatures("adpma"),
      ownership: { ownershipType: "unknown" },
    });
    expect(result.score).toBeNull();
    expect(result.veto?.rule).toBe("required_feature_missing");
  });
});

describe("dsl · hard vetoes", () => {
  it("fires the distributor veto without contradictory evidence", () => {
    const result = fitScore(entryFeatures("pure-distributor-negative"));
    expect(result.score).toBeNull();
    expect(result.veto?.rule).toBe(DISTRIBUTOR_VETO_RULE);
  });

  it("suppresses the distributor veto when proprietary evidence contradicts it", () => {
    const contradictory = {
      ...entryFeatures("pure-distributor-negative"),
      businessModel: {
        ...entryFeatures("pure-distributor-negative").businessModel,
        proprietaryProductEvidence: "patented" as const,
      },
      size: { ...entryFeatures("pure-distributor-negative").size },
    };
    // neutralize the revenue veto so ONLY the distributor clause is under test
    const withRevenue = {
      ...contradictory,
      size: { ...contradictory.size, revenueBand: "10-20m" as const },
    };
    expect(fitScore(withRevenue).veto?.rule).toBeUndefined();
  });

  it("fires the pure build-to-print veto", () => {
    const result = fitScore(entryFeatures("pure-btp-shop-negative"));
    expect(result.score).toBeNull();
    expect(result.veto?.rule).toBe(BTP_VETO_RULE);
  });

  it("does not fire the BTP veto for minor share", () => {
    const mcneil = entryFeatures("mcneil-industries"); // btp minor
    expect(fitScore(mcneil).veto?.rule).toBeUndefined();
  });

  it("an unknown revenue band can never satisfy the '<$50m' hard requirement", () => {
    const program = singleComponentProgram("size.revenueBand");
    const vetoed = {
      feature: "size.revenueBand",
      operator: "gt" as const,
      value: "20-35m",
      severity: "hard" as const,
    };
    const prog = scoringProgramSchema.parse({
      name: "revenue-requirement",
      version: 1,
      axis: "fit",
      missingPolicy: "zero",
      complexityPenalty: 0,
      hardVetoes: [vetoed],
      components: [{ feature: "aftermarket", weight: 1 }],
    });
    void program;
    // known-too-big band fails
    expect(
      evaluateProgram(prog, {
        ...entryFeatures("mcneil-industries"),
        size: { ...entryFeatures("mcneil-industries").size, revenueBand: "35-50m" },
      }).veto?.rule,
    ).toBe("size.revenueBand:gt");
    // UNKNOWN band also fails the bound (ranks above every known band)
    expect(
      evaluateProgram(prog, {
        ...entryFeatures("mcneil-industries"),
        size: { ...entryFeatures("mcneil-industries").size, revenueBand: "unknown" },
      }).veto?.rule,
    ).toBe("size.revenueBand:gt");
    // comfortably-small band passes
    expect(
      evaluateProgram(prog, {
        ...entryFeatures("mcneil-industries"),
        size: { ...entryFeatures("mcneil-industries").size, revenueBand: "10-20m" },
      }).veto?.rule,
    ).toBeUndefined();
  });

  it("vetoes never fire on 'unknown' trileans under equals/in", () => {
    const fv = {
      ...entryFeatures("mcneil-industries"),
      businessModel: {
        ...entryFeatures("mcneil-industries").businessModel,
        distributesProducts: "unknown" as const,
      },
    };
    expect(fitScore(fv).veto?.rule).toBeUndefined();
  });

  it("evidenceRequirement nulls the score below the floor", () => {
    const prog = scoringProgramSchema.parse({
      name: "evidence-floored",
      version: 1,
      axis: "fit",
      missingPolicy: "zero",
      complexityPenalty: 0,
      evidenceRequirement: { minPrimarySources: 2, minSources: 4 },
      components: [{ feature: "aftermarket", weight: 1 }],
    });
    const weak = evaluateProgram(prog, entryFeatures("pure-distributor-negative"));
    expect(weak.score).toBeNull();
    expect(weak.veto?.rule).toBe("evidence_requirement");
  });

  it("identity strings are NOT valid scoring features", () => {
    const leaked = scoringProgramSchema.parse({
      name: "domain-leak",
      version: 1,
      axis: "fit",
      missingPolicy: "zero",
      complexityPenalty: 0,
      components: [{ feature: "identity.domain", weight: 1 }],
    });
    expect(leakageScan(leaked).clean).toBe(false);
    expect(() => evaluateProgram(leaked, entryFeatures("adpma"))).toThrow(
      /non-feature fields/,
    );
  });
});

describe("dsl · aggregation", () => {
  it("validates component+interaction weights sum to 1 ± 0.01 at parse time", () => {
    expect(() =>
      scoringProgramSchema.parse({
        name: "bad-weights",
        version: 1,
        axis: "fit",
        missingPolicy: "zero",
        complexityPenalty: 0,
        components: [
          { feature: "aftermarket", weight: 0.7 },
          { feature: "platforms", weight: 0.2 },
        ],
      }),
    ).toThrow(/sum to 1/);
  });

  it("three missingPolicy behaviors observably differ", () => {
    // armstrong carries several unknown qualifications → policy-sensitive.
    const fv = entryFeatures("armstrong-mfg");
    const mk = (policy: "zero" | "exclude_renormalize" | "floor_0.5") =>
      scoringProgramSchema.parse({
        ...DEFAULT_FIT_PROGRAM,
        name: `fit-${policy}`,
        missingPolicy: policy,
      });
    const zero = evaluateProgram(mk("zero"), fv).score;
    const renorm = evaluateProgram(mk("exclude_renormalize"), fv).score;
    const floored = evaluateProgram(mk("floor_0.5"), fv).score;
    // renormalization drops unknowns entirely → strictly higher than zeroing them
    expect(renorm).toBeGreaterThan(zero as number);
    // flooring unknowns at 0.5 sits between zeroing and dropping them here
    expect(floored).toBeGreaterThan(zero as number);
    expect(floored).toBeLessThan(renorm as number);
    // and every policy reports what it did with the missing facts
    const evalRenorm = evaluateProgram(mk("exclude_renormalize"), fv);
    expect(
      evalRenorm.missingHandled.some((m) => m.handling === "excluded_renormalized"),
    ).toBe(true);
  });

  it("is deterministic: identical inputs give byte-identical output", () => {
    const fv = entryFeatures("skybolt");
    const a = JSON.stringify(evaluateProgram(DEFAULT_FIT_PROGRAM, fv));
    const b = JSON.stringify(evaluateProgram(DEFAULT_FIT_PROGRAM, fv));
    expect(a).toBe(b);
    const c = JSON.stringify(evaluateProgram(DEFAULT_ACTIONABILITY_PROGRAM, fv));
    const d = JSON.stringify(evaluateProgram(DEFAULT_ACTIONABILITY_PROGRAM, fv));
    expect(c).toBe(d);
  });

  it("supports interactions multiplicatively", () => {
    const mk = (
      interactions: ScoringProgram["interactions"],
      weightA: number,
      weightB: number,
    ) =>
      scoringProgramSchema.parse({
        name: interactions.length > 0 ? "coupled" : "additive",
        version: 1,
        axis: "fit",
        missingPolicy: "zero",
        complexityPenalty: 0,
        components: [
          { feature: "businessModel.proprietary_product_evidence", weight: weightA },
          { feature: "aftermarket", weight: weightB },
        ],
        interactions,
      });
    const coupled = mk(
      [
        {
          features: [
            "businessModel.proprietary_product_evidence",
            "aftermarket",
          ],
          weight: 0.2,
        },
      ],
      0.4,
      0.4,
    );
    // romco-like vector: proprietary claimed (0.55) × aftermarket false (0.3)
    const midFv = {
      ...entryFeatures("romco-manufacturing"),
      businessModel: {
        ...entryFeatures("romco-manufacturing").businessModel,
        proprietaryProductEvidence: "claimed" as const,
      },
    };
    const additiveMid = evaluateProgram(mk([], 0.5, 0.5), midFv).score as number;
    const coupledMid = evaluateProgram(coupled, midFv).score as number;
    // additive:  .5·.55 + .5·.30              = 0.425  → 42.5
    // coupled:   .4·.55 + .4·.30 + .2·(.55·.30) = 0.373  → 37.3 — the joint
    // product term only pays when BOTH strengths co-occur, so mid-strength
    // pairs score lower than under a purely additive program of the same mass.
    expect(additiveMid).toBeCloseTo(42.5, 6);
    expect(coupledMid).toBeCloseTo(37.3, 6);
  });
});

// ---------------------------------------------------------------------------
// axes
// ---------------------------------------------------------------------------

describe("axes · novelty", () => {
  const fv = entryFeatures("adpma");
  it("maps match statuses to the four documented states", () => {
    expect(computeNovelty(fv, { matchStatusesBySnapshot: [] })).toEqual({
      status: "unable_to_assess",
      score: null,
    });
    expect(computeNovelty(fv, { matchStatusesBySnapshot: ["exact"] }).status).toBe(
      "confirmed_known_company",
    );
    expect(
      computeNovelty(fv, { matchStatusesBySnapshot: ["none", "probable"] }).status,
    ).toBe("possible_known_universe_match");
    expect(computeNovelty(fv, { matchStatusesBySnapshot: ["none"] })).toEqual({
      status: "not_matched_to_current_known_universe",
      score: 100,
    });
    expect(
      computeNovelty(fv, { matchStatusesBySnapshot: ["unresolved"] }).score,
    ).toBeNull();
  });

  it("orders novelty scores confirmed < possible < not_matched", () => {
    const confirmed = computeNovelty(fv, { matchStatusesBySnapshot: ["exact"] })
      .score as number;
    const possible = computeNovelty(fv, {
      matchStatusesBySnapshot: ["possible"],
    }).score as number;
    const fresh = computeNovelty(fv, { matchStatusesBySnapshot: ["none"] })
      .score as number;
    expect(confirmed).toBeLessThan(possible);
    expect(possible).toBeLessThan(fresh);
  });
});

describe("axes · confidence", () => {
  it("grows with sources and primary sources", () => {
    const weak = computeConfidence({
      sourceCount: 1,
      primarySourceCount: 0,
      conflictCount: 0,
      freshestObservationDaysOld: 10,
      identityResolved: true,
    });
    const stronger = computeConfidence({
      sourceCount: 5,
      primarySourceCount: 2,
      conflictCount: 0,
      freshestObservationDaysOld: 10,
      identityResolved: true,
    });
    expect(stronger).toBeGreaterThan(weak);
  });

  it("penalizes conflicts, staleness, unknown recency, unresolved identity", () => {
    const clean = computeConfidence({
      sourceCount: 4,
      primarySourceCount: 2,
      conflictCount: 0,
      freshestObservationDaysOld: 30,
      identityResolved: true,
    });
    expect(
      computeConfidence({
        sourceCount: 4,
        primarySourceCount: 2,
        conflictCount: 3,
        freshestObservationDaysOld: 30,
        identityResolved: true,
      }),
    ).toBeLessThan(clean);
    expect(
      computeConfidence({
        sourceCount: 4,
        primarySourceCount: 2,
        conflictCount: 0,
        freshestObservationDaysOld: 2000,
        identityResolved: true,
      }),
    ).toBeLessThan(clean);
    expect(
      computeConfidence({
        sourceCount: 4,
        primarySourceCount: 2,
        conflictCount: 0,
        freshestObservationDaysOld: null,
        identityResolved: true,
      }),
    ).toBeLessThan(clean);
    expect(
      computeConfidence({
        sourceCount: 4,
        primarySourceCount: 2,
        conflictCount: 0,
        freshestObservationDaysOld: 30,
        identityResolved: false,
      }),
    ).toBeLessThan(clean);
  });

  it("clamps to [0,100] and exposes documented bands", () => {
    const zeroish = computeConfidence({
      sourceCount: 0,
      primarySourceCount: 0,
      conflictCount: 9,
      freshestObservationDaysOld: null,
      identityResolved: false,
    });
    expect(zeroish).toBe(0);
    expect(confidenceBand(zeroish)).toBe("very_low");
    expect(confidenceBand(50)).toBe("moderate");
    expect(confidenceBand(90)).toBe("very_high");
  });
});

// ---------------------------------------------------------------------------
// priorities + routing
// ---------------------------------------------------------------------------

describe("priorities", () => {
  it("default weight sets parse and sum to 1", () => {
    const r = DEFAULT_RESEARCH_PRIORITY_WEIGHTS;
    expect(
      r.expectedFit +
        r.expectedNovelty +
        r.uncertainty +
        r.informationGain +
        r.sourceDiversity,
    ).toBeCloseTo(1, 2);
    const p = DEFAULT_PARTNER_REVIEW_PRIORITY_WEIGHTS;
    expect(
      p.fit + p.novelty + p.actionability + p.confidence + p.archetypeDiversity,
    ).toBeCloseTo(1, 2);
  });

  it("researchPriority is deterministic, configurable, and cost reduces", () => {
    const input = {
      expectedFit: 0.8,
      expectedNovelty: 0.9,
      uncertainty: 0.6,
      informationGain: 0.7,
      sourceDiversity: 0.5,
      cost: 0.5,
    };
    expect(researchPriority(input)).toBe(researchPriority(input));
    expect(researchPriority(input, undefined, 0.9)).toBeLessThan(
      researchPriority(input),
    );
    // informationGain dominates uncertainty by design (0.35 vs 0.25)
    expect(
      researchPriority({ ...input, informationGain: 0, uncertainty: 0.35 }),
    ).toBeLessThan(
      researchPriority({ ...input, informationGain: 0.35, uncertainty: 0 }),
    );
    // invalid weight objects are refused
    expect(() =>
      researchPriority(input, {
        expectedFit: 0.5,
        expectedNovelty: 0.5,
        uncertainty: 0.5,
        informationGain: 0.5,
        sourceDiversity: 0.5,
      }),
    ).toThrow(/sum to 1/);
  });

  it("partnerReviewPriority weights actionability above fit", () => {
    const base = {
      fit: 0,
      novelty: 0,
      actionability: 0,
      confidence: 0,
      archetypeDiversity: 0,
    };
    expect(partnerReviewPriority({ ...base, actionability: 1 })).toBeGreaterThan(
      partnerReviewPriority({ ...base, fit: 1 }),
    );
  });
});

describe("routeCandidate", () => {
  const thresholds = { highFit: 70, lowConfidence: 50, unactionableMax: 25 };

  it("high fit + high actionability + confident + novel → partner", () => {
    const decision = routeCandidate(
      {
        fit: fitScore(entryFeatures("adpma")).score as number,
        noveltyStatus: "not_matched_to_current_known_universe",
        confidence: computeConfidence(entryFeatures("adpma").evidence),
        actionability: actionabilityScore(entryFeatures("adpma")).score as number,
      },
      thresholds,
    );
    expect(decision.queue).toBe("partner");
  });

  it("high fit + low confidence → research, never partner", () => {
    const degradedEvidence = {
      ...entryFeatures("skybolt"),
      evidence: {
        sourceCount: 1,
        primarySourceCount: 0,
        conflictCount: 1,
        freshestObservationDaysOld: null,
        identityResolved: false,
      },
    };
    const fit = fitScore(degradedEvidence).score as number;
    expect(fit).toBeGreaterThanOrEqual(70);
    const confidence = computeConfidence(degradedEvidence.evidence);
    expect(confidence).toBeLessThan(50);
    const decision = routeCandidate(
      {
        fit,
        noveltyStatus: "not_matched_to_current_known_universe",
        confidence,
        actionability: 60,
      },
      thresholds,
    );
    expect(decision.queue).toBe("research");
    expect(decision.reasons).toContain("low_confidence_requires_research");
  });

  it("high fit + unactionable (capped public subsidiary) → watchlist", () => {
    const highFitPublicSub = extractFeatureVector({
      domain: "ideal-public-sub.example",
      revenue_band: "10-20m",
      ownership_type: "public_sub",
      build_to_print_share: "none",
      proprietary_product_evidence: "patented",
      qualifications: {
        pma: "present",
        as9100: "present",
        nadcap: "present",
        qpl: "present",
        oem_approved: "present",
      },
      aftermarket: true,
      platforms: ["p1", "p2", "p3", "p4"],
      source_count: 6,
      primary_source_count: 3,
      conflict_count: 0,
      freshest_observation_days_old: 30,
      identity_resolved: true,
    });
    const fit = fitScore(highFitPublicSub).score as number;
    expect(fit).toBeGreaterThanOrEqual(70);
    const actionability = actionabilityScore(highFitPublicSub);
    expect(actionability.score).toBeLessThanOrEqual(SEVERE_VETO_CAP);
    const decision = routeCandidate(
      {
        fit,
        noveltyStatus: "not_matched_to_current_known_universe",
        confidence: 80,
        actionability: actionability.score,
      },
      thresholds,
    );
    expect(decision.queue).toBe("watchlist");
  });

  it("null actionability at high fit goes to watchlist, not partner", () => {
    const decision = routeCandidate(
      {
        fit: 90,
        noveltyStatus: "not_matched_to_current_known_universe",
        confidence: 80,
        actionability: null,
      },
      thresholds,
    );
    expect(decision.queue).toBe("watchlist");
  });

  it("un-scoreable fit and below-threshold fit go to research", () => {
    expect(routeCandidate({ fit: null, noveltyStatus: "unable_to_assess", confidence: 90, actionability: 90 }, thresholds).queue).toBe("research");
    expect(routeCandidate({ fit: 40, noveltyStatus: "not_matched_to_current_known_universe", confidence: 90, actionability: 90 }, thresholds).queue).toBe("research");
  });
});

// ---------------------------------------------------------------------------
// evaluation harness
// ---------------------------------------------------------------------------

describe("evaluation harness over the frozen v1 dataset", () => {
  it("separates strong positives from negative controls", () => {
    const sep = strongVsNegativeSeparation(DEFAULT_FIT_PROGRAM, GOLDEN_DATASET_V1);
    expect(sep.separation).toBeGreaterThan(40);
    expect(sep.strongMean as number).toBeGreaterThan(60);
    expect(sep.negativeMean as number).toBe(0); // negatives hard-vetoed → 0
    expect(sep.strongCount).toBe(7);
    expect(sep.negativeCount).toBe(2);
  });

  it("passes the veto audit against every expected veto fixture", () => {
    const audit = vetoAudit(
      { fit: DEFAULT_FIT_PROGRAM, actionability: DEFAULT_ACTIONABILITY_PROGRAM },
      GOLDEN_DATASET_V1,
    );
    expect(audit.checked).toBeGreaterThanOrEqual(8);
    expect(audit.passed).toBe(true);
    expect(audit.failures).toEqual([]);
  });

  it("bootstrapCI95 is seeded and reproducible", () => {
    const a = bootstrapCI95(DEFAULT_FIT_PROGRAM, GOLDEN_DATASET_V1, { seed: 42 });
    const b = bootstrapCI95(DEFAULT_FIT_PROGRAM, GOLDEN_DATASET_V1, { seed: 42 });
    const c = bootstrapCI95(DEFAULT_FIT_PROGRAM, GOLDEN_DATASET_V1, { seed: 7 });
    expect(a).toEqual(b);
    expect(a.low).toBeLessThan(a.high);
    expect(a.seed).toBe(42);
    expect(c.seed).toBe(7);
  });

  it("mulberry32 streams are seed-stable", () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
    expect(new Set(seqA).size).toBe(3);
  });

  it("loocv rank stability stays tight and runs fast", () => {
    const start = Date.now();
    const stability = loocvStability(DEFAULT_FIT_PROGRAM, GOLDEN_DATASET_V1);
    const elapsed = Date.now() - start;
    expect(stability.folds).toBe(GOLDEN_DATASET_V1.entries.length);
    expect(stability.maxDisplacement).toBeLessThanOrEqual(3);
    void elapsed; // covered by the combined timing assertion below
  });

  it("loocv + bootstrap together finish well under 2s", () => {
    const start = Date.now();
    loocvStability(DEFAULT_FIT_PROGRAM, GOLDEN_DATASET_V1);
    bootstrapCI95(DEFAULT_FIT_PROGRAM, GOLDEN_DATASET_V1, { samples: 400 });
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("complexityScore counts components, double-counts interactions, adds penalty", () => {
    const simple = singleComponentProgram("aftermarket");
    expect(complexityScore(simple)).toBe(1);
    expect(complexityScore(DEFAULT_FIT_PROGRAM)).toBe(
      DEFAULT_FIT_PROGRAM.components.length +
        DEFAULT_FIT_PROGRAM.hardVetoes.length +
        DEFAULT_FIT_PROGRAM.complexityPenalty,
    );
  });

  it("runEvaluation ranks programs by the configured primary metric", () => {
    const challengerNoPlatforms = (() => {
      const kept = DEFAULT_FIT_PROGRAM.components.filter(
        (c) => c.feature !== "platforms",
      );
      const sum = kept.reduce((acc, c) => acc + c.weight, 0);
      return scoringProgramSchema.parse({
        ...DEFAULT_FIT_PROGRAM,
        name: "challenger-no-platforms",
        components: kept.map((c) => ({ ...c, weight: c.weight / sum })),
      });
    })();
    const run = runEvaluation(
      [
        { name: DEFAULT_FIT_PROGRAM.name as string, program: DEFAULT_FIT_PROGRAM },
        { name: "challenger-no-platforms", program: challengerNoPlatforms },
      ],
      GOLDEN_DATASET_V1,
      { bootstrapSamples: 100 },
    );
    expect(run.results).toHaveLength(2);
    expect(run.results[0]?.name).toBe("challenger-no-platforms");
    expect(run.results[0]?.strongVsNegativeSeparation).toBeGreaterThan(
      run.results[1]?.strongVsNegativeSeparation as number,
    );
    // alternate primary metric flips the penalty term into the ranking
    const altRun = runEvaluation(
      [
        { name: DEFAULT_FIT_PROGRAM.name as string, program: DEFAULT_FIT_PROGRAM },
        { name: "challenger-no-platforms", program: challengerNoPlatforms },
      ],
      GOLDEN_DATASET_V1,
      {
        primaryMetric: "separationMinusComplexityPenalty",
        bootstrapSamples: 100,
      },
    );
    expect(altRun.primaryMetric).toBe("separationMinusComplexityPenalty");
  });

  it("leakageScan flags pipeline state and identity references", () => {
    const leaked = scoringProgramSchema.parse({
      name: "leaky",
      version: 1,
      axis: "fit",
      missingPolicy: "zero",
      complexityPenalty: 0,
      components: [{ feature: "pipeline_priority", weight: 0.5 }, { feature: "aftermarket", weight: 0.5 }],
    });
    const scan = scanProgramLeaks(leaked);
    expect(scan.clean).toBe(false);
    expect(scan.leaked).toContain("pipeline_priority");
    expect(scanProgramLeaks(DEFAULT_FIT_PROGRAM).clean).toBe(true);
    expect(scanProgramLeaks(DEFAULT_ACTIONABILITY_PROGRAM).clean).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// promotion
// ---------------------------------------------------------------------------

describe("decidePromotion", () => {
  const championName = DEFAULT_FIT_PROGRAM.name as string;
  const challengerNoPlatforms = (() => {
    const kept = DEFAULT_FIT_PROGRAM.components.filter(
      (c) => c.feature !== "platforms",
    );
    const sum = kept.reduce((acc, c) => acc + c.weight, 0);
    return scoringProgramSchema.parse({
      ...DEFAULT_FIT_PROGRAM,
      name: "challenger-no-platforms",
      components: kept.map((c) => ({ ...c, weight: c.weight / sum })),
    });
  })();

  it("promotes a challenger whose metric gain clears epsilon cleanly", () => {
    const run = runEvaluation(
      [
        { name: championName, program: DEFAULT_FIT_PROGRAM },
        { name: "challenger-no-platforms", program: challengerNoPlatforms },
      ],
      GOLDEN_DATASET_V1,
      { bootstrapSamples: 50 },
    );
    const decision = decidePromotion(
      DEFAULT_FIT_PROGRAM,
      challengerNoPlatforms,
      run,
      { epsilon: 0.02 },
    );
    expect(decision.decision).toBe("promote");
  });

  it("rejects a challenger that does not beat epsilon", () => {
    const twin = scoringProgramSchema.parse({
      ...DEFAULT_FIT_PROGRAM,
      name: "twin-of-champion",
    });
    const run = runEvaluation(
      [
        { name: championName, program: DEFAULT_FIT_PROGRAM },
        { name: "twin-of-champion", program: twin },
      ],
      GOLDEN_DATASET_V1,
      { bootstrapSamples: 50 },
    );
    const decision = decidePromotion(DEFAULT_FIT_PROGRAM, twin, run, {
      epsilon: 0.02,
    });
    expect(decision.decision).toBe("reject");
    expect(decision.reasons.join(";")).toContain("not_beyond_epsilon");
  });

  it("rejects added complexity that does not pay rent (>+2 components, small gain)", () => {
    const scaled = DEFAULT_FIT_PROGRAM.components.map((c) => ({
      ...c,
      weight: c.weight * 0.999,
    }));
    const bloated = scoringProgramSchema.parse({
      ...DEFAULT_FIT_PROGRAM,
      name: "bloated-challenger",
      components: [
        ...scaled,
        { feature: "evidence.conflictCount", weight: 0.0004 },
        { feature: "size.employeesBand", weight: 0.0003 },
        { feature: "qualifications.itar_signal", weight: 0.0003 },
      ],
    });
    expect(bloated.components.length).toBe(
      DEFAULT_FIT_PROGRAM.components.length + 3,
    );
    const run = runEvaluation(
      [
        { name: championName, program: DEFAULT_FIT_PROGRAM },
        { name: "bloated-challenger", program: bloated },
      ],
      GOLDEN_DATASET_V1,
      { bootstrapSamples: 50 },
    );
    const decision = decidePromotion(DEFAULT_FIT_PROGRAM, bloated, run, {
      epsilon: 0.0001, // gain passes epsilon easily…
      // …but must exceed 0.05 to justify +3 components
    });
    expect(decision.decision).toBe("reject");
    expect(decision.reasons.join(";")).toContain("component_delta_3_exceeds_2");
  });

  it("rejects challengers leaking non-feature fields", () => {
    const scaled = DEFAULT_FIT_PROGRAM.components.map((c) => ({
      ...c,
      weight: c.weight * 0.5,
    }));
    const leaky = scoringProgramSchema.parse({
      ...DEFAULT_FIT_PROGRAM,
      name: "leaky-challenger",
      components: [
        { feature: "pipeline_priority", weight: 0.5 },
        ...scaled,
      ],
    });
    const run = runEvaluation(
      [{ name: championName, program: DEFAULT_FIT_PROGRAM }],
      GOLDEN_DATASET_V1,
      { bootstrapSamples: 50 },
    );
    const decision = decidePromotion(DEFAULT_FIT_PROGRAM, leaky, run, {
      epsilon: 0.01,
    });
    expect(decision.decision).toBe("reject");
    expect(decision.reasons.join(";")).toContain("leaked_fields:pipeline_priority");
  });
});

// ---------------------------------------------------------------------------
// mutation operators
// ---------------------------------------------------------------------------

describe("mutation operators (LLM-free challenger generation)", () => {
  it("are deterministic given the seed and vary across seeds", () => {
    expect(JSON.stringify(jitterWeights(DEFAULT_FIT_PROGRAM, 1))).toBe(
      JSON.stringify(jitterWeights(DEFAULT_FIT_PROGRAM, 1)),
    );
    const seedsDiffer = new Set(
      [1, 2, 3, 4, 5].map((s) =>
        JSON.stringify(jitterWeights(DEFAULT_FIT_PROGRAM, s)),
      ),
    );
    expect(seedsDiffer.size).toBeGreaterThan(1);
  });

  it("dropComponent removes exactly one component and keeps the schema valid", () => {
    const mutated = dropComponent(DEFAULT_FIT_PROGRAM, 11);
    expect(mutated.components.length).toBe(DEFAULT_FIT_PROGRAM.components.length - 1);
    expect(() => scoringProgramSchema.parse(mutated)).not.toThrow();
    expect(mutated.components.reduce((a, c) => a + c.weight, 0)).toBeCloseTo(1, 2);
  });

  it("addInteraction adds one coupling and keeps the schema valid", () => {
    const before = DEFAULT_FIT_PROGRAM.interactions.length;
    const mutated = addInteraction(DEFAULT_FIT_PROGRAM, 3);
    expect(mutated.interactions.length).toBe(before + 1);
    expect(() => scoringProgramSchema.parse(mutated)).not.toThrow();
  });

  it("moveThreshold nudges complexityPenalty within bounds", () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const mutated = moveThreshold(DEFAULT_FIT_PROGRAM, seed);
      expect(mutated.complexityPenalty).toBeGreaterThanOrEqual(0);
      expect(Math.abs(mutated.complexityPenalty - DEFAULT_FIT_PROGRAM.complexityPenalty))
        .toBeLessThanOrEqual(0.05 + 1e-9);
    }
  });

  it("jittered challengers stay schema-valid with normalized weights", () => {
    for (const seed of [10, 20, 30]) {
      const mutated = jitterWeights(DEFAULT_FIT_PROGRAM, seed);
      expect(mutated.components.reduce((a, c) => a + c.weight, 0)).toBeCloseTo(1, 2);
    }
  });
});
