import { describe, expect, it } from "vitest";

import { CSV_MAX_BYTES, CSV_MAX_ROWS } from "./csv.js";
import {
  ImportValidationError,
  processImportBatch,
  validateCompanyRow,
  validateFacilityRow,
} from "./imports.js";

describe("import row validation", () => {
  it("accepts a company row and keeps optional fields omitted", () => {
    const row = validateCompanyRow(
      { legal_name: "Acme Castings", website_url: "https://acme.example" },
      2,
    );
    expect(row.status).toBe("validated");
    expect(row.normalizedData).toEqual({
      legalName: "Acme Castings",
      displayName: "Acme Castings",
      websiteUrl: "https://acme.example",
      status: "active",
    });
  });

  it("rejects missing names, bad URLs, and unknown statuses", () => {
    const row = validateCompanyRow(
      { legal_name: "", website_url: "ftp://x", status: "mystery" },
      3,
    );
    expect(row.status).toBe("rejected");
    expect(row.errors.join(" ")).toMatch(/legal_name/);
    expect(row.errors.join(" ")).toMatch(/http/);
    expect(row.errors.join(" ")).toMatch(/status/);
  });

  it("requires a facility country and owning company", () => {
    const missing = validateFacilityRow({ name: "Plant 1" }, 2);
    expect(missing.status).toBe("rejected");
    const ok = validateFacilityRow(
      {
        name: "Plant 1",
        country_code: "us",
        company_legal_name: "Acme Castings",
      },
      2,
    );
    expect(ok.status).toBe("validated");
    expect(ok.normalizedData).toMatchObject({
      name: "Plant 1",
      countryCode: "US",
      companyLegalName: "Acme Castings",
      status: "active",
    });
  });
});


describe("import size and emptiness guards", () => {
  it("rejects empty and oversized CSVs before touching the database", async () => {
    await expect(
      processImportBatch({
        actorUserId: "00000000-0000-4000-8000-000000000001",
        content: new Uint8Array(),
        dryRun: true,
        entity: "companies",
        fileName: "empty.csv",
      }),
    ).rejects.toBeInstanceOf(ImportValidationError);

    const oversized = new Uint8Array(CSV_MAX_BYTES + 1);
    oversized.set(new TextEncoder().encode("legal_name\nAcme\n"));
    await expect(
      processImportBatch({
        actorUserId: "00000000-0000-4000-8000-000000000001",
        content: oversized,
        dryRun: true,
        entity: "companies",
        fileName: "huge.csv",
      }),
    ).rejects.toMatchObject({
      name: "ImportValidationError",
      message: "CSV imports are limited to 5 MB",
    });
  });

  it("rejects CSVs over the row cap before persistence", async () => {
    const body = ["legal_name", ...Array.from({ length: CSV_MAX_ROWS + 1 }, () => "Acme")].join("\n");
    await expect(
      processImportBatch({
        actorUserId: "00000000-0000-4000-8000-000000000001",
        content: new TextEncoder().encode(body),
        dryRun: true,
        entity: "companies",
        fileName: "rows.csv",
      }),
    ).rejects.toMatchObject({
      name: "ImportValidationError",
      message: `CSV imports are limited to ${CSV_MAX_ROWS} rows`,
    });
  });
});
