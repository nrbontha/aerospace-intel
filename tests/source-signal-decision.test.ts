import { describe, expect, it } from "vitest";

import {
  deterministicSourceSignalDecision,
  type SourceSignalClassification,
  type SourceSignalTargetDecision,
} from "../apps/worker/src/supervisor/handlers.js";

const PAGE_URL = "https://example.test/capabilities";
const EXCERPT =
  "We manufacture flight-control components for military aircraft and aerospace programs.";
const PAGE_TEXT = `[Source URL: ${PAGE_URL}]\n${EXCERPT}`;

function verifiedManufacturer(
  overrides: Partial<SourceSignalClassification> = {},
): SourceSignalClassification {
  return {
    manufacturer: true,
    aerospaceDefenseRelevance: true,
    businessModel: "manufacturer",
    headquartersCountry: "United States",
    ownershipType: "independent",
    sizeFit: "likely_under_50m",
    proprietarySignals: ["Flight-control component manufacturing"],
    manufacturerEvidence: { excerpt: EXCERPT, url: PAGE_URL },
    aerospaceDefenseEvidence: { excerpt: EXCERPT, url: PAGE_URL },
    targetDecision: "yes_target",
    reasons: ["Model proposal fixture"],
    confidence: 0.94,
    ...overrides,
  };
}

const fixtures: ReadonlyArray<{
  name: string;
  modelProposal: SourceSignalClassification;
  expected: SourceSignalTargetDecision;
  reasons?: readonly string[];
}> = [
  {
    name: "Zephyr",
    modelProposal: verifiedManufacturer(),
    expected: "yes_target",
  },
  {
    name: "York",
    modelProposal: verifiedManufacturer({
      ownershipType: "unknown",
      sizeFit: "unknown",
      targetDecision: "yes_target",
    }),
    expected: "needs_more_research",
    reasons: ["ownership_requires_research", "size_requires_research"],
  },
  {
    name: "Zippertubing",
    modelProposal: verifiedManufacturer({
      ownershipType: "unknown",
      sizeFit: "unknown",
      targetDecision: "yes_target",
    }),
    expected: "needs_more_research",
    reasons: ["ownership_requires_research", "size_requires_research"],
  },
  {
    name: "ZOLL",
    modelProposal: verifiedManufacturer({
      manufacturer: false,
      aerospaceDefenseRelevance: false,
      businessModel: "service",
      ownershipType: "public",
      sizeFit: "likely_over_50m",
      manufacturerEvidence: null,
      aerospaceDefenseEvidence: null,
      targetDecision: "yes_target",
    }),
    expected: "no_target",
  },
  {
    name: "TLD Canada",
    modelProposal: verifiedManufacturer({
      headquartersCountry: "Canada",
      targetDecision: "yes_target",
    }),
    expected: "no_target",
    reasons: ["non_us_headquarters"],
  },
  {
    name: "Yulista",
    modelProposal: verifiedManufacturer({
      ownershipType: "strategic_parent",
      targetDecision: "yes_target",
    }),
    expected: "no_target",
    reasons: ["ineligible_ownership:strategic_parent"],
  },
];

describe("deterministic generic source-signal target policy", () => {
  it.each(fixtures)("routes $name to $expected", ({ modelProposal, expected, reasons }) => {
    const decision = deterministicSourceSignalDecision(modelProposal, PAGE_TEXT, [PAGE_URL]);
    expect(decision.targetDecision).toBe(expected);
    if (reasons !== undefined) expect(decision.reasons).toEqual(reasons);
  });

  it("rejects true claims whose excerpts or URLs are not grounded in fetched pages", () => {
    const decision = deterministicSourceSignalDecision(
      verifiedManufacturer({
        manufacturerEvidence: { excerpt: "Fabricates aerospace components", url: PAGE_URL },
        aerospaceDefenseEvidence: { excerpt: EXCERPT, url: "https://other.test/about" },
      }),
      PAGE_TEXT,
      [PAGE_URL],
    );
    expect(decision).toMatchObject({
      targetDecision: "no_target",
      reasons: [
        "manufacturer_evidence_not_page_grounded",
        "aerospace_defense_evidence_not_page_grounded",
      ],
    });
  });
});
