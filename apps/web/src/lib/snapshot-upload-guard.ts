/**
 * Snapshot workbook upload hardening (Sec-M4). Pure metadata guard so the
 * checks are unit-testable without Next.js request plumbing.
 */
export const MAX_SNAPSHOT_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_SNAPSHOT_UPLOAD_ROWS = 50_000;

const ALLOWED_UPLOAD_EXTENSIONS: Record<string, true> = {
  ".xlsx": true,
  ".xlsm": true,
};
// Some clients send workbooks as generic binary; the extension check still
// applies. Everything more specific than that must be a spreadsheet MIME.
const ALLOWED_UPLOAD_CONTENT_TYPES: Record<string, true> = {
  // Keys are lowercase; the lookup lowercases the incoming header.
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": true,
  "application/vnd.ms-excel.sheet.macroenabled.12": true,
  "application/octet-stream": true,
  "": true,
};
export type UploadGuardRejection = {
  ok: false;
  status: number;
  // Wire codes come from @asi/contracts apiErrorCodeValues; the HTTP status
  // carries the 413/415 distinction.
  code: "validation_failed";
  message: string;
};
export type UploadGuardResult = { ok: true } | UploadGuardRejection;

/** Guard over the upload metadata; rejects empty, oversized, wrongly typed
 * or wrongly named files before any bytes are buffered or parsed. */
export function validateWorkbookUpload(file: {
  name: string;
  size: number;
  type: string;
}): UploadGuardResult {
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return {
      ok: false,
      status: 400,
      code: "validation_failed",
      message: "Uploaded file is empty",
    };
  }
  if (file.size > MAX_SNAPSHOT_UPLOAD_BYTES) {
    return {
      ok: false,
      status: 413,
      code: "validation_failed",
      message: `Workbook exceeds the ${MAX_SNAPSHOT_UPLOAD_BYTES} byte upload limit`,
    };
  }
  const extension = file.name.includes(".")
    ? file.name.slice(file.name.lastIndexOf(".")).toLowerCase()
    : "";
  if (ALLOWED_UPLOAD_EXTENSIONS[extension] !== true) {
    return {
      ok: false,
      status: 400,
      code: "validation_failed",
      message: "Only .xlsx and .xlsm workbooks are accepted",
    };
  }
  if (ALLOWED_UPLOAD_CONTENT_TYPES[file.type.toLowerCase()] !== true) {
    return {
      ok: false,
      status: 415,
      code: "validation_failed",
      message: `Content type ${file.type} is not an accepted spreadsheet type`,
    };
  }
  return { ok: true };
}
