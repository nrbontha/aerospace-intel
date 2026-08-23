import { agentUpdateSchema, uuidSchema } from "@asi/contracts";
import {
  agentTicks,
  auditEvents,
  researchAgents,
  type ResearchAgent,
} from "@asi/database";
import { getDatabase } from "@asi/database/client";
import { desc, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { jsonError, jsonSuccess } from "@/lib/api";
import { requireRole, requireUser, verifyCsrfRequest } from "@/lib/auth";

import {
  AgentNotFoundError,
  getFindsTodayByAgentId,
  handleAgentRouteError,
  toAgentDto,
  toTickDto,
} from "@/app/api/v1/agents/shared";

type RouteContext = { params: Promise<{ id: string }> };

const RECENT_TICK_LIMIT = 10;

async function requireAgentRow(id: string): Promise<ResearchAgent> {
  const [agent] = await getDatabase()
    .select()
    .from(researchAgents)
    .where(eq(researchAgents.id, id))
    .limit(1);
  if (agent === undefined) throw new AgentNotFoundError(id);
  return agent;
}

/** Old/new values for every field that differs between two agent rows. */
function fieldDiff(
  beforeRow: ResearchAgent,
  afterRow: ResearchAgent,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const key of Object.keys(beforeRow) as Array<keyof ResearchAgent>) {
    if (key === "updatedAt") continue;
    if (beforeRow[key] !== afterRow[key]) {
      before[key] = beforeRow[key] ?? null;
      after[key] = afterRow[key] ?? null;
    }
  }
  return { before, after };
}

// GET /api/v1/agents/[id] — all roles; detail + aggregates + recent ticks.
export async function GET(
  _request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  try {
    await requireUser();
    const id = uuidSchema.safeParse((await context.params).id);
    if (!id.success) {
      return jsonError("validation_failed", "Invalid agent id", 400);
    }

    const [agent, findsToday] = await Promise.all([
      requireAgentRow(id.data),
      getFindsTodayByAgentId(),
    ]);
    const ticks = await getDatabase()
      .select()
      .from(agentTicks)
      .where(eq(agentTicks.agentId, id.data))
      .orderBy(desc(agentTicks.startedAt))
      .limit(RECENT_TICK_LIMIT);

    return jsonSuccess({
      agent: toAgentDto(agent),
      aggregates: {
        findsToday: findsToday.get(id.data) ?? 0,
      },
      recentTicks: ticks.map(toTickDto),
    });
  } catch (error) {
    return handleAgentRouteError(error);
  }
}

// PATCH /api/v1/agents/[id] — admin; cadence/budget/seeds/goal edits (audited).
// Lifecycle state is deliberately NOT editable here: use
// /pause|/resume|/kill so every transition stays individually audited.
export async function PATCH(
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

    // zod v4 .partial() keeps inner .default()s alive, so a parsed payload
    // always contains defaulted fields (status/seedScope/config/...). Only
    // keys present in the RAW body may be written, and lifecycle status is
    // rejected outright: use /pause, /resume or /kill instead.
    const rawBody: unknown = await request.json().catch(() => ({}));
    if (
      typeof rawBody === "object" &&
      rawBody !== null &&
      "status" in rawBody
    ) {
      return jsonError(
        "validation_failed",
        "Use /pause, /resume or /kill to change agent status",
        400,
      );
    }

    const body = agentUpdateSchema.safeParse(rawBody);
    if (!body.success) {
      return jsonError(
        "validation_failed",
        "Invalid agent payload",
        400,
        body.error.flatten(),
      );
    }

    const rawKeys = new Set(
      Object.keys(typeof rawBody === "object" && rawBody !== null ? rawBody : {}),
    );
    const input = body.data;
    const updates: Partial<typeof researchAgents.$inferInsert> = {};
    if (rawKeys.has("name")) updates.name = input.name!;
    if (rawKeys.has("goal")) updates.goal = input.goal!;
    if (rawKeys.has("seedScope")) updates.seedScope = input.seedScope;
    if (rawKeys.has("policyVersion")) {
      updates.policyVersion = input.policyVersion ?? null;
    }
    if (rawKeys.has("budgetSharePct")) {
      updates.budgetSharePct = String(input.budgetSharePct);
    }
    if (rawKeys.has("dailyBudgetUsd")) {
      updates.dailyBudgetUsd = String(input.dailyBudgetUsd);
    }
    if (rawKeys.has("cadenceSeconds")) {
      updates.cadenceSeconds = input.cadenceSeconds;
    }
    if (rawKeys.has("config")) updates.config = input.config;
    if (Object.keys(updates).length === 0) {
      return jsonError(
        "validation_failed",
        "At least one field must be supplied",
        400,
      );
    }

    const beforeRow = await requireAgentRow(id.data);
    const [updated] = await getDatabase()
      .update(researchAgents)
      .set(updates)
      .where(eq(researchAgents.id, id.data))
      .returning();

    const diff = fieldDiff(beforeRow, updated!);
    await getDatabase().insert(auditEvents).values({
      actorUserId: actor.id,
      action: "agent.updated",
      entityType: "research_agent",
      entityId: id.data,
      before: diff.before,
      after: diff.after,
    });

    return jsonSuccess(toAgentDto(updated!));
  } catch (error) {
    return handleAgentRouteError(error);
  }
}
