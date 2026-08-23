import { sql } from "drizzle-orm";

import { getDatabase } from "@asi/database/client";
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
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_BUDGET_USD;
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
  if (
    campaign.budgetUsd !== null &&
    campaign.spendUsd >= campaign.budgetUsd
  ) {
    return { ok: false, rejection: "campaign_budget_exceeded" };
  }
  if (dailySpendUsd >= maxDailyUsd) {
    return { ok: false, rejection: "daily_cap_exceeded" };
  }
  return { ok: true };
}

/**
 * Total model_usage spend recorded since UTC midnight. Strategies that make
 * model calls must persist model_usage rows; this reads them back.
 */
export async function getDailySpendUsd(now: Date = new Date()): Promise<number> {
  const result = await getDatabase().execute<{ total: string | null }>(sql`
    SELECT COALESCE(SUM(cost_usd), 0)::text AS total
    FROM model_usage
    WHERE created_at >= date_trunc('day', ${now.toISOString()}::timestamptz)
  `);
  const total = result.rows[0]?.total ?? "0";
  const parsed = Number(total);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
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
    flippedToBudgetExhausted:
      row.status === "budget_exhausted" && deltaUsd > 0,
  };
}
