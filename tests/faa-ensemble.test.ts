import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as DatabaseModule from "@asi/database";

import { getDailySpendUsd } from "../packages/research/src/campaigns/budget.js";
import { OpenRouterClientError } from "../packages/research/src/openrouter.js";
import { callJev } from "../packages/research/src/faa-ensemble/jev.js";

const signalReviewMocks = vi.hoisted(() => ({
  claimSignalReviews: vi.fn(),
  commitSignalReview: vi.fn(),
  failSignalReview: vi.fn(),
  insertFaaReviewModelUsageReceipt: vi.fn(),
  reconcileChangedSignalReviews: vi.fn(),
  updateClaimedSignalReviewInput: vi.fn(),
}));

vi.mock("@asi/database", async (importOriginal) => ({
  ...(await importOriginal<typeof DatabaseModule>()),
  ...signalReviewMocks,
}));

import {
  buildEvidencePackage,
  buildFaaReviewInputManifest,
  currentFaaReviewInputContract,
  buildJevState,
  evaluateJevLadder,
  hashFaaReviewInput,
  resolveEnsembleConfig,
  parseEnsembleArgs,
  runFaaEnsemble,
  runJevReviews,
  runMuseReviews,
  type FaaEnsembleConfig,
  type FaaEvidencePackage,
  type JevLadderCallRequest,
} from "../scripts/run-faa-ensemble.mts";

function sourceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    review_revision: 0,
    source_key: "faa_pma_database",
    source_locator: "faa-pma:1ABC2",
    source_fingerprint: "source-fingerprint",
    raw_name: "Acme Aero",
    raw_domain: null,
    uei: null,
    cage: "1ABC2",
    city: "Mobile",
    state: "AL",
    country: "US",
    award_count: 14,
    freshest_award: "2026-01-01T00:00:00Z",
    source_payload: {
      makes: ["BOEING"],
      models_sample: ["737"],
      guid_url: "https://drs.faa.gov/example",
    },
    qualification: {},
    ...overrides,
  };
}

function supportRef(
  stage: "domain" | "website" | "ownership" | "size" | "hq",
  quote: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    evidenceId: `${stage}-row`,
    stage,
    url: `https://acme.example/evidence/${stage}`,
    title: `${stage} evidence`,
    quote,
    contentSha256: `${stage}-sha256`,
    retrievedAt: "2026-09-27T00:00:00Z",
    sourceKind: "official_site",
    firstParty: true,
    role: "support",
    ...overrides,
  };
}

function sourcedResearch(overrides: Record<string, unknown> = {}) {
  return {
    version: "signal_research_v1",
    signalId: "00000000-0000-0000-0000-000000000001",
    sourceContext: {
      sourceKey: "faa_pma_database",
      sourceLocator: "faa-pma:1ABC2",
      sourceFingerprint: "source-fingerprint",
      rawName: "Acme Aero",
      rawDomain: null,
      uei: null,
      cage: "1ABC2",
      city: "Mobile",
      state: "AL",
      country: "US",
      awardCount: 14,
    },
    identity: {
      status: "verified",
      verifiedDomain: "acme.example",
      legalName: "Acme Aero LLC",
      proofEvidenceIds: ["domain-row"],
    },
    website: {
      status: "supported",
      offering: "products_menu",
      excerpts: "Acme manufactures the AX-10 actuator.",
      productHints: ["AX-10 actuator"],
      namedProductEvidenceIds: ["website-row"],
    },
    ownership: {
      status: "unknown",
      owner: null,
      year: null,
      supportEvidenceIds: [],
    },
    size: { status: "unknown", assessment: "unknown", indicators: [] },
    headquarters: {
      status: "unknown",
      city: null,
      state: null,
      country: null,
      supportEvidenceIds: [],
    },
    missingFacts: ["headquarters", "revenue", "ownership"],
    checkedSources: [
      {
        url: "https://acme.example/products",
        outcome: "retrieved",
        contentSha256: "abc123",
        retrievedAt: "2026-09-27T00:00:00Z",
      },
    ],
    evidenceRefs: [
      supportRef("domain", "Acme Aero LLC"),
      supportRef("website", "AX-10 actuator"),
    ],
    ...overrides,
  };
}

function packageFixture(
  research: Record<string, unknown> = sourcedResearch(),
): FaaEvidencePackage {
  return buildEvidencePackage(sourceRow(), research as never);
}

function fullLadderCaller(
  finalChoice: "reject" | "research" | "high_priority",
) {
  return async (request: JevLadderCallRequest) => {
    if (request.rung === "r1") {
      return {
        answers: { manufacturer: { type: "noul", noul: 0.9 } },
        costUsd: null,
        model: "jev",
      };
    }
    if (request.rung === "r2") {
      return {
        answers: {
          product_vs_process: {
            type: "choice",
            choice: "product",
            confidence: 0.8,
          },
        },
        costUsd: null,
        model: "jev",
      };
    }
    if (request.rung === "r3") {
      return {
        answers: { oversize: { type: "noul", noul: 0.1 } },
        costUsd: null,
        model: "jev",
      };
    }
    return {
      answers: {
        disposition: {
          type: "choice",
          choice: finalChoice,
          confidence: 0.8,
        },
      },
      costUsd: null,
      model: "jev",
    };
  };
}

describe("JEv provider failure classification", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("attempts the structured quota 403 with a numeric key hash once", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message:
                "Key limit exceeded (total limit). Manage it using https://openrouter.ai/workspaces/default/keys/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
              code: 403,
            },
          }),
          { status: 403 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      callJev("test-key", {}, { disposition: { type: "choice" } }),
    ).rejects.toMatchObject({
      code: "quota_exhausted",
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("classifies HTTP 402 credit exhaustion as terminal quota", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { message: "Insufficient credits", code: 402 },
          }),
          { status: 402 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      callJev("test-key", {}, { disposition: { type: "choice" } }),
    ).rejects.toMatchObject({
      code: "quota_exhausted",
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not treat ordinary 403 body digits as retryable or quota", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message:
                "Forbidden for resource 503187f18bf3097567905f785a3965ab7693f97",
              code: 403,
            },
          }),
          { status: 403 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      callJev("test-key", {}, { disposition: { type: "choice" } }),
    ).rejects.toMatchObject({
      code: "request_rejected",
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("bounds transient HTTP retries by maxRetries", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response("", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const call = callJev(
      "test-key",
      {},
      { disposition: { type: "choice" } },
      { maxRetries: 2 },
    );
    const rejection = expect(call).rejects.toMatchObject({
      code: "provider_unavailable",
      retryable: true,
    });
    await vi.runAllTimersAsync();
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries a transport failure and returns the next valid response", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("controlled network failure"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: "typesafe/jev-controlled",
            answers: { disposition: { type: "noul", noul: 0.6 } },
            usage: { cost: 0.0123 },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const call = callJev(
      "test-key",
      {},
      { disposition: { type: "noul" } },
      { maxRetries: 1 },
    );
    await vi.runAllTimersAsync();
    await expect(call).resolves.toMatchObject({
      model: "typesafe/jev-controlled",
      costUsd: 0.0123,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("canonical FAA review input", () => {
  it("keeps FAA holder/platform context separate from sourced products", () => {
    const evidence = packageFixture();

    expect(evidence).toMatchObject({
      sourceRecordKind: "faa_holder_records",
      sourceRecordCount: 14,
      platformMakes: ["BOEING"],
      platformModels: ["737"],
      productEvidence: ["AX-10 actuator"],
      identityStatus: "verified",
      headquarters: { status: "unknown" },
    });
    expect(buildJevState(evidence)).toMatchObject({
      faa_platform_applicability: {
        makes: ["BOEING"],
        models: ["737"],
      },
      sourced_product_evidence: ["AX-10 actuator"],
    });
  });

  it("labels non-FAA counts as government award context", () => {
    const evidence = buildEvidencePackage(
      sourceRow({ source_key: "sam_entity", award_count: 6 }),
      sourcedResearch() as never,
    );

    expect(evidence.sourceRecordKind).toBe("government_awards");
    expect(evidence.sourceRecordCount).toBe(6);
    expect(evidence.productEvidence).toEqual(["AX-10 actuator"]);
  });

  it("reads current FAA DRS record context without treating it as products", () => {
    const evidence = buildEvidencePackage(
      sourceRow({
        source_key: "faa_drs_pma",
        award_count: 0,
        source_payload: {
          record: {
            make: "Pratt & Whitney Canada Corp.",
            models: ["PW305A", "PW305B"],
            supplementDate: "2026-08-04",
            guidUrl: "https://drs.faa.gov/current-record",
          },
        },
      }),
      sourcedResearch({
        website: {
          status: "no_content",
          offering: "unknown",
          excerpts: "",
          productHints: [],
          namedProductEvidenceIds: [],
        },
      }) as never,
    );

    expect(evidence).toMatchObject({
      sourceRecordKind: "faa_holder_records",
      sourceRecordCount: 1,
      platformMakes: ["Pratt & Whitney Canada Corp."],
      platformModels: ["PW305A", "PW305B"],
      productEvidence: [],
      latestSourceRecordDate: "2026-08-04",
    });
  });

  it("does not treat FAA platforms as products without sourced research", () => {
    const evidence = buildEvidencePackage(sourceRow());

    expect(evidence.platformMakes).toEqual(["BOEING"]);
    expect(evidence.productEvidence).toEqual([]);
    expect(evidence.identityStatus).toBe("not_found");
  });

  it("keeps identical evidence stable across persistence ids and retrieval times", () => {
    const config = resolveEnsembleConfig({});
    const first = buildFaaReviewInputManifest(packageFixture(), config, 0);
    const changedOperationalFields = sourcedResearch({
      identity: {
        status: "verified",
        verifiedDomain: "acme.example",
        legalName: "Acme Aero LLC",
        proofEvidenceIds: ["different-domain-id"],
      },
      website: {
        status: "supported",
        offering: "products_menu",
        excerpts: "Acme manufactures the AX-10 actuator.",
        productHints: ["AX-10 actuator"],
        namedProductEvidenceIds: ["different-product-id"],
      },
      evidenceRefs: [
        supportRef("domain", "Acme Aero LLC", {
          evidenceId: "different-domain-id",
          retrievedAt: "2027-01-01T00:00:00Z",
        }),
        supportRef("website", "AX-10 actuator", {
          evidenceId: "different-product-id",
          retrievedAt: "2027-01-01T00:00:00Z",
        }),
      ],
    });
    const second = buildFaaReviewInputManifest(
      packageFixture(changedOperationalFields),
      config,
      0,
    );

    expect(hashFaaReviewInput(second)).toBe(hashFaaReviewInput(first));
  });

  it("invalidates the review when evidence or reviewed human facts change", () => {
    const config = resolveEnsembleConfig({});
    const original = buildFaaReviewInputManifest(packageFixture(), config, 0);
    const changedIdentity = buildFaaReviewInputManifest(
      packageFixture(
        sourcedResearch({
          identity: {
            status: "verified",
            verifiedDomain: "different.example",
            legalName: "Different Acme LLC",
            proofEvidenceIds: ["new-id"],
          },
        }),
      ),
      config,
      0,
    );
    const changedEvidence = buildFaaReviewInputManifest(
      packageFixture(
        sourcedResearch({
          website: {
            status: "supported",
            offering: "products_menu",
            excerpts: "Acme manufactures the AX-20 actuator.",
            productHints: ["AX-20 actuator"],
            namedProductEvidenceIds: ["new-product-id"],
          },
        }),
      ),
      config,
      0,
    );
    const changedHumanFacts = buildFaaReviewInputManifest(
      buildEvidencePackage(
        sourceRow({
          qualification: {
            humanDecision: "research",
            decisionSource: "human",
          },
        }),
        sourcedResearch() as never,
      ),
      config,
      0,
    );

    expect(hashFaaReviewInput(changedIdentity)).not.toBe(
      hashFaaReviewInput(original),
    );
    expect(hashFaaReviewInput(changedEvidence)).not.toBe(
      hashFaaReviewInput(original),
    );
    expect(hashFaaReviewInput(changedHumanFacts)).not.toBe(
      hashFaaReviewInput(original),
    );
  });
  it("binds the database source revision into the full review contract", () => {
    const config = resolveEnsembleConfig({});
    const original = buildFaaReviewInputManifest(packageFixture(), config, 7);
    const revised = buildFaaReviewInputManifest(packageFixture(), config, 8);

    expect(original).toMatchObject({
      sourceRevision: 7,
      policy: {
        jevModel: config.jevModel,
        museModel: config.modelA,
      },
    });
    expect(hashFaaReviewInput(revised)).not.toBe(hashFaaReviewInput(original));
  });
  it("uses one pure current contract for manifests and read-only consumers", () => {
    const config = resolveEnsembleConfig({});
    const contract = currentFaaReviewInputContract(config);
    const manifest = buildFaaReviewInputManifest(packageFixture(), config, 3);

    expect(contract).toEqual({
      version: manifest.version,
      policy: manifest.policy,
    });
  });
});
describe("FAA ensemble CLI selection", () => {
  it.each([
    ["--status", "qualified"],
    ["--source-key", "faa_pma_database"],
    ["--sample", "2"],
    ["--include-known"],
    ["--benchmark-names", "Acme"],
    ["--failed-only"],
  ])("rejects live-only use of unsupported selector %s", (...selector) => {
    expect(() => parseEnsembleArgs(selector, {})).toThrow(
      /supported only with --dry-run/u,
    );
    expect(() =>
      parseEnsembleArgs(["--dry-run", ...selector], {}),
    ).not.toThrow();
  });
  it("rejects programmatic live selectors before touching the database", async () => {
    const selectedDryRun = parseEnsembleArgs(
      ["--dry-run", "--source-key", "faa_pma_database"],
      {},
    );
    await expect(
      runFaaEnsemble({ ...selectedDryRun, dryRun: false }, { db: {} as never }),
    ).rejects.toThrow(/supported only for dry runs/u);
  });
});

describe("production JEv ladder engine", () => {
  it("rejects acquired assets without a five-year bypass or model call", async () => {
    const call = vi.fn();
    const evidence = packageFixture(
      sourcedResearch({
        ownership: {
          status: "pe_owned",
          owner: "Sponsor",
          year: 2010,
          supportEvidenceIds: ["ownership-row"],
        },
        evidenceRefs: [
          supportRef("domain", "Acme Aero LLC"),
          supportRef("website", "AX-10 actuator"),
          supportRef("ownership", "Sponsor acquired Acme."),
        ],
      }),
    );

    const result = await evaluateJevLadder({ evidence, call });

    expect(result).toMatchObject({
      decision: "reject",
      exitRung: "r0-veto",
      callCount: 0,
      costUsd: null,
    });
    expect(call).not.toHaveBeenCalled();
  });

  it("does not turn an unsupported ownership label into a deterministic veto", async () => {
    const call = vi.fn(fullLadderCaller("research"));
    const evidence = packageFixture(
      sourcedResearch({
        ownership: {
          status: "pe_owned",
          owner: "Unattributed Sponsor",
          year: 2010,
          supportEvidenceIds: [],
        },
      }),
    );

    const result = await evaluateJevLadder({ evidence, call });

    expect(result).toMatchObject({
      decision: "research",
      exitRung: "r4",
      callCount: 4,
    });
    expect(call).toHaveBeenCalled();
  });

  it.each([
    [
      "non-US headquarters",
      {
        headquarters: {
          status: "supported",
          city: "Toronto",
          state: "ON",
          country: "CA",
          supportEvidenceIds: ["hq-row"],
        },
        evidenceRefs: [
          supportRef("domain", "Acme Aero LLC"),
          supportRef("website", "AX-10 actuator"),
          supportRef("hq", "Headquartered in Toronto, Canada."),
        ],
      },
    ],
    [
      "public ownership",
      {
        ownership: {
          status: "public_parent",
          owner: "Public Parent",
          year: null,
          supportEvidenceIds: ["ownership-row"],
        },
        evidenceRefs: [
          supportRef("domain", "Acme Aero LLC"),
          supportRef("website", "AX-10 actuator"),
          supportRef("ownership", "Acme is a subsidiary of Public Parent."),
        ],
      },
    ],
    [
      "revenue at or above the mandate",
      {
        size: {
          status: "supported",
          assessment: "over_50m",
          indicators: [
            {
              kind: "revenue",
              excerpt: "Revenue exceeded $50 million.",
              evidenceId: "size-row",
            },
          ],
        },
        evidenceRefs: [
          supportRef("domain", "Acme Aero LLC"),
          supportRef("website", "AX-10 actuator"),
          supportRef("size", "Revenue exceeded $50 million."),
        ],
      },
    ],
  ])(
    "rejects affirmative %s evidence before model spend",
    async (_label, override) => {
      const call = vi.fn();
      const result = await evaluateJevLadder({
        evidence: packageFixture(sourcedResearch(override)),
        call,
      });

      expect(result).toMatchObject({
        decision: "reject",
        exitRung: "r0-veto",
        callCount: 0,
      });
      expect(call).not.toHaveBeenCalled();
    },
  );

  it("keeps model HP as research while ownership, HQ, or revenue are unknown", async () => {
    const result = await evaluateJevLadder({
      evidence: packageFixture(),
      call: fullLadderCaller("high_priority"),
    });

    expect(result).toMatchObject({
      decision: "research",
      exitRung: "r4",
      callCount: 4,
    });
    expect(result.records.at(-1)).toMatchObject({
      decision: "research",
      terminal: true,
    });
  });

  it("retains HP only with sourced positive mandate evidence", async () => {
    const research = sourcedResearch({
      ownership: {
        status: "independent",
        owner: null,
        year: null,
        supportEvidenceIds: ["ownership-row"],
      },
      size: {
        status: "supported",
        assessment: "under_50m",
        indicators: [
          {
            kind: "revenue",
            excerpt: "The company reports revenue below $50 million.",
            evidenceId: "size-row",
          },
        ],
      },
      headquarters: {
        status: "supported",
        city: "Mobile",
        state: "AL",
        country: "US",
        supportEvidenceIds: ["hq-row"],
      },
      missingFacts: [],
      evidenceRefs: [
        supportRef("domain", "Acme Aero LLC"),
        supportRef("website", "AX-10 actuator"),
        supportRef("ownership", "Acme is independently owned."),
        supportRef("size", "Revenue is below $50 million."),
        supportRef("hq", "Acme is headquartered in Mobile, Alabama, USA."),
      ],
    });
    const result = await evaluateJevLadder({
      evidence: packageFixture(research),
      call: fullLadderCaller("high_priority"),
    });

    expect(result.decision).toBe("high_priority");
  });

  it("counts only a non-NULL terminal rung as the terminal judgment", async () => {
    const seen: JevLadderCallRequest[] = [];
    const result = await evaluateJevLadder({
      evidence: packageFixture(),
      call: async (request) => {
        seen.push(request);
        if (request.rung === "r1") {
          return {
            answers: { manufacturer: { type: "noul", noul: 0.9 } },
            costUsd: 0.01,
            model: "jev",
          };
        }
        if (request.rung === "r2") {
          return {
            answers: {
              product_vs_process: {
                type: "choice",
                choice: "product",
                confidence: 0.8,
              },
            },
            costUsd: 0.01,
            model: "jev",
          };
        }
        if (request.rung === "r3") {
          return {
            answers: { oversize: { type: "noul", noul: 0.1 } },
            costUsd: 0.01,
            model: "jev",
          };
        }
        return {
          answers: {
            disposition: {
              type: "choice",
              choice: "research",
              confidence: 0.75,
            },
          },
          costUsd: 0.01,
          model: "jev",
        };
      },
    });

    expect(seen.map((request) => request.rung)).toEqual([
      "r1",
      "r2",
      "r3",
      "r4",
    ]);
    expect(result).toMatchObject({
      decision: "research",
      exitRung: "r4",
      callCount: 4,
      costUsd: 0.04,
    });
    expect(result.records.filter((record) => record.terminal)).toHaveLength(1);
    expect(
      result.records.slice(0, -1).every((record) => !record.terminal),
    ).toBe(true);
    expect(
      result.records.slice(0, -1).every((record) => record.decision === null),
    ).toBe(true);
  });

  it("propagates provider errors instead of fabricating research", async () => {
    await expect(
      evaluateJevLadder({
        evidence: packageFixture(),
        call: async () => {
          throw new Error("provider unavailable");
        },
      }),
    ).rejects.toThrow("provider unavailable");
  });

  it("rejects malformed final output instead of publishing a judgment", async () => {
    await expect(
      evaluateJevLadder({
        evidence: packageFixture(),
        call: async (request) => {
          if (request.rung === "r1") {
            return {
              answers: { manufacturer: { type: "noul", noul: 0.9 } },
              costUsd: null,
              model: "jev",
            };
          }
          if (request.rung === "r2") {
            return {
              answers: {
                product_vs_process: {
                  type: "choice",
                  choice: "product",
                  confidence: 0.8,
                },
              },
              costUsd: null,
              model: "jev",
            };
          }
          if (request.rung === "r3") {
            return {
              answers: { oversize: { type: "noul", noul: 0.1 } },
              costUsd: null,
              model: "jev",
            };
          }
          return { answers: {}, costUsd: null, model: "jev" };
        },
      }),
    ).rejects.toThrow("terminal disposition");
  });
});

describe("ensemble configuration", () => {
  it("uses intended defaults when optional numeric env values are unset", () => {
    expect(resolveEnsembleConfig({})).toMatchObject({
      jevAuditSampleRate: 0.05,
    });
    expect(
      resolveEnsembleConfig({
        JEV_AUDIT_SAMPLE_RATE: "",
      }),
    ).toMatchObject({
      jevAuditSampleRate: 0.05,
    });
  });
});

function reviewClaim(
  phase: "jev" | "muse",
  overrides: Record<string, unknown> = {},
) {
  return {
    signalId: "00000000-0000-0000-0000-000000000001",
    sourceRevision: 0,
    phase,
    inputHash: null,
    inputManifest: null,
    researchEvidence: sourcedResearch(),
    jevEvaluationId: null,
    nextAttemptAt: new Date("2026-09-28T00:00:00Z"),
    attemptCount: 0,
    lastError: null,
    leaseToken: "00000000-0000-0000-0000-000000000099",
    leaseExpiresAt: new Date("2026-09-28T01:00:00Z"),
    researchDueAt: null,
    lastResearchOutcome: null,
    inputsCheckedAt: null,
    createdAt: new Date("2026-09-28T00:00:00Z"),
    updatedAt: new Date("2026-09-28T00:00:00Z"),
    ...overrides,
  };
}

function unitReviewConfig(): FaaEnsembleConfig {
  return {
    ...resolveEnsembleConfig({}),
    concurrency: 1,
    requestDelayMs: 0,
  };
}

describe("FAA recorded-spend budget gates", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    signalReviewMocks.reconcileChangedSignalReviews.mockResolvedValue(0);
    signalReviewMocks.insertFaaReviewModelUsageReceipt.mockResolvedValue({});
    signalReviewMocks.updateClaimedSignalReviewInput.mockImplementation(
      async (_db, claim, input) => ({ ...claim, ...input }),
    );
    signalReviewMocks.failSignalReview.mockResolvedValue({});
    signalReviewMocks.commitSignalReview.mockResolvedValue({
      accepted: true,
      value: undefined,
      state: {},
    });
  });

  it("fails closed when recorded spend cannot be read", async () => {
    const db = {
      execute: vi.fn(async () => ({ rows: [{ total: null }] })),
    };

    await expect(
      getDailySpendUsd(new Date("2026-09-28T12:00:00Z"), db as never),
    ).rejects.toThrow("invalid total");
  });

  it("defers an exhausted JEv claim without a paid call or judgment", async () => {
    const claim = reviewClaim("jev");
    signalReviewMocks.claimSignalReviews.mockResolvedValue([claim]);
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [sourceRow()] }),
    };
    const callJev = vi.fn(fullLadderCaller("research"));
    const readSpend = vi.fn(async () => 1);

    const summary = await runJevReviews(
      db as never,
      { limit: 1, concurrency: 1 },
      {
        config: unitReviewConfig(),
        callJev,
        getDailySpendUsd: readSpend,
        dailyBudgetCapUsd: () => 1,
      },
    );

    expect(summary).toMatchObject({
      screened: 0,
      deferred: 1,
      errors: 0,
      stale: 0,
    });
    expect(readSpend).toHaveBeenCalledOnce();
    expect(callJev).not.toHaveBeenCalled();
    expect(signalReviewMocks.commitSignalReview).not.toHaveBeenCalled();
    expect(signalReviewMocks.failSignalReview).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ signalId: claim.signalId, attemptCount: 0 }),
      expect.stringContaining("Daily model budget exhausted"),
      { deferred: true },
    );
  });

  it("defers a Muse claim when accounting is unreadable", async () => {
    const config = unitReviewConfig();
    const evidence = packageFixture();
    const manifest = buildFaaReviewInputManifest(evidence, config, 0);
    const inputHash = hashFaaReviewInput(manifest);
    const claim = reviewClaim("muse", {
      inputHash,
      inputManifest: manifest,
      jevEvaluationId: "00000000-0000-0000-0000-000000000010",
    });
    signalReviewMocks.claimSignalReviews.mockResolvedValue([claim]);
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [sourceRow()] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: claim.jevEvaluationId,
              decision: "research",
              confidence: "0.8",
              input_hash: inputHash,
            },
          ],
        }),
    };
    const evaluateModel = vi.fn();

    const summary = await runMuseReviews(
      db as never,
      { limit: 1, concurrency: 1 },
      {
        config,
        evaluateModel,
        getDailySpendUsd: vi.fn(async () => {
          throw new Error("database unavailable");
        }),
        dailyBudgetCapUsd: () => 1,
      },
    );

    expect(summary).toEqual({
      verified: 0,
      confirmed: 0,
      overruled: 0,
      deferred: 1,
      costUsd: 0,
      errors: 0,
      stale: 0,
    });
    expect(evaluateModel).not.toHaveBeenCalled();
    expect(signalReviewMocks.commitSignalReview).not.toHaveBeenCalled();
    expect(signalReviewMocks.failSignalReview).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ signalId: claim.signalId, attemptCount: 0 }),
      expect.stringContaining("accounting unavailable"),
      { deferred: true },
    );
  });

  it("keeps an observed first-rung charge when a later JEv rung fails", async () => {
    const claim = reviewClaim("jev");
    signalReviewMocks.claimSignalReviews.mockResolvedValue([claim]);
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [sourceRow()] }),
    };
    const callJev = vi
      .fn()
      .mockResolvedValueOnce({
        answers: { manufacturer: { type: "noul", noul: 0.9 } },
        costUsd: 0.1234,
        model: "typesafe/jev-returned",
      })
      .mockRejectedValueOnce(new Error("later rung failed"));

    const summary = await runJevReviews(
      db as never,
      { limit: 1, concurrency: 1 },
      {
        config: unitReviewConfig(),
        callJev,
        getDailySpendUsd: async () => 0,
        dailyBudgetCapUsd: () => 1,
      },
    );

    expect(summary).toMatchObject({
      screened: 0,
      costUsd: 0.1234,
      errors: 1,
      stale: 0,
    });
    expect(
      signalReviewMocks.insertFaaReviewModelUsageReceipt,
    ).toHaveBeenCalledOnce();
    expect(
      signalReviewMocks.insertFaaReviewModelUsageReceipt,
    ).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        sourceSignalId: claim.signalId,
        configuredModel: unitReviewConfig().jevModel,
        returnedModel: "typesafe/jev-returned",
        phase: "jev",
        rung: "r1",
        costUsd: "0.1234",
      }),
    );
    expect(signalReviewMocks.commitSignalReview).not.toHaveBeenCalled();
  });

  it("defers a quota-exhausted later JEv rung and retains prior spend", async () => {
    const claim = reviewClaim("jev");
    signalReviewMocks.claimSignalReviews.mockResolvedValue([claim]);
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [sourceRow()] }),
    };
    const callJev = vi
      .fn()
      .mockResolvedValueOnce({
        answers: { manufacturer: { type: "noul", noul: 0.9 } },
        costUsd: 0.1234,
        model: "typesafe/jev-returned",
      })
      .mockRejectedValueOnce(
        new OpenRouterClientError("quota_exhausted", false),
      );

    const summary = await runJevReviews(
      db as never,
      { limit: 1, concurrency: 1 },
      {
        config: unitReviewConfig(),
        callJev,
        getDailySpendUsd: async () => 0,
        dailyBudgetCapUsd: () => 1,
      },
    );

    expect(summary).toMatchObject({
      screened: 0,
      costUsd: 0.1234,
      deferred: 1,
      errors: 0,
      stale: 0,
    });
    expect(callJev).toHaveBeenCalledTimes(2);
    expect(
      signalReviewMocks.insertFaaReviewModelUsageReceipt,
    ).toHaveBeenCalledOnce();
    expect(
      signalReviewMocks.insertFaaReviewModelUsageReceipt,
    ).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        sourceSignalId: claim.signalId,
        returnedModel: "typesafe/jev-returned",
        rung: "r1",
        costUsd: "0.1234",
      }),
    );
    expect(signalReviewMocks.commitSignalReview).not.toHaveBeenCalled();
  });

  it("counts a paid JEv response even when the lease fence rejects publication", async () => {
    const claim = reviewClaim("jev");
    signalReviewMocks.claimSignalReviews.mockResolvedValue([claim]);
    signalReviewMocks.commitSignalReview.mockResolvedValue({ accepted: false });
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [sourceRow()] })
        .mockResolvedValueOnce({ rows: [sourceRow()] }),
    };

    const summary = await runJevReviews(
      db as never,
      { limit: 1, concurrency: 1 },
      {
        config: unitReviewConfig(),
        callJev: async () => ({
          answers: { manufacturer: { type: "noul", noul: 0.1 } },
          costUsd: 0.2,
          model: "typesafe/jev-returned",
        }),
        getDailySpendUsd: async () => 0,
        dailyBudgetCapUsd: () => 1,
      },
    );

    expect(summary).toMatchObject({
      screened: 0,
      costUsd: 0.2,
      errors: 0,
      stale: 1,
    });
    expect(
      signalReviewMocks.insertFaaReviewModelUsageReceipt,
    ).toHaveBeenCalledOnce();
  });

  it("records Muse spend before a later source/currentness failure", async () => {
    const config = unitReviewConfig();
    const evidence = packageFixture();
    const manifest = buildFaaReviewInputManifest(evidence, config, 0);
    const inputHash = hashFaaReviewInput(manifest);
    const claim = reviewClaim("muse", {
      inputHash,
      inputManifest: manifest,
      jevEvaluationId: "00000000-0000-0000-0000-000000000010",
    });
    signalReviewMocks.claimSignalReviews.mockResolvedValue([claim]);
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [sourceRow()] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: claim.jevEvaluationId,
              decision: "research",
              confidence: "80",
              input_hash: inputHash,
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] }),
    };

    const summary = await runMuseReviews(
      db as never,
      { limit: 1, concurrency: 1 },
      {
        config,
        evaluateModel: async () => ({
          ok: true,
          result: {
            decision: "research",
            confidence: 80,
            company_type: "manufacturer",
            aerospace_defense_relevance: "moderate",
            manufacturing_evidence: "moderate",
            thesis_signals: [],
            disqualifiers: [],
            missing_evidence: [],
            false_negative_risk: "medium",
            reason: "controlled response",
            proprietary_product_evidence: "weak",
            proprietary_process_only: false,
            website_products_menu: true,
            size_indicators: [],
            likely_oversize: false,
            suggested_priority: 2,
          },
          rawResponse: "{}",
          tokens: { input: 1, output: 1, total: 2 },
          costUsd: 0.3,
          returnedModel: "meta/muse-returned",
        }),
        getDailySpendUsd: async () => 0,
        dailyBudgetCapUsd: () => 1,
      },
    );

    expect(summary).toEqual({
      verified: 0,
      confirmed: 0,
      overruled: 0,
      costUsd: 0.3,
      deferred: 0,
      errors: 0,
      stale: 1,
    });
    expect(
      signalReviewMocks.insertFaaReviewModelUsageReceipt,
    ).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        sourceSignalId: claim.signalId,
        configuredModel: config.modelA,
        returnedModel: "meta/muse-returned",
        phase: "muse",
        costUsd: "0.3",
      }),
    );
    expect(signalReviewMocks.commitSignalReview).not.toHaveBeenCalled();
  });

  it("records known Muse costs when an injected adapter throws", async () => {
    const config = unitReviewConfig();
    const evidence = packageFixture();
    const manifest = buildFaaReviewInputManifest(evidence, config, 0);
    const inputHash = hashFaaReviewInput(manifest);
    const claim = reviewClaim("muse", {
      inputHash,
      inputManifest: manifest,
      jevEvaluationId: "00000000-0000-0000-0000-000000000010",
    });
    signalReviewMocks.claimSignalReviews.mockResolvedValue([claim]);
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [sourceRow()] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: claim.jevEvaluationId,
              decision: "research",
              confidence: "80",
              input_hash: inputHash,
            },
          ],
        }),
    };

    const summary = await runMuseReviews(
      db as never,
      { limit: 1, concurrency: 1 },
      {
        config,
        evaluateModel: async () => {
          throw new OpenRouterClientError("invalid_structured_output", false, [
            {
              attempt: 1,
              model: "meta/muse-observed-first",
              provider: "controlled-test",
              status: "schema_error",
              httpStatus: 200,
              promptSha256: "prompt-sha",
              responseSha256: "first-response-sha",
              inputTokens: 2,
              outputTokens: 2,
              totalTokens: 4,
              costUsd: 0.11,
              latencyMs: 1,
              retryDelayMs: null,
              errorCode: "invalid_structured_output",
            },
            {
              attempt: 2,
              model: "meta/muse-observed-final",
              provider: "controlled-test",
              status: "schema_error",
              httpStatus: 200,
              promptSha256: "prompt-sha",
              responseSha256: "final-response-sha",
              inputTokens: 2,
              outputTokens: 2,
              totalTokens: 4,
              costUsd: 0.11,
              latencyMs: 1,
              retryDelayMs: null,
              errorCode: "invalid_structured_output",
            },
          ]);
        },
        getDailySpendUsd: async () => 0,
        dailyBudgetCapUsd: () => 1,
      },
    );

    expect(summary).toEqual({
      verified: 0,
      confirmed: 0,
      overruled: 0,
      costUsd: 0.22,
      deferred: 0,
      errors: 1,
      stale: 0,
    });
    expect(
      signalReviewMocks.insertFaaReviewModelUsageReceipt,
    ).toHaveBeenCalledOnce();
    expect(
      signalReviewMocks.insertFaaReviewModelUsageReceipt,
    ).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        sourceSignalId: claim.signalId,
        configuredModel: config.modelA,
        returnedModel: "meta/muse-observed-final",
        phase: "muse",
        costUsd: "0.22",
      }),
    );
    expect(signalReviewMocks.failSignalReview).toHaveBeenCalledWith(
      db,
      claim,
      "OpenRouter returned invalid structured output",
    );
    expect(signalReviewMocks.commitSignalReview).not.toHaveBeenCalled();
  });

  it("defers quota-exhausted Muse while retaining billed attempts and JEv linkage", async () => {
    const config = unitReviewConfig();
    const evidence = packageFixture();
    const manifest = buildFaaReviewInputManifest(evidence, config, 0);
    const inputHash = hashFaaReviewInput(manifest);
    const claim = reviewClaim("muse", {
      inputHash,
      inputManifest: manifest,
      jevEvaluationId: "00000000-0000-0000-0000-000000000010",
    });
    signalReviewMocks.claimSignalReviews.mockResolvedValue([claim]);
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [sourceRow()] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: claim.jevEvaluationId,
              decision: "research",
              confidence: "80",
              input_hash: inputHash,
            },
          ],
        }),
    };

    const summary = await runMuseReviews(
      db as never,
      { limit: 1, concurrency: 1 },
      {
        config,
        evaluateModel: async () => {
          throw new OpenRouterClientError("quota_exhausted", false, [
            {
              attempt: 1,
              model: "meta/muse-billed-before-quota",
              provider: "controlled-test",
              status: "schema_error",
              httpStatus: 200,
              promptSha256: "prompt-sha",
              responseSha256: "billed-response-sha",
              inputTokens: 2,
              outputTokens: 2,
              totalTokens: 4,
              costUsd: 0.11,
              latencyMs: 1,
              retryDelayMs: null,
              errorCode: "invalid_structured_output",
            },
            {
              attempt: 2,
              model: config.modelA,
              provider: null,
              status: "failed",
              httpStatus: 403,
              promptSha256: "prompt-sha",
              responseSha256: null,
              inputTokens: null,
              outputTokens: null,
              totalTokens: null,
              costUsd: null,
              latencyMs: 1,
              retryDelayMs: null,
              errorCode: "quota_exhausted",
            },
          ]);
        },
        getDailySpendUsd: async () => 0,
        dailyBudgetCapUsd: () => 1,
      },
    );

    expect(summary).toEqual({
      verified: 0,
      confirmed: 0,
      overruled: 0,
      costUsd: 0.11,
      deferred: 1,
      errors: 0,
      stale: 0,
    });
    expect(
      signalReviewMocks.insertFaaReviewModelUsageReceipt,
    ).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        sourceSignalId: claim.signalId,
        returnedModel: "meta/muse-billed-before-quota",
        phase: "muse",
        costUsd: "0.11",
      }),
    );
    expect(signalReviewMocks.commitSignalReview).not.toHaveBeenCalled();
  });

  it("keeps an unknown failed Muse cost nullable", async () => {
    const config = unitReviewConfig();
    const evidence = packageFixture();
    const manifest = buildFaaReviewInputManifest(evidence, config, 0);
    const inputHash = hashFaaReviewInput(manifest);
    const claim = reviewClaim("muse", {
      inputHash,
      inputManifest: manifest,
      jevEvaluationId: "00000000-0000-0000-0000-000000000010",
    });
    signalReviewMocks.claimSignalReviews.mockResolvedValue([claim]);
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [sourceRow()] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: claim.jevEvaluationId,
              decision: "research",
              confidence: "80",
              input_hash: inputHash,
            },
          ],
        }),
    };

    const summary = await runMuseReviews(
      db as never,
      { limit: 1, concurrency: 1 },
      {
        config,
        evaluateModel: async () => {
          throw new OpenRouterClientError("network_error", true, [
            {
              attempt: 1,
              model: config.modelA,
              provider: null,
              status: "transient_error",
              httpStatus: null,
              promptSha256: "prompt-sha",
              responseSha256: null,
              inputTokens: null,
              outputTokens: null,
              totalTokens: null,
              costUsd: null,
              latencyMs: 1,
              retryDelayMs: null,
              errorCode: "network_error",
            },
          ]);
        },
        getDailySpendUsd: async () => 0,
        dailyBudgetCapUsd: () => 1,
      },
    );

    expect(summary).toMatchObject({ costUsd: 0, errors: 1 });
    expect(
      signalReviewMocks.insertFaaReviewModelUsageReceipt,
    ).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        returnedModel: null,
        phase: "muse",
        costUsd: null,
      }),
    );
    expect(signalReviewMocks.commitSignalReview).not.toHaveBeenCalled();
  });

  it("preserves deterministic JEv progress when no paid call is needed", async () => {
    const research = sourcedResearch({
      ownership: {
        status: "public_parent",
        owner: "Public Parent",
        year: null,
        supportEvidenceIds: ["ownership-row"],
      },
      evidenceRefs: [
        supportRef("domain", "Acme Aero LLC"),
        supportRef("website", "AX-10 actuator"),
        supportRef("ownership", "Acme is a subsidiary of Public Parent."),
      ],
    });
    const claim = reviewClaim("jev", { researchEvidence: research });
    signalReviewMocks.claimSignalReviews.mockResolvedValue([claim]);
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValue({ rows: [sourceRow()] }),
    };
    const callJev = vi.fn();
    const readSpend = vi.fn(async () => 1);

    const summary = await runJevReviews(
      db as never,
      { limit: 1, concurrency: 1 },
      {
        config: unitReviewConfig(),
        callJev,
        getDailySpendUsd: readSpend,
        dailyBudgetCapUsd: () => 1,
      },
    );

    expect(summary).toMatchObject({
      screened: 1,
      rejected: 1,
      deferred: 0,
      errors: 0,
    });
    expect(readSpend).not.toHaveBeenCalled();
    expect(callJev).not.toHaveBeenCalled();
    expect(signalReviewMocks.commitSignalReview).toHaveBeenCalledOnce();
  });
});
