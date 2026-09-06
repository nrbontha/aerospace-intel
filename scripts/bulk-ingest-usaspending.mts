import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import {
  closeDatabase,
  getDatabase,
  upsertHarvestedSourceSignal,
  type Database,
  type HarvestedSourceSignal,
} from "@asi/database";
import {
  AEROSPACE_NAICS,
  monthWindows,
  USASPENDING_API_MAX_PAGE,
  UsaspendingClient,
  type SourceQualification,
  type UsaspendingLeadCandidate,
} from "@asi/research";

const DEFAULT_STATE_FILE = "./exports/usaspending-ingest-state.json";
const DEFAULT_PAGE_SIZE = 100;

export interface BulkIngestUsaspendingOptions {
  readonly from: string;
  readonly to: string;
  /** Maximum qualified recipients to attempt across the whole run; zero means all. */
  readonly limit: number;
  readonly dryRun: boolean;
  readonly pageSize: number;
  readonly resume: boolean;
  readonly stateFile: string;
}

export interface UsaspendingIngestMonthSummary {
  readonly month: string;
  /** Award rows examined by the source client's strict qualification gate. */
  readonly fetched: number;
  /** Unique recipients that passed strict qualification before the CLI limit. */
  readonly filtered: number;
  readonly inserted: number;
  readonly duplicates: number;
  readonly limited: number;
  readonly skipped: boolean;
}

export interface UsaspendingIngestSummary {
  readonly months: readonly UsaspendingIngestMonthSummary[];
  readonly fetched: number;
  readonly filtered: number;
  readonly inserted: number;
  readonly duplicates: number;
  readonly limited: number;
}

const completedMonthStateSchema = z.object({
  fetched: z.number().int().nonnegative(),
  filtered: z.number().int().nonnegative(),
  inserted: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  completedAt: z.string(),
});

const ingestStateSchema = z.object({
  version: z.literal(1),
  completedMonths: z.record(
    z.string().regex(/^\d{4}-\d{2}$/u),
    completedMonthStateSchema,
  ),
  inProgress: z
    .object({
      month: z.string().regex(/^\d{4}-\d{2}$/u),
      startPage: z.number().int().positive(),
      cursor: z
        .object({ sortValue: z.string(), uniqueId: z.number() })
        .nullable(),
      updatedAt: z.string(),
    })
    .nullable()
    .default(null),
});

/** Parse the bulk-ingestion CLI. --limit applies across the selected months. */
export function parseBulkIngestUsaspendingArgs(
  argv: readonly string[],
  now: Date = new Date(),
): BulkIngestUsaspendingOptions {
  const defaults = defaultMonthRange(now);
  let from = defaults.from;
  let to = defaults.to;
  let limit = 0;
  let pageSize = DEFAULT_PAGE_SIZE;
  let dryRun = false;
  let resume = false;
  const supplied = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--dry-run" || argument === "--resume") {
      if (supplied.has(argument))
        throw new Error(`${argument} may be supplied only once`);
      supplied.add(argument);
      if (argument === "--dry-run") dryRun = true;
      else resume = true;
      continue;
    }

    const equalsAt = argument.indexOf("=");
    const flag = equalsAt === -1 ? argument : argument.slice(0, equalsAt);
    if (
      flag !== "--from" &&
      flag !== "--to" &&
      flag !== "--limit" &&
      flag !== "--page-size"
    ) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    if (supplied.has(flag))
      throw new Error(`${flag} may be supplied only once`);
    supplied.add(flag);
    const inlineValue =
      equalsAt === -1 ? undefined : argument.slice(equalsAt + 1);
    const value = inlineValue ?? argv[index + 1];
    if (value === undefined || value.trim() === "" || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    if (inlineValue === undefined) index += 1;

    if (flag === "--from") {
      from = parseMonth(value, "--from");
    } else if (flag === "--to") {
      to = parseMonth(value, "--to");
    } else if (flag === "--limit") {
      limit = parseInteger(value, "--limit", 0, Number.MAX_SAFE_INTEGER);
    } else {
      pageSize = parseInteger(value, "--page-size", 1, DEFAULT_PAGE_SIZE);
    }
  }

  if (from > to) throw new Error("--from must not be after --to");
  return {
    from,
    to,
    limit,
    dryRun,
    pageSize,
    resume,
    stateFile: DEFAULT_STATE_FILE,
  };
}

/** Fetch every API page for each requested month, then queue quarantined signals. */
export async function runBulkIngestUsaspending(
  options: BulkIngestUsaspendingOptions,
  db?: Database,
): Promise<UsaspendingIngestSummary> {
  if (!options.dryRun && db === undefined) {
    throw new Error("A database is required unless --dry-run is used");
  }

  const state = options.dryRun
    ? emptyState()
    : await readState(options.stateFile);
  const client = new UsaspendingClient({
    // Single-page calls: the month loop below owns traversal via
    // nextPage/cursor (the client would otherwise walk maxPages itself).
    maxPages: 1,
    pageSize: options.pageSize,
  });
  const windows = monthWindows(
    `${options.from}-01`,
    `${options.to}-${lastDayOfMonth(options.to)}`,
  );
  const summaries: UsaspendingIngestMonthSummary[] = [];
  let remaining =
    options.limit === 0 ? Number.POSITIVE_INFINITY : options.limit;

  for (const window of windows) {
    const month = window.startDate.slice(0, 7);
    const completed = state.completedMonths[month];
    if (options.resume && completed !== undefined) {
      const summary: UsaspendingIngestMonthSummary = {
        month,
        fetched: completed.fetched,
        filtered: completed.filtered,
        inserted: completed.inserted,
        duplicates: completed.duplicates,
        limited: 0,
        skipped: true,
      };
      printMonthSummary(summary, options.dryRun);
      summaries.push(summary);
      continue;
    }

    const resumeFrom =
      options.resume &&
      !options.dryRun &&
      state.inProgress?.month === month
        ? {
            startPage: state.inProgress.startPage,
            cursor: state.inProgress.cursor,
          }
        : null;
    if (resumeFrom !== null) {
      console.log(
        `month=${month} resuming at page=${resumeFrom.startPage}`,
      );
    }
    const fetched = await fetchMonth(
      client,
      window,
      month,
      remaining,
      resumeFrom,
      async (progress) => {
        if (options.dryRun) return;
        state.inProgress = {
          month,
          startPage: progress.startPage,
          cursor: progress.cursor,
          updatedAt: new Date().toISOString(),
        };
        await writeState(options.stateFile, state);
      },
    );
    const filtered = fetched.recipients.length;
    const selected = fetched.recipients.slice(0, remaining);
    const limited = filtered - selected.length;
    let inserted = 0;
    let duplicates = 0;

    if (!options.dryRun) {
      const outcome = await ingestRecipients(db!, selected, month);
      inserted = outcome.inserted;
      duplicates = outcome.duplicates;
    }
    remaining -= selected.length;

    const summary: UsaspendingIngestMonthSummary = {
      month,
      fetched: fetched.rowCount,
      filtered,
      inserted,
      duplicates,
      limited,
      skipped: false,
    };
    printMonthSummary(summary, options.dryRun);
    summaries.push(summary);

    // A limited month was only partially ingested, so a later --resume must
    // query it again. Dry runs deliberately never create or advance state.
    if (!options.dryRun && limited === 0) {
      state.completedMonths[month] = {
        fetched: summary.fetched,
        filtered: summary.filtered,
        inserted: summary.inserted,
        duplicates: summary.duplicates,
        completedAt: new Date().toISOString(),
      };
      state.inProgress = null;
      await writeState(options.stateFile, state);
    }
  }

  return summaries.reduce<UsaspendingIngestSummary>(
    (total, summary) => ({
      months: [...total.months, summary],
      fetched: total.fetched + (summary.skipped ? 0 : summary.fetched),
      filtered: total.filtered + (summary.skipped ? 0 : summary.filtered),
      inserted: total.inserted + (summary.skipped ? 0 : summary.inserted),
      duplicates: total.duplicates + (summary.skipped ? 0 : summary.duplicates),
      limited: total.limited + summary.limited,
    }),
    {
      months: [],
      fetched: 0,
      filtered: 0,
      inserted: 0,
      duplicates: 0,
      limited: 0,
    },
  );
}

async function fetchMonthPageWithRetry(
  client: UsaspendingClient,
  args: {
    readonly naicsCodes: readonly string[];
    readonly timePeriod: { readonly startDate: string; readonly endDate: string };
    readonly startPage: number;
    readonly cursor: { readonly sortValue: string; readonly uniqueId: number } | null;
  },
): Promise<Awaited<ReturnType<UsaspendingClient["searchRecipientsPage"]>>> {
  let delayMs = 2000;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await client.searchRecipientsPage(args);
    } catch (error) {
      if (attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(30_000, delayMs * 2);
    }
  }
}

async function fetchMonth(
  client: UsaspendingClient,
  timePeriod: { readonly startDate: string; readonly endDate: string },
  month: string,
  collectCap: number,
  resumeFrom: {
    readonly startPage: number;
    readonly cursor: { readonly sortValue: string; readonly uniqueId: number } | null;
  } | null,
  onProgress: (
    progress: {
      readonly startPage: number;
      readonly cursor: { readonly sortValue: string; readonly uniqueId: number } | null;
    },
  ) => Promise<void>,
): Promise<{
  readonly rowCount: number;
  readonly recipients: UsaspendingLeadCandidate[];
}> {
  const recipients = new Map<string, UsaspendingLeadCandidate>();
  let rowCount = 0;
  let startPage = resumeFrom?.startPage ?? 1;
  let cursor = resumeFrom?.cursor ?? null;
  let pages = 0;

  while (true) {
    // UsaspendingClient owns response rowSchema parsing and the strict NAICS /
    // excluded-service qualification gate before any candidate reaches here.
    const page = await fetchMonthPageWithRetry(client, {
      naicsCodes: AEROSPACE_NAICS,
      timePeriod,
      startPage,
      cursor,
    });
    pages += 1;
    rowCount += page.qualificationFindings.qualified;
    rowCount += Object.values(page.qualificationFindings.rejected).reduce(
      (total, count) => total + count,
      0,
    );
    for (const recipient of page.leads) {
      const key = recipientKey(recipient);
      const existing = recipients.get(key);
      recipients.set(
        key,
        existing === undefined
          ? recipient
          : mergeRecipient(existing, recipient),
      );
    }
    if (pages % 25 === 0) {
      console.log(
        `month=${month} pages=${pages} rows=${rowCount} recipients=${recipients.size}`,
      );
    }
    // Stop early once enough unique recipients are banked for --limit runs.
    if (recipients.size >= collectCap) break;
    if (page.nextPage === null) break;
    startPage = page.nextPage;
    cursor = page.cursor;
    // Checkpoint traversal so --resume survives mid-month failures; inserts
    // stay idempotent via fingerprint upserts, so re-walked pages just merge.
    if (pages % 25 === 0) {
      await onProgress({ startPage, cursor });
    }
  }

  return { rowCount, recipients: [...recipients.values()] };
}
): UsaspendingLeadCandidate {
  const naics = uniqueStrings(left.naics, right.naics);
  const pscCodes = uniqueStrings(left.pscCodes, right.pscCodes);
  const useRightQualification =
    left.sourceQualification.evidenceStrength === "request_filter_only" &&
    right.sourceQualification.evidenceStrength === "returned_strict_naics";
  const qualification = useRightQualification
    ? right.sourceQualification
    : left.sourceQualification;
  const freshestAwardDate = newerDate(
    left.freshestAwardDate,
    right.freshestAwardDate,
  );

  return {
    ...left,
    ...(right.uei === undefined ? {} : { uei: right.uei }),
    ...(left.city === undefined && right.city !== undefined
      ? { city: right.city }
      : {}),
    ...(left.state === undefined && right.state !== undefined
      ? { state: right.state }
      : {}),
    naics,
    pscCodes,
    awardCount: left.awardCount + right.awardCount,
    totalAwardValueUsd: left.totalAwardValueUsd + right.totalAwardValueUsd,
    ...(freshestAwardDate === undefined ? {} : { freshestAwardDate }),
    sourceQualification: mergeQualification(qualification, naics, pscCodes),
  };
}

function mergeQualification(
  qualification: SourceQualification,
  naics: readonly string[],
  pscCodes: readonly string[],
): SourceQualification {
  return {
    ...qualification,
    returnedNaics: naics.length === 0 ? null : naics,
    returnedPsc: pscCodes.length === 0 ? null : pscCodes,
  };
}

async function ingestRecipients(
  db: Database,
  recipients: readonly UsaspendingLeadCandidate[],
  month: string,
): Promise<{ readonly inserted: number; readonly duplicates: number }> {
  let inserted = 0;
  let duplicates = 0;
  for (const recipient of recipients) {
    const input = recipientToSignal(recipient, month);
    const result = await upsertHarvestedSourceSignal(db, input);
    if (result.duplicate) duplicates += 1;
    else inserted += 1;
  }
  return { inserted, duplicates };
}

function recipientToSignal(
  recipient: UsaspendingLeadCandidate,
  month: string,
): HarvestedSourceSignal {
  return {
    sourceKey: "usaspending",
    sourceLocator: recipient.sourceLocator,
    rawName: recipient.rawName,
    ...(recipient.uei === undefined ? {} : { uei: recipient.uei }),
    ...(recipient.cageCode === undefined ? {} : { cage: recipient.cageCode }),
    ...(recipient.city === undefined ? {} : { city: recipient.city }),
    ...(recipient.state === undefined ? {} : { state: recipient.state }),
    awardCount: recipient.awardCount,
    awardValue: recipient.totalAwardValueUsd,
    ...(recipient.freshestAwardDate === undefined
      ? {}
      : { freshestAward: recipient.freshestAwardDate }),
    sourcePayload: {
      source: recipient.source,
      sourceLocator: recipient.sourceLocator,
      sourceQualification: recipient.sourceQualification,
      naics: recipient.naics,
      pscCodes: recipient.pscCodes,
      addressLine: recipient.addressLine,
      zip: recipient.zip,
      ingestedMonth: month,
    },
  };
}

function recipientKey(recipient: UsaspendingLeadCandidate): string {
  const uei = recipient.uei?.trim().toLocaleUpperCase("en-US");
  if (uei !== undefined && uei !== "") return `uei:${uei}`;
  return `name:${recipient.rawName.trim().toLocaleLowerCase("en-US").replace(/\s+/gu, " ")}`;
}

function uniqueStrings(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): string[] {
  return [...new Set([...(left ?? []), ...(right ?? [])])];
}

function newerDate(
  left: string | undefined,
  right: string | undefined,
): string | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return left >= right ? left : right;
}

function defaultMonthRange(now: Date): {
  readonly from: string;
  readonly to: string;
} {
  const currentMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const from = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 12, 1),
  );
  const to = new Date(currentMonth - 24 * 60 * 60 * 1_000);
  return {
    from: from.toISOString().slice(0, 7),
    to: to.toISOString().slice(0, 7),
  };
}

function parseMonth(value: string, flag: string): string {
  if (!/^\d{4}-\d{2}$/u.test(value)) {
    throw new Error(`${flag} must use YYYY-MM`);
  }
  const [yearText, monthText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (year < 1 || month < 1 || month > 12) {
    throw new Error(`${flag} must use a valid YYYY-MM`);
  }
  return value;
}

function parseInteger(
  value: string,
  flag: string,
  minimum: number,
  maximum: number,
): number {
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${flag} must be an integer from ${minimum} to ${maximum}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${flag} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function lastDayOfMonth(month: string): string {
  const [yearText, monthText] = month.split("-");
  const last = new Date(Date.UTC(Number(yearText), Number(monthText), 0));
  return last.toISOString().slice(8, 10);
}

async function readState(stateFile: string): Promise<IngestState> {
  try {
    return ingestStateSchema.parse(
      JSON.parse(await readFile(stateFile, "utf8")),
    );
  } catch (error) {
    if (isMissingFileError(error)) return emptyState();
    throw new Error(
      `Unable to read USAspending ingest state at ${stateFile}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function emptyState(): IngestState {
  return { version: 1, completedMonths: {} };
}

async function writeState(
  stateFile: string,
  state: IngestState,
): Promise<void> {
  const absolutePath = path.resolve(stateFile);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, absolutePath);
}

function printMonthSummary(
  summary: UsaspendingIngestMonthSummary,
  dryRun: boolean,
): void {
  console.log(
    [
      `month=${summary.month}`,
      `fetched=${summary.fetched}`,
      `filtered=${summary.filtered}`,
      `inserted=${summary.inserted}`,
      `duplicates=${summary.duplicates}`,
      `limited=${summary.limited}`,
      ...(summary.skipped ? ["skipped=true"] : []),
      ...(dryRun ? ["dry_run=true"] : []),
    ].join(" "),
  );
}

function printSummary(
  summary: UsaspendingIngestSummary,
  dryRun: boolean,
): void {
  console.log(
    [
      `total_fetched=${summary.fetched}`,
      `total_filtered=${summary.filtered}`,
      `total_inserted=${summary.inserted}`,
      `total_duplicates=${summary.duplicates}`,
      `total_limited=${summary.limited}`,
      ...(dryRun ? ["dry_run=true"] : []),
    ].join(" "),
  );
}

async function main(): Promise<void> {
  const options = parseBulkIngestUsaspendingArgs(process.argv.slice(2));
  try {
    const summary = await runBulkIngestUsaspending(
      options,
      options.dryRun ? undefined : getDatabase(),
    );
    printSummary(summary, options.dryRun);
  } finally {
    if (!options.dryRun) await closeDatabase().catch(() => undefined);
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
