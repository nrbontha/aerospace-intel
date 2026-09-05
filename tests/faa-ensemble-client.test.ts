import { describe, expect, it } from "vitest";

import { compareDecisions } from "../packages/research/src/faa-ensemble/ensemble.js";

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
