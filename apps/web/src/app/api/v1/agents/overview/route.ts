import { agentFrontierProgress, listAgents } from "@asi/database";
import { getDatabase } from "@asi/database/client";
import { sql } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { jsonSuccess } from "@/lib/api";
import { requireUser } from "@/lib/auth";

import {
  dailyBudgetCapUsd,
  getFindsTodayByAgentId,
  getGlobalSpendTodayUsd,
  getLastFind,
  getOpenProposalCount,
  handleAgentRouteError,
  iso,
} from "@/app/api/v1/agents/shared";

type SourceSignalOverviewRow = Readonly<{
  queued_qualification: string | number | null;
  qualifying: string | number | null;
  qualified_today: string | number | null;
  rejected_today: string | number | null;
  quarantined: string | number | null;
  latest_qualification: Date | string | null;
}>;

export type SourceSignalOverview = Readonly<{
  queuedQualification: number;
  qualifying: number;
  qualifiedToday: number;
  rejectedToday: number;
  quarantined: number;
  latestQualification: string | null;
}>;
export type UsaSpendingCrawlOverview = Readonly<{
  totalWindows: number;
  pendingWindows: number;
  inProgressWindows: number;
  completedWindows: number;
  failedWindows: number;
  currentMonth: string | null;
  currentPage: number | null;
  lastAttemptAt: string | null;
}>;

const EMPTY_USASPENDING_CRAWL: UsaSpendingCrawlOverview = {
  totalWindows: 0,
  pendingWindows: 0,
  inProgressWindows: 0,
  completedWindows: 0,
  failedWindows: 0,
  currentMonth: null,
  currentPage: null,
  lastAttemptAt: null,
};

/** USAspending month/page coverage owned by the autonomous discovery agent. */
export async function getUsaSpendingCrawlOverview(
  agentId: string | null,
): Promise<UsaSpendingCrawlOverview> {
  if (agentId === null) return EMPTY_USASPENDING_CRAWL;

  const progress = await agentFrontierProgress(agentId);
  return {
    totalWindows: progress.total,
    pendingWindows: progress.pending,
    inProgressWindows: progress.inProgress,
    completedWindows: progress.completed,
    failedWindows: progress.failed,
    currentMonth: progress.currentMonth,
    currentPage: progress.currentPage,
    lastAttemptAt: progress.lastAttemptAt,
  };
}


/**
 * Source observations remain quarantined until qualification creates a lead.
 * This single aggregate is deliberately zero-safe for a newly migrated table.
 */
export async function getSourceSignalOverview(
  now = new Date(),
): Promise<SourceSignalOverview> {
  const result = await getDatabase().execute<SourceSignalOverviewRow>(sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'queued_qualification')::int AS queued_qualification,
      COUNT(*) FILTER (WHERE status = 'qualifying')::int AS qualifying,
      COUNT(*) FILTER (
        WHERE status = 'qualified'
          AND qualified_at >= (
            date_trunc('day', ${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')
            AT TIME ZONE 'UTC'
          )
      )::int AS qualified_today,
      COUNT(*) FILTER (
        WHERE status = 'rejected'
          AND rejected_at >= (
            date_trunc('day', ${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')
            AT TIME ZONE 'UTC'
          )
      )::int AS rejected_today,
      COUNT(*) FILTER (WHERE status = 'quarantined')::int AS quarantined,
      MAX(GREATEST(qualified_at, rejected_at)) AS latest_qualification
    FROM source_signals
  `);
  const row = result.rows[0];

  return {
    queuedQualification: count(row?.queued_qualification),
    qualifying: count(row?.qualifying),
    qualifiedToday: count(row?.qualified_today),
    rejectedToday: count(row?.rejected_today),
    quarantined: count(row?.quarantined),
    latestQualification: row === undefined ? null : iso(row.latest_qualification),
  };
}

function count(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

// GET /api/v1/agents/overview — all roles; the Research-tab live strip in one
// call: status counts, $ today vs global cap, open proposals, last find.
export async function GET(_request: NextRequest): Promise<Response> {
  try {
    await requireUser();

    const [rows, spendTodayUsd, openProposals, lastFind, findsToday, sourceSignals] =
      await Promise.all([
        listAgents(),
        getGlobalSpendTodayUsd(),
        getOpenProposalCount(),
        getLastFind(),
        getFindsTodayByAgentId(),
        getSourceSignalOverview(),
      ]);

    const usaSpendingAgentId =
      rows.find((row) => row.agent.key === "discover-usaspending")?.agent.id ?? null;
    const usaSpendingCrawl =
      await getUsaSpendingCrawlOverview(usaSpendingAgentId);

    const counts = { total: rows.length, running: 0, idle: 0, paused: 0, failed: 0 };
    for (const row of rows) {
      if (row.agent.status in counts) {
        counts[row.agent.status as keyof typeof counts] += 1;
      }
    }

    return jsonSuccess({
      counts,
      findsToday: [...findsToday.values()].reduce((sum, n) => sum + n, 0),
      spendTodayUsd,
      dailyCapUsd: dailyBudgetCapUsd(),
      openProposals,
      lastFind,
      sourceSignals,
      usaSpendingCrawl,
    });
  } catch (error) {
    return handleAgentRouteError(error);
  }
}
