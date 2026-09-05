import { asc, count, eq, sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.js";
import {
  unifiedTargets,
  type NewUnifiedTarget,
  type UnifiedTarget,
  type UnifiedTargetTier,
} from "../schema.js";

export type { UnifiedTarget, UnifiedTargetTier };
export type { NewUnifiedTarget };

export type UpsertUnifiedTargetInput = Omit<
  NewUnifiedTarget,
  "id" | "normalizedName" | "createdAt" | "updatedAt"
> & {
  normalizedName?: string;
};

/**
 * Canonical normalization: collapse whitespace, trim, lowercase, strip one
 * trailing legal-entity suffix. MUST match normalizeUnifiedName in
 * scripts/populate-unified-targets.mts.
 */
export function normalizeTargetName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[,.\s]+$/, "")
    .replace(
      /\s+(llc|inc|corp|corporation|incorporated|co|company|ltd|limited|lp|llp|pllc|plc)\.?$/,
      "",
    )
    .replace(/[,.\s]+$/, "");
}

/** SQL fragment ranking a tier string without downgrading on merge. */
export type TierRankExpr = SQL;

function tierRankExpr(columnRef: string): TierRankExpr {
  return sql.raw(
    `(CASE ${columnRef} WHEN 'reference' THEN 4 WHEN 'high_interest' THEN 3 WHEN 'evaluate' THEN 2 ELSE 1 END)`,
  );
}

/** SQL fragment unioning two JSONB string arrays with dedupe. */
export type JsonbArrayUnionExpr = SQL;

function jsonbArrayUnionExpr(column: string): JsonbArrayUnionExpr {
  return sql.raw(
    `(SELECT COALESCE(jsonb_agg(DISTINCT e), '[]'::jsonb) FROM jsonb_array_elements_text(COALESCE("unified_targets"."${column}", '[]'::jsonb) || COALESCE(excluded."${column}", '[]'::jsonb)) AS u(e))`,
  );
}

/**
 * Insert one unified target, merging into the existing row when
 * `normalized_name` already exists. Origins and evidence URLs are
 * array-unioned, nullable scalars keep the existing value unless the new row
 * provides one, and tier never downgrades
 * (reference > high_interest > evaluate > needs_research). Single statement,
 * safe under concurrent writers.
 */
export async function upsertUnifiedTarget(
  db: Database,
  input: UpsertUnifiedTargetInput,
): Promise<UnifiedTarget> {
  const { normalizedName, ...rest } = input;
  const values = {
    ...rest,
    normalizedName: normalizedName ?? normalizeTargetName(input.companyName),
  };
  const rows = await db
    .insert(unifiedTargets)
    .values(values)
    .onConflictDoUpdate({
      target: unifiedTargets.normalizedName,
      set: {
        companyName: sql`excluded."company_name"`,
        domain: sql`COALESCE(excluded."domain", "unified_targets"."domain")`,
        websiteUrl: sql`COALESCE(excluded."website_url", "unified_targets"."website_url")`,
        city: sql`COALESCE(excluded."city", "unified_targets"."city")`,
        stateCode: sql`COALESCE(excluded."state_code", "unified_targets"."state_code")`,
        countryCode: sql`COALESCE(excluded."country_code", "unified_targets"."country_code")`,
        origins: jsonbArrayUnionExpr("origins"),
        goldenV1Member: sql`"unified_targets"."golden_v1_member" OR COALESCE(excluded."golden_v1_member", false)`,
        tier: sql`CASE WHEN ${tierRankExpr('excluded."tier"')} > ${tierRankExpr('"unified_targets"."tier"')} THEN excluded."tier" ELSE "unified_targets"."tier" END`,
        pipelineStatus: sql`COALESCE(excluded."pipeline_status", "unified_targets"."pipeline_status")`,
        fit: sql`COALESCE(excluded."fit", "unified_targets"."fit")`,
        novelty: sql`COALESCE(excluded."novelty", "unified_targets"."novelty")`,
        confidence: sql`COALESCE(excluded."confidence", "unified_targets"."confidence")`,
        actionability: sql`COALESCE(excluded."actionability", "unified_targets"."actionability")`,
        ensembleDecision: sql`COALESCE(excluded."ensemble_decision", "unified_targets"."ensemble_decision")`,
        ensembleConfidence: sql`COALESCE(excluded."ensemble_confidence", "unified_targets"."ensemble_confidence")`,
        whyInteresting: sql`COALESCE(excluded."why_interesting", "unified_targets"."why_interesting")`,
        risks: sql`COALESCE(excluded."risks", "unified_targets"."risks")`,
        unknowns: sql`COALESCE(excluded."unknowns", "unified_targets"."unknowns")`,
        evidenceUrls: jsonbArrayUnionExpr("evidence_urls"),
        companyId: sql`COALESCE(excluded."company_id", "unified_targets"."company_id")`,
        signalId: sql`COALESCE(excluded."signal_id", "unified_targets"."signal_id")`,
        candidateId: sql`COALESCE(excluded."candidate_id", "unified_targets"."candidate_id")`,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error(
      `unified_targets upsert returned no row for ${values.normalizedName}`,
    );
  }
  return row;
}

/** Read one target by company name (normalized before lookup). */
export async function getUnifiedTarget(
  db: Database,
  name: string,
): Promise<UnifiedTarget | null> {
  const rows = await db
    .select()
    .from(unifiedTargets)
    .where(eq(unifiedTargets.normalizedName, normalizeTargetName(name)))
    .limit(1);
  return rows[0] ?? null;
}

/** List targets, optionally filtered by tier, alphabetically, capped. */
export async function listUnifiedTargets(
  db: Database,
  tier?: UnifiedTargetTier,
  limit = 50,
): Promise<UnifiedTarget[]> {
  const capped = Math.min(Math.max(1, Math.trunc(limit)), 500);
  const base = db.select().from(unifiedTargets);
  if (tier === undefined) {
    return base.orderBy(asc(unifiedTargets.companyName)).limit(capped);
  }
  return base
    .where(eq(unifiedTargets.tier, tier))
    .orderBy(asc(unifiedTargets.companyName))
    .limit(capped);
}

/** Row counts per tier; every tier is present even when empty. */
export async function countByTier(
  db: Database,
): Promise<Record<UnifiedTargetTier, number>> {
  const counts: Record<UnifiedTargetTier, number> = {
    reference: 0,
    high_interest: 0,
    evaluate: 0,
    needs_research: 0,
  };
  const rows = await db
    .select({ tier: unifiedTargets.tier, n: count() })
    .from(unifiedTargets)
    .groupBy(unifiedTargets.tier);
  for (const row of rows) {
    const tier = row.tier as UnifiedTargetTier;
    if (tier in counts) counts[tier] = Number(row.n);
  }
  return counts;
}
