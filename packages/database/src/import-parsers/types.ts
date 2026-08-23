/**
 * Types for the ADCO workbook import parsers.
 *
 * Parsers are pure: bytes in (ArrayBuffer / Uint8Array), typed plain objects
 * out. No DB, no env, no fs at module level. Values are faithful to the
 * source cells — nothing is invented, coerced, or reordered.
 */

/** A raw spreadsheet cell value as produced by SheetJS with `raw: true`. */
export type Cell = string | number | boolean | null;

/**
 * Convert an Excel serial date to an ISO `YYYY-MM-DD` string.
 * Excel's epoch starts at 1899-12-30 (accounting for the Lotus 1-2-3
 * leap-year bug). Pure: no locale, no clock.
 */
export function excelSerialToIso(serial: number): string {
  const epochUtcMs = Date.UTC(1899, 11, 30);
  return new Date(epochUtcMs + Math.round(serial * 86_400_000))
    .toISOString()
    .slice(0, 10);
}

/** One company row of the 'Golden Set Targets' table. */
export interface GoldenCompanyRow {
  name: string;
  domain: string | null;
  description: string | null;
  /** Headquarter text as written, e.g. "USA - TN". */
  hq: string | null;
  revenueEstimate: number | null;
  ownership: string | null;
  /**
   * Every non-empty cell of the source row keyed verbatim by its header,
   * including unmapped columns (e.g. "Misc. details" on the targets sheet,
   * all 49 Grata columns on the 'Grata Data' sheet).
   */
  grataPayload: Record<string, unknown>;
  /** 1-based worksheet row this company was parsed from. */
  workbookRow: number;
}

export interface DatabaseSourceRow {
  name: string;
  domain: string | null;
  details: string | null;
  workbookRow: number;
}

export interface ParsedGoldenSet {
  criteria: {
    qualifying: string[];
    disqualifying: string[];
    /** Every criteria-block string captured verbatim (incl. line breaks). */
    raw: string[];
  };
  companies: GoldenCompanyRow[];
  sources: DatabaseSourceRow[];
}

/**
 * One row of the 'M&A Pipeline' sheet, mapped positionally.
 *
 * Column indices are fixed by the real layout (24 columns, including a
 * SECOND 'Name' header at index 21 holding a contact first name — distinct
 * from the company name at index 0):
 *
 * | c  | field              |
 * |----|--------------------|
 * | 0  | companyName        |
 * | 1  | category           |
 * | 2  | domain             |
 * | 3  | stage              |
 * | 4  | status             |
 * | 5  | rawPriority        |
 * | 6  | description        |
 * | 7  | revenue            |
 * | 8  | ebitda             |
 * | 9  | ebitdaMargin       |
 * | 10 | employees          |
 * | 11 | situationUpdate    |
 * | 12 | situationUpdateDate|
 * | 13 | nextAction         |
 * | 14 | contactMade        |
 * | 15 | ndaSignedDate      |
 * | 16 | ioiLoi             |
 * | 17 | source             |
 * | 18 | processType        |
 * | 19 | hq                 |
 * | 20 | ownership          |
 * | 21 | contactName        |
 * | 22 | contactTitle       |
 * | 23 | contactEmail       |
 */
export interface PipelineRow {
  workbookRow: number;
  companyName: string;
  category: Cell;
  domain: Cell;
  stage: Cell;
  status: Cell;
  /** Priority cell preserved VERBATIM as text — never coerced to number semantics. */
  rawPriority: string | null;
  description: Cell;
  revenue: number | null;
  ebitda: number | null;
  ebitdaMargin: Cell;
  employees: number | null;
  situationUpdate: Cell;
  /** Excel serial → ISO `YYYY-MM-DD`. */
  situationUpdateDate: string | null;
  nextAction: Cell;
  contactMade: Cell;
  /** Excel serial → ISO `YYYY-MM-DD`. */
  ndaSignedDate: string | null;
  ioiLoi: Cell;
  source: Cell;
  processType: Cell;
  hq: Cell;
  ownership: Cell;
  contactName: Cell;
  contactTitle: Cell;
  contactEmail: Cell;
}

export interface ParsedPipeline {
  /** Header labels verbatim, in sheet order (length 24 for the real sheet). */
  headers: string[];
  rows: PipelineRow[];
}
