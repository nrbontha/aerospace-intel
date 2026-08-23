import { frontierItemListQuerySchema, uuidSchema } from "@asi/contracts";
import { listFrontierItems } from "@asi/research";
import type { NextRequest } from "next/server";

import { jsonError, jsonPage } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { AuthorizationError } from "@/lib/rbac";

type RouteContext = { params: Promise<{ id: string }> };

// GET /api/v1/campaigns/[id]/frontier — all roles; paginated items with
// status/type filters scoped to the campaign.
export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  try {
    await requireUser();
    const id = uuidSchema.safeParse((await context.params).id);
    if (!id.success) {
      return jsonError("validation_failed", "Invalid campaign id", 400);
    }
    const query = frontierItemListQuerySchema.safeParse({
      ...Object.fromEntries(request.nextUrl.searchParams),
      campaignId: id.data,
    });
    if (!query.success) {
      return jsonError(
        "validation_failed",
        "Invalid frontier query",
        400,
        query.error.flatten(),
      );
    }
    const result = await listFrontierItems(query.data);
    return jsonPage(result.records, result.page, result.pageSize, result.total);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return jsonError(
        error.status === 401 ? "unauthorized" : "forbidden",
        error.message,
        error.status,
      );
    }
    return jsonError("internal_error", "An internal error occurred", 500);
  }
}
