/**
 * Deep-research a queued candidate end-to-end WITHOUT a worker process:
 *   enqueue run/job → processCandidateResearch INLINE (live fetch + model)
 *   → canonical rescore → research_ready.
 *
 * Usage:
 *   DATABASE_URL=postgres://asi:local-development-only@localhost:55440/aerospace_supplier_intelligence \
 *     npx tsx scripts/deep-research-candidate.ts <companyId> [domain]
 *
 * Prints observations created, evidence count, tokens, cost, and
 * before/after axis scores. Aborts before any model spend when today's
 * model_usage total exceeds $0.80.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { eq, sql } from "drizzle-orm";

// Load gitignored .env.local without overriding already-exported vars.
const envFile = path.join(process.cwd(), ".env.local");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u);
    if (match === null) continue;
    const [, key, raw] = match;
    if (process.env[key!] === undefined) {
      process.env[key!] = raw!.replace(/^["']|["']$/gu, "");
    }
  }
}

import {
  closeDatabase,
  companyDomains,
  getCandidateByCompanyId,
  getDatabase,
  latestAxisScores,
  type LatestAxisScoreMap,
} from "@asi/database";
import { enqueueCandidateResearch } from "@asi/research";
import { processCandidateResearch } from "../apps/worker/src/handlers/candidate-research.js";
import { OpenRouterClient } from "@asi/research/openrouter";

process.env.DATABASE_URL ??=
  "postgres://asi:local-development-only@localhost:55440/aerospace_supplier_intelligence";


const DAILY_COST_ABORT_USD = 0.8;

async function main(): Promise<void> {
  const companyId = process.argv[2];
  if (companyId === undefined || companyId.length === 0) {
    console.error("usage: npx tsx scripts/deep-research-candidate.ts <companyId> [domain]");
    process.exitCode = 1;
    return;
  }

  const db = getDatabase();
  const candidate = await getCandidateByCompanyId(db, companyId);
  if (candidate === null) {
    throw new Error(`No candidate found for company ${companyId}`);
  }
  const [domainRow] = await db
    .select({ domain: companyDomains.domain })
    .from(companyDomains)
    .where(eq(companyDomains.companyId, companyId))
    .limit(1);
  const domain = process.argv[3] ?? domainRow?.domain;
  if (domain === undefined) {
    throw new Error("No domain known for this company; pass one as argv[2]");
  }

  const dailySpend = await db.execute<{ total: string }>(sql`
    SELECT coalesce(sum(cost_usd), 0)::text AS total FROM model_usage
    WHERE created_at >= date_trunc('day', now())
  `);
  const spendUsd = Number(dailySpend.rows[0]?.total ?? "0");
  if (spendUsd > DAILY_COST_ABORT_USD) {
    throw new Error(
      `Daily model usage $${spendUsd.toFixed(2)} exceeds $${DAILY_COST_ABORT_USD.toFixed(2)} abort threshold`,
    );
  }

  const before = await latestAxisScores(db, candidate.id);
  console.log("candidate", {
    id: candidate.id,
    status: candidate.status,
    domain,
    beforeScores: Object.fromEntries(
      Object.entries(before).map(([axis, entry]) => [axis, entry?.value ?? null]),
    ),
  });

  const enqueued = await enqueueCandidateResearch(db, {
    candidateId: candidate.id,
    companyId,
    domain,
  });
  console.log("enqueued", enqueued);

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("OPENROUTER_API_KEY is required");
  }
  const client = new OpenRouterClient(apiKey);
  const models = {
    deep: process.env.OPENROUTER_MODEL_DEEP!,
    fallback: process.env.OPENROUTER_MODEL_FALLBACK!,
    fast: process.env.OPENROUTER_MODEL_FAST!,
  };

  const result = await processCandidateResearch(
    { researchRunId: enqueued.researchRunId, companyId },
    { client, models, forceRefresh: process.argv.includes("--refresh") },
  );

  const after = await latestAxisScores(db, candidate.id);
  const toPlain = (scores: LatestAxisScoreMap) =>
    Object.fromEntries(
      Object.entries(scores).map(([axis, entry]) => [axis, entry?.value ?? null]),
    );
  console.log("result", {
    candidateId: result.candidateId,
    fetchedUrls: result.fetchedUrls,
    observationsCreated: result.observationsCreated,
    evidenceCount: result.evidenceCount,
    proposalCount: result.proposalCount,
    tokens: {
      input: result.inputTokens,
      output: result.outputTokens,
      total: result.totalTokens,
    },
    costUsd: result.costUsd,
    beforeScores: toPlain(before),
    afterScores: toPlain(after),
  });

  await closeDatabase();
}

main().catch(async (error) => {
  console.error(error);
  await closeDatabase().catch(() => undefined);
  process.exitCode = 1;
});
