import { describe, expect, it } from "vitest";

import {
  UNIFIED_CSV_HEADERS,
  parseExportArgs,
} from "../scripts/export-unified-targets.mts";
import {
  ROUND2_ACQUIRED_MAP,
  deriveRound2Verdict,
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
  mergeOwnershipStatus,
  mergePipelineDecision,
  normalizeUnifiedName,
  upsertBatch,
} from "../scripts/populate-unified-targets.mts";
import { ENSEMBLE_PROMOTION_CAMPAIGN_ID } from "../packages/database/src/unified-targets/promote.js";

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
      "Ownership Status",
      "Pipeline Decision",
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
      expect(call.params.length).toBeLessThanOrEqual(250 * 29);
    }
    expect(outcome).toEqual({ inserted: 0, merged: 0 });
  });
});

describe("ensemble promotion campaign", () => {
  it("uses a valid UUID campaign id (invalid ids fail at the database)", () => {
    expect(ENSEMBLE_PROMOTION_CAMPAIGN_ID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe("round-2 investor verdicts", () => {
  it("keeps the 19-entry acquired-owner map intact", () => {
    expect(ROUND2_ACQUIRED_MAP).toHaveLength(19);
  });

  it("maps strategic acquisitions to pass_acquired/strategic_owned", () => {
    expect(deriveRound2Verdict("Dart Aerospace")).toMatchObject({
      ownershipStatus: "strategic_owned",
      pipelineDecision: "pass_acquired",
      owner: "TransDigm",
    });
    expect(
      deriveRound2Verdict("Jet Parts Engineering, Inc. (JPE)"),
    ).toMatchObject({
      ownershipStatus: "strategic_owned",
      pipelineDecision: "pass_acquired",
    });
    expect(
      deriveRound2Verdict("Kirkhill Aircraft Parts Company").ownershipStatus,
    ).toBe("strategic_owned");
    expect(
      deriveRound2Verdict("Turbine Kinetics Inc, Subsidiary of HEICO Corp"),
    ).toMatchObject({
      ownershipStatus: "strategic_owned",
      pipelineDecision: "pass_acquired",
    });
    expect(deriveRound2Verdict("Robertson Fuel Systems LLC")).toMatchObject({
      ownershipStatus: "strategic_owned",
      pipelineDecision: "pass_acquired",
    });
  });

  it("maps PE acquisitions to pe_owned and public companies to public", () => {
    expect(deriveRound2Verdict("Raisbeck Engineering Inc")).toMatchObject({
      ownershipStatus: "pe_owned",
      pipelineDecision: "pass_acquired",
    });
    expect(deriveRound2Verdict("Shadin Avionics").ownershipStatus).toBe(
      "pe_owned",
    );
    expect(
      deriveRound2Verdict(
        "Sirius Technologies, Inc., DBA Flight Display System",
      ),
    ).toMatchObject({
      ownershipStatus: "pe_owned",
      pipelineDecision: "pass_acquired",
      owner: "Vance Street Partners",
    });
    expect(deriveRound2Verdict("VisionSafe Corporation")).toMatchObject({
      ownershipStatus: "pe_owned",
      pipelineDecision: "pass_acquired",
    });
    expect(deriveRound2Verdict("Butler National Corporation")).toMatchObject({
      ownershipStatus: "public",
      pipelineDecision: "pass_acquired",
    });
  });

  it("maps Maybe verdicts to hold and the sole add to add", () => {
    for (const name of [
      "Alpha Aviation, Inc",
      "Composite Specialties",
      "Concorde Battery Corp",
      "Middle Fork Mods, LLC.",
      "M-20 Oil Separators LLC",
    ]) {
      expect(deriveRound2Verdict(name).pipelineDecision).toBe("hold");
    }
    expect(deriveRound2Verdict("Electronics International Inc")).toMatchObject({
      ownershipStatus: "independent",
      pipelineDecision: "add",
    });
  });

  it("maps dead and wrong-sector verdicts", () => {
    expect(deriveRound2Verdict("Keddeg Company")).toMatchObject({
      ownershipStatus: "dead",
      pipelineDecision: "pass_dead",
    });
    expect(
      deriveRound2Verdict("Whelen Engineering Co Inc").pipelineDecision,
    ).toBe("pass_sector");
    expect(deriveRound2Verdict("Delta Flight Products")).toMatchObject({
      ownershipStatus: "strategic_owned",
      pipelineDecision: "pass_sector",
    });
  });

  it("flags subsidiary names as strategic-owned, leaves others unreviewed", () => {
    expect(deriveRound2Verdict("Acme, a Division of XYZ")).toMatchObject({
      ownershipStatus: "strategic_owned",
      pipelineDecision: "unreviewed",
    });
    expect(deriveRound2Verdict("Zephyr International LLC")).toMatchObject({
      ownershipStatus: "unknown",
      pipelineDecision: "unreviewed",
    });
  });
});

describe("ownership/decision merge precedence", () => {
  it("prefers any non-unknown ownership, keeping existing on ties", () => {
    expect(mergeOwnershipStatus("unknown", "strategic_owned")).toBe(
      "strategic_owned",
    );
    expect(mergeOwnershipStatus("pe_owned", "unknown")).toBe("pe_owned");
    expect(mergeOwnershipStatus("pe_owned", "strategic_owned")).toBe(
      "pe_owned",
    );
    expect(mergeOwnershipStatus(null, undefined)).toBe("unknown");
  });

  it("keeps terminal passes over hold/unreviewed, add over hold", () => {
    expect(mergePipelineDecision("hold", "pass_acquired")).toBe(
      "pass_acquired",
    );
    expect(mergePipelineDecision("pass_dead", "add")).toBe("pass_dead");
    expect(mergePipelineDecision("unreviewed", "add")).toBe("add");
    expect(mergePipelineDecision("hold", "unreviewed")).toBe("hold");
    expect(mergePipelineDecision(null, null)).toBe("unreviewed");
  });

  it("folds verdict fields when batch rows collide", () => {
    const row = (
      companyName: string,
      ownershipStatus: string,
      pipelineDecision: string,
    ) => ({
      companyName,
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
      ownershipStatus,
      pipelineDecision,
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
    const merged = mergeBatchDuplicates([
      row("Dart Aerospace", "unknown", "unreviewed"),
      row("DART AEROSPACE", "strategic_owned", "pass_acquired"),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      ownershipStatus: "strategic_owned",
      pipelineDecision: "pass_acquired",
    });
  });
});
