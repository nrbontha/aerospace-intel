/**
 * LIVE gated integration test for the candidate-research vertical slice.
 *
 *   ASI_DB_TESTS=1 DATABASE_URL=postgres://asi:local-development-only@localhost:55440/aerospace_supplier_intelligence \
 *     npx vitest run tests/candidate-research.live.db.test.ts
 *
 * Runs REAL network fetches and REAL OpenRouter model calls against the
 * discovered Zephyr International candidate. Asserts the full vertical:
 * ≥2 observations with evidence, confidence > 0, research_ready status,
 * persisted model_usage rows, and no duplicate source documents on rerun
 * (recent-document reuse window). Append-only provenance tables are never
 * mutated — assertions are absolute over canonical state plus per-run ids.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

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
process.env.DATABASE_URL ??=
  "postgres://asi:local-development-only@localhost:55440/aerospace_supplier_intelligence";

const DB_TESTS_ENABLED =
  process.env.ASI_DB_TESTS === "1" &&
  Boolean(process.env.DATABASE_URL);
const d = describe.skipIf(!DB_TESTS_ENABLED);

import {
  candidates,
  closeDatabase,
  getCandidateByCompanyId,
  getDatabase,
  latestAxisScores,
  modelUsage,
  sourceDocumentLinks,
  sourceDocuments,
} from "@asi/database";
import { enqueueCandidateResearch } from "@asi/research";
import { processCandidateResearch } from "../apps/worker/src/handlers/candidate-research.js";
import { OpenRouterClient } from "@asi/research/openrouter";

const ZEPHYR_COMPANY_ID = "47b6dfcd-9461-429e-8ed9-18d739e4da4a";
const ZEPHYR_DOMAIN = "zephyrintl.com";

function liveModels() {
  return {
    deep: process.env.OPENROUTER_MODEL_DEEP!,
    fallback: process.env.OPENROUTER_MODEL_FALLBACK!,
    fast: process.env.OPENROUTER_MODEL_FAST!,
  };
}

async function linkedSourceDocumentCount(companyId: string): Promise<number> {
  const rows = await getDatabase()
    .select({ n: sql<number>`count(*)::int` })
    .from(sourceDocuments)
    .innerJoin(
      sourceDocumentLinks,
      eq(sourceDocumentLinks.sourceDocumentId, sourceDocuments.id),
    )
    .where(eq(sourceDocumentLinks.companyId, companyId));
  return rows[0]?.n ?? 0;
}

d("candidate-research live (Zephyr)", () => {
  it("flows queued_research through real fetch+model to research_ready", { timeout: 300_000 }, async () => {
    const db = getDatabase();
    const candidate = await getCandidateByCompanyId(db, ZEPHYR_COMPANY_ID);
    expect(candidate).not.toBeNull();
    await db
      .update(candidates)
      .set({ status: "queued_research" })
      .where(eq(candidates.id, candidate!.id));

    const apiKey = process.env.OPENROUTER_API_KEY;
    expect(apiKey).toBeDefined();
    const client = new OpenRouterClient(apiKey!);

    const before = await latestAxisScores(db, candidate!.id);
    const enqueued = await enqueueCandidateResearch(db, {
      candidateId: candidate!.id,
      companyId: ZEPHYR_COMPANY_ID,
      domain: ZEPHYR_DOMAIN,
    });
    expect(enqueued.researchRunId).toBeDefined();

    const result = await processCandidateResearch(
      { researchRunId: enqueued.researchRunId, companyId: ZEPHYR_COMPANY_ID },
      { client, models: liveModels(), forceRefresh: true },
    );

    // Tool manifest bounded to ≤3 fetch_url calls.
    expect(result.fetchedUrls.length).toBeGreaterThanOrEqual(1);
    expect(result.fetchedUrls.length).toBeLessThanOrEqual(3);

    // ≥2 observations with evidence rows exist for this candidate from
    // evidence-backed candidate-research extraction (this run or prior ones —
    // append-only provenance is never rewritten).
    const obsRows = await db.execute<{ n: number }>(sql`
      SELECT count(DISTINCT o.id)::int AS n FROM observations o
      JOIN evidence e ON e.id = o.evidence_id
      JOIN source_documents sd ON sd.id = e.source_document_id
      WHERE o.subject_type = 'company' AND o.subject_id = ${ZEPHYR_COMPANY_ID}
        AND sd.metadata->>'promptVersion' = 'candidate-research.v1'
    `);
    expect(Number(obsRows.rows[0]!.n)).toBeGreaterThanOrEqual(2);

    // Candidate ends research_ready with confidence > 0 (never lower).
    const afterRow = await db
      .select({ status: candidates.status })
      .from(candidates)
      .where(eq(candidates.id, candidate!.id))
      .limit(1);
    expect(afterRow[0]!.status).toBe("research_ready");
    const after = await latestAxisScores(db, candidate!.id);
    expect(after.confidence?.value ?? 0).toBeGreaterThan(0);
    expect(after.confidence!.value).toBeGreaterThanOrEqual(
      before.confidence?.value ?? 0,
    );

    // Model usage persisted for THIS run (tokens recorded even at $0).
    const usage = await db
      .select({
        rows: sql<number>`count(*)::int`,
        inputTokens: sql<number>`coalesce(sum(${modelUsage.inputTokens}), 0)::int`,
        costUsd: sql<string>`coalesce(sum(${modelUsage.costUsd}), 0)::text`,
      })
      .from(modelUsage)
      .where(eq(modelUsage.researchRunId, enqueued.researchRunId));
    expect(Number(usage[0]!.rows)).toBeGreaterThanOrEqual(1);
    expect(Number(usage[0]!.inputTokens)).toBeGreaterThan(0);
    expect(Number(usage[0]!.costUsd)).toBeLessThanOrEqual(0.5);

    // Second inline run within the reuse window adds NO duplicate source
    // documents and no new observations.
    const documentsBefore = await linkedSourceDocumentCount(ZEPHYR_COMPANY_ID);
    const enqueued2 = await enqueueCandidateResearch(db, {
      candidateId: candidate!.id,
      companyId: ZEPHYR_COMPANY_ID,
      domain: ZEPHYR_DOMAIN,
    });
    const rerun = await processCandidateResearch(
      { researchRunId: enqueued2.researchRunId, companyId: ZEPHYR_COMPANY_ID },
      { client, models: liveModels() },
    );
    expect(rerun.observationsCreated).toBe(0);
    const documentsAfter = await linkedSourceDocumentCount(ZEPHYR_COMPANY_ID);
    expect(documentsAfter).toBe(documentsBefore);

    await closeDatabase();
  });

  it("returns the candidate to queued_research with an unknowns note when the workflow fails twice", { timeout: 120_000 }, async () => {
    const db = getDatabase();
    const candidate = await getCandidateByCompanyId(db, ZEPHYR_COMPANY_ID);
    expect(candidate).not.toBeNull();
    await db
      .update(candidates)
      .set({ status: "in_research" })
      .where(eq(candidates.id, candidate!.id));

    // A valid key with nonexistent models makes OpenRouter reject fast while
    // still exercising the real client error path (twice, per MAX_ATTEMPTS).
    const client = new OpenRouterClient(process.env.OPENROUTER_API_KEY!);
    const brokenModels = {
      deep: "stealth/nonexistent-deep",
      fallback: "stealth/nonexistent-fallback",
      fast: "stealth/ox-alpha-nonexistent-model",
    };
    const enqueued = await enqueueCandidateResearch(db, {
      candidateId: candidate!.id,
      companyId: ZEPHYR_COMPANY_ID,
      domain: ZEPHYR_DOMAIN,
    });
    await expect(
      processCandidateResearch(
        { researchRunId: enqueued.researchRunId, companyId: ZEPHYR_COMPANY_ID },
        { client, models: brokenModels, forceRefresh: true },
      ),
    ).rejects.toThrowError();

    const row = await db
      .select({ status: candidates.status, rationale: candidates.rationale })
      .from(candidates)
      .where(eq(candidates.id, candidate!.id))
      .limit(1);
    expect(row[0]!.status).toBe("queued_research");
    expect(
      row[0]!.rationale.unknowns.some((unknown_) =>
        unknown_.includes("candidate-research failed"),
      ),
    ).toBe(true);

    await closeDatabase();
  });
});
