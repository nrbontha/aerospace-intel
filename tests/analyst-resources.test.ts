import { beforeEach, describe, expect, it, vi } from "vitest";

const accountingMocks = vi.hoisted(() => ({
  reserve: vi.fn(),
  settle: vi.fn(),
}));

vi.mock("@asi/database", () => ({
  reserveResearchProviderUsage: accountingMocks.reserve,
  settleResearchProviderUsage: accountingMocks.settle,
}));

import {
  AnalystPaidResourceDisabledError,
  createAnalystResourceExecutor,
  type AnalystResourceContext,
} from "../packages/research/src/analyst-resources.js";
import {
  ExaSearchClient,
  ExaSearchError,
} from "../packages/research/src/search/exa.js";
import { exaProviderRequestHash } from "../packages/research/src/enrichment/exa-budget.js";
import type { SafeFetchResult } from "../packages/research/src/safe-fetch.js";

const context: AnalystResourceContext = {
  sourceSignalId: "00000000-0000-4000-8000-000000000001",
  analystStepId: "00000000-0000-4000-8000-000000000002",
  now: new Date("2026-09-28T12:00:00.000Z"),
};

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000003",
    provider: "exa",
    operation: "search",
    sourceSignalId: context.sourceSignalId,
    analystStepId: context.analystStepId,
    budgetScopeId: "validation-2026-09-28",
    requestHash: "a".repeat(64),
    utcDay: "2026-09-28",
    estimatedCostUsd: "0.007",
    status: "reserved",
    actualCostUsd: null,
    observedAt: null,
    error: null,
    createdAt: context.now,
    updatedAt: context.now,
    ...overrides,
  };
}

function safePage(content: string): SafeFetchResult {
  return {
    requestedUrl: "https://example.test/",
    finalUrl: "https://example.test/",
    contentType: "text/html",
    content,
    byteLength: Buffer.byteLength(content),
    contentSha256: "b".repeat(64),
    retrievedAt: context.now?.toISOString() ?? "",
    durationMs: 4,
    redirects: [],
  };
}

describe("analyst resource executor", () => {
  it("makes paid Exa tools impossible at the free-only executor boundary", async () => {
    const exaClient = {
      searchWithMetadata: vi.fn(),
      fetchContentsWithMetadata: vi.fn(),
    };
    const executor = createAnalystResourceExecutor({
      db: {} as never,
      executionMode: "free_only",
      exaClient,
      exaBudgetScopeId: "paused-validation-scope",
    });

    await expect(
      executor.execute(context, {
        tool: "exa_search",
        query: "ignore the execution boundary",
      }),
    ).rejects.toBeInstanceOf(AnalystPaidResourceDisabledError);
    await expect(
      executor.execute(context, {
        tool: "exa_contents",
        urls: ["https://example.com/"],
      }),
    ).rejects.toBeInstanceOf(AnalystPaidResourceDisabledError);
    expect(exaClient.searchWithMetadata).not.toHaveBeenCalled();
    expect(exaClient.fetchContentsWithMetadata).not.toHaveBeenCalled();
    expect(accountingMocks.reserve).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    accountingMocks.reserve.mockReset();
    accountingMocks.settle.mockReset();
    accountingMocks.reserve.mockResolvedValue({
      outcome: "reserved",
      reused: false,
      reservation: receipt(),
    });
    accountingMocks.settle.mockImplementation(
      async (_db, _id, input: { actualCostUsd: string | null; status: string }) =>
        receipt({
          status: input.status,
          actualCostUsd: input.actualCostUsd,
          observedAt: context.now,
        }),
    );
  });

  it("keeps a soft 404 as a replayable checked failure, never support", async () => {
    const executor = createAnalystResourceExecutor({
      db: {} as never,
      exaBudgetScopeId: "validation-2026-09-28",
      fetchUrl: vi.fn(async () =>
        safePage("<html><title>404</title><body>Page not found</body></html>"),
      ),
    });

    const observation = await executor.execute(context, {
      tool: "public_page",
      url: "https://example.test/missing",
    });

    expect(observation).toMatchObject({
      tool: "public_page",
      outcome: "access_limited",
      supportRole: "checked_only",
      accessLimit: "soft_404",
      body: null,
    });
    expect(observation.sourceReferences[0]).toMatchObject({
      representation: "checked_failure",
      contentSha256: null,
    });
  });

  it("classifies an actual human-verification challenge as access limited", async () => {
    const executor = createAnalystResourceExecutor({
      db: {} as never,
      exaBudgetScopeId: "validation-2026-09-28",
      fetchUrl: vi.fn(async () =>
        safePage(
          "<html><body><h1>Verify you are human</h1><p>Complete the CAPTCHA challenge to continue.</p></body></html>",
        ),
      ),
    });

    const observation = await executor.execute(context, {
      tool: "public_page",
      url: "https://example.test/challenge",
    });

    expect(observation).toMatchObject({
      outcome: "access_limited",
      supportRole: "checked_only",
      accessLimit: "authentication_or_anti_bot_challenge",
      body: null,
    });
  });

  it("preserves structured identity and products beyond a large HTML header", async () => {
    const jsonLd = {
      "@type": "Organization",
      name: "Beacon Aerospace LLC",
      url: "https://example.test/",
      address: {
        "@type": "PostalAddress",
        streetAddress: "100 Flight Way",
        addressLocality: "Denver",
        addressRegion: "CO",
        postalCode: "80202",
        addressCountry: "US",
      },
      identifier: {
        "@type": "PropertyValue",
        propertyID: "CAGE",
        value: "1ABC2",
      },
      description: "x".repeat(1_561),
    };
    const html = [
      "<html><head>",
      `<style>${"body{color:black}".repeat(3_000)}</style>`,
      `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`,
      "</head><body><h1>Beacon Aerospace LLC</h1>",
      "<p>We manufacture the AX-10 actuator for aircraft operators.</p>",
      "</body></html>",
    ].join("");
    const executor = createAnalystResourceExecutor({
      db: {} as never,
      exaBudgetScopeId: "validation-2026-09-28",
      fetchUrl: vi.fn(async () => safePage(html)),
    });

    const observation = await executor.execute(context, {
      tool: "public_page",
      url: "https://example.test/",
    });

    expect(observation).toMatchObject({
      outcome: "success",
      supportRole: "candidate_evidence",
      truncated: false,
    });
    if (
      observation.tool !== "public_page" ||
      observation.outcome !== "success" ||
      observation.body === null
    ) {
      throw new Error("wrong observation");
    }
    expect(observation.body).toContain("AX-10 actuator");
    const structuredText =
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/u.exec(
        observation.body,
      )?.[1];
    if (structuredText === undefined) throw new Error("missing JSON-LD projection");
    const [structured] = JSON.parse(structuredText) as [
      Record<string, unknown>,
    ];
    expect(structured).toMatchObject({
      name: "Beacon Aerospace LLC",
      address: {
        streetAddress: "100 Flight Way",
        addressLocality: "Denver",
        addressRegion: "CO",
        postalCode: "80202",
        addressCountry: "US",
      },
      identifier: {
        propertyID: "CAGE",
        value: "1ABC2",
      },
    });
    expect(observation.sourceReferences[0]).toMatchObject({
      representation: "normalized_publisher_text",
      contentSha256: "b".repeat(64),
    });
  });

  it("does not mistake reCAPTCHA assets or AX-404 products for access limits", async () => {
    const executor = createAnalystResourceExecutor({
      db: {} as never,
      exaBudgetScopeId: "validation-2026-09-28",
      fetchUrl: vi.fn(async () =>
        safePage(
          '<html><head><script src="https://captcha.test/recaptcha.js"></script></head><body><h1>AX-404 actuator</h1><p>We manufacture aerospace controls.</p></body></html>',
        ),
      ),
    });

    const observation = await executor.execute(context, {
      tool: "public_page",
      url: "https://example.test/products/ax-404",
    });

    expect(observation).toMatchObject({
      outcome: "success",
      supportRole: "candidate_evidence",
      accessLimit: null,
    });
  });

  it("refuses fuzzy or name-only primary lookup before touching storage", async () => {
    const execute = vi.fn();
    const executor = createAnalystResourceExecutor({
      db: { execute } as never,
      exaBudgetScopeId: "validation-2026-09-28",
    });

    const observation = await executor.execute(context, {
      tool: "primary_records",
      identity: { legalName: "Beacon Aerospace" },
    });

    expect(observation).toMatchObject({
      tool: "primary_records",
      outcome: "unresolved",
      supportRole: "checked_only",
      records: [],
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves multiple exact imported primary records and issuer provenance", async () => {
    const db = {
      execute: vi.fn(async () => ({
        rows: [
          {
            id: "00000000-0000-4000-8000-000000000010",
            source_key: "sam_entity",
            source_locator: "sam://entity/ABC123",
            source_fingerprint: "sam-fingerprint",
            raw_name: "Beacon Aerospace LLC",
            raw_domain: "beacon.test",
            uei: "ABC123",
            cage: "1ABC2",
            city: "Denver",
            state: "CO",
            country: "US",
            award_count: 0,
            source_payload: { legalName: "Beacon Aerospace LLC", uei: "ABC123" },
          },
          {
            id: "00000000-0000-4000-8000-000000000011",
            source_key: "usaspending",
            source_locator: "usaspending://recipient/ABC123",
            source_fingerprint: "usa-fingerprint",
            raw_name: "Beacon Aerospace LLC",
            raw_domain: null,
            uei: "ABC123",
            cage: null,
            city: "Denver",
            state: "CO",
            country: "US",
            award_count: 4,
            source_payload: { recipient: "Beacon Aerospace LLC", uei: "ABC123" },
          },
          {
            id: "00000000-0000-4000-8000-000000000012",
            source_key: "faa_pma_database",
            source_locator: "https://drs.faa.gov/browse/PMA/ABC123",
            source_fingerprint: "faa-fingerprint",
            raw_name: "Beacon Aerospace LLC",
            raw_domain: null,
            uei: "ABC123",
            cage: "1ABC2",
            city: "Denver",
            state: "CO",
            country: "US",
            award_count: null,
            source_payload: {
              holderName: "Beacon Aerospace LLC",
              uei: "ABC123",
            },
          },
        ],
      })),
    };
    const executor = createAnalystResourceExecutor({
      db: db as never,
      exaBudgetScopeId: "validation-2026-09-28",
    });

    const observation = await executor.execute(context, {
      tool: "primary_records",
      identity: {
        legalName: "Beacon Aerospace LLC",
        city: "Denver",
        state: "CO",
      },
    });

    expect(observation).toMatchObject({
      outcome: "success",
      matchBasis: "legal_name_and_location",
      ambiguous: false,
      supportRole: "candidate_evidence",
    });
    if (observation.tool !== "primary_records") throw new Error("wrong tool");
    expect(observation.records).toHaveLength(3);
    expect(observation.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          issuer: "U.S. General Services Administration",
          recordAccess: "reused_imported_record",
        }),
        expect.objectContaining({
          sourceKey: "faa_pma_database",
          issuer: "Federal Aviation Administration",
        }),
      ]),
    );
    expect(observation.sourceReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          locator: "sam://entity/ABC123",
          representation: "structured_primary_record",
          contentSha256: expect.any(String),
        }),
      ]),
    );
  });

  it("marks contradictory exact primary records ambiguous without discarding them", async () => {
    const shared = {
      source_locator: "https://sam.gov/entity/ABC123",
      source_fingerprint: "fingerprint",
      raw_domain: null,
      uei: "ABC123",
      cage: null,
      country: "US",
      award_count: null,
      source_payload: {},
    };
    const db = {
      execute: vi.fn(async () => ({
        rows: [
          {
            ...shared,
            id: "00000000-0000-4000-8000-000000000013",
            source_key: "sam_entity",
            raw_name: "Beacon Aerospace LLC",
            city: "Denver",
            state: "CO",
          },
          {
            ...shared,
            id: "00000000-0000-4000-8000-000000000014",
            source_key: "usaspending",
            raw_name: "Beacon Aviation Holdings Inc.",
            city: "Phoenix",
            state: "AZ",
          },
        ],
      })),
    };
    const executor = createAnalystResourceExecutor({
      db: db as never,
      exaBudgetScopeId: "validation-2026-09-28",
    });

    const observation = await executor.execute(context, {
      tool: "primary_records",
      identity: { legalName: "Beacon Aerospace LLC", uei: "ABC123" },
    });

    expect(observation).toMatchObject({
      outcome: "success",
      ambiguous: true,
    });
    if (observation.tool !== "primary_records") throw new Error("wrong tool");
    expect(observation.records).toHaveLength(2);
  });

  it("normalizes equivalent search requests without merging distinct queries", () => {
    expect(
      exaProviderRequestHash("search", {
        query: "bounded aerospace search",
      }),
    ).toBe(
      exaProviderRequestHash("search", {
        query: "  bounded   aerospace search  ",
      }),
    );
    expect(
      exaProviderRequestHash("search", { query: "a different aerospace company" }),
    ).not.toBe(
      exaProviderRequestHash("search", { query: "bounded aerospace search" }),
    );
  });

  it("bounds text-only contents to three normalized URLs before hashing or sending", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new ExaSearchClient({ apiKey: "test-key", fetch: fetchMock });
    const urls = [
      " https://example.test/one ",
      "not-a-url",
      "https://example.test/two",
      "https://example.test/three",
      "https://example.test/four",
    ];

    await client.fetchContentsWithMetadata(urls);

    expect(
      JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)).urls,
    ).toEqual([
      "https://example.test/one",
      "https://example.test/two",
      "https://example.test/three",
    ]);
    expect(exaProviderRequestHash("contents", { urls })).toBe(
      exaProviderRequestHash("contents", {
        urls: [
          "https://example.test/one",
          "https://example.test/two",
          "https://example.test/three",
        ],
      }),
    );
  });
  it("settles malformed HTTP 200 payload cost metadata before reporting failure", async () => {
    const client = new ExaSearchClient({
      apiKey: "test-key",
      fetch: vi.fn(async () =>
        new Response(
          JSON.stringify({ costDollars: { total: 1e-13 }, results: [{ bad: true }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    });
    const executor = createAnalystResourceExecutor({
      db: {} as never,
      exaApiKey: "test-key",
      exaClient: client,
      exaBudgetScopeId: "validation-2026-09-28",
    });

    const observation = await executor.execute(context, {
      tool: "exa_search",
      query: "Beacon Aerospace official website",
    });

    expect(observation).toMatchObject({
      outcome: "failed",
      providerReceiptId: "00000000-0000-4000-8000-000000000003",
      providerCostUsd: "0.0000000000001",
      providerCostKnown: true,
      failure: { code: "invalid_response", retryable: false },
    });
    expect(accountingMocks.settle).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({
        status: "failed",
        actualCostUsd: "0.0000000000001",
      }),
    );
  });

  it("keeps the timeout active while reading a delayed response body", async () => {
    vi.useFakeTimers();
    try {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          setTimeout(() => {
            controller.enqueue(
              new TextEncoder().encode(JSON.stringify({ results: [] })),
            );
            controller.close();
          }, 20_000);
        },
      });
      const client = new ExaSearchClient({
        apiKey: "test-key",
        fetch: vi.fn(async () => new Response(body, { status: 200 })),
      });
      const pending = client.searchWithMetadata("bounded standard search");
      const rejection = expect(pending).rejects.toMatchObject({
        code: "timeout",
        transient: true,
      });
      await vi.advanceTimersByTimeAsync(15_001);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("turns Exa credit exhaustion into a durable cooldown deferral with unknown cost", async () => {
    const exaClient = {
      searchWithMetadata: vi.fn(async () => {
        throw new ExaSearchError("quota_exhausted", true, 402, null);
      }),
      fetchContentsWithMetadata: vi.fn(),
    };
    const executor = createAnalystResourceExecutor({
      db: {} as never,
      exaClient,
      exaBudgetScopeId: "validation-2026-09-28",
    });

    const observation = await executor.execute(context, {
      tool: "exa_search",
      query: "bounded standard search",
    });

    expect(observation).toMatchObject({
      outcome: "deferred",
      providerCostUsd: null,
      providerCostKnown: false,
      accessLimit: expect.stringContaining("provider_cooldown"),
    });
    expect(accountingMocks.settle).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({
        status: "failed",
        actualCostUsd: null,
        providerCooldown: expect.objectContaining({ reason: "credits_exhausted" }),
      }),
    );
  });
});
