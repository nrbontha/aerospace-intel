import { companyMergeCreateSchema, mergeListQuerySchema } from "@asi/contracts";
import {
  listCompanyMergeRecords,
  mergeCompanyRecordsById,
} from "@asi/database";
import type { NextRequest } from "next/server";

import { jsonError, jsonPage, jsonSuccess } from "@/lib/api";
import { requireRole, requireUser, verifyCsrfRequest } from "@/lib/auth";
import { AuthorizationError } from "@/lib/rbac";

export const dynamic = "force-dynamic";

function handleRouteError(error: unknown): Response {
  if (error instanceof AuthorizationError) {
    return jsonError(
      error.status === 401 ? "unauthorized" : "forbidden",
      error.message,
      error.status,
    );
  }
  if (
    error instanceof Error &&
    error.message === "Both exact company IDs must exist"
  ) {
    return jsonError("not_found", "Company not found", 404);
  }
  return jsonError("internal_error", "An internal error occurred", 500);
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireUser();
    const query = mergeListQuerySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    if (!query.success) {
      return jsonError(
        "validation_failed",
        "Invalid company merge query",
        400,
        query.error.flatten(),
      );
    }
    const result = await listCompanyMergeRecords({
      page: query.data.page,
      pageSize: query.data.pageSize,
      ...(query.data.query === undefined ? {} : { query: query.data.query }),
      ...(query.data.companyId === undefined
        ? {}
        : { companyId: query.data.companyId }),
      ...(query.data.status === undefined ? {} : { status: query.data.status }),
    });
    return jsonPage(result.records, result.page, result.pageSize, result.total);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const actor = await requireRole("analyst", "admin");
    await verifyCsrfRequest(request);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("bad_request", "Request body must be valid JSON", 400);
    }

    const input = companyMergeCreateSchema.safeParse(body);
    if (!input.success) {
      return jsonError(
        "validation_failed",
        "Invalid company merge",
        400,
        input.error.flatten(),
      );
    }

    const requestId = request.headers.get("x-request-id");
    const result = await mergeCompanyRecordsById({
      ...input.data,
      actorUserId: actor.id,
      ...(requestId === null ? {} : { requestId }),
    });

    return jsonSuccess(result, {
      status: 201,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
