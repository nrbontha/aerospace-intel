import * as XLSX from "xlsx";
import { findSheet, readRows, readWorkbook, toText } from "./internal.js";
import type { Cell, DatabaseSourceRow } from "./types.js";

/**
 * Parse the 'Database Sources' sheet (header: 'Common Databases' | 'Domain'
 * | 'Misc. details'; 5 rows OASIS/PRI/SAM/USAspending/Boeing IPC in the
 * real workbook).
 */
export function parseDatabaseSources(
  bytes: ArrayBuffer | Uint8Array,
): DatabaseSourceRow[] {
  return parseDatabaseSourcesFromWorkbook(readWorkbook(bytes));
}

export function parseDatabaseSourcesFromWorkbook(wb: XLSX.WorkBook): DatabaseSourceRow[] {
  const ws = findSheet(wb, "Database Sources");
  const rows = readRows(ws);
  const headerIdx = rows.findIndex(
    (row) =>
      row.some((c) => String(c ?? "").trim().toLowerCase() === "common databases") &&
      row.some((c) => String(c ?? "").trim().toLowerCase() === "domain"),
  );
  if (headerIdx === -1) throw new Error("Database Sources header row not found");

  const out: DatabaseSourceRow[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i] as Cell[];
    const name = toText(row[0]);
    if (!name) continue;
    out.push({
      name: name.trim(),
      domain: toText(row[1]),
      details: toText(row[2]),
      workbookRow: i + 1,
    });
  }
  return out;
}
