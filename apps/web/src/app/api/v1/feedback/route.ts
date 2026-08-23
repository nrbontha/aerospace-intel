import { feedbackCreateSchema, paginatedQuerySchema, uuidSchema } from "@asi/contracts";
import { createFeedbackRecord, getDatabase, listFeedbackRecords } from "@asi/database";
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

/** Record structured analyst/partner feedback (analyst/admin; audited). */
export async function POST(request: NextRequest): Promise<Response> {
  try {
    const user = await requireRole("analyst", "admin");
    await verifyCsrfRequest(request);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("bad_request", "Request body must be valid JSON", 400);
    }
    const input = feedbackCreateSchema.safeParse(body);
    if (!input.success) {
      return jsonError(
        "validation_failed",
        "Invalid feedback payload (check channel/action and entity reference)",
        400,
        input.error.flatten(),
      );
    }

    const created = await createFeedbackRecord(getDatabase(), {
      ...input.data,
      actor: user.id,
    });
    return jsonSuccess(jsonValue(created), {
      status: 201,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** List feedback with optional channel/candidate/company filters (all roles). */
export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireUser();
    const params = request.nextUrl.searchParams;
    const paging = paginatedQuerySchema.safeParse({
      page: params.get("page") ?? undefined,
      pageSize: params.get("pageSize") ?? undefined,
    });
    if (!paging.success) {
      return jsonError("validation_failed", "Invalid paging parameters", 400);
    }
    const candidateId = params.get("candidateId") ?? undefined;
    const companyId = params.get("companyId") ?? undefined;
    const channel = params.get("channel") ?? undefined;
    if (candidateId !== undefined && !uuidSchema.safeParse(candidateId).success) {
      return jsonError("validation_failed", "Invalid candidateId", 400);
    }
    if (companyId !== undefined && !uuidSchema.safeParse(companyId).success) {
      return jsonError("validation_failed", "Invalid companyId", 400);
    }

    const result = await listFeedbackRecords(getDatabase(), {
      page: paging.data.page,
      pageSize: paging.data.pageSize,
      ...(channel === undefined ? {} : { channel }),
      ...(candidateId === undefined ? {} : { candidateId }),
      ...(companyId === undefined ? {} : { companyId }),
    });
    return jsonPage(result.records, result.page, result.pageSize, result.total);
  } catch (error) {
    return handleRouteError(error);
  }
}
