import { agentTickListQuerySchema, uuidSchema } from "@asi/contracts";
import { agentTicks, researchAgents } from "@asi/database";
import { getDatabase } from "@asi/database/client";
import { and, count, desc, eq, type SQL } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { jsonError, jsonPage } from "@/lib/api";
import { requireUser } from "@/lib/auth";

import { handleAgentRouteError, toTickDto } from "@/app/api/v1/agents/shared";

type RouteContext = { params: Promise<{ id: string }> };

// GET /api/v1/agents/[id]/ticks — all roles; paginated tick log.
export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  try {
    await requireUser();
    const id = uuidSchema.safeParse((await context.params).id);
    if (!id.success) {
      return jsonError("validation_failed", "Invalid agent id", 400);
    }

    const query = agentTickListQuerySchema.safeParse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    if (!query.success) {
      return jsonError(
        "validation_failed",
        "Invalid tick query",
        400,
        query.error.flatten(),
      );
    }

    const [agent] = await getDatabase()
      .select({ id: researchAgents.id })
      .from(researchAgents)
      .where(eq(researchAgents.id, id.data))
      .limit(1);
    if (agent === undefined) {
      return jsonError("not_found", `Agent ${id.data} not found`, 404);
    }

    const filters: SQL[] = [eq(agentTicks.agentId, id.data)];
    if (query.data.outcome !== undefined) {
      filters.push(eq(agentTicks.outcome, query.data.outcome));
    }
    const where = and(...filters);

    const [countRow] = await getDatabase()
      .select({ total: count() })
      .from(agentTicks)
      .where(where);
    const ticks = await getDatabase()
      .select()
      .from(agentTicks)
      .where(where)
      .orderBy(desc(agentTicks.startedAt))
      .limit(query.data.pageSize)
      .offset((query.data.page - 1) * query.data.pageSize);

    return jsonPage(
      ticks.map(toTickDto),
      query.data.page,
      query.data.pageSize,
      countRow!.total,
    );
  } catch (error) {
    return handleAgentRouteError(error);
  }
}
