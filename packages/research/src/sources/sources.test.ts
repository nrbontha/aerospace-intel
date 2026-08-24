import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { getSearchableSources, SOURCE_CATALOG } from "./catalog.js";
import { SamApiKeyMissingError, SamEntityClient } from "./sam.js";
import { SourceFetchError } from "./types.js";
import {
  AIRCRAFT_COMPONENT_PSC,
  AEROSPACE_NAICS,
  USASPENDING_SEARCH_URL,
  UsaspendingClient,
} from "./usaspending.js";

interface PageFixture {
  results: Record<string, unknown>[];
  page_metadata?: unknown;
}

/**
 * Committed fixture files: JSON parsed once at the test boundary into the
 * documented fixture shape (results array plus optional metadata).
 */
function loadPageFixture(name: string): PageFixture {
  const path = new URL(`./fixtures/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(path, "utf8")) as PageFixture;
}

/** Test seam: builds a Response without touching the network (many call sites). */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type FetchSpy = {
  calls: { url: string; init: RequestInit | undefined }[];
  respond: (url: string, init?: RequestInit) => Response | Promise<Response>;
};

/** Test seam/DI boundary: records calls so tests assert request shape + count. */
function fetchSpy(respond: FetchSpy["respond"]): {
  spy: FetchSpy;
  fetchImpl: typeof fetch;
} {
  const spy: FetchSpy = { calls: [], respond };
  const fetchImpl = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    spy.calls.push({ url, init });
    return await spy.respond(url, init);
  }) as unknown as typeof fetch;
  return { spy, fetchImpl };
}

const noSleep = async () => {};

const FY_WINDOW = { startDate: "2021-01-01", endDate: "2026-01-01" };

describe("UsaspendingClient aggregation", () => {
  it("aggregates rows into one LeadCandidate per recipient with exact sums, counts, freshest date", async () => {
    const pages = [
      loadPageFixture("usaspending-page1"),
      loadPageFixture("usaspending-page2"),
    ];
    const { spy, fetchImpl } = fetchSpy((_url, init) =>
      jsonResponse(pages[Number(JSON.parse(String(init?.body)).page) - 1]),
    );
    const client = new UsaspendingClient({
      fetchImpl,
      sleep: noSleep,
      pageSize: 4, // page1 fills a full page -> forces the page-2 request
      maxPages: 5,
    });

    const leads = await client.searchRecipients({
      naicsCodes: [...AEROSPACE_NAICS],
      timePeriod: FY_WINDOW,
    });

    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[0]!.url).toBe(USASPENDING_SEARCH_URL);

    // 6 award rows collapse into 4 distinct recipients.
    expect(leads).toHaveLength(4);

    // Multi-award aggregate case spanning both pages:
    const aero = leads.find(
      (l) => l.rawName === "Aero Structures Manufacturing Inc",
    );
    expect(aero).toMatchObject({
      uei: "AAA111111111",
      awardCount: 3,
      totalAwardValueUsd: 220_500.0, // 120000.00 + 80500.25 + 19999.75
      freshestAwardDate: "2025-02-20",
      source: "usaspending",
    });
    expect(aero!.sourceLocator).toContain("recipient_name=Aero+Structures");

    const desert = leads.find(
      (l) => l.rawName === "Desert Tooling & Machine Co",
    );
    expect(desert).toMatchObject({
      awardCount: 1,
      totalAwardValueUsd: 7_250.5,
      freshestAwardDate: "2021-08-02",
    });
    // Recipient with no UEI still yields a candidate; locator omits uei.
    expect(desert!.uei).toBeUndefined();
    expect(desert!.sourceLocator).not.toContain("uei=");
  });

  it("respects the maxPages budget bound even when more pages exist", async () => {
    const { spy, fetchImpl } = fetchSpy(() =>
      // Server has >= 3 pages of results (every response is a full page).
      jsonResponse(loadPageFixture("usaspending-page1")),
    );
    const client = new UsaspendingClient({
      fetchImpl,
      sleep: noSleep,
      pageSize: 2, // fixtures hold >2 rows so pagination wants to continue
      maxPages: 2,
    });

    const leads = await client.searchRecipients({ timePeriod: FY_WINDOW });

    expect(spy.calls).toHaveLength(2);
    // Aggregated exactly from the two served (identical full) pages: an
    // unbounded loop would have kept fetching and inflated these counts.
    const aero = leads.find(
      (l) => l.rawName === "Aero Structures Manufacturing Inc",
    );
    expect(aero!.awardCount).toBe(4); // 2 rows/page x 2 pages
    expect(aero!.totalAwardValueUsd).toBe(401_000.5);
  });

  it("rate-limit sleeps at least 1000ms between pages but not after the last", async () => {
    const sleeps: number[] = [];
    const { fetchImpl } = fetchSpy(() =>
      jsonResponse(loadPageFixture("usaspending-page1")),
    );
    const client = new UsaspendingClient({
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      pageSize: 2,
      maxPages: 2,
      requestDelayMs: 50, // clamped up to the contractual minimum
    });

    await client.searchRecipients({ timePeriod: FY_WINDOW });
    expect(sleeps).toHaveLength(1); // only between page 1 and page 2
    expect(sleeps[0]).toBeGreaterThanOrEqual(1000);
  });
});

describe("UsaspendingClient error taxonomy", () => {
  it("classifies HTTP 429 as transient and retries until success", async () => {
    let callCount = 0;
    const { spy, fetchImpl } = fetchSpy(() => {
      callCount += 1;
      return callCount === 1
        ? jsonResponse({ error: "throttled" }, 429)
        : jsonResponse(loadPageFixture("usaspending-page1"));
    });
    const client = new UsaspendingClient({ fetchImpl, sleep: noSleep });

    const leads = await client.searchRecipients({ timePeriod: FY_WINDOW });
    expect(leads.length).toBeGreaterThan(0);
    expect(spy.calls).toHaveLength(2); // retried once after the 429
  });

  it("classifies HTTP 5xx as transient and exhausts retries before failing", async () => {
    const { spy, fetchImpl } = fetchSpy(() =>
      jsonResponse({ error: "boom" }, 503),
    );
    const client = new UsaspendingClient({
      fetchImpl,
      sleep: noSleep,
      maxRetries: 2,
    });

    await expect(
      client.searchRecipients({ timePeriod: FY_WINDOW }),
    ).rejects.toMatchObject({ transient: true, status: 503 });
    expect(spy.calls).toHaveLength(3); // initial + 2 retries
  });

  it("classifies other 4xx as permanent and does not retry", async () => {
    const { spy, fetchImpl } = fetchSpy(() =>
      jsonResponse({ error: "bad filter" }, 400),
    );
    const client = new UsaspendingClient({
      fetchImpl,
      sleep: noSleep,
      maxRetries: 2,
    });

    await expect(
      client.searchRecipients({ timePeriod: FY_WINDOW }),
    ).rejects.toBeInstanceOf(SourceFetchError);
    await expect(
      client.searchRecipients({ timePeriod: FY_WINDOW }),
    ).rejects.toMatchObject({ transient: false, status: 400 });
    expect(spy.calls).toHaveLength(2); // one per search attempt, zero retries
  });
});

describe("UsaspendingClient schema validation", () => {
  it("drops rows missing Recipient Name instead of failing the page", async () => {
    // One malformed row mid-stream used to fail schema validation for the
    // whole 100-row page, which stalled a running crawl with retry backoff.
    const broken: PageFixture = structuredClone(loadPageFixture("usaspending-page1"));
    delete broken.results[0]!["Recipient Name"];
    broken.page_metadata = null; // API emits explicit null between pages
    const { spy, fetchImpl } = fetchSpy(() => jsonResponse(broken));
    const client = new UsaspendingClient({ fetchImpl, sleep: noSleep });

    const leads = await client.searchRecipients({
      naicsCodes: [...AEROSPACE_NAICS],
      timePeriod: FY_WINDOW,
    });

    expect(spy.calls).toHaveLength(1);
    // Page 1 fixture holds 4 rows; the nameless one (row 0) is skipped.
    expect(leads).toHaveLength(3);
    // Row 0 belonged to Aero Structures: its aggregate loses that award…
    const aero = leads.find(
      (lead) => lead.rawName === "Aero Structures Manufacturing Inc",
    );
    expect(aero?.awardCount).toBe(1);
    // …while the other three recipients survive intact.
    expect(leads.some((lead) => lead.rawName === "Precision Gears LLC")).toBe(
      true,
    );
  });

  it("continues past a spurious hasNext=false while pages stay full", async () => {
    // Under sorted access the API flips hasNext to false at its internal
    // 10k-record window even though deeper pages keep returning data
    // (verified live 2026-08-24). Only a partial page means exhaustion.
    const { spy, fetchImpl } = fetchSpy(() =>
      jsonResponse({
        results: loadPageFixture("usaspending-page1").results,
        page_metadata: { page: 100, hasNext: false },
      }),
    );
    const client = new UsaspendingClient({
      fetchImpl,
      sleep: noSleep,
      pageSize: 4,
      maxPages: 2,
    });

    const result = await client.searchRecipientsPage({ timePeriod: FY_WINDOW });

    expect(spy.calls).toHaveLength(2); // kept walking despite hasNext:false
    expect(result.nextPage).toBe(3);
  });

  it("stops on a partial page even without any metadata", async () => {
    // Fixture page holds 4 rows; pageSize 10 makes it partial — the true
    // end-of-data signal.
    const { spy, fetchImpl } = fetchSpy(() =>
      jsonResponse(loadPageFixture("usaspending-page1")),
    );
    const client = new UsaspendingClient({
      fetchImpl,
      sleep: noSleep,
      pageSize: 10,
      maxPages: 3,
    });

    const result = await client.searchRecipientsPage({ timePeriod: FY_WINDOW });

    expect(spy.calls).toHaveLength(1);
    expect(result.nextPage).toBeNull();
  });

  it("treats a partial page with null cursor fields as true exhaustion", async () => {
    // Verbatim end-of-stream shape (verified live 2026-08-24): fewer rows
    // than the page size plus hasNext:false and null cursor fields.
    const { spy, fetchImpl } = fetchSpy(() =>
      jsonResponse({
        results: loadPageFixture("usaspending-page1").results,
        page_metadata: {
          page: 100,
          hasNext: false,
          last_record_unique_id: null,
          last_record_sort_value: "None",
        },
      }),
    );
    const client = new UsaspendingClient({
      fetchImpl,
      sleep: noSleep,
      pageSize: 10, // fixture holds 4 rows -> partial page
      maxPages: 2,
    });

    const result = await client.searchRecipientsPage({
      timePeriod: FY_WINDOW,
      startPage: 100,
    });

    expect(spy.calls).toHaveLength(1);
    expect(result.nextPage).toBeNull();
    expect(result.cursor).toBeNull();
  });

  it("sends the documented request shape (award types, fields, limit, page)", async () => {
    const { spy, fetchImpl } = fetchSpy(() => jsonResponse({ results: [] }));
    const client = new UsaspendingClient({ fetchImpl, sleep: noSleep });

    await client.searchRecipients({
      naicsCodes: ["336411"],
      pscCodes: [...AIRCRAFT_COMPONENT_PSC],
      timePeriod: { startDate: "2024-01-01", endDate: "2025-01-01" },
      placeOfPerformanceLocations: [{ state: "KS" }],
    });

    const body = JSON.parse(String(spy.calls[0]!.init?.body));
    expect(body).toEqual({
      filters: {
        award_type_codes: ["A", "B", "C", "D"],
        naics_codes: ["336411"],
        product_or_service_code: [...AIRCRAFT_COMPONENT_PSC],
        place_of_performance_locations: [{ state: "KS" }],
        time_period: [{ start_date: "2024-01-01", end_date: "2025-01-01" }],
      },
      fields: [
        "Recipient Name",
        "Recipient UEI",
        "Recipient UEI Count",
        "Award Amount",
        "Awarding Agency",
        "Start Date",
        "Description",
      ],
      limit: 100,
      page: 1,
      // Explicit stable ordering: without it the API walks recipients
      // Z→A and bounded crawls only ever sample the alphabet tail.
      sort: "Recipient Name",
      order: "asc",
    });
  });
});

describe("UsaspendingClient cursor pagination", () => {
  it("reports nextPage and the API cursor from page_metadata", async () => {
    const { spy, fetchImpl } = fetchSpy(() =>
      jsonResponse({
        results: loadPageFixture("usaspending-page1").results,
        page_metadata: {
          page: 1,
          hasNext: true,
          last_record_unique_id: 359759755,
          last_record_sort_value: "Aero Structures Manufacturing Inc",
        },
      }),
    );
    const client = new UsaspendingClient({
      fetchImpl,
      sleep: noSleep,
      pageSize: 2,
      maxPages: 1,
    });

    const result = await client.searchRecipientsPage({ timePeriod: FY_WINDOW });

    expect(spy.calls).toHaveLength(1);
    expect(result.nextPage).toBe(2);
    expect(result.cursor).toEqual({
      sortValue: "Aero Structures Manufacturing Inc",
      uniqueId: 359759755,
    });
  });

  it("advances past the page ceiling when a cursor is provided", async () => {
    // Sequential (cursor) pagination is exactly what the API prescribes
    // past its 50k-record page-param ceiling.
    const { spy, fetchImpl } = fetchSpy(() =>
      jsonResponse({
        results: loadPageFixture("usaspending-page1").results,
        page_metadata: {
          page: 500,
          hasNext: true,
          last_record_unique_id: 42,
          last_record_sort_value: "BASIC RUBBER AND PLASTICS CO.",
        },
      }),
    );
    const client = new UsaspendingClient({
      fetchImpl,
      sleep: noSleep,
      pageSize: 2,
      maxPages: 1,
    });

    const result = await client.searchRecipientsPage({
      timePeriod: FY_WINDOW,
      startPage: 500,
      cursor: { sortValue: "BAHR MACHINE COMPANY INC", uniqueId: 41 },
    });

    expect(spy.calls).toHaveLength(1);
    expect(result.nextPage).toBe(501);
    expect(result.cursor).toEqual({
      sortValue: "BASIC RUBBER AND PLASTICS CO.",
      uniqueId: 42,
    });
  });

  it("resumes at startPage and forwards the cursor in the request body", async () => {
    const { spy, fetchImpl } = fetchSpy((_url, init) => {
      const body = JSON.parse(String(init?.body));
      return jsonResponse({
        results: loadPageFixture("usaspending-page1").results,
        page_metadata: { page: body.page, hasNext: true },
      });
    });
    const client = new UsaspendingClient({
      fetchImpl,
      sleep: noSleep,
      pageSize: 2,
      maxPages: 1,
    });

    const result = await client.searchRecipientsPage({
      timePeriod: FY_WINDOW,
      startPage: 42,
      cursor: { sortValue: "KIT PACK CO., INC.", uniqueId: 123456789 },
    });

    const body = JSON.parse(String(spy.calls[0]!.init?.body));
    expect(body.page).toBe(42);
    expect(body.last_record_sort_value).toBe("KIT PACK CO., INC.");
    expect(body.last_record_unique_id).toBe(123456789);
    expect(result.nextPage).toBe(43);
  });

  it("refuses to advance past the API's 50k-record page ceiling", async () => {
    const { spy, fetchImpl } = fetchSpy(() =>
      jsonResponse({
        results: loadPageFixture("usaspending-page1").results,
        page_metadata: {
          page: 500,
          hasNext: true,
          last_record_unique_id: 999,
          last_record_sort_value: "ZEPHYR INTERNATIONAL LLC",
        },
      }),
    );
    const client = new UsaspendingClient({
      fetchImpl,
      sleep: noSleep,
      pageSize: 2,
      maxPages: 2,
    });

    const result = await client.searchRecipientsPage({
      timePeriod: FY_WINDOW,
      startPage: 500,
    });

    expect(spy.calls).toHaveLength(1); // page 501 would be rejected by the API
    expect(result.nextPage).toBeNull();
    // The cursor still hands off so deeper traversal can resume sequentially.
    expect(result.cursor).toEqual({
      sortValue: "ZEPHYR INTERNATIONAL LLC",
      uniqueId: 999,
    });
  });
});

describe("SamEntityClient", () => {
  it("throws the typed non-transient error when no API key is configured", async () => {
    const { spy, fetchImpl } = fetchSpy(() => {
      throw new Error("network must not be touched without a key");
    });
    const client = new SamEntityClient({ fetchImpl });

    await expect(client.search({ q: "fastener" })).rejects.toBeInstanceOf(
      SamApiKeyMissingError,
    );
    await expect(client.search({ q: "fastener" })).rejects.toMatchObject({
      transient: false,
    });
    expect(spy.calls).toHaveLength(0); // never fabricated, never called
  });

  it("maps records onto LeadCandidate and caps page size at 100", async () => {
    const { spy, fetchImpl } = fetchSpy((url) => {
      expect(url).toContain("api.sam.gov/entity-information/v3/search");
      expect(url).toContain("api_key=test-key");
      return jsonResponse(loadPageFixture("sam-search"));
    });
    const client = new SamEntityClient({
      apiKey: "test-key",
      fetchImpl,
      pageSize: 250, // must be capped to the API's 100
    });

    const { totalRecords, leads } = await client.search({ q: "aerospace" });

    expect(totalRecords).toBe(2);
    expect(leads).toHaveLength(2);
    expect(
      new URLSearchParams(spy.calls[0]!.url.split("?")[1]).get("size"),
    ).toBe("100");

    expect(leads[0]).toEqual({
      rawName: "Helix Fastener Systems Inc",
      uei: "EEE555555555",
      cageCode: "8X2Y4",
      addressLine: "1200 Industrial Pkwy",
      city: "Wichita",
      state: "KS",
      zip: "67209",
      naics: ["336413", "332722"],
      awardCount: 0, // registry source: no award data asserted
      totalAwardValueUsd: 0,
      source: "sam_gov",
      sourceLocator: "sam://entity-information/v3/search?uei=EEE555555555",
    });
    // Minimal record maps with optional fields absent.
    expect(leads[1]).toEqual({
      rawName: "Cascade Hydraulics LLC",
      uei: "FFF666666666",
      awardCount: 0,
      totalAwardValueUsd: 0,
      source: "sam_gov",
      sourceLocator: "sam://entity-information/v3/search?uei=FFF666666666",
    });
  });
});

describe("SOURCE_CATALOG", () => {
  it("registers exactly the five seeded canonical data sources", () => {
    expect(Object.keys(SOURCE_CATALOG).sort()).toEqual([
      "Boeing Illustrated Parts Catalog (IPC)",
      "Online Aerospace Supplier Information System (OASIS)",
      "Performance Review Institute",
      "System for Award Management (SAM)",
      "USAspending",
    ]);
  });

  it("marks exactly SAM + USAspending as searchable today", () => {
    const searchable = getSearchableSources();
    expect(Object.keys(searchable).sort()).toEqual([
      "System for Award Management (SAM)",
      "USAspending",
    ]);
    expect(searchable["USAspending"]).toEqual({
      adapterAvailable: true,
      accessModel: "public_no_auth",
      notes: expect.any(String),
    });
    expect(searchable["System for Award Management (SAM)"]).toMatchObject({
      accessModel: "api_key_required",
    });
    expect(SOURCE_CATALOG["Performance Review Institute"]).toMatchObject({
      adapterAvailable: false,
      accessModel: "paid_subscription",
    });
  });
});

// Live smoke test — opt-in only (ASI_LIVE_SOURCES=1), budget-bounded to a
// single request (maxRetries 0, maxPages 1).
describe.skipIf(!process.env.ASI_LIVE_SOURCES)("live USAspending", () => {
  it("parses at least one real recipient from a bounded query", async () => {
    const client = new UsaspendingClient({
      maxPages: 1,
      maxRetries: 0,
      timeoutMs: 15_000,
    });
    const leads = await client.searchRecipients({
      naicsCodes: ["3364"],
      timePeriod: { startDate: "2024-10-01", endDate: "2025-09-30" },
    });
    expect(leads.length).toBeGreaterThanOrEqual(1);
    console.log(
      `[live] usaspending recipients: ${leads.length}, first: ${JSON.stringify(leads[0])}`,
    );
  }, 30_000);
});
