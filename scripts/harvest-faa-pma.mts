import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  closeDatabase,
  getDatabase,
  researchAgents,
  sourceSignalFingerprint,
  sourceSignals,
  upsertHarvestedSourceSignal,
  type Database,
  type HarvestedSourceSignal,
} from "@asi/database";
import type { FaaPmaScrapeQuery, FaaPmaScrapeResult } from "@asi/contracts";
import { eq } from "drizzle-orm";

import { parseFaaAddress } from "../packages/database/src/synthesis/faa.js";
import { FaaDrsBrowserClient } from "../packages/research/src/sources/faa-drs.js";
import { parseScrapeFaaPmaArgs } from "./scrape-faa-pma.js";

export const FAA_PMA_HARVEST_AGENT_KEY = "faa-pma-targeted";
export const FAA_PMA_HARVEST_TIMEOUT_MS = 120_000;

export interface HarvestFaaPmaCliOptions {
  readonly query: FaaPmaScrapeQuery;
  readonly agentKey: string;
  readonly apply: boolean;
  readonly refreshExisting: boolean;
}

export interface FaaPmaHarvestClient {
  search(query: FaaPmaScrapeQuery): Promise<FaaPmaScrapeResult>;
}

export interface HarvestFaaPmaSummary {
  readonly records: number;
  readonly created: number;
  readonly duplicates: number;
  readonly refreshed: number;
}

export interface HarvestFaaPmaDependencies {
  readonly client?: FaaPmaHarvestClient;
  readonly db?: Database;
  readonly now?: () => Date;
  readonly resolveAgentId?: (
    db: Database,
    agentKey: string,
  ) => Promise<string | undefined>;
  readonly upsertSignal?: (
    db: Database,
    input: HarvestedSourceSignal,
  ) => Promise<{ readonly duplicate: boolean }>;
  readonly refreshSignal?: (
    db: Database,
    input: HarvestedSourceSignal,
    updatedAt: Date,
  ) => Promise<boolean>;
}

export function parseHarvestFaaPmaArgs(
  argv: readonly string[],
): HarvestFaaPmaCliOptions {
  const scrapeArguments: string[] = [];
  let agentKey = FAA_PMA_HARVEST_AGENT_KEY;
  let agentKeySupplied = false;
  let mode: "apply" | "dry-run" | undefined;
  let refreshExisting = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--apply" || argument === "--dry-run") {
      const nextMode = argument === "--apply" ? "apply" : "dry-run";
      if (mode !== undefined && mode !== nextMode) {
        throw new Error("Choose either --dry-run or --apply, not both");
      }
      mode = nextMode;
      continue;
    }

    if (argument === "--refresh-existing") {
      if (refreshExisting) {
        throw new Error("--refresh-existing may be supplied only once");
      }
      refreshExisting = true;
      continue;
    }

    const equalsAt = argument.indexOf("=");
    const flag = equalsAt === -1 ? argument : argument.slice(0, equalsAt);
    if (flag === "--agent-key") {
      if (agentKeySupplied) throw new Error("--agent-key may be supplied only once");
      const inlineValue = equalsAt === -1 ? undefined : argument.slice(equalsAt + 1);
      const value = inlineValue ?? argv[index + 1];
      if (value === undefined || value.trim() === "" || value.startsWith("--")) {
        throw new Error("--agent-key requires a value");
      }
      if (inlineValue === undefined) index += 1;
      agentKey = value.trim();
      agentKeySupplied = true;
      continue;
    }

    if (flag === "--output") {
      throw new Error(`Unknown argument: ${argument}`);
    }
    scrapeArguments.push(argument);
  }

  const { query } = parseScrapeFaaPmaArgs(scrapeArguments);
  if (refreshExisting && mode !== "apply") {
    throw new Error("--refresh-existing is valid only with --apply");
  }
  return {
    query,
    agentKey,
    apply: mode === "apply",
    refreshExisting,
  };
}

export async function runFaaPmaHarvest(
  options: HarvestFaaPmaCliOptions,
  dependencies: HarvestFaaPmaDependencies = {},
): Promise<HarvestFaaPmaSummary> {
  const client =
    dependencies.client ??
    new FaaDrsBrowserClient({
      ...(process.env.FAA_DRS_CHROMIUM_PATH === undefined
        ? {}
        : { chromiumPath: process.env.FAA_DRS_CHROMIUM_PATH }),
      navigationTimeoutMs: FAA_PMA_HARVEST_TIMEOUT_MS,
      queryTimeoutMs: FAA_PMA_HARVEST_TIMEOUT_MS,
      maxRetries: 0,
    });
  const result = await client.search(options.query);
  const records = result.records.length;

  if (!options.apply) {
    return { records, created: 0, duplicates: 0, refreshed: 0 };
  }

  const harvestedAtDate = dependencies.now?.() ?? new Date();
  const harvestedAt = harvestedAtDate.toISOString();
  const inputs = result.records.map((record): HarvestedSourceSignal => {
    if (record.holderName === null) {
      throw new Error(`FAA PMA record ${record.recordId} has no holder name`);
    }
    const address =
      record.fullAddress === null ? null : parseFaaAddress(record.fullAddress);
    return {
      sourceKey: "faa_drs_pma",
      sourceLocator: record.guidUrl,
      rawName: record.holderName,
      ...(address?.city === null || address?.city === undefined
        ? {}
        : { city: address.city }),
      ...(address?.region === null || address?.region === undefined
        ? {}
        : { state: address.region }),
      ...(address === null ? {} : { country: address.countryCode }),
      awardCount: 0,
      awardValue: 0,
      sourcePayload: {
        record,
        query: result.query,
        source: result.source,
        manualHarvest: { at: harvestedAt },
      },
    };
  });

  const db = dependencies.db ?? getDatabase();
  const resolveAgentId = dependencies.resolveAgentId ?? findResearchAgentId;
  const agentId = await resolveAgentId(db, options.agentKey);
  const upsertSignal = dependencies.upsertSignal ?? upsertHarvestedSourceSignal;
  const refreshSignal =
    dependencies.refreshSignal ?? refreshExistingFaaPmaSignal;
  let created = 0;
  let duplicates = 0;
  let refreshed = 0;
  for (const input of inputs) {
    const outcome = await upsertSignal(db, {
      ...input,
      ...(agentId === undefined ? {} : { agentId }),
    });
    if (!outcome.duplicate) {
      created += 1;
      continue;
    }
    if (
      options.refreshExisting &&
      (await refreshSignal(db, input, harvestedAtDate))
    ) {
      refreshed += 1;
    } else {
      duplicates += 1;
    }
  }

  return { records, created, duplicates, refreshed };
}

export async function findResearchAgentId(
  db: Database,
  agentKey: string,
): Promise<string | undefined> {
  const rows = await db
    .select({ id: researchAgents.id })
    .from(researchAgents)
    .where(eq(researchAgents.key, agentKey))
    .limit(1);
  return rows[0]?.id;
}

export async function refreshExistingFaaPmaSignal(
  db: Database,
  input: HarvestedSourceSignal,
  updatedAt: Date,
): Promise<boolean> {
  const rows = await db
    .update(sourceSignals)
    .set({
      rawName: input.rawName,
      city: input.city ?? null,
      state: input.state ?? null,
      country: input.country ?? null,
      sourcePayload: input.sourcePayload,
      updatedAt,
    })
    .where(
      eq(
        sourceSignals.sourceFingerprint,
        sourceSignalFingerprint(input),
      ),
    )
    .returning({ id: sourceSignals.id });
  return rows.length > 0;
}

function printSummary(
  options: HarvestFaaPmaCliOptions,
  summary: HarvestFaaPmaSummary,
): void {
  console.log(options.apply ? "mode: APPLY" : "mode: DRY RUN (no database writes)");
  console.log(JSON.stringify(summary));
}

async function main(): Promise<void> {
  const options = parseHarvestFaaPmaArgs(process.argv.slice(2));
  try {
    printSummary(options, await runFaaPmaHarvest(options));
  } finally {
    if (options.apply) await closeDatabase().catch(() => undefined);
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
