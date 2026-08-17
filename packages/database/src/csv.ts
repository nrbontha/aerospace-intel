export const CSV_MAX_BYTES = 5 * 1024 * 1024;
export const CSV_MAX_ROWS = 5_000;

export function normalizeCsvHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function parseCsv(text: string): {
  headers: string[];
  rows: Record<string, string>[];
} {
  const source = text.replace(/^\uFEFF/, "");
  const table: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let index = 0;

  while (index < source.length) {
    const char = source[index]!;
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      index += 1;
      continue;
    }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      field = "";
      if (row.some((cell) => cell.trim() !== "")) table.push(row);
      row = [];
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }

  if (quoted) {
    throw new Error("CSV has an unterminated quoted field");
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell.trim() !== "")) table.push(row);
  }
  if (table.length === 0) {
    return { headers: [], rows: [] };
  }

  const headers = table[0]!.map((header) => normalizeCsvHeader(header));
  if (headers.some((header) => header === "") || new Set(headers).size !== headers.length) {
    throw new Error("CSV headers must be unique and non-empty");
  }

  const rows = table.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    for (const [column, header] of headers.entries()) {
      record[header] = (cells[column] ?? "").trim();
    }
    return record;
  });

  return { headers, rows };
}

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === "string"
        ? value
        : typeof value === "number" || typeof value === "boolean"
          ? String(value)
          : JSON.stringify(value);
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function stringifyCsv(
  headers: readonly string[],
  rows: readonly Record<string, unknown>[],
): string {
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(","));
  }
  return `${lines.join("\n")}\n`;
}
