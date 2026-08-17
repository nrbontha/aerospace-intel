import { describe, expect, it } from "vitest";

import { normalizeComparableHttpUrl, searchContains } from "./search.js";

describe("searchContains", () => {
  it("wraps trimmed text in a contains pattern", () => {
    expect(searchContains("  Hitchiner  ")).toBe("%Hitchiner%");
  });

  it("strips LIKE wildcards instead of honoring them", () => {
    expect(searchContains("%acme_co\\")).toBe("%acme co%");
    expect(searchContains("%%%")).toBeUndefined();
    expect(searchContains("   ")).toBeUndefined();
    expect(searchContains(undefined)).toBeUndefined();
  });
});

describe("normalizeComparableHttpUrl", () => {
  it("lowercases and strips trailing slashes", () => {
    expect(normalizeComparableHttpUrl(" HTTPS://www.Hitchiner.com/ ")).toBe(
      "https://www.hitchiner.com",
    );
    expect(normalizeComparableHttpUrl("https://www.hitchiner.com")).toBe(
      "https://www.hitchiner.com",
    );
  });
});
