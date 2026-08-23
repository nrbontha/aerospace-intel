import { sql } from "drizzle-orm";

import type { AgentTick, ResearchAgent } from "@asi/database";
import { getDatabase } from "@asi/database/client";

import { jsonError } from "@/lib/api";
import { AuthorizationError } from "@/lib/rbac";

/**
 * Shared plumbing for the agent control-plane API (REDESIGN_PLAN §1.4).
 * The web app cannot import @asi/research (not a dependency), so the daily
 * cap / spend reads here intentionally mirror
 * packages/research/src/campaigns/budget.ts.
 */

export class AgentNotFoundError extends Error {
  constructor(id: string) {
    super(`Agent ${id} not found`);
    this.name = "AgentNotFoundError";
  }
}

export function handleAgentRouteError(error: unknown): Response {
  if (error instanceof AuthorizationError) {
    return jsonError(
      error.status === 401 ? "unauthorized" : "forbidden",
      error.message,
      error.status,
    );
  }
  if (error instanceof AgentNotFoundError) {
    return jsonError("not_found", error.message, 404);
  }
  if (isUniqueViolation(error)) {
    return jsonError("conflict", "An agent with that key already exists", 409);
  }
  return jsonError("internal_error", "An internal error occurred", 500);
}

function isUniqueViolation(error: unknown): boolean {
  // drizzle wraps driver failures in DrizzleQueryError with the pg error
  // (which carries .code = "23505") as its cause.
  if (hasPgUniqueViolationCode(error)) return true;
  return error instanceof Error && hasPgUniqueViolationCode(error.cause);
}

function hasPgUniqueViolationCode(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && "code" in value &&
    value.code === "23505"
  );
}

// ---------------------------------------------------------------------------
// DTO mapping
// ---------------------------------------------------------------------------

/** JSON shape of a research agent as served by the control plane. */
export interface AgentDtoJson {
  id: string;
  key: string;
  name: string;
  agentType: string;
  goal: string;
  seedScope: Record<string, unknown>;
  policyVersion: string | null;
  budgetSharePct: number | null;
  dailyBudgetUsd: number | null;
  cadenceSeconds: number;
  status: string;
  lastTickAt: string | null;
  nextTickAt: string | null;
  heartbeatAt: string | null;
  leaseExpiresAt: string | null;
  leasedBy: string | null;
  consecutiveFailures: number;
  spendTodayUsd: number;
  config: Record<string, unknown>;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toAgentDto(agent: ResearchAgent): AgentDtoJson {
  return {
    id: agent.id,
    key: agent.key,
    name: agent.name,
    agentType: agent.agentType,
    goal: agent.goal,
    seedScope: agent.seedScope ?? {},
    policyVersion: agent.policyVersion,
    budgetSharePct: nullableNumber(agent.budgetSharePct),
    dailyBudgetUsd: nullableNumber(agent.dailyBudgetUsd),
    cadenceSeconds: agent.cadenceSeconds,
    status: agent.status,
    lastTickAt: iso(agent.lastTickAt),
    nextTickAt: iso(agent.nextTickAt),
    heartbeatAt: iso(agent.heartbeatAt),
    leaseExpiresAt: iso(agent.leaseExpiresAt),
    leasedBy: agent.leasedBy,
    consecutiveFailures: agent.consecutiveFailures,
    spendTodayUsd: Number(agent.spendTodayUsd),
    config: agent.config ?? {},
    createdBy: agent.createdBy,
    createdAt: iso(agent.createdAt)!,
    updatedAt: iso(agent.updatedAt)!,
  };
}

/** JSON shape of an agent tick journal row. */
export interface AgentTickDtoJson {
  id: string;
  agentId: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: string;
  plan: Record<string, unknown>;
  actionsExecuted: number;
  findings: Record<string, unknown>;
  costUsd: number;
  error: string | null;
}

export function iso(value: Date | string | null): string | null {
  // Raw execute() returns timestamptz as pg-format strings, Dates come from
  // the query builder — normalize both to ISO.
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function toTickDto(tick: AgentTick): AgentTickDtoJson {
  return {
    id: tick.id,
    agentId: tick.agentId,
    startedAt: iso(tick.startedAt)!,
    finishedAt: iso(tick.finishedAt),
    outcome: tick.outcome,
    plan: tick.plan ?? {},
    actionsExecuted: tick.actionsExecuted,
    findings: tick.findings ?? {},
    costUsd: Number(tick.costUsd),
    error: tick.error,
  };
}

function nullableNumber(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

/** Daily hard cap when OPENROUTER_MAX_COST_PER_DAY_USD is unset ($1). */
export function dailyBudgetCapUsd(): number {
  const raw = process.env["OPENROUTER_MAX_COST_PER_DAY_USD"];
  if (raw === undefined || raw.trim().length === 0) return 1.0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1.0;
}

/** Total model_usage spend recorded since UTC midnight (supervisor gate). */
export async function getGlobalSpendTodayUsd(now = new Date()): Promise<number> {
  const result = await getDatabase().execute<{ total: string }>(sql`
    SELECT COALESCE(SUM(cost_usd), 0)::text AS total
    FROM model_usage
    WHERE created_at >= date_trunc('day', ${now.toISOString()}::timestamptz)
  `);
  return nonNegativeNumber(result.rows[0]?.total);
}

/** Open proposals awaiting human review (research_proposals pending). */
export async function getOpenProposalCount(): Promise<number> {
  const result = await getDatabase().execute<{ total: string }>(sql`
    SELECT COUNT(*)::text AS total FROM research_proposals WHERE status = 'pending'
  `);
  return nonNegativeNumber(result.rows[0]?.total);
}

/**
 * "Finds" per agent since UTC midnight: summed findings deltas
 * (newLeads + newCandidates + newObservations) across today's ticks.
 * Agents without finds are absent from the map.
 */
export async function getFindsTodayByAgentId(
  midnightUtc: Date = utcMidnight(),
): Promise<Map<string, number>> {
  const result = await getDatabase().execute<{
    agent_id: string;
    finds: string;
  }>(sql`
    SELECT t.agent_id,
           COALESCE(SUM(
             COALESCE((t.findings ->> 'newLeads')::int, 0) +
             COALESCE((t.findings ->> 'newCandidates')::int, 0) +
             COALESCE((t.findings ->> 'newObservations')::int, 0)
           ), 0)::text AS finds
    FROM agent_ticks t
    WHERE t.started_at >= ${midnightUtc.toISOString()}
    GROUP BY t.agent_id
  `);
  const map = new Map<string, number>();
  for (const row of result.rows) {
    const parsed = nonNegativeNumber(row.finds);
    if (parsed > 0) map.set(row.agent_id, parsed);
  }
  return map;
}

/** Most recent tick that produced at least one find, across all agents. */
export async function getLastFind(): Promise<{
  at: string;
  agentId: string;
  agentKey: string;
  agentName: string;
} | null> {
  const result = await getDatabase().execute<{
    agent_id: string;
    agent_key: string;
    agent_name: string;
    started_at: Date;
  }>(sql`
    SELECT t.agent_id,
           a.key AS agent_key,
           a.name AS agent_name,
           t.started_at
    FROM agent_ticks t
    JOIN research_agents a ON a.id = t.agent_id
    WHERE COALESCE((t.findings ->> 'newLeads')::int, 0) +
            COALESCE((t.findings ->> 'newCandidates')::int, 0) +
            COALESCE((t.findings ->> 'newObservations')::int, 0) > 0
    ORDER BY t.started_at DESC
    LIMIT 1
  `);
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    at: new Date(row.started_at).toISOString(),
    agentId: row.agent_id,
    agentKey: row.agent_key,
    agentName: row.agent_name,
  };
}

function utcMidnight(now = new Date()): Date {
  const midnight = new Date(now);
  midnight.setUTCHours(0, 0, 0, 0);
  return midnight;
}

function nonNegativeNumber(raw: string | undefined): number {
  const parsed = Number(raw ?? "0");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
