import { describe, expect, it } from "vitest";

import { enrichUnifiedExportRow } from "../packages/database/src/unified-targets/export.js";

const expectedReviewInputContract = {
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
    verifiedDomain: "example-aero.com",
    proofEvidenceIds: ["identity-proof"],
  },
  website: {
    status: "supported",
    offering: "products_menu",
    namedProductEvidenceIds: ["product-proof"],
  },
  ownership: {
    status: "independent",
    supportEvidenceIds: ["ownership-proof"],
  },
  size: {
    status: "supported",
    assessment: "under_50m",
    indicators: [{ kind: "revenue", evidenceId: "size-proof" }],
  },
  headquarters: {
    status: "supported",
    country: "US",
    supportEvidenceIds: ["hq-proof"],
  },
  missingFacts: [],
  evidenceRefs: [
    {
      evidenceId: "identity-proof",
      stage: "domain",
      role: "support",
      firstParty: true,
    },
    {
      evidenceId: "product-proof",
      stage: "website",
      role: "support",
      firstParty: true,
    },
    {
      evidenceId: "ownership-proof",
      stage: "ownership",
      role: "support",
    },
    {
      evidenceId: "size-proof",
      stage: "size",
      role: "support",
    },
    {
      evidenceId: "hq-proof",
      stage: "hq",
      role: "support",
    },
  ],
};

const exportContext = { expectedReviewInputContract } as const;

function readyRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    company_name: "Example Aero",
    domain: "example-aero.com",
    signal_id: "signal-current",
    review_phase: "settled",
    review_input_hash: "input-current",
    review_input_manifest: {
      ...expectedReviewInputContract,
      sourceRevision: 9,
      evidence: {},
    },
    state_source_revision: 9,
    signal_source_revision: 9,
    state_jev_evaluation_id: "jev-current",
    result_input_hash: "input-current",
    result_jev_evaluation_id: "jev-current",
    result_muse_evaluation_id: "muse-current",
    result_final_decision: "high_priority",
    jev_evaluation_id: "jev-current",
    jev_signal_id: "signal-current",
    jev_input_hash: "input-current",
    jev_decision: "high_priority",
    jev_error: null,
    jev_disqualifiers: [],
    muse_evaluation_id: "muse-current",
    muse_signal_id: "signal-current",
    muse_input_hash: "input-current",
    muse_decision: "high_priority",
    muse_error: null,
    muse_disqualifiers: [],
    research_evidence: completeResearchEvidence,
    source_raw_domain: "example-aero.com",
    known_company_domains: ["example-aero.com"],
    memberships: [],
    possible_memberships: [],
    ...overrides,
  };
}

const conflictingIdentityInputs: [string, Record<string, unknown>][] = [
  ["reported target", { domain: "different-target.com" }],
  [
    "source signal",
    {
      source_raw_domain: "different-source.com",
      known_company_domains: ["example-aero.com"],
    },
  ],
  [
    "linked company",
    {
      source_raw_domain: "example-aero.com",
      known_company_domains: ["example-aero.com", "different-company.com"],
    },
  ],
];

describe("unified target export identity gate", () => {
  it.each(conflictingIdentityInputs)(
    "holds an otherwise-ready row with a conflicting %s domain",
    (_kind, domains) => {
      const exported = enrichUnifiedExportRow(readyRow(domains), exportContext);

      expect(exported["promotion_status"]).toBe("diligence_hold");
    },
  );

  it("keeps equivalent normalized identity inputs ready", () => {
    const exported = enrichUnifiedExportRow(
      readyRow({
        source_raw_domain: " HTTPS://WWW.Example-Aero.com/about ",
        known_company_domains: [
          "example-aero.com.",
          "http://www.EXAMPLE-AERO.com/products",
        ],
      }),
      exportContext,
    );

    expect(exported["review_status"]).toBe("current_complete");
    expect(exported["promotion_status"]).toBe("ready");
    expect(exported["promotion_holds"]).toEqual([]);
  });

  it("preserves exclusions when identity inputs also conflict", () => {
    const exported = enrichUnifiedExportRow(
      readyRow({
        source_raw_domain: "different-source.com",
        jev_disqualifiers: ["public-company parent"],
      }),
      exportContext,
    );

    expect(exported["promotion_status"]).toBe("excluded");
  });

  it("does not let matching domains compensate for mismatched review inputs", () => {
    const exported = enrichUnifiedExportRow(
      readyRow({ muse_input_hash: "older-input" }),
      exportContext,
    );

    expect(exported["review_status"]).toBe("current_jev_complete");
    expect(exported["models_agree"]).toBeNull();
    expect(exported["promotion_status"]).toBe("not_current");
  });

  it("fails closed when the expected policy is absent or incompatible", () => {
    const absentPolicy = enrichUnifiedExportRow(readyRow());
    const incompatiblePolicy = enrichUnifiedExportRow(readyRow(), {
      expectedReviewInputContract: {
        ...expectedReviewInputContract,
        policy: {
          ...expectedReviewInputContract.policy,
          museModel: "muse-next",
        },
      },
    });

    expect(absentPolicy["review_status"]).toBe("current_policy_unverified");
    expect(absentPolicy["promotion_status"]).toBe("not_current");
    expect(incompatiblePolicy["review_status"]).toBe("stale_or_incompatible");
    expect(incompatiblePolicy["promotion_status"]).toBe("not_current");
  });
});
