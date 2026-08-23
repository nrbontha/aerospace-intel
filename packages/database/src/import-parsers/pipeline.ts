import * as XLSX from "xlsx";
import {
  cellAt,
  detectPipelineHeaderRow,
  findSheet,
  readRows,
  readWorkbook,
  toDateIso,
  toNumber,
  toText,
} from "./internal.js";
import type { Cell, ParsedPipeline, PipelineRow } from "./types.js";

// Fixed positional columns of the 'M&A Pipeline' sheet (24 columns). The
// header at index 21 is a SECOND 'Name' column holding a contact first
// name — distinct from the company name at index 0.
const COL = {
  companyName: 0,
  category: 1,
  domain: 2,
  stage: 3,
  status: 4,
  priority: 5,
  description: 6,
  revenue: 7,
  ebitda: 8,
  ebitdaMargin: 9,
  employees: 10,
  situationUpdate: 11,
  situationUpdateDate: 12,
  nextAction: 13,
  contactMade: 14,
  ndaSignedDate: 15,
  ioiLoi: 16,
  source: 17,
  processType: 18,
  hq: 19,
  ownership: 20,
  contactName: 21,
  contactTitle: 22,
  contactEmail: 23,
} as const;

/**
 * Parse the 'M&A Pipeline' sheet. Title junk rows precede the header, which
 * is detected dynamically as the first row whose column 0 is exactly
 * 'Name'. Rows map positionally (see `COL`); Priority is preserved verbatim
 * as text, Revenue/EBITDA/Employees are parsed as numbers-or-null, and the
 * two date columns convert Excel serials to ISO `YYYY-MM-DD`.
 */
export function parsePipeline(bytes: ArrayBuffer | Uint8Array): ParsedPipeline {
  return parsePipelineFromWorkbook(readWorkbook(bytes));
}

export function parsePipelineFromWorkbook(wb: XLSX.WorkBook): ParsedPipeline {
  const ws = findSheet(wb, "M&A Pipeline");
  const rows = readRows(ws);
  const headerIdx = detectPipelineHeaderRow(rows);
  const headers = (rows[headerIdx] as Cell[]).map((h) => String(h ?? ""));

  const pipelineRows: PipelineRow[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i] as Cell[];
    const companyName = toText(row[COL.companyName]);
    if (!companyName) continue;
    pipelineRows.push({
      workbookRow: i + 1,
      companyName: companyName.trim(),
      category: cellAt(row, COL.category),
      domain: cellAt(row, COL.domain),
      stage: cellAt(row, COL.stage),
      status: cellAt(row, COL.status),
      rawPriority: toText(row[COL.priority] ?? null),
      description: cellAt(row, COL.description),
      revenue: toNumber(cellAt(row, COL.revenue)),
      ebitda: toNumber(cellAt(row, COL.ebitda)),
      ebitdaMargin: cellAt(row, COL.ebitdaMargin),
      employees: toNumber(cellAt(row, COL.employees)),
      situationUpdate: cellAt(row, COL.situationUpdate),
      situationUpdateDate: toDateIso(cellAt(row, COL.situationUpdateDate)),
      nextAction: cellAt(row, COL.nextAction),
      contactMade: cellAt(row, COL.contactMade),
      ndaSignedDate: toDateIso(cellAt(row, COL.ndaSignedDate)),
      ioiLoi: cellAt(row, COL.ioiLoi),
      source: cellAt(row, COL.source),
      processType: cellAt(row, COL.processType),
      hq: cellAt(row, COL.hq),
      ownership: cellAt(row, COL.ownership),
      contactName: cellAt(row, COL.contactName),
      contactTitle: cellAt(row, COL.contactTitle),
      contactEmail: cellAt(row, COL.contactEmail),
    });
  }
  return { headers, rows: pipelineRows };
}
