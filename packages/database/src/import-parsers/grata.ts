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
import type { Cell, GoldenCompanyRow } from "./types.js";

/**
 * Parse the 'Grata Data' sheet (real layout: range B2:AX20 — 49 named
 * columns starting 'Grata Link', 'Company Id', 'Domain', 'Name', …).
 * Every non-empty column is preserved in `grataPayload` keyed verbatim by
 * its header; well-known columns are additionally surfaced as typed fields.
 * Returns one row per company data row (18 in the real workbook).
 */
export function parseGrataData(bytes: ArrayBuffer | Uint8Array): GoldenCompanyRow[] {
  return parseGrataDataFromWorkbook(readWorkbook(bytes));
}

export function parseGrataDataFromWorkbook(wb: XLSX.WorkBook): GoldenCompanyRow[] {
  const ws = findSheet(wb, "Grata Data");
  const rows = readRows(ws);
  const headerIdx = detectNameDomainHeaderRow(rows);
  const headers = rows[headerIdx] as Cell[];

  const colIndex = (label: string): number =>
    headers.findIndex((h) => String(h ?? "").trim().toLowerCase() === label);

  const iName = colIndex("name");
  const iDomain = colIndex("domain");
  const iDescription = colIndex("description");
  const iRevenue = colIndex("revenue estimate");
  const iOwnership = colIndex("ownership");

  const out: GoldenCompanyRow[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i] as Cell[];
    const name = iName >= 0 ? toText(row[iName] ?? null) : null;
    if (!name) continue;
    out.push({
      name: name.trim(),
      domain: iDomain >= 0 ? toText(row[iDomain] ?? null) : null,
      description: iDescription >= 0 ? toText(row[iDescription] ?? null) : null,
      hq: null,
      revenueEstimate: iRevenue >= 0 ? toNumber(row[iRevenue] ?? null) : null,
      ownership: iOwnership >= 0 ? toText(row[iOwnership] ?? null) : null,
      grataPayload: buildPayload(headers, row),
      workbookRow: i + 1,
    });
  }
  return out;
}
