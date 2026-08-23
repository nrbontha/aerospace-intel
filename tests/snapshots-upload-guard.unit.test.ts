/**
 * Unit tests for the snapshot upload guards (Sec-M4): pure metadata guard,
 * SheetJS bounded-read limits.
 *   npx vitest run tests/snapshots-upload-guard.unit.test.ts
 */
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";

import { readWorkbook } from "../packages/database/src/import-parsers/internal.js";
import {
  MAX_SNAPSHOT_UPLOAD_BYTES,
  MAX_SNAPSHOT_UPLOAD_ROWS,
  validateWorkbookUpload,
} from "../apps/web/src/lib/snapshot-upload-guard.js";

function xlsxBytes(sheets: Record<string, unknown[][]>): Uint8Array {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  }
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return new Uint8Array(out);
}

describe("validateWorkbookUpload", () => {
  it("accepts a well-formed xlsx upload", () => {
    expect(
      validateWorkbookUpload({
        name: "golden-set.xlsx",
        size: 1024,
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    ).toEqual({ ok: true });
  });

  it("accepts .xlsm and generic binary content type", () => {
    expect(
      validateWorkbookUpload({
        name: "pipeline.xlsm",
        size: 10,
        type: "application/vnd.ms-excel.sheet.macroEnabled.12",
      }),
    ).toEqual({ ok: true });
    expect(
      validateWorkbookUpload({ name: "grata.xlsx", size: 10, type: "application/octet-stream" }),
    ).toEqual({ ok: true });
  });

  it("rejects oversized files with 413 before buffering", () => {
    const result = validateWorkbookUpload({
      name: "huge.xlsx",
      size: MAX_SNAPSHOT_UPLOAD_BYTES + 1,
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    expect(result).toMatchObject({ ok: false, status: 413, code: "validation_failed" });
  });

  it("rejects disallowed extensions regardless of content type", () => {
    for (const name of ["data.csv", "data.zip", "data.xls", "noext"]) {
      expect(
        validateWorkbookUpload({
          name,
          size: 100,
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
      ).toMatchObject({ ok: false, status: 400 });
    }
  });

  it("rejects wrong content types with 415", () => {
    expect(
      validateWorkbookUpload({ name: "data.xlsx", size: 100, type: "text/csv" }),
    ).toMatchObject({ ok: false, status: 415, code: "validation_failed" });
  });

  it("rejects empty uploads", () => {
    expect(
      validateWorkbookUpload({
        name: "empty.xlsx",
        size: 0,
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    ).toMatchObject({ ok: false, status: 400 });
  });
});

describe("readWorkbook bounded-read limits", () => {
  it("defaults to the previous unbounded behavior", () => {
    const wb = readWorkbook(xlsxBytes({ Data: [["Name"], ["A"]] }));
    expect(wb.SheetNames).toEqual(["Data"]);
  });

  it("enforces the sheet cap", () => {
    const bytes = xlsxBytes({
      Alpha: [["x"]],
      Beta: [["y"]],
    });
    expect(() => readWorkbook(bytes, { maxSheets: 1 })).toThrow(/at most 1 allowed/);
    expect(() => readWorkbook(bytes, { maxSheets: 2 })).not.toThrow();
  });

  it("caps parsed rows per sheet via sheetRows", () => {
    const rows: unknown[][] = [["Name"]];
    for (let i = 0; i < MAX_SNAPSHOT_UPLOAD_ROWS + 5; i += 1) rows.push([`row-${i}`]);
    const wb = readWorkbook(xlsxBytes({ Data: rows }), { sheetRows: 10 });
    const ws = wb.Sheets["Data"]!;
    // !ref is clamped to the capped range instead of the full 50k+ rows.
    expect(ws["!ref"]).toBe("A1:A10");
  });
});
