import { campaignCreateSchema, paginatedQuerySchema } from "@asi/contracts";
import { auditEvents } from "@asi/database";
import { getDatabase } from "@asi/database/client";
import { createCampaign, listCampaigns } from "@asi/research";
import type { NextRequest } from "next/server";

import { jsonError, jsonPage, jsonSuccess } from "@/lib/api";
import { requireRole, requireUser, verifyCsrfRequest } from "@/lib/auth";
import { AuthorizationError } from "@/lib/rbac";

function handleRouteError(error: unknown): Response {
  if (error instanceof AuthorizationError) {
    return jsonError(
      error.status === 401 ? "unauthorized" : "forbidden",
      error.message,
      error.status,
    );
  }
  if (isUniqueViolation(error)) {
    return jsonError("conflict", "A campaign with that name already exists", 409);
  }
  return jsonError("internal_error", "An internal error occurred", 500);
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return error.code === "23505";
}

// GET /api/v1/campaigns — all roles.
export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireUser();
    const query = paginatedQuerySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    if (!query.success) {
      return jsonError(
        "validation_failed",
        "Invalid campaign query",
        400,
        query.error.flatten(),
      );
    }
    const result = await listCampaigns({
      page: query.data.page,
      pageSize: query.data.pageSize,
    });
    return jsonPage(result.records, result.page, result.pageSize, result.total);
  } catch (error) {
    return handleRouteError(error);
  }
}

// POST /api/v1/campaigns — analyst/admin create a draft campaign (audited).
export async function POST(request: NextRequest): Promise<Response> {
  try {
    const actor = await requireRole("analyst", "admin");
    await verifyCsrfRequest(request);

    const body = campaignCreateSchema.safeParse(await request.json());
    if (!body.success) {
      return jsonError(
        "validation_failed",
        "Invalid campaign payload",
        400,
        body.error.flatten(),
      );
    }
    const created = await createCampaign(body.data, { creator: actor.id });
    await getDatabase().insert(auditEvents).values({
      actorUserId: actor.id,
      action: "campaign.created",
      entityType: "research_campaign",
      entityId: created.id,
      after: { name: created.name, status: created.status },
    });
    return jsonSuccess(created, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
