import { uuidSchema } from "@asi/contracts";
import { agentTicks, auditEvents, researchAgents } from "@asi/database";
import { getDatabase } from "@asi/database/client";
import { and, eq, isNull } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { jsonError, jsonSuccess } from "@/lib/api";
import { requireRole, verifyCsrfRequest } from "@/lib/auth";

import {
  AgentNotFoundError,
  handleAgentRouteError,
  toAgentDto,
} from "@/app/api/v1/agents/shared";

type RouteContext = { params: Promise<{ id: string }> };

const agentKillSchema = z.strictObject({
  reason: z.string().trim().min(1).max(10_000),
});

/**
 * POST /api/v1/agents/[id]/kill — admin only; reason required.
 *
 * Kill semantics, stated honestly (REDESIGN_PLAN §1.4): kill = pause plus
 * lease invalidation. We flip the agent to 'paused', clear the lease
 * columns so the supervisor's heartbeat/claim machinery immediately treats
 * the tick as lost, and mark any open journal row (finished_at IS NULL) as
 * 'preempted' with the operator's reason. The in-flight model call is NOT
 * hard-cancelled — if the worker's executor is still running it may finalize
 * that journal row afterwards and overwrite the preempted marker; either way
 * the agent stays paused, its lease stays released, and no further ticks are
 * ever scheduled until a human resumes it.
 */
export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  try {
    const actor = await requireRole("admin");
    await verifyCsrfRequest(request);

    const id = uuidSchema.safeParse((await context.params).id);
    if (!id.success) {
      return jsonError("validation_failed", "Invalid agent id", 400);
    }

    const body = agentKillSchema.safeParse(await request.json().catch(() => ({})));
    if (!body.success) {
      return jsonError(
        "validation_failed",
        "A kill requires a non-empty reason",
        400,
        body.error.flatten(),
      );
    }

    const now = new Date();
    const updated = await getDatabase().transaction(async (tx) => {
      const [agent] = await tx
        .select()
        .from(researchAgents)
        .where(eq(researchAgents.id, id.data))
        .limit(1)
        .for("update");
      if (agent === undefined) throw new AgentNotFoundError(id.data);

      // Abort the current tick via lease invalidation: close any open journal
      // row as preempted, then release the lease and park the agent paused.
      await tx
        .update(agentTicks)
        .set({
          finishedAt: now,
          outcome: "preempted",
          error: body.data.reason.slice(0, 4000),
        })
        .where(
          and(eq(agentTicks.agentId, id.data), isNull(agentTicks.finishedAt)),
        );

      const [row] = await tx
        .update(researchAgents)
        .set({
          status: "paused",
          leasedBy: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          updatedAt: now,
        })
        .where(eq(researchAgents.id, id.data))
        .returning();

      await tx.insert(auditEvents).values({
        actorUserId: actor.id,
        action: "agent.kill",
        entityType: "research_agent",
        entityId: id.data,
        before: { status: agent.status },
        after: { status: row!.status, reason: body.data.reason },
      });
      return row!;
    });

    return jsonSuccess(toAgentDto(updated));
  } catch (error) {
    return handleAgentRouteError(error);
  }
}
