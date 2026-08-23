/**
 * DB-gated integration suite for the candidate promotion engine.
 *
 *   ASI_DB_TESTS=1 DATABASE_URL=postgres://... npx vitest run tests/candidates.db.test.ts
 *
 * Requires a docker Postgres with migrations applied. The suite imports the
 * real gitignored datasets (data/) so the Skybolt novelty case runs against
 * the actual golden-set snapshots, and synthesizes canonical catalog rows
 * via Drizzle inserts. Seeding is idempotent: observation tables are
 * append-only, so repeated runs REUSE the synthetic companies instead of
 * recreating them.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { feedbackCreateSchema } from "@asi/contracts";

import {
  certifications,
  closeDatabase,
  companies,
  companyDomains,
  companyIdentifiers,
  createFeedbackRecord,
  createResearchQuestionRecord,
  dataSources,
  employeeObservations,
  evidence,
  facilities,
  facilityQualifications,
  financialObservations,
  getDatabase,
  candidateDetail,
  listResearchQuestionRecords,
  ownershipObservations,
  parts,
  platformFamilies,
  platforms,
  queryCandidates,
  sourceDocuments,
  updateCandidateStatus,
  updateResearchQuestionRecord,
} from "@asi/database";

import type { FeatureVector } from "../packages/research/src/scoring-axial/features.js";
import { computeConfidence } from "../packages/research/src/scoring-axial/index.js";

import { promoteCompany, rescoreCandidate } from "../apps/web/src/lib/candidate-scoring.js";

import { runMigrations } from "../packages/database/src/migrate.js";

const execFileAsync = promisify(execFile);
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

async function countRows(query: ReturnType<typeof sql>): Promise<number> {
  const result = await getDatabase().execute<{ c: number }>(query);
  return result.rows[0]?.c ?? 0;
}

async function findOrInsertCompany(
  displayName: string,
  legalName: string,
): Promise<{ id: string; reused: boolean }> {
  const db = getDatabase();
  const existing = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.displayName, displayName))
    .limit(1);
  if (existing[0] !== undefined) return { id: existing[0].id, reused: true };
  const inserted = await db
    .insert(companies)
    .values({ legalName, displayName, headquartersCountryCode: "US" })
    .returning({ id: companies.id });
  return { id: inserted[0]!.id, reused: false };
}

function uuidArraySql(ids: string[]): ReturnType<typeof sql.raw> {
  return sql.raw(`ARRAY[${ids.map((id) => `'${id}'::uuid`).join(",")}]`);
}

const RUN_TAG = Date.now().toString(36);

describe.skipIf(!DB_TESTS_ENABLED)("candidate engine (DB)", () => {
  let companyId: string;
  let actorId: string;
  let skyboltId: string;
  let candidateId: string;

  beforeAll(async () => {
    loadDatabaseUrl();
    await runMigrations();
    // Real golden-set snapshots so the Skybolt novelty case has live data.
    const snapshotCount = await countRows(
      sql`SELECT count(*)::int AS c FROM known_universe_snapshots`,
    );
    if (snapshotCount === 0 && existsSync(repoPath("data/golden-set-v01.xlsx"))) {
      await execFileAsync("npx", ["tsx", "scripts/import-datasets.ts"], {
        cwd: process.cwd(),
        maxBuffer: 10 * 1024 * 1024,
      });
    }

    const db = getDatabase();

    const existingUser = await db.execute<{ id: string }>(sql`
      SELECT id FROM users WHERE lower(email) = 'candidates-engine-test@example.invalid'
    `);
    if (existingUser.rows[0] !== undefined) {
      actorId = existingUser.rows[0].id;
    } else {
      const newUser = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, display_name, role, password_hash)
        VALUES ('candidates-engine-test@example.invalid', 'Engine Test', 'analyst', 'x')
        RETURNING id
      `);
      actorId = newUser.rows[0]!.id;
    }

    const aero = await findOrInsertCompany(
      `Aero Precision Machining ${RUN_TAG}`,
      `Aero Precision Machining ${RUN_TAG} LLC`,
    );
    companyId = aero.id;
    const skybolt = await findOrInsertCompany(
      "Skybolt Aerospace Fasteners",
      "Skybolt Aerospace Fasteners",
    );
    skyboltId = skybolt.id;

    if (!aero.reused) {
      await db.insert(companyDomains).values({
        companyId,
        domain: `aero-${RUN_TAG}.example`,
        isPrimary: true,
        verifiedAt: new Date(),
      });
      await db.insert(companyIdentifiers).values({
        companyId,
        type: "cage",
        value: `7ABC${RUN_TAG.toUpperCase()}`,
        issuingCountryCode: "US",
      });

      // Three distinct sources (one primary-by-heuristic) feed evidence counts.
      const sourceRows = await db
        .insert(dataSources)
        .values([
          { name: `engine-test-gov-${companyId}`, sourceType: "government", access: "authorized" },
          { name: `engine-test-pub1-${companyId}`, sourceType: "news" },
          { name: `engine-test-pub2-${companyId}`, sourceType: "news" },
        ])
        .returning({ id: dataSources.id });
      let firstEvidenceId: string | null = null;
      for (const source of sourceRows) {
        const doc = await db
          .insert(sourceDocuments)
          .values({ dataSourceId: source.id, canonicalUrl: `https://example.invalid/${source.id}` })
          .returning({ id: sourceDocuments.id });
        const ev = await db
          .insert(evidence)
          .values({
            sourceDocumentId: doc[0]!.id,
            extractionMethod: "test",
            quote: "Synthetic evidence quote for the candidate engine test.",
            locator: "p.1",
          })
          .returning({ id: evidence.id });
        firstEvidenceId ??= ev[0]!.id;
      }
      const evidenceId = firstEvidenceId!;

      await db.insert(financialObservations).values({
        companyId,
        metric: "revenue",
        amountLower: "7000000",
        amountUpper: "11000000",
        currency: "USD",
        confidence: "0.9000",
        evidenceId,
      });
      await db.insert(employeeObservations).values({
        companyId,
        employeeCountLower: 30,
        employeeCountUpper: 50,
        confidence: "0.8000",
        evidenceId,
      });
      await db.insert(ownershipObservations).values({
        companyId,
        type: "private",
        ownerName: "Founder Family",
        confidence: "0.9500",
        evidenceId,
      });
      await db.insert(certifications).values({
        companyId,
        standard: "AS9100D",
        status: "active",
      });

      // Platform linkage via facility qualification chain.
      const facility = await db
        .insert(facilities)
        .values({ companyId, name: "Plant 1", countryCode: "US" })
        .returning({ id: facilities.id });
      const part = await db
        .insert(parts)
        .values({ manufacturerCompanyId: companyId, partNumber: `PN-001-${RUN_TAG}` })
        .returning({ id: parts.id });
      await db
        .insert(platformFamilies)
        .values({ name: `F-35 Engine Test Family ${RUN_TAG}` })
        .onConflictDoNothing();
      const family = await db
        .select({ id: platformFamilies.id })
        .from(platformFamilies)
        .where(eq(platformFamilies.name, `F-35 Engine Test Family ${RUN_TAG}`));
      const platform = await db
        .insert(platforms)
        .values({ name: `F-35A Engine Test Variant ${RUN_TAG}`, familyId: family[0]!.id })
        .returning({ id: platforms.id });
      await db.insert(facilityQualifications).values({
        facilityId: facility[0]!.id,
        partId: part[0]!.id,
        platformId: platform[0]!.id,
      });
    }

    if (!skybolt.reused) {
      await db.insert(companyDomains).values({
        companyId: skyboltId,
        domain: "skybolt.com",
        isPrimary: true,
        verifiedAt: new Date(),
      });
    }

    // Fresh candidate-engine state where the tables allow deletes.
    const fixtureArray = uuidArraySql([companyId, skyboltId]);
    await db.execute(sql`DELETE FROM feedback WHERE candidate_id IN (SELECT id FROM candidates WHERE company_id = ANY(${fixtureArray}))`);
    await db.execute(sql`DELETE FROM research_questions WHERE candidate_id IN (SELECT id FROM candidates WHERE company_id = ANY(${fixtureArray}))`);
  });

  afterAll(async () => {
    const db = getDatabase();
    // Observation tables are append-only and RESTRICT company deletes, so
    // the synthetic companies persist as reusable fixtures; all mutable
    // candidate-engine state is cleared instead.
    const fixtureIds = [companyId, skyboltId].filter((id) => id !== undefined);
    if (fixtureIds.length > 0) {
      const fixtureArray = uuidArraySql(fixtureIds);
      await db.execute(sql`DELETE FROM feedback WHERE candidate_id IN (SELECT id FROM candidates WHERE company_id = ANY(${fixtureArray}))`);
      await db.execute(sql`DELETE FROM research_questions WHERE candidate_id IN (SELECT id FROM candidates WHERE company_id = ANY(${fixtureArray}))`);
    }
    await closeDatabase();
  });

  it("promotes a canonical company to a scored candidate", async () => {
    const db = getDatabase();
    const result = await promoteCompany(db, companyId);
    expect(result.appendedScoreRows).toBe(true);
    candidateId = result.candidate.id;

    const detail = await candidateDetail(db, result.candidate.id);
    expect(detail).not.toBeNull();
    const axes = detail!.candidate.currentScores;
    expect(Object.keys(axes).sort()).toEqual([
      "actionability",
      "confidence",
      "fit",
      "novelty",
    ]);
    expect(detail!.scores.length).toBeGreaterThanOrEqual(4);
    expect(detail!.featureSnapshot).not.toBeNull();
    expect(detail!.featureSnapshot!.contentSha256).toMatch(/^[a-f0-9]{64}$/);

    // Confidence axis must equal the engine recomputation from the stored
    // feature snapshot — provenance round-trips.
    const vector = detail!.featureSnapshot!.features as unknown as FeatureVector;
    const recomputed = computeConfidence(vector.evidence);
    expect(axes.confidence).toBe(recomputed);

    // Latest score per axis carries program provenance on program-driven
    // axes; none on pure-function axes.
    const latest = detail!.scores[0];
    void latest;
    const fitRow = detail!.scores.find((score) => score.axis === "fit")!;
    const actionabilityRow = detail!.scores.find(
      (score) => score.axis === "actionability",
    )!;
    const noveltyRow = detail!.scores.find((score) => score.axis === "novelty")!;
    expect(fitRow.scoringProgramId).not.toBeNull();
    expect(actionabilityRow.scoringProgramId).not.toBeNull();
    expect(noveltyRow.scoringProgramId).toBeNull();

    // With datasets imported the active-snapshot verdicts make novelty
    // assessable for this fresh-domain company: no member matches.
    expect(detail!.candidate.noveltyStatus).toBe("not_matched_to_current_known_universe");
    expect(detail!.candidate.researchPriority).not.toBeNull();
    expect(detail!.candidate.partnerReviewPriority).not.toBeNull();
  });

  it("is idempotent on re-promotion and appends history only on rescore", async () => {
    const db = getDatabase();
    const before = await countRows(
      sql`SELECT count(*)::int AS c FROM candidate_scores WHERE candidate_id = ${candidateId}`,
    );
    const again = await promoteCompany(db, companyId);
    expect(again.appendedScoreRows).toBe(false);
    const afterIdentical = await countRows(
      sql`SELECT count(*)::int AS c FROM candidate_scores WHERE candidate_id = ${candidateId}`,
    );
    expect(afterIdentical).toBe(before);

    const rescored = await rescoreCandidate(db, candidateId);
    expect(rescored.appendedScoreRows).toBe(true);
    const afterRescore = await countRows(
      sql`SELECT count(*)::int AS c FROM candidate_scores WHERE candidate_id = ${candidateId}`,
    );
    expect(afterRescore).toBe(afterIdentical + 4);
  });

  it("keeps candidate_scores append-only (trigger denies UPDATE/DELETE)", async () => {
    const db = getDatabase();
    // Drizzle wraps the pg error; the trigger text lives on the cause.
    const updateError = await db
      .execute(sql`UPDATE candidate_scores SET value = 99 WHERE candidate_id = ${candidateId}`)
      .catch((caught) => caught);
    expect(String(updateError?.cause ?? updateError)).toMatch(/append-only/i);
    const deleteError = await db
      .execute(sql`DELETE FROM candidate_scores WHERE candidate_id = ${candidateId}`)
      .catch((caught) => caught);
    expect(String(deleteError?.cause ?? deleteError)).toMatch(/append-only/i);
  });

  it("computes possible_known_universe_match for Skybolt vs the golden set", async () => {
    const result = await promoteCompany(getDatabase(), skyboltId);
    // skybolt.com is an active-snapshot member across the golden-set /
    // grata / pipeline snapshots but resolves to no canonical company →
    // probable per snapshot → possible_known_universe_match.
    expect(result.candidate.noveltyStatus).toBe("possible_known_universe_match");
    expect(result.candidate.currentScores.novelty).toBe(25);
    expect(result.candidate.noveltySnapshotIds.length).toBeGreaterThanOrEqual(3);
  });

  it("round-trips feedback and rejects invalid channel/action pairs", async () => {
    const db = getDatabase();
    const created = await createFeedbackRecord(db, {
      channel: "investment",
      action: "shortlist",
      candidateId,
      reason: "Strong fit in test",
      actor: actorId,
    });
    expect(created.channel).toBe("investment");
    expect(created.actor).toBe(actorId);

    // Invalid investment action must be refused by the contract schema —
    // the API maps this exact failure to HTTP 400.
    const invalid = feedbackCreateSchema.safeParse({
      channel: "investment",
      action: "duplicate",
      candidateId,
    });
    expect(invalid.success).toBe(false);
  });

  it("exercises the research question lifecycle", async () => {
    const db = getDatabase();
    const created = await createResearchQuestionRecord(db, {
      candidateId,
      question: "Who is the current owner of record?",
      priority: 80,
    });
    expect(created.status).toBe("open");

    const listed = await listResearchQuestionRecords(db, {
      candidateId,
      page: 1,
      pageSize: 25,
    });
    expect(listed.records.map((record) => record.id)).toContain(created.id);

    const answered = await updateResearchQuestionRecord(db, {
      questionId: created.id,
      answer: { owner: "Founder Family", since: "1998" },
      status: "answered",
    });
    expect(answered!.status).toBe("answered");
    expect(answered!.closedAt).not.toBeNull();

    const reopened = await updateResearchQuestionRecord(db, {
      questionId: created.id,
      status: "open",
    });
    expect(reopened!.closedAt).toBeNull();
  });

  it("supports analyst status changes with audit trail and filtered listing", async () => {
    const db = getDatabase();
    const updated = await updateCandidateStatus(db, {
      candidateId,
      status: "shortlist",
      actor: actorId,
    });
    expect(updated.status).toBe("shortlist");

    const audits = await countRows(sql`
      SELECT count(*)::int AS c FROM audit_events
      WHERE entity_type = 'candidate' AND entity_id = ${candidateId}
        AND action = 'candidate.status_change'
    `);
    expect(audits).toBeGreaterThanOrEqual(1);

    // Re-promotion must NOT reset the human-set status.
    const rerun = await promoteCompany(db, companyId);
    expect(rerun.candidate.status).toBe("shortlist");

    const filtered = await queryCandidates(db, {
      page: 1,
      pageSize: 25,
      minConfidence: 0,
      maxConfidence: 100,
    });
    expect(filtered.records.some((record) => record.id === candidateId)).toBe(true);
    const none = await queryCandidates(db, { page: 1, pageSize: 25, minFit: 101 });
    expect(none.records).toHaveLength(0);
  });
});
