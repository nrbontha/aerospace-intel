import { frontierItemListQuerySchema } from "@asi/contracts";
import { listFrontierItems } from "@asi/research";
import type { NextRequest } from "next/server";

import { jsonError, jsonPage } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { AuthorizationError } from "@/lib/rbac";

// GET /api/v1/frontier?campaignId=... — all roles; cross-campaign frontier
// listing (campaignId optional).
export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireUser();
    const query = frontierItemListQuerySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
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
