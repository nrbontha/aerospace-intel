import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as DatabaseModule from "@asi/database";

import {
  closeDatabase,
  getDatabase,
  type Database,
} from "../packages/database/src/client.js";
import { runMigrations } from "../packages/database/src/migrate.js";
import { sourceSignals } from "../packages/database/src/schema.js";

import {
  admitSignalResourceEvidence,
  assessSignalSiteIdentity,
  buildSignalIdentityQuote,
  classifyExplicitRevenueSize,
  extractFirstPartyNamedProductQuotes,
  extractWebsiteFacts,
  isFirstPartyNamedProductEvidence,
  researchSignalEvidence as researchSignalEvidenceAccounted,
} from "../packages/research/src/enrichment/signal-evidence.js";
import type { WebsiteFetchResult } from "../packages/research/src/enrichment/website.js";
import { SafeFetchError } from "../packages/research/src/safe-fetch.js";
import type { ResearchSignalEvidenceOptions } from "../packages/research/src/enrichment/signal-evidence.js";
import type { SourcedSignalResearchEvidence } from "../packages/research/src/enrichment/signal-evidence.js";
import type { AnalystResourceObservation } from "../packages/research/src/analyst-resources.js";
import type {
  ExaContentsResult,
  ExaSearchResult,
} from "../packages/research/src/search/exa.js";

const providerAccounting = vi.hoisted(() => {
  const receipt = {
    id: "00000000-0000-4000-8000-000000000094",
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

function researchSignalEvidence(options: ResearchSignalEvidenceOptions) {
  return researchSignalEvidenceAccounted({
    exaBudgetScopeId: "signal-evidence-test-scope",
    ...options,
  });
}

function metadataSearchClient(
  results: readonly ExaSearchResult[] = [],
) {
  return {
    searchWithMetadata: vi.fn(async () => ({
      results,
      providerCostUsd: null,
    })),
    fetchContentsWithMetadata: vi.fn(async () => ({
      results: [] as readonly ExaContentsResult[],
      providerCostUsd: null,
    })),
  };
}

const identity = {
  rawName: "Electronics International, Inc.",
  uei: null,
  cage: "1ABC2",
  city: "Anaheim",
  state: "CA",
} as const;

function fetchedWebsite(text: string): WebsiteFetchResult {
  return fetchedWebsitePages(text);
}

function fetchedWebsitePages(...texts: readonly string[]): WebsiteFetchResult {
  return {
    outcome: "success",
    errorCode: null,
    costUsd: 0.01,
    fetchesAttempted: texts.length,
    fetchesSucceeded: texts.length,
    budgetLimited: false,
    websiteOffering: "unknown",
    excerpts: texts.join("\n"),
    ownershipHints: [],
    sizeHints: [],
    productHints: [],
    pages: texts.map((text, index) => ({
      url: `https://example.test/page-${String(index + 1)}`,
      title: `Page ${String(index + 1)}`,
      text,
      textChars: text.length,
      excerpt: text.slice(0, 500),
      contentSha256: String(index + 1).repeat(64),
      retrievedAt: "2026-09-27T12:00:00.000Z",
    })),
  };
}

function fetchedWebsiteWithTitle(
  title: string,
  text: string,
): WebsiteFetchResult {
  const website = fetchedWebsite(text);
  return {
    ...website,
    pages: website.pages.map((page) => ({ ...page, title })),
  };
}

function sameSitePublisherJsonLd(companyName: string, siteUrl: string): string {
  const rootUrl = new URL("/", siteUrl).href;
  const organizationId = `${rootUrl}#organization`;
  return `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        name: `Home - ${companyName}`,
        url: rootUrl,
      },
      {
        "@type": "WebSite",
        "@id": `${rootUrl}#website`,
        url: rootUrl,
        publisher: { "@id": organizationId },
      },
      {
        "@type": "Organization",
        "@id": organizationId,
        name: companyName,
        url: rootUrl,
      },
    ],
  })}</script>`;
}

describe("raw signal official-site identity", () => {
  it("requires corroboration and does not accept a location-mismatched homonym", () => {
    const result = assessSignalSiteIdentity(identity, [
      "Infinite Electronics International is based in Boston, MA. This corporate website contains products, services, careers, and general contact information for the global organization.",
    ]);

    expect(result.status).toBe("ambiguous");
    expect(result.corroboratedBy).toBeNull();
  });

  it("does not accept a longer publisher identity even at the same location", () => {
    const result = assessSignalSiteIdentity(identity, [
      "Infinite Electronics International is based in Anaheim, CA. Our company supplies electronic components and publishes product, support, careers, and contact information for customers.",
    ]);

    expect(result.status).toBe("ambiguous");
    expect(result.nameMatched).toBe(false);
  });

  it("requires exact city and labeled identifier boundaries", () => {
    const wrongCity = assessSignalSiteIdentity(
      { ...identity, city: "York", state: "NY", cage: null },
      [
        "Electronics International, Inc. designs aircraft instruments. Our manufacturing office is located in Yorkshire, NY, and our teams provide product support worldwide.",
      ],
    );
    const wrongCage = assessSignalSiteIdentity(
      { ...identity, city: null, state: null },
      [
        "Electronics International, Inc. designs aircraft instruments. Our company identifier is CAGE X1ABC2Y, and our teams provide product support worldwide.",
      ],
    );

    expect(wrongCity.status).toBe("ambiguous");
    expect(wrongCage.status).toBe("ambiguous");
  });

  it("preserves legal-name connectors and accepts an exact labeled identifier", () => {
    const result = assessSignalSiteIdentity(
      {
        rawName: "Smith and Jones Aerospace LLC",
        uei: null,
        cage: "7XY91",
        city: null,
        state: null,
      },
      [
        "Smith and Jones Aerospace LLC manufactures precision flight controls. We design and build components for commercial operators. CAGE Code: 7XY91. Contact our support and sales teams.",
      ],
    );

    expect(result).toMatchObject({
      status: "verified",
      nameMatched: true,
      corroboratedBy: "identifier",
    });
  });

  it("does not treat a publisher's target mention as self-identification", () => {
    const result = assessSignalSiteIdentity(identity, [
      "Our supplier directory includes Electronics International, Inc. in Anaheim, CA. We publish profiles, market reports, product comparisons, and contact information for aerospace businesses.",
    ]);

    expect(result.status).toBe("ambiguous");
    expect(result.nameMatched).toBe(false);
  });

  it("does not treat a parent portfolio relationship as publisher identity", () => {
    const result = assessSignalSiteIdentity(
      {
        rawName: "Beacon Aerospace LLC",
        uei: null,
        cage: null,
        city: "Denver",
        state: "CO",
      },
      [
        "Atlas Group portfolio companies. Beacon Aerospace LLC is a subsidiary of Atlas Group. Beacon Aerospace LLC operates in Denver, CO.",
      ],
    );

    expect(result).toMatchObject({
      status: "ambiguous",
      nameMatched: false,
    });
  });

  it("does not let a target heading turn publisher voice into self-identification", () => {
    const result = assessSignalSiteIdentity(
      {
        rawName: "Beacon Aerospace LLC",
        uei: null,
        cage: null,
        city: "Austin",
        state: "TX",
      },
      [
        [
          "# Beacon Aerospace LLC",
          "Our supplier directory lists this manufacturer at 123 Main Street, Austin, TX 78701.",
          "Contact our editorial team to correct this listing.",
          "We maintain a comprehensive industrial business directory for purchasing teams.",
        ].join("\n"),
      ],
    );

    expect(result).toMatchObject({
      status: "ambiguous",
      nameMatched: false,
      corroboratedBy: "location",
    });
  });

  it("does not let a directory suffix turn publisher voice into self-identification", () => {
    const result = assessSignalSiteIdentity(
      {
        rawName: "Beacon Aerospace LLC",
        uei: null,
        cage: null,
        city: "Austin",
        state: "TX",
      },
      [
        "Beacon Aerospace LLC is an aerospace manufacturer listed in our supplier directory at 123 Main Street, Austin, TX 78701. Contact our editorial team to correct this listing.",
      ],
    );

    expect(result).toMatchObject({
      status: "ambiguous",
      nameMatched: false,
      corroboratedBy: "location",
    });
  });

  it("does not treat a complete third-party directory profile as publisher identity", () => {
    const result = assessSignalSiteIdentity(
      {
        rawName: "Beacon Aerospace LLC",
        uei: null,
        cage: null,
        city: "Austin",
        state: "TX",
      },
      [
        [
          "Independent Supplier Directory",
          "Our supplier directory lists manufacturers in the aerospace industry.",
          "Beacon Aerospace LLC designs and manufactures actuators.",
          "Address: 123 Flight Road, Austin, TX 78701.",
          "Copyright 2026 Independent Directory Inc.",
        ].join("\n"),
      ],
    );

    expect(result).toMatchObject({
      status: "ambiguous",
      nameMatched: false,
    });
  });

  it("rejects chamber member copy and its context-stripped retained quote", () => {
    const pageUrl =
      "https://members.nashuachamber.com/list/member/bae-systems-20240";
    const signal = {
      rawName: "BAE SYSTEMS",
      uei: null,
      cage: null,
      city: "Nashua",
      state: "NH",
    } as const;
    const content = [
      "<title>BAE Systems | Manufacturing - Greater Nashua Chamber of Commerce</title>",
      "<h1>BAE Systems</h1>",
      "<h5>Categories</h5><p>Manufacturing</p>",
      '<a href="http://www.baesystems.com">Visit Website</a>',
      "<h3>About Us</h3>",
      "<p>At BAE Systems, we provide some of the world's most advanced, technology-led defense, aerospace and security solutions.</p>",
      "<p>PO Box 868, NHQ1-747 Nashua NH 03061</p>",
      "<footer>60 Main Street, Suite 200 Nashua, NH 03060 © 2026 Greater Nashua Chamber of Commerce. All Rights Reserved.</footer>",
    ].join("");
    const retainedQuote = [
      "At BAE Systems, we provide some of the world's most advanced, technology-led defense, aerospace and security solutions.",
      "Nashua, NH 03060",
    ].join("\n");

    for (const evidence of [content, retainedQuote]) {
      expect(
        assessSignalSiteIdentity(signal, [evidence], [pageUrl]),
      ).toMatchObject({
        status: "ambiguous",
        nameMatched: false,
        corroboratedBy: null,
      });
    }
    const assessment = assessSignalSiteIdentity(signal, [content], [pageUrl]);
    expect(
      buildSignalIdentityQuote(content, pageUrl, signal, assessment),
    ).toBe("");
  });

  it("rejects a copied target Organization when the site publishes data profiles", () => {
    const signal = {
      rawName: "Avtech Tyee Inc",
      uei: null,
      cage: null,
      city: "Everett",
      state: "WA",
    } as const;
    const pageUrl = "https://trade-data.example/records/avtech-tyee";
    const content = [
      `<script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": "WebSite",
            url: "https://trade-data.example/",
            publisher: {
              "@type": "Organization",
              name: "Global Trade Data Ltd",
            },
          },
          {
            "@type": "Organization",
            name: signal.rawName,
            url: "https://trade-data.example/",
          },
        ],
      })}</script>`,
      "<nav>Our Data Pricing Market Intelligence</nav>",
      "<main>Supplier profile. Avtech Tyee Inc imports and exports aircraft components. Address: 6500 Merrill Creek Parkway, Everett, WA 98203.</main>",
      "<footer>© Copyright 2026, Global Trade Data Ltd. All rights reserved.</footer>",
    ].join("");
    expect(
      assessSignalSiteIdentity(signal, [content], [pageUrl]),
    ).toMatchObject({
      status: "ambiguous",
      nameMatched: false,
      corroboratedBy: null,
    });

    const retainedPageUrl =
      "https://data.example/en/company/avtech-tyee-inc/4d4ebc460fa287d13610f99e08c1527a3288e049846f6cf33e60fb0a8685246f";
    const retainedQuote = [
      '[normalized JSON-LD publisher evidence; not a verbatim quote; role=Organization.root; locator="https://data.example"]',
      '<script type="application/ld+json">{"@type":"Organization","url":"https://data.example","name":"Avtech Tyee Inc"}</script>',
      "6500 Merrill Creek Parkway Everett, WA 98203",
    ].join("\n");
    expect(
      assessSignalSiteIdentity(
        signal,
        [retainedQuote],
        [retainedPageUrl],
      ),
    ).toMatchObject({
      status: "ambiguous",
      nameMatched: false,
      corroboratedBy: null,
    });
  });

  it("preserves a manufacturer page hosted within its parent's site", () => {
    const pageUrl =
      "https://www.pccfasteners.com/companies/pcc-fasteners/pb-fasteners.html";
    const signal = {
      rawName: "PB Fasteners",
      uei: null,
      cage: null,
      city: "Gardena",
      state: "CA",
    } as const;
    const content = [
      "<title>PCC Fasteners | PCC Fasteners - PB Fasteners</title>",
      "<h1>PCC Fasteners - PB Fasteners</h1>",
      "<h2>PB Fasteners</h2>",
      "<p>Our company manufactures airframe structural bolts, fuse pins, screws, and nuts for aerospace customers.</p>",
      "<p>PB Fasteners is devoted to manufacturing high-strength aerospace fasteners and maintains its own quality system.</p>",
      "<address>1700 W. 132nd Street, Gardena, CA 90249</address>",
    ].join("");
    const assessment = assessSignalSiteIdentity(
      signal,
      [content],
      [pageUrl],
    );
    const quote = buildSignalIdentityQuote(
      content,
      pageUrl,
      signal,
      assessment,
    );

    expect(assessment).toMatchObject({
      status: "verified",
      nameMatched: true,
      corroboratedBy: "location",
    });
    expect(quote).not.toBe("");
    expect(quote.length).toBeLessThanOrEqual(500);
    expect(assessSignalSiteIdentity(signal, [quote], [pageUrl])).toMatchObject({
      status: "verified",
      nameMatched: true,
      corroboratedBy: "location",
    });
  });

  it("does not use a customer-market state as the publisher location", () => {
    const result = assessSignalSiteIdentity({ ...identity, city: null }, [
      "Electronics International, Inc. designs aircraft instruments. We manufacture our own engine monitoring and flight-control products. We serve customers throughout CA and other western markets.",
    ]);

    expect(result).toMatchObject({
      status: "ambiguous",
      nameMatched: true,
      corroboratedBy: null,
    });
  });

  it("accepts the exact legal identity with source-page location corroboration", () => {
    const result = assessSignalSiteIdentity(identity, [
      "Electronics International, Inc. designs and manufactures aircraft instruments. Our office and manufacturing team is located at 123 Aviation Way, Anaheim, CA 92801. Contact our team for product support and sales. Electronics International, Inc. is a subsidiary of Atlas Group.",
    ]);

    expect(result).toMatchObject({
      status: "verified",
      nameMatched: true,
      corroboratedBy: "location",
    });
  });

  it("matches exact US city/state evidence across full names and USPS codes", () => {
    const actualPublisherPassage = [
      sameSitePublisherJsonLd("ROMCO Manufacturing", "https://www.romco.net/"),
      "Romco Manufacturing is located about twenty minutes South East of Houston, Texas in Deer Park, Texas.",
      "We have since grown into a full service manufacturing facility that is currently satisfying Gas/Steam turbine customers in the Oil and Gas industry as well as big name customers in the Military, Aerospace and Packaging/Brewing industries.",
      "© Copyright 2001-2021, All Rights Reserved",
      "ROMCO Manufacturing",
    ].join("\n");
    const rawAbbreviation = assessSignalSiteIdentity(
      {
        rawName: "Romco Manufacturing",
        uei: null,
        cage: null,
        city: "Deer Park",
        state: "TX",
      },
      [actualPublisherPassage],
      ["https://www.romco.net/"],
    );
    const rawFullName = assessSignalSiteIdentity(
      {
        rawName: "Romco Manufacturing",
        uei: null,
        cage: null,
        city: "Deer Park",
        state: "Texas",
      },
      [
        actualPublisherPassage.replaceAll(
          "Houston, Texas in Deer Park, Texas",
          "Houston, TX in Deer Park, TX",
        ),
      ],
      ["https://www.romco.net/"],
    );

    expect(rawAbbreviation).toMatchObject({
      status: "verified",
      nameMatched: true,
      corroboratedBy: "location",
    });
    expect(rawFullName).toMatchObject({
      status: "verified",
      nameMatched: true,
      corroboratedBy: "location",
    });
  });

  it("does not relax exact location corroboration for a mismatched or absent state", () => {
    const signal = {
      rawName: "Romco Manufacturing",
      uei: null,
      cage: null,
      city: "Deer Park",
      state: "TX",
    } as const;
    const publisherContext = [
      sameSitePublisherJsonLd("ROMCO Manufacturing", "https://www.romco.net/"),
      "We have since grown into a full service manufacturing facility that is currently satisfying Gas/Steam turbine customers.",
      "© Copyright 2001-2021, All Rights Reserved",
      "ROMCO Manufacturing",
    ].join("\n");
    const mismatched = assessSignalSiteIdentity(
      signal,
      [
        `Romco Manufacturing is located about twenty minutes South East of Houston, Louisiana in Deer Park, Louisiana.\n${publisherContext}`,
      ],
      ["https://www.romco.net/"],
    );
    const absent = assessSignalSiteIdentity(
      signal,
      [
        `Romco Manufacturing provides company, product, quality, and contact information.\n${publisherContext}`,
      ],
      ["https://www.romco.net/"],
    );

    expect(mismatched).toMatchObject({
      nameMatched: true,
      corroboratedBy: null,
      status: "ambiguous",
    });
    expect(absent).toMatchObject({
      nameMatched: true,
      corroboratedBy: null,
      status: "ambiguous",
    });
  });

  it("requires a ZIP after state-only USPS codes even when raw states are full names", () => {
    const beaconUrl = "https://beacon-aerospace.example/";
    const publisherContext = sameSitePublisherJsonLd(
      "Beacon Aerospace LLC",
      beaconUrl,
    );
    const cases = [
      {
        state: "Indiana",
        text: "Beacon Aerospace LLC designs aircraft systems in our manufacturing facility and publishes product and contact information. Our company manufactures flight controls.",
      },
      {
        state: "Oregon",
        text: "Beacon Aerospace LLC designs aircraft systems or supplies repair teams with product and contact information. Our company manufactures flight controls.",
      },
      {
        state: "Maine",
        text: "Beacon Aerospace LLC designs aircraft systems; contact me through our office for product and support information. Our company manufactures flight controls.",
      },
      {
        state: "Indiana",
        text: "Beacon Aerospace LLC designs aircraft systems. Our office is in IN and provides product and contact information. Our company manufactures flight controls.",
      },
    ] as const;

    for (const testCase of cases) {
      expect(
        assessSignalSiteIdentity(
          {
            rawName: "Beacon Aerospace LLC",
            uei: null,
            cage: null,
            city: null,
            state: testCase.state,
          },
          [`${publisherContext}\n${testCase.text}`],
          [beaconUrl],
        ),
      ).toMatchObject({
        nameMatched: true,
        corroboratedBy: null,
        status: "ambiguous",
      });
    }

    expect(
      assessSignalSiteIdentity(
        {
          rawName: "Beacon Aerospace LLC",
          uei: null,
          cage: null,
          city: null,
          state: "Indiana",
        },
        [
          [
            publisherContext,
            "Our facility is in IN 46201.",
            "Our company manufactures flight controls and publishes detailed product, engineering, support, and contact information for aircraft operators.",
          ].join("\n"),
        ],
        [beaconUrl],
      ),
    ).toMatchObject({
      nameMatched: true,
      corroboratedBy: "location",
      status: "verified",
    });
  });

  it("accepts exact legal publisher subjects split across lines or followed by a branded acronym", () => {
    const northStar = assessSignalSiteIdentity(
      {
        rawName: "North Star Aviation Inc",
        uei: null,
        cage: null,
        city: "Ulysses",
        state: "KS",
      },
      [
        [
          "We are a full service facility for agriculture aircraft.",
          "North Star Aviation",
          "North Star",
          "Aviation, Inc. takes pride in offering quality service to our customers.",
          "Mailing Address",
          "PO Box 412",
          "Ulysses KS, 67880",
        ].join("\n"),
      ],
    );
    const aeci = assessSignalSiteIdentity(
      {
        rawName: "Aviation Engineering Consultants Inc",
        uei: null,
        cage: null,
        city: "Clearwater",
        state: "FL",
      },
      [
        [
          "AECI - Beechcraft Aircraft Parts, Engineering and Manufacturing, Clearwater, FL.",
          "Aviation Engineering Consultants, Inc. (AECI) designs, certifies, manufactures and sells FAA-PMA replacement parts.",
          "2754 Sunset Point Road",
          "Clearwater, Florida 33759",
          "© 2014 - , Aviation Engineering Consultants, Inc. (AECI). All Rights Reserved.",
        ].join("\n"),
      ],
    );

    expect(northStar).toMatchObject({
      status: "verified",
      nameMatched: true,
      corroboratedBy: "location",
    });
    expect(aeci).toMatchObject({
      status: "verified",
      nameMatched: true,
      corroboratedBy: "location",
    });
  });

  it("recognizes an exact first-person publisher introduction without a manufacturing prerequisite", () => {
    const result = assessSignalSiteIdentity(
      {
        rawName: "Armstrong Manufacturing & Engineering",
        uei: null,
        cage: null,
        city: "Auburn",
        state: "CA",
      },
      [
        "At Armstrong Manufacturing & Engineering, we are obsessed with quality craftsmanship and customer satisfaction.\nAddress: 12780 Earhart Ave. Auburn CA 95602.",
      ],
    );
    expect(result).toMatchObject({
      status: "verified",
      nameMatched: true,
      corroboratedBy: "location",
    });
  });

  it("allows only a terminal legal-suffix omission in an explicit publisher introduction", () => {
    const signal = {
      rawName: "Beacon Aerospace LLC",
      uei: null,
      cage: null,
      city: "Austin",
      state: "TX",
    };
    const page = (publisher: string) =>
      `We are ${publisher}, and our team supports aircraft operators worldwide.\nOur office is located at 123 Main Street, Austin, TX 78701.`;
    expect(
      assessSignalSiteIdentity(signal, [page("Beacon Aerospace")]).status,
    ).toBe("verified");
    expect(
      assessSignalSiteIdentity(signal, [page("Beacon Aerospace Services")])
        .status,
    ).toBe("ambiguous");
    expect(
      assessSignalSiteIdentity(signal, [page("North Beacon Aerospace")]).status,
    ).toBe("ambiguous");
  });

  it("accepts the real publisher footer with a decoded copyright entity", () => {
    const result = assessSignalSiteIdentity(
      {
        rawName: "Brackett Aero Filters Inc.",
        uei: null,
        cage: null,
        city: "Kingman",
        state: "AZ",
      },
      [
        [
          "<html><body><main>Brackett replacement air filter information and customer support.</main>",
          "<address>7045 Flightline Drive, Kingman, AZ 86401</address>",
          "<footer>Copyright <strong>&copy;</strong> 2010 Brackett Aero Filters, Inc.. All Rights Reserved.</footer>",
          "</body></html>",
        ].join(""),
      ],
    );

    expect(result).toMatchObject({
      status: "verified",
      nameMatched: true,
      corroboratedBy: "location",
    });
  });

  it("accepts a publisher footer that omits only the legal suffix", () => {
    const result = assessSignalSiteIdentity(
      {
        rawName: "Brackett Aero Filters, Inc.",
        uei: null,
        cage: null,
        city: "Kingman",
        state: "AZ",
      },
      [
        [
          "<html><body><address>7045 Flightline Drive, Kingman, AZ 86401</address>",
          "<p>Replacement air filter information, installation resources, and customer support.</p>",
          "<footer>Copyright &#169; 2010 Brackett Aero Filters. All Rights Reserved.</footer>",
          "</body></html>",
        ].join(""),
      ],
    );

    expect(result).toMatchObject({
      status: "verified",
      nameMatched: true,
      corroboratedBy: "location",
    });
  });

  it("recognizes bounded real-world copyright ordering and legal-suffix formats", () => {
    const cases = [
      {
        rawName: "Jet Parts Engineering, LLC",
        footer:
          "© 2026 Jet Parts Engineering. All Rights Reserved. | Privacy Policy | Terms of Use",
      },
      {
        rawName: "Fiber Dynamics, Inc.",
        footer: "© 2026 All Rights Reserved | Fiber Dynamics Inc.",
      },
      {
        rawName: "Jay- Em Aerospace Corporation",
        footer:
          "© 2025 Jay-Em Aerospace Corp. All rights reserved. | Privacy Policy",
      },
      {
        rawName: "Skylock Industries",
        footer:
          "© 2026 Skylock Industries, Inc. All Rights Reserved. Website by Bluefin Technology Partners",
      },
      {
        rawName: "Servotronics, Inc.",
        footer:
          "© 2025 Servotronics Inc | www.servotronics.com | Your Partner for Performance.",
      },
    ] as const;

    for (const testCase of cases) {
      const result = assessSignalSiteIdentity(
        {
          rawName: testCase.rawName,
          uei: null,
          cage: null,
          city: "Austin",
          state: "TX",
        },
        [
          [
            "<main>Engineering, product support, customer service, and manufacturing resources for aircraft operators.</main>",
            "<address>123 Aviation Way, Austin, TX 78701</address>",
            `<footer>${testCase.footer}</footer>`,
          ].join(""),
        ],
      );

      expect(result, `publisher case: ${testCase.rawName}`).toMatchObject({
        status: "verified",
        nameMatched: true,
        corroboratedBy: "location",
      });
    }
  });

  it("uses only attributable same-site Organization and WebSite metadata", () => {
    const signal = {
      rawName: "Fiber Dynamics, Inc.",
      uei: null,
      cage: null,
      city: "Wichita",
      state: "KS",
    } as const;
    const visibleContent =
      "<main>Complex aerospace composite design, testing, production, finishing, delivery, careers, and customer support.</main><address>123 Aviation Way, Wichita, KS 67202</address>";
    const organization = assessSignalSiteIdentity(
      signal,
      [
        `<script type="application/ld+json">${JSON.stringify({
          "@type": "Organization",
          name: "Fiber Dynamics",
          url: "https://fiberdynamics.net/",
        })}</script>${visibleContent}`,
      ],
      ["https://fiberdynamics.net/"],
    );
    const websitePublisher = assessSignalSiteIdentity(
      signal,
      [
        `<script type="application/ld+json">${JSON.stringify({
          "@type": "WebSite",
          url: "https://fiberdynamics.net/",
          publisher: {
            "@type": "Organization",
            name: "Fiber Dynamics Inc.",
          },
        })}</script>${visibleContent}`,
      ],
      ["https://www.fiberdynamics.net/about/"],
    );

    expect(organization).toMatchObject({
      status: "verified",
      nameMatched: true,
      corroboratedBy: "location",
    });
    expect(websitePublisher).toMatchObject({
      status: "verified",
      nameMatched: true,
      corroboratedBy: "location",
    });
  });

  it("uses typed identifiers only from the matching structured publisher", () => {
    const pageUrl = "https://beacon.test/";
    const signal = {
      rawName: "Beacon Aerospace LLC",
      uei: null,
      cage: "1ABC2",
      city: "Denver",
      state: "CO",
    } as const;
    const publisher = {
      "@type": "Organization",
      name: signal.rawName,
      url: pageUrl,
      identifier: {
        "@type": "PropertyValue",
        propertyID: "CAGE",
        value: signal.cage,
      },
    };
    const content =
      `<script type="application/ld+json">${JSON.stringify(publisher)}</script>` +
      "<address>100 Flight Way, Denver, CO 80202</address>";
    const matching = assessSignalSiteIdentity(signal, [content], [pageUrl]);

    expect(matching).toMatchObject({
      status: "verified",
      nameMatched: true,
      corroboratedBy: "identifier",
    });
    const quote = buildSignalIdentityQuote(
      content,
      pageUrl,
      signal,
      matching,
    );
    expect(quote.length).toBeLessThanOrEqual(500);
    expect(quote).toContain(
      '"identifier":{"@type":"PropertyValue","propertyID":"CAGE","value":"1ABC2"}',
    );
    expect(assessSignalSiteIdentity(signal, [quote], [pageUrl])).toMatchObject({
      status: "verified",
      corroboratedBy: "identifier",
    });

    expect(
      assessSignalSiteIdentity(
        { ...signal, cage: "9ZZZ9" },
        [content],
        [pageUrl],
      ),
    ).toMatchObject({
      status: "ambiguous",
      nameMatched: true,
      corroboratedBy: "location",
    });

    const publisherDescription =
      "Beacon Aerospace LLC designs and manufactures actuators. Our office is located at 100 Flight Way, Denver, CO 80202. Copyright 2026 Beacon Aerospace LLC. All Rights Reserved.";
    expect(
      assessSignalSiteIdentity(signal, [
        `${publisherDescription} CAGE: 1ABC2 for federal contracts.`,
      ]),
    ).toMatchObject({
      status: "verified",
      nameMatched: true,
      corroboratedBy: "identifier",
    });
    expect(
      assessSignalSiteIdentity(signal, [
        `${publisherDescription} CAGE: 9ZZZ9 for federal contracts.`,
      ]),
    ).toMatchObject({
      status: "ambiguous",
      nameMatched: true,
      corroboratedBy: "location",
    });
    expect(
      assessSignalSiteIdentity(
        { ...signal, uei: "ABC123DEF456", cage: null },
        [
          `${publisherDescription} UEI: XYZ987XYZ987 for federal contracts.`,
        ],
      ),
    ).toMatchObject({
      status: "ambiguous",
      nameMatched: true,
      corroboratedBy: "location",
    });
    for (const overlong of ["1ABC2X", "1ABC2-X", "1 A B C 2 X"]) {
      expect(
        assessSignalSiteIdentity(signal, [
          `${publisherDescription} CAGE: ${overlong} for federal contracts.`,
        ]),
        overlong,
      ).toMatchObject({
        status: "verified",
        nameMatched: true,
        corroboratedBy: "location",
      });
    }

    const parentIdentifierContent =
      `<script type="application/ld+json">${JSON.stringify({
        "@graph": [
          {
            "@type": "Organization",
            name: signal.rawName,
            url: pageUrl,
          },
          {
            "@type": "Organization",
            "@id": `${pageUrl}#parent`,
            name: "Atlas Group",
            identifier: {
              "@type": "PropertyValue",
              propertyID: "CAGE",
              value: "9ZZZ9",
            },
          },
        ],
      })}</script>` +
      `<p>${publisherDescription}</p>`;
    expect(
      assessSignalSiteIdentity(
        signal,
        [parentIdentifierContent],
        [pageUrl],
      ),
    ).toMatchObject({
      status: "verified",
      nameMatched: true,
      corroboratedBy: "location",
    });

    expect(
      assessSignalSiteIdentity(signal, [
        `${publisherDescription} CAGE audit teams review quality-system controls and supplier records.`,
      ]),
    ).toMatchObject({
      status: "verified",
      nameMatched: true,
      corroboratedBy: "location",
    });
  });

  it("retains the matched structured publisher role instead of an earlier name mention", () => {
    const pageUrl = "https://www.romco.net/";
    const signal = {
      rawName: "Romco Manufacturing",
      uei: null,
      cage: null,
      city: "Deer Park",
      state: "TX",
    } as const;
    const organizationId = `${pageUrl}#organization`;
    const misleadingProfileUrl = `${pageUrl}customers/romco`;
    const nodes = [
      {
        "@type": "WebPage",
        name: "Home - ROMCO Manufacturing",
        url: pageUrl,
      },
      {
        "@type": "ProfilePage",
        name: "ROMCO Manufacturing",
        url: misleadingProfileUrl,
      },
      {
        "@type": "WebSite",
        "@id": `${pageUrl}#website`,
        url: pageUrl,
        publisher: { "@id": organizationId },
      },
      {
        "@type": "Organization",
        "@id": organizationId,
        name: "ROMCO Manufacturing",
        url: pageUrl,
      },
    ];
    const visibleContent = [
      "Romco Manufacturing is located in Deer Park, Texas.",
      "Our full service manufacturing facility supports aerospace and turbine customers with product, quality, and contact information.",
    ].join("\n");
    const content =
      `<script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@graph": nodes,
      })}</script>` + visibleContent;
    const assessment = assessSignalSiteIdentity(signal, [content], [pageUrl]);
    const quote = buildSignalIdentityQuote(
      content,
      pageUrl,
      signal,
      assessment,
    );

    expect(assessment).toMatchObject({
      status: "verified",
      nameMatched: true,
      corroboratedBy: "location",
    });
    expect(quote).toContain(organizationId);
    expect(quote).not.toContain("Home - ROMCO Manufacturing");
    expect(quote).not.toContain(misleadingProfileUrl);
    expect(quote.length).toBeLessThanOrEqual(500);
    expect(assessSignalSiteIdentity(signal, [quote], [pageUrl])).toMatchObject({
      status: "verified",
      nameMatched: true,
      corroboratedBy: "location",
    });

    const wrongProfileOnly = `<script type="application/ld+json">${JSON.stringify(
      {
        "@context": "https://schema.org",
        "@graph": nodes.slice(0, 2),
      },
    )}</script>${visibleContent}`;
    expect(
      assessSignalSiteIdentity(signal, [wrongProfileOnly], [pageUrl]),
    ).toMatchObject({
      status: "ambiguous",
      nameMatched: false,
      corroboratedBy: "location",
    });
  });

  it("preserves typeless structured publisher fields without inventing an organization", () => {
    const pageUrl = "https://beacon-aerospace.example/";
    const signal = {
      rawName: "Beacon Aerospace LLC",
      uei: null,
      cage: null,
      city: "Austin",
      state: "TX",
    } as const;
    const content =
      `<script type="application/ld+json">${JSON.stringify({
        "@type": "WebSite",
        url: pageUrl,
        publisher: { name: signal.rawName },
      })}</script>` +
      [
        "Our facility is located in Austin, TX 78701.",
        "Our company manufactures flight controls and publishes detailed product, engineering, support, and contact information.",
      ].join("\n");
    const assessment = assessSignalSiteIdentity(signal, [content], [pageUrl]);
    const quote = buildSignalIdentityQuote(
      content,
      pageUrl,
      signal,
      assessment,
    );

    expect(assessment.status).toBe("verified");
    const retainedDocument = JSON.parse(
      /<script\b[^>]*>([\s\S]*?)<\/script>/iu.exec(quote)?.[1] ?? "null",
    ) as Record<string, unknown>;
    expect(retainedDocument["publisher"]).toEqual({ name: signal.rawName });
    expect(assessSignalSiteIdentity(signal, [quote], [pageUrl])).toMatchObject({
      status: "verified",
      nameMatched: true,
      corroboratedBy: "location",
    });
  });

  it("retains a standalone publisher header with its nearby operational voice", () => {
    const pageUrl = "https://north-star.example/";
    const signal = {
      rawName: "North Star Aviation Inc",
      uei: null,
      cage: null,
      city: "Austin",
      state: "TX",
    } as const;
    const content = [
      "North Star Aviation Inc",
      "Our company manufactures flight-control assemblies for aircraft operators.",
      "Our facility is located in Austin, TX 78701.",
      "Product engineering, quality, support, and contact resources are available from our team.",
    ].join("\n");
    const assessment = assessSignalSiteIdentity(signal, [content], [pageUrl]);
    const quote = buildSignalIdentityQuote(
      content,
      pageUrl,
      signal,
      assessment,
    );

    expect(assessment.status).toBe("verified");
    expect(quote).toContain("North Star Aviation Inc");
    expect(quote).toContain(
      "Our company manufactures flight-control assemblies",
    );
    expect(quote).toContain("Austin, TX 78701");
    expect(assessSignalSiteIdentity(signal, [quote], [pageUrl])).toMatchObject({
      status: "verified",
      nameMatched: true,
      corroboratedBy: "location",
    });
  });

  it("rejects customer and credited-agency names as publisher proof", () => {
    const signal = {
      rawName: "Thomas Marketing Services",
      uei: null,
      cage: null,
      city: "Austin",
      state: "TX",
    } as const;
    const visibleContent =
      "<main>Engineering, product support, customer service, and manufacturing resources for aircraft operators.</main><address>123 Aviation Way, Austin, TX 78701</address>";
    const creditedAgency = assessSignalSiteIdentity(signal, [
      `${visibleContent}<footer>Copyright © 2026 McNeil Industries Website created by Thomas Marketing Services</footer>`,
    ]);
    const customerMetadata = assessSignalSiteIdentity(
      signal,
      [
        `<script type="application/ld+json">${JSON.stringify({
          "@type": "Organization",
          name: "Thomas Marketing Services",
          url: "https://manufacturer.example/customers/thomas-marketing",
        })}</script>${visibleContent}`,
      ],
      ["https://manufacturer.example/"],
    );

    expect(creditedAgency).toMatchObject({
      status: "ambiguous",
      nameMatched: false,
      corroboratedBy: "location",
    });
    expect(customerMetadata).toMatchObject({
      status: "ambiguous",
      nameMatched: false,
      corroboratedBy: "location",
    });
  });

  it("rejects extra or missing meaningful publisher words", () => {
    const signal = {
      rawName: "Brackett Aero Filters, Inc.",
      uei: null,
      cage: null,
      city: "Kingman",
      state: "AZ",
    } as const;
    const page = (publisher: string) =>
      [
        "7045 Flightline Drive, Kingman, AZ 86401. ",
        "Replacement air filter information, installation resources, and customer support. ",
        `Copyright © 2010 ${publisher}. All Rights Reserved.`,
      ].join("");

    expect(
      assessSignalSiteIdentity(signal, [
        page("West Brackett Aero Filters, Inc."),
      ]),
    ).toMatchObject({ status: "ambiguous", nameMatched: false });
    expect(
      assessSignalSiteIdentity(signal, [
        page("Brackett Aero Filters Holdings, Inc."),
      ]),
    ).toMatchObject({ status: "ambiguous", nameMatched: false });
    expect(
      assessSignalSiteIdentity(signal, [page("Brackett Filters, Inc.")]),
    ).toMatchObject({ status: "ambiguous", nameMatched: false });
  });

  it("rejects registrar and domain-sale boilerplate even when it repeats the query", () => {
    const result = assessSignalSiteIdentity(identity, [
      "Electronics International, Inc. Anaheim, CA 92801. This domain is for sale. Registrar information and WHOIS lookup services are available for prospective buyers of this parked domain.",
    ]);

    expect(result.status).toBe("ambiguous");
  });
});

const DB_TESTS_ENABLED = process.env.ASI_DB_TESTS === "1";

describe.skipIf(!DB_TESTS_ENABLED)("official site retry semantics (DB)", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("jointly verifies name-only intake from exact primary and publisher identifiers", async () => {
    const db = getDatabase();
    const signalId = randomUUID();
    const observedAt = "2026-09-28T12:00:00.000Z";
    const signal = {
      id: signalId,
      sourceKey: "test",
      sourceLocator: `test:${signalId}`,
      sourceFingerprint: `signal-evidence-test:${signalId}`,
      rawName: "Beacon Aerospace LLC",
      rawDomain: null,
      uei: null,
      cage: null,
      city: null,
      state: null,
      country: null,
      awardCount: null,
      sourcePayload: {},
      createdAt: new Date(observedAt),
    };
    const currentEvidence: SourcedSignalResearchEvidence = {
      version: "signal_research_v1",
      signalId,
      sourceContext: {
        sourceKey: signal.sourceKey,
        sourceLocator: signal.sourceLocator,
        sourceFingerprint: signal.sourceFingerprint,
        rawName: signal.rawName,
        rawDomain: signal.rawDomain,
        uei: signal.uei,
        cage: signal.cage,
        city: signal.city,
        state: signal.state,
        country: signal.country,
        awardCount: signal.awardCount,
      },
      identity: {
        status: "not_found",
        verifiedDomain: null,
        legalName: signal.rawName,
        proofEvidenceIds: [],
      },
      website: {
        status: "not_checked",
        offering: "unknown",
        excerpts: "",
        productHints: [],
        namedProductEvidenceIds: [],
      },
      ownership: {
        status: "unknown",
        owner: null,
        year: null,
        conflicting: false,
        currentness: "unknown",
        supportEvidenceIds: [],
      },
      size: {
        status: "unknown",
        assessment: "unknown",
        conflicting: false,
        indicators: [],
      },
      headquarters: {
        status: "unknown",
        city: null,
        state: null,
        country: null,
        supportEvidenceIds: [],
      },
      missingFacts: ["verified_official_identity"],
      checkedSources: [],
      evidenceRefs: [],
    };
    const publisherText = [
      "Beacon Aerospace LLC designs and manufactures aerospace actuators and controls for aircraft operators.",
      "UEI: ABC123DEF456.",
      "Headquartered at 100 Flight Way, Denver, CO 80202.",
      "Copyright © 2026 Beacon Aerospace LLC. All Rights Reserved.",
      "Beacon Aerospace LLC is a subsidiary of Atlas Group.",
    ].join(" ");
    const observations: readonly AnalystResourceObservation[] = [
      {
        tool: "primary_records",
        requestHash: "1".repeat(64),
        observedAt,
        outcome: "success",
        supportRole: "candidate_evidence",
        matchBasis: "uei",
        ambiguous: false,
        records: [
          {
            signalId: randomUUID(),
            sourceKey: "sam_entity",
            sourceLocator: "sam://entity/ABC123DEF456",
            sourceFingerprint: "sam-beacon-abc123",
            legalName: signal.rawName,
            domain: null,
            uei: "ABC123DEF456",
            cage: "1ABC2",
            city: "Denver",
            state: "CO",
            country: "US",
            awardCount: 0,
            payloadJson: JSON.stringify({
              legalName: signal.rawName,
              uei: "ABC123DEF456",
              city: "Denver",
              state: "CO",
            }),
            payloadTruncated: false,
            issuer: "U.S. General Services Administration",
            recordAccess: "reused_imported_record",
            observedAt,
          },
        ],
        sourceReferences: [
          {
            locator: "sam://entity/ABC123DEF456",
            finalUrl: null,
            contentSha256: "a".repeat(64),
            retrievedAt: null,
            representation: "structured_primary_record",
            replayCaveat: "Structured imported record.",
          },
        ],
        failure: null,
        accessLimit: null,
        providerReceiptId: null,
        providerCostUsd: null,
        providerCostKnown: false,
      },
      {
        tool: "public_page",
        requestHash: "2".repeat(64),
        observedAt,
        outcome: "success",
        supportRole: "candidate_evidence",
        body: publisherText,
        contentType: "text/html",
        originalByteLength: publisherText.length,
        retainedCharacters: publisherText.length,
        truncated: false,
        redirects: [],
        linkedUrls: [],
        sourceReferences: [
          {
            locator: "https://beacon.test/",
            finalUrl: "https://beacon.test/",
            contentSha256: "b".repeat(64),
            retrievedAt: observedAt,
            representation: "normalized_publisher_text",
            replayCaveat: "Hash covers the fetched publisher response.",
          },
        ],
        failure: null,
        accessLimit: null,
        providerReceiptId: null,
        providerCostUsd: null,
        providerCostKnown: false,
      },
    ];
    const primaryObservation = observations[0];
    const publisherObservation = observations[1];
    if (
      primaryObservation?.tool !== "primary_records" ||
      publisherObservation?.tool !== "public_page"
    ) {
      throw new Error("invalid controlled observations");
    }
    expect(
      assessSignalSiteIdentity(
        {
          rawName: signal.rawName,
          uei: "KNOWN999ABCD",
          cage: null,
          city: "Denver",
          state: "CO",
        },
        [
          [
            "Beacon Aerospace LLC designs and manufactures aerospace controls.",
            "Headquartered at 100 Flight Way, Denver, CO 80202.",
            "Our customer uses UEI: CUSTOMER1234.",
            "Copyright © 2026 Beacon Aerospace LLC. All Rights Reserved.",
          ].join(" "),
        ],
        ["https://beacon.test/"],
      ),
    ).toMatchObject({
      status: "verified",
      corroboratedBy: "location",
    });
    expect(
      assessSignalSiteIdentity(
        {
          rawName: signal.rawName,
          uei: "KNOWN999ABCD",
          cage: null,
          city: "Denver",
          state: "CO",
        },
        [
          [
            "Atlas Group portfolio companies.",
            "Beacon Aerospace LLC is a subsidiary of Atlas Group.",
            "Parent company UEI: PARENT123456.",
            "Beacon Aerospace LLC operates in Denver, CO.",
          ].join(" "),
        ],
        ["https://atlas.test/portfolio/beacon"],
      ),
    ).toMatchObject({
      status: "ambiguous",
      nameMatched: false,
    });
    const rollback = new Error("Rollback isolated evidence fixture");
    try {
      await db.transaction(async (tx) => {
        await tx.insert(sourceSignals).values(signal);
        const result = await admitSignalResourceEvidence({
          db: tx as unknown as Database,
          signal,
          currentEvidence,
          observations,
        });

        expect(result.researchEvidence.identity).toMatchObject({
          status: "verified",
          verifiedDomain: "beacon.test",
        });
        expect(result.researchEvidence.ownership).toMatchObject({
          status: "acquired",
          owner: "Atlas Group",
          conflicting: false,
          currentness: "explicit_current_relation",
        });
        expect(
          result.researchEvidence.ownership.supportEvidenceIds.length,
        ).toBeGreaterThan(0);
        expect(result.researchEvidence.identity.proofEvidenceIds.length).toBe(2);
        expect(result.researchEvidence.evidenceRefs).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              sourceKind: "registry",
              url: "sam://entity/ABC123DEF456",
              quote: expect.stringContaining("UEI: ABC123DEF456"),
            }),
            expect.objectContaining({
              sourceKind: "official_site",
              url: "https://beacon.test/",
              quote: expect.stringContaining("ABC123DEF456"),
            }),
          ]),
        );
        const conflicts = [
          {
            label: "UEI hidden by matching location",
            identity: {
              uei: "KNOWN999ABCD",
              cage: null,
              city: "Denver",
              state: "CO",
            },
          },
          {
            label: "CAGE hidden by matching UEI",
            identity: {
              uei: "ABC123DEF456",
              cage: "9ZZZ9",
              city: null,
              state: null,
            },
          },
          {
            label: "complete location",
            identity: {
              uei: null,
              cage: null,
              city: "Phoenix",
              state: "AZ",
            },
          },
          {
            label: "known city with missing state",
            identity: {
              uei: null,
              cage: null,
              city: "Phoenix",
              state: null,
            },
          },
          {
            label: "known state with missing city",
            identity: {
              uei: null,
              cage: null,
              city: null,
              state: "AZ",
            },
          },
        ] as const;
        for (const conflict of conflicts) {
          const conflictingId = randomUUID();
          const conflictingSignal = {
            ...signal,
            id: conflictingId,
            sourceLocator: `test:${conflictingId}`,
            sourceFingerprint: `signal-evidence-test:${conflictingId}`,
            ...conflict.identity,
          };
          const conflictingEvidence: SourcedSignalResearchEvidence = {
            ...currentEvidence,
            signalId: conflictingId,
            sourceContext: {
              ...currentEvidence.sourceContext,
              sourceLocator: conflictingSignal.sourceLocator,
              sourceFingerprint: conflictingSignal.sourceFingerprint,
              ...conflict.identity,
            },
          };
          await tx.insert(sourceSignals).values(conflictingSignal);
          const rejected = await admitSignalResourceEvidence({
            db: tx as unknown as Database,
            signal: conflictingSignal,
            currentEvidence: conflictingEvidence,
            observations,
          });

          expect(
            rejected.researchEvidence.identity,
            `${conflict.label} conflict`,
          ).toMatchObject({
            status: "ambiguous",
            verifiedDomain: null,
            proofEvidenceIds: [],
          });
          expect(rejected.researchEvidence.sourceContext).toMatchObject(
            conflict.identity,
          );
          expect(rejected.researchEvidence.ownership).toMatchObject({
            status: "unknown",
            conflicting: false,
            supportEvidenceIds: [],
          });
        }
        const publisherOnlyId = randomUUID();
        const publisherOnlySignal = {
          ...signal,
          id: publisherOnlyId,
          sourceLocator: `test:${publisherOnlyId}`,
          sourceFingerprint: `signal-evidence-test:${publisherOnlyId}`,
          uei: "KNOWN999ABCD",
          city: "Denver",
          state: "CO",
        };
        const publisherOnlyEvidence: SourcedSignalResearchEvidence = {
          ...currentEvidence,
          signalId: publisherOnlyId,
          sourceContext: {
            ...currentEvidence.sourceContext,
            sourceLocator: publisherOnlySignal.sourceLocator,
            sourceFingerprint: publisherOnlySignal.sourceFingerprint,
            uei: publisherOnlySignal.uei,
            city: publisherOnlySignal.city,
            state: publisherOnlySignal.state,
          },
        };
        await tx.insert(sourceSignals).values(publisherOnlySignal);
        const publisherOnlyRejected = await admitSignalResourceEvidence({
          db: tx as unknown as Database,
          signal: publisherOnlySignal,
          currentEvidence: publisherOnlyEvidence,
          observations: [publisherObservation],
        });
        expect(publisherOnlyRejected.researchEvidence.identity).toMatchObject({
          status: "ambiguous",
          verifiedDomain: null,
          proofEvidenceIds: [],
        });
        expect(publisherOnlyRejected.researchEvidence.ownership).toMatchObject({
          status: "unknown",
          supportEvidenceIds: [],
        });
        expect(publisherOnlyRejected.researchEvidence.website).toMatchObject({
          status: "not_checked",
          offering: "unknown",
          namedProductEvidenceIds: [],
        });

        const candidateId = randomUUID();
        const candidateSignal = {
          ...signal,
          id: candidateId,
          sourceLocator: `test:${candidateId}`,
          sourceFingerprint: `signal-evidence-test:${candidateId}`,
          city: "Denver",
          state: "CO",
        };
        const candidateEvidence: SourcedSignalResearchEvidence = {
          ...currentEvidence,
          signalId: candidateId,
          sourceContext: {
            ...currentEvidence.sourceContext,
            sourceLocator: candidateSignal.sourceLocator,
            sourceFingerprint: candidateSignal.sourceFingerprint,
            city: candidateSignal.city,
            state: candidateSignal.state,
          },
        };
        const candidatePublisherText = [
          "Beacon Aerospace LLC designs and manufactures aerospace controls for aircraft operators.",
          "Product, quality, engineering, and customer support resources are published by our team.",
          "Copyright © 2026 Beacon Aerospace LLC. All Rights Reserved.",
        ].join(" ");
        const candidatePublisher: typeof publisherObservation = {
          ...publisherObservation,
          requestHash: "9".repeat(64),
          body: candidatePublisherText,
          originalByteLength: candidatePublisherText.length,
          retainedCharacters: candidatePublisherText.length,
          sourceReferences: publisherObservation.sourceReferences.map(
            (reference) => ({
              ...reference,
              contentSha256: "9".repeat(64),
            }),
          ),
        };
        await tx.insert(sourceSignals).values(candidateSignal);
        const retainedCandidate = await admitSignalResourceEvidence({
          db: tx as unknown as Database,
          signal: candidateSignal,
          currentEvidence: candidateEvidence,
          observations: [candidatePublisher],
        });
        expect(retainedCandidate.researchEvidence.identity).toMatchObject({
          status: "ambiguous",
          verifiedDomain: null,
          proofEvidenceIds: [],
        });
        expect(retainedCandidate.researchEvidence.evidenceRefs).toEqual([
          expect.objectContaining({
            role: "checked_only",
            stage: "domain",
            url: "https://beacon.test/",
          }),
        ]);

        const candidateReplacementText = [
          "Unrelated Robotics Corporation designs warehouse automation systems.",
          "Its headquarters are located in Seattle, Washington.",
          "Product and support resources serve logistics customers.",
        ].join(" ");
        const candidateReplacement: typeof publisherObservation = {
          ...candidatePublisher,
          requestHash: "a".repeat(64),
          body: candidateReplacementText,
          originalByteLength: candidateReplacementText.length,
          retainedCharacters: candidateReplacementText.length,
          sourceReferences: candidatePublisher.sourceReferences.map(
            (reference) => ({
              ...reference,
              contentSha256: "a".repeat(64),
              retrievedAt: "2026-09-29T12:00:00.000Z",
            }),
          ),
        };
        const supersededCandidate = await admitSignalResourceEvidence({
          db: tx as unknown as Database,
          signal: candidateSignal,
          currentEvidence: retainedCandidate.researchEvidence,
          observations: [candidateReplacement],
        });
        expect(supersededCandidate.researchEvidence.identity).toMatchObject({
          status: "ambiguous",
          verifiedDomain: null,
          proofEvidenceIds: [],
        });
        expect(
          supersededCandidate.researchEvidence.evidenceRefs.filter(
            (reference) =>
              reference.stage === "domain" &&
              reference.url === "https://beacon.test/",
          ),
        ).toEqual([]);

        const separateLocationText =
          "Our office is located at 100 Flight Way, Denver, CO 80202. Contact this office for technical support.";
        const separateLocation: typeof publisherObservation = {
          ...candidatePublisher,
          requestHash: "b".repeat(64),
          body: separateLocationText,
          originalByteLength: separateLocationText.length,
          retainedCharacters: separateLocationText.length,
          sourceReferences: candidatePublisher.sourceReferences.map(
            (reference) => ({
              ...reference,
              locator: "https://beacon.test/contact",
              finalUrl: "https://beacon.test/contact",
              contentSha256: "b".repeat(64),
              retrievedAt: "2026-09-29T12:05:00.000Z",
            }),
          ),
        };
        const noResurrection = await admitSignalResourceEvidence({
          db: tx as unknown as Database,
          signal: candidateSignal,
          currentEvidence: supersededCandidate.researchEvidence,
          observations: [separateLocation],
        });
        expect(noResurrection.researchEvidence.identity).toMatchObject({
          status: "ambiguous",
          verifiedDomain: null,
          proofEvidenceIds: [],
        });

        const primaryOnlyId = randomUUID();
        const primaryOnlySignal = {
          ...signal,
          id: primaryOnlyId,
          sourceLocator: `test:${primaryOnlyId}`,
          sourceFingerprint: `signal-evidence-test:${primaryOnlyId}`,
          uei: "ABC123DEF456",
          cage: null,
          city: null,
          state: null,
        };
        const primaryOnlyEvidence: SourcedSignalResearchEvidence = {
          ...currentEvidence,
          signalId: primaryOnlyId,
          sourceContext: {
            ...currentEvidence.sourceContext,
            sourceLocator: primaryOnlySignal.sourceLocator,
            sourceFingerprint: primaryOnlySignal.sourceFingerprint,
            uei: primaryOnlySignal.uei,
            cage: primaryOnlySignal.cage,
            city: primaryOnlySignal.city,
            state: primaryOnlySignal.state,
          },
          identity: {
            ...currentEvidence.identity,
            status: "verified",
            verifiedDomain: "stale-publisher.test",
          },
          website: {
            ...currentEvidence.website,
            status: "supported",
            excerpts: "Unvalidated stale publisher facts.",
            productHints: ["Unvalidated stale product"],
          },
        };
        await tx.insert(sourceSignals).values(primaryOnlySignal);
        const primaryOnly = await admitSignalResourceEvidence({
          db: tx as unknown as Database,
          signal: primaryOnlySignal,
          currentEvidence: primaryOnlyEvidence,
          observations: [primaryObservation],
        });
        expect(primaryOnly.researchEvidence.identity).toMatchObject({
          status: "verified",
          verifiedDomain: null,
        });
        expect(primaryOnly.researchEvidence.identity.proofEvidenceIds).toHaveLength(
          1,
        );
        expect(primaryOnly.researchEvidence.evidenceRefs).toEqual([
          expect.objectContaining({
            role: "support",
            stage: "domain",
            sourceKind: "registry",
            url: "sam://entity/ABC123DEF456",
          }),
        ]);
        expect(primaryOnly.researchEvidence.website).toMatchObject({
          status: "not_checked",
          offering: "unknown",
          excerpts: "",
          productHints: [],
          namedProductEvidenceIds: [],
        });

        const unrelatedPrimaryFollowupText = [
          "Unrelated Robotics Corporation designs warehouse automation systems.",
          "Its headquarters are located in Seattle, Washington.",
          "Product and support resources serve logistics customers.",
        ].join(" ");
        const unrelatedPrimaryFollowup: typeof publisherObservation = {
          ...publisherObservation,
          requestHash: "6".repeat(64),
          body: unrelatedPrimaryFollowupText,
          originalByteLength: unrelatedPrimaryFollowupText.length,
          retainedCharacters: unrelatedPrimaryFollowupText.length,
          sourceReferences: publisherObservation.sourceReferences.map(
            (reference) => ({
              ...reference,
              locator: "https://unrelated.test/",
              finalUrl: "https://unrelated.test/",
              contentSha256: "6".repeat(64),
            }),
          ),
        };
        const retainedPrimaryOnly = await admitSignalResourceEvidence({
          db: tx as unknown as Database,
          signal: primaryOnlySignal,
          currentEvidence: primaryOnly.researchEvidence,
          observations: [unrelatedPrimaryFollowup],
        });
        expect(retainedPrimaryOnly.researchEvidence.identity).toEqual(
          primaryOnly.researchEvidence.identity,
        );
        expect(retainedPrimaryOnly.researchEvidence.website).toMatchObject({
          status: "not_checked",
          offering: "unknown",
          excerpts: "",
          productHints: [],
          namedProductEvidenceIds: [],
        });

        const checkedOnlyPrimary = await admitSignalResourceEvidence({
          db: tx as unknown as Database,
          signal: primaryOnlySignal,
          currentEvidence: {
            ...primaryOnly.researchEvidence,
            evidenceRefs: primaryOnly.researchEvidence.evidenceRefs.map(
              (reference) => ({ ...reference, role: "checked_only" as const }),
            ),
          },
          observations: [unrelatedPrimaryFollowup],
        });
        expect(checkedOnlyPrimary.researchEvidence.identity).toMatchObject({
          status: "ambiguous",
          verifiedDomain: null,
          proofEvidenceIds: [],
        });

        const retainedLocationPublisherText = [
          "Beacon Aerospace LLC designs and manufactures aerospace controls.",
          "Headquartered at 100 Flight Way, Denver, CO 80202.",
          "Copyright © 2026 Beacon Aerospace LLC. All Rights Reserved.",
        ].join(" ");
        const retainedLocationPublisher: typeof publisherObservation = {
          ...publisherObservation,
          requestHash: "7".repeat(64),
          body: retainedLocationPublisherText,
          originalByteLength: retainedLocationPublisherText.length,
          retainedCharacters: retainedLocationPublisherText.length,
          sourceReferences: publisherObservation.sourceReferences.map(
            (reference) => ({
              ...reference,
              contentSha256: "7".repeat(64),
            }),
          ),
        };
        const retainedPrimaryWebsite = await admitSignalResourceEvidence({
          db: tx as unknown as Database,
          signal: primaryOnlySignal,
          currentEvidence: primaryOnly.researchEvidence,
          observations: [retainedLocationPublisher],
        });
        expect(retainedPrimaryWebsite.researchEvidence.identity).toMatchObject({
          status: "verified",
          verifiedDomain: "beacon.test",
        });
        expect(
          retainedPrimaryWebsite.researchEvidence.identity.proofEvidenceIds,
        ).toHaveLength(2);
        const retainedPrimaryProofs =
          retainedPrimaryWebsite.researchEvidence.evidenceRefs.filter(
            (reference) =>
              retainedPrimaryWebsite.researchEvidence.identity.proofEvidenceIds.includes(
                reference.evidenceId,
              ),
          );
        expect(retainedPrimaryProofs).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              sourceKind: "registry",
              quote: expect.stringContaining("location: Denver, CO"),
            }),
            expect.objectContaining({
              sourceKind: "official_site",
              url: "https://beacon.test/",
            }),
          ]),
        );

        const freshConflictingPrimary: typeof primaryObservation = {
          ...primaryObservation,
          requestHash: "8".repeat(64),
          records: primaryObservation.records.map((record) => ({
            ...record,
            sourceFingerprint: "sam-beacon-abc123-phoenix",
            sourceLocator: "sam://entity/ABC123DEF456?revision=phoenix",
            city: "Phoenix",
            state: "AZ",
            payloadJson: JSON.stringify({
              legalName: signal.rawName,
              uei: "ABC123DEF456",
              city: "Phoenix",
              state: "AZ",
            }),
          })),
        };
        const refreshedPrimary = await admitSignalResourceEvidence({
          db: tx as unknown as Database,
          signal: primaryOnlySignal,
          currentEvidence: primaryOnly.researchEvidence,
          observations: [freshConflictingPrimary],
        });
        expect(refreshedPrimary.researchEvidence.identity).toMatchObject({
          status: "verified",
          verifiedDomain: null,
        });
        expect(
          refreshedPrimary.researchEvidence.identity.proofEvidenceIds,
        ).toHaveLength(1);
        const refreshedPrimaryProof =
          refreshedPrimary.researchEvidence.evidenceRefs.find((reference) =>
            refreshedPrimary.researchEvidence.identity.proofEvidenceIds.includes(
              reference.evidenceId,
            ),
          );
        expect(refreshedPrimaryProof?.quote).toContain(
          "location: Phoenix, AZ",
        );
        expect(refreshedPrimaryProof?.quote).not.toContain(
          "location: Denver, CO",
        );

        const transitionId = randomUUID();
        const transitionSignal = {
          ...signal,
          id: transitionId,
          sourceLocator: `test:${transitionId}`,
          sourceFingerprint: `signal-evidence-test:${transitionId}`,
          uei: "KNOWN999ABCD",
          city: "Denver",
          state: "CO",
        };
        const transitionEvidence: SourcedSignalResearchEvidence = {
          ...currentEvidence,
          signalId: transitionId,
          sourceContext: {
            ...currentEvidence.sourceContext,
            sourceLocator: transitionSignal.sourceLocator,
            sourceFingerprint: transitionSignal.sourceFingerprint,
            uei: transitionSignal.uei,
            city: transitionSignal.city,
            state: transitionSignal.state,
          },
        };
        const transitionText = [
          "Beacon Aerospace LLC designs and manufactures aerospace actuators and controls for aircraft operators.",
          "Headquartered at 100 Flight Way, Denver, CO 80202.",
          "Copyright © 2026 Beacon Aerospace LLC. All Rights Reserved.",
          "Beacon Aerospace LLC is a subsidiary of Atlas Group.",
        ].join(" ");
        const transitionPage: typeof publisherObservation = {
          ...publisherObservation,
          requestHash: "3".repeat(64),
          body: transitionText,
          originalByteLength: transitionText.length,
          retainedCharacters: transitionText.length,
          sourceReferences: publisherObservation.sourceReferences.map(
            (reference) => ({
              ...reference,
              contentSha256: "c".repeat(64),
            }),
          ),
        };
        await tx.insert(sourceSignals).values(transitionSignal);
        const initiallyVerified = await admitSignalResourceEvidence({
          db: tx as unknown as Database,
          signal: transitionSignal,
          currentEvidence: transitionEvidence,
          observations: [transitionPage],
        });
        expect(initiallyVerified.researchEvidence.identity).toMatchObject({
          status: "verified",
          verifiedDomain: "beacon.test",
        });
        expect(initiallyVerified.researchEvidence.ownership).toMatchObject({
          status: "acquired",
          owner: "Atlas Group",
        });

        const replacementText = [
          "Unrelated Robotics Corporation designs warehouse automation systems.",
          "Its headquarters are located in Seattle, Washington.",
          "Product and support resources serve logistics customers.",
        ].join(" ");
        const replacementPage: typeof publisherObservation = {
          ...transitionPage,
          requestHash: "e".repeat(64),
          body: replacementText,
          originalByteLength: replacementText.length,
          retainedCharacters: replacementText.length,
          sourceReferences: transitionPage.sourceReferences.map(
            (reference) => ({
              ...reference,
              contentSha256: "e".repeat(64),
              retrievedAt: "2026-09-29T12:00:00.000Z",
            }),
          ),
        };
        const superseded = await admitSignalResourceEvidence({
          db: tx as unknown as Database,
          signal: transitionSignal,
          currentEvidence: initiallyVerified.researchEvidence,
          observations: [replacementPage],
        });
        expect(superseded.researchEvidence.identity).toMatchObject({
          status: "ambiguous",
          verifiedDomain: null,
          proofEvidenceIds: [],
        });
        expect(superseded.researchEvidence.website).toMatchObject({
          status: "not_checked",
          offering: "unknown",
          excerpts: "",
          productHints: [],
          namedProductEvidenceIds: [],
        });
        expect(superseded.researchEvidence.checkedSources).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              url: "https://beacon.test/",
              contentSha256: "e".repeat(64),
              retrievedAt: "2026-09-29T12:00:00.000Z",
            }),
          ]),
        );

        const invalidated = await admitSignalResourceEvidence({
          db: tx as unknown as Database,
          signal: transitionSignal,
          currentEvidence: initiallyVerified.researchEvidence,
          observations: [primaryObservation],
        });
        expect(invalidated.researchEvidence.identity).toMatchObject({
          status: "ambiguous",
          verifiedDomain: null,
          proofEvidenceIds: [],
        });
        expect(invalidated.researchEvidence.website).toMatchObject({
          status: "not_checked",
          offering: "unknown",
          excerpts: "",
          productHints: [],
          namedProductEvidenceIds: [],
        });
        expect(invalidated.researchEvidence.ownership).toMatchObject({
          status: "unknown",
          owner: null,
          conflicting: false,
          currentness: "unknown",
          supportEvidenceIds: [],
        });
        expect(
          invalidated.researchEvidence.evidenceRefs.some(
            (reference) =>
              reference.stage === "ownership" &&
              reference.url === "https://beacon.test/",
          ),
        ).toBe(true);
        const externalParentText =
          "Beacon Aerospace LLC is a subsidiary of Atlas Group.";
        const externalParentPage: typeof publisherObservation = {
          ...publisherObservation,
          requestHash: "4".repeat(64),
          body: externalParentText,
          originalByteLength: externalParentText.length,
          retainedCharacters: externalParentText.length,
          sourceReferences: [
            {
              ...publisherObservation.sourceReferences[0]!,
              locator: "https://atlas.test/portfolio/beacon",
              finalUrl: "https://atlas.test/portfolio/beacon",
              contentSha256: "d".repeat(64),
            },
          ],
        };
        const mixedSupport = await admitSignalResourceEvidence({
          db: tx as unknown as Database,
          signal: transitionSignal,
          currentEvidence: initiallyVerified.researchEvidence,
          observations: [externalParentPage],
        });
        expect(
          mixedSupport.researchEvidence.ownership.supportEvidenceIds,
        ).toHaveLength(2);
        const externallySupported = await admitSignalResourceEvidence({
          db: tx as unknown as Database,
          signal: transitionSignal,
          currentEvidence: mixedSupport.researchEvidence,
          observations: [primaryObservation],
        });
        expect(externallySupported.researchEvidence.ownership).toMatchObject({
          status: "acquired",
          owner: "Atlas Group",
          conflicting: false,
          currentness: "explicit_current_relation",
        });
        expect(
          externallySupported.researchEvidence.ownership.supportEvidenceIds,
        ).toHaveLength(1);
        const parentFactRetained = await admitSignalResourceEvidence({
          db: tx as unknown as Database,
          signal: transitionSignal,
          currentEvidence: externallySupported.researchEvidence,
          observations: [primaryObservation],
        });
        expect(parentFactRetained.researchEvidence.ownership).toMatchObject({
          status: "acquired",
          owner: "Atlas Group",
          conflicting: false,
          currentness: "explicit_current_relation",
        });
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  });

  it("keeps a failed official candidate retryable despite another candidate mismatch", async () => {
    vi.stubEnv("EXA_DAILY_BUDGET_USD", "99999");
    const db = getDatabase();
    const signalId = randomUUID();
    const compactSignalId = signalId.replaceAll("-", "");
    const officialDomain = `official-${compactSignalId}.example`;
    const homonymOrigin = `https://homonym-${compactSignalId}.example`;
    const signal = {
      id: signalId,
      sourceKey: "test",
      sourceLocator: `test:${signalId}`,
      sourceFingerprint: `signal-evidence-test:${signalId}`,
      rawName: identity.rawName,
      rawDomain: officialDomain,
      uei: null,
      cage: identity.cage,
      city: identity.city,
      state: identity.state,
      country: "US",
      awardCount: 1,
      sourcePayload: {},
      createdAt: new Date("2026-09-27T00:00:00.000Z"),
    };
    const rollback = new Error("Rollback isolated evidence fixture");
    try {
      await db.transaction(async (tx) => {
        await tx.insert(sourceSignals).values(signal);
        const result = await researchSignalEvidence({
          db: tx as unknown as Database,
          apiKey: "test-key",
          signal,
          searchClient: metadataSearchClient([
            {
              title: "Infinite Electronics International",
              url: `${homonymOrigin}/`,
              text: "Search candidate",
              score: 1,
            },
          ]),
          fetchUrl: vi.fn(async (url: string) => {
            if (new URL(url).hostname === officialDomain) {
              throw new SafeFetchError("timeout");
            }
            return {
              requestedUrl: url,
              finalUrl: url,
              contentType: "text/html" as const,
              content:
                "<html><body>Infinite Electronics International is based in Anaheim, CA. Our company supplies electronic components and publishes extensive product, support, careers, and contact information.</body></html>",
              byteLength: 190,
              contentSha256: compactSignalId.repeat(2),
              retrievedAt: "2026-09-27T12:00:00.000Z",
              durationMs: 10,
              redirects: [],
            };
          }),
        });

        expect(result).toMatchObject({
          outcome: "retryable_error",
          reason: "official_site_unreachable",
          errorCode: "timeout",
        });
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not verify or link identity when bounded durable proof cannot retain corroboration", async () => {
    vi.stubEnv("EXA_DAILY_BUDGET_USD", "99999");
    const db = getDatabase();
    const signalId = randomUUID();
    const compactSignalId = signalId.replaceAll("-", "");
    const officialDomain = `bounded-${compactSignalId}.example`;
    const pageUrl = `https://${officialDomain}/`;
    const signal = {
      id: signalId,
      sourceKey: "test",
      sourceLocator: `test:${signalId}`,
      sourceFingerprint: `signal-evidence-test:${signalId}`,
      rawName: "Romco Manufacturing",
      rawDomain: officialDomain,
      uei: null,
      cage: null,
      city: "Deer Park",
      state: "TX",
      country: "US",
      awardCount: 1,
      sourcePayload: {},
      createdAt: new Date("2026-09-27T00:00:00.000Z"),
    };
    const content = [
      sameSitePublisherJsonLd(signal.rawName, pageUrl),
      `Romco Manufacturing is located in Deer Park, Texas and supports ${"precision manufacturing operations ".repeat(20)}.`,
    ].join("\n");
    const rollback = new Error("Rollback isolated evidence fixture");
    try {
      await db.transaction(async (tx) => {
        await tx.insert(sourceSignals).values(signal);
        const result = await researchSignalEvidence({
          db: tx as unknown as Database,
          apiKey: "test-key",
          signal,
          searchClient: metadataSearchClient(),
          fetchUrl: vi.fn(async (url: string) => ({
            requestedUrl: url,
            finalUrl: url,
            contentType: "text/html" as const,
            content,
            byteLength: content.length,
            contentSha256: compactSignalId.repeat(2),
            retrievedAt: "2026-09-27T12:00:00.000Z",
            durationMs: 10,
            redirects: [],
          })),
        });

        expect(result.outcome).toBe("completed");
        if (result.outcome !== "completed") {
          throw new Error(`Expected completed research, got ${result.outcome}`);
        }
        expect(result.researchEvidence.identity).toMatchObject({
          status: "ambiguous",
          verifiedDomain: null,
          proofEvidenceIds: [],
        });
        expect(
          result.researchEvidence.evidenceRefs.filter(
            (reference) => reference.stage === "domain",
          ),
        ).toEqual([]);
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("uses a candidate page's actual identity link before guessed paths", async () => {
    vi.stubEnv("EXA_DAILY_BUDGET_USD", "99999");
    const db = getDatabase();
    const signalId = randomUUID();
    const compactSignalId = signalId.replaceAll("-", "");
    const officialDomain = `brackett-${compactSignalId}.example`;
    const signal = {
      id: signalId,
      sourceKey: "test",
      sourceLocator: `test:${signalId}`,
      sourceFingerprint: `signal-evidence-test:${signalId}`,
      rawName: "Brackett Aero Filters, Inc.",
      rawDomain: `https://${officialDomain}/landing.html`,
      uei: null,
      cage: null,
      city: "Kingman",
      state: "AZ",
      country: "US",
      awardCount: 1,
      sourcePayload: {},
      createdAt: new Date("2026-09-27T00:00:00.000Z"),
    };
    const fetchUrl = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      let content: string;
      if (parsed.pathname === "/landing.html") {
        content = [
          "<html><body><nav>",
          '<a href="/company/history.html">Company History</a>',
          '<a href="/contact-us.html">Contact Us</a>',
          "</nav><address>7045 Flightline Drive, Kingman, AZ 86401</address>",
          "<p>Replacement filter resources and customer service information.</p></body></html>",
        ].join("");
      } else if (parsed.pathname === "/company/history.html") {
        content = [
          "<html><body>",
          "<p>Replacement air filter information, installation resources, and customer support.</p>",
          "<footer>Copyright <strong>&copy;</strong> 2010 Brackett Aero Filters, Inc.. All Rights Reserved.</footer>",
          "</body></html>",
        ].join("");
      } else {
        throw new SafeFetchError("http_error", 404);
      }
      return {
        requestedUrl: url,
        finalUrl: url,
        contentType: "text/html" as const,
        content,
        byteLength: content.length,
        contentSha256: compactSignalId.repeat(2),
        retrievedAt: "2026-09-27T12:00:00.000Z",
        durationMs: 10,
        redirects: [],
      };
    });
    const rollback = new Error("Rollback isolated evidence fixture");
    try {
      await db.transaction(async (tx) => {
        await tx.insert(sourceSignals).values(signal);
        const result = await researchSignalEvidence({
          db: tx as unknown as Database,
          apiKey: "test-key",
          signal,
          searchClient: metadataSearchClient(),
          fetchUrl,
        });

        expect(result.outcome).toBe("completed");
        if (result.outcome !== "completed") {
          throw new Error(`Expected completed research, got ${result.outcome}`);
        }
        expect(result.researchEvidence.identity).toMatchObject({
          status: "verified",
          verifiedDomain: officialDomain,
        });
        expect(result.researchEvidence.website).toMatchObject({
          offering: "unknown",
          namedProductEvidenceIds: [],
        });
        expect(result.researchEvidence.ownership.status).toBe("unknown");
        expect(result.researchEvidence.size.assessment).toBe("unknown");
        expect(result.researchEvidence.headquarters.status).toBe("unknown");
        const identityEvidence = result.researchEvidence.evidenceRefs.filter(
          (reference) => reference.stage === "domain",
        );
        const publisherProof = identityEvidence.find(
          (reference) =>
            reference.url === `https://${officialDomain}/company/history.html`,
        );
        const locationProof = identityEvidence.find(
          (reference) => reference.url === signal.rawDomain,
        );
        expect(publisherProof?.quote).toContain(
          "Copyright © 2010 Brackett Aero Filters, Inc.",
        );
        expect(locationProof?.quote).toContain("Kingman, AZ 86401");
        expect(result.researchEvidence.identity.proofEvidenceIds).toEqual(
          expect.arrayContaining([
            publisherProof?.evidenceId,
            locationProof?.evidenceId,
          ]),
        );
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("persists named-product proof from full page text with exact provenance", async () => {
    vi.stubEnv("EXA_DAILY_BUDGET_USD", "99999");
    const db = getDatabase();
    const signalId = randomUUID();
    const compactSignalId = signalId.replaceAll("-", "");
    const officialDomain = `haltec-${compactSignalId}.example`;
    const signal = {
      id: signalId,
      sourceKey: "test",
      sourceLocator: `test:${signalId}`,
      sourceFingerprint: `signal-evidence-test:${signalId}`,
      rawName: "Haltec Corporation",
      rawDomain: officialDomain,
      uei: null,
      cage: null,
      city: "Salem",
      state: "OH",
      country: "US",
      awardCount: 1,
      sourcePayload: {},
      createdAt: new Date("2026-09-27T00:00:00.000Z"),
    };
    const productQuote =
      "Our most recent product updates include a redesign to our Mega Bore Valve system, and our IN-95 Inflator Adaptor.";
    const content = [
      "<html><head><title>HALTEC Corporation</title></head><body>",
      "<p>Haltec Corporation designs and manufactures tire valves and accessories.</p>",
      "<p>Our office is located in Salem, OH 44460.</p>",
      `<p>${productQuote}</p>`,
      "</body></html>",
    ].join("");
    const contentSha256 = compactSignalId.repeat(2);
    const retrievedAt = "2026-09-27T12:00:00.000Z";
    const rollback = new Error("Rollback isolated evidence fixture");
    try {
      await db.transaction(async (tx) => {
        await tx.insert(sourceSignals).values(signal);
        const result = await researchSignalEvidence({
          db: tx as unknown as Database,
          apiKey: "test-key",
          signal,
          searchClient: metadataSearchClient(),
          fetchUrl: vi.fn(async (url: string) => {
            if (new URL(url).pathname !== "/") {
              throw new SafeFetchError("http_error", 404);
            }
            return {
              requestedUrl: url,
              finalUrl: url,
              contentType: "text/html" as const,
              content,
              byteLength: content.length,
              contentSha256,
              retrievedAt,
              durationMs: 10,
              redirects: [],
            };
          }),
        });

        expect(result.outcome).toBe("completed");
        if (result.outcome !== "completed") {
          throw new Error(`Expected completed research, got ${result.outcome}`);
        }
        const productEvidence = result.researchEvidence.evidenceRefs.find(
          (reference) =>
            reference.quote === productQuote &&
            result.researchEvidence.website.namedProductEvidenceIds.includes(
              reference.evidenceId,
            ),
        );
        expect(productEvidence).toMatchObject({
          url: `https://${officialDomain}/`,
          quote: productQuote,
          stage: "website",
          firstParty: true,
          contentSha256,
          retrievedAt,
        });
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("treats missing guessed identity pages as permanent and bounded", async () => {
    vi.stubEnv("EXA_DAILY_BUDGET_USD", "99999");
    const db = getDatabase();
    const signalId = randomUUID();
    const compactSignalId = signalId.replaceAll("-", "");
    const officialDomain = `missing-${compactSignalId}.example`;
    const signal = {
      id: signalId,
      sourceKey: "test",
      sourceLocator: `test:${signalId}`,
      sourceFingerprint: `signal-evidence-test:${signalId}`,
      rawName: identity.rawName,
      rawDomain: officialDomain,
      uei: null,
      cage: identity.cage,
      city: identity.city,
      state: identity.state,
      country: "US",
      awardCount: 1,
      sourcePayload: {},
      createdAt: new Date("2026-09-27T00:00:00.000Z"),
    };
    const fetchUrl = vi.fn(async () => {
      throw new SafeFetchError("http_error", 404);
    });
    const rollback = new Error("Rollback isolated evidence fixture");
    try {
      await db.transaction(async (tx) => {
        await tx.insert(sourceSignals).values(signal);
        const result = await researchSignalEvidence({
          db: tx as unknown as Database,
          apiKey: "test-key",
          signal,
          searchClient: metadataSearchClient(),
          fetchUrl,
        });

        expect(result.outcome).toBe("completed");
        if (result.outcome !== "completed") {
          throw new Error(`Expected completed research, got ${result.outcome}`);
        }
        expect(result.researchEvidence.identity.status).toBe("not_found");
        expect(fetchUrl).toHaveBeenCalledTimes(3);
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("sourced product and size semantics", () => {
  it("requires a manufacturing relationship to a supplier-owned named product", () => {
    expect(
      isFirstPartyNamedProductEvidence(
        "Our ISO-9001 certified precision machining services support the MD-80 aircraft.",
      ),
    ).toBe(false);
    expect(
      isFirstPartyNamedProductEvidence("Our Parker P-25 valve is in stock."),
    ).toBe(false);
    expect(
      isFirstPartyNamedProductEvidence(
        "Our RG-72059 valve cover gasket is manufactured for Lycoming engines.",
      ),
    ).toBe(true);
    expect(
      isFirstPartyNamedProductEvidence(
        "We manufacture the Atlas A-20 actuator using our own design.",
      ),
    ).toBe(true);
    expect(
      isFirstPartyNamedProductEvidence(
        "We manufacture our AX-10 actuator for aircraft operators.",
      ),
    ).toBe(true);
  });

  it("retains attributable redesign and same-page manufactured-model proof", () => {
    expect(
      isFirstPartyNamedProductEvidence(
        "Our most recent product updates include a redesign to our Mega Bore Valve system, and our IN-95 Inflator Adaptor.",
        "Haltec Corporation",
      ),
    ).toBe(true);
    expect(
      isFirstPartyNamedProductEvidence(
        [
          "CEC Vibration Products",
          "CEC designs, manufactures, and repairs vibration transducers, load cells, power supplies, ballasts, and LED lighting.",
          "4-138 Velocity Transducer",
        ].join("\n"),
        "CEC Vibration Products LLC",
      ),
    ).toBe(true);
    expect(
      isFirstPartyNamedProductEvidence(
        [
          "Unrelated Publisher LLC",
          "CEC designs and manufactures vibration transducers.",
          "4-138 Velocity Transducer",
        ].join("\n"),
        "CEC Vibration Products LLC",
      ),
    ).toBe(false);
    expect(
      isFirstPartyNamedProductEvidence(
        [
          "Beacon Aerospace LLC",
          "Beacon designs and manufactures vibration transducers.",
          "4-138 Velocity Transducer",
        ].join("\n"),
        "BEACON AEROSPACE LLC",
      ),
    ).toBe(false);
    const mixedInventoryExcerpt = [
      "Beacon Aerospace LLC",
      "We design and manufacture actuators.",
      "Authorized distributor of Atlas products",
      "AX-10 actuator",
      "AX-20 actuator",
      "AX-30 actuator",
      "AX-40 actuator",
      "We manufacture our BX-20 actuator for aircraft operators.",
    ].join("\n");
    const mixedInventoryQuotes = extractFirstPartyNamedProductQuotes(
      mixedInventoryExcerpt,
      "Beacon Aerospace LLC",
    );
    for (const distributorSku of ["AX-10", "AX-20", "AX-30", "AX-40"]) {
      expect(
        mixedInventoryQuotes.some((quote) => quote.includes(distributorSku)),
      ).toBe(false);
    }
    expect(mixedInventoryQuotes).toContain(
      "We manufacture our BX-20 actuator for aircraft operators.",
    );
    expect(
      isFirstPartyNamedProductEvidence(
        mixedInventoryExcerpt,
        "Beacon Aerospace LLC",
      ),
    ).toBe(true);
    for (const sellerContext of [
      "We also distribute Atlas actuators.",
      "We stock parts from other manufacturers.",
      "Stocking distributor",
    ]) {
      const sellerInventoryQuotes = extractFirstPartyNamedProductQuotes(
        [
          "Beacon Aerospace LLC",
          "We design and manufacture actuators.",
          sellerContext,
          "AX-50 actuator",
          "We manufacture our BX-20 actuator for aircraft operators.",
        ].join("\n"),
        "Beacon Aerospace LLC",
      );
      expect(
        sellerInventoryQuotes.some((quote) => quote.includes("AX-50")),
        sellerContext,
      ).toBe(false);
      expect(sellerInventoryQuotes, sellerContext).toContain(
        "We manufacture our BX-20 actuator for aircraft operators.",
      );
    }
    expect(
      extractFirstPartyNamedProductQuotes(
        [
          "Beacon Aerospace LLC",
          "We design and manufacture actuators.",
          "Distributor Network",
          "AX-50 actuator",
        ].join("\n"),
        "Beacon Aerospace LLC",
      ).some((quote) => quote.includes("AX-50")),
    ).toBe(true);
  });

  it("fails closed when a complete named-product proof exceeds the persisted quote bound", () => {
    const modelBeyondPersistedQuote = `${"Background information ".repeat(
      30,
    )}We manufacture our AX-10 actuator for aircraft operators.`;

    expect(
      extractFirstPartyNamedProductQuotes(modelBeyondPersistedQuote),
    ).toEqual([]);
    expect(isFirstPartyNamedProductEvidence(modelBeyondPersistedQuote)).toBe(
      false,
    );
  });
  it("accepts attributable branded manufactured and proprietary product lines without SKUs", () => {
    expect(
      isFirstPartyNamedProductEvidence(
        [
          "Along with equipment and additional skilled employees, McNeil acquired its first manufactured product line: the MAXAM® Bearing.",
          "McNeil Industries currently manufactures precision bearing products in Painesville.",
        ].join(" "),
        "McNeil Industries",
      ),
    ).toBe(true);
    expect(
      isFirstPartyNamedProductEvidence(
        "The corporation also has a proprietary product line under the registered trademark of TRU-TURN Precision Model Products offered to Hobby and UAV markets.",
        "Romco Manufacturing",
      ),
    ).toBe(true);
    const productFacts = extractWebsiteFacts(
      fetchedWebsite(
        "McNeil Industries manufactures the MAXAM® Bearing as its own named product line.",
      ),
      "McNeil Industries",
    );
    expect(productFacts).toMatchObject({
      ownershipStatus: "unknown",
      sizeAssessment: "unknown",
      headquartersStatus: "unknown",
      headquarters: null,
    });
  });

  it("does not turn borrowed brands, inventory, applicability, or certificates into owned products", () => {
    expect(
      isFirstPartyNamedProductEvidence(
        "We manufacture hydraulic pumps for aerospace customers.",
      ),
    ).toBe(false);
    expect(
      isFirstPartyNamedProductEvidence(
        "Parker introduces the PX-10 valve, which we distribute to aircraft operators.",
      ),
    ).toBe(false);
    expect(
      isFirstPartyNamedProductEvidence(
        "We introduce the PX-10 valve from Parker into our distribution catalog.",
      ),
    ).toBe(false);
    expect(
      isFirstPartyNamedProductEvidence(
        "We manufacture the Parker PX-10 valve for Parker's distribution catalog.",
      ),
    ).toBe(false);
    expect(
      isFirstPartyNamedProductEvidence(
        [
          "McNeil Industries provides precision manufacturing services.",
          "Our customer Atlas acquired its first manufactured product line: the MAXAM® Bearing.",
        ].join(" "),
        "McNeil Industries",
      ),
    ).toBe(false);
    expect(
      isFirstPartyNamedProductEvidence(
        'Our customer Atlas says: "We manufacture our AX-10 actuator for aircraft operators."',
        "Beacon Aerospace LLC",
      ),
    ).toBe(false);
    expect(
      isFirstPartyNamedProductEvidence(
        "<blockquote>We manufacture our AX-10 actuator for aircraft operators.</blockquote>",
        "Beacon Aerospace LLC",
      ),
    ).toBe(false);
    expect(
      isFirstPartyNamedProductEvidence(
        'Our customer Atlas says: "We build aircraft systems. We manufacture our AX-10 actuator for aircraft operators."',
        "Beacon Aerospace LLC",
      ),
    ).toBe(false);
    expect(
      isFirstPartyNamedProductEvidence(
        "> We build aircraft systems. We manufacture our AX-10 actuator for aircraft operators.",
        "Beacon Aerospace LLC",
      ),
    ).toBe(false);
    expect(
      isFirstPartyNamedProductEvidence(
        'Our customer Atlas says: "We manufacture our AX-10 actuator." We manufacture our BX-20 actuator for aircraft operators.',
        "Beacon Aerospace LLC",
      ),
    ).toBe(true);
    expect(
      isFirstPartyNamedProductEvidence(
        "We stock the Parker Hannifin valve product line for same-day shipment.",
        "Beacon Aerospace LLC",
      ),
    ).toBe(false);
    expect(
      isFirstPartyNamedProductEvidence(
        "Our FAA approvals cover 47 aircraft models, including the Cessna 172 and Piper PA-28.",
        "Beacon Aerospace LLC",
      ),
    ).toBe(false);
    expect(
      isFirstPartyNamedProductEvidence(
        "Our 128 PMA certificates and AS9100 registration support aerospace customers.",
        "Beacon Aerospace LLC",
      ),
    ).toBe(false);
  });

  it("does not promote a model menu without attributable same-category manufacture", () => {
    expect(
      isFirstPartyNamedProductEvidence(
        [
          "Beacon Aerospace LLC",
          "Featured products",
          "4-138 Velocity Transducer",
          "ISO 9001:2022 & AS9100 Rev D Certified",
        ].join("\n"),
        "Beacon Aerospace LLC",
      ),
    ).toBe(false);
    expect(
      isFirstPartyNamedProductEvidence(
        [
          "Beacon Aerospace LLC",
          "We distribute vibration transducers from leading manufacturers.",
          "4-138 Velocity Transducer",
        ].join("\n"),
        "Beacon Aerospace LLC",
      ),
    ).toBe(false);
  });

  it("preserves comparison and range semantics around the $50m mandate", () => {
    expect(
      classifyExplicitRevenueSize("We employ 24 people in two facilities."),
    ).toBe("unknown");
    const recentYear = new Date().getUTCFullYear() - 1;
    expect(
      classifyExplicitRevenueSize(
        `Annual revenue was $45 million in ${recentYear}.`,
      ),
    ).toBe("unknown");
    expect(
      classifyExplicitRevenueSize(
        `In its latest completed fiscal year ${recentYear}, annual revenue was $45 million.`,
      ),
    ).toBe("under_50m");
    expect(
      classifyExplicitRevenueSize(
        `Projected annual revenue for the latest fiscal year ${recentYear} is $45 million.`,
      ),
    ).toBe("unknown");
    expect(
      classifyExplicitRevenueSize(
        "In its latest completed fiscal year 1990, annual revenue was $12 million.",
      ),
    ).toBe("unknown");
    expect(
      classifyExplicitRevenueSize(
        "The company reported revenue of $50 million.",
      ),
    ).toBe("over_50m");
    expect(
      classifyExplicitRevenueSize("Our annual revenue exceeds $20 million."),
    ).toBe("unknown");
    expect(
      classifyExplicitRevenueSize("Our annual revenue is $20 million or more."),
    ).toBe("unknown");
    expect(
      classifyExplicitRevenueSize("Our annual revenue is $20 million+."),
    ).toBe("unknown");
    expect(
      classifyExplicitRevenueSize("Our annual revenue is $20 million plus."),
    ).toBe("unknown");
    expect(
      classifyExplicitRevenueSize("Our annual revenue is $20 million or less."),
    ).toBe("under_50m");
    expect(
      classifyExplicitRevenueSize(
        "Our annual revenue is less than $50 million.",
      ),
    ).toBe("under_50m");
    expect(
      classifyExplicitRevenueSize(
        "Revenue ranges from $20 million to $40 million.",
      ),
    ).toBe("under_50m");
    expect(
      classifyExplicitRevenueSize("Revenue ranges from $20-$40 million."),
    ).toBe("under_50m");
    expect(
      classifyExplicitRevenueSize(
        "Revenue ranges from $40 million to $60 million.",
      ),
    ).toBe("unknown");
    expect(
      classifyExplicitRevenueSize(
        "Our revenue increased by $5 million this year.",
      ),
    ).toBe("unknown");
    expect(
      classifyExplicitRevenueSize(
        "We invested $5 million in equipment and reported annual revenue of $100 million.",
      ),
    ).toBe("over_50m");
    expect(
      classifyExplicitRevenueSize("Our annual revenue rose to $100 million."),
    ).toBe("over_50m");
    expect(
      classifyExplicitRevenueSize("Our annual revenue rose from $5 million."),
    ).toBe("unknown");
    expect(
      classifyExplicitRevenueSize(
        "Our annual revenue rose from $5 million to $100 million.",
      ),
    ).toBe("over_50m");
    expect(
      classifyExplicitRevenueSize("Quarterly revenue was $5 million."),
    ).toBe("unknown");
    expect(
      classifyExplicitRevenueSize("Annual revenue was $12 million in 1990."),
    ).toBe("unknown");
    expect(
      classifyExplicitRevenueSize(
        "We target annual revenue of $40 million next year.",
      ),
    ).toBe("unknown");
    expect(
      classifyExplicitRevenueSize(
        "Our projected annual revenue is $40 million.",
      ),
    ).toBe("unknown");
    expect(
      classifyExplicitRevenueSize("Our annual revenue target is $40 million."),
    ).toBe("unknown");
    expect(
      classifyExplicitRevenueSize(
        "Our annual revenue will reach $40 million next year.",
      ),
    ).toBe("unknown");
  });

  it("admits only attributable current revenue into consumer size facts", () => {
    const recentYear = new Date().getUTCFullYear() - 1;
    const latest = extractWebsiteFacts(
      fetchedWebsite(
        `Our annual revenue for our latest completed fiscal year ${recentYear} was $45 million.`,
      ),
      "Beacon Aerospace LLC",
    );
    const datedWithoutLatest = extractWebsiteFacts(
      fetchedWebsite(`Our annual revenue was $45 million in ${recentYear}.`),
      "Beacon Aerospace LLC",
    );
    const forecast = extractWebsiteFacts(
      fetchedWebsite(
        `Our projected annual revenue for fiscal year ${recentYear} is $45 million.`,
      ),
      "Beacon Aerospace LLC",
    );

    expect(latest.sizeAssessment).toBe("under_50m");
    expect(latest.sizeDocuments).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          periodYear: recentYear,
          currentness: "latest_completed_period",
        }),
      }),
    ]);
    expect(datedWithoutLatest.sizeAssessment).toBe("unknown");
    expect(datedWithoutLatest.sizeDocuments).toEqual([]);
    expect(forecast.sizeAssessment).toBe("unknown");
    expect(forecast.sizeDocuments).toEqual([]);
  });

  it("attributes current ownership, revenue, and headquarters to the target", () => {
    const unrelated = extractWebsiteFacts(
      fetchedWebsite(
        [
          "Customer spotlight: Atlas",
          "We are family-owned, have annual revenue of $10 million, and are headquartered in Denver, CO.",
          "We were founded as a family-owned business in 1970.",
          "We are no longer family-owned.",
          "Our customer Atlas reports annual revenue of $20 million.",
          "Our customer Atlas is headquartered in Austin, TX 78701.",
          'Our customer Atlas says: "We are owned by MegaHoldings."',
        ].join("\n"),
      ),
      "Beacon Aerospace LLC",
    );
    const subordinate = extractWebsiteFacts(
      fetchedWebsite(
        "We supply Atlas, which is family-owned, has annual revenue of $20 million, and is headquartered in Austin, TX.",
      ),
      "Beacon Aerospace LLC",
    );
    const current = extractWebsiteFacts(
      fetchedWebsite(
        [
          "We remain family-owned.",
          "Our annual revenue is less than $50 million.",
          "We are headquartered in Austin, TX 78701.",
        ].join("\n"),
      ),
      "Beacon Aerospace LLC",
    );

    expect(unrelated).toMatchObject({
      ownershipStatus: "unknown",
      sizeAssessment: "unknown",
      headquarters: null,
    });
    expect(subordinate).toMatchObject({
      ownershipStatus: "unknown",
      sizeAssessment: "unknown",
      headquartersStatus: "unknown",
      headquarters: null,
    });
    expect(subordinate.ownershipDocuments).toHaveLength(0);
    expect(subordinate.sizeDocuments).toHaveLength(0);
    expect(subordinate.headquartersDocuments).toHaveLength(0);
    expect(current).toMatchObject({
      ownershipStatus: "independent",
      sizeAssessment: "under_50m",
      headquarters: { city: "Austin", state: "TX", country: "US" },
    });
  });

  it("binds source facts to the target property and persistent speaker scope", () => {
    const rejected = [
      "Beacon Aerospace LLC's subsidiary remains family-owned.",
      "We supply Atlas that is family-owned, has annual revenue of $20 million, and is headquartered in Austin, TX.",
      "We reported Atlas's annual revenue of $20 million.",
      "We know Atlas has annual revenue of $20 million.",
      "We help our customers generate annual revenue of $20 million.",
      "Our company supplies Atlas, which is family-owned, has annual revenue of $20 million, and is headquartered in Austin, TX.",
      "We target annual revenue of $40 million next year.",
      'Our customer Atlas says: "We build aircraft systems. We are family-owned. Our annual revenue is $20 million. Our headquarters are in Austin, Texas, United States."',
    ].map((text) =>
      extractWebsiteFacts(fetchedWebsite(text), "Beacon Aerospace LLC"),
    );

    for (const facts of rejected) {
      expect(facts).toMatchObject({
        ownershipStatus: "unknown",
        sizeAssessment: "unknown",
        headquartersStatus: "unknown",
        headquarters: null,
      });
      expect(facts.ownershipDocuments).toHaveLength(0);
      expect(facts.sizeDocuments).toHaveLength(0);
      expect(facts.headquartersDocuments).toHaveLength(0);
    }

    const coordinatedTargetRevenue = extractWebsiteFacts(
      fetchedWebsite(
        "We invested $5 million in equipment and reported annual revenue of $100 million.",
      ),
      "Beacon Aerospace LLC",
    );
    expect(coordinatedTargetRevenue.sizeAssessment).toBe("over_50m");
    expect(coordinatedTargetRevenue.sizeDocuments).toHaveLength(1);

    const directAmountInRevenue = extractWebsiteFacts(
      fetchedWebsite("We generated $100 million in annual revenue."),
      "Beacon Aerospace LLC",
    );
    expect(directAmountInRevenue.sizeAssessment).toBe("over_50m");
    expect(directAmountInRevenue.sizeDocuments).toHaveLength(1);

    const directLegalProperties = extractWebsiteFacts(
      fetchedWebsite(
        [
          "Beacon Aerospace LLC remains family-owned.",
          "Beacon Aerospace LLC's annual revenue is $20 million.",
          "Beacon Aerospace LLC's headquarters are in Austin, Texas, United States.",
        ].join("\n"),
      ),
      "Beacon Aerospace LLC",
    );
    expect(directLegalProperties).toMatchObject({
      ownershipStatus: "independent",
      sizeAssessment: "under_50m",
      headquartersStatus: "supported",
      headquarters: { city: "Austin", state: "TX", country: "US" },
    });
  });

  it("retains publisher facts after a closed customer quotation", () => {
    const facts = extractWebsiteFacts(
      fetchedWebsite(
        [
          'Our customer Atlas says: "We are family-owned. Our annual revenue is $20 million. Our headquarters are in Austin, Texas, United States."',
          "We remain family-owned.",
          "Our annual revenue is $80 million.",
          "Our headquarters are in Denver, CO.",
        ].join(" "),
      ),
      "Beacon Aerospace LLC",
    );

    expect(facts).toMatchObject({
      ownershipStatus: "independent",
      sizeAssessment: "over_50m",
      headquartersStatus: "supported",
      headquarters: { city: "Denver", state: "CO", country: "US" },
    });
    expect(facts.ownershipDocuments).toHaveLength(1);
    expect(facts.sizeDocuments).toHaveLength(1);
    expect(facts.headquartersDocuments).toHaveLength(1);
  });

  it("keeps a punctuated legal suffix attached to its attribution predicate", () => {
    const facts = extractWebsiteFacts(
      fetchedWebsite(
        [
          "Electronics International, Inc. remains family-owned.",
          "Our annual revenue is less than $50 million.",
          "We are headquartered in Anaheim, CA 92801.",
        ].join(" "),
      ),
      "Electronics International, Inc.",
    );

    expect(facts).toMatchObject({
      ownershipStatus: "independent",
      sizeAssessment: "under_50m",
      headquarters: { city: "Anaheim", state: "CA", country: "US" },
    });
    expect(
      facts.ownershipDocuments.map((document) => document.quote),
    ).toContain("Electronics International, Inc. remains family-owned.");
  });

  it("uses a confirmed publisher title to attribute suffix-omitted diligence facts", () => {
    const haltec = extractWebsiteFacts(
      fetchedWebsiteWithTitle(
        "About Us - HALTEC Corporation",
        "Haltec has over 125,000 square feet of office/manufacturing space and is headquartered in Leetonia, Ohio.",
      ),
      "Haltec Corporation",
    );
    const adpma = extractWebsiteFacts(
      fetchedWebsiteWithTitle(
        "ADPma, LLC | Who We Are",
        "ADPma has recently been acquired by “buy and grow” private investors committed to supporting our long term expansion and success.",
      ),
      "ADPma, LLC",
    );

    expect(haltec).toMatchObject({
      headquartersStatus: "supported",
      headquarters: { city: "Leetonia", state: "OH", country: "US" },
    });
    expect(
      haltec.headquartersDocuments.map((document) => document.quote),
    ).toEqual([
      "Haltec has over 125,000 square feet of office/manufacturing space and is headquartered in Leetonia, Ohio.",
    ]);
    expect(adpma).toMatchObject({
      ownershipStatus: "unknown",
      owner: null,
    });
  });

  it("marks attributable owner and independence evidence conflicting", () => {
    const facts = extractWebsiteFacts(
      fetchedWebsitePages(
        "We remain family-owned.",
        "We are owned by ParentCo.",
        "Atlas Components was acquired by MegaHoldings.",
      ),
      "Beacon Aerospace LLC",
    );

    expect(facts).toMatchObject({
      ownershipStatus: "unknown",
      owner: null,
      ownershipConflicting: true,
    });
    expect(facts.ownershipDocuments.map((document) => document.quote)).toEqual([
      "We remain family-owned.",
      "We are owned by ParentCo.",
    ]);
  });

  it("retains incompatible headquarters facts without treating either as support", () => {
    const facts = extractWebsiteFacts(
      fetchedWebsitePages(
        "We are headquartered in Austin, TX.",
        "We are headquartered in Toronto, Canada.",
      ),
      "Beacon Aerospace LLC",
    );

    expect(facts).toMatchObject({
      headquartersStatus: "conflicting",
      headquarters: null,
    });
    expect(
      facts.headquartersDocuments.map((document) => document.quote),
    ).toEqual([
      "We are headquartered in Austin, TX.",
      "We are headquartered in Toronto, Canada.",
    ]);
  });

  it("merges compatible partial headquarters facts without manufacturing conflict", () => {
    const facts = extractWebsiteFacts(
      fetchedWebsitePages(
        "We are headquartered in Austin, TX.",
        "Our headquarters are in Austin, United States.",
      ),
      "Beacon Aerospace LLC",
    );

    expect(facts).toMatchObject({
      headquartersStatus: "supported",
      headquarters: { city: "Austin", state: "TX", country: "US" },
    });
  });

  it("attaches country only to the governed current headquarters location", () => {
    const foreign = extractWebsiteFacts(
      fetchedWebsite(
        "We are headquartered in Tokyo and serve customers throughout the USA.",
      ),
      "Beacon Aerospace LLC",
    );
    const former = extractWebsiteFacts(
      fetchedWebsite(
        "Our annual revenue was $12 million in 1990.\nWe were formerly headquartered in Austin, TX 78701 before moving overseas.",
      ),
      "Beacon Aerospace LLC",
    );
    const explicitForeign = extractWebsiteFacts(
      fetchedWebsite(
        "We are headquartered in Tokyo, Japan and serve customers throughout the USA.",
      ),
      "Beacon Aerospace LLC",
    );

    expect(foreign.headquarters).toEqual({
      city: "Tokyo",
      state: null,
      country: null,
    });
    expect(former).toMatchObject({
      headquarters: null,
      sizeAssessment: "unknown",
    });
    expect(explicitForeign.headquarters).toEqual({
      city: "Tokyo",
      state: null,
      country: "Japan",
    });
  });

  it("recognizes the federal district as US headquarters without an alias conflict", () => {
    const facts = extractWebsiteFacts(
      fetchedWebsitePages(
        "We are headquartered in Washington, DC.",
        "We are headquartered in Washington, District of Columbia.",
        "We are headquartered in Washington, D.C.",
      ),
      "Beacon Aerospace LLC",
    );

    expect(facts).toMatchObject({
      headquartersStatus: "supported",
      headquarters: { city: "Washington", state: "DC", country: "US" },
    });
  });

  it("keeps NMB's governed headquarters separate from its listed offices", () => {
    const statement =
      "NMB Technologies Corporation, a MinebeaMitsumi Group Company, is headquartered in Novi, Michigan, with offices in San Jose, CA, Chatsworth, CA, Marysville, OH and Boston, MA.";
    const facts = extractWebsiteFacts(
      fetchedWebsiteWithTitle("About Us | NMB Technologies", statement),
      "NMB Technologies Corporation",
    );

    expect(facts).toMatchObject({
      headquartersStatus: "supported",
      headquarters: { city: "Novi", state: "MI", country: "US" },
      headquartersObservations: [
        { city: "Novi", state: "MI", country: "US" },
      ],
    });
    expect(
      facts.headquartersDocuments.map((document) => document.quote),
    ).toEqual([statement]);
  });

  it("parses only the governed US address before office or parent clauses", () => {
    const address = extractWebsiteFacts(
      fetchedWebsite(
        "Our headquarters are located at 123 Aviation Way, Austin, Texas 78701, with offices in Denver, CO and Boston, MA.",
      ),
      "Beacon Aerospace LLC",
    );
    const parent = extractWebsiteFacts(
      fetchedWebsite(
        "We are headquartered in Austin, Texas, while our parent is headquartered in Chicago, Illinois.",
      ),
      "Beacon Aerospace LLC",
    );

    expect(address).toMatchObject({
      headquartersStatus: "supported",
      headquarters: { city: "Austin", state: "TX", country: "US" },
    });
    expect(parent).toMatchObject({
      headquartersStatus: "supported",
      headquarters: { city: "Austin", state: "TX", country: "US" },
    });
  });

  it("preserves a multiword foreign country in the governed location", () => {
    const facts = extractWebsiteFacts(
      fetchedWebsite(
        "Our headquarters are in Port of Spain, Trinidad and Tobago, with offices in Miami, FL.",
      ),
      "Beacon Aerospace LLC",
    );

    expect(facts).toMatchObject({
      headquartersStatus: "supported",
      headquarters: {
        city: "Port of Spain",
        state: null,
        country: "Trinidad and Tobago",
      },
    });
  });

  it("does not extend headquarters into trailing predicates or office clauses", () => {
    const foreignWithOffice = extractWebsiteFacts(
      fetchedWebsite(
        "We are headquartered in Toronto, Canada with offices in Austin, TX.",
      ),
      "Beacon Aerospace LLC",
    );
    const usWithPredicate = extractWebsiteFacts(
      fetchedWebsite(
        "We are headquartered in Austin, Texas and have 30 employees.",
      ),
      "Beacon Aerospace LLC",
    );
    const foreignWithUsOffice = extractWebsiteFacts(
      fetchedWebsite(
        "Our headquarters are in Toronto, Canada, and our US office is in Austin, TX.",
      ),
      "Beacon Aerospace LLC",
    );

    expect(foreignWithOffice).toMatchObject({
      headquartersStatus: "supported",
      headquarters: { city: "Toronto", state: null, country: "Canada" },
    });
    expect(usWithPredicate).toMatchObject({
      headquartersStatus: "supported",
      headquarters: { city: "Austin", state: "TX", country: "US" },
    });
    expect(foreignWithUsOffice).toMatchObject({
      headquartersStatus: "supported",
      headquarters: { city: "Toronto", state: null, country: "Canada" },
    });
  });

  it("abstains from a compound headquarters location instead of combining it", () => {
    const facts = extractWebsiteFacts(
      fetchedWebsite(
        "We are headquartered in Austin, Texas and Denver, Colorado, United States.",
      ),
      "Beacon Aerospace LLC",
    );

    expect(facts).toMatchObject({
      headquartersStatus: "unknown",
      headquarters: null,
      headquartersObservations: [],
    });
    expect(facts.headquartersDocuments).toEqual([]);
  });

  it("attributes McNeil's current headcount and owned headquarters without borrowing nearby facts", () => {
    const source = fetchedWebsiteWithTitle(
      "About McNeil Industries | McNeil Industries",
      [
        "Since its inception in 1986 by Randall J. McNeil, McNeil Industries has grown from a humble beginning in a basement to a leading, privately-held manufacturer headquartered in Painesville, Ohio.",
        "McNeil Industries currently employs 30 people at its 32,000-square-foot headquarters and manufacturing facility in Painesville, Ohio.",
        "Our customer Atlas currently employs 400 people at its 80,000-square-foot headquarters and manufacturing facility in Denver, Colorado.",
        "McNeil Industries reports that its parent currently employs 500 people at its headquarters and manufacturing facility in Chicago, Illinois.",
        "McNeil Industries once employed 12 people at its headquarters and manufacturing facility in Willoughby, Ohio.",
      ].join("\n"),
    );
    const facts = extractWebsiteFacts(
      {
        ...source,
        pages: source.pages.map((page) => ({
          ...page,
          url: "https://mcneilindustries.com/about-us/",
        })),
      },
      "McNeil Industries",
    );

    expect(facts).toMatchObject({
      ownershipStatus: "unknown",
      sizeAssessment: "unknown",
      headquartersStatus: "supported",
      headquarters: { city: "Painesville", state: "OH", country: "US" },
    });
    expect(facts.sizeDocuments).toContainEqual(
      expect.objectContaining({
        url: "https://mcneilindustries.com/about-us/",
        metadata: expect.objectContaining({
          sizeKind: "employee_count",
          periodYear: null,
          currentness: "undated_current",
        }),
        quote: expect.stringContaining(
          "McNeil Industries currently employs 30 people",
        ),
      }),
    );
    expect(facts.sizeDocuments).not.toContainEqual(
      expect.objectContaining({
        quote: expect.stringMatching(
          /customer Atlas|its parent|once employed/u,
        ),
      }),
    );
    expect(facts.headquartersDocuments).toContainEqual(
      expect.objectContaining({
        url: "https://mcneilindustries.com/about-us/",
        metadata: { explicitHeadquarters: true },
        quote: expect.stringContaining(
          "its 32,000-square-foot headquarters and manufacturing facility in Painesville, Ohio",
        ),
      }),
    );
  });

  it("binds owned headquarters to the target antecedent and current tense", () => {
    for (const statement of [
      "Beacon Aerospace LLC manufactures components for its parent company at its headquarters in Paris, France.",
      "Beacon Aerospace LLC manufactures components with its supplier at its headquarters in Toronto, Canada.",
      "We no longer maintain our headquarters in Austin, Texas.",
    ]) {
      const facts = extractWebsiteFacts(
        fetchedWebsite(statement),
        "Beacon Aerospace LLC",
      );
      expect(facts.headquartersStatus, statement).toBe("unknown");
      expect(facts.headquarters, statement).toBeNull();
      expect(facts.headquartersDocuments, statement).toHaveLength(0);
    }

    const targetOwned = extractWebsiteFacts(
      fetchedWebsite(
        "Beacon Aerospace LLC operates from its headquarters in Austin, Texas while serving customers.",
      ),
      "Beacon Aerospace LLC",
    );
    expect(targetOwned).toMatchObject({
      headquartersStatus: "supported",
      headquarters: { city: "Austin", state: "TX", country: "US" },
    });
  });

  it("keeps overlength contradictions in aggregate fact reconciliation", () => {
    const trailingContext =
      "while continuing precision manufacturing operations for aerospace and industrial applications ".repeat(
        7,
      );
    const revenue = extractWebsiteFacts(
      fetchedWebsitePages(
        "We have annual revenue of $25 million.",
        `We have annual revenue of $80 million ${trailingContext}.`,
      ),
      "Beacon Aerospace LLC",
    );
    const headquarters = extractWebsiteFacts(
      fetchedWebsitePages(
        "We are headquartered in Austin, Texas.",
        `We are headquartered in Paris, France ${trailingContext}.`,
      ),
      "Beacon Aerospace LLC",
    );
    const ownership = extractWebsiteFacts(
      fetchedWebsitePages(
        "We are independently owned.",
        `We are owned by ParentCo ${trailingContext}.`,
      ),
      "Beacon Aerospace LLC",
    );

    expect(revenue.sizeAssessment).toBe("unknown");
    expect(revenue.sizeDocuments).toContainEqual(
      expect.objectContaining({
        quote: "We have annual revenue of $25 million.",
      }),
    );
    expect(headquarters).toMatchObject({
      headquartersStatus: "conflicting",
      headquarters: null,
    });
    expect(headquarters.headquartersDocuments).toContainEqual(
      expect.objectContaining({
        quote: "We are headquartered in Austin, Texas.",
      }),
    );
    expect(ownership).toMatchObject({
      ownershipStatus: "unknown",
      owner: null,
    });
    expect(ownership.ownershipDocuments).toContainEqual(
      expect.objectContaining({ quote: "We are independently owned." }),
    );
  });

  it("does not assign affirmative facts when their complete source statements exceed the support bound", () => {
    const trailingContext =
      "while continuing precision manufacturing operations for aerospace and industrial applications ".repeat(
        7,
      );
    const facts = extractWebsiteFacts(
      fetchedWebsitePages(
        `We are owned by ParentCo ${trailingContext}.`,
        `We currently employ 30 people ${trailingContext}.`,
        `We are headquartered in Austin, TX ${trailingContext}.`,
      ),
      "Beacon Aerospace LLC",
    );

    expect(facts).toMatchObject({
      ownershipStatus: "unknown",
      owner: null,
      sizeAssessment: "unknown",
      headquartersStatus: "unknown",
      headquarters: null,
    });
    expect(facts.ownershipDocuments).toHaveLength(0);
    expect(facts.sizeDocuments).toHaveLength(0);
    expect(facts.headquartersDocuments).toHaveLength(0);
  });

  it("preserves newline-delimited facts after a long unpunctuated block", () => {
    const facts = extractWebsiteFacts(
      fetchedWebsite(
        `${"precision manufacturing capabilities ".repeat(40)}\nWe remain family-owned.`,
      ),
      "Beacon Aerospace LLC",
    );

    expect(facts.ownershipStatus).toBe("independent");
  });
});
