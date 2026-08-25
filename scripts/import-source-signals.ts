import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  closeDatabase,
  getDatabase,
  ingestSourceSignalBatch,
  normalizeCsvHeader,
  parseCsv,
  readWorkbook,
  SOURCE_SIGNAL_BATCH_MAX_ROWS,
  type Database,
  type SourceSignalBatchResult,
  type SourceSignalColumnMapping,
} from "@asi/database";
import * as XLSX from "xlsx";

export const SOURCE_SIGNAL_IMPORT_METADATA_KEY = "__source_signal_import";
const DRY_RUN_DATABASE = new Proxy({} as Database, {
  get(): never {
    throw new Error("Dry-run attempted database access");
  },
});

export interface ImportSourceSignalsOptions {
  readonly file: string;
  readonly sourceKey: string;
  readonly mapping: SourceSignalColumnMapping;
  readonly agentId?: string;
  readonly apply: boolean;
}

export interface LoadedSourceSignalFile {
  readonly format: "csv" | "json" | "xlsx";
  readonly rows: readonly Record<string, unknown>[];
  readonly sourceRows: readonly number[];
  readonly sheet?: string;
}

export interface SourceSignalImportRun {
  readonly result: SourceSignalBatchResult;
  readonly fileSha256: string;
  readonly format: LoadedSourceSignalFile["format"];
  readonly sheet?: string;
  readonly rowErrors: readonly { readonly row: number; readonly error: string }[];
}

export function parseImportSourceSignalArgs(argv: readonly string[]): ImportSourceSignalsOptions {
  let file: string | undefined;
  let sourceKey: string | undefined;
  let agentId: string | undefined;
  let apply = false;
  let modeFlag: "dry-run" | "apply" | undefined;
  const columns: Partial<Record<keyof SourceSignalColumnMapping, string>> = {};
  const columnFlags: Record<string, keyof SourceSignalColumnMapping> = {
    "--name-column": "name",
    "--domain-column": "domain",
    "--city-column": "city",
    "--state-column": "state",
    "--country-column": "country",
    "--uei-column": "uei",
    "--cage-column": "cage",
    "--award-count-column": "awardCount",
    "--award-value-column": "awardValue",
    "--freshest-award-column": "freshestAward",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--apply" || argument === "--dry-run") {
      const nextMode = argument === "--apply" ? "apply" : "dry-run";
      if (modeFlag !== undefined && modeFlag !== nextMode) {
        throw new Error("Choose either --dry-run or --apply, not both");
      }
      modeFlag = nextMode;
      apply = nextMode === "apply";
      continue;
    }

    const equalsAt = argument.indexOf("=");
    const flag = equalsAt === -1 ? argument : argument.slice(0, equalsAt);
    const inlineValue = equalsAt === -1 ? undefined : argument.slice(equalsAt + 1);
    if (flag === "--file" || flag === "--source-key" || flag === "--agent-id") {
      const value = inlineValue ?? argv[index + 1];
      if (value === undefined || value.trim() === "" || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
      }
      if (inlineValue === undefined) index += 1;
      if (flag === "--file") file = value;
      else if (flag === "--source-key") sourceKey = value;
      else agentId = value;
      continue;
    }

    const mappingKey = columnFlags[flag];
    if (mappingKey !== undefined) {
      const value = inlineValue ?? argv[index + 1];
      if (value === undefined || value.trim() === "" || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
      }
      if (inlineValue === undefined) index += 1;
      columns[mappingKey] = value;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  if (file === undefined) throw new Error("Missing required --file");
  if (sourceKey === undefined || sourceKey.trim() === "") {
    throw new Error("Missing required --source-key");
  }
  if (columns.name === undefined) throw new Error("Missing required --name-column");

  return {
    file,
    sourceKey,
    mapping: columns as SourceSignalColumnMapping,
    ...(agentId === undefined ? {} : { agentId }),
    apply,
  };
}

export function loadSourceSignalFile(
  filePath: string,
  bytes: Uint8Array,
): LoadedSourceSignalFile {
  const extension = path.extname(filePath).toLocaleLowerCase("en-US");
  if (extension === ".csv") {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = parseCsv(text);
    assertRowLimit(parsed.rows.length);
    return {
      format: "csv",
      rows: parsed.rows,
      sourceRows: parsed.rows.map((_, index) => index + 2),
    };
  }

  if (extension === ".json") {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error("JSON input must be an array of objects");
    assertRowLimit(parsed.length);
    const rows = parsed.map((value, index) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`JSON row ${index + 1} must be an object`);
      }
      return value as Record<string, unknown>;
    });
    return {
      format: "json",
      rows,
      sourceRows: rows.map((_, index) => index + 1),
    };
  }

  if (extension === ".xlsx" || extension === ".xls" || extension === ".xlsm") {
    const workbook = readWorkbook(bytes, {
      maxSheets: 100,
      sheetRows: SOURCE_SIGNAL_BATCH_MAX_ROWS + 2,
    });
    const sheetName = workbook.SheetNames[0];
    if (sheetName === undefined) throw new Error("Workbook has no sheets");
    const sheet = workbook.Sheets[sheetName];
    if (sheet === undefined) throw new Error(`Workbook sheet ${sheetName} is missing`);
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: null,
      raw: true,
    });
    assertRowLimit(rows.length);
    return {
      format: "xlsx",
      rows,
      sourceRows: rows.map((_, index) => index + 2),
      sheet: sheetName,
    };
  }

  throw new Error("Unsupported input type; expected .csv, .json, .xlsx, .xls, or .xlsm");
}

export async function runSourceSignalImport(
  db: Database,
  options: ImportSourceSignalsOptions,
  now: Date = new Date(),
): Promise<SourceSignalImportRun> {
  const bytes = new Uint8Array(await readFile(options.file));
  const fileSha256 = createHash("sha256").update(bytes).digest("hex");
  const loaded = loadSourceSignalFile(options.file, bytes);
  const mapping = loaded.format === "csv"
    ? normalizeCsvMapping(options.mapping)
    : options.mapping;
  const importedAt = now.toISOString();
  const rows = loaded.rows.map((row, index) => ({
    ...row,
    [SOURCE_SIGNAL_IMPORT_METADATA_KEY]: {
      fileSha256,
      sheet: loaded.sheet ?? null,
      row: loaded.sourceRows[index],
      importedAt,
    },
  }));
  const absoluteFile = path.resolve(options.file);
  const sourceLocator = `${pathToFileURL(absoluteFile).href}#sha256=${fileSha256}`;
  const result = await ingestSourceSignalBatch(db, {
    sourceKey: options.sourceKey,
    sourceLocator,
    rows,
    mapping,
    ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
    dryRun: !options.apply,
  });

  return {
    result,
    fileSha256,
    format: loaded.format,
    ...(loaded.sheet === undefined ? {} : { sheet: loaded.sheet }),
    rowErrors: result.rowErrors.map(({ rowIndex, error }) => ({
      row: loaded.sourceRows[rowIndex] ?? rowIndex + 1,
      error,
    })),
  };
}

function normalizeCsvMapping(
  mapping: SourceSignalColumnMapping,
): SourceSignalColumnMapping {
  const normalized: Partial<Record<keyof SourceSignalColumnMapping, string>> = {};
  for (const [key, value] of Object.entries(mapping) as Array<
    [keyof SourceSignalColumnMapping, string]
  >) {
    normalized[key] = normalizeCsvHeader(value);
  }
  return normalized as SourceSignalColumnMapping;
}

function assertRowLimit(rowCount: number): void {
  if (rowCount > SOURCE_SIGNAL_BATCH_MAX_ROWS) {
    throw new Error(
      `Source signal imports are limited to ${SOURCE_SIGNAL_BATCH_MAX_ROWS.toLocaleString("en-US")} rows; received ${rowCount.toLocaleString("en-US")}`,
    );
  }
}

function printReport(run: SourceSignalImportRun, options: ImportSourceSignalsOptions): void {
  console.log(options.apply ? "mode: APPLY" : "mode: DRY RUN (no database writes)");
  console.log(`file_sha256: ${run.fileSha256}`);
  console.log(
    `format: ${run.format}${run.sheet === undefined ? "" : ` sheet: ${run.sheet}`}`,
  );
  console.log(
    `${options.apply ? "created" : "would_create"}: ${run.result.created} duplicate: ${run.result.duplicate} rejected: ${run.result.rejected}`,
  );
  for (const rowError of run.rowErrors) {
    console.error(`row ${rowError.row}: ${rowError.error}`);
  }
}

async function main(): Promise<void> {
  const options = parseImportSourceSignalArgs(process.argv.slice(2));
  if (!options.apply) {
    const run = await runSourceSignalImport(DRY_RUN_DATABASE, options);
    printReport(run, options);
    return;
  }

  try {
    const run = await runSourceSignalImport(getDatabase(), options);
    printReport(run, options);
  } finally {
    await closeDatabase().catch(() => undefined);
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
