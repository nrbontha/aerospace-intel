import {
  paginatedQuerySchema,
  researchQuestionCreateSchema,
  uuidSchema,
} from "@asi/contracts";
import {
  createResearchQuestionRecord,
  getDatabase,
  listResearchQuestionRecords,
} from "@asi/database";
import { type NextRequest } from "next/server";

import { jsonError, jsonPage, jsonSuccess, jsonValue } from "@/lib/api";
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
  return jsonError("internal_error", "An internal error occurred", 500);
}

/** Open a new research question against a candidate or company (analyst/admin). */
export async function POST(request: NextRequest): Promise<Response> {
  try {
    await requireRole("analyst", "admin");
    await verifyCsrfRequest(request);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("bad_request", "Request body must be valid JSON", 400);
    }
    const input = researchQuestionCreateSchema.safeParse(body);
    if (!input.success) {
      return jsonError(
        "validation_failed",
        "Invalid research question (candidateId or companyId required)",
        400,
        input.error.flatten(),
      );
    }

    const created = await createResearchQuestionRecord(getDatabase(), input.data);
    return jsonSuccess(jsonValue(created), {
      status: 201,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** List research questions with optional entity/status filters (all roles). */
export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireUser();
    const params = request.nextUrl.searchParams;
    const paging = paginatedQuerySchema.safeParse(Object.fromEntries(params));
    if (!paging.success) {
      return jsonError("validation_failed", "Invalid paging parameters", 400);
    }
    const candidateId = params.get("candidateId") ?? undefined;
    const companyId = params.get("companyId") ?? undefined;
    const status = params.get("status") ?? undefined;
    if (candidateId !== undefined && !uuidSchema.safeParse(candidateId).success) {
      return jsonError("validation_failed", "Invalid candidateId", 400);
    }
    if (companyId !== undefined && !uuidSchema.safeParse(companyId).success) {
      return jsonError("validation_failed", "Invalid companyId", 400);
    }
    if (
      status !== undefined &&
      !["open", "answered", "stale"].includes(status)
    ) {
      return jsonError("validation_failed", "Invalid status filter", 400);
    }

    const result = await listResearchQuestionRecords(getDatabase(), {
      page: paging.data.page,
      pageSize: paging.data.pageSize,
      ...(candidateId === undefined ? {} : { candidateId }),
      ...(companyId === undefined ? {} : { companyId }),
      ...(status === undefined ? {} : { status }),
    });
    return jsonPage(result.records, result.page, result.pageSize, result.total);
  } catch (error) {
    return handleRouteError(error);
  }
}
