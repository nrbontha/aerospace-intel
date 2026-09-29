import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import type * as DatabaseModule from "@asi/database";

import {
  classifyWebsiteEvidence,
  fetchWebsiteEvidence as fetchWebsiteEvidenceAccounted,
  type FetchWebsiteEvidenceOptions,
  normalizeEvidencePageText,
  splitScopedEvidenceStatements,
  type WebsiteFetchOutcome,
} from "../packages/research/src/enrichment/website.js";
import {
  extractWebsiteFacts,
  isFirstPartyNamedProductEvidence,
} from "../packages/research/src/enrichment/signal-evidence.js";
import {
  SafeFetchError,
  type SafeFetchResult,
} from "../packages/research/src/safe-fetch.js";

const providerAccounting = vi.hoisted(() => {
  const receipt = {
    id: "00000000-0000-4000-8000-000000000092",
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
  budgetScopeId: "website-test-scope",
  sourceSignalId: "00000000-0000-4000-8000-000000000093",
  dailyCapUsd: "1",
} as const;

function fetchWebsiteEvidence(
  apiKey: string,
  domainOrUrl: string,
  companyName: string,
  options: FetchWebsiteEvidenceOptions = {},
) {
  return fetchWebsiteEvidenceAccounted(apiKey, domainOrUrl, companyName, {
    accounting: testAccounting,
    ...options,
  });
}

function safeHtmlPage(
  url: string,
  content: string,
  finalUrl: string = url,
): SafeFetchResult {
  return {
    requestedUrl: url,
    finalUrl,
    contentType: "text/html",
    content,
    byteLength: Buffer.byteLength(content),
    contentSha256: createHash("sha256").update(content).digest("hex"),
    retrievedAt: "2026-09-28T12:00:00.000Z",
    durationMs: 5,
    redirects: [],
  };
}

describe("website evidence collection", () => {
  it("records an actual PDF-only catalog without inventing PDF evidence", async () => {
    const homepage = safeHtmlPage(
      "https://www.brackettaerofilters.com/",
      [
        "<html><head><title>Brackett Aero Filters | Home</title></head><body>",
        '<a href="catalog.html" title="Air Filter Catalog">Air Filter Catalog</a>',
        '<a href="contact.html">Contact</a>',
        "<p>FAA-PMA approved – 88 different models.</p>",
        "<footer>Copyright &copy; 2010 Brackett Aero Filters, Inc. All Rights Reserved.</footer>",
        "</body></html>",
      ].join(""),
    );
    const fetchUrl = vi.fn(async (url: string) => {
      if (url === "https://www.brackettaerofilters.com/catalog.html") {
        return safeHtmlPage(
          url,
          [
            "<html><head><title>Air Filter Catalog</title></head><body>",
            "<h1>Air Filter Catalog</h1>",
            '<p><a href="documents/2005Catalog.pdf">Download our entire catalog in PDF Format</a></p>',
            "</body></html>",
          ].join(""),
        );
      }
      throw new SafeFetchError("http_error", 404);
    });
    const fetchContents = vi.fn(async () => []);

    const result = await fetchWebsiteEvidence(
      "test-key",
      "brackettaerofilters.com",
      "Brackett Aero Filters, Inc.",
      {
        sourcePages: [homepage],
        fetchUrl,
        client: { fetchContents },
      },
    );

    expect(result.outcome).toBe("success");
    expect(result.pages.map((page) => page.url)).toEqual([
      "https://www.brackettaerofilters.com/",
      "https://www.brackettaerofilters.com/catalog.html",
    ]);
    expect(result.pages[0]).toMatchObject({
      contentSha256: homepage.contentSha256,
      retrievedAt: homepage.retrievedAt,
    });
    expect(result.pages[0]?.text).toContain(
      "Copyright © 2010 Brackett Aero Filters, Inc.",
    );
    expect(result.pages[1]?.text).toContain(
      "Download our entire catalog in PDF Format",
    );
    expect(result.productHints).toEqual([]);
    expect(fetchUrl).not.toHaveBeenCalledWith(
      "https://www.brackettaerofilters.com/documents/2005Catalog.pdf",
    );
    expect(fetchUrl.mock.calls.map(([url]) => url)).toEqual([
      "https://www.brackettaerofilters.com/catalog.html",
      "https://brackettaerofilters.com/about",
    ]);
    expect(fetchUrl).not.toHaveBeenCalledWith(
      "https://brackettaerofilters.com/products",
    );
    expect(fetchContents).not.toHaveBeenCalled();
  });

  it("retains substantive body text after oversized quoted attributes", async () => {
    const statement =
      "Example Controls designs and manufactures single and two-stage servo valves for safety-critical aerospace applications.";
    const homepage = safeHtmlPage(
      "https://controls.test/",
      [
        "<html><head><title>Example Controls</title></head><body>",
        `<div data-current-context='${"carousel item > ".repeat(900)}'></div>`,
        `<main><p>${statement}</p>`,
        "<p>ISO 9001 &amp; AS9100 Certificate of Registration.</p></main>",
        "</body></html>",
      ].join(""),
    );
    const fetchUrl = vi.fn(async () => {
      throw new SafeFetchError("http_error", 404);
    });

    const result = await fetchWebsiteEvidence(
      "test-key",
      "controls.test",
      "Example Controls, Inc.",
      {
        sourcePages: [homepage],
        fetchUrl,
        client: {
          fetchContentsWithMetadata: vi.fn(async () => ({
            results: [],
            providerCostUsd: null,
          })),
        },
      },
    );

    expect(result.outcome).toBe("success");
    expect(result.pages[0]).toMatchObject({
      contentSha256: homepage.contentSha256,
      retrievedAt: homepage.retrievedAt,
    });
    expect(result.pages[0]?.text).toContain(statement);
    expect(result.pages[0]?.text).not.toContain("carousel item");
    expect(result.productHints).toEqual([statement]);
    expect(result.excerpts).toBe(statement);
  });

  it("prioritizes complete publisher product statements over standards and headings", () => {
    const statement = [
      "Example Controls designs and manufactures the AX-900 electrohydraulic servo valve",
      "with qualified materials and documented performance throughout demanding thermal, vibration, pressure, endurance, contamination, and cold-start testing",
      "while retaining the complete source sentence through its final attributable claim.",
    ].join(" ");
    const evidence = classifyWebsiteEvidence([
      {
        url: "https://controls.test/products",
        title: "Products",
        text: [
          "AB-100 actuator installation and performance data.",
          "AB-200 actuator installation and performance data.",
          "AB-300 actuator installation and performance data.",
          "AB-400 actuator installation and performance data.",
          "AB-500 actuator installation and performance data.",
          "AB-600 actuator installation and performance data.",
          "ISO 9001:2015 & AS9100D Certificate of Registration.",
          statement,
        ].join("\n"),
      },
    ]);

    expect(evidence.productHints).toHaveLength(6);
    expect(evidence.productHints[0]).toBe(statement);
    expect(evidence.productHints.join("\n")).not.toContain("ISO 9001");
    expect(evidence.excerpts).toContain("final attributable claim.");
    expect(evidence.excerpts).not.toContain("…");
  });

  it("keeps lexical quotations publisher-scoped without losing genuine quotes", () => {
    const acquisition =
      "ADPma has recently been acquired by “buy and grow” private investors committed to supporting our long term expansion and success.";
    const branded =
      "“Buy and Grow” investors acquired Example Controls to support its expansion.";

    expect(splitScopedEvidenceStatements(`${acquisition}\n${branded}`)).toEqual(
      [
        { text: acquisition, quoted: false },
        { text: branded, quoted: false },
      ],
    );
    expect(
      splitScopedEvidenceStatements(
        "“We manufacture our AX-10 actuator. We test every unit.”",
      ),
    ).toEqual([
      { text: "“We manufacture our AX-10 actuator.", quoted: true },
      { text: "We test every unit.”", quoted: true },
    ]);
  });

  it("replaces a numeric null entity instead of manufacturing a NUL", () => {
    const normalized = normalizeEvidencePageText(
      "<p>Traceable lot &#0; remains valid evidence text.</p>",
    );

    expect(normalized).toBe("Traceable lot � remains valid evidence text.");
    expect(normalized).not.toContain("\u0000");
  });

  it.each([
    {
      label: "Aviation Pumps",
      href: "/markets/aviation",
      statement:
        "The AP-100 aviation pump is part of our manufactured product line.",
    },
    {
      label: "Technology",
      href: "/innovation",
      statement:
        "The CT-200 Celestia technology platform is part of our product family.",
    },
  ])(
    "follows source-visible $label navigation before the guessed product path",
    async ({ label, href, statement }) => {
      const homepage = safeHtmlPage(
        "https://manufacturer.test/",
        [
          "<html><body>",
          `<a href="${href}">${label}</a>`,
          "<p>Manufacturer Test designs and builds aerospace hardware.</p>",
          "</body></html>",
        ].join(""),
      );
      const productUrl = `https://manufacturer.test${href}`;
      const fetchUrl = vi.fn(async (url: string) => {
        if (url === productUrl) {
          return safeHtmlPage(
            url,
            [
              `<html><head><title>${label}</title></head><body>`,
              `<h1>${label}</h1>`,
              `<p>${statement}</p>`,
              `<p>${"Design, manufacturing, testing, and installation details. ".repeat(7)}</p>`,
              "</body></html>",
            ].join(""),
          );
        }
        throw new SafeFetchError("http_error", 404);
      });
      const fetchContents = vi.fn(async () => []);

      const result = await fetchWebsiteEvidence(
        "test-key",
        "manufacturer.test",
        "Manufacturer Test, Inc.",
        {
          sourcePages: [homepage],
          fetchUrl,
          client: { fetchContents },
        },
      );

      expect(result).toMatchObject({
        outcome: "success",
        websiteOffering: "products_menu",
        fetchesAttempted: 2,
        fetchesSucceeded: 2,
      });
      expect(result.pages.map((page) => page.url)).toEqual([
        "https://manufacturer.test/",
        productUrl,
      ]);
      expect(result.productHints.join(" ")).toContain(statement);
      expect(fetchUrl.mock.calls.map(([url]) => url)).toEqual([
        productUrl,
        "https://manufacturer.test/about",
      ]);
      expect(fetchUrl).not.toHaveBeenCalledWith(
        "https://manufacturer.test/products",
      );
      expect(fetchContents).not.toHaveBeenCalled();
    },
  );

  it("ignores comments, scripts, styles, and templates as navigation and evidence", async () => {
    const homepage = safeHtmlPage(
      "https://example.test/",
      [
        "<html><body>",
        '<!-- <a href="/comment-catalog">Product Catalog</a><p>COMMENT-101 trademark product line.</p> -->',
        '<script>const template = \'<a href="/script-products">Products</a>\'; const claim = "SCRIPT-202 product line";</script>',
        "<style>.hero::after { content: '<a href=\"/style-products\">Products</a> STYLE-303 product line'; }</style>",
        '<template><a href="/template-products">Products</a><p>TEMPLATE-404 product line.</p></template>',
        "<p>Example Test provides precision manufacturing services worldwide.</p>",
        "</body></html>",
      ].join(""),
    );
    const fetchUrl = vi.fn(async () => {
      throw new SafeFetchError("http_error", 404);
    });
    const fetchContents = vi.fn(async () => []);

    const result = await fetchWebsiteEvidence(
      "test-key",
      "example.test",
      "Example Test, Inc.",
      {
        sourcePages: [homepage],
        fetchUrl,
        client: { fetchContents },
      },
    );

    expect(result).toMatchObject({
      outcome: "success",
      websiteOffering: "unknown",
      productHints: [],
      fetchesAttempted: 2,
      fetchesSucceeded: 1,
    });
    expect(result.pages[0]?.text).toBe(
      "Example Test provides precision manufacturing services worldwide.",
    );
    expect(fetchUrl.mock.calls.map(([url]) => url)).toEqual([
      "https://example.test/products",
      "https://example.test/about",
    ]);
    expect(fetchContents).not.toHaveBeenCalled();
  });

  it("rejects external and local navigation and excludes an off-domain final redirect", async () => {
    const homepage = safeHtmlPage(
      "https://example.test/",
      [
        "<html><body>",
        '<a href="https://inventory.invalid/catalog">Product Catalog</a>',
        '<a href="http://127.0.0.1/admin">Internal Catalog</a>',
        '<a href="/catalog.html">Official Catalog</a>',
        "<footer>Copyright Example Aerospace, Inc.</footer>",
        "</body></html>",
      ].join(""),
    );
    const fetchUrl = vi.fn(async (url: string) => {
      if (url === "https://example.test/catalog.html") {
        return safeHtmlPage(
          url,
          "<html><body>Redirected supplier inventory.</body></html>",
          "https://redirect.invalid/catalog.html",
        );
      }
      throw new SafeFetchError("http_error", 404);
    });
    const fetchContents = vi.fn(async () => []);

    const result = await fetchWebsiteEvidence(
      "test-key",
      "example.test",
      "Example Aerospace, Inc.",
      {
        sourcePages: [homepage],
        fetchUrl,
        client: { fetchContents },
      },
    );

    expect(result.outcome).toBe("success");
    expect(result.pages.map((page) => page.url)).toEqual([
      "https://example.test/",
    ]);
    expect(fetchUrl.mock.calls.map(([url]) => url)).toEqual([
      "https://example.test/catalog.html",
      "https://example.test/about",
    ]);
    expect(fetchUrl).not.toHaveBeenCalledWith(
      "https://inventory.invalid/catalog",
    );
    expect(fetchUrl).not.toHaveBeenCalledWith("http://127.0.0.1/admin");
    expect(fetchContents).not.toHaveBeenCalled();
  });

  it("retains partial pages while surfacing a transient discovered-page failure", async () => {
    const homepage = safeHtmlPage(
      "https://example.test/",
      [
        "<html><body>",
        '<a href="/catalog.html">Product Catalog</a>',
        "<footer>Copyright Example Aerospace, Inc.</footer>",
        "</body></html>",
      ].join(""),
    );
    const fetchUrl = vi.fn(async (url: string) => {
      if (url === "https://example.test/catalog.html") {
        throw new SafeFetchError("http_error", 503);
      }
      throw new SafeFetchError("http_error", 404);
    });
    const fetchContents = vi.fn(async () => []);

    const result = await fetchWebsiteEvidence(
      "test-key",
      "example.test",
      "Example Aerospace, Inc.",
      {
        sourcePages: [homepage],
        fetchUrl,
        client: { fetchContents },
      },
    );

    expect(result).toMatchObject({
      outcome: "retryable_error",
      costUsd: 0,
      fetchesAttempted: 2,
      fetchesSucceeded: 1,
    });
    expect(result.pages.map((page) => page.url)).toEqual([
      "https://example.test/",
    ]);
    expect(fetchContents).not.toHaveBeenCalled();
  });

  it("treats a reused nested home document as the primary landing page", async () => {
    const homepage = safeHtmlPage(
      "https://legacy.test/pc/home.asp",
      [
        "<html><body>",
        '<a href="catalog.asp">Product Catalog</a>',
        "<footer>Copyright Legacy Aerospace, Inc.</footer>",
        "</body></html>",
      ].join(""),
    );
    const fetchUrl = vi.fn(async (url: string) => {
      if (url === "https://legacy.test/pc/catalog.asp") {
        return safeHtmlPage(
          url,
          "<html><body><h1>Product Catalog</h1><p>AX-200 actuator application and installation details.</p></body></html>",
        );
      }
      throw new SafeFetchError("http_error", 404);
    });
    const fetchContents = vi.fn(async () => []);

    const result = await fetchWebsiteEvidence(
      "test-key",
      "legacy.test",
      "Legacy Aerospace, Inc.",
      {
        sourcePages: [homepage],
        fetchUrl,
        client: { fetchContents },
      },
    );

    expect(result.outcome).toBe("success");
    expect(result.pages.map((page) => page.url)).toEqual([
      "https://legacy.test/pc/home.asp",
      "https://legacy.test/pc/catalog.asp",
    ]);
    expect(fetchUrl.mock.calls.map(([url]) => url)).toEqual([
      "https://legacy.test/pc/catalog.asp",
      "https://legacy.test/about",
    ]);
    expect(fetchUrl).not.toHaveBeenCalledWith("https://legacy.test/");
    expect(fetchContents).not.toHaveBeenCalled();
  });

  it.each([
    { status: 404, expected: "provider_error" },
    { status: 503, expected: "retryable_error" },
  ] satisfies ReadonlyArray<{
    status: number;
    expected: WebsiteFetchOutcome;
  }>)(
    "keeps HTTP $status operational semantics as $expected",
    async ({ status, expected }) => {
      const fetchUrl = vi.fn(async () => {
        throw new SafeFetchError("http_error", status);
      });
      const fetchContents = vi.fn(async () => []);

      const result = await fetchWebsiteEvidence(
        "test-key",
        "example.test",
        "Example Aerospace, Inc.",
        { fetchUrl, client: { fetchContents } },
      );

      expect(result).toMatchObject({
        outcome: expected,
        costUsd: 0,
        fetchesAttempted: 3,
        fetchesSucceeded: 0,
        pages: [],
      });
      expect(fetchContents).not.toHaveBeenCalled();
    },
  );

  it("retains supplier inventory and customer quotations without treating either as own-product proof", async () => {
    const homepage = safeHtmlPage(
      "https://supplier.test/",
      [
        "<html><body>",
        '<a href="/inventory/catalog.html">Product Catalog</a>',
        "<p>Independent aerospace parts stocking and fulfillment.</p>",
        "</body></html>",
      ].join(""),
    );
    const fetchUrl = vi.fn(async (url: string) => {
      if (url === "https://supplier.test/inventory/catalog.html") {
        return safeHtmlPage(
          url,
          [
            "<html><head><title>Supplier Product Catalog</title></head><body>",
            "<p>SKU: TV-555D valve is available from our inventory for same-day fulfillment.</p>",
            "<p>We distribute stocked components made by third-party manufacturers.</p>",
            "<h2>Customer spotlight: Atlas</h2>",
            "<p>We manufacture our AX-10 actuator for aircraft operators.</p>",
            "</body></html>",
          ].join(""),
        );
      }
      throw new SafeFetchError("http_error", 404);
    });
    const fetchContents = vi.fn(async () => []);

    const result = await fetchWebsiteEvidence(
      "test-key",
      "supplier.test",
      "Supplier Test, Inc.",
      {
        sourcePages: [homepage],
        fetchUrl,
        client: { fetchContents },
      },
    );

    expect(result.websiteOffering).toBe("products_menu");
    expect(result.productHints.join(" ")).toContain("TV-555D");
    expect(result.productHints.join(" ")).toContain("AX-10");
    expect(isFirstPartyNamedProductEvidence(result.excerpts)).toBe(false);
    expect(fetchContents).not.toHaveBeenCalled();
  });

  it("keeps HTML blockquote speaker scope across sentences without hiding later publisher facts", async () => {
    const homepage = safeHtmlPage(
      "https://beacon.test/",
      [
        "<html><head><title>Beacon Aerospace</title></head><body>",
        "<p>Our customer Atlas says:</p>",
        "<blockquote>",
        "<p>We build aircraft systems.</p>",
        "<p>We manufacture our AX-10 actuator for aircraft operators.</p>",
        "<p>We are family-owned. Our annual revenue is $20 million.</p>",
        "<p>Our headquarters are in Austin, Texas, United States.</p>",
        "</blockquote>",
        "<p>We remain family-owned.</p>",
        "<p>Our annual revenue is $80 million.</p>",
        "<p>Our headquarters are in Denver, CO.</p>",
        "</body></html>",
      ].join(""),
    );
    const fetchUrl = vi.fn(async () => {
      throw new SafeFetchError("http_error", 404);
    });

    const result = await fetchWebsiteEvidence(
      "test-key",
      "beacon.test",
      "Beacon Aerospace LLC",
      {
        sourcePages: [homepage],
        fetchUrl,
        client: {
          fetchContentsWithMetadata: vi.fn(async () => ({
            results: [],
            providerCostUsd: null,
          })),
        },
      },
    );

    expect(result.outcome).toBe("success");
    expect(isFirstPartyNamedProductEvidence(result.pages[0]?.text ?? "")).toBe(
      false,
    );
    expect(isFirstPartyNamedProductEvidence(result.excerpts)).toBe(false);
    expect(extractWebsiteFacts(result, "Beacon Aerospace LLC")).toMatchObject({
      ownershipStatus: "independent",
      sizeAssessment: "over_50m",
      headquartersStatus: "supported",
      headquarters: { city: "Denver", state: "CO", country: "US" },
    });
  });

  it("accounts injected Exa results while excluding off-domain content", async () => {
    const fetchUrl = vi.fn(async (url: string) =>
      safeHtmlPage(url, "<html><script>renderClientSide()</script></html>"),
    );
    const fetchContentsWithMetadata = vi.fn(async () => ({
      results: [
        {
          url: "https://example.test/catalog.html",
          title: "Catalog",
          text: "Product catalog details for the AX-200 actuator family.",
        },
        {
          url: "https://redirect.invalid/catalog.html",
          title: "Wrong site",
          text: "Off-domain text must not be accepted.",
        },
      ],
      providerCostUsd: null,
    }));

    const result = await fetchWebsiteEvidence(
      "test-key",
      "example.test",
      "Example Aerospace, Inc.",
      { fetchUrl, client: { fetchContentsWithMetadata } },
    );

    expect(result).toMatchObject({
      outcome: "success",
      costUsd: 0,
      fetchesAttempted: 6,
      fetchesSucceeded: 1,
    });
    expect(result.pages.map((page) => page.url)).toEqual([
      "https://example.test/catalog.html",
    ]);
  });
});
