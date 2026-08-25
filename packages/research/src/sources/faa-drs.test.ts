import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  FAA_DRS_PUBLIC_PMA_URL,
  FaaDrsAccessError,
  FaaDrsBrowserClient,
  FaaDrsProtocolError,
  FaaDrsStaleResultsError,
  parseFaaPmaCard,
  parseFaaPmaCards,
  type FaaDrsBrowserFactory,
  type FaaDrsBrowserPage,
  type FaaDrsDomCard,
} from "./faa-drs.js";

interface FaaFixture {
  readonly cards: readonly FaaDrsDomCard[];
}

const fixturePath = new URL(
  "./fixtures/faa-drs-ram-aerospace.json",
  import.meta.url,
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as FaaFixture;

interface BrowserCall {
  readonly method: string;
  readonly value?: string | number;
}

class MockBrowserPage implements FaaDrsBrowserPage {
  readonly calls: BrowserCall[] = [];
  navigationUrl = FAA_DRS_PUBLIC_PMA_URL;
  navigationStatus: number | null = 200;
  responseStatus: 401 | 403 | 429 | null = null;
  renderedBody = "PMA search results";
  resultCards: readonly FaaDrsDomCard[] = fixture.cards;
  resultCardsAfterWait: readonly FaaDrsDomCard[] | undefined;

  async navigate(url: string, timeoutMs: number) {
    this.calls.push({ method: "navigate", value: url });
    this.calls.push({ method: "navigation-timeout", value: timeoutMs });
    return { url: this.navigationUrl, status: this.navigationStatus };
  }

  async fill(selector: string, value: string) {
    this.calls.push({ method: "fill-selector", value: selector });
    this.calls.push({ method: "fill-value", value });
  }

  async press(selector: string, key: "Enter") {
    this.calls.push({ method: "press-selector", value: selector });
    this.calls.push({ method: "press-key", value: key });
  }

  async click(selector: string) {
    this.calls.push({ method: "click", value: selector });
  }

  async waitForResults(timeoutMs: number) {
    this.calls.push({ method: "query-timeout", value: timeoutMs });
    if (this.resultCardsAfterWait !== undefined) {
      this.resultCards = this.resultCardsAfterWait;
    }
  }

  async bodyText() {
    return this.renderedBody;
  }

  blockedStatus() {
    return this.responseStatus;
  }

  async cards(maxRecords: number) {
    this.calls.push({ method: "cards-limit", value: maxRecords });
    return this.resultCards.slice(0, maxRecords);
  }

  async close() {
    this.calls.push({ method: "close" });
  }
}

class MockBrowserFactory implements FaaDrsBrowserFactory {
  readonly page: MockBrowserPage;
  opens = 0;

  constructor(page = new MockBrowserPage()) {
    this.page = page;
  }

  async open() {
    this.opens += 1;
    return this.page;
  }
}

const noSleep = async () => {};

describe("FAA DRS PMA card parser", () => {
  it("maps RAM Aerospace rendered fields and stable public record URLs exactly", () => {
    const records = parseFaaPmaCards(fixture.cards, 25);

    expect(records).toHaveLength(3);
    expect(records[0]).toEqual({
      recordId: "161062274720260819195457.0001",
      guidUrl:
        "https://drs.faa.gov/browse/excelExternalWindow/DRSDOCID161062274720260819195457.0001",
      status: "Current",
      subStatus: null,
      holderName: "RAM Aerospace",
      holderNumber: "PQ00076WB",
      fullAddress: null,
      pmaPartNumber: "143-11243",
      partName: "Pin, Dowel",
      replacementPartNumber: "143-11243",
      make: "Pratt & Whitney Canada Corp.",
      models: ["PW305A", "PW305B", "PW306A"],
      supplementNumber: "1",
      supplementDate: "2026-08-04",
      approvalBasis:
        "Identicality per 14 CFR 21.303, licensing agreement between RAM Aerospace and Pratt Whitney Canada CorpFile No. RAMP25001dated 1/27/2026DWG No: 30B717",
      serviceOffice: "AIR-800: System Oversight",
      opr: "AIR-871: Scottsdale Certificate Management Section",
      cfrReferences: ["Part 21", "Sec. 21.301"],
      comments: null,
      renderedSourceText: fixture.cards[0]!.renderedText,
    });
    expect(records[1]).toMatchObject({
      recordId: "105200434020260819195455.0001",
      holderName: "RAM Aerospace",
      pmaPartNumber: "286-11243",
      partName: "Ring",
      models: ["PW305A", "PW305B", "PW306A"],
      supplementDate: "2026-08-04",
    });
    expect(records[2]).toMatchObject({
      recordId: "1365986",
      fullAddress:
        "1450 Aviation Drive\nSt. George, UT 84790\nUnited States",
      models: ["AS907-2-1G", "AS907-3-1E"],
      cfrReferences: ["14 CFR 21.303", "14 CFR 21.316"],
      comments: "Eligible for installation as specified by the supplement.",
    });
  });

  it("applies the DOM-card limit before deduplicating by record URL", () => {
    expect(parseFaaPmaCards(fixture.cards, 1)).toHaveLength(1);
    expect(parseFaaPmaCards(fixture.cards, 2)).toHaveLength(2);
    expect(parseFaaPmaCards(fixture.cards, 3)).toHaveLength(3);
    expect(parseFaaPmaCards(fixture.cards, 4)).toHaveLength(3);
  });

  it("rejects links outside the public document-card route", () => {
    expect(() =>
      parseFaaPmaCard({
        href: "https://drs.faa.gov/api/documents/1365986",
        renderedText: "PMA Holder Name: RAM Aerospace, Inc.",
      }),
    ).toThrow(FaaDrsProtocolError);
  });
});

describe("FaaDrsBrowserClient", () => {
  it("uses the selected public filter, keyboard token creation, Apply, and hard timeouts", async () => {
    const browserFactory = new MockBrowserFactory();
    const client = new FaaDrsBrowserClient({
      browserFactory,
      sleep: noSleep,
      now: () => new Date("2026-08-25T12:00:00.000Z"),
    });

    const result = await client.search({
      holderName: "RAM Aerospace",
      maxRecords: 2,
    });

    expect(result.records).toHaveLength(2);
    expect(result.source).toEqual({
      publicUrl: FAA_DRS_PUBLIC_PMA_URL,
      scrapedAt: "2026-08-25T12:00:00.000Z",
      retrievalMethod: "guest_browser_dom",
    });
    expect(browserFactory.page.calls).toEqual([
      { method: "navigate", value: FAA_DRS_PUBLIC_PMA_URL },
      { method: "navigation-timeout", value: 30_000 },
      { method: "fill-selector", value: "input[name='PMA Holder Name']" },
      { method: "fill-value", value: "RAM Aerospace" },
      { method: "press-selector", value: "input[name='PMA Holder Name']" },
      { method: "press-key", value: "Enter" },
      { method: "click", value: "#apply-filters-btn" },
      { method: "query-timeout", value: 60_000 },
      { method: "cards-limit", value: 2 },
      { method: "close" },
    ]);
  });
  it("waits past initial default cards and returns only later matching RAM cards", async () => {
    const page = new MockBrowserPage();
    page.resultCards = [
      {
        href: "/browse/excelExternalWindow/DRSDOCID190185491920260813184047.0001",
        renderedText:
          "PMA Holder Name: B/E Aerospace Inc.\nPMA Holder Number: PQ3417CE\nPMA Part Number: 4660-2222-02",
      },
    ];
    page.resultCardsAfterWait = fixture.cards;
    const client = new FaaDrsBrowserClient({
      browserFactory: new MockBrowserFactory(page),
      sleep: noSleep,
    });

    const result = await client.search({
      holderNumber: "PQ00076WB",
      maxRecords: 2,
    });

    expect(result.records).toHaveLength(2);
    expect(
      result.records.every(
        (record) =>
          record.holderNumber === "PQ00076WB" &&
          record.holderName === "RAM Aerospace" &&
          record.guidUrl.startsWith(
            "https://drs.faa.gov/browse/excelExternalWindow/DRSDOCID",
          ),
      ),
    ).toBe(true);
  });

  it("throws a typed error instead of returning stale default cards", async () => {
    const page = new MockBrowserPage();
    page.resultCards = [
      {
        href: "/browse/excelExternalWindow/DRSDOCID190185491920260813184047.0001",
        renderedText:
          "PMA Holder Name: B/E Aerospace Inc.\nPMA Holder Number: PQ3417CE\nPMA Part Number: 4660-2222-02",
      },
    ];
    const client = new FaaDrsBrowserClient({
      browserFactory: new MockBrowserFactory(page),
      sleep: noSleep,
      maxRetries: 0,
    });

    await expect(
      client.search({ holderNumber: "PQ00076WB", maxRecords: 1 }),
    ).rejects.toBeInstanceOf(FaaDrsStaleResultsError);
  });


  it("rejects no-filter and over-limit queries before opening a browser", async () => {
    const browserFactory = new MockBrowserFactory();
    const client = new FaaDrsBrowserClient({ browserFactory, sleep: noSleep });

    await expect(client.search({ maxRecords: 1 })).rejects.toThrow();
    await expect(
      client.search({ holderNumber: "PQ1826CE", maxRecords: 26 }),
    ).rejects.toThrow();
    expect(browserFactory.opens).toBe(0);
  });

  it.each([
    [401, "", "unauthorized"],
    [403, "", "forbidden"],
    [429, "", "rate_limited"],
    [200, "Complete the CAPTCHA to continue", "captcha"],
    [200, "Sign in required to continue access", "authentication_required"],
  ] as const)(
    "stops with a typed access error for status/body case %#",
    async (status, body, reason) => {
      const page = new MockBrowserPage();
      page.navigationStatus = status;
      page.renderedBody = body;
      const browserFactory = new MockBrowserFactory(page);
      const client = new FaaDrsBrowserClient({
        browserFactory,
        sleep: noSleep,
      });

      const rejection = client.search({ partNumber: "RAM-101-1", maxRecords: 1 });
      await expect(rejection).rejects.toBeInstanceOf(FaaDrsAccessError);
      await expect(rejection).rejects.toMatchObject({ reason });
      expect(browserFactory.opens).toBe(1);
    },
  );

  it("never exceeds three retries and backs off at least one second", async () => {
    const sleeps: number[] = [];
    let opens = 0;
    let nowMs = 10_000;
    const browserFactory: FaaDrsBrowserFactory = {
      async open() {
        opens += 1;
        throw new Error("browser process exited");
      },
    };
    const client = new FaaDrsBrowserClient({
      browserFactory,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        nowMs += milliseconds;
      },
      maxRetries: 3,
      nowMs: () => nowMs,
    });

    await expect(
      client.search({ model: "HTF7000", maxRecords: 1 }),
    ).rejects.toMatchObject({ transient: true });
    expect(opens).toBe(4);
    expect(sleeps).toEqual([1_000, 2_000, 4_000]);
  });

  it("refuses navigation away from the public PMA page", async () => {
    const page = new MockBrowserPage();
    page.navigationUrl = "https://drs.faa.gov/api/documents/search";
    const client = new FaaDrsBrowserClient({
      browserFactory: new MockBrowserFactory(page),
      sleep: noSleep,
    });

    await expect(
      client.search({ make: "Honeywell", maxRecords: 1 }),
    ).rejects.toBeInstanceOf(FaaDrsProtocolError);
  });
});

describe("FAA DRS source transport guard", () => {
  it("contains no private-route request construction or fetch client", () => {
    const source = readFileSync(new URL("./faa-drs.ts", import.meta.url), "utf8");
    expect(source).not.toContain("/api/");
    expect(source).not.toMatch(/\bfetch\s*\(/u);
    expect(source).not.toMatch(/\b(?:page|context)\.request\b/u);
  });
});
