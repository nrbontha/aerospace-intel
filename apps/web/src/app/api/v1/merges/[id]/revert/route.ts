import { companyMergeRevertSchema, uuidSchema } from "@asi/contracts";
import { revertCompanyMergeById } from "@asi/database";
import type { NextRequest } from "next/server";

import { jsonError, jsonSuccess } from "@/lib/api";
import { requireRole, verifyCsrfRequest } from "@/lib/auth";
import { AuthorizationError } from "@/lib/rbac";

type RouteContext = { params: Promise<{ id: string }> };

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
    error.message === "Applied company merge not found"
  ) {
    return jsonError("not_found", "Applied company merge not found", 404);
  }
  return jsonError("internal_error", "An internal error occurred", 500);
}

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  try {
    const actor = await requireRole("admin");
    await verifyCsrfRequest(request);

    const mergeId = uuidSchema.safeParse((await context.params).id);
    if (!mergeId.success) {
      return jsonError("validation_failed", "Invalid company merge id", 400);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("bad_request", "Request body must be valid JSON", 400);
    }

    const input = companyMergeRevertSchema.safeParse(body);
    if (!input.success) {
      return jsonError(
        "validation_failed",
        "Invalid company merge revert",
        400,
        input.error.flatten(),
      );
    }

    const requestId = request.headers.get("x-request-id");
    await revertCompanyMergeById(mergeId.data, {
      reason: input.data.reason,
      actorUserId: actor.id,
      ...(requestId === null ? {} : { requestId }),
    });

    return jsonSuccess(
      { success: true },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
