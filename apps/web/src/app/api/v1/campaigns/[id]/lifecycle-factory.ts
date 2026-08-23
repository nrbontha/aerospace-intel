import { campaignTransitionSchema, uuidSchema } from "@asi/contracts";
import { auditEvents } from "@asi/database";
import { getDatabase } from "@asi/database/client";
import { applyLifecycleAction } from "@asi/research";
import type { NextRequest } from "next/server";

import { jsonError, jsonSuccess } from "@/lib/api";
import { requireRole, verifyCsrfRequest } from "@/lib/auth";

import { handleCampaignRouteError } from "../shared";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Factory for POST /api/v1/campaigns/[id]/{start,pause,resume,cancel}.
 * The ROUTE is the audit caller: every accepted transition writes an
 * audit_events row with before/after status in the same request.
 */
export function createLifecycleRoute(action: "start" | "pause" | "resume" | "cancel") {
  return async function POST(
    request: NextRequest,
    context: RouteContext,
  ): Promise<Response> {
    try {
      const actor = await requireRole("analyst", "admin");
      await verifyCsrfRequest(request);

      const id = uuidSchema.safeParse((await context.params).id);
      if (!id.success) {
        return jsonError("validation_failed", "Invalid campaign id", 400);
      }

      const rawBody: unknown = await request.json().catch(() => ({}));
      const body = campaignTransitionSchema.safeParse(rawBody ?? {});
      if (!body.success) {
        return jsonError(
          "validation_failed",
          "Invalid lifecycle payload",
          400,
          body.error.flatten(),
        );
      }
      if (body.data.action !== action) {
        return jsonError(
          "validation_failed",
          `This endpoint applies the "${action}" action only`,
          400,
        );
      }

      const result = await applyLifecycleAction(id.data, action);
      await getDatabase().insert(auditEvents).values({
        actorUserId: actor.id,
        action: `campaign.${action}`,
        entityType: "research_campaign",
        entityId: id.data,
        after: {
          status: result.campaign.status,
          ...(body.data.note === undefined ? {} : { note: body.data.note }),
        },
      });
      return jsonSuccess(result.campaign);
    } catch (error) {
      return handleCampaignRouteError(error);
    }
  };
}
