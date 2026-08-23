/**
 * Enrichment benchmark CLI (spec §9B.2 direct-name variant).
 *
 *   npx tsx scripts/bench-enrichment.ts [--limit N] [--no-cache] [--cache-dir .cache/bench]
 *
 * For each golden_examples row (name + domain + grata_payload from the DB):
 *   1. fetch the company homepage (+ one about/contact page if linked, ≤3 fetches)
 *      through safe-fetch,
 *   2. extract an EnrichmentProfile via the OpenRouter gateway (structured output,
 *      fast route; default model stealth/ox-alpha — free tier),
 *   3. compare field-by-field against the grata_payload reference,
 *   4. persist NOTHING to canonical tables; write the report to
 *      reports/enrichment-benchmark-<ts>.json and, when the @asi/database
 *      experiments journal is available, an experiment_runs row
 *      (kind enrichment_benchmark).
 *
 * Cost discipline: per-run cap $0.50 and daily abort at $0.80 (baseline = today's
 * model_usage sum) are enforced in-code regardless of env caps. Results are
 * cached per domain under .cache/bench/ so reruns skip fetch + model spend.
 */
import path from "node:path";
import process from "node:process";
import {
  buildExtractionPrompt,
  compareProfiles,
  DEFAULT_DAILY_ABORT_USD,
  DEFAULT_RUN_COST_CAP_USD,
  ENRICHMENT_PROFILE_SCHEMA_NAME,
  enrichProfileSchema,
  EXTRACTION_SYSTEM_PROMPT,
  runEnrichmentBenchmark,
  type BenchmarkReport,
  type FetchPageOutcome,
} from "../packages/research/src/benchmarks/index.js";
import {
  safeFetchUrl,
  SafeFetchError,
  OpenRouterClient,
  OpenRouterClientError,
} from "@asi/research";
import { closeDatabase, getDatabase } from "@asi/database";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";

import { normalizeExtraction } from "../packages/research/src/benchmarks/index.js";
import type { EnrichmentProfile } from "../packages/research/src/benchmarks/index.js";
import { z } from "zod";
// ---------------------------------------------------------------------------
// env bootstrap (mirror scripts/ops-status.ts convention: source .env.local)
// ---------------------------------------------------------------------------
for (const line of existsSync(".env.local")
  ? readFileSync(".env.local", "utf8").split("\n")
  : []) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/u);
  const key = match?.[1];
  const value = match?.[2];
  if (key !== undefined && value !== undefined && process.env[key] === undefined) {
    process.env[key] = value;
  }
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const hasFlag = (flag: string) => process.argv.includes(flag);

const limitArg = argValue("--limit");
const limit = limitArg === undefined ? undefined : Number(limitArg);
let cacheDir = argValue("--cache-dir") ?? ".cache/bench";
if (hasFlag("--no-cache")) {
  // Cache dir swap keeps prior runs intact while forcing fresh fetch+extract.
  cacheDir = `.cache/bench-fresh-${Date.now()}`;
}

// The benchmark is authorized on stealth/ox-alpha (free tier). .env.local model
// slots are NOT used so a stale local default can never spend money here.
const MODEL = process.env["ENRICHMENT_BENCH_MODEL"] ?? "stealth/ox-alpha";
const models = { fast: MODEL, deep: MODEL, fallback: MODEL } as const;

const apiKey = process.env["OPENROUTER_API_KEY"];
if (apiKey === undefined || apiKey.trim().length === 0) {
  console.error("OPENROUTER_API_KEY is required");
  process.exit(1);
}

interface GoldenRow {
  name: string;
  domain: string;
  grata_payload?: Record<string, unknown>;
}

interface GoldenCompany {
  name: string;
  domain: string;
  grataPayload: Record<string, unknown>;
}

async function loadGoldenRows(): Promise<GoldenCompany[]> {
  const result = await getDatabase().execute(sql`
    select name, coalesce(domain, '') as domain, grata_payload
    from golden_examples
    order by name
  `);
  const rows = (result as unknown as { rows: GoldenRow[] }).rows ?? [];
  return rows
    .filter((row) => row.domain.length > 0)
    .map((row): GoldenCompany => ({
      name: row.name,
      domain: row.domain,
      // Raw SQL rows come back snake_case.
      grataPayload: row.grata_payload ?? {},
    }));
}

async function dailyModelSpendUsd(): Promise<number> {
  const result = await getDatabase().execute<{ total: string | null }>(sql`
    select coalesce(sum(cost_usd), 0)::text as total
    from model_usage
    where created_at >= date_trunc('day', now())
  `);
  const rows = (result as unknown as { rows: Array<{ total: string | null }> }).rows ?? [];
  return Number.parseFloat(rows[0]?.total ?? "0");
}

async function fetchPage(url: string): Promise<FetchPageOutcome> {
  try {
    const result = await safeFetchUrl(url);
    return {
      url: result.finalUrl,
      ok: true,
      contentType: result.contentType,
      body: result.content,
    };
  } catch (error) {
    const detail =
      error instanceof SafeFetchError ? `${error.code}: ${error.message}` : String(error);
    return { url, ok: false, contentType: "text/plain", body: "", error: detail };
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const rows = (await loadGoldenRows()).slice(0, limit ?? Number.POSITIVE_INFINITY);
  if (rows.length === 0) {
    console.error("No golden examples with domains found — import datasets first.");
    await closeDatabase();
    process.exit(1);
  }
  const dailyBaseline = await dailyModelSpendUsd();
  console.log(
    `Enrichment benchmark: ${rows.length} companies, model ${MODEL}, ` +
      `cache ${cacheDir}, daily baseline $${dailyBaseline.toFixed(4)}, ` +
      `caps $${DEFAULT_RUN_COST_CAP_USD.toFixed(2)}/run, $${DEFAULT_DAILY_ABORT_USD.toFixed(2)}/day abort`,
  );

  const client = new OpenRouterClient(apiKey!);
  let structuredOutputSupported = true;
  const sleep = (ms: number): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
  };

  interface ExtractionTelemetryLike {
    tokens: number | null;
    costUsd: number | null;
    model: string | null;
  }

  // Repair pass: some free-tier providers ignore response_format and answer in
  // prose. One plain completion with the same prompts, JSON recovered from the
  // reply, then normalized and strictly validated locally.
  const rawCompletionExtract = async (input: {
    name: string;
    domain: string;
    documents: ReadonlyArray<{ url: string; text: string }>;
  }): Promise<{ profile: EnrichmentProfile; telemetry: ExtractionTelemetryLike }> => {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
          { role: "user", content: buildExtractionPrompt(input.name, input.domain, input.documents) },
        ],
        max_tokens: 3_500,
        temperature: 0,
      }),
    });
    if (!response.ok) {
      throw new Error(`fallback completion HTTP ${response.status}`);
    }
    const envelope = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
      usage?: { total_tokens?: number; cost?: number };
      model?: string;
    };
    const content = envelope.choices?.[0]?.message?.content ?? "";
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start < 0 || end <= start) {
      throw new Error("no JSON object found in fallback model output");
    }
    const profile = normalizeExtraction(JSON.parse(content.slice(start, end + 1)), {
      legalName: input.name,
      domain: input.domain,
    });
    return {
      profile,
      telemetry: {
        tokens: envelope.usage?.total_tokens ?? null,
        costUsd: envelope.usage?.cost ?? null,
        model: envelope.model ?? MODEL,
      },
    };
  };

  const extract = async (input: {
    name: string;
    domain: string;
    documents: ReadonlyArray<{ url: string; text: string }>;
  }) => {
    if (!structuredOutputSupported) {
      const outcome = await rawCompletionExtract(input);
      await sleep(2_000);
      return outcome;
    }
    try {
      const result = await client.generateStructured({
        route: "fast",
        models,
        schemaName: ENRICHMENT_PROFILE_SCHEMA_NAME,
        schema: enrichProfileSchema,
        systemPrompt: EXTRACTION_SYSTEM_PROMPT,
        prompt: buildExtractionPrompt(input.name, input.domain, input.documents),
        maxOutputTokens: 2_048,
        timeoutMs: 90_000,
        maxAttempts: 1,
      });
      return {
        profile: result.data,
        telemetry: {
          tokens: result.telemetry.totalTokens,
          costUsd: result.telemetry.costUsd,
          model: result.telemetry.model,
        } satisfies ExtractionTelemetryLike,
      };
    } catch (error) {
      const reason =
        error instanceof OpenRouterClientError ? error.code : "unexpected";
      if (reason === "invalid_structured_output") structuredOutputSupported = false;
      console.log(`    structured output unavailable (${reason}); using raw-completion repair pass`);
      const outcome = await rawCompletionExtract(input);
      await sleep(2_000);
      return outcome;
    }
  };

  let report: BenchmarkReport;
  try {
    report = await runEnrichmentBenchmark({
      companies: rows,
      cacheDir,
      fetchPage,
      extract,
      dailySpendBaselineUsd: dailyBaseline,
      onProgress: (line) => console.log(`  ${line}`),
    });
  } catch (error) {
    console.error(
      "Benchmark aborted:",
      error instanceof OpenRouterClientError
        ? `${error.code} — ${error.message}`
        : String(error),
    );
    await closeDatabase();
    process.exit(2);
  }

  // ---------------------------------------------------------------- report --
  const reportsDir = path.join(process.cwd(), "reports");
  mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const reportPath = path.join(reportsDir, `enrichment-benchmark-${stamp}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log("\n=== Aggregate ===");
  console.log(`companies: ${report.totals.completed}/${report.totals.companies} completed` +
    ` (${report.totals.cacheHits} from cache, ${report.totals.failed} failed)`);
  console.log(`fetches: ${report.totals.fetchCount}, tokens: ${report.totals.totalTokens ?? "n/a"}, ` +
    `cost: $${(report.totals.totalCostUsd ?? 0).toFixed(4)}, runtime: ${(
      (Date.now() - startedAt) / 1000
    ).toFixed(1)}s`);
  if (report.totals.aborted) console.log(`ABORTED: ${report.totals.abortReason}`);
  for (const [field, rate] of Object.entries(report.aggregate.matchRatesByField)) {
    const comparable = report.aggregate.comparableByField[field as keyof typeof report.aggregate.comparableByField];
    const coverage = report.aggregate.fieldCoverage[field as keyof typeof report.aggregate.fieldCoverage];
    console.log(
      `  ${field}: matchRate=${rate === null ? "n/a" : `${(rate * 100).toFixed(0)}%`} ` +
        `comparable=${comparable} coverage=${(coverage * 100).toFixed(0)}%`,
    );
  }
  console.log(`  overallMatchRate=${report.aggregate.overallMatchRate === null ? "n/a" : `${(report.aggregate.overallMatchRate * 100).toFixed(0)}%`}`);
  console.log(`  disagreements: ${JSON.stringify(report.aggregate.disagreementCounts)}`);

  // ------------------------------------------------- experiment_runs row --
  let journalNote = "experiment journal helper not available; report file only";
  try {
    const database = await import("@asi/database");
    const journal = (database as Record<string, unknown>)["recordExperimentRun"];
    if (typeof journal === "function") {
      await (
        journal as (
          db: ReturnType<typeof getDatabase>,
          dto: Record<string, unknown>,
        ) => Promise<unknown>
      )(getDatabase(), {
        kind: "enrichment_benchmark",
        label: `enrichment-benchmark ${stamp} (${report.totals.completed}/${report.totals.companies} companies)`,
        primaryMetricName: "field_match_rate",
        primaryMetricValue: report.aggregate.overallMatchRate,
        result: report as unknown as Record<string, unknown>,
      });
      journalNote = "experiment_runs row recorded via @asi/database journal";
    }
  } catch (error) {
    const cause =
      error !== null && typeof error === "object" && "cause" in error
        ? ` — cause: ${String((error as { cause?: unknown }).cause)}`
        : "";
    journalNote = `experiment_runs insert failed: ${error instanceof Error ? error.message : String(error)}${cause}`;
  }
  console.log(`\njournal: ${journalNote}`);
  console.log(`report: ${reportPath}`);

  await closeDatabase();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
