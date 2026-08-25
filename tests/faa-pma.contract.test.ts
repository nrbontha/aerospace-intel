import { describe, expect, it } from "vitest";

import {
  faaPmaPublicUrl,
  faaPmaRecordSchema,
  faaPmaScrapeQuerySchema,
  faaPmaScrapeResultSchema,
  identifierTypeSchema,
} from "@asi/contracts";

const record = {
  recordId: "DRSDOCID123456",
  guidUrl:
    "https://drs.faa.gov/browse/excelExternalWindow/DRSDOCID123456",
  status: "Active",
  subStatus: null,
  holderName: "Acme Aerospace, Inc.",
  holderNumber: "PQ1234CE",
  fullAddress: "100 Flight Way, Wichita, KS 67209, United States",
  pmaPartNumber: "ACM-100",
  partName: "Bracket Assembly",
  replacementPartNumber: "OEM-42",
  make: "Boeing",
  models: ["737-700", "737-800"],
  supplementNumber: "12",
  supplementDate: "2026-08-25",
  approvalBasis: "Test and computation",
  serviceOffice: "Fort Worth ACO Branch",
  opr: "AIR-7F0",
  cfrReferences: ["14 CFR 21.303"],
  comments: null,
  renderedSourceText: "PMA Holder Name: Acme Aerospace, Inc.\nPMA Part Number: ACM-100",
};

const source = {
  publicUrl: faaPmaPublicUrl,
  scrapedAt: "2026-08-25T12:00:00.000Z",
  retrievalMethod: "guest_browser_dom" as const,
};

describe("FAA PMA contracts", () => {
  it("accepts a complete strict record and rejects unmodeled fields", () => {
    expect(faaPmaRecordSchema.parse(record)).toEqual(record);
    expect(
      faaPmaRecordSchema.parse({ ...record, renderedSourceText: "\n  raw card  \n" })
        .renderedSourceText,
    ).toBe("\n  raw card  \n");
    expect(
      faaPmaRecordSchema.safeParse({ ...record, privateApiPayload: {} }).success,
    ).toBe(false);
    expect(
      faaPmaRecordSchema.safeParse({ ...record, supplementDate: "08/25/2026" })
        .success,
    ).toBe(false);
  });

  it("requires exactly one targeted public UI filter and caps records at 25", () => {
    expect(faaPmaScrapeQuerySchema.parse({ holderName: " Acme ", maxRecords: "10" })).toEqual({
      holderName: "Acme",
      maxRecords: 10,
    });
    expect(faaPmaScrapeQuerySchema.parse({ partNumber: "ACM-100" })).toEqual({
      partNumber: "ACM-100",
      maxRecords: 25,
    });

    expect(faaPmaScrapeQuerySchema.safeParse({}).success).toBe(false);
    expect(
      faaPmaScrapeQuerySchema.safeParse({ holderName: "Acme", model: "737" })
        .success,
    ).toBe(false);
    expect(
      faaPmaScrapeQuerySchema.safeParse({ make: "Boeing", maxRecords: 26 })
        .success,
    ).toBe(false);
    expect(
      faaPmaScrapeQuerySchema.safeParse({ make: "Boeing", unexpected: true })
        .success,
    ).toBe(false);
  });

  it("validates source metadata and exposes the FAA holder identifier", () => {
    const result = {
      query: { holderNumber: "PQ1234CE", maxRecords: 1 },
      records: [record],
      source,
    };
    expect(faaPmaScrapeResultSchema.parse(result)).toEqual(result);
    expect(
      faaPmaScrapeResultSchema.safeParse({
        ...result,
        source: {
          ...source,
          hydratedRecordUrl:
            "https://drs.faa.gov/browse/excelExternalWindow/DRSDOCID123456",
        },
      }).success,
    ).toBe(true);
    expect(
      faaPmaScrapeResultSchema.safeParse({
        ...result,
        source: { ...source, hydratedRecordUrl: "not-a-url" },
      }).success,
    ).toBe(false);
    expect(
      faaPmaScrapeResultSchema.safeParse({
        ...result,
        records: [record, { ...record, recordId: "DRSDOCID654321" }],
      }).success,
    ).toBe(false);
    expect(
      faaPmaScrapeResultSchema.safeParse({
        ...result,
        source: { ...source, retrievalMethod: "private_json_api" },
      }).success,
    ).toBe(false);
    expect(identifierTypeSchema.parse("faa_pma_holder")).toBe("faa_pma_holder");
  });
});
