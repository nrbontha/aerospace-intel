/**
 * Parse the FAA official PMA bulk Access databases (mdb-export) into
 * deduplicated per-holder quarantined source signals.
 *
 * Both era files (pre-2010 and post-2010) are exported to CSV, streamed row by
 * row, and aggregated into ONE candidate per unique PMA Holder Name
 * (case-insensitive). Each holder becomes a single SourceSignalProposal-shaped
 * row that is inserted in batches of 500 through the shared
 * ingestSourceSignalBatch quarantine pipeline — no leads or companies are
 * touched here.
 *
 * Usage:
 *   npx tsx scripts/parse-faa-pma-database.mts \
 *     [--data-dir /tmp/pma-parse] [--limit N] [--dry-run] [--skip-known]
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";

import {
  closeDatabase,
  companies,
  getDatabase,
  goldenExamples,
  ingestSourceSignalBatch,
  type Database,
} from "@asi/database";
import {
  sourceSignalProposalSchema,
  type SourceSignalProposal,
} from "../packages/research/src/signals/harvester.js";

export const FAA_PMA_DATABASE_SOURCE_KEY = "faa_pma_database";
export const FAA_PMA_SOURCE_LOCATOR =
  "https://drs.faa.gov/browse/PMA/doctypeDetails";
/** Rows per ingestSourceSignalBatch call. */
export const FAA_PMA_BATCH_SIZE = 500;

const ACCDB_TABLE = "PMA";
const ACCDB_EXTENSION = /\.accdb$/i;

/** Raw mdb-export column headers. */
const COLUMN = {
  holder: "PMA Holder Name",
  model: "Model",
  city: "City",
  address: "Address",
  make: "Make",
  country: "Country",
  zip: "Zip",
  supplementDate: "Supplement Date",
  state: "State",
  guid: "guid",
} as const;

export interface FaaPmaParseCliOptions {
  readonly dataDir: string;
  /** Maximum holders to insert; 0 means all. */
  readonly limit: number;
  readonly dryRun: boolean;
  readonly skipKnown: boolean;
}

/** One deduplicated holder observation, aggregated across every PMA record. */
export interface PmaHolderAggregate {
  readonly rawName: string;
  readonly address: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly zip: string | null;
  readonly country: string | null;
  readonly partCount: number;
  readonly makes: readonly string[];
  readonly modelsSample: readonly string[];
  /** ISO calendar date (YYYY-MM-DD) of the newest supplement, if parsable. */
  readonly latestSupplementDate: string | null;
  readonly guidUrl: string | null;
}

export interface FaaPmaParseSummary {
  readonly mode: "apply" | "dry-run";
  readonly files: readonly string[];
  readonly recordsParsed: number;
  readonly recordsWithoutHolderName: number;
  readonly totalUniqueHolders: number;
  readonly skippedKnown: number;
  readonly emitted: number;
  readonly created: number;
  readonly duplicates: number;
  readonly rejected: number;
  readonly errorSamples: readonly string[];
  readonly dryRun: boolean;
}

export interface FaaPmaParseDependencies {
  readonly db?: Database;
  readonly listAccdbFiles?: (dataDir: string) => Promise<string[]>;
  readonly exportCsv?: (accdbPath: string, csvPath: string) => Promise<void>;
  readonly readRows?: typeof readCsvRowsFromFile;
  readonly loadKnownHolderNames?: (
    db: Database,
  ) => Promise<ReadonlySet<string>>;
  readonly ingestBatch?: typeof ingestSourceSignalBatch;
}

// ---------------------------------------------------------------------------
// CSV reading (streaming, quote-safe across chunk boundaries)
// ---------------------------------------------------------------------------

/** Stream mdb-export CSV rows keyed by their original header names. */
export async function* readCsvRowsFromFile(
  csvPath: string,
): AsyncGenerator<Record<string, string>> {
  const stream = createReadStream(csvPath, { encoding: "utf8" });
  let buffer = "";
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let headers: readonly string[] | null = null;

  const emitRow = (): void => {
    cells.push(cell);
    cell = "";
    const rowCells = cells;
    cells = [];
    if (headers === null) {
      headers = rowCells.map((header) => header.trim());
      return;
    }
    if (rowCells.every((value) => value.trim() === "")) return;
    const row: Record<string, string> = {};
    for (const [index, header] of headers.entries()) {
      row[header] = (rowCells[index] ?? "").trim();
    }
    queue.push(row);
  };
  const queue: Record<string, string>[] = [];

  for await (const chunk of stream) {
    buffer += chunk;
    let scanned = 0;
    while (scanned < buffer.length) {
      const char = buffer[scanned]!;
      if (quoted) {
        if (char === '"') {
          if (buffer[scanned + 1] === '"') {
            cell += '"';
            scanned += 2;
            continue;
          }
          quoted = false;
          scanned += 1;
          continue;
        }
        cell += char;
        scanned += 1;
        continue;
      }
      if (char === '"') {
        quoted = true;
        scanned += 1;
        continue;
      }
      if (char === ",") {
        cells.push(cell);
        cell = "";
        scanned += 1;
        continue;
      }
      if (char === "\n" || char === "\r") {
        if (char === "\r" && buffer[scanned + 1] === "\n") scanned += 1;
        scanned += 1;
        emitRow();
        buffer = buffer.slice(scanned);
        scanned = 0;
        while (queue.length > 0) yield queue.shift()!;
        continue;
      }
      cell += char;
      scanned += 1;
    }
    buffer = buffer.slice(scanned);
  }
  if (cell !== "" || cells.length > 0 || quoted) emitRow();
  while (queue.length > 0) yield queue.shift()!;
  if (quoted) throw new Error(`${csvPath}: CSV has an unterminated quoted field`);
  if (headers === null) throw new Error(`${csvPath}: CSV is empty`);
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** Case-insensitive holder identity: trimmed, lowercased, whitespace folded. */
export function normalizeHolderName(name: string): string {
  return name.trim().toLocaleLowerCase("en-US").replace(/\s+/gu, " ");
}

/** Quarantine identity for one holder under one source key. */
export function pmaHolderFingerprint(
  sourceKey: string,
  rawName: string,
): string {
  return createHash("sha256")
    .update(`${sourceKey}:${normalizeHolderName(rawName)}`, "utf8")
    .digest("hex");
}

/** Parse mdb-export MM/DD/YYYY supplement dates to epoch millis. */
export function parseSupplementDateMs(value: string | undefined): number | null {
  const text = (value ?? "").trim();
  if (text === "") return null;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (match !== null) {
    const month = Number(match[1]);
    const day = Number(match[2]);
    if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(Number(match[3]), month, 0)).getUTCDate()) {
      return null;
    }
    const milliseconds = Date.UTC(
      Number(match[3]),
      month - 1,
      day,
    );
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

interface FieldBest {
  date: number;
  value: string;
}

interface HolderState {
  rawName: string;
  address?: FieldBest;
  city?: FieldBest;
  state?: FieldBest;
  zip?: FieldBest;
  country?: FieldBest;
  partCount: number;
  makes: Set<string>;
  models: Set<string>;
  latestDate: number;
  guid: string | null;
}

const MODELS_SAMPLE_MAX = 10;

/**
 * Folds many part-level PMA records into one holder. The richest non-empty
 * address parts win, preferring the most recent supplement date; ties keep the
 * later-processed record. Deterministic for a fixed input order.
 */
export class PmaHolderAggregator {
  private readonly states = new Map<string, HolderState>();
  private recordsWithoutHolderName = 0;
  private recordsParsed = 0;

  add(row: Record<string, string>): void {
    this.recordsParsed += 1;
    const rawName = (row[COLUMN.holder] ?? "").trim();
    if (rawName === "") {
      this.recordsWithoutHolderName += 1;
      return;
    }
    const key = normalizeHolderName(rawName);
    let state = this.states.get(key);
    if (state === undefined) {
      state = {
        rawName,
        partCount: 0,
        makes: new Set<string>(),
        models: new Set<string>(),
        latestDate: Number.NEGATIVE_INFINITY,
        guid: null,
      };
      this.states.set(key, state);
    }
    state.partCount += 1;

    const date = parseSupplementDateMs(row[COLUMN.supplementDate]);
    const effectiveDate = date ?? Number.NEGATIVE_INFINITY;
    // At least as new as everything seen so far: this record speaks for the
    // holder's freshest identity (name casing) and carries the sample URL.
    const freshest = effectiveDate >= state.latestDate;
    if (freshest) {
      state.latestDate = effectiveDate;
      state.rawName = rawName;
    }
    const guid = (row[COLUMN.guid] ?? "").trim();
    if (guid !== "" && (freshest || state.guid === null)) state.guid = guid;
    if (state.models.size < MODELS_SAMPLE_MAX) {
      for (const model of splitList(row[COLUMN.model])) {
        if (state.models.size >= MODELS_SAMPLE_MAX) break;
        state.models.add(model);
      }
    }
    const make = (row[COLUMN.make] ?? "").trim();
    if (make !== "") state.makes.add(make);

    this.keepRichest(state, "address", row[COLUMN.address], effectiveDate);
    this.keepRichest(state, "city", row[COLUMN.city], effectiveDate);
    this.keepRichest(state, "state", row[COLUMN.state], effectiveDate);
    this.keepRichest(state, "zip", row[COLUMN.zip], effectiveDate);
    this.keepRichest(state, "country", row[COLUMN.country], effectiveDate);
  }
  /** Sorted-by-name aggregates; deterministic across runs. */
  finish(): PmaHolderAggregate[] {
    return [...this.states.entries()]
      .sort(([a], [b]) => a.localeCompare(b, "en-US"))
      .map(([, state]): PmaHolderAggregate => {
        const latestIso =
          state.latestDate === Number.NEGATIVE_INFINITY
            ? null
            : new Date(state.latestDate).toISOString().slice(0, 10);
        return {
          rawName: state.rawName,
          address: state.address?.value ?? null,
          city: state.city?.value ?? null,
          state: state.state?.value ?? null,
          zip: state.zip?.value ?? null,
          country: state.country?.value ?? null,
          partCount: state.partCount,
          makes: [...state.makes].sort((a, b) => a.localeCompare(b, "en-US")),
          modelsSample: [...state.models],
          latestSupplementDate: latestIso,
          guidUrl:
            state.guid === null
              ? null
              : `https://drs.faa.gov/browse/excelExternalWindow/${state.guid}`,
        };
      });
  }

  private keepRichest(
    state: HolderState,
    field: "address" | "city" | "state" | "zip" | "country",
    value: string | undefined,
    date: number,
  ): void {
    const text = (value ?? "").trim();
    if (text === "") return;
    const best = state[field];
    if (best === undefined || date >= best.date) {
      state[field] = { date, value: text };
    }
  }

  get stats(): { recordsParsed: number; recordsWithoutHolderName: number } {
    return {
      recordsParsed: this.recordsParsed,
      recordsWithoutHolderName: this.recordsWithoutHolderName,
    };
  }
}

// ---------------------------------------------------------------------------
// Proposals and signal rows
// ---------------------------------------------------------------------------

/** Shape one holder as an unqualified external-source observation. */
export function holderToProposal(
  aggregate: PmaHolderAggregate,
): SourceSignalProposal {
  return sourceSignalProposalSchema.parse({
    sourceKey: FAA_PMA_DATABASE_SOURCE_KEY,
    sourceLocator: FAA_PMA_SOURCE_LOCATOR,
    sourceFingerprint: pmaHolderFingerprint(
      FAA_PMA_DATABASE_SOURCE_KEY,
      aggregate.rawName,
    ),
    rawName: aggregate.rawName,
    ...(aggregate.city === null ? {} : { city: aggregate.city }),
    ...(aggregate.state === null ? {} : { state: aggregate.state }),
    ...(aggregate.country === null ? {} : { country: aggregate.country }),
    awardCount: aggregate.partCount,
    ...(aggregate.latestSupplementDate === null
      ? {}
      : {
          freshestAward: `${aggregate.latestSupplementDate}T00:00:00.000Z`,
        }),
    sourcePayload: {
      ...(aggregate.address === null ? {} : { address: aggregate.address }),
      ...(aggregate.zip === null ? {} : { zip: aggregate.zip }),
      makes: [...aggregate.makes],
      models_sample: [...aggregate.modelsSample],
      ...(aggregate.guidUrl === null ? {} : { guid_url: aggregate.guidUrl }),
    },
  });
}

export const FAA_PMA_SIGNAL_MAPPING = {
  name: "holder_name",
  city: "city",
  state: "state",
  country: "country",
  awardCount: "part_count",
  freshestAward: "latest_supplement_date",
} as const;

/** Flatten a proposal into the row shape consumed by ingestSourceSignalBatch. */
export function proposalToSignalRow(
  proposal: SourceSignalProposal,
): Record<string, unknown> {
  return {
    holder_name: proposal.rawName,
    ...(proposal.city === undefined ? {} : { city: proposal.city }),
    ...(proposal.state === undefined ? {} : { state: proposal.state }),
    ...(proposal.country === undefined ? {} : { country: proposal.country }),
    part_count: proposal.awardCount ?? 0,
    ...(proposal.freshestAward === undefined
      ? {}
      : { latest_supplement_date: proposal.freshestAward }),
    ...proposal.sourcePayload,
    pma_holder_fingerprint: proposal.sourceFingerprint,
  };
}

// ---------------------------------------------------------------------------
// Known-company lookup
// ---------------------------------------------------------------------------

/**
 * Normalized names already present in the warehouse: golden-set examples plus
 * existing companies (legal and display names). PMA bulk rows carry no
 * domains, so matching is by name.
 */
export async function loadKnownHolderNames(
  db: Database,
): Promise<Set<string>> {
  const known = new Set<string>();
  const golden = await db
    .select({ name: goldenExamples.name })
    .from(goldenExamples);
  for (const row of golden) known.add(normalizeHolderName(row.name));
  const organizations = await db
    .select({
      legalName: companies.legalName,
      displayName: companies.displayName,
    })
    .from(companies);
  for (const row of organizations) {
    known.add(normalizeHolderName(row.legalName));
    known.add(normalizeHolderName(row.displayName));
  }
  return known;
}

// ---------------------------------------------------------------------------
// Import orchestration
// ---------------------------------------------------------------------------

async function defaultListAccdbFiles(dataDir: string): Promise<string[]> {
  const entries = await readdir(dataDir);
  return entries
    .filter((entry) => ACCDB_EXTENSION.test(entry))
    .map((entry) => path.join(dataDir, entry))
    .sort();
}

async function defaultExportAccdbCsv(
  accdbPath: string,
  csvPath: string,
): Promise<void> {
  const child = spawn("mdb-export", [accdbPath, ACCDB_TABLE], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  // Attach before piping: the exit event can fire as soon as stdout closes.
  const exited = once(child, "exit");
  try {
    await pipeline(child.stdout, createWriteStream(csvPath));
  } catch (error) {
    child.kill();
    await exited.catch(() => undefined);
    throw new Error(
      `mdb-export failed for ${path.basename(accdbPath)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const [code] = (await exited) as readonly [number | null, string | null];
  if (code !== 0) {
    throw new Error(`mdb-export exited with code ${String(code)} for ${accdbPath}`);
  }
}

export async function runFaaPmaDatabaseImport(
  options: FaaPmaParseCliOptions,
  dependencies: FaaPmaParseDependencies = {},
): Promise<FaaPmaParseSummary> {
  const listAccdbFiles = dependencies.listAccdbFiles ?? defaultListAccdbFiles;
  const exportCsv = dependencies.exportCsv ?? defaultExportAccdbCsv;
  const readRows = dependencies.readRows ?? readCsvRowsFromFile;

  const accdbPaths = await listAccdbFiles(options.dataDir);
  if (accdbPaths.length === 0) {
    throw new Error(`No .accdb files found in ${options.dataDir}`);
  }

  const aggregator = new PmaHolderAggregator();
  const workDirectory = await mkdtemp(path.join(os.tmpdir(), "faa-pma-parse-"));
  try {
    for (const [index, accdbPath] of accdbPaths.entries()) {
      const csvPath = path.join(workDirectory, `pma-${index}.csv`);
      await exportCsv(accdbPath, csvPath);
      for await (const row of readRows(csvPath)) {
        aggregator.add(row);
      }
    }
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }

  const { recordsParsed, recordsWithoutHolderName } = aggregator.stats;
  const allHolders = aggregator.finish();
  let candidates = allHolders;
  let skippedKnown = 0;
  if (options.skipKnown) {
    const db = dependencies.db ?? getDatabase();
    const loadKnown =
      dependencies.loadKnownHolderNames ?? loadKnownHolderNames;
    const knownNames = await loadKnown(db);
    candidates = allHolders.filter(
      (holder) => !knownNames.has(normalizeHolderName(holder.rawName)),
    );
    skippedKnown = allHolders.length - candidates.length;
  }
  if (options.limit > 0) candidates = candidates.slice(0, options.limit);

  const rows = candidates.map((holder) =>
    proposalToSignalRow(holderToProposal(holder)),
  );

  let created = 0;
  let duplicates = 0;
  let rejected = 0;
  const errorSamples: string[] = [];
  if (rows.length > 0) {
    // Dry runs never touch persistence, so a placeholder handle suffices.
    const db =
      dependencies.db ?? (options.dryRun ? ({} as Database) : getDatabase());
    const ingestBatch = dependencies.ingestBatch ?? ingestSourceSignalBatch;
    for (let start = 0; start < rows.length; start += FAA_PMA_BATCH_SIZE) {
      const result = await ingestBatch(db, {
        sourceKey: FAA_PMA_DATABASE_SOURCE_KEY,
        sourceLocator: FAA_PMA_SOURCE_LOCATOR,
        rows: rows.slice(start, start + FAA_PMA_BATCH_SIZE),
        mapping: FAA_PMA_SIGNAL_MAPPING,
        ...(options.dryRun ? { dryRun: true } : {}),
      });
      created += result.created;
      duplicates += result.duplicate;
      rejected += result.rejected;
      for (const rowError of result.rowErrors) {
        if (errorSamples.length < 5) {
          errorSamples.push(`batch row ${rowError.rowIndex}: ${rowError.error}`);
        }
      }
    }
  }

  const summary: FaaPmaParseSummary = {
    mode: options.dryRun ? "dry-run" : "apply",
    files: accdbPaths,
    recordsParsed,
    recordsWithoutHolderName,
    totalUniqueHolders: allHolders.length,
    skippedKnown,
    emitted: rows.length,
    created,
    duplicates,
    rejected,
    errorSamples,
    dryRun: options.dryRun,
  };
  printSummary(summary);
  return summary;
}

function printSummary(summary: FaaPmaParseSummary): void {
  console.log(
    summary.mode === "apply"
      ? "mode: APPLY"
      : "mode: DRY RUN (no database writes)",
  );
  console.log(JSON.stringify(summary, null, 2));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseFaaPmaDatabaseArgs(
  argv: readonly string[],
): FaaPmaParseCliOptions {
  const options: {
    dataDir: string;
    limit: number;
    dryRun: boolean;
    skipKnown: boolean;
  } = {
    dataDir: "/tmp/pma-parse",
    limit: 0,
    dryRun: false,
    skipKnown: false,
  };
  const value = (flag: string, index: number): string => {
    const next = argv[index];
    if (next === undefined) throw new Error(`${flag} requires a value`);
    return next;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    switch (arg) {
      case "--data-dir":
        options.dataDir = value(arg, index + 1);
        index += 1;
        break;
      case "--limit": {
        const parsed = Number(value(arg, index + 1));
        if (!Number.isInteger(parsed) || parsed < 0) {
          throw new Error("--limit must be a non-negative integer");
        }
        options.limit = parsed;
        index += 1;
        break;
      }
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--skip-known":
        options.skipKnown = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseFaaPmaDatabaseArgs(process.argv.slice(2));
  try {
    await runFaaPmaDatabaseImport(options);
  } finally {
    if (!options.dryRun || options.skipKnown) {
      await closeDatabase().catch(() => undefined);
    }
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url ===
    (await import("node:url")).pathToFileURL(path.resolve(invokedPath)).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
