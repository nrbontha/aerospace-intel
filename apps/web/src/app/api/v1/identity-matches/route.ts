import { paginatedQuerySchema } from "@asi/contracts";
import type { NextRequest } from "next/server";

import { listIdentityMatches } from "@asi/database";

import { jsonError, jsonPage, jsonValue } from "@/lib/api";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET /api/v1/identity-matches?status=pending — identity-match review queue
// with lead + company context; defaults to the pending decision state.
export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireUser();
    // strictObject: parse ONLY the declared pagination keys, never the raw
    // searchParams (an unknown key such as status would fail validation).
    const params = request.nextUrl.searchParams;
    const query = paginatedQuerySchema.safeParse({
      ...(params.get("page") === null ? {} : { page: params.get("page") }),
      ...(params.get("pageSize") === null
        ? {}
        : { pageSize: params.get("pageSize") }),
    });
    if (!query.success) {
      return jsonError(
        "validation_failed",
        "Invalid identity-match query",
        400,
        query.error.flatten(),
      );
    }
    const status = params.get("status") ?? undefined;
    const result = await listIdentityMatches({
      ...(status === undefined ? {} : { status }),
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
