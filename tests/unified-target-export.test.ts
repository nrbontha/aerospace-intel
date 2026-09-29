import { describe, expect, it } from "vitest";

import {
  enrichSourceSignalExportRow,
  enrichUnifiedExportRow,
  toCsvRecord,
  toSourceSignalCsvRecord,
} from "../packages/database/src/unified-targets/export.js";

const expectedReviewInputContract = {
  version: "faa_review_input_v1",
  policy: {
    ladder: "faa_ladder_v1",
    jevModel: "jev-current",
    museModel: "muse-current",
    evaluatorPrompt: "faa_evaluator_v1",
    analyst: "analyst-current",
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

describe("source signal analyst export currentness", () => {
  const inputHash = "a".repeat(64);
  const currentRow = {
    signal_id: "signal-current",
    signal_source_revision: 9,
    state_source_revision: 9,
    review_phase: "muse",
    review_input_hash: inputHash,
    review_input_manifest: {
      ...expectedReviewInputContract,
      sourceRevision: 9,
      evidence: {},
    },
    state_jev_evaluation_id: "jev-current",
    jev_evaluation_id: "jev-current",
    jev_signal_id: "signal-current",
    jev_model_id: "jev-current",
    jev_prompt_version: "jev-ladder-rung-prompt",
    jev_input_hash: inputHash,
    jev_input_manifest: {
      ...expectedReviewInputContract,
      sourceRevision: 9,
      evidence: {},
    },
    jev_error: null,
    jev_decision: "research",
    jev_parsed: {
      version: "jev-triage-v1",
      decision: "research",
      confidence: 0.72,
      productFit: "supported_product",
      acquisitionReadiness: "needs_research",
      researchPriority: 1,
      reasonCodes: ["acquisition_facts_incomplete"],
      explanation: "Product fit is supported; mandate facts remain open.",
      observations: [],
      gaps: [
        {
          id: "ownership.current_control",
          field: "ownership",
          question: "Who currently controls the business?",
          priority: 1,
          reason: "Current ownership is unverified.",
          supportingSources: [],
          conflictingSources: [],
        },
      ],
    },
    analyst_case_id: "case-current",
    analyst_source_revision: 9,
    analyst_policy_version: "analyst-current",
    analyst_input_hash: inputHash,
    analyst_case_status: "completed",
    analyst_next_attempt_at: null,
    analyst_stop_reason: "bounded_complete",
    analyst_memo: {
      version: "signal-analyst-memo-v1",
      inputHash,
      createdAt: "2026-09-28T12:34:56.123Z",
      summary: { label: "model_analysis", text: "Model analysis only." },
      answers: [
        {
          gapId: "ownership.current_control",
          field: "ownership",
          status: "unresolved",
          answer: null,
          evidenceIds: [],
        },
      ],
      nextActions: ["Locate a current ownership filing."],
    },
  } satisfies Record<string, unknown>;

  it("exports current triage and requires completed memo/hash proof", () => {
    const current = enrichSourceSignalExportRow(currentRow, exportContext);
    const draft = enrichSourceSignalExportRow(
      { ...currentRow, analyst_case_status: "awaiting_review" },
      exportContext,
    );
    const oldHash = enrichSourceSignalExportRow(
      {
        ...currentRow,
        analyst_memo: { ...currentRow.analyst_memo, inputHash: "b".repeat(64) },
      },
      exportContext,
    );

    expect(current).toMatchObject({
      triage_current: true,
      jev_product_fit: "supported_product",
      jev_acquisition_readiness: "needs_research",
      jev_research_priority: 1,
      analyst_episode_current: true,
      analyst_proof_current: true,
      analyst_memo_current: true,
    });
    expect(draft["analyst_memo_current"]).toBe(false);
    expect(oldHash["analyst_memo_current"]).toBe(false);
  });

  it("keeps unknown provider exposure distinct from known zero spend", () => {
    const record = toSourceSignalCsvRecord({
      ...enrichSourceSignalExportRow(currentRow, exportContext),
      provider_known_cost_usd: "0",
      provider_unknown_estimated_cost_usd: "0.014",
      provider_receipt_count: 1,
      provider_unknown_receipt_count: 1,
    });

    expect(record["Provider Known Cost USD"]).toBe("0");
    expect(record["Provider Unknown Estimated Cost USD"]).toBe("0.014");
    expect(record["Provider Unknown Receipt Count"]).toBe("1");
    expect(record).not.toHaveProperty("Source Payload");
    expect(record).not.toHaveProperty("Qualification");
  });

});

describe("unified target analyst fields", () => {
  it("adds current Jev triage and analyst proof fields without changing membership provenance", () => {
    const inputHash = "c".repeat(64);
    const exported = enrichUnifiedExportRow(
      readyRow({
        review_input_hash: inputHash,
        jev_input_hash: inputHash,
        result_input_hash: inputHash,
        review_phase: "settled",
        jev_model_id: "jev-current",
        jev_prompt_version: "jev-ladder-rung-prompt",
        jev_input_manifest: {
          ...expectedReviewInputContract,
          sourceRevision: 9,
          evidence: {},
        },
        jev_parsed: {
          version: "jev-triage-v1",
          decision: "research",
          confidence: 0.64,
          productFit: "plausible_supplier",
          acquisitionReadiness: "needs_research",
          researchPriority: 2,
          reasonCodes: ["acquisition_facts_incomplete"],
          explanation: "Useful fit signal; diligence remains.",
          observations: [],
          gaps: [],
        },
        analyst_case_id: "case-current",
        analyst_source_revision: 9,
        analyst_policy_version: "analyst-current",
        analyst_input_hash: inputHash,
        analyst_case_status: "active",
      }),
      exportContext,
    );

    expect(exported).toMatchObject({
      triage_current: true,
      jev_product_fit: "plausible_supplier",
      analyst_episode_current: true,
      analyst_proof_current: true,
      analyst_memo_current: false,
      membership_provenance: [],
    });
  });

  it("uses the canonical unscored ranking when no source ranking is linked", () => {
    const exported = enrichUnifiedExportRow(
      readyRow({
        signal_id: null,
        readiness: null,
        ranking: null,
      }),
      exportContext,
    );
    const record = toCsvRecord(exported);

    expect(record).toMatchObject({
      "Investor Ranking Score": "",
      "Investor Ranking Status": "unscored",
      "Investor Ranking Readiness": "unscored",
    });
    expect(record["Membership Provenance"]).toBe("");
    expect(record["Possible Identity Match"]).toBe("no");
  });
});
