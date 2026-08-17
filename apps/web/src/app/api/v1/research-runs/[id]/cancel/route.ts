import { uuidSchema } from "@asi/contracts";
import {
  getResearchRunRecord,
  IllegalResearchRunTransitionError,
  RepositoryConflictError,
  RepositoryNotFoundError,
  setResearchRunState,
} from "@asi/database";
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
  if (error instanceof RepositoryNotFoundError) {
    return jsonError("not_found", "Research run not found", 404);
  }
  if (
    error instanceof RepositoryConflictError ||
    error instanceof IllegalResearchRunTransitionError
  ) {
    return jsonError("conflict", error.message, 409);
  }
  return jsonError("internal_error", "An internal error occurred", 500);
}

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  try {
    await requireRole("analyst", "admin");
    await verifyCsrfRequest(request);

    const id = uuidSchema.safeParse((await context.params).id);
    if (!id.success) {
      return jsonError("validation_failed", "Invalid research run id", 400);
    }

    const current = await getResearchRunRecord(id.data);
    if (current === null) {
      return jsonError("not_found", "Research run not found", 404);
    }
    if (current.status === "cancelled") {
      return jsonSuccess(current);
    }
    if (current.status === "succeeded" || current.status === "failed") {
      return jsonError(
        "conflict",
        `A ${current.status} research run cannot be cancelled`,
        409,
      );
    }

    const cancelled = await setResearchRunState(id.data, {
      status: "cancelled",
      expectedStatus: current.status,
    });
    return jsonSuccess(cancelled);
  } catch (error) {
    return handleRouteError(error);
  }
}
