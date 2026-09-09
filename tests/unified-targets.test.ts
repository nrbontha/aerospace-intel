import { describe, expect, it } from "vitest";

import {
  UNIFIED_CSV_HEADERS,
  parseExportArgs,
} from "../scripts/export-unified-targets.mts";
import {
  higherTier,
  isOffThesisName,
  isSubsidiaryName,
  isSyntheticTargetName,
  mapCandidateTier,
  mapCuratedTier,
  mapCuratedInvestorAssessment,
  mapDiscoveryInvestorAssessment,
  mapEnsembleInvestorAssessment,
  mapEnsembleTier,
  mergeBatchDuplicates,
  normalizeUnifiedName,
  upsertBatch,
} from "../scripts/populate-unified-targets.mts";

describe("normalizeUnifiedName", () => {
  it("lowercases, trims, collapses whitespace, strips legal suffix", () => {
    expect(normalizeUnifiedName("  Acme   Corp ")).toBe("acme");
    expect(normalizeUnifiedName("Zephyr\tInternational\nLLC")).toBe(
      "zephyr international",
    );
    expect(normalizeUnifiedName("Zitec, INC")).toBe("zitec");
    expect(normalizeUnifiedName("York Precision Machining & Hydraulics")).toBe(
      "york precision machining & hydraulics",
    );
  });
});

describe("higherTier (tier-no-downgrade merge)", () => {
  it("never downgrades: reference beats everything", () => {
    expect(higherTier("reference", "high_interest")).toBe("reference");
    expect(higherTier("high_interest", "reference")).toBe("reference");
    expect(higherTier("reference", "needs_research")).toBe("reference");
  });

  it("picks the higher rank of the pair", () => {
    expect(higherTier("needs_research", "evaluate")).toBe("evaluate");
    expect(higherTier("evaluate", "needs_research")).toBe("evaluate");
    expect(higherTier("evaluate", "high_interest")).toBe("high_interest");
    expect(higherTier("needs_research", "needs_research")).toBe(
      "needs_research",
    );
  });
});

describe("tier mapping", () => {
  it("maps curated credible_target to high_interest", () => {
    expect(mapCuratedTier("credible_target")).toBe("high_interest");
    expect(mapCuratedTier("needs_more_evidence")).toBe("evaluate");
    expect(mapCuratedTier("conditional_maritime_defense")).toBe("evaluate");
  });

  it("excludes rejects everywhere", () => {
    expect(mapCuratedTier("reject")).toBeNull();
    expect(mapCuratedTier("rejected")).toBeNull();
    expect(mapCandidateTier("rejected")).toBeNull();
    expect(mapCandidateTier("archived")).toBeNull();
    expect(mapEnsembleTier("reject")).toBeNull();
  });

  it("maps candidate and ensemble tiers", () => {
    expect(mapCandidateTier("research_ready")).toBe("high_interest");
    expect(mapCandidateTier("queued_research")).toBe("needs_research");
    expect(mapCandidateTier("in_research")).toBe("evaluate");
    expect(mapEnsembleTier("high_priority")).toBe("high_interest");
    expect(mapEnsembleTier("research")).toBe("needs_research");
  });
});

describe("investor priority mapping", () => {
  it("treats kitting as process-only and prevents a P1 designation", () => {
    expect(
      mapDiscoveryInvestorAssessment(
        "research_ready",
        0.8,
        "https://example.com",
        "Custom kitting and assembly services",
      ),
    ).toEqual({
      investorPriority: 2,
      proprietaryBasis: "process_only",
    });
  });

  it("keeps a Products-menu research-ready candidate on the P1 product path", () => {
    expect(
      mapDiscoveryInvestorAssessment(
        "research_ready",
        0.8,
        "https://example.com",
        "Products catalog",
      ),
    ).toEqual({
      investorPriority: 1,
      proprietaryBasis: "product",
    });
  });
});

describe("unified export", () => {
  it("uses the contract CSV header list", () => {
    expect([...UNIFIED_CSV_HEADERS]).toEqual([
      "Company Name",
      "Domain",
      "Website",
      "City",
      "State",
      "Country",
      "Tier",
      "Priority",
      "Oversize Flag",
      "Proprietary Basis",
      "Origins",
      "Golden v1",
      "Pipeline Status",
      "Fit",
      "Novelty",
      "Confidence",
      "Actionability",
      "Ensemble Decision",
      "Ensemble Confidence",
      "Why Interesting",
      "Risks",
      "Unknowns",
      "Evidence URLs",
    ]);
  });

  it("parses CLI flags with csv defaults", () => {
    const defaults = parseExportArgs([]);
    expect(defaults.format).toBe("csv");
    expect(defaults.tier).toBeNull();
    expect(defaults.out).toMatch(/exports\/unified-targets-\d{8}\.csv$/);

    const filtered = parseExportArgs([
      "--format",
      "json",
      "--tier",
      "high_interest",
      "--out",
      "exports/custom.json",
    ]);
    expect(filtered).toMatchObject({
      format: "json",
      tier: "high_interest",
      out: "exports/custom.json",
    });
  });
});

describe("mergeBatchDuplicates", () => {
  const row = (overrides: Record<string, unknown>) => ({
    companyName: "Zitec, INC",
    domain: null,
    websiteUrl: null,
    city: null,
    stateCode: null,
    countryCode: null,
    origin: "discovery",
    goldenV1Member: false,
    tier: "needs_research",
    investorPriority: 3 as const,
    oversizeFlag: false,
    proprietaryBasis: "unknown" as const,
    pipelineStatus: null,
    fit: null,
    novelty: null,
    confidence: null,
    actionability: null,
    ensembleDecision: null,
    ensembleConfidence: null,
    whyInteresting: null,
    risks: null,
    unknowns: null,
    evidenceUrls: [],
    companyId: null,
    signalId: null,
    candidateId: null,
    ...overrides,
  });

  it("folds same-name rows keeping highest tier and first non-null scalars", () => {
    const merged = mergeBatchDuplicates([
      row({ tier: "needs_research", domain: "zitecusa.com" }),
      row({
        companyName: "ZITEC, INC ",
        tier: "high_interest",
        investorPriority: 1 as const,
        oversizeFlag: true,
        proprietaryBasis: "product" as const,
        city: "Niceville",
        evidenceUrls: ["https://example.com/a"],
      }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      tier: "high_interest",
      investorPriority: 1,
      oversizeFlag: true,
      proprietaryBasis: "product",
      domain: "zitecusa.com",
      city: "Niceville",
      evidenceUrls: ["https://example.com/a"],
    });
  });
});

describe("isSyntheticTargetName", () => {
  it("flags benchmark fixture names", () => {
    expect(isSyntheticTargetName("New Domain Foundry a534ffe2")).toBe(true);
    expect(isSyntheticTargetName("Aero Precision Machining mt5u8ng8")).toBe(
      true,
    );
    expect(isSyntheticTargetName("Shared Brand Foundry LLC")).toBe(true);
  });

  it("keeps real company names", () => {
    expect(isSyntheticTargetName("Zephyr International LLC")).toBe(false);
    expect(isSyntheticTargetName("A&B Foundry")).toBe(false);
    expect(isSyntheticTargetName("3M Company")).toBe(false);
  });
});

describe("isOffThesisName", () => {
  it("excludes mega-cap strategics regardless of suffix", () => {
    expect(isOffThesisName("ANDURIL INDUSTRIES, INC.")).toBe(true);
    expect(isOffThesisName("SKYDWELLER US INC.")).toBe(true);
  });

  it("keeps plausible small suppliers", () => {
    expect(isOffThesisName("RAM Aviation, Space & Defense")).toBe(false);
    expect(isOffThesisName("Zephyr International LLC")).toBe(false);
  });
});

describe("isSubsidiaryName", () => {
  it("flags stated subsidiaries and divisions", () => {
    expect(
      isSubsidiaryName("Turbine Kinetics Inc, Subsidiary of HEICO Corp"),
    ).toBe(true);
    expect(isSubsidiaryName("Acme, a Division of XYZ")).toBe(true);
  });

  it("keeps independent names", () => {
    expect(isSubsidiaryName("Zephyr International LLC")).toBe(false);
    expect(
      isSubsidiaryName("B/E Aerospace Inc, DBA, SMR Technologies Inc"),
    ).toBe(false);
  });
});

describe("upsertBatch chunking", () => {
  const row = (name: string) => ({
    companyName: name,
    domain: null,
    websiteUrl: null,
    city: null,
    stateCode: null,
    countryCode: null,
    origin: "faa_ensemble",
    goldenV1Member: false,
    tier: "needs_research",
    investorPriority: 3 as const,
    oversizeFlag: false,
    proprietaryBasis: "unknown" as const,
    pipelineStatus: null,
    fit: null,
    novelty: null,
    confidence: null,
    actionability: null,
    ensembleDecision: null,
    ensembleConfidence: null,
    whyInteresting: null,
    risks: null,
    unknowns: null,
    evidenceUrls: [],
    companyId: null,
    signalId: null,
    candidateId: null,
  });

  it("splits large batches so no INSERT exceeds the parameter ceiling", async () => {
    const calls: { text: string; params: unknown[] }[] = [];
    const rows = Array.from({ length: 600 }, (_, i) => row(`Chunk Co ${i}`));
    const outcome = await upsertBatch(async (text, params) => {
      calls.push({ text, params });
      return { rows: rows.slice(0, 0).map(() => ({ inserted: false })) };
    }, rows);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.params.length).toBeLessThanOrEqual(250 * 27);
    }
    expect(outcome).toEqual({ inserted: 0, merged: 0 });
  });
});
