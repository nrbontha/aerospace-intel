import { listAgents } from "@asi/database";
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
} from "@/app/api/v1/agents/shared";

// GET /api/v1/agents/overview — all roles; the Research-tab live strip in one
// call: status counts, $ today vs global cap, open proposals, last find.
export async function GET(_request: NextRequest): Promise<Response> {
  try {
    await requireUser();

    const [rows, spendTodayUsd, openProposals, lastFind, findsToday] =
      await Promise.all([
        listAgents(),
        getGlobalSpendTodayUsd(),
        getOpenProposalCount(),
        getLastFind(),
        getFindsTodayByAgentId(),
      ]);

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
    });
  } catch (error) {
    return handleAgentRouteError(error);
  }
}
