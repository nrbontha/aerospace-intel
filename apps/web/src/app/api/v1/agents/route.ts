import {
  agentCreateSchema,
  agentListQuerySchema,
} from "@asi/contracts";
import { auditEvents, listAgents, researchAgents } from "@asi/database";
import { getDatabase } from "@asi/database/client";
import type { NextRequest } from "next/server";

import { jsonError, jsonPage, jsonSuccess } from "@/lib/api";
import { requireRole, requireUser, verifyCsrfRequest } from "@/lib/auth";

import {
  getFindsTodayByAgentId,
  handleAgentRouteError,
  toAgentDto,
  type AgentDtoJson,
  iso,
} from "@/app/api/v1/agents/shared";

/** One row of the agents table: full DTO plus health/spend/finds aggregates. */
interface AgentListItem extends AgentDtoJson {
  ticksToday: number;
  lastTickOutcome: string | null;
  lastTickFinishedAt: string | null;
  errorsLast24h: number;
  findsToday: number;
}

// GET /api/v1/agents — all roles; registry + health/spend/finds aggregates.
export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireUser();
    const query = agentListQuerySchema.safeParse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    if (!query.success) {
      return jsonError(
        "validation_failed",
        "Invalid agent query",
        400,
        query.error.flatten(),
      );
    }

    const [rows, findsToday] = await Promise.all([
      listAgents(),
      getFindsTodayByAgentId(),
    ]);

    const items: AgentListItem[] = rows
      .filter(
        (row) =>
          (query.data.status === undefined ||
            row.agent.status === query.data.status) &&
          (query.data.agentType === undefined ||
            row.agent.agentType === query.data.agentType),
      )
      .sort((left, right) => left.agent.key.localeCompare(right.agent.key))
      .map((row) => ({
        ...toAgentDto(row.agent),
        ticksToday: row.ticksToday,
        lastTickOutcome: row.lastTickOutcome,
        lastTickFinishedAt: iso(row.lastTickFinishedAt),
        errorsLast24h: row.errorsLast24h,
        findsToday: findsToday.get(row.agent.id) ?? 0,
      }));

    const start = (query.data.page - 1) * query.data.pageSize;
    return jsonPage(
      items.slice(start, start + query.data.pageSize),
      query.data.page,
      query.data.pageSize,
      items.length,
    );
  } catch (error) {
    return handleAgentRouteError(error);
  }
}

// POST /api/v1/agents — admin registers an agent of a known type (audited).
export async function POST(request: NextRequest): Promise<Response> {
  try {
    const actor = await requireRole("admin");
    await verifyCsrfRequest(request);

    const body = agentCreateSchema.safeParse(await request.json().catch(() => ({})));
    if (!body.success) {
      return jsonError(
        "validation_failed",
        "Invalid agent payload",
        400,
        body.error.flatten(),
      );
    }
    const input = body.data;

    const [created] = await getDatabase()
      .insert(researchAgents)
      .values({
        key: input.key,
        name: input.name,
        agentType: input.agentType,
        goal: input.goal,
        seedScope: input.seedScope,
        policyVersion: input.policyVersion ?? null,
        budgetSharePct:
          input.budgetSharePct === undefined
            ? null
            : String(input.budgetSharePct),
        dailyBudgetUsd:
          input.dailyBudgetUsd === undefined
            ? null
            : String(input.dailyBudgetUsd),
        cadenceSeconds: input.cadenceSeconds,
        status: input.status,
        config: input.config,
        createdBy: actor.id,
      })
      .returning();

    await getDatabase().insert(auditEvents).values({
      actorUserId: actor.id,
      action: "agent.created",
      entityType: "research_agent",
      entityId: created!.id,
      after: {
        key: created!.key,
        name: created!.name,
        agentType: created!.agentType,
        status: created!.status,
      },
    });

    return jsonSuccess(toAgentDto(created!), { status: 201 });
  } catch (error) {
    return handleAgentRouteError(error);
  }
}
