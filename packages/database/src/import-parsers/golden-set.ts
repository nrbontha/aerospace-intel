import * as XLSX from "xlsx";
import {
  buildPayload,
  detectNameDomainHeaderRow,
  findSheet,
  readRows,
  readWorkbook,
  toNumber,
  toText,
} from "./internal.js";
import type { Cell, GoldenCompanyRow, ParsedGoldenSet } from "./types.js";
import { parseDatabaseSourcesFromWorkbook } from "./database-sources.js";

export interface GoldenSetCriteria {
  qualifying: string[];
  disqualifying: string[];
  raw: string[];
}

/**
 * Parse the 'Golden Set Targets' sheet.
 *
 * Layout: a criteria text block first (qualifying parameters, then the
 * disqualifying sub-block), then a company table whose header row contains
 * 'Company Name' and 'Domain'. Criteria strings are captured verbatim,
 * including embedded line breaks; block-title rows (e.g. "Qualifying
 * parameters", "Diqsualifying parameters") end up in `raw` only.
 */
export function parseGoldenSetTargets(bytes: ArrayBuffer | Uint8Array): {
  criteria: GoldenSetCriteria;
  companies: GoldenCompanyRow[];
} {
  const wb = readWorkbook(bytes);
  return parseGoldenSetTargetsFromWorkbook(wb);
}

export function parseGoldenSetTargetsFromWorkbook(wb: XLSX.WorkBook): {
  criteria: GoldenSetCriteria;
  companies: GoldenCompanyRow[];
} {
  const ws = findSheet(wb, "Golden Set Targets");
  const rows = readRows(ws);
  const headerIdx = detectNameDomainHeaderRow(rows);
  const headers = rows[headerIdx] as Cell[];

  const criteria = extractCriteria(rows.slice(0, headerIdx));

  const companies: GoldenCompanyRow[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i] as Cell[];
    const name = toText(row[0]);
    if (!name) continue;
    companies.push({
      name: name.trim(),
      domain: toText(row[1]),
      description: toText(row[2]),
      hq: toText(row[3]),
      revenueEstimate: toNumber(row[4]),
      ownership: toText(row[5]),
      grataPayload: buildPayload(headers, row),
      workbookRow: i + 1,
    });
  }

  return { criteria, companies };
}

/** Parse all three sheets of the golden-set workbook into one result. */
export function parseGoldenSetWorkbook(
  bytes: ArrayBuffer | Uint8Array,
): ParsedGoldenSet {
  const wb = readWorkbook(bytes);
  const { criteria, companies } = parseGoldenSetTargetsFromWorkbook(wb);
  return {
    criteria,
    companies,
    sources: parseDatabaseSourcesFromWorkbook(wb),
  };
}

function extractCriteria(blockRows: Cell[][]): GoldenSetCriteria {
  const qualifying: string[] = [];
  const disqualifying: string[] = [];
  const raw: string[] = [];
  // "Qualifying parameters" / "Diqsualifying parameters" (sic) — both are
  // short single-cell title lines ending in "parameters".
  const isBlockTitle = (text: string) =>
    /^.{0,40}parameters\.?\s*$/i.test(text.trim());

  let mode: "none" | "qualifying" | "disqualifying" = "none";
  for (const row of blockRows) {
    const text = toText(row[0]);
    if (!text) continue;
    raw.push(text);
    if (isBlockTitle(text)) {
      mode = mode === "none" ? "qualifying" : "disqualifying";
      continue;
    }
    if (mode === "qualifying") qualifying.push(text);
    else if (mode === "disqualifying") disqualifying.push(text);
  }
  return { qualifying, disqualifying, raw };
}
