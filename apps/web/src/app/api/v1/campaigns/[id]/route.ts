import { uuidSchema } from "@asi/contracts";
import { getCampaignDetail } from "@asi/research";
import type { NextRequest } from "next/server";

import { jsonError, jsonSuccess } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { handleCampaignRouteError } from "../shared";

type RouteContext = { params: Promise<{ id: string }> };

// GET /api/v1/campaigns/[id] — all roles; includes spend vs budget and
// frontier status breakdown.
export async function GET(
  _request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  try {
    await requireUser();
    const id = uuidSchema.safeParse((await context.params).id);
    if (!id.success) {
      return jsonError("validation_failed", "Invalid campaign id", 400);
    }
    const detail = await getCampaignDetail(id.data);
    return jsonSuccess(detail);
  } catch (error) {
    return handleCampaignRouteError(error);
  }
}
