import { describe, expect, it } from "vitest";

import {
  deterministicSourceSignalDecision,
  evaluateOfficialSiteAuthenticity,
  type AuthoritativeSourceEvidence,
  type IdentityPage,
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

  it("does not accept SAM registration as physical-manufacturing proof", () => {
    const samUrl = "sam://entity-information/v4/entities/ACTIVE000001?naics=336413";
    const samText =
      '"legalName": "SAM Registered Aerospace LLC", "matchedNaicsCodes": ["336413"]';
    const samEvidence: AuthoritativeSourceEvidence = {
      sourceKey: "sam_entity",
      url: samUrl,
      text: samText,
      allowedClaims: ["aerospace", "headquarters"],
      metadata: { country: "United States", uei: "ACTIVE000001" },
    };
    const decision = deterministicSourceSignalDecision(
      verifiedManufacturer({
        manufacturerEvidence: { excerpt: samText, url: samUrl },
        aerospaceDefenseEvidence: { excerpt: samText, url: samUrl },
      }),
      PAGE_TEXT,
      [PAGE_URL],
      [samEvidence],
    );
    expect(decision).toMatchObject({
      targetDecision: "no_target",
      reasons: ["manufacturer_evidence_not_page_grounded"],
    });
  });
});

describe("deterministic official-site authenticity", () => {
  const page = (finalUrl: string, text: string): IdentityPage => ({
    finalUrl,
    text,
    identityLinks: [],
  });

  it("rejects a target profile when the root identifies only HigherGov", () => {
    expect(
      evaluateOfficialSiteAuthenticity(
        {
          legalName: "A F B SYSTEMS, INC.",
          city: "Huntsville",
          state: "AL",
          uei: null,
          cage: null,
        },
        "https://directory.test/",
        [
          page(
            "https://directory.test/",
            "HigherGov government contracting intelligence, vendor profiles, and opportunity search.",
          ),
        ],
      ),
    ).toEqual({
      origin: "https://directory.test/",
      passed: false,
      method: "none",
      corroborationUrl: null,
    });
  });

  it("accepts an official origin when its root/footer identifies the legal company", () => {
    expect(
      evaluateOfficialSiteAuthenticity(
        {
          legalName: "A F B SYSTEMS, INC.",
          city: null,
          state: null,
          uei: null,
          cage: null,
        },
        "https://afbsystems.test/",
        [
          page(
            "https://afbsystems.test/",
            "Capabilities Contact © A F B Systems, Inc. All rights reserved.",
          ),
        ],
      ),
    ).toMatchObject({
      passed: true,
      method: "legal_name_token_overlap",
      corroborationUrl: "https://afbsystems.test/",
    });
  });

  it("accepts exact CAGE plus matching location across root and About evidence", () => {
    expect(
      evaluateOfficialSiteAuthenticity(
        {
          legalName: "Unrelated Legal Identity LLC",
          city: "Franklin",
          state: "OH",
          uei: null,
          cage: "1A004",
        },
        "https://manufacturer.test/",
        [
          page("https://manufacturer.test/", "Precision foundry located in Franklin, Ohio."),
          page("https://manufacturer.test/about", "Government supplier CAGE 1A004."),
        ],
      ),
    ).toMatchObject({
      passed: true,
      method: "identifier_and_location",
      corroborationUrl: "https://manufacturer.test/about",
    });
  });
});
