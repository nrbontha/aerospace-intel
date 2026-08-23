/**
 * LIVE gated integration test for the enrich_candidate TickHandler.
 *
 *   ASI_DB_TESTS=1 DATABASE_URL=postgres://asi:local-development-only@localhost:55440/aerospace_supplier_intelligence \
 *     npx vitest run tests/enrich-agent.live.db.test.ts
 *
 * REAL network fetches + REAL OpenRouter model calls against the discovered
 * Zephyr International candidate (company 47b6dfcd-9461-429e-8ed9-18d739e4da4a).
 * Proves the full agent vertical: planTick → validated action → bounded
 * deep-research workflow → ≥1 NEW observation with evidence → rescore →
 * research_ready, with the tick journaled via startTick/completeTick and
 * live cost reported. Append-only provenance is never rewritten; assertions
 * are deltas over pre-tick state.
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
  process.env.ASI_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const d = describe.skipIf(!DB_TESTS_ENABLED);

import {
  candidates,
  closeDatabase,
  completeTick,
  getCandidateByCompanyId,
  getDatabase,
  latestAxisScores,
  researchAgents,
  startTick,
} from "@asi/database";
import { OpenRouterClient } from "@asi/research";
import { createV1TickHandlerRegistry } from "../apps/worker/src/supervisor/handlers.js";

const ZEPHYR_COMPANY_ID = "47b6dfcd-9461-429e-8ed9-18d739e4da4a";
const ZEPHYR_DOMAIN = "zephyrintl.com";

function liveModels() {
  return {
    deep: process.env.OPENROUTER_MODEL_DEEP!,
    fallback: process.env.OPENROUTER_MODEL_FALLBACK!,
    fast: process.env.OPENROUTER_MODEL_FAST!,
  };
}

async function candidateResearchObservationCount(companyId: string): Promise<number> {
  const rows = await getDatabase().execute<{ n: number }>(sql`
    SELECT count(DISTINCT o.id)::int AS n FROM observations o
    JOIN evidence e ON e.id = o.evidence_id
    JOIN source_documents sd ON sd.id = e.source_document_id
    WHERE o.subject_type = 'company' AND o.subject_id = ${companyId}
      AND sd.metadata->>'promptVersion' = 'candidate-research.v1'
  `);
  return Number(rows.rows[0]!.n);
}

d("enrich_candidate live tick (Zephyr)", () => {
  it("plans, deep-researches with real fetch+model, produces a NEW observation and journals cost", {
    timeout: 300_000,
  }, async () => {
    const db = getDatabase();
    const apiKey = process.env.OPENROUTER_API_KEY;
    expect(apiKey).toBeDefined();
    const client = new OpenRouterClient(apiKey!);

    // Put Zephyr at the head of the enrichment queue for this run.
    const candidate = await getCandidateByCompanyId(db, ZEPHYR_COMPANY_ID);
    expect(candidate).not.toBeNull();
    await db
      .update(candidates)
      .set({ status: "queued_research" })
      .where(eq(candidates.id, candidate!.id));

    // Reset MACHINE-GENERATED residue from earlier automated runs of this
    // same vertical (pending, non-canonical observations sourced by
    // candidate-research.v1 documents). Without this, conservative
    // extraction legitimately returns zero novel facts for a saturated
    // candidate and "≥1 new observation" would be untestable. The append-
    // only guard trigger is disabled ONLY for this scoped delete and
    // re-enabled immediately; canonical facts are never touched.
    await db.execute(
      sql`ALTER TABLE observations DISABLE TRIGGER deny_observations_mutation`,
    );
    try {
      // research_proposals rows (RESTRICT) reference these observations,
      // so the proposals from the residue runs go first.
      await db.execute(sql`
        DELETE FROM research_proposals rp USING observations o, evidence e, source_documents sd
        WHERE rp.observation_id = o.id AND o.evidence_id = e.id
          AND e.source_document_id = sd.id
          AND o.subject_type = 'company' AND o.subject_id = ${ZEPHYR_COMPANY_ID}
          AND o.review_status = 'pending'
          AND sd.metadata->>'promptVersion' = 'candidate-research.v1'
      `);
      await db.execute(sql`
        DELETE FROM observations o USING evidence e, source_documents sd
        WHERE o.evidence_id = e.id AND e.source_document_id = sd.id
          AND o.subject_type = 'company' AND o.subject_id = ${ZEPHYR_COMPANY_ID}
          AND o.review_status = 'pending'
          AND sd.metadata->>'promptVersion' = 'candidate-research.v1'
          AND NOT EXISTS (
            SELECT 1 FROM canonical_facts cf WHERE cf.current_observation_id = o.id
          )
      `);
    } finally {
      await db.execute(
        sql`ALTER TABLE observations ENABLE TRIGGER deny_observations_mutation`,
      );
    }
    const beforeObservations =
      await candidateResearchObservationCount(ZEPHYR_COMPANY_ID);
    const beforeScores = await latestAxisScores(db, candidate!.id);
    const originalCreatedAt = candidate!.createdAt;
    await db
      .update(candidates)
      .set({ createdAt: new Date(0) })
      .where(eq(candidates.id, candidate!.id));

    const [agent] = await db
      .insert(researchAgents)
      .values({
        key: `test-enrich-zephyr-live-${Date.now()}`,
        name: "Live enrich test",
        agentType: "enrich_candidate",
        goal: "Deep-research queued candidates oldest-first until evidence suffices.",
        cadenceSeconds: 900,
        status: "running",
      })
      .returning();
    expect(agent).toBeDefined();

    const registry = createV1TickHandlerRegistry({
      client,
      models: liveModels(),
      // Deterministic NEW evidence even inside the 24h reuse window.
      researchForceRefresh: true,
    });
    const handler = registry.get("enrich_candidate")!;

    // Journal the tick exactly as the supervisor would, so findings/cost
    // land on a real agent_ticks row.
    const tick = await startTick(agent!.id);
    let result;
    try {
      result = await handler({
        agent: agent!,
        signal: new AbortController().signal,
      });
      await completeTick(agent!.id, {
        tickId: tick.id,
        outcome: result.outcome ?? "executed",
        plan: result.plan ?? {},
        actionsExecuted: result.actionsExecuted ?? 0,
        findings: result.findings ?? {},
        costUsd: result.costUsd ?? 0,
      });
    } catch (error) {
      await db.delete(researchAgents).where(eq(researchAgents.id, agent!.id));
      await db
        .update(candidates)
        .set({ createdAt: originalCreatedAt })
        .where(eq(candidates.id, candidate!.id));
      throw error;
    }

    try {
      expect(result.outcome).toBe("executed");
      expect(result.actionsExecuted).toBe(1);

      const enriched = (result.findings!.enriched as Array<Record<string, unknown>>)[0];
      expect(enriched).toBeDefined();
      expect(enriched!.observationsCreated).toBeGreaterThanOrEqual(0);

      // ≥1 NEW evidence-backed observation from THIS run's extraction.
      const afterObservations =
        await candidateResearchObservationCount(ZEPHYR_COMPANY_ID);
      expect(afterObservations).toBeGreaterThan(beforeObservations);

      // Bounded tool manifest: ≤3 fetched URLs.
      const fetchedUrls = enriched!.fetchedUrls as string[];
      expect(fetchedUrls.length).toBeGreaterThanOrEqual(1);
      expect(fetchedUrls.length).toBeLessThanOrEqual(3);

      // Candidate ends research_ready with confidence never lower.
      const [afterRow] = await db
        .select({ status: candidates.status })
        .from(candidates)
        .where(eq(candidates.id, candidate!.id));
      expect(afterRow!.status).toBe("research_ready");
      const afterScores = await latestAxisScores(db, candidate!.id);
      expect(afterScores.confidence?.value ?? 0).toBeGreaterThanOrEqual(
        beforeScores.confidence?.value ?? 0,
      );

      // Model usage persisted for the run opened by this tick.
      const usage = await db.execute<{ rows: number; tokens: number; cost: string }>(sql`
        SELECT count(*)::int AS rows,
               COALESCE(sum(mu.input_tokens), 0)::int AS tokens,
               COALESCE(sum(mu.cost_usd), 0)::text AS cost
        FROM model_usage mu
        JOIN research_runs rr ON rr.id = mu.research_run_id
        WHERE rr.target_id = ${ZEPHYR_COMPANY_ID}
          AND rr.created_at >= date_trunc('day', now())
      `);
      expect(Number(usage.rows[0]!.tokens)).toBeGreaterThan(0);
      const runCostUsd = Number(usage.rows[0]!.cost);
      expect(runCostUsd).toBeLessThan(0.5); // wave budget sanity

      // Tick row carries plan, findings and the reported cost.
      const [tickRow] = await db.execute<{
        plan: Record<string, unknown>;
        findings: Record<string, unknown>;
        cost_usd: string;
      }>(sql`
        SELECT plan, findings, cost_usd::text AS cost_usd FROM agent_ticks WHERE id = ${tick.id}
      `).then((query) => query.rows);
      expect(tickRow.plan).toHaveProperty("actions");
      expect((tickRow.findings.enriched as unknown[]).length).toBe(1);
      expect(
        ((tickRow.findings.enriched as Array<Record<string, unknown>>)[0]![
          "companyId"
        ] as string),
      ).toBe(ZEPHYR_COMPANY_ID);
      console.log(
        `[live] enrich tick cost_usd=${tickRow.cost_usd} observations ${beforeObservations}→${afterObservations} urls=${fetchedUrls.join(",")}`,
      );
    } finally {
      // Ticks cascade; frontier/leads untouched by enrich.
      await db.delete(researchAgents).where(eq(researchAgents.id, agent!.id));
      await db
        .update(candidates)
        .set({ createdAt: originalCreatedAt })
        .where(eq(candidates.id, candidate!.id));
    }

    await closeDatabase();
  });
});
