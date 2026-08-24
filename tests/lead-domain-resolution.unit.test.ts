/**
 * Pure unit coverage for the lead domain-resolution helpers: tokenization,
 * overlap math, candidate normalization, fallback domains, title casing.
 * No DB, no network.
 */
import { describe, expect, it } from "vitest";

import {
  fallbackDomainsFor,
  identityOverlapRatio,
  leadNameTokens,
  normalizeCandidateDomain,
  titleCaseName,
} from "@asi/database";

describe("leadNameTokens", () => {
  it("drops legal suffixes, stopwords and punctuation", () => {
    expect(leadNameTokens("YORK PRECISION MACHINING AND HYDRAULICS, LLC")).toEqual([
      "york",
      "precision",
      "machining",
      "hydraulics",
    ]);
  });

  it("keeps meaningful short tokens but strips generic ones", () => {
    expect(leadNameTokens("The Acme Tool & Die Co.")).toEqual(["acme", "tool", "die"]);
  });

  it("returns nothing for a pure-suffix name", () => {
    expect(leadNameTokens("LLC Inc Corp")).toEqual([]);
  });
});

describe("identityOverlapRatio", () => {
  const homepage =
    "York Precision Machining and Hydraulics — CNC machining, hydraulic repair. Welcome to our shop.";

  it("scores a perfect identity page at 1", () => {
    expect(identityOverlapRatio("YORK PRECISION MACHINING AND HYDRAULICS, LLC", homepage)).toBe(1);
  });

  it("is case- and punctuation-insensitive on both sides", () => {
    expect(
      identityOverlapRatio("york-precision machining", "YORK PRECISION MACHINING CO"),
    ).toBe(1);
  });

  it("scores an unrelated page low", () => {
    expect(identityOverlapRatio("YORK PRECISION MACHINING AND HYDRAULICS, LLC", "buy cheap sneakers online")).toBe(0);
  });

  it("handles partial matches fractionally", () => {
    // 1 of 2 tokens present → 0.5: at MIN_IDENTITY_OVERLAP exactly, the
  // service treats the page as ambiguous and escalates to the model judge.
    expect(identityOverlapRatio("acme hydraulics", "ACME Systems for sale")).toBe(0.5);
  });

  it("returns 0 when the name has no significant tokens", () => {
    expect(identityOverlapRatio("LLC", "anything at all")).toBe(0);
  });
});

describe("normalizeCandidateDomain", () => {
  it("strips scheme, www, paths and casing", () => {
    expect(normalizeCandidateDomain("https://WWW.YorkPMH.com/products")).toBe("yorkpmh.com");
    expect(normalizeCandidateDomain("  YorkPMH.com ")).toBe("yorkpmh.com");
  });

  it("rejects empty input", () => {
    expect(normalizeCandidateDomain("   ")).toBeNull();
  });
});

describe("fallbackDomainsFor", () => {
  it("joins significant tokens under .com/.net only", () => {
    expect(fallbackDomainsFor("ACME Tool Works, LLC")).toEqual([
      "acmetoolworks.com",
      "acmetoolworks.net",
    ]);
  });

  it("returns nothing when no tokens survive", () => {
    expect(fallbackDomainsFor("LLC")).toEqual([]);
  });
});

describe("titleCaseName", () => {
  it("title-cases an all-caps legal name, keeping legal suffixes as written", () => {
    expect(titleCaseName("YORK PRECISION MACHINING AND HYDRAULICS, LLC")).toBe(
      "York Precision Machining And Hydraulics, LLC",
    );
  });
});
