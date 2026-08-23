import { uuidSchema } from "@asi/contracts";
import { planCampaign } from "@asi/research";
import { auditEvents } from "@asi/database";
import { getDatabase } from "@asi/database/client";
import type { NextRequest } from "next/server";

import { jsonError, jsonSuccess } from "@/lib/api";
import { requireRole, verifyCsrfRequest } from "@/lib/auth";

import { handleCampaignRouteError } from "../../shared";

type RouteContext = { params: Promise<{ id: string }> };

// POST /api/v1/campaigns/[id]/plan — analyst/admin; expands seeds into
// initial frontier items (audited). The searchable-source registry is
// injected by the caller; until the source-adapter wave lands it is empty
// and only non-source seeds are expanded.
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

    const result = await planCampaign(id.data, { searchableSources: [] });
    await getDatabase().insert(auditEvents).values({
      actorUserId: actor.id,
      action: "campaign.planned",
      entityType: "research_campaign",
      entityId: id.data,
      after: {
        frontierItemsPlanned: result.totalPlanned,
        frontierItemsInserted: result.inserted,
      },
    });
    return jsonSuccess(result);
  } catch (error) {
    return handleCampaignRouteError(error);
  }
}
