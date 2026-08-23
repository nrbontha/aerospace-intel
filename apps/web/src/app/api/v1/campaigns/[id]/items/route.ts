import { uuidSchema } from "@asi/contracts";
import { auditEvents } from "@asi/database";
import { getDatabase } from "@asi/database/client";
import { addManualFrontierItem } from "@asi/research";
import type { NextRequest } from "next/server";

import { jsonError, jsonSuccess } from "@/lib/api";
import { requireRole, verifyCsrfRequest } from "@/lib/auth";
import { ZodError } from "zod";

import { handleCampaignRouteError } from "../../shared";

type RouteContext = { params: Promise<{ id: string }> };

// POST /api/v1/campaigns/[id]/items — analyst/admin manual frontier add
// (audited; duplicates by idempotency key are reported, not re-inserted).
export async function POST(
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

    const result = await addManualFrontierItem(id.data, await request.json());
    if (result.item !== null) {
      await getDatabase().insert(auditEvents).values({
        actorUserId: actor.id,
        action: "campaign.frontier_item_added",
        entityType: "research_campaign",
        entityId: id.data,
        after: {
          itemId: result.item.id,
          itemType: result.item.itemType,
          normalizedValue: result.item.normalizedValue,
        },
      });
    }
    return jsonSuccess(
      result.item ?? { duplicate: true as const },
      { status: result.item === null ? 200 : 201 },
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return jsonError("validation_failed", "Invalid frontier item", 400, error.flatten());
    }
    return handleCampaignRouteError(error);
  }
}
