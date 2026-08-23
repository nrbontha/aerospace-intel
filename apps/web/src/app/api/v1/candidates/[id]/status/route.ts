import { candidateStatusSchema, uuidSchema } from "@asi/contracts";
import { getDatabase, updateCandidateStatus } from "@asi/database";
import { type NextRequest } from "next/server";

import { jsonError, jsonSuccess, jsonValue } from "@/lib/api";
import { requireRole, verifyCsrfRequest } from "@/lib/auth";
import { AuthorizationError } from "@/lib/rbac";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Loose transition policy: any current status may move to one of the four
 * human bookkeeping states. Research-lifecycle statuses (queued_research,
 * in_research, research_ready, partner_review) are engine-routed and are
 * deliberately NOT settable by hand.
 */
const MANUAL_TARGET_STATUSES: readonly string[] = [
  "archived",
  "rejected",
  "hold",
  "shortlist",
];

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

/** Manual analyst/admin status change with audit logging. */
export async function PATCH(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  try {
    const user = await requireRole("analyst", "admin");
    await verifyCsrfRequest(request);

    const id = uuidSchema.safeParse((await context.params).id);
    if (!id.success) {
      return jsonError("validation_failed", "Invalid candidate id", 400);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("bad_request", "Request body must be valid JSON", 400);
    }
    const rawStatus =
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>).status
        : undefined;
    const parsed = candidateStatusSchema.safeParse(rawStatus);
    if (!parsed.success || !MANUAL_TARGET_STATUSES.includes(parsed.data)) {
      return jsonError(
        "validation_failed",
        `status must be one of: ${MANUAL_TARGET_STATUSES.join(", ")}`,
        400,
        parsed.success ? undefined : parsed.error.flatten(),
      );
    }

    const updated = await updateCandidateStatus(getDatabase(), {
      candidateId: id.data,
      status: parsed.data,
      actor: user.id,
    });
    return jsonSuccess(jsonValue({ id: updated.id, status: updated.status }), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
