/**
 * Enrichment benchmark runner — orchestrates fetch → extract → compare per
 * golden company with a per-domain content cache, a fetch budget (≤3 per
 * company), and a hard cost abort. Dependencies are injected so the whole
 * flow is testable without network or model.
 *
 * Read-only over canonical data: the runner never writes canonical tables.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  aggregateComparisons,
  compareProfiles,
  type AggregateMetrics,
  type ComparisonContext,
  type FieldComparison,
} from "./compare.js";
import {
  collectAboutLinks,
  enrichProfileSchema,
  htmlToText,
  type EnrichmentProfile,
} from "./schema.js";

export const CACHE_VERSION = 1;
export const DEFAULT_MAX_FETCHES_PER_COMPANY = 3;
export const DEFAULT_RUN_COST_CAP_USD = 0.5;
export const DEFAULT_DAILY_ABORT_USD = 0.8;

export interface BenchmarkCompanyInput {
  readonly name: string;
  readonly domain: string;
  readonly grataPayload: Record<string, unknown>;
}

export interface FetchPageOutcome {
  readonly url: string;
  readonly ok: boolean;
  readonly contentType: string;
  /** Raw body (HTML or text); empty on failure. */
  readonly body: string;
  readonly error?: string;
}

export type PageFetcher = (url: string) => Promise<FetchPageOutcome>;

export interface ExtractionTelemetry {
  readonly tokens: number | null;
  readonly costUsd: number | null;
  readonly model: string | null;
}

export type ProfileExtractor = (input: {
  readonly name: string;
  readonly domain: string;
  readonly documents: ReadonlyArray<{ readonly url: string; readonly text: string }>;
}) => Promise<{ profile: EnrichmentProfile; telemetry: ExtractionTelemetry }>;

export interface CompanyBenchmarkResult {
  readonly name: string;
  readonly domain: string;
  readonly fetchedUrls: readonly string[];
  readonly fetchErrors: readonly string[];
  readonly fromCache: boolean;
  readonly profile: EnrichmentProfile | null;
  readonly extractError: string | null;
  readonly comparisons: readonly FieldComparison[];
  readonly tokens: number | null;
  readonly costUsd: number | null;
  readonly model: string | null;
}

export interface BenchmarkTotals {
  readonly companies: number;
  readonly completed: number;
  readonly failed: number;
  readonly cacheHits: number;
  readonly fetchCount: number;
  readonly totalTokens: number | null;
  readonly totalCostUsd: number | null;
  readonly runtimeMs: number;
  readonly aborted: boolean;
  readonly abortReason: string | null;
}

export interface BenchmarkReport {
  readonly generatedAt: string;
  readonly totals: BenchmarkTotals;
  readonly perCompany: readonly CompanyBenchmarkResult[];
  readonly aggregate: AggregateMetrics;
}

export interface RunBenchmarkOptions {
  readonly companies: readonly BenchmarkCompanyInput[];
  readonly cacheDir: string;
  readonly fetchPage: PageFetcher;
  readonly extract: ProfileExtractor;
  readonly maxFetchesPerCompany?: number;
  readonly runCostCapUsd?: number;
  /** Spend already recorded elsewhere (e.g. model_usage) today, in USD. */
  readonly dailySpendBaselineUsd?: number;
  readonly dailyAbortThresholdUsd?: number;
  readonly comparisonContext?: ComparisonContext;
  readonly onProgress?: (line: string) => void;
}

interface CacheEntry {
  readonly version: number;
  readonly name: string;
  readonly domain: string;
  readonly cachedAt: string;
  readonly fetchedUrls: readonly string[];
  readonly documents: ReadonlyArray<{ readonly url: string; readonly text: string }>;
  readonly profile: EnrichmentProfile;
  readonly telemetry: ExtractionTelemetry;
}

function cachePathFor(cacheDir: string, domain: string): string {
  const safe = domain.replace(/[^a-z0-9.-]+/giu, "_").toLocaleLowerCase("en-US");
  return path.join(cacheDir, `${safe}.json`);
}

async function loadCache(cacheDir: string, domain: string): Promise<CacheEntry | null> {
  let raw: string;
  try {
    raw = await readFile(cachePathFor(cacheDir, domain), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as CacheEntry;
    if (parsed.version !== CACHE_VERSION || parsed.domain !== domain) return null;
    const profile = enrichProfileSchema.parse(parsed.profile);
    if (parsed.documents.length === 0) return null;
    return { ...parsed, profile };
  } catch {
    return null;
  }
}

async function saveCache(cacheDir: string, entry: CacheEntry): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  await writeFile(cachePathFor(cacheDir, entry.domain), `${JSON.stringify(entry, null, 2)}\n`, "utf8");
}

function homepageUrl(domain: string): string | null {
  const host = domain.trim().replace(/^https?:\/\//iu, "").replace(/\/+$/u, "");
  if (host.length === 0 || !host.includes(".")) return null;
  return `https://${host}/`;
}

function sumOrNull(values: ReadonlyArray<number | null | undefined>): number | null {
  const finite = values.filter((value): value is number =>
    typeof value === "number" && Number.isFinite(value),
  );
  return finite.length === 0 ? null : finite.reduce((a, b) => a + b, 0);
}

/**
 * Run the benchmark over all companies. Budget guard: before any spend-incurring
 * step, if accumulated run cost (plus the daily baseline) reaches the daily
 * abort threshold or the run cost cap, stop and report partial results.
 */
export async function runEnrichmentBenchmark(
  options: RunBenchmarkOptions,
): Promise<BenchmarkReport> {
  const maxFetches = options.maxFetchesPerCompany ?? DEFAULT_MAX_FETCHES_PER_COMPANY;
  const runCap = options.runCostCapUsd ?? DEFAULT_RUN_COST_CAP_USD;
  const dailyAbort = options.dailyAbortThresholdUsd ?? DEFAULT_DAILY_ABORT_USD;
  const baseline = options.dailySpendBaselineUsd ?? 0;
  const startedAt = Date.now();
  const results: CompanyBenchmarkResult[] = [];
  let fetchCount = 0;
  let aborted = false;
  let abortReason: string | null = null;
  let cacheHits = 0;

  const budgetBlocked = (runCostSoFar: number | null): boolean => {
    const total = (runCostSoFar ?? 0) + baseline;
    if (runCostSoFar !== null && runCostSoFar >= runCap) {
      abortReason = `run cost cap reached ($${runCostSoFar.toFixed(4)} ≥ $${runCap.toFixed(2)})`;
      return true;
    }
    if (total >= dailyAbort) {
      abortReason = `daily spend approaching cap ($${total.toFixed(4)} ≥ $${dailyAbort.toFixed(2)} abort threshold)`;
      return true;
    }
    return false;
  };

  for (const company of options.companies) {
    if (aborted) break;
    const progress = (line: string) => options.onProgress?.(line);
    if (budgetBlocked(sumOrNull(results.map((result) => result.costUsd)))) {
      aborted = true;
      progress(`ABORT: ${abortReason}`);
      break;
    }

    const cached = await loadCache(options.cacheDir, company.domain);
    if (cached !== null) {
      cacheHits += 1;
      const comparisons = compareProfiles(
        cached.profile,
        company.grataPayload,
        {
          ...options.comparisonContext,
          pageText:
            options.comparisonContext?.pageText ??
            cached.documents.map((doc) => doc.text).join(" "),
        },
      );
      results.push({
        name: company.name,
        domain: company.domain,
        fetchedUrls: cached.fetchedUrls,
        fetchErrors: [],
        fromCache: true,
        profile: cached.profile,
        extractError: null,
        comparisons,
        tokens: cached.telemetry.tokens,
        costUsd: cached.telemetry.costUsd,
        model: cached.telemetry.model,
      });
      progress(`${company.name}: cached (${cached.fetchedUrls.length} urls), ${comparisons.length} comparisons`);
      continue;
    }

    const homepage = homepageUrl(company.domain);
    if (homepage === null) {
      results.push({
        name: company.name,
        domain: company.domain,
        fetchedUrls: [],
        fetchErrors: ["invalid domain"],
        fromCache: false,
        profile: null,
        extractError: "invalid domain",
        comparisons: [],
        tokens: null,
        costUsd: null,
        model: null,
      });
      progress(`${company.name}: invalid domain ${company.domain}`);
      continue;
    }

    const fetchedUrls: string[] = [];
    const fetchErrors: string[] = [];
    const documents: Array<{ url: string; text: string }> = [];

    const homeOutcome = await options.fetchPage(homepage);
    fetchCount += 1;
    const homeText = homeOutcome.ok
      ? htmlToText(homeOutcome.body, homeOutcome.contentType)
      : "";
    if (!homeOutcome.ok) {
      fetchErrors.push(`${homeOutcome.url}: ${homeOutcome.error ?? "fetch failed"}`);
    } else if (homeText.length === 0) {
      fetchErrors.push(`${homeOutcome.url}: empty page text`);
    } else {
      fetchedUrls.push(homeOutcome.url);
      documents.push({ url: homeOutcome.url, text: homeText });
    }

    // One secondary page (about/contact/capabilities) when linked and budget allows.
    if (documents.length > 0 && fetchCount < maxFetches) {
      const [aboutLink] = collectAboutLinks(homeOutcome.body, homepage, 1);
      if (aboutLink !== undefined && !fetchedUrls.includes(aboutLink)) {
        fetchCount += 1;
        const aboutOutcome = await options.fetchPage(aboutLink);
        const aboutText = aboutOutcome.ok
          ? htmlToText(aboutOutcome.body, aboutOutcome.contentType)
          : "";
        if (!aboutOutcome.ok) {
          fetchErrors.push(`${aboutOutcome.url}: ${aboutOutcome.error ?? "fetch failed"}`);
        } else if (aboutText.length > 0) {
          fetchedUrls.push(aboutOutcome.url);
          documents.push({ url: aboutOutcome.url, text: aboutText });
        } else {
          fetchErrors.push(`${aboutOutcome.url}: empty page text`);
        }
      }
    }

    if (documents.length === 0) {
      results.push({
        name: company.name,
        domain: company.domain,
        fetchedUrls,
        fetchErrors,
        fromCache: false,
        profile: null,
        extractError: "no page could be fetched",
        comparisons: [],
        tokens: null,
        costUsd: null,
        model: null,
      });
      progress(`${company.name}: fetch failed (${fetchErrors.join("; ")})`);
      continue;
    }

    const runCostSoFar = sumOrNull(results.map((result) => result.costUsd));
    if (budgetBlocked(runCostSoFar)) {
      aborted = true;
      progress(`ABORT: ${abortReason}`);
      break;
    }

    try {
      const extraction = await options.extract({
        name: company.name,
        domain: company.domain,
        documents,
      });
      await saveCache(options.cacheDir, {
        version: CACHE_VERSION,
        name: company.name,
        domain: company.domain,
        cachedAt: new Date().toISOString(),
        fetchedUrls,
        documents,
        profile: extraction.profile,
        telemetry: extraction.telemetry,
      });
      const comparisons = compareProfiles(extraction.profile, company.grataPayload, {
        ...options.comparisonContext,
        pageText:
          options.comparisonContext?.pageText ??
          documents.map((doc) => doc.text).join(" "),
      });
      results.push({
        name: company.name,
        domain: company.domain,
        fetchedUrls,
        fetchErrors,
        fromCache: false,
        profile: extraction.profile,
        extractError: null,
        comparisons,
        tokens: extraction.telemetry.tokens,
        costUsd: extraction.telemetry.costUsd,
        model: extraction.telemetry.model,
      });
      const matchCount = comparisons.filter((c) => c.verdict === "match").length;
      const mismatchCount = comparisons.filter((c) => c.verdict === "mismatch").length;
      progress(
        `${company.name}: ${fetchedUrls.length} pages, ${matchCount} match / ${mismatchCount} mismatch`,
      );
    } catch (error) {
      results.push({
        name: company.name,
        domain: company.domain,
        fetchedUrls,
        fetchErrors,
        fromCache: false,
        profile: null,
        extractError: error instanceof Error ? error.message : String(error),
        comparisons: [],
        tokens: null,
        costUsd: null,
        model: null,
      });
      progress(`${company.name}: extraction failed — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const completed = results.filter((result) => result.profile !== null).length;
  const totals: BenchmarkTotals = {
    companies: options.companies.length,
    completed,
    failed: options.companies.length - completed,
    cacheHits,
    fetchCount,
    totalTokens: sumOrNull(results.map((result) => result.tokens)),
    totalCostUsd: sumOrNull(results.map((result) => result.costUsd)),
    runtimeMs: Date.now() - startedAt,
    aborted,
    abortReason,
  };

  return {
    generatedAt: new Date().toISOString(),
    totals,
    perCompany: results,
    aggregate: aggregateComparisons(results),
  };
}
