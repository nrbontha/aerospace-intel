import type { AgentDto, AgentTickDto } from "@asi/contracts";

import { apiJson } from "@/components/csrf-client";

// ---------------------------------------------------------------------------
// Research control-plane client (REDESIGN_PLAN §3 / §1.4).
// Mirrors the JSON served by /api/v1/agents* routes; types are structural
// views, so extra fields on the wire stay harmless.
// ---------------------------------------------------------------------------

export type AgentStatus = "idle" | "running" | "paused" | "failed";
export type TickOutcome =
  | "planned"
  | "executed"
  | "stuck"
  | "done"
  | "budget_exhausted"
  | "error"
  | "preempted";

/** One row of GET /api/v1/agents (DTO plus health/spend/finds aggregates). */
export type AgentListItem = Readonly<{
  id: string;
  key: string;
  name: string;
  agentType: string;
  goal: string;
  status: AgentStatus;
  cadenceSeconds: number;
  budgetSharePct: number | null;
  dailyBudgetUsd: number | null;
  nextTickAt: string | null;
  lastTickAt: string | null;
  consecutiveFailures: number;
  spendTodayUsd: number;
  ticksToday: number;
  lastTickOutcome: string | null;
  lastTickFinishedAt: string | null;
  errorsLast24h: number;
  findsToday: number;
}>;

/** GET /api/v1/agents/overview — the live strip payload. */
export type AgentsOverview = Readonly<{
  counts: Readonly<{
    total: number;
    running: number;
    idle: number;
    paused: number;
    failed: number;
  }>;
  findsToday: number;
  spendTodayUsd: number;
  dailyCapUsd: number;
  openProposals: number;
  lastFind: Readonly<{
    at: string;
    agentId: string;
    agentKey: string;
    agentName: string;
  }> | null;
}>;

export type AgentTickRecord = AgentTickDto;

/** GET /api/v1/agents/:id — detail plus recent ticks. */
export type AgentDetailPayload = Readonly<{
  agent: AgentDto;
  aggregates: Readonly<{ findsToday: number }>;
  recentTicks: readonly AgentTickRecord[];
}>;


// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function getAgentsOverview(
  signal: AbortSignal,
): Promise<AgentsOverview> {
  return apiJson<AgentsOverview>("/api/v1/agents/overview", { signal });
}

/**
 * apiJson already unwraps the `{ data }` success envelope, so the page shape
 * here is the bare item array; totals live in `meta` if a caller needs them.
 */
export async function listAgents(
  signal: AbortSignal,
  page = 1,
): Promise<readonly AgentListItem[]> {
  return apiJson<readonly AgentListItem[]>(
    `/api/v1/agents?page=${page}&pageSize=100`,
    { signal },
  );
}

export async function getAgentDetail(
  agentId: string,
  signal: AbortSignal,
): Promise<AgentDetailPayload> {
  return apiJson<AgentDetailPayload>(`/api/v1/agents/${agentId}`, { signal });
}

export async function listAgentTicks(
  agentId: string,
  signal: AbortSignal,
  page = 1,
): Promise<readonly AgentTickRecord[]> {
  return apiJson<readonly AgentTickRecord[]>(
    `/api/v1/agents/${agentId}/ticks?page=${page}&pageSize=25`,
    { signal },
  );
}

// ---------------------------------------------------------------------------
// Lifecycle mutations (audited server-side; CSRF handled by apiJson)
// ---------------------------------------------------------------------------

export type AgentLifecycleAction = "pause" | "resume" | "kill";

/**
 * POST /api/v1/agents/:id/{action} — every transition is audited server-side;
 * pause/resume need analyst role and kill needs admin plus a non-empty reason
 * (both enforced by the routes, mirrored in the UI).
 */
export async function postAgentLifecycle(
  agentId: string,
  action: AgentLifecycleAction,
  reason?: string,
): Promise<AgentDto> {
  return apiJson<AgentDto>(`/api/v1/agents/${agentId}/${action}`, {
    method: "POST",
    ...(action === "kill"
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        }
      : {}),
  });
}
