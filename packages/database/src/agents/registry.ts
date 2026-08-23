import { sql } from "drizzle-orm";

import { getDatabase } from "../client.js";
import { researchAgents, type ResearchAgent } from "../schema.js";

/**
 * Claim up to `limit` due agents for one supervisor instance.
 *
 * Due predicate (REDESIGN_PLAN §1.2): status='running' AND
 * (next_tick_at IS NULL OR next_tick_at <= now OR stale lease). A *fresh*
 * lease (lease_expires_at >= now) always blocks claiming — an agent mid-tick
 * still shows a past next_tick_at until its tick completes, so the freshness
 * guard is what prevents double execution. Claims are serialized through
 * FOR UPDATE SKIP LOCKED, so concurrent supervisors receive disjoint sets.
 */
export async function claimDueAgents(options: {
  limit: number;
  instanceId: string;
  leaseSeconds: number;
  now?: Date;
}): Promise<ResearchAgent[]> {
  const now = options.now ?? new Date();
  return getDatabase()
    .update(researchAgents)
    .set({
      heartbeatAt: now,
      leaseExpiresAt: sql`${now}::timestamptz + make_interval(secs => ${options.leaseSeconds}::double precision)`,
      leasedBy: options.instanceId,
      updatedAt: now,
    })
    .where(
      sql`${researchAgents.id} IN (
        SELECT id FROM ${researchAgents}
        WHERE ${researchAgents.status} = 'running'
          AND (${researchAgents.nextTickAt} IS NULL OR ${researchAgents.nextTickAt} <= ${now}
               OR ${researchAgents.leaseExpiresAt} < ${now})
          AND (${researchAgents.leaseExpiresAt} IS NULL OR ${researchAgents.leaseExpiresAt} < ${now})
        ORDER BY COALESCE(${researchAgents.nextTickAt}, ${now})
        LIMIT ${options.limit}
        FOR UPDATE SKIP LOCKED
      )`,
    )
    .returning();
}

/**
 * Refresh liveness for a leased agent and extend its lease. Returns false
 * when the agent is no longer leased by anyone (completed or never claimed).
 */
export async function heartbeat(
  agentId: string,
  options: { leaseSeconds: number; now?: Date },
): Promise<boolean> {
  const now = options.now ?? new Date();
  const rows = await getDatabase()
    .update(researchAgents)
    .set({
      heartbeatAt: now,
      leaseExpiresAt: sql`${now}::timestamptz + make_interval(secs => ${options.leaseSeconds}::double precision)`,
      updatedAt: now,
    })
    .where(
      sql`${researchAgents.id} = ${agentId} AND ${researchAgents.leasedBy} IS NOT NULL`,
    )
    .returning({ id: researchAgents.id });
  return rows.length > 0;
}

/** Registry listing with lightweight aggregates for control-plane surfaces. */
export async function listAgents(now: Date = new Date()): Promise<
  Array<{
    agent: ResearchAgent;
    spendTodayUsd: number;
    ticksToday: number;
    lastTickOutcome: string | null;
    lastTickFinishedAt: Date | null;
    errorsLast24h: number;
  }>
> {
  const midnight = new Date(now);
  midnight.setUTCHours(0, 0, 0, 0);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60_000);
  const rows = await getDatabase().execute<{
    id: string;
    spend_today_usd: string | null;
    ticks_today: string | null;
    last_tick_outcome: string | null;
    last_tick_finished_at: Date | null;
    errors_last_24h: string | null;
  }>(sql`
    SELECT a.id,
           COALESCE(t.spend_today_usd, 0) AS spend_today_usd,
           COALESCE(t.ticks_today, 0) AS ticks_today,
           t.last_tick_outcome,
           t.last_tick_finished_at,
           COALESCE(e.errors_last_24h, 0) AS errors_last_24h
    FROM ${researchAgents} a
    LEFT JOIN LATERAL (
      SELECT SUM(x.cost_usd) AS spend_today_usd,
             COUNT(*) AS ticks_today,
             (ARRAY_REMOVE(ARRAY_AGG(x.outcome ORDER BY x.started_at DESC), NULL))[1] AS last_tick_outcome,
             MAX(x.finished_at) AS last_tick_finished_at
      FROM agent_ticks x
      WHERE x.agent_id = a.id AND x.started_at >= ${midnight}
    ) t ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS errors_last_24h
      FROM agent_ticks x
      WHERE x.agent_id = a.id AND x.outcome = 'error' AND x.started_at >= ${dayAgo}
    ) e ON TRUE
    ORDER BY a.key
  `);
  const agents = await getDatabase().select().from(researchAgents);
  const byId = new Map(
    rows.rows.map((row) => [row.id, row]),
  );
  return agents.map((agent) => {
    const agg = byId.get(agent.id);
    return {
      agent,
      spendTodayUsd: Number(agg?.spend_today_usd ?? 0),
      ticksToday: Number(agg?.ticks_today ?? 0),
      lastTickOutcome: agg?.last_tick_outcome ?? null,
      lastTickFinishedAt: agg?.last_tick_finished_at ?? null,
      errorsLast24h: Number(agg?.errors_last_24h ?? 0),
    };
  });
}
