/**
 * DB-gated integration suite for F1: production scoring resolves the LIVE
 * champion program from scoring_programs and falls back to the shipped
 * default only when no champion exists.
 *
 *   ASI_DB_TESTS=1 DATABASE_URL=postgres://... npx vitest run tests/champion-program.db.test.ts
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDatabase,
  companies,
  companyDomains,
  dataSources,
  evidence,
  financialObservations,
  getDatabase,
  latestAxisScores,
  scoringPrograms,
  sourceDocuments,
  upsertCandidate,
} from "@asi/database";
import {
  DEFAULT_FIT_PROGRAM,
  getChampionProgramOrFallback,
  scoringProgramSchema,
} from "@asi/research/scoring-axial";
import { rescoreCandidateAfterResearch } from "../packages/research/src/campaigns/candidate-research.js";
import { promoteProgram, upsertProgram } from "../packages/database/src/experiments/journal.js";
import { runMigrations } from "../packages/database/src/migrate.js";

const DB_TESTS_ENABLED = process.env.ASI_DB_TESTS === "1";
const repoPath = (suffix: string) => path.join(process.cwd(), suffix);

function loadDatabaseUrl(): void {
  if (process.env.DATABASE_URL !== undefined && process.env.DATABASE_URL !== "") return;
  for (const candidate of [repoPath(".env.local"), repoPath(".env")]) {
    if (!existsSync(candidate)) continue;
    for (const line of readFileSync(candidate, "utf8").split("\n")) {
      const match = /^DATABASE_URL=(.*)$/.exec(line.trim());
      if (match?.[1] !== undefined) {
        process.env.DATABASE_URL = match[1].trim();
        return;
      }
    }
  }
}

const RUN_TAG = randomUUID().slice(0, 8);

/**
 * Champion variant that shifts weight from revenue band to AS9100 — both
 * features are PRESENT for the synthetic company, so the score moves
 * deterministically. (Veto clauses cannot fire on 'unknown' facts by design:
 * clauseMatches refuses positive equals/in matches on missing values.)
 */
function weightShiftChallenger() {
  return scoringProgramSchema.parse({
    ...DEFAULT_FIT_PROGRAM,
    name: `dbtest-fit-shift-${RUN_TAG}`,
    version: 1,
    components: DEFAULT_FIT_PROGRAM.components.map((component) => {
      if (component.feature === "qualifications.as9100") {
        return { ...component, weight: component.weight + 0.1 };
      }
      if (component.feature === "size.revenueBand") {
        return { ...component, weight: component.weight - 0.1 };
      }
      return component;
    }),
  });
}

describe.skipIf(!DB_TESTS_ENABLED)("champion resolution (DB)", () => {
  let companyId: string;
  let candidateId: string;
  /** Exact prior status of every fit-axis program touched by this suite. */
  let priorFitStatuses: Array<{ id: string; status: string }> = [];

  beforeAll(async () => {
    loadDatabaseUrl();
    await runMigrations();
    const db = getDatabase();

    priorFitStatuses = (
      await db.execute<{ id: string; status: string }>(
        sql`SELECT id, status::text AS status FROM scoring_programs WHERE axis='fit'`,
      )
    ).rows.map((row) => ({ id: row.id, status: row.status }));

    const [company] = await db
      .insert(companies)
      .values({
        legalName: `Champion Test ${RUN_TAG} LLC`,
        displayName: `Champion Test ${RUN_TAG}`,
        headquartersCountryCode: "US",
      })
      .returning({ id: companies.id });
    companyId = company!.id;
    await db.insert(companyDomains).values({
      companyId,
      domain: `champion-${RUN_TAG}.example`,
      isPrimary: true,
      verifiedAt: new Date(),
    });

    // A revenue observation satisfies DEFAULT_FIT_PROGRAM's <$50m requirement;
    // without it the unknown band hard-vetoes every variant and scores stay null.
    const [source] = await db
      .insert(dataSources)
      .values({ name: `champion-test-${RUN_TAG}`, sourceType: "news" })
      .returning({ id: dataSources.id });
    const [doc] = await db
      .insert(sourceDocuments)
      .values({ dataSourceId: source.id, canonicalUrl: `https://example.invalid/${source.id}` })
      .returning({ id: sourceDocuments.id });
    const [ev] = await db
      .insert(evidence)
      .values({
        sourceDocumentId: doc.id,
        extractionMethod: "test",
        quote: "Synthetic revenue evidence for the champion test.",
        locator: "p.1",
      })
      .returning({ id: evidence.id });
    await db.insert(financialObservations).values({
      companyId,
      metric: "revenue",
      amountLower: "7000000",
      amountUpper: "11000000",
      currency: "USD",
      confidence: "0.9000",
      evidenceId: ev.id,
    });

    const candidate = await upsertCandidate(db, {
      companyId,
      routedStatus: "queued_research",
      noveltyStatus: "unable_to_assess",
      noveltySnapshotIds: [],
      rationale: { whyInteresting: [], risks: [], unknowns: [] },
      currentScores: { fit: null, novelty: null, confidence: 0, actionability: null },
      researchPriority: null,
      partnerReviewPriority: null,
    });
    candidateId = candidate.id;
  });

  afterAll(async () => {
    const db = getDatabase();
    // Restore EXACT prior statuses (never delete rows).
    const priorIds = new Set(priorFitStatuses.map((row) => row.id));
    // Anything this suite promoted to champion that was not a prior champion
    // goes back to challenger.
    const currentChampions = (
      await db.execute<{ id: string }>(
        sql`SELECT id FROM scoring_programs WHERE axis='fit' AND status='champion'`,
      )
    ).rows.map((row) => row.id);
    for (const id of currentChampions) {
      if (!priorIds.has(id)) {
        await db
          .update(scoringPrograms)
          .set({ status: "challenger" })
          .where(eq(scoringPrograms.id, id));
      }
    }
    for (const row of priorFitStatuses) {
      await db
        .update(scoringPrograms)
        .set({ status: row.status as "champion" | "challenger" | "archived" | "rejected" })
        .where(eq(scoringPrograms.id, row.id));
    }
    await closeDatabase();
  });

  it("rescore stamps the promoted challenger id and its changed score", async () => {
    const db = getDatabase();

    await rescoreCandidateAfterResearch(db, candidateId);
    const baselineScores = await latestAxisScores(db, candidateId);
    expect(baselineScores.fit).toBeDefined();
    expect(baselineScores.fit?.value).not.toBeNull();

    // Promote the weight-shift variant to fit champion.
    const registered = await upsertProgram(db, {
      name: `dbtest-fit-shift-${RUN_TAG}`,
      version: 1,
      axis: "fit",
      program: weightShiftChallenger() as unknown as Record<string, unknown>,
    });
    await promoteProgram(db, registered.id, "dbtest: weight shift", null);

    const rescored = await rescoreCandidateAfterResearch(db, candidateId);
    const scores = await latestAxisScores(db, candidateId);
    // The appended row reflects the NEW champion program and its score.
    expect(scores.fit?.scoringProgramId).toBe(registered.id);
    expect(scores.fit?.value).not.toBeNull();
    expect(scores.fit?.value).not.toBe(baselineScores.fit?.value);
    expect(scores.fit?.value).toBe(rescored.scores.fit);
  });

  it("falls back to the shipped default when no champion exists", async () => {
    const db = getDatabase();
    // Archive every fit champion (status UPDATE — never delete rows).
    await db.execute(
      sql`UPDATE scoring_programs SET status='archived' WHERE axis='fit' AND status='champion'`,
    );

    const resolved = await getChampionProgramOrFallback(db, "fit");
    expect(resolved.scoringProgramId).toBeNull();
    expect(resolved.program.name).toBe("default-fit-v1");

    await rescoreCandidateAfterResearch(db, candidateId);
    const scores = await latestAxisScores(db, candidateId);
    // Fallback stamp is honest: no champion row ⇒ null program id.
    expect(scores.fit?.scoringProgramId).toBeNull();
    expect(scores.fit?.value).not.toBeNull();
  });
});
