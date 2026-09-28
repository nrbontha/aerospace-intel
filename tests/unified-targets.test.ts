import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { parseExportArgs } from "../scripts/export-unified-targets.mts";
import {
  hasConflictingTargetDomains,
  higherTier,
  isOffThesisName,
  isSubsidiaryName,
  isSyntheticTargetName,
  mapCandidateTier,
  mapCuratedTier,
  mapDiscoveryInvestorAssessment,
  mergeBatchDuplicates,
  mapEnsembleProjectionTier,
  normalizeUnifiedName,
} from "../scripts/populate-unified-targets.mts";
import { closeDatabase, getDatabase } from "../packages/database/src/client.js";
import { runMigrations } from "../packages/database/src/migrate.js";
import {
  faaEnsembleEvaluations,
  faaEnsembleResults,
  signalReviewState,
  sourceSignals,
  unifiedTargets,
} from "../packages/database/src/schema.js";
import { populateUnifiedTargets } from "../packages/database/src/unified-targets/populate.js";
import { enrichUnifiedExportRow } from "../packages/database/src/unified-targets/export.js";
import {
  assessPromotionEvidence,
  isCurrentReviewLinkage,
  isOriginalBooieListName,
  matchKnownUniverseIdentity,
  matchesExpectedReviewInputContract,
  parseSignalResearchEvidence,
  upsertUnifiedTarget,
} from "../packages/database/src/unified-targets/records.js";
import { isPromotionCandidateCovered } from "../packages/database/src/unified-targets/promote.js";

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
  });

  it("maps current candidate stages without claiming model readiness", () => {
    expect(mapCandidateTier("research_ready")).toBe("high_interest");
    expect(mapCandidateTier("queued_research")).toBe("needs_research");
    expect(mapCandidateTier("in_research")).toBe("evaluate");
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
    ownershipStatus: "unknown" as const,
    pipelineDecision: "unreviewed" as const,
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

  it("preserves the established identity and human judgment on conflicts", () => {
    const merged = mergeBatchDuplicates([
      row({
        domain: "electronicsinternational.com",
        websiteUrl: "https://electronicsinternational.com",
        ownershipStatus: "independent" as const,
        pipelineDecision: "add" as const,
        evidenceUrls: ["https://electronicsinternational.com/about"],
      }),
      row({
        origin: "faa_ensemble",
        domain: "infiniteelectronics.com",
        websiteUrl: "https://infiniteelectronics.com",
        tier: "high_interest",
        ownershipStatus: "unknown" as const,
        pipelineDecision: "unreviewed" as const,
        evidenceUrls: ["https://infiniteelectronics.com/about"],
      }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      domain: "electronicsinternational.com",
      ownershipStatus: "independent",
      pipelineDecision: "add",
      evidenceUrls: ["https://electronicsinternational.com/about"],
    });
    expect(
      hasConflictingTargetDomains(
        "electronicsinternational.com",
        "https://www.infiniteelectronics.com",
      ),
    ).toBe(true);
  });

  it("does not downgrade human add, hold, or pass facts on replay", () => {
    for (const decision of ["add", "hold", "pass_scale"] as const) {
      const [merged] = mergeBatchDuplicates([
        row({
          domain: "zitecusa.com",
          ownershipStatus: "independent" as const,
          pipelineDecision: decision,
        }),
        row({
          origin: "faa_ensemble",
          domain: "zitecusa.com",
          ownershipStatus: "unknown" as const,
          pipelineDecision: "unreviewed" as const,
        }),
      ]);
      expect(merged).toMatchObject({
        ownershipStatus: "independent",
        pipelineDecision: decision,
      });
    }
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

describe("ensemble projection tier", () => {
  it("keeps only evidence-ready dual-model HP at high interest", () => {
    expect(mapEnsembleProjectionTier("high_priority", "ready", true)).toBe(
      "high_interest",
    );
    expect(
      mapEnsembleProjectionTier("high_priority", "diligence_hold", false),
    ).toBe("evaluate");
    expect(mapEnsembleProjectionTier("research", "diligence_hold", true)).toBe(
      "evaluate",
    );
    expect(mapEnsembleProjectionTier("research", "diligence_hold", false)).toBe(
      "needs_research",
    );
  });
});

describe("research evidence parsing", () => {
  it("keeps absent facts unknown instead of manufacturing undefined values", () => {
    const parsed = parseSignalResearchEvidence({
      identity: { status: " " },
      size: { indicators: [{}] },
      evidenceRefs: [{}],
    });

    expect(parsed.identity).not.toHaveProperty("status");
    expect(parsed.size?.indicators?.[0]).toEqual({});
    expect(parsed.evidenceRefs?.[0]).toEqual({});
  });
});

const expectedReviewContract = {
  version: "faa_review_input_v1",
  policy: {
    ladder: "faa_ladder_v1",
    jevModel: "jev-current",
    museModel: "muse-current",
    evaluatorPrompt: "faa_evaluator_v1",
    jevAuditSampleRate: 0.05,
  },
} as const;

const completeResearchEvidence = {
  version: "signal_research_v1",
  identity: {
    status: "verified",
    verifiedDomain: "electronicsinternational.com",
    proofEvidenceIds: ["identity-1"],
  },
  website: {
    status: "supported",
    offering: "products_menu",
    namedProductEvidenceIds: ["product-1"],
  },
  ownership: {
    status: "independent",
    supportEvidenceIds: ["ownership-1"],
  },
  size: {
    status: "supported",
    assessment: "under_50m",
    indicators: [
      {
        kind: "revenue",
        evidenceId: "size-1",
      },
    ],
  },
  headquarters: {
    status: "supported",
    city: "Bend",
    state: "OR",
    country: "US",
    supportEvidenceIds: ["hq-1"],
  },
  missingFacts: [],
  evidenceRefs: [
    {
      evidenceId: "identity-1",
      stage: "domain",
      role: "support",
      url: "https://electronicsinternational.com/about",
      firstParty: true,
    },
    {
      evidenceId: "product-1",
      stage: "website",
      url: "https://electronicsinternational.com/products",
      role: "support",
      quote: "Aircraft engine instruments",
      firstParty: true,
    },
    {
      evidenceId: "ownership-1",
      stage: "ownership",
      role: "support",
      url: "https://electronicsinternational.com/about",
      quote: "Privately owned by its founders",
      firstParty: true,
    },
    {
      evidenceId: "size-1",
      stage: "size",
      role: "support",
      url: "https://electronicsinternational.com/company-profile",
      quote: "Annual revenue of $20 million",
      firstParty: true,
    },
    {
      evidenceId: "hq-1",
      stage: "hq",
      role: "support",
      url: "https://electronicsinternational.com/contact",
      quote: "Headquartered in Bend, Oregon",
      firstParty: true,
    },
  ],
};

describe("current review and promotion evidence", () => {
  const currentLinkage = {
    phase: "settled",
    stateInputHash: "hash-1",
    stateJevEvaluationId: "jev-1",
    stateSourceRevision: 7,
    signalSourceRevision: 7,
    inputManifest: {
      ...expectedReviewContract,
      sourceRevision: 7,
      evidence: {},
    },
    resultInputHash: "hash-1",
    resultJevEvaluationId: "jev-1",
    resultMuseEvaluationId: "muse-1",
    signalId: "signal-1",
    jev: {
      id: "jev-1",
      signalId: "signal-1",
      inputHash: "hash-1",
      decision: "high_priority",
      error: null,
    },
    muse: {
      id: "muse-1",
      signalId: "signal-1",
      inputHash: "hash-1",
      decision: "high_priority",
      error: null,
    },
  };

  it("rejects legacy NULL hashes and mismatched current pointers", () => {
    expect(isCurrentReviewLinkage(currentLinkage, expectedReviewContract)).toBe(
      true,
    );
    expect(isCurrentReviewLinkage(currentLinkage, null)).toBe(false);
    expect(
      isCurrentReviewLinkage(
        {
          ...currentLinkage,
          stateInputHash: null,
          resultInputHash: null,
          jev: { ...currentLinkage.jev, inputHash: null },
          muse: { ...currentLinkage.muse, inputHash: null },
        },
        expectedReviewContract,
      ),
    ).toBe(false);
    expect(
      isCurrentReviewLinkage(
        {
          ...currentLinkage,
          resultMuseEvaluationId: "older-muse",
        },
        expectedReviewContract,
      ),
    ).toBe(false);
    expect(
      isCurrentReviewLinkage(
        {
          ...currentLinkage,
          signalSourceRevision: 8,
        },
        expectedReviewContract,
      ),
    ).toBe(false);
    expect(
      isCurrentReviewLinkage(
        {
          ...currentLinkage,
          signalSourceRevision: null,
        },
        expectedReviewContract,
      ),
    ).toBe(false);
    expect(
      isCurrentReviewLinkage(
        {
          ...currentLinkage,
          inputManifest: {
            ...currentLinkage.inputManifest,
            sourceRevision: 6,
          },
        },
        expectedReviewContract,
      ),
    ).toBe(false);
  });

  it("requires sourced identity, products, ownership, size, and US HQ", () => {
    expect(
      assessPromotionEvidence({
        finalDecision: "high_priority",
        jevDecision: "high_priority",
        museDecision: "high_priority",
        researchEvidence: completeResearchEvidence,
      }),
    ).toEqual({
      status: "ready",
      reasons: [],
      verifiedDomain: "electronicsinternational.com",
    });

    const hold = assessPromotionEvidence({
      finalDecision: "high_priority",
      jevDecision: "high_priority",
      museDecision: "high_priority",
      researchEvidence: {
        ...completeResearchEvidence,
        ownership: {
          ...completeResearchEvidence.ownership,
          status: "unknown",
        },
        size: {
          ...completeResearchEvidence.size,
          assessment: "unknown",
        },
        missingFacts: ["ultimate owner", "revenue"],
      },
    });
    expect(hold.status).toBe("diligence_hold");
    expect(hold.reasons).toEqual(
      expect.arrayContaining([
        "independent ownership unverified",
        "sub-$50m revenue unverified",
      ]),
    );
  });

  it("keeps sourced acquisition and scale exclusions out of promotion", () => {
    const acquired = assessPromotionEvidence({
      finalDecision: "high_priority",
      jevDecision: "high_priority",
      museDecision: "high_priority",
      researchEvidence: {
        ...completeResearchEvidence,
        ownership: {
          ...completeResearchEvidence.ownership,
          status: "acquired",
        },
        size: {
          ...completeResearchEvidence.size,
          assessment: "over_50m",
        },
      },
    });
    expect(acquired.status).toBe("excluded");
    expect(acquired.reasons).toEqual(
      expect.arrayContaining([
        "ownership exclusion: acquired",
        "sourced revenue exceeds $50m",
      ]),
    );
  });
});

describe("safe prior-list identity", () => {
  it("keeps Electronics International distinct from Infinite Electronics", () => {
    expect(isOriginalBooieListName("Electronics International, Inc.")).toBe(
      true,
    );
    expect(
      isOriginalBooieListName("Infinite Electronics International, Inc."),
    ).toBe(false);
  });

  it("matches exact domains or domainless exact names only", () => {
    expect(
      matchKnownUniverseIdentity(
        {
          normalizedName: "alliance aerospace engineering",
          normalizedDomain: "alliance-aerospace.com",
        },
        {
          normalizedName: "alliance aerospace group",
          normalizedDomain: "alliance-aerospace.com",
        },
      ),
    ).toBe("exact_domain");
    expect(
      matchKnownUniverseIdentity(
        {
          normalizedName: "electronics international",
          normalizedDomain: "electronicsinternational.com",
        },
        {
          normalizedName: "electronics international",
          normalizedDomain: null,
        },
      ),
    ).toBe("exact_name");
    expect(
      matchKnownUniverseIdentity(
        {
          normalizedName: "alliance aerospace engineering",
          normalizedDomain: "alliance-aerospace.com",
        },
        {
          normalizedName: "alliance aerospace engineering",
          normalizedDomain: "alliance.aero",
        },
      ),
    ).toBeNull();
  });
});

describe("truthful review export", () => {
  it("does not report a legacy high-priority pair as current agreement", () => {
    const row = enrichUnifiedExportRow({
      company_name: "Legacy Supplier",
      signal_id: "signal-1",
      review_phase: "settled",
      review_input_hash: null,
      state_jev_evaluation_id: "jev-1",
      result_input_hash: null,
      result_jev_evaluation_id: "jev-1",
      result_muse_evaluation_id: "muse-1",
      result_final_decision: "high_priority",
      jev_evaluation_id: "jev-1",
      jev_signal_id: "signal-1",
      jev_input_hash: null,
      jev_decision: "high_priority",
      jev_error: null,
      muse_evaluation_id: "muse-1",
      muse_signal_id: "signal-1",
      muse_input_hash: null,
      muse_decision: "high_priority",
      muse_error: null,
      research_evidence: {
        missingFacts: ["verified domain", "ultimate owner"],
      },
      memberships: [],
      possible_memberships: [],
    });
    expect(row["review_status"]).toBe("legacy_unlinked");
    expect(row["models_agree"]).toBeNull();
    expect(row["promotion_status"]).toBe("not_current");
    expect(row["research_missing_facts"]).toEqual([
      "verified domain",
      "ultimate owner",
    ]);
  });

  it("reports current Jev research without inventing a Muse result", () => {
    const input = {
      company_name: "Diligence Supplier",
      signal_id: "signal-2",
      review_phase: "settled",
      review_input_hash: "hash-2",
      state_jev_evaluation_id: "jev-2",
      review_input_manifest: {
        ...expectedReviewContract,
        sourceRevision: 4,
        evidence: {},
      },
      state_source_revision: 4,
      signal_source_revision: 4,
      result_input_hash: null,
      result_jev_evaluation_id: null,
      result_muse_evaluation_id: null,
      jev_evaluation_id: "jev-2",
      jev_signal_id: "signal-2",
      jev_input_hash: "hash-2",
      jev_decision: "research",
      jev_error: null,
      muse_evaluation_id: null,
      muse_signal_id: null,
      muse_input_hash: null,
      muse_decision: null,
      muse_error: null,
      research_evidence: completeResearchEvidence,
      memberships: [],
      possible_memberships: [],
    };
    expect(enrichUnifiedExportRow(input)["review_status"]).toBe(
      "current_policy_unverified",
    );
    const row = enrichUnifiedExportRow(input, {
      expectedReviewInputContract: expectedReviewContract,
    });

    expect(row["review_status"]).toBe("current_jev_complete");
    expect(row["jev_decision"]).toBe("research");
    expect(row["muse_decision"]).toBeNull();
    expect(row["models_agree"]).toBeNull();
    expect(row["promotion_status"]).toBe("not_current");
    expect(
      matchesExpectedReviewInputContract(input.review_input_manifest, {
        ...expectedReviewContract,
        policy: {
          ...expectedReviewContract.policy,
          museModel: "muse-new",
        },
      }),
    ).toBe(false);
  });

  it("keeps list membership separate from current review status", () => {
    const row = enrichUnifiedExportRow({
      company_name: "Electronics International",
      review_phase: null,
      research_evidence: {},
      memberships: [
        {
          snapshotKey: "booie-original29-2026-09-09",
          sourceRow: 20,
          contentSha256: "abc123",
          matchBasis: "exact_name",
        },
      ],
      possible_memberships: [],
    });
    expect(row["pre_jev_membership"]).toBe(true);
    expect(row["original_booie_list_presence"]).toBe(true);
    expect(row["review_status"]).toBe("not_started");
    expect(row["promotion_status"]).toBe("not_current");
  });
});

describe("promotion idempotency coverage", () => {
  it("skips an already-covered exact lead without substring aliasing", () => {
    const coverage = {
      leadIds: new Set<string>(),
      companyIds: new Set<string>(),
      rawNames: new Set(["Electronics International"]),
    };
    expect(
      isPromotionCandidateCovered(
        {
          leadId: null,
          companyId: null,
          rawName: "Electronics International",
        },
        coverage,
      ),
    ).toBe(true);
    expect(
      isPromotionCandidateCovered(
        {
          leadId: null,
          companyId: null,
          rawName: "Infinite Electronics International",
        },
        coverage,
      ),
    ).toBe(false);
  });
});

const DB_TESTS_ENABLED = process.env.ASI_DB_TESTS === "1";
const projectionSignalIds: string[] = [];
const projectionTargetNames: string[] = [];

describe.skipIf(!DB_TESTS_ENABLED)(
  "unified target review-contract projection (DB)",
  () => {
    beforeAll(async () => {
      await runMigrations();
    });

    afterAll(async () => {
      await closeDatabase();
    });

    afterEach(async () => {
      const db = getDatabase();
      const targetNames = projectionTargetNames.splice(0);
      if (targetNames.length > 0) {
        await db
          .delete(unifiedTargets)
          .where(inArray(unifiedTargets.normalizedName, targetNames));
      }
      const signalIds = projectionSignalIds.splice(0);
      if (signalIds.length > 0) {
        await db
          .delete(sourceSignals)
          .where(inArray(sourceSignals.id, signalIds));
      }
    });

    it.each([
      {
        origins: ["faa_ensemble"],
        pipelineDecision: "unreviewed",
        expected: {
          tier: "needs_research",
          investorPriority: null,
          proprietaryBasis: "unknown",
          oversizeFlag: false,
          whyInteresting: null,
          risks: null,
          unknowns: null,
        },
      },
      {
        origins: ["curated", "faa_ensemble"],
        pipelineDecision: "unreviewed",
        expected: {
          tier: "high_interest",
          investorPriority: 1,
          proprietaryBasis: "product",
          oversizeFlag: true,
          whyInteresting: "Durable source rationale",
          risks: "Durable source risk",
          unknowns: "Durable source gap",
        },
      },
      {
        origins: ["faa_ensemble"],
        pipelineDecision: "hold",
        expected: {
          tier: "high_interest",
          investorPriority: 1,
          proprietaryBasis: "product",
          oversizeFlag: true,
          whyInteresting: "Durable source rationale",
          risks: "Durable source risk",
          unknowns: "Durable source gap",
        },
      },
    ])(
      "reconciles stale attention and rationale for $origins/$pipelineDecision",
      async ({ origins, pipelineDecision, expected }) => {
        const db = getDatabase();
        const companyName = `Projection Attention ${randomUUID()}`;
        const normalizedName = normalizeUnifiedName(companyName);
        projectionTargetNames.push(normalizedName);
        await db.insert(unifiedTargets).values({
          companyName,
          normalizedName,
          origins,
          pipelineDecision,
          tier: "high_interest",
          investorPriority: 1,
          proprietaryBasis: "product",
          oversizeFlag: true,
          pipelineStatus: "ready",
          ensembleDecision: "high_priority",
          whyInteresting: "Durable source rationale",
          risks: "Durable source risk",
          unknowns: "Durable source gap",
        });

        await populateUnifiedTargets(db, {
          expectedReviewInputContract: expectedReviewContract,
          curatedCsvPath: "/dev/null",
        });
        const [projected] = await db
          .select()
          .from(unifiedTargets)
          .where(eq(unifiedTargets.normalizedName, normalizedName));
        expect(projected).toMatchObject({
          ...expected,
          pipelineDecision,
          pipelineStatus: null,
          ensembleDecision: null,
        });
      },
    );

    it("replaces ready/product/oversize claims with the current same-policy research assessment", async () => {
      const db = getDatabase();
      const signalId = randomUUID();
      const jevEvaluationId = randomUUID();
      const inputHash = `projection-refresh-${randomUUID()}`;
      const companyName = `Projection Refresh ${randomUUID()}`;
      const normalizedName = normalizeUnifiedName(companyName);
      const inputManifest = { ...expectedReviewContract, sourceRevision: 0 };
      projectionSignalIds.push(signalId);
      projectionTargetNames.push(normalizedName);
      await db.insert(sourceSignals).values({
        id: signalId,
        sourceKey: "faa_pma_database",
        sourceLocator: `https://example.test/projection/${signalId}`,
        sourceFingerprint: `projection-refresh:${signalId}`,
        rawName: companyName,
      });
      await db.insert(faaEnsembleEvaluations).values({
        id: jevEvaluationId,
        signalId,
        modelId: expectedReviewContract.policy.jevModel,
        promptVersion: expectedReviewContract.policy.evaluatorPrompt,
        inputHash,
        inputManifest,
        decision: "research",
        confidence: 70,
      });
      await db.insert(signalReviewState).values({
        signalId,
        sourceRevision: 0,
        phase: "settled",
        inputHash,
        inputManifest,
        jevEvaluationId,
        researchEvidence: {
          identity: {
            status: "ambiguous",
            verifiedDomain: null,
            proofEvidenceIds: [],
          },
          missingFacts: ["identity", "ownership", "revenue"],
        },
      });
      await db.insert(unifiedTargets).values({
        companyName,
        normalizedName,
        signalId,
        origins: ["faa_ensemble"],
        tier: "high_interest",
        investorPriority: 1,
        proprietaryBasis: "product",
        oversizeFlag: true,
        pipelineStatus: "ready",
        ensembleDecision: "high_priority",
        whyInteresting: "Stale machine rationale",
        risks: "Stale machine risk",
        unknowns: "Stale machine gap",
      });

      await populateUnifiedTargets(db, {
        expectedReviewInputContract: expectedReviewContract,
        curatedCsvPath: "/dev/null",
      });
      const [projected] = await db
        .select()
        .from(unifiedTargets)
        .where(eq(unifiedTargets.signalId, signalId));
      expect(projected).toMatchObject({
        tier: "needs_research",
        investorPriority: 3,
        proprietaryBasis: "unknown",
        oversizeFlag: false,
        pipelineStatus: "jev_complete",
        ensembleDecision: "research",
        whyInteresting: null,
        risks: null,
      });
      expect(projected?.unknowns).toContain("identity");
    });

    it.each([
      {
        protection: "machine-only",
        origins: ["faa_ensemble"],
        pipelineDecision: "unreviewed",
        expected: {
          whyInteresting: null,
          risks: "Current machine risk",
          unknowns: null,
        },
      },
      {
        protection: "candidate rationale",
        origins: ["discovery", "faa_ensemble"],
        pipelineDecision: "unreviewed",
        expected: {
          whyInteresting: "Prior rationale",
          risks: "Prior risk",
          unknowns: "Prior gap",
        },
      },
      {
        protection: "human decision",
        origins: ["faa_ensemble"],
        pipelineDecision: "hold",
        expected: {
          whyInteresting: "Prior rationale",
          risks: "Prior risk",
          unknowns: "Prior gap",
        },
      },
    ])(
      "public upsert respects $protection when replacing ensemble rationale",
      async ({ origins, pipelineDecision, expected }) => {
        const db = getDatabase();
        const companyName = `Public Rationale ${randomUUID()}`;
        const normalizedName = normalizeUnifiedName(companyName);
        projectionTargetNames.push(normalizedName);
        await db.insert(unifiedTargets).values({
          companyName,
          normalizedName,
          origins,
          pipelineDecision,
          whyInteresting: "Prior rationale",
          risks: "Prior risk",
          unknowns: "Prior gap",
        });

        const projected = await upsertUnifiedTarget(db, {
          companyName,
          origins: ["faa_ensemble"],
          whyInteresting: null,
          risks: "Current machine risk",
          unknowns: null,
        });

        expect(projected).toMatchObject({
          ...expected,
          pipelineDecision,
        });
      },
    );

    it("preserves curated rationale across stale and current ensemble projections", async () => {
      const db = getDatabase();
      const signalId = randomUUID();
      const jevEvaluationId = randomUUID();
      const museEvaluationId = randomUUID();
      const inputHash = `projection-policy-${randomUUID()}`;
      const companyName = `Projection Policy Fence ${randomUUID()}`;
      const normalizedName = normalizeUnifiedName(companyName);
      const oldReviewContract = {
        ...expectedReviewContract,
        policy: {
          ...expectedReviewContract.policy,
          evaluatorPrompt: "faa_evaluator_obsolete",
        },
      };
      const oldInputManifest = {
        ...oldReviewContract,
        sourceRevision: 0,
      };
      const currentInputManifest = {
        ...expectedReviewContract,
        sourceRevision: 0,
      };
      projectionSignalIds.push(signalId);
      projectionTargetNames.push(normalizedName);

      await db.insert(sourceSignals).values({
        id: signalId,
        sourceKey: "faa_pma_database",
        sourceLocator: `https://example.test/projection/${signalId}`,
        sourceFingerprint: `projection-policy:${signalId}`,
        rawName: companyName,
        sourcePayload: {
          guid_url: `https://example.test/projection/${signalId}/source`,
        },
      });
      await db.insert(faaEnsembleEvaluations).values([
        {
          id: jevEvaluationId,
          signalId,
          modelId: expectedReviewContract.policy.jevModel,
          promptVersion: oldReviewContract.policy.evaluatorPrompt,
          inputHash,
          inputManifest: oldInputManifest,
          decision: "research",
          confidence: 71,
          disqualifiers: ["legacy-risk"],
          missingEvidence: ["legacy-gap"],
        },
        {
          id: museEvaluationId,
          signalId,
          modelId: expectedReviewContract.policy.museModel,
          promptVersion: oldReviewContract.policy.evaluatorPrompt,
          inputHash,
          inputManifest: oldInputManifest,
          decision: "research",
          confidence: 75,
        },
      ]);
      await db.insert(faaEnsembleResults).values({
        signalId,
        inputHash,
        jevEvaluationId,
        museEvaluationId,
        modelAId: expectedReviewContract.policy.jevModel,
        modelBId: expectedReviewContract.policy.museModel,
        modelADecision: "research",
        modelBDecision: "research",
        agreed: true,
        adjudicationRequired: false,
        finalDecision: "research",
        finalConfidence: 73,
        reason: "Legacy policy rationale",
      });
      await db.insert(signalReviewState).values({
        signalId,
        sourceRevision: 0,
        phase: "settled",
        inputHash,
        inputManifest: oldInputManifest,
        researchEvidence: completeResearchEvidence,
        jevEvaluationId,
      });

      await populateUnifiedTargets(db, {
        expectedReviewInputContract: oldReviewContract,
        curatedCsvPath: "/dev/null",
      });
      const [oldProjection] = await db
        .select()
        .from(unifiedTargets)
        .where(eq(unifiedTargets.normalizedName, normalizedName));
      if (oldProjection === undefined) {
        throw new Error("expected obsolete-contract projection");
      }
      expect(oldProjection).toMatchObject({
        ensembleDecision: "research",
        ensembleConfidence: 73,
        whyInteresting: "Legacy policy rationale",
        risks: "legacy-risk",
      });
      expect(oldProjection.unknowns).toContain("legacy-gap");

      await db
        .update(unifiedTargets)
        .set({
          origins: ["faa_ensemble", "curated"],
          tier: "high_interest",
          ownershipStatus: "pe_owned",
          fit: "0.9100",
          whyInteresting: "Curated investment rationale",
          risks: "Curated source risk",
          unknowns: "Curated diligence gap",
        })
        .where(eq(unifiedTargets.id, oldProjection.id));

      await populateUnifiedTargets(db, {
        expectedReviewInputContract: expectedReviewContract,
        curatedCsvPath: "/dev/null",
      });
      const [staleProjection] = await db
        .select()
        .from(unifiedTargets)
        .where(eq(unifiedTargets.id, oldProjection.id));
      expect(staleProjection).toMatchObject({
        goldenV1Member: false,
        tier: "high_interest",
        ownershipStatus: "pe_owned",
        pipelineDecision: "unreviewed",
        fit: "0.9100",
        domain: "electronicsinternational.com",
        ensembleDecision: null,
        ensembleConfidence: null,
        pipelineStatus: null,
        whyInteresting: "Curated investment rationale",
        risks: "Curated source risk",
        unknowns: "Curated diligence gap",
      });
      expect(staleProjection?.origins).toEqual(
        expect.arrayContaining(["faa_ensemble", "curated"]),
      );
      expect(staleProjection?.evidenceUrls).toEqual(
        expect.arrayContaining([
          "https://electronicsinternational.com/about",
          `https://example.test/projection/${signalId}/source`,
        ]),
      );

      const durableStates = await db
        .select()
        .from(signalReviewState)
        .where(eq(signalReviewState.signalId, signalId));
      const durableEvaluations = await db
        .select({ id: faaEnsembleEvaluations.id })
        .from(faaEnsembleEvaluations)
        .where(eq(faaEnsembleEvaluations.signalId, signalId));
      const durableResults = await db
        .select({ id: faaEnsembleResults.id })
        .from(faaEnsembleResults)
        .where(eq(faaEnsembleResults.signalId, signalId));
      expect(durableStates).toHaveLength(1);
      expect(durableStates[0]).toMatchObject({
        phase: "settled",
        inputHash,
        inputManifest: oldInputManifest,
      });
      expect(durableEvaluations).toHaveLength(2);
      expect(durableResults).toHaveLength(1);

      await db
        .update(signalReviewState)
        .set({ inputManifest: currentInputManifest })
        .where(eq(signalReviewState.signalId, signalId));
      await db
        .update(faaEnsembleEvaluations)
        .set({
          inputManifest: currentInputManifest,
          promptVersion: expectedReviewContract.policy.evaluatorPrompt,
        })
        .where(eq(faaEnsembleEvaluations.signalId, signalId));
      await populateUnifiedTargets(db, {
        expectedReviewInputContract: expectedReviewContract,
        curatedCsvPath: "/dev/null",
      });

      const [currentProjection] = await db
        .select()
        .from(unifiedTargets)
        .where(eq(unifiedTargets.id, oldProjection.id));
      expect(currentProjection).toMatchObject({
        goldenV1Member: false,
        tier: "high_interest",
        ownershipStatus: "pe_owned",
        pipelineDecision: "unreviewed",
        fit: "0.9100",
        ensembleDecision: "research",
        ensembleConfidence: 73,
        whyInteresting: "Curated investment rationale",
        risks: "Curated source risk",
        unknowns: "Curated diligence gap",
      });
    });
  },
);
