import { describe, expect, it } from "vitest";

import { normalizeCsvHeader, parseCsv, stringifyCsv } from "./csv.js";

describe("parseCsv", () => {
  it("parses a simple table and skips blank rows", () => {
    const parsed = parseCsv(
      "legal_name,website_url\nHitchiner Manufacturing Co.,https://hitchiner.com\n\nAcme Castings,\n",
    );
    expect(parsed.headers).toEqual(["legal_name", "website_url"]);
    expect(parsed.rows).toEqual([
      {
        legal_name: "Hitchiner Manufacturing Co.",
        website_url: "https://hitchiner.com",
      },
      { legal_name: "Acme Castings", website_url: "" },
    ]);
  });

  it("keeps quoted commas and escaped quotes", () => {
    const parsed = parseCsv('name,notes\n"Acme, Inc.","He said ""ready"""\n');
    expect(parsed.rows[0]).toEqual({
      name: "Acme, Inc.",
      notes: 'He said "ready"',
    });
  });

  it("normalizes noisy headers", () => {
    expect(normalizeCsvHeader(" Legal Name ")).toBe("legal_name");
    const parsed = parseCsv("Legal Name,Country Code\nAcme,US\n");
    expect(parsed.headers).toEqual(["legal_name", "country_code"]);
    expect(parsed.rows[0]?.country_code).toBe("US");
  });

  it("rejects duplicate headers and unterminated quotes", () => {
    expect(() => parseCsv("name,name\nA,B\n")).toThrow(/unique/);
    expect(() => parseCsv('name\n"open\n')).toThrow(/unterminated/);
  });
});

describe("stringifyCsv", () => {
  it("round-trips quotes and commas", () => {
    const csv = stringifyCsv(["name", "notes"], [
      { name: "Acme, Inc.", notes: 'He said "ready"' },
    ]);
    expect(parseCsv(csv).rows[0]).toEqual({
      name: "Acme, Inc.",
      notes: 'He said "ready"',
    });
  });
});
