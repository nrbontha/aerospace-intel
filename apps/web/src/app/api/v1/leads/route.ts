import { leadListQuerySchema, uuidSchema } from "@asi/contracts";
import type { NextRequest } from "next/server";

import { listLeads } from "@asi/database";

import { jsonError, jsonPage, jsonValue } from "@/lib/api";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

const leadListRouteQuerySchema = leadListQuerySchema.extend({
  campaignId: uuidSchema.optional(),
});

/** `q` is accepted as a friendlier alias for the contract's `query`. */
function searchParamAlias(params: URLSearchParams): string | null {
  return params.get("query") ?? params.get("q");
}

// GET /api/v1/leads?campaignId=&status= — lead pipeline listing with
// per-lead identity-match summary tallies.
export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireUser();
    // Parse ONLY the declared keys — strictObject rejects unknown keys, so
    // spreading every searchParam here would 400/500 on any filter.
    const params = request.nextUrl.searchParams;
    const search = searchParamAlias(params);
    const parsed = {
      ...(params.get("campaignId") === null
        ? {}
        : { campaignId: params.get("campaignId") }),
      ...(params.get("status") === null ? {} : { status: params.get("status") }),
      ...(search === null || search.length === 0 ? {} : { query: search }),
      ...(params.get("page") === null ? {} : { page: params.get("page") }),
      ...(params.get("pageSize") === null
        ? {}
        : { pageSize: params.get("pageSize") }),
    };
    const query = leadListRouteQuerySchema.safeParse(parsed);
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
      ...(query.data.query === undefined ? {} : { query: query.data.query }),
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
