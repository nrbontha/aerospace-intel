import { and, eq, sql } from "drizzle-orm";
import type {
  CandidateDto,
  ScoreRecordDto,
  TierOverride,
} from "@asi/contracts";
import { resolveEffectiveTier, tierToInvestmentAction } from "@asi/contracts";

import type { Database } from "../client.js";
import {
  auditEvents,
  candidates,
  candidateScores,
  featureSnapshots,
  feedback,
  scoringPrograms,
  type Candidate,
  type CandidateScore,
  type FeatureSnapshot,
} from "../schema.js";

/**
 * Storage layer for the candidate engine: plain CRUD over the
 * candidates / candidate_scores / feature_snapshots / scoring_programs
 * tables. All SCORING decisions are made upstream (apps/web scoring glue)
 * and arrive here as precomputed plain arguments — this module never
 * imports the scoring engine.
 */

type TxLike = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type DbOrTx = Database | TxLike;

export interface ChampionSeed {
  name: string;
  version: number;
  axis: "fit" | "actionability";
  program: Record<string, unknown>;
  complexity: number;
}

export type ScoreAxisName = "fit" | "novelty" | "confidence" | "actionability";

export interface ScoreAppendix {
  axis: ScoreAxisName;
  value: number | null;
  scoringProgramId: string | null;
  featureSchemaVersion: string;
  details: Record<string, unknown>;
}

export interface LatestAxisScore {
  value: number | null;
  scoringProgramId: string | null;
  computedAt: Date;
}

export type LatestAxisScoreMap = Partial<Record<ScoreAxisName, LatestAxisScore>>;

/**
 * Insert-or-get each seeded champion program (name+version natural key).
 * Transactional: concurrent first promotions converge on one row.
 */
export async function ensureChampionPrograms(
  tx: TxLike,
  seeds: readonly ChampionSeed[],
): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const seed of seeds) {
    await tx
      .insert(scoringPrograms)
      .values({
        name: seed.name,
        version: seed.version,
        axis: seed.axis,
        program: seed.program,
        status: "champion",
        complexity: seed.complexity.toFixed(3),
      })
      .onConflictDoNothing({
        target: [scoringPrograms.name, scoringPrograms.version],
      });
    const found = await tx
      .select({ id: scoringPrograms.id })
      .from(scoringPrograms)
      .where(and(eq(scoringPrograms.name, seed.name), eq(scoringPrograms.version, seed.version)))
      .limit(1);
    const id = found[0]?.id;
    if (id === undefined) {
      throw new Error(`scoring_programs row missing after insert-or-get: ${seed.name}`);
    }
    ids[seed.name] = id;
  }
  return ids;
}

/** Insert the feature snapshot unless byte-identical content already exists. */
export async function ensureFeatureSnapshot(
  tx: TxLike,
  input: {
    companyId: string;
    schemaVersion: string;
    contentSha256: string;
    features: Record<string, unknown>;
    thesisVersion?: string;
  },
): Promise<FeatureSnapshot> {
  await tx
    .insert(featureSnapshots)
    .values({
      companyId: input.companyId,
      schemaVersion: input.schemaVersion,
      contentSha256: input.contentSha256,
      features: input.features,
      ...(input.thesisVersion === undefined ? {} : { thesisVersion: input.thesisVersion }),
    })
    .onConflictDoNothing({
      target: [
        featureSnapshots.companyId,
        featureSnapshots.schemaVersion,
        featureSnapshots.contentSha256,
      ],
    });
  const found = await tx
    .select()
    .from(featureSnapshots)
    .where(
      and(
        eq(featureSnapshots.companyId, input.companyId),
        eq(featureSnapshots.schemaVersion, input.schemaVersion),
        eq(featureSnapshots.contentSha256, input.contentSha256),
      ),
    )
    .limit(1);
  const snapshot = found[0];
  if (snapshot === undefined) {
    throw new Error("feature_snapshots row missing after insert-or-get");
  }
  return snapshot;
}

export interface CandidateUpsertValues {
  companyId: string;
  /** Routing applied ONLY on first insert; analyst-set statuses survive updates. */
  routedStatus: string;
  noveltyStatus: string;
  noveltySnapshotIds: string[];
  rationale: {
    whyInteresting: string[];
    risks: string[];
    unknowns: string[];
  };
  currentScores: Partial<Record<ScoreAxisName, number | null>>;
  researchPriority: number | null;
  partnerReviewPriority: number | null;
}

/**
 * Idempotent candidate upsert keyed by company_id. On conflict every
 * computed column refreshes but `status` is deliberately NOT touched:
 * human routing (shortlist/hold/rejected/…) must never be silently reset
 * by a re-promotion.
 */
export async function upsertCandidate(
  tx: TxLike,
  values: CandidateUpsertValues,
): Promise<Candidate> {
  const rows = await tx
    .insert(candidates)
    .values({
      companyId: values.companyId,
      status: values.routedStatus as Candidate["status"],
      noveltyStatus: values.noveltyStatus as Candidate["noveltyStatus"],
      noveltySnapshotIds: values.noveltySnapshotIds,
      rationale: values.rationale,
      currentScores: values.currentScores,
      researchPriority:
        values.researchPriority === null ? null : values.researchPriority.toFixed(2),
      partnerReviewPriority:
        values.partnerReviewPriority === null ? null : values.partnerReviewPriority.toFixed(2),
      // New candidates start on the engine-owned tier derived from routing.
      tierOverride: null,
      tierSource: "engine",
    })
    .onConflictDoUpdate({
      target: candidates.companyId,
      set: {
        noveltyStatus: sql`excluded.novelty_status`,
        noveltySnapshotIds: sql`excluded.novelty_snapshot_ids`,
        rationale: sql`excluded.rationale`,
        currentScores: sql`excluded.current_scores`,
        researchPriority: sql`excluded.research_priority`,
        partnerReviewPriority: sql`excluded.partner_review_priority`,
        // Engine re-routing owns the tier ONLY while it is still
        // engine-sourced; a human override (tier_source='human') survives
        // every re-promotion — same rule as analyst-set statuses above.
        tierOverride: sql`${candidates.tierOverride}`,
        tierSource: sql`CASE WHEN ${candidates.tierSource} = 'human'
          THEN ${candidates.tierSource} ELSE 'engine' END`,
      },
    })
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`candidates upsert returned no row for company ${values.companyId}`);
  }
  return row;
}

/** Append-only: candidate_scores rows are NEVER updated or deleted. */
export async function appendScoreRows(
  tx: TxLike,
  candidateId: string,
  scores: readonly ScoreAppendix[],
): Promise<CandidateScore[]> {
  if (scores.length === 0) return [];
  return tx
    .insert(candidateScores)
    .values(
      scores.map((score) => ({
        candidateId,
        axis: score.axis,
        value: score.value === null ? null : score.value.toFixed(2),
        ...(score.scoringProgramId === null ? {} : { scoringProgramId: score.scoringProgramId }),
        featureSchemaVersion: score.featureSchemaVersion,
        details: score.details,
      })),
    )
    .returning();
}

export async function getCandidateById(
  db: Database,
  candidateId: string,
): Promise<Candidate | null> {
  const rows = await db.select().from(candidates).where(eq(candidates.id, candidateId)).limit(1);
  return rows[0] ?? null;
}

export async function getCandidateByCompanyId(
  db: Database,
  companyId: string,
): Promise<Candidate | null> {
  const rows = await db
    .select()
    .from(candidates)
    .where(eq(candidates.companyId, companyId))
    .limit(1);
  return rows[0] ?? null;
}
export async function updateCandidateStatus(
  db: Database,
  input: {
    candidateId: string;
    status: string;
    /** Set when the change comes from the API — writes an audit event. */
    actor?: string;
  },
): Promise<Candidate> {
  return db.transaction(async (tx) => {
    const current = await tx
      .select({ status: candidates.status })
      .from(candidates)
      .where(eq(candidates.id, input.candidateId))
      .limit(1);
    const before = current[0]?.status;
    const rows = await tx
      .update(candidates)
      .set({ status: input.status as Candidate["status"] })
      .where(eq(candidates.id, input.candidateId))
      .returning();
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`candidate ${input.candidateId} not found`);
    }
    if (input.actor !== undefined) {
      await tx.insert(auditEvents).values({
        actorUserId: input.actor,
        action: "candidate.status_change",
        entityType: "candidate",
        entityId: row.id,
        before: { status: before ?? null },
        after: { status: row.status },
      });
    }
    return row;
  });
}

/** Latest appended score per axis — used for change-detection on re-promotion. */
export async function latestAxisScores(
  db: DbOrTx,
  candidateId: string,
): Promise<LatestAxisScoreMap> {
  const rows = await db.execute<{
    axis: ScoreAxisName;
    value: string | null;
    scoring_program_id: string | null;
    computed_at: Date;
  }>(sql`
    SELECT DISTINCT ON (axis) axis::text AS axis, value, scoring_program_id, computed_at
    FROM candidate_scores WHERE candidate_id = ${candidateId}
    ORDER BY axis, computed_at DESC, id DESC
  `);
  const out: LatestAxisScoreMap = {};
  for (const row of rows.rows) {
    out[row.axis] = {
      value: row.value === null ? null : Number(row.value),
      scoringProgramId: row.scoring_program_id,
      computedAt: new Date(row.computed_at),
    };
  }
  return out;
}

export async function latestFeatureSnapshotForCompany(
  db: DbOrTx,
  companyId: string,
): Promise<FeatureSnapshot | null> {
  const rows = await db
    .select()
    .from(featureSnapshots)
    .where(eq(featureSnapshots.companyId, companyId))
    .orderBy(sql`created_at DESC, id DESC`)
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// DTO shaping
// ---------------------------------------------------------------------------

function numericToNumber(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function instant(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toCandidateDto(row: Candidate): CandidateDto {
  const currentScores: Record<string, number | null> = {};
  for (const [axis, value] of Object.entries(row.currentScores)) {
    currentScores[axis] = value ?? null;
  }
  return {
    id: row.id,
    companyId: row.companyId,
    status: row.status,
    noveltyStatus: row.noveltyStatus,
    noveltySnapshotIds: row.noveltySnapshotIds,
    rationale: row.rationale,
    currentScores,
    researchPriority: numericToNumber(row.researchPriority),
    partnerReviewPriority: numericToNumber(row.partnerReviewPriority),
    createdAt: instant(row.createdAt),
    updatedAt: instant(row.updatedAt),
    tierOverride: row.tierOverride,
    tierSource: row.tierSource,
    effectiveTier: resolveEffectiveTier(row.status, row.tierOverride),
  };
}

/**
 * Human tier override (REDESIGN_PLAN §2.1). Writes the override + flips
 * tier_source to 'human' (engine re-routing never clobbers it), records the
 * corresponding investment feedback journal entry, and lands a
 * 'candidate.tier_overridden' audit event — all in one transaction.
 */
export async function setHumanTier(
  db: Database,
  input: {
    candidateId: string;
    tier: TierOverride;
    actorId: string;
    note?: string;
  },
): Promise<Candidate> {
  return db.transaction(async (tx) => {
    const current = await tx
      .select()
      .from(candidates)
      .where(eq(candidates.id, input.candidateId))
      .limit(1);
    const before = current[0];
    if (before === undefined) {
      throw new Error(`candidate ${input.candidateId} not found`);
    }

    const rows = await tx
      .update(candidates)
      .set({ tierOverride: input.tier, tierSource: "human" })
      .where(eq(candidates.id, input.candidateId))
      .returning();
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`candidate ${input.candidateId} update returned no row`);
    }

    const action = tierToInvestmentAction[input.tier];
    const feedbackRows = await tx
      .insert(feedback)
      .values({
        channel: "investment",
        action,
        companyId: before.companyId,
        candidateId: row.id,
        reason: input.note ?? null,
        payload: {
          tierOverride: input.tier,
          previousTierOverride: before.tierOverride,
          previousTierSource: before.tierSource,
        },
        notes: input.note ?? null,
        actor: input.actorId,
      })
      .returning({ id: feedback.id });
    const feedbackRow = feedbackRows[0];

    await tx.insert(auditEvents).values({
      actorUserId: input.actorId,
      action: "candidate.tier_overridden",
      entityType: "candidate",
      entityId: row.id,
      before: {
        status: before.status,
        tierOverride: before.tierOverride,
        tierSource: before.tierSource,
      },
      after: { tierOverride: row.tierOverride, tierSource: row.tierSource },
      ...(feedbackRow === undefined ? {} : { metadata: { feedbackId: feedbackRow.id } }),
    });

    return row;
  });
}

export function toScoreRecordDto(row: CandidateScore): ScoreRecordDto {
  return {
    id: row.id,
    candidateId: row.candidateId,
    axis: row.axis,
    value: numericToNumber(row.value),
    scoringProgramId: row.scoringProgramId,
    featureSchemaVersion: row.featureSchemaVersion,
    details: row.details,
    computedAt: instant(row.computedAt),
  };
}
