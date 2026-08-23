import * as XLSX from "xlsx";
import { excelSerialToIso } from "./types.js";
import type { Cell } from "./types.js";

/** Lowercase and strip everything that is not a letter or digit. */
export function normalizeLabel(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Fuzzy-locate a sheet by name (case/spacing/punctuation insensitive).
 * Exact normalized match wins; otherwise the first sheet whose normalized
 * name contains the wanted key.
 */
export function findSheet(wb: XLSX.WorkBook, sheetName: string): XLSX.WorkSheet {
  const wanted = normalizeLabel(sheetName);
  const exact = wb.SheetNames.find((n) => normalizeLabel(n) === wanted);
  const name = exact ?? wb.SheetNames.find((n) => normalizeLabel(n).includes(wanted));
  if (!name) {
    throw new Error(
      `Sheet matching "${sheetName}" not found. Sheets: ${wb.SheetNames.join(", ")}`,
    );
  }
  return wb.Sheets[name] as XLSX.WorkSheet;
}

/** Read all rows as arrays of raw cell values, keeping blank rows. */
export function readRows(ws: XLSX.WorkSheet): Cell[][] {
  return XLSX.utils.sheet_to_json<Cell[]>(ws, {
    header: 1,
    defval: null,
    blankrows: true,
    raw: true,
  });
}

/**
 * Detect a header row: the first row where one cell is exactly "Domain"
 * and another cell contains "Name" ("Company Name" on the targets sheet,
 * plain "Name" on the Grata sheet). Returns a 0-based row index.
 */
export function detectNameDomainHeaderRow(rows: Cell[][]): number {
  const idx = rows.findIndex(
    (row) =>
      row.some((c) => normalizeLabel(c) === "domain") &&
      row.some((c) => normalizeLabel(c).includes("name")),
  );
  if (idx === -1) throw new Error("Header row with 'Name' + 'Domain' not found");
  return idx;
}

/**
 * Detect the pipeline header row: first row whose column 0 is exactly
 * "Name". Returns a 0-based row index.
 */
export function detectPipelineHeaderRow(rows: Cell[][]): number {
  const idx = rows.findIndex((row) => normalizeLabel(row[0]) === "name");
  if (idx === -1) throw new Error("Pipeline header row (column 0 === 'Name') not found");
  return idx;
}

/** Faithful text of a cell; null for empty. Preserves embedded line breaks. */
export function toText(value: Cell | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

/** Strict numeric parse: real numbers pass; numeric strings are coerced; junk → null. */
export function toNumber(value: Cell | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || !/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Date cells in these workbooks are Excel serials → ISO `YYYY-MM-DD`.
 * Values already stored as text are passed through verbatim; anything else
 * (empty, boolean) → null.
 */
export function toDateIso(value: Cell | undefined): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return excelSerialToIso(value);
  if (typeof value === "string" && value.trim() !== "") return value;
  return null;
}

/** Build `{ header -> rawCell }` payload from a data row under a header row. */
export function buildPayload(
  headers: Cell[],
  row: Cell[],
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  headers.forEach((header, i) => {
    if (header === null || header === undefined || header === "") return;
    const value = (row[i] ?? null) as Cell;
    if (value === null) return;
    payload[String(header)] = value;
  });
  return payload;
}

/** Bounded read options. When omitted, `readWorkbook` behaves exactly as
 * before (no dense mode, no row/sheet caps). */
export type WorkbookReadLimits = {
  /** Reject workbooks declaring more than this many sheets. */
  maxSheets?: number;
  /** Cap parsed rows per sheet (SheetJS `sheetRows`); excess rows are
   * dropped by the parser rather than buffered. */
  sheetRows?: number;
};

/** Read workbook bytes with raw (non-date-coerced) cells; input is copied
 * into a plain Uint8Array so pooled Buffers / views never leak through.
 * Pass `limits` to bound parse memory (dense mode + per-sheet row cap +
 * sheet-count check). */
export function readWorkbook(
  bytes: ArrayBuffer | Uint8Array,
  limits?: WorkbookReadLimits,
): XLSX.WorkBook {
  const data = bytes instanceof Uint8Array ? new Uint8Array(bytes) : new Uint8Array(bytes);
  const wb = limits === undefined
    ? XLSX.read(data, { type: "array", cellDates: false })
    : XLSX.read(data, {
        type: "array",
        cellDates: false,
        dense: true,
        ...(limits.sheetRows === undefined ? {} : { sheetRows: limits.sheetRows }),
      });
  if (limits?.maxSheets !== undefined && wb.SheetNames.length > limits.maxSheets) {
    throw new Error(
      `Workbook declares ${wb.SheetNames.length} sheets; at most ${limits.maxSheets} allowed`,
    );
  }
  return wb;
}

/** Bounds-safe cell access: out-of-range reads become null. */
export function cellAt(row: Cell[], index: number): Cell {
  return row[index] ?? null;
}
