import { leadListQuerySchema, paginatedQuerySchema, uuidSchema } from "@asi/contracts";
import type { NextRequest } from "next/server";

import { listLeads } from "@asi/database";

import { jsonError, jsonPage, jsonValue } from "@/lib/api";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

const leadListRouteQuerySchema = leadListQuerySchema.extend({
  campaignId: uuidSchema.optional(),
});

// GET /api/v1/leads?campaignId=&status= — lead pipeline listing with
// per-lead identity-match summary tallies.
export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireUser();
    const query = leadListRouteQuerySchema.safeParse({
      ...Object.fromEntries(request.nextUrl.searchParams),
      ...paginatedQuerySchema.parse(
        Object.fromEntries(request.nextUrl.searchParams),
      ),
    });
    if (!query.success) {
      return jsonError(
        "validation_failed",
        "Invalid lead query",
        400,
        query.error.flatten(),
      );
    }
    const result = await listLeads({
      ...(query.data.campaignId === undefined
        ? {}
        : { campaignId: query.data.campaignId }),
      ...(query.data.status === undefined ? {} : { status: query.data.status }),
      page: query.data.page,
      pageSize: query.data.pageSize,
    });
    return jsonPage(
      result.records.map(jsonValue),
      query.data.page,
      query.data.pageSize,
      result.total,
    );
  } catch {
    return jsonError("internal_error", "An internal error occurred", 500);
  }
}
