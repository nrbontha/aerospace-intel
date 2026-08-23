import { uuidSchema } from "@asi/contracts";
import { auditEvents, researchAgents } from "@asi/database";
import { getDatabase } from "@asi/database/client";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { jsonError, jsonSuccess } from "@/lib/api";
import { requireRole, verifyCsrfRequest } from "@/lib/auth";

import {
  AgentNotFoundError,
  handleAgentRouteError,
  toAgentDto,
  type AgentDtoJson,
} from "@/app/api/v1/agents/shared";

type RouteContext = { params: Promise<{ id: string }> };

type LifecycleAction = "pause" | "resume";

/**
 * Factory for POST /api/v1/agents/[id]/{pause,resume}.
 * The ROUTE is the audit caller: every accepted transition writes an
 * audit_events row with before/after status in the same request.
 *
 * Semantics: pause flips status to 'paused'; a tick already in flight is not
 * hard-aborted (use /kill for that) but the supervisor stops claiming the
 * agent, so no further ticks start. Resume flips back to 'running' and
 * re-dues the agent immediately.
 */
export function createAgentLifecycleRoute(action: LifecycleAction) {
  return async function POST(
    request: NextRequest,
    context: RouteContext,
  ): Promise<Response> {
    try {
      const actor = await requireRole("analyst", "admin");
      await verifyCsrfRequest(request);

      const id = uuidSchema.safeParse((await context.params).id);
      if (!id.success) {
        return jsonError("validation_failed", "Invalid agent id", 400);
      }

      const nextStatus = action === "pause" ? "paused" : "running";
      const updated = await getDatabase().transaction(async (tx) => {
        const [agent] = await tx
          .select()
          .from(researchAgents)
          .where(eq(researchAgents.id, id.data))
          .limit(1)
          .for("update");
        if (agent === undefined) throw new AgentNotFoundError(id.data);

        const now = new Date();
        const [row] = await tx
          .update(researchAgents)
          .set({
            status: nextStatus,
            // Resume re-dues promptly; pause keeps the scheduled slot so a
            // later resume does not lose the cadence position.
            ...(action === "resume" ? { nextTickAt: now } : {}),
            updatedAt: now,
          })
          .where(eq(researchAgents.id, id.data))
          .returning();

        await tx.insert(auditEvents).values({
          actorUserId: actor.id,
          action: `agent.${action}`,
          entityType: "research_agent",
          entityId: id.data,
          before: { status: agent.status },
          after: { status: row!.status },
        });
        return row!;
      });

      return jsonSuccess(toAgentDto(updated) satisfies AgentDtoJson);
    } catch (error) {
      return handleAgentRouteError(error);
    }
  };
}
