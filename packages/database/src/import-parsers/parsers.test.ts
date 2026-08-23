import { readFile } from "node:fs/promises";
import * as XLSX from "xlsx";
import { beforeAll, describe, expect, it } from "vitest";
import {
  excelSerialToIso,
  parseDatabaseSources,
  parseGoldenSetWorkbook,
  parseGrataData,
  parsePipeline,
  type ParsedGoldenSet,
  type ParsedPipeline,
  type PipelineRow,
} from "./index.js";

// ---------------------------------------------------------------------------
// Synthetic workbook builders — tiny xlsx files reproducing the REAL layouts
// (criteria-above-table, duplicate 'Name' header, Excel serial dates).
// ---------------------------------------------------------------------------

const PIPELINE_HEADERS = [
  "Name",
  "Category",
  "Domain",
  "Stage",
  "Status",
  "Priority",
  "Description",
  "Revenue",
  "EBITDA",
  "EBITDA Margin",
  "Employees",
  "Situation Update",
  "Situate Update Date",
  "Next Action",
  "Contact Made?",
  "NDA Signed Date",
  "IOI/LOI?",
  "Source",
  "Process Type",
  "HQ",
  "Ownership",
  "Name", // duplicate header at index 21: CONTACT first name
  "Title",
  "Email",
];

function pipelineDataRow(overrides: Record<number, unknown> = {}): unknown[] {
  const row: unknown[] = new Array(24).fill(null);
  row[0] = "Interface, Inc.";
  row[1] = "Avionics, Electrical & Sensors";
  row[2] = "interfaceforce.com";
  row[5] = 1;
  row[7] = 500_000;
  row[12] = 46217; // Excel serial
  row[21] = "Cathy Caris"; // contact name ≠ company name
  row[22] = "Owner";
  row[23] = "ccaris@interfaceforce.com";
  Object.entries(overrides).forEach(([i, v]) => {
    row[Number(i)] = v;
  });
  return row;
}

function aoaToWorkbook(sheets: Record<string, unknown[][]>): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  }
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

function buildPipelineWorkbook(extraLeadingBlankRow = false): ArrayBuffer {
  const rows: unknown[][] = [];
  if (extraLeadingBlankRow) rows.push(new Array(24).fill(null));
  rows.push(["ADCO M&A Pipeline", ...new Array(23).fill(null)]);
  rows.push(new Array(24).fill(null)); // junk blank between title and header
  rows.push(PIPELINE_HEADERS);
  rows.push(pipelineDataRow()); // priority 1, revenue set
  rows.push(
    pipelineDataRow({
      0: "Bartington Instruments",
      2: "bartington.com",
      5: 2,
      7: 10_000_000,
      8: 600_000,
      9: 0.06,
      10: 48,
    }),
  );
  rows.push(
    pipelineDataRow({
      0: "ValveTech",
      2: "valvetech.net",
      5: null, // sparse priorities: nulls must stay null (verbatim)
      7: null, // null revenue
      8: 5_000_000,
      9: 0.43478,
      15: 45991, // NDA serial date
    }),
  );
  rows.push(new Array(24).fill(null)); // trailing blank row is skipped
  return aoaToWorkbook({ "M&A Pipeline": rows });
}

function buildGoldenSetWorkbook(): ArrayBuffer {
  const targets: unknown[][] = [
    ["Qualifying parameters"],
    ["Privately-owned"],
    ["Less than $50m revenue"],
    ["Keywords: proprietary, sole sourced,\r\nPMA, FAA, ITAR"],
    ["Diqsualifying parameters"], // typo is verbatim from the real sheet
    ["Pure-play distributors or service providers"],
    [null, null, null, null, null, null, null],
    ["Company Name", "Domain", "Description", "HQ", "Estimated revenue", "Ownership", "Misc. details"],
    [
      "ADPma, LLC",
      "adpma.com",
      "FAA-PMA aftermarket supplier.",
      "USA - TN",
      4_000_000,
      "Mollenhour Gross",
      "note-a",
    ],
    [
      "The PDI Group",
      "thepdigroup.com",
      "Four member companies.",
      "USA - NJ",
      null, // null revenue preserved
      "Private",
      "note-b",
    ],
  ];

  const grata: unknown[][] = [
    ["Grata Link", "Company Id", "Domain", "Name", "Description", "Revenue Estimate"],
    ["https://search.grata.com/search?c=CPHA5YYK", "CPHA5YYK", "adpma.com", "Adpma, Llc", "PMA parts.", 4_020_000],
    ["https://search.grata.com/search?c=J2SSBJAD", "J2SSBJAD", "thepdigroup.com", "The Pdi Group", "GSE.", null],
  ];

  const sources: unknown[][] = [
    ["Common Databases", "Domain", "Misc. details"],
    ["OASIS", "https://iaqg.org/tools/oasis/", "IAQG cert list."],
    ["USAspending", "https://www.usaspending.gov/", null],
  ];

  return aoaToWorkbook({ "Golden Set Targets": targets, "Grata Data": grata, "Database Sources": sources });
}

// ---------------------------------------------------------------------------
// Synthetic-layout tests (always run)
// ---------------------------------------------------------------------------

describe("parsePipeline (synthetic)", () => {
  let parsed: ParsedPipeline;

  beforeAll(() => {
    parsed = parsePipeline(buildPipelineWorkbook());
  });

  it("detects the header row below title junk rows", () => {
    expect(parsed.headers).toEqual(PIPELINE_HEADERS);
    expect(parsed.headers).toHaveLength(24);
    // duplicate 'Name' header at index 21
    expect(parsed.headers[0]).toBe("Name");
    expect(parsed.headers[21]).toBe("Name");
    expect(parsed.headers).toContain("Situate Update Date"); // real-sheet typo preserved
  });

  it("maps positionally so contact name ≠ company name", () => {
    const first = parsed.rows[0]!;
    expect(first.companyName).toBe("Interface, Inc.");
    expect(first.contactName).toBe("Cathy Caris");
    expect(first.contactTitle).toBe("Owner");
    expect(first.contactEmail).toBe("ccaris@interfaceforce.com");
    expect(first.category).toBe("Avionics, Electrical & Sensors");
    expect(first.domain).toBe("interfaceforce.com");
  });

  it("preserves Priority verbatim as string|null, never number semantics", () => {
    expect(parsed.rows.map((r) => r.rawPriority)).toEqual(["1", "2", null]);
  });

  it("parses numbers only for revenue/ebitda/employees", () => {
    const [a, b, c] = parsed.rows as [PipelineRow, PipelineRow, PipelineRow];
    expect(a.revenue).toBe(500_000);
    expect(a.ebitda).toBeNull();
    expect(b.revenue).toBe(10_000_000);
    expect(b.ebitda).toBe(600_000);
    expect(b.ebitdaMargin).toBeCloseTo(0.06);
    expect(b.employees).toBe(48);
    expect(c.revenue).toBeNull();
    expect(c.ebitdaMargin).toBeCloseTo(0.43478);
  });

  it("converts Excel serial dates to ISO via the 1899-12-30 epoch", () => {
    expect(excelSerialToIso(46217)).toBe("2026-07-14");
    expect(excelSerialToIso(1)).toBe("1899-12-31");
    expect(parsed.rows[0]!.situationUpdateDate).toBe("2026-07-14");
    expect(parsed.rows[0]!.ndaSignedDate).toBeNull();
    expect(parsed.rows[2]!.ndaSignedDate).toBe("2025-11-30");
  });

  it("skips trailing blank rows but keeps workbookRow faithful", () => {
    expect(parsed.rows).toHaveLength(3);
    // title(1) + blank(2) + header(3) → first data row is sheet row 4
    expect(parsed.rows[0]!.workbookRow).toBe(4);
  });

  it("is robust to an extra leading blank row (off-by-one)", () => {
    const shifted = parsePipeline(buildPipelineWorkbook(true));
    expect(shifted.headers).toEqual(PIPELINE_HEADERS);
    expect(shifted.rows.map((r) => r.companyName)).toEqual(
      parsed.rows.map((r) => r.companyName),
    );
    expect(shifted.rows[0]!.workbookRow).toBe(5); // one row later, still correct
  });
});

describe("golden-set workbook parsers (synthetic)", () => {
  let parsed: ParsedGoldenSet;
  let grataRows: ReturnType<typeof parseGrataData>;

  beforeAll(() => {
    const bytes = buildGoldenSetWorkbook();
    parsed = parseGoldenSetWorkbook(bytes);
    grataRows = parseGrataData(bytes.slice(0));
  });

  it("splits criteria into qualifying/disqualifying blocks above the table", () => {
    expect(parsed.criteria.qualifying).toEqual([
      "Privately-owned",
      "Less than $50m revenue",
      "Keywords: proprietary, sole sourced,\r\nPMA, FAA, ITAR", // line break verbatim
    ]);
    expect(parsed.criteria.disqualifying).toEqual([
      "Pure-play distributors or service providers",
    ]);
    // raw captures everything verbatim, including both block titles
    expect(parsed.criteria.raw[0]).toBe("Qualifying parameters");
    expect(parsed.criteria.raw).toHaveLength(6);
    expect(parsed.criteria.raw).toContain("Diqsualifying parameters");
  });

  it("maps company table by header with null revenue preserved", () => {
    expect(parsed.companies.map((c) => c.name)).toEqual([
      "ADPma, LLC",
      "The PDI Group",
    ]);
    const adpma = parsed.companies[0]!;
    expect(adpma.domain).toBe("adpma.com");
    expect(adpma.hq).toBe("USA - TN");
    expect(adpma.revenueEstimate).toBe(4_000_000);
    expect(adpma.ownership).toBe("Mollenhour Gross");
    expect(adpma.grataPayload["Misc. details"]).toBe("note-a");
    expect(parsed.companies[1]!.revenueEstimate).toBeNull();
  });

  it("parses Grata Data payload keyed verbatim by all headers", () => {
    expect(grataRows).toHaveLength(2);
    expect(grataRows[0]!.name).toBe("Adpma, Llc");
    expect(grataRows[0]!.domain).toBe("adpma.com");
    expect(grataRows[0]!.revenueEstimate).toBe(4_020_000);
    expect(grataRows[0]!.grataPayload["Company Id"]).toBe("CPHA5YYK");
    expect(String(grataRows[0]!.grataPayload["Grata Link"])).toContain("grata.com");
    expect(grataRows[1]!.revenueEstimate).toBeNull();
  });

  it("parses Database Sources rows", () => {
    const sources = parseDatabaseSources(buildGoldenSetWorkbook());
    expect(sources.map((s) => s.name)).toEqual(["OASIS", "USAspending"]);
    expect(sources[0]!.domain).toBe("https://iaqg.org/tools/oasis/");
    expect(sources[1]!.details).toBeNull();

    // combined workbook result exposes the same rows
    expect(parsed.sources.map((s) => s.name)).toEqual(["OASIS", "USAspending"]);
  });
});

// ---------------------------------------------------------------------------
// INTEGRATION guard against the REAL workbooks.
// Opt-in only: run locally with ASI_REAL_DATASETS=1 (files live outside git
// in <repo>/data/). Skips cleanly otherwise.
// ---------------------------------------------------------------------------

const dataDir = new URL("../../../../data/", import.meta.url).pathname;
const goldenPath = `${dataDir}ADCO-golden-set.xlsx`;
const pipelinePath = `${dataDir}ADCO-pipeline.xlsx`;

describe.skipIf(!process.env.ASI_REAL_DATASETS)("real ADCO workbooks", () => {
  it("parses without throwing and matches measured ground truth", async () => {
    const [goldenBytes, pipelineBytes] = await Promise.all([
      readFile(goldenPath),
      readFile(pipelinePath),
    ]);

    const golden = parseGoldenSetWorkbook(goldenBytes);
    const grata = parseGrataData(goldenBytes);
    const pipeline = parsePipeline(pipelineBytes);

    expect(golden.companies).toHaveLength(18);
    expect(grata).toHaveLength(18);

    expect(pipeline.rows.length).toBeGreaterThanOrEqual(240);
    expect(pipeline.rows.length).toBeLessThanOrEqual(250);

    const interfaceRow = pipeline.rows.find((r) => r.contactName === "Cathy Caris");
    expect(interfaceRow?.companyName).toBe("Interface, Inc.");
    expect(interfaceRow?.companyName).not.toBe(interfaceRow?.contactName);

    // sparse priorities 1/2/3 plus nulls
    const priorities = pipeline.rows.map((r) => r.rawPriority);
    expect(priorities.filter((p) => p !== null)).toHaveLength(3);
    expect(new Set(priorities)).toEqual(new Set(["1", "2", "3", null]));

    // serial dates converted to ISO
    const withDate = pipeline.rows.find((r) => r.situationUpdateDate !== null);
    expect(withDate?.situationUpdateDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
