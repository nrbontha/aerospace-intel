import { describe, expect, it } from "vitest";

import { compareDecisions } from "../packages/research/src/faa-ensemble/ensemble.js";
import {
  adjudicatorResultSchema,
  evaluatorResultSchema,
} from "../packages/research/src/faa-ensemble/schemas.js";

describe("compareDecisions agreement", () => {
  it("accepts matching decisions without adjudication", () => {
    expect(compareDecisions("research", "research")).toMatchObject({
      agreed: true,
      adjudicationRequired: false,
      provisionalDecision: "research",
    });
    expect(compareDecisions("high_priority", "high_priority")).toMatchObject({
      agreed: true,
      adjudicationRequired: false,
      provisionalDecision: "high_priority",
    });
  });

  it("adjudicates any reject split", () => {
    expect(compareDecisions("reject", "research")).toMatchObject({
      agreed: false,
      adjudicationRequired: true,
      provisionalDecision: null,
    });
  });

  it("resolves near-agreement to research without adjudication", () => {
    expect(compareDecisions("research", "high_priority")).toMatchObject({
      agreed: false,
      adjudicationRequired: false,
      provisionalDecision: "research",
    });
  });
});

describe("investor feedback result fields", () => {
  it("defaults new evaluator and adjudicator fields for historical outputs", () => {
    const evaluator = evaluatorResultSchema.parse({
      decision: "research",
      confidence: 70,
      company_type: "manufacturer",
      aerospace_defense_relevance: "strong",
      manufacturing_evidence: "strong",
      false_negative_risk: "medium",
      reason: "Plausible supplier with incomplete evidence.",
    });
    const adjudicator = adjudicatorResultSchema.parse({
      decision: "research",
      confidence: 70,
      disagreement_type: "missing evidence",
      model_a_error: "none",
      model_b_error: "none",
      false_negative_risk: "medium",
      reason: "The company warrants more research.",
    });

    const expectedDefaults = {
      proprietary_product_evidence: "none",
      proprietary_process_only: false,
      website_products_menu: null,
      size_indicators: [],
      likely_oversize: false,
      suggested_priority: 3,
    };
    expect(evaluator).toMatchObject(expectedDefaults);
    expect(adjudicator).toMatchObject(expectedDefaults);
  });

  it("rejects an unsupported suggested priority", () => {
    expect(
      evaluatorResultSchema.safeParse({
        decision: "research",
        confidence: 70,
        company_type: "manufacturer",
        aerospace_defense_relevance: "strong",
        manufacturing_evidence: "strong",
        false_negative_risk: "medium",
        reason: "Plausible supplier with incomplete evidence.",
        suggested_priority: 4,
      }).success,
    ).toBe(false);
  });
});
