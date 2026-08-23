import { inArray, sql, type SQL } from "drizzle-orm";

import {
  engineStatusToTier,
  type CandidateDto,
  type CandidateListQuery,
  type EffectiveTier,
  type ScoreRecordDto,
} from "@asi/contracts";
import type { Database } from "../client.js";
import { candidates, candidateScores, featureSnapshots } from "../schema.js";
import { toCandidateDto, toScoreRecordDto } from "./storage.js";

/**
 * Filtered candidate listing. Axis-range predicates run against the
 * denormalized current_scores jsonb (NULL axis values fail the comparison
 * and drop out naturally); default sort is partner_review_priority
 * descending, nulls last.
 */
function instant(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// SQL mirror of engineStatusToTier + tier_override precedence, generated FROM
// the shared mapping record so the ?tier= filter can never drift from
// resolveEffectiveTier. COALESCE: human override first, else engine route.
const effectiveTierSql = sql`COALESCE(c.tier_override::text, CASE c.status::text ${sql.join(
  (
    Object.entries(engineStatusToTier) as [string, EffectiveTier][]
  ).map(([status, tier]) => sql`WHEN ${status} THEN ${tier}`),
  sql` `,
)} END)`;

export interface CandidateListPage {
  records: CandidateDto[];
  page: number;
  pageSize: number;
  total: number;
}

const AXIS_FILTER_KEYS: Record<string, string> = {
  minFit: "fit",
  maxFit: "fit",
  minNovelty: "novelty",
  maxNovelty: "novelty",
  minConfidence: "confidence",
  maxConfidence: "confidence",
  minActionability: "actionability",
  maxActionability: "actionability",
};

export async function queryCandidates(
  db: Database,
  filters: CandidateListQuery,
): Promise<CandidateListPage> {
  const conditions: SQL[] = [];
  if (filters.status !== undefined) conditions.push(sql`c.status = ${filters.status}`);
  if (filters.noveltyStatus !== undefined) {
    conditions.push(sql`c.novelty_status = ${filters.noveltyStatus}`);
  }
  if (filters.tier !== undefined) {
    conditions.push(sql`${effectiveTierSql} = ${filters.tier}`);
  }
  for (const [key, value] of Object.entries(filters)) {
    const axis = AXIS_FILTER_KEYS[key];
    if (axis === undefined) continue;
    const comparison = key.startsWith("min") ? sql`>=` : sql`<=`;
    conditions.push(
      sql`(c.current_scores ->> ${axis})::double precision ${comparison} ${value}`,
    );
  }
  const whereClause =
    conditions.length === 0 ? sql`` : sql` WHERE ${sql.join(conditions, sql` AND `)}`;
  const offset = (filters.page - 1) * filters.pageSize;

  const [rows, totals] = await Promise.all([
    db.execute<{ id: string }>(sql`
      SELECT c.id FROM candidates c${whereClause}
      ORDER BY c.partner_review_priority DESC NULLS LAST, c.created_at DESC
      LIMIT ${filters.pageSize} OFFSET ${offset}
    `),
    db.execute<{ total: string }>(sql`
      SELECT count(*)::text AS total FROM candidates c${whereClause}
    `),
  ]);

  const ids = rows.rows.map((row) => row.id);
  const fullRows =
    ids.length === 0
      ? []
      : await db.select().from(candidates).where(inArray(candidates.id, ids));
  const byId = new Map(fullRows.map((row) => [row.id, row]));
  const records = ids
    .map((id) => byId.get(id))
    .filter((row) => row !== undefined)
    .map((row) => toCandidateDto(row));

  return {
    records,
    page: filters.page,
    pageSize: filters.pageSize,
    total: Number(totals.rows[0]?.total ?? "0"),
  };
}

export interface CandidateDetail {
  candidate: CandidateDto;
  scores: ScoreRecordDto[];
  featureSnapshot: {
    id: string;
    schemaVersion: string;
    features: Record<string, unknown>;
    contentSha256: string;
    createdAt: string;
  } | null;
}

/** Candidate detail: full append-only score history plus latest feature snapshot. */
export async function candidateDetail(
  db: Database,
  candidateId: string,
): Promise<CandidateDetail | null> {
  const candidateRows = await db
    .select()
    .from(candidates)
    .where(sql`${candidates.id} = ${candidateId}`)
    .limit(1);
  const candidate = candidateRows[0];
  if (candidate === undefined) return null;

  const [scoreRows, snapshotRows] = await Promise.all([
    db
      .select()
      .from(candidateScores)
      .where(sql`${candidateScores.candidateId} = ${candidateId}`)
      .orderBy(sql`computed_at DESC, id DESC`)
      .limit(500),
    db
      .select()
      .from(featureSnapshots)
      .where(sql`${featureSnapshots.companyId} = ${candidate.companyId}`)
      .orderBy(sql`created_at DESC, id DESC`)
      .limit(1),
  ]);

  const snapshot = snapshotRows[0];
  return {
    candidate: toCandidateDto(candidate),
    scores: scoreRows.map(toScoreRecordDto),
    featureSnapshot:
      snapshot === undefined
        ? null
        : {
            id: snapshot.id,
            schemaVersion: snapshot.schemaVersion,
            features: snapshot.features,
            contentSha256: snapshot.contentSha256,
            createdAt: instant(snapshot.createdAt),
          },
  };
}
