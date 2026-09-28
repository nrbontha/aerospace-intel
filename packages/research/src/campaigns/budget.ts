import { sql } from "drizzle-orm";

import { getDatabase, type Database } from "@asi/database/client";
import { researchCampaigns } from "@asi/database";

import type { CampaignView } from "./types.js";

/** Daily hard cap when OPENROUTER_MAX_COST_PER_DAY_USD is unset. */
export const DEFAULT_DAILY_BUDGET_USD = 1.0;

export function dailyBudgetCapUsd(): number {
  const raw = process.env["OPENROUTER_MAX_COST_PER_DAY_USD"];
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_DAILY_BUDGET_USD;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_DAILY_BUDGET_USD;
}

export type BudgetRejection = "campaign_budget_exceeded" | "daily_cap_exceeded";

export interface BudgetDecision {
  ok: boolean;
  rejection?: BudgetRejection;
}

/**
 * Pure budget gate. `campaignBudgetUsd === null` means unlimited campaign
 * budget; the daily cap always applies. Callers MUST invoke this before
 * every model/tool call inside a campaign task.
 */
export function evaluateBudgets(
  campaign: Pick<CampaignView, "spendUsd" | "budgetUsd">,
  dailySpendUsd: number,
  maxDailyUsd: number,
): BudgetDecision {
  if (campaign.budgetUsd !== null && campaign.spendUsd >= campaign.budgetUsd) {
    return { ok: false, rejection: "campaign_budget_exceeded" };
  }
  if (dailySpendUsd >= maxDailyUsd) {
    return { ok: false, rejection: "daily_cap_exceeded" };
  }
  return { ok: true };
}

/**
 * Total recorded model spend for the UTC calendar day containing `now`.
 *
 * `model_usage` is the generic research ledger. FAA review provider responses
 * are recorded independently in `faa_review_model_usage`; evaluation costs are
 * retained only as diagnostic history and are not summed again.
 */
export async function getDailySpendUsd(
  now: Date = new Date(),
  db: Database = getDatabase(),
): Promise<number> {
  if (!Number.isFinite(now.getTime())) {
    throw new TypeError("now must be a valid date");
  }
  const utcDayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const utcDayEnd = new Date(utcDayStart.getTime() + 24 * 60 * 60 * 1_000);
  const result = await db.execute<{ total: string | null }>(sql`
    SELECT COALESCE(SUM(recorded.cost_usd), 0)::text AS total
    FROM (
      SELECT cost_usd
      FROM model_usage
      WHERE created_at >= ${utcDayStart.toISOString()}::timestamptz
        AND created_at < ${utcDayEnd.toISOString()}::timestamptz
        AND cost_usd IS NOT NULL
      UNION ALL
      SELECT cost_usd
      FROM faa_review_model_usage
      WHERE observed_at >= ${utcDayStart.toISOString()}::timestamptz
        AND observed_at < ${utcDayEnd.toISOString()}::timestamptz
        AND cost_usd IS NOT NULL
    ) recorded
  `);
  const total = result.rows[0]?.total;
  const parsed =
    total === null || total === undefined ? Number.NaN : Number(total);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("Daily model spend accounting returned an invalid total");
  }
  return parsed;
}

export interface SpendRecorded {
  spendUsd: number;
  status: string;
  flippedToBudgetExhausted: boolean;
}

/**
 * Atomically add spend to a campaign. The status flip to
 * `budget_exhausted` happens in the same statement so concurrent workers
 * can never observe spend above budget with a non-terminal status. Only
 * active statuses flip; terminal states are never resurrected.
 */
export async function recordSpend(
  campaignId: string,
  deltaUsd: number,
): Promise<SpendRecorded> {
  if (!Number.isFinite(deltaUsd) || deltaUsd < 0) {
    throw new RangeError("Spend delta must be a finite non-negative number");
  }
  const rows = await getDatabase()
    .update(researchCampaigns)
    .set({
      spendUsd: sql`${researchCampaigns.spendUsd} + ${deltaUsd}::numeric`,
      status: sql`CASE
        WHEN ${researchCampaigns.budgetUsd} IS NOT NULL
          AND ${researchCampaigns.spendUsd} + ${deltaUsd}::numeric >= ${researchCampaigns.budgetUsd}
          AND ${researchCampaigns.status} IN ('running', 'paused', 'draft', 'queued')
        THEN 'budget_exhausted'::campaign_status
        ELSE ${researchCampaigns.status}
      END`,
    })
    .where(sql`${researchCampaigns.id} = ${campaignId}`)
    .returning({
      spendUsd: researchCampaigns.spendUsd,
      status: researchCampaigns.status,
    });

  const row = rows[0];
  if (row === undefined) {
    throw new Error(`Campaign not found: ${campaignId}`);
  }
  return {
    spendUsd: Number(row.spendUsd),
    status: row.status,
    flippedToBudgetExhausted: row.status === "budget_exhausted" && deltaUsd > 0,
  };
}
