import { describe, expect, it, vi } from "vitest";
import type * as DatabaseModule from "@asi/database";

import {
  type AcquisitionResearchOutcome,
  classifySentence,
  researchAcquisitionHistory as researchAcquisitionHistoryAccounted,
  type ResearchAcquisitionHistoryOptions,
} from "../packages/research/src/enrichment/ownership.js";
import { SafeFetchError } from "../packages/research/src/safe-fetch.js";
import type { ExaSearchResult } from "../packages/research/src/search/exa.js";

const providerAccounting = vi.hoisted(() => {
  const receipt = {
    id: "00000000-0000-4000-8000-000000000090",
    actualCostUsd: null,
  };
  return {
    reserve: vi.fn(async () => ({
      outcome: "reserved" as const,
      reused: false,
      reservation: receipt,
    })),
    settle: vi.fn(async () => receipt),
  };
});

vi.mock("@asi/database", async (importOriginal) => {
  const actual = await importOriginal<typeof DatabaseModule>();
  return {
    ...actual,
    reserveResearchProviderUsage: providerAccounting.reserve,
    settleResearchProviderUsage: providerAccounting.settle,
  };
});

const testAccounting = {
  db: {} as never,
  budgetScopeId: "ownership-test-scope",
  sourceSignalId: "00000000-0000-4000-8000-000000000091",
  dailyCapUsd: "1",
} as const;

function metadataSearch(
  search: () => Promise<readonly ExaSearchResult[]>,
) {
  return vi.fn(async () => ({
    results: await search(),
    providerCostUsd: null,
  }));
}

function researchAcquisitionHistory(
  apiKey: string,
  companyName: string,
  domain?: string,
  options: ResearchAcquisitionHistoryOptions = {},
): Promise<AcquisitionResearchOutcome> {
  return researchAcquisitionHistoryAccounted(apiKey, companyName, domain, {
    accounting: testAccounting,
    ...options,
  });
}

interface OwnershipSourceFixture {
  readonly url: string;
  readonly content: string;
  readonly contentSha256: string;
  readonly retrievedAt: string;
}

function researchBeaconSources(
  sources: readonly OwnershipSourceFixture[],
): Promise<AcquisitionResearchOutcome> {
  return researchAcquisitionHistory(
    "test-key",
    "Beacon Aerospace LLC",
    "beaconaerospace.example",
    {
      client: {
        searchWithMetadata: metadataSearch(async () =>
          sources.map((source, index) => ({
            title: `Ownership source ${index + 1}`,
            url: source.url,
            text: "Discovery only.",
            score: 1 - index / 10,
          })),
        ),
      },
      fetchUrl: vi.fn(async (url: string) => {
        const source = sources.find((candidate) => candidate.url === url);
        if (source === undefined) throw new Error(`Missing fixture for ${url}`);
        return {
          requestedUrl: url,
          finalUrl: url,
          contentType: "text/html" as const,
          content: `<html><body><p>${source.content}</p></body></html>`,
          byteLength: source.content.length,
          contentSha256: source.contentSha256,
          retrievedAt: source.retrievedAt,
          durationMs: 10,
          redirects: [],
        };
      }),
    },
  );
}

function overlengthAtlasClaim(): string {
  return `Following an extensive strategic review ${"and extensive financing review ".repeat(60)}, Beacon Aerospace LLC is currently a subsidiary of Atlas Group.`;
}

describe("classifySentence acquisition verbs", () => {
  it("catches Completes/Announces Acquisition headlines", () => {
    expect(
      classifySentence(
        "TransDigm Completes Acquisition of DART Aerospace",
        "Dart Aerospace",
      ),
    ).toMatchObject({ status: "acquired", owner: "TransDigm" });
    expect(
      classifySentence(
        "TransDigm Announces Acquisition of DART Aerospace",
        "Dart Aerospace",
      ),
    ).toMatchObject({ status: "acquired", owner: "TransDigm" });
  });

  it("attributes strategic acquisition headlines only to a complete subject", () => {
    const predicateOnly =
      "Enhances Critical Aerospace Capabilities With Acquisition of PB Fasteners";
    expect(classifySentence(predicateOnly, "PB Fasteners")).toMatchObject({
      status: "acquired",
      owner: null,
      currentRelation: false,
    });
    expect(
      classifySentence(
        `Precision Castparts Corp. ${predicateOnly}`,
        "PB Fasteners",
      ),
    ).toMatchObject({
      status: "acquired",
      owner: "Precision Castparts Corp",
      currentRelation: false,
    });
  });

  it("does not borrow headline decoration as the strategic buyer", () => {
    expect(
      classifySentence(
        "Industry commentary discussed Legacy Holdings Inc. Enhances Critical Aerospace Capabilities With Acquisition of PB Fasteners",
        "PB Fasteners",
      ),
    ).toMatchObject({
      status: "acquired",
      owner: null,
      currentRelation: false,
    });
  });

  it.each([
    "Precision Castparts Corp. may enhance critical aerospace capabilities with acquisition of PB Fasteners.",
    "Precision Castparts Corp. plans to enhance critical aerospace capabilities through acquisition of PB Fasteners.",
    "Precision Castparts Corp. Enhances Critical Aerospace Capabilities With Acquisition of PB Fasteners, subject to regulatory approval.",
  ])(
    "does not treat a proposed or conditional strategic headline as completed",
    (sentence) => {
      expect(classifySentence(sentence, "PB Fasteners")).toBeNull();
    },
  );

  it.each([
    "Enhanced Critical Aerospace Capabilities With Acquisition of PB Fasteners",
    "Accelerates Aerospace Growth Through Acquisition of PB Fasteners",
    "Precision Castparts Corp. will accelerate aerospace growth through acquisition of PB Fasteners",
  ])(
    "fails closed for unsupported connector-governed acquisition syntax",
    (sentence) => {
      expect(classifySentence(sentence, "PB Fasteners")).toBeNull();
    },
  );

  it.each([
    "Atlas Group has not acquired Beacon Aerospace LLC.",
    "Atlas Group never acquired Beacon Aerospace LLC.",
    "Regulators denied Atlas Group's acquisition of Beacon Aerospace LLC.",
    "Atlas Group plans to acquire Beacon Aerospace LLC.",
    "Atlas Group to acquire Beacon Aerospace LLC.",
    "Atlas Group may acquire Beacon Aerospace LLC if regulators approve.",
    "If Atlas Group acquires Beacon Aerospace LLC, it will expand production.",
  ])(
    "does not treat a denied, proposed, or conditional transaction as ownership",
    (sentence) => {
      expect(classifySentence(sentence, "Beacon Aerospace LLC")).toBeNull();
    },
  );

  it.each([
    "Atlas Group acquired Beacon Aerospace LLC in 2024.",
    "Atlas Group has not only acquired Beacon Aerospace LLC but also retained its workforce.",
    "Atlas Group acquired Beacon Aerospace LLC but did not acquire its supplier.",
  ])(
    "keeps an affirmative target predicate despite nearby wording",
    (sentence) => {
      expect(classifySentence(sentence, "Beacon Aerospace LLC")).toMatchObject({
        status: "acquired",
        owner: "Atlas Group",
      });
    },
  );

  it("still catches acquired-by phrasing", () => {
    expect(
      classifySentence(
        "Dart Aerospace was acquired by TransDigm in 2022",
        "Dart Aerospace",
      ),
    ).toMatchObject({ status: "acquired" });
  });

  it("recognizes a bare acquired-by headline with the target as subject", () => {
    expect(
      classifySentence("ADPma Acquired by Mollenhour Gross", "ADPma, LLC"),
    ).toMatchObject({
      status: "acquired",
      owner: "Mollenhour Gross",
    });
  });

  it("recognizes a bounded recent-adverb passive acquisition", () => {
    expect(
      classifySentence(
        "ADPma has recently been acquired by Mollenhour Gross",
        "ADPma, LLC",
      ),
    ).toMatchObject({
      status: "acquired",
      owner: "Mollenhour Gross",
    });
    expect(
      classifySentence(
        'ADPma has recently been acquired by "buy and grow" private investors',
        "ADPma, LLC",
      ),
    ).toMatchObject({ status: "acquired", owner: null });
    expect(
      classifySentence("ADPma acquired Infinite Widgets", "ADPma, LLC"),
    ).toBeNull();
  });

  it("bounds passive buyer names before transaction prose", () => {
    expect(
      classifySentence(
        "Beacon Aerospace LLC was acquired by Atlas Group to expand its aerospace portfolio.",
        "Beacon Aerospace LLC",
      ),
    ).toMatchObject({ status: "acquired", owner: "Atlas Group" });
    expect(
      classifySentence(
        "Beacon Aerospace LLC has been acquired by private investors committed to supporting growth.",
        "Beacon Aerospace LLC",
      ),
    ).toMatchObject({ status: "acquired", owner: null });
  });

  it("bounds an all-caps buyer before a transaction-purpose clause", () => {
    expect(
      classifySentence(
        "BEACON AEROSPACE LLC WAS ACQUIRED BY ATLAS GROUP TO EXPAND ITS AEROSPACE PORTFOLIO.",
        "Beacon Aerospace LLC",
      ),
    ).toMatchObject({ status: "acquired", owner: "ATLAS GROUP" });
  });

  it("does not truncate a hyphenated buyer name at a purpose-word prefix", () => {
    expect(
      classifySentence(
        "Beacon Aerospace LLC was acquired by Atlas To-Go Holdings to expand its aerospace portfolio.",
        "Beacon Aerospace LLC",
      ),
    ).toMatchObject({ status: "acquired", owner: "Atlas To-Go Holdings" });
  });

  it("extracts possessive buyers without absorbing transaction-event prose", () => {
    const headline =
      "TransDigm and Servotronics Announce Successful Completion of Tender Offer and TransDigm's Acquisition of Servotronics - TransDigm Group Inc. TransDigm and Servotronics Announce Successful Completion of Tender Offer and TransDigm's Acquisition of Servotronics";
    expect(classifySentence(headline, "Servotronics, Inc.")).toMatchObject({
      status: "acquired",
      owner: "TransDigm",
    });
    expect(
      classifySentence(
        "Smith & Wesson Holdings LLC's Acquisition of Beacon Aerospace LLC",
        "Beacon Aerospace LLC",
      ),
    ).toMatchObject({
      status: "acquired",
      owner: "Smith & Wesson Holdings LLC",
    });
  });

  it("recognizes a plain owned-by relationship only when the target is the subject", () => {
    expect(
      classifySentence(
        "Dart Aerospace is owned by ParentCo.",
        "Dart Aerospace",
      ),
    ).toMatchObject({ status: "acquired", owner: "ParentCo" });
    expect(
      classifySentence(
        "Dart Aerospace supplies rotor parts; Atlas Components is owned by MegaHoldings.",
        "Dart Aerospace",
      ),
    ).toBeNull();
  });
  it("does not vote without an owner", () => {
    expect(
      classifySentence("The company announced growth plans", "Dart Aerospace"),
    ).toBeNull();
  });

  it("does not attribute another company's acquisition to the target", () => {
    expect(
      classifySentence(
        "Atlas Components was acquired by MegaHoldings.",
        "Dart Aerospace",
      ),
    ).toBeNull();
    expect(
      classifySentence(
        "Dart Aerospace supplies rotor parts; Atlas Components was acquired by MegaHoldings.",
        "Dart Aerospace",
      ),
    ).toBeNull();
    expect(
      classifySentence(
        "MegaHoldings acquired Infinite Dart Aerospace.",
        "Dart Aerospace",
      ),
    ).toBeNull();
    expect(
      classifySentence(
        "Dart Aerospace's customer was acquired by MegaHoldings.",
        "Dart Aerospace",
      ),
    ).toBeNull();
  });
});

describe("researchAcquisitionHistory source confirmation", () => {
  it("does not affirm an acquisition from a search snippet when the retrieved page is unrelated", async () => {
    vi.stubEnv("EXA_DAILY_BUDGET_USD", "99999");
    const result = await researchAcquisitionHistory(
      "test-key",
      "Dart Aerospace",
      "dartaerospace.com",
      {
        client: {
          searchWithMetadata: metadataSearch(async () => [
            {
              title: "TransDigm completes acquisition of DART Aerospace",
              url: "https://news.example/acquisition",
              text: "DART Aerospace was acquired by TransDigm.",
              score: 1,
            },
          ]),
        },
        fetchUrl: vi.fn(async (url: string) => ({
          requestedUrl: url,
          finalUrl: url,
          contentType: "text/html" as const,
          content:
            "<html><body>This article concerns an unrelated consumer business and contains no target identity.</body></html>",
          byteLength: 120,
          contentSha256: "a".repeat(64),
          retrievedAt: "2026-09-27T12:00:00.000Z",
          durationMs: 10,
          redirects: [],
        })),
      },
    );

    expect(result.outcome).toBe("no_evidence");
    expect(result.finding.status).toBe("unknown");
    expect(result.checkedSources).toEqual([
      expect.objectContaining({ outcome: "identity_mismatch" }),
    ]);
    vi.unstubAllEnvs();
  });

  it("retains a dated acquisition as checked history without claiming the current owner", async () => {
    vi.stubEnv("EXA_DAILY_BUDGET_USD", "99999");
    const result = await researchAcquisitionHistory(
      "test-key",
      "Dart Aerospace, Inc.",
      "dartaerospace.com",
      {
        client: {
          searchWithMetadata: metadataSearch(async () => [
            {
              title: "Transaction announcement",
              url: "https://news.example/transaction",
              text: "Search discovery result.",
              score: 1,
            },
          ]),
        },
        fetchUrl: vi.fn(async (url: string) => ({
          requestedUrl: url,
          finalUrl: url,
          contentType: "text/html" as const,
          content:
            "<html><body>Dart Aerospace, Inc. was acquired by TransDigm in 2022. The transaction announcement identifies DART Aerospace as the exact target company.</body></html>",
          byteLength: 180,
          contentSha256: "b".repeat(64),
          retrievedAt: "2026-09-27T12:00:00.000Z",
          durationMs: 10,
          redirects: [],
        })),
      },
    );

    expect(result.outcome).toBe("no_evidence");
    expect(result.finding.status).toBe("unknown");
    expect(result.checkedSources).toEqual([
      expect.objectContaining({
        outcome: "retrieved",
        contentSha256: "b".repeat(64),
      }),
    ]);
    vi.unstubAllEnvs();
  });

  it("keeps an acquisition headline as history rather than current ownership", async () => {
    vi.stubEnv("EXA_DAILY_BUDGET_USD", "99999");
    const result = await researchAcquisitionHistory(
      "test-key",
      "ADPma, LLC",
      "adpma.com",
      {
        client: {
          searchWithMetadata: metadataSearch(async () => [
            {
              title: "ADPma Acquired by Mollenhour Gross",
              url: "https://news.example/adpma-transaction",
              text: "Discovery only.",
              score: 1,
            },
          ]),
        },
        fetchUrl: vi.fn(async (url: string) => ({
          requestedUrl: url,
          finalUrl: url,
          contentType: "text/html" as const,
          content: [
            "<html><head><title>ADPma Acquired by Mollenhour Gross</title></head>",
            "<body><nav>News Releases</nav>",
            "<h1>ADPma Acquired by Mollenhour Gross</h1>",
            "<p>ADPma, LLC, an aerospace parts company located in Piney Flats, TN, announced the next chapter in its history.</p>",
            "<p>Owners Rick Rathbun, David Blythe, and Rick Wedgeworth sold the business to Mollenhour Gross.</p>",
            "</body></html>",
          ].join(""),
          byteLength: 420,
          contentSha256: "e".repeat(64),
          retrievedAt: "2026-09-28T10:03:27.000Z",
          durationMs: 10,
          redirects: [],
        })),
      },
    );

    expect(result.outcome).toBe("no_evidence");
    expect(result.finding.status).toBe("unknown");
    expect(result.checkedSources).toEqual([
      expect.objectContaining({
        url: "https://news.example/adpma-transaction",
        outcome: "retrieved",
      }),
    ]);
    vi.unstubAllEnvs();
  });

  it("does not affirm from a complete proof that exceeds the excerpt bound", async () => {
    vi.stubEnv("EXA_DAILY_BUDGET_USD", "99999");
    const result = await researchBeaconSources([
      {
        url: "https://news.example/overlength-transaction",
        content: overlengthAtlasClaim(),
        contentSha256: "f".repeat(64),
        retrievedAt: "2026-09-28T12:00:00.000Z",
      },
    ]);

    expect(result).toMatchObject({
      outcome: "no_evidence",
      finding: {
        status: "unknown",
        owner: null,
        year: null,
        excerpt: null,
        sourceUrl: null,
      },
    });
    vi.unstubAllEnvs();
  });

  it("does not convert a named past buyer into the current owner", async () => {
    vi.stubEnv("EXA_DAILY_BUDGET_USD", "99999");
    const result = await researchBeaconSources([
      {
        url: "https://news.example/unknown-buyer",
        content:
          "Beacon Aerospace LLC was acquired by private investors committed to supporting growth.",
        contentSha256: "1".repeat(64),
        retrievedAt: "2026-09-28T12:01:00.000Z",
      },
      {
        url: "https://news.example/named-buyer",
        content: "Atlas Group acquired Beacon Aerospace LLC in 2024.",
        contentSha256: "2".repeat(64),
        retrievedAt: "2026-09-28T12:02:00.000Z",
      },
    ]);

    expect(result).toMatchObject({
      outcome: "no_evidence",
      finding: {
        status: "unknown",
        owner: null,
        year: null,
        excerpt: null,
        sourceUrl: null,
      },
    });
    expect(result.checkedSources).toHaveLength(2);
    vi.unstubAllEnvs();
  });

  it("accepts an explicit present-tense ownership relationship", async () => {
    const result = await researchBeaconSources([
      {
        url: "https://atlas.example/portfolio/beacon",
        content: "Beacon Aerospace LLC is a subsidiary of Atlas Group.",
        contentSha256: "3".repeat(64),
        retrievedAt: "2026-09-28T12:03:00.000Z",
      },
    ]);

    expect(result).toMatchObject({
      outcome: "affirmative",
      finding: {
        status: "acquired",
        owner: "Atlas Group",
        excerpt: "Beacon Aerospace LLC is a subsidiary of Atlas Group.",
      },
    });
  });

  it.each([
    {
      conflictKind: "owner",
      statement:
        "Beacon Aerospace LLC is currently a subsidiary of Orion Holdings.",
    },
  ])(
    "keeps a conflicting $conflictKind vote even when another claim is overlength",
    async ({ statement }) => {
      vi.stubEnv("EXA_DAILY_BUDGET_USD", "99999");
      const result = await researchBeaconSources([
        {
          url: "https://news.example/overlength-atlas-claim",
          content: overlengthAtlasClaim(),
          contentSha256: "3".repeat(64),
          retrievedAt: "2026-09-28T12:03:00.000Z",
        },
        {
          url: "https://news.example/conflicting-claim",
          content: statement,
          contentSha256: "4".repeat(64),
          retrievedAt: "2026-09-28T12:04:00.000Z",
        },
      ]);

      expect(result).toMatchObject({
        outcome: "no_evidence",
        finding: {
          status: "unknown",
          owner: null,
          year: null,
          excerpt: null,
          sourceUrl: null,
        },
      });
      vi.unstubAllEnvs();
    },
  );

  it("keeps provider failure distinct from a completed no-evidence search", async () => {
    vi.stubEnv("EXA_DAILY_BUDGET_USD", "99999");
    const result = await researchAcquisitionHistory(
      "test-key",
      "Dart Aerospace",
      "dartaerospace.com",
      {
        client: {
          searchWithMetadata: metadataSearch(async () => {
            throw new Error("temporary provider transport failure");
          }),
        },
      },
    );

    expect(result.outcome).toBe("retryable_error");
    expect(result.finding.status).toBe("unknown");
    vi.unstubAllEnvs();
  });

  it("ignores unrelated acquisition sentences on an identity-matched page", async () => {
    vi.stubEnv("EXA_DAILY_BUDGET_USD", "99999");
    const result = await researchAcquisitionHistory(
      "test-key",
      "Dart Aerospace",
      "dartaerospace.com",
      {
        client: {
          searchWithMetadata: metadataSearch(async () => [
            {
              title: "Industry roundup",
              url: "https://news.example/roundup",
              text: "Dart Aerospace appears in this industry roundup.",
              score: 1,
            },
          ]),
        },
        fetchUrl: vi.fn(async (url: string) => ({
          requestedUrl: url,
          finalUrl: url,
          contentType: "text/html" as const,
          content:
            "<html><body>Dart Aerospace announced a new product line. Atlas Components was acquired by MegaHoldings. Read more company stories.</body></html>",
          byteLength: 160,
          contentSha256: "c".repeat(64),
          retrievedAt: "2026-09-27T12:00:00.000Z",
          durationMs: 10,
          redirects: [],
        })),
      },
    );

    expect(result.outcome).toBe("no_evidence");
    expect(result.finding.status).toBe("unknown");
    vi.unstubAllEnvs();
  });

  it("keeps mixed retrieval failure retryable when retrieved pages are inconclusive", async () => {
    vi.stubEnv("EXA_DAILY_BUDGET_USD", "99999");
    const result = await researchAcquisitionHistory(
      "test-key",
      "Dart Aerospace",
      "dartaerospace.com",
      {
        client: {
          searchWithMetadata: metadataSearch(async () => [
            {
              title: "Transaction report",
              url: "https://news.example/unreachable",
              text: "Potential transaction report.",
              score: 1,
            },
            {
              title: "Company profile",
              url: "https://news.example/profile",
              text: "Dart Aerospace company profile.",
              score: 0.9,
            },
          ]),
        },
        fetchUrl: vi.fn(async (url: string) => {
          if (url.endsWith("/unreachable")) {
            throw new SafeFetchError("timeout");
          }
          return {
            requestedUrl: url,
            finalUrl: url,
            contentType: "text/html" as const,
            content:
              "<html><body>Dart Aerospace manufactures rotorcraft components and announced an expanded product line.</body></html>",
            byteLength: 120,
            contentSha256: "d".repeat(64),
            retrievedAt: "2026-09-27T12:00:00.000Z",
            durationMs: 10,
            redirects: [],
          };
        }),
      },
    );

    expect(result.outcome).toBe("retryable_error");
    expect(result.errorCode).toBe("timeout");
    expect(result.finding.status).toBe("unknown");
    vi.unstubAllEnvs();
  });

  it.each([
    { status: 404, outcome: "no_evidence", errorCode: null },
    { status: 503, outcome: "retryable_error", errorCode: "http_error" },
  ] as const)(
    "keeps an HTTP $status retrieval failure uncertain without misclassifying retryability",
    async ({ status, outcome, errorCode }) => {
      vi.stubEnv("EXA_DAILY_BUDGET_USD", "99999");
      const result = await researchAcquisitionHistory(
        "test-key",
        "Dart Aerospace",
        "dartaerospace.com",
        {
          client: {
            searchWithMetadata: metadataSearch(async () => [
              {
                title: "Company profile",
                url: "https://news.example/company-profile",
                text: "Dart Aerospace company profile.",
                score: 1,
              },
            ]),
          },
          fetchUrl: vi.fn(async () => {
            throw new SafeFetchError("http_error", status);
          }),
        },
      );

      expect(result).toMatchObject({
        outcome,
        finding: { status: "unknown" },
        errorCode,
        checkedSources: [{ outcome: "unreachable" }],
      });
      vi.unstubAllEnvs();
    },
  );
});
