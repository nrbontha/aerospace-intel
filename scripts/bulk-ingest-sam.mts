import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  closeDatabase,
  getDatabase,
  ingestSourceSignalBatch,
  type Database,
} from "@asi/database";
import { z } from "zod";

import {
  SamEntityClient,
  SamQuotaExceededError,
  isSamEntityActive,
  isSamEntityExcluded,
  isSamEntityUnitedStates,
  type SamEntity,
} from "../packages/research/src/sources/sam.js";
import { AEROSPACE_NAICS } from "../packages/research/src/sources/usaspending.js";
import {
  SAM_ENTITY_SOURCE_KEY,
  fingerprintSamEntity,
} from "../packages/research/src/signals/sam-harvester.js";

export const SAM_INGEST_STATE_PATH = "./exports/sam-ingest-state.json";
export const SAM_PAGE_SIZE = 10;

export interface SamBulkIngestOptions {
  readonly naicsCodes: readonly string[];
  /** Zero means no cap. */
  readonly limit: number;
  readonly dryRun: boolean;
  readonly resume: boolean;
}

export interface SamNaicsIngestMetrics {
  readonly fetched: number;
  readonly filtered: number;
  readonly inserted: number;
  readonly duplicates: number;
}

export interface SamBulkIngestSummary {
  readonly byNaics: Readonly<Record<string, SamNaicsIngestMetrics>>;
  readonly quotaExceeded: boolean;
}

interface SamIngestState {
  readonly version: 1;
  readonly naics: Record<string, SamNaicsCursor>;
}

interface SamNaicsCursor {
  /** Zero-based result offset for the next request. */
  cursor: number;
  complete: boolean;
}

const samNaicsCursorSchema = z
  .object({
    cursor: z.number().int().nonnegative(),
    complete: z.boolean(),
  })
  .strict();

const samIngestStateSchema = z
  .object({
    version: z.literal(1),
    naics: z.record(z.string(), samNaicsCursorSchema),
  })
  .strict();

/** Parse the deliberately small CLI surface so accidental broad discovery is impossible. */
export function parseSamBulkIngestArgs(
  argv: readonly string[],
): SamBulkIngestOptions {
  let naicsCodes = [...AEROSPACE_NAICS];
  let limit = 0;
  let dryRun = false;
  let resume = false;
  let naicsSupplied = false;
  let limitSupplied = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const equalsAt = argument.indexOf("=");
    const flag = equalsAt === -1 ? argument : argument.slice(0, equalsAt);
    const inlineValue =
      equalsAt === -1 ? undefined : argument.slice(equalsAt + 1);

    if (flag === "--dry-run") {
      if (inlineValue !== undefined || dryRun) {
        throw new Error(
          "--dry-run may be supplied only once and takes no value",
        );
      }
      dryRun = true;
      continue;
    }
    if (flag === "--resume") {
      if (inlineValue !== undefined || resume) {
        throw new Error(
          "--resume may be supplied only once and takes no value",
        );
      }
      resume = true;
      continue;
    }
    if (flag !== "--naics" && flag !== "--limit") {
      throw new Error(`Unknown argument: ${argument}`);
    }
    if (
      (flag === "--naics" && naicsSupplied) ||
      (flag === "--limit" && limitSupplied)
    ) {
      throw new Error(`${flag} may be supplied only once`);
    }

    const value = inlineValue ?? argv[index + 1];
    if (value === undefined || value.trim() === "" || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    if (inlineValue === undefined) index += 1;

    if (flag === "--naics") {
      const parsed = value
        .split(",")
        .map((code) => code.trim())
        .filter((code) => code !== "");
      if (
        parsed.length === 0 ||
        parsed.some((code) => !/^\d{6}$/u.test(code)) ||
        new Set(parsed).size !== parsed.length
      ) {
        throw new Error(
          "--naics must be a comma-separated list of unique six-digit codes",
        );
      }
      naicsCodes = parsed;
      naicsSupplied = true;
      continue;
    }

    if (!/^\d+$/u.test(value.trim())) {
      throw new Error("--limit must be a non-negative integer");
    }
    const parsedLimit = Number(value);
    if (!Number.isSafeInteger(parsedLimit)) {
      throw new Error("--limit must be a safe non-negative integer");
    }
    limit = parsedLimit;
    limitSupplied = true;
  }

  return { naicsCodes, limit, dryRun, resume };
}

/**
 * Harvest every requested SAM result page while retaining the normal client’s
 * request validation, normalization, timeout, and quota handling. The client
 * normally begins at page zero; this adapter shifts each of those requests to
 * the persisted result offset.
 */
export async function runSamBulkIngest(
  options: SamBulkIngestOptions,
  dependencies: {
    readonly db?: Database;
    readonly statePath?: string;
  } = {},
): Promise<SamBulkIngestSummary> {
  const apiKey = process.env.SAM_API_KEY?.trim();
  if (apiKey === undefined || apiKey === "" || /[\r\n]/u.test(apiKey)) {
    throw new Error("SAM_API_KEY is required for SAM bulk ingestion");
  }

  const statePath = dependencies.statePath ?? SAM_INGEST_STATE_PATH;
  const state = options.resume
    ? await readSamIngestState(statePath)
    : emptyState();
  const byNaics: Record<string, SamNaicsIngestMetrics> = {};
  const seenUeis = new Set<string>();
  let queued = 0;
  let db = dependencies.db;
  let activeNaics: string | undefined;

  try {
    for (const naicsCode of options.naicsCodes) {
      activeNaics = naicsCode;

      const metrics = {
        fetched: 0,
        filtered: 0,
        inserted: 0,
        duplicates: 0,
      };
      byNaics[naicsCode] = metrics;
      const cursor = state.naics[naicsCode] ?? { cursor: 0, complete: false };
      state.naics[naicsCode] = cursor;

      while (
        !cursor.complete &&
        (options.limit === 0 || queued < options.limit)
      ) {
        const remaining =
          options.limit === 0 ? undefined : options.limit - queued;
        const pageSize = pageSizeFor(cursor.cursor, remaining);
        const fetch = offsetSamFetch(cursor.cursor, pageSize);
        const client = new SamEntityClient({
          apiKey,
          maxPages: 1,
          pageSize,
          fetchImpl: fetch.fetchImpl,
        });
        const result = await client.search({
          naicsCodes: [naicsCode],
          maxResults: pageSize,
        });

        cursor.cursor = fetch.nextCursor();
        if (cursor.cursor >= result.totalRecords) cursor.complete = true;
        metrics.fetched += result.entities.length;

        const accepted: SamEntity[] = [];
        for (const entity of result.entities) {
          if (
            !isSamEntityActive(entity) ||
            !isSamEntityUnitedStates(entity) ||
            isSamEntityExcluded(entity)
          ) {
            metrics.filtered += 1;
            continue;
          }

          const fingerprint = fingerprintSamEntity(entity.uei);
          if (seenUeis.has(fingerprint)) {
            metrics.duplicates += 1;
            continue;
          }
          seenUeis.add(fingerprint);
          accepted.push(entity);
        }

        queued += accepted.length;
        if (accepted.length > 0 && options.dryRun) {
          metrics.inserted += accepted.length;
        } else if (accepted.length > 0) {
          db ??= getDatabase();
          const ingested = await ingestSourceSignalBatch(db, {
            sourceKey: SAM_ENTITY_SOURCE_KEY,
            sourceLocator: "sam://entity-information/v4/entities",
            rows: accepted.map(sourceSignalRow),
            mapping: {
              name: "name",
              domain: "domain",
              city: "city",
              state: "state",
              country: "country",
              uei: "uei",
              cage: "cage",
            },
          });
          metrics.inserted += ingested.created;
          metrics.duplicates += ingested.duplicate;
          metrics.filtered += ingested.rejected;
        }

        if (options.resume && !options.dryRun)
          await writeSamIngestState(statePath, state);
      }

      printNaicsMetrics(naicsCode, metrics);
      activeNaics = undefined;
    }
  } catch (error) {
    if (!(error instanceof SamQuotaExceededError)) throw error;
    if (options.resume && !options.dryRun)
      await writeSamIngestState(statePath, state);
    if (activeNaics !== undefined) {
      printNaicsMetrics(activeNaics, byNaics[activeNaics]!);
    }
    const saved =
      options.resume && !options.dryRun
        ? ` Progress was saved to ${statePath}.`
        : "";
    console.error(
      `SAM.gov quota exhausted; retry after ${error.resetAt.toISOString()} with --resume.${saved}`,
    );
    return { byNaics, quotaExceeded: true };
  }

  return { byNaics, quotaExceeded: false };
}

function pageSizeFor(cursor: number, remaining: number | undefined): number {
  if (remaining === undefined) return SAM_PAGE_SIZE;
  const maximum = Math.min(SAM_PAGE_SIZE, remaining);
  for (let pageSize = maximum; pageSize >= 1; pageSize -= 1) {
    if (cursor % pageSize === 0) return pageSize;
  }
  return 1;
}

function offsetSamFetch(
  cursor: number,
  pageSize: number,
): { readonly fetchImpl: typeof fetch; readonly nextCursor: () => number } {
  let requestedPages = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const originalUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const url = new URL(originalUrl);
    const requestedPage = Number(url.searchParams.get("page") ?? "0");
    if (!Number.isSafeInteger(requestedPage) || requestedPage < 0) {
      throw new Error("SAM client requested an invalid page cursor");
    }
    url.searchParams.set("page", String(cursor / pageSize + requestedPage));
    requestedPages = Math.max(requestedPages, requestedPage + 1);
    return fetch(url, init);
  };
  return {
    fetchImpl,
    nextCursor: () => cursor + requestedPages * pageSize,
  };
}

function sourceSignalRow(entity: SamEntity): Record<string, unknown> {
  return {
    name: entity.legalName,
    domain: entity.officialDomain,
    city: entity.city,
    state: entity.state,
    country: entity.country,
    uei: entity.uei,
    cage: entity.cageCode,
    sourceLocator: entity.sourceLocator,
    matchedNaicsCodes: entity.matchedNaicsCodes,
    rawEntity: entity.raw,
  };
}

function emptyState(): SamIngestState {
  return { version: 1, naics: {} };
}

async function readSamIngestState(statePath: string): Promise<SamIngestState> {
  try {
    const parsed = samIngestStateSchema.safeParse(
      JSON.parse(await readFile(statePath, "utf8")),
    );
    if (!parsed.success) {
      throw new Error("state file must contain version 1 and NAICS cursors");
    }
    return parsed.data;
  } catch (error) {
    if (isMissingFile(error)) return emptyState();
    throw new Error(
      `Unable to read SAM ingest state at ${statePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function writeSamIngestState(
  statePath: string,
  state: SamIngestState,
): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporaryPath, statePath);
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function printNaicsMetrics(
  naicsCode: string,
  metrics: SamNaicsIngestMetrics,
): void {
  console.log(
    `${naicsCode}: fetched=${metrics.fetched} filtered=${metrics.filtered} inserted=${metrics.inserted} duplicates=${metrics.duplicates}`,
  );
}

async function main(): Promise<void> {
  const options = parseSamBulkIngestArgs(process.argv.slice(2));
  try {
    await runSamBulkIngest(options);
  } finally {
    await closeDatabase();
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
