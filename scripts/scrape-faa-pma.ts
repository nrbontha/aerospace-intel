import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  faaPmaScrapeQuerySchema,
  faaPmaScrapeResultSchema,
  type FaaPmaScrapeQuery,
  type FaaPmaScrapeResult,
} from "@asi/contracts";

import { FaaDrsBrowserClient } from "../packages/research/src/sources/faa-drs.js";

export const FAA_PMA_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_OUTPUT_DIRECTORY = "reports";
const DEFAULT_CACHE_DIRECTORY = ".cache/faa-drs";

const FILTER_FLAGS = {
  "--holder-name": "holderName",
  "--holder-number": "holderNumber",
  "--part-number": "partNumber",
  "--make": "make",
  "--model": "model",
} as const;

type FilterFlag = keyof typeof FILTER_FLAGS;
type QueryFilter = (typeof FILTER_FLAGS)[FilterFlag];

export interface ScrapeFaaPmaCliOptions {
  readonly query: FaaPmaScrapeQuery;
  readonly outputPath?: string;
}

export interface FaaPmaScrapeClient {
  search(query: FaaPmaScrapeQuery): Promise<FaaPmaScrapeResult>;
}

export interface RunFaaPmaScrapeDependencies {
  readonly client?: FaaPmaScrapeClient;
  readonly cacheDirectory?: string;
  readonly now?: () => Date;
}

export interface RunFaaPmaScrapeResult {
  readonly result: FaaPmaScrapeResult;
  readonly outputPath: string;
  readonly cachePath: string;
  readonly cacheHit: boolean;
}

export function parseScrapeFaaPmaArgs(
  argv: readonly string[],
): ScrapeFaaPmaCliOptions {
  const filters: Partial<Record<QueryFilter, string>> = {};
  let limit = 25;
  let outputPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const equalsAt = argument.indexOf("=");
    const flag = (equalsAt === -1
      ? argument
      : argument.slice(0, equalsAt)) as FilterFlag | "--limit" | "--output";
    const inlineValue = equalsAt === -1 ? undefined : argument.slice(equalsAt + 1);
    const queryField = FILTER_FLAGS[flag as FilterFlag];

    if (queryField !== undefined) {
      const value = readFlagValue(flag, inlineValue, argv[index + 1]);
      if (inlineValue === undefined) index += 1;
      if (filters[queryField] !== undefined) {
        throw new Error(`${flag} may be supplied only once`);
      }
      filters[queryField] = value;
      continue;
    }

    if (flag === "--limit") {
      const value = readFlagValue(flag, inlineValue, argv[index + 1]);
      if (inlineValue === undefined) index += 1;
      limit = Number(value);
      if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
        throw new Error("--limit must be an integer from 1 through 25");
      }
      continue;
    }

    if (flag === "--output") {
      outputPath = readFlagValue(flag, inlineValue, argv[index + 1]);
      if (inlineValue === undefined) index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  const selectedFilters = Object.entries(filters).filter(
    (entry): entry is [QueryFilter, string] => entry[1] !== undefined,
  );
  if (selectedFilters.length === 0) {
    throw new Error(
      "One targeted filter is required: --holder-name, --holder-number, --part-number, --make, or --model",
    );
  }
  if (selectedFilters.length > 1) {
    throw new Error("Choose exactly one FAA PMA filter per invocation");
  }

  const [filterName, filterValue] = selectedFilters[0]!;
  const query = faaPmaScrapeQuerySchema.parse({
    [filterName]: filterValue,
    maxRecords: limit,
  });
  return {
    query,
    ...(outputPath === undefined ? {} : { outputPath }),
  };
}

export function faaPmaQueryHash(query: FaaPmaScrapeQuery): string {
  const canonicalQuery = canonicalizeQuery(query);
  return createHash("sha256").update(JSON.stringify(canonicalQuery)).digest("hex");
}

export async function runFaaPmaScrape(
  options: ScrapeFaaPmaCliOptions,
  dependencies: RunFaaPmaScrapeDependencies = {},
): Promise<RunFaaPmaScrapeResult> {
  const query = faaPmaScrapeQuerySchema.parse(options.query);
  const now = dependencies.now?.() ?? new Date();
  const hash = faaPmaQueryHash(query);
  const cacheDirectory = path.resolve(
    dependencies.cacheDirectory ?? DEFAULT_CACHE_DIRECTORY,
  );
  const cachePath = path.join(cacheDirectory, `${hash}.json`);
  const cached = await readFreshCache(cachePath, now);
  const cacheHit = cached !== null;
  const result =
    cached ??
    (await (dependencies.client ?? new FaaDrsBrowserClient()).search(query));

  if (!cacheHit) {
    await writeJsonAtomically(cachePath, {
      cachedAt: now.toISOString(),
      result,
    });
  }

  const outputPath = path.resolve(
    options.outputPath ??
      path.join(DEFAULT_OUTPUT_DIRECTORY, `faa-pma-${hash.slice(0, 12)}.json`),
  );
  await writeJsonAtomically(outputPath, result);
  return { result, outputPath, cachePath, cacheHit };
}

async function readFreshCache(
  cachePath: string,
  now: Date,
): Promise<FaaPmaScrapeResult | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(cachePath, "utf8"));
  } catch (cause) {
    if (isMissingFileError(cause)) return null;
    if (cause instanceof SyntaxError) return null;
    throw cause;
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("cachedAt" in parsed) ||
    typeof parsed.cachedAt !== "string" ||
    !("result" in parsed)
  ) {
    return null;
  }
  const cachedAt = Date.parse(parsed.cachedAt);
  if (
    !Number.isFinite(cachedAt) ||
    now.getTime() - cachedAt < 0 ||
    now.getTime() - cachedAt >= FAA_PMA_CACHE_TTL_MS
  ) {
    return null;
  }
  const result = faaPmaScrapeResultSchema.safeParse(parsed.result);
  return result.success ? result.data : null;
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

function canonicalizeQuery(query: FaaPmaScrapeQuery): Record<string, string | number> {
  const canonical: Record<string, string | number> = {
    maxRecords: query.maxRecords,
  };
  for (const filterName of Object.values(FILTER_FLAGS)) {
    const value = query[filterName];
    if (typeof value === "string") canonical[filterName] = value;
  }
  return canonical;
}

function readFlagValue(
  flag: string,
  inlineValue: string | undefined,
  nextValue: string | undefined,
): string {
  const value = inlineValue ?? nextValue;
  if (value === undefined || value.trim().length === 0 || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value.trim();
}

function isMissingFileError(cause: unknown): boolean {
  return (
    cause !== null &&
    typeof cause === "object" &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
}

async function main(): Promise<void> {
  const options = parseScrapeFaaPmaArgs(process.argv.slice(2));
  const run = await runFaaPmaScrape(options);
  console.log(`FAA PMA records: ${run.result.records.length}`);
  console.log(`source: ${run.cacheHit ? "24h cache" : "live guest browser"}`);
  console.log(`JSON: ${run.outputPath}`);
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
