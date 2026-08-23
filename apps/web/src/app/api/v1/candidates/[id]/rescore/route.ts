import { uuidSchema } from "@asi/contracts";
import { getDatabase } from "@asi/database";
import { type NextRequest } from "next/server";

import { jsonError, jsonSuccess, jsonValue } from "@/lib/api";
import { requireRole, verifyCsrfRequest } from "@/lib/auth";
import { rescoreCandidate } from "@/lib/candidate-scoring";
import { AuthorizationError } from "@/lib/rbac";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

function handleRouteError(error: unknown): Response {
  if (error instanceof AuthorizationError) {
    return jsonError(
      error.status === 401 ? "unauthorized" : "forbidden",
      error.message,
      error.status,
    );
  }
  if (error instanceof Error && /not found/i.test(error.message)) {
    return jsonError("not_found", error.message, 404);
  }
  return jsonError("internal_error", "An internal error occurred", 500);
}

/** Re-run the promotion path, appending a new score history row set. */
export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  try {
    await requireRole("analyst", "admin");
    await verifyCsrfRequest(request);

    const id = uuidSchema.safeParse((await context.params).id);
    if (!id.success) {
      return jsonError("validation_failed", "Invalid candidate id", 400);
    }

    const result = await rescoreCandidate(getDatabase(), id.data);
    return jsonSuccess(jsonValue(result.candidate), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
