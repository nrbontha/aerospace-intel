import { identityMatchCandidateDecisionSchema, uuidSchema } from "@asi/contracts";
import { applyIdentityMatchDecision } from "@asi/database";
import type { NextRequest } from "next/server";

import { jsonError, jsonSuccess, jsonValue } from "@/lib/api";
import { requireRole, verifyCsrfRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

function handleRouteError(error: unknown): Response {
  if (error instanceof Error && /not found/i.test(error.message)) {
    return jsonError("not_found", error.message, 404);
  }
  if (error instanceof Error && /already decided/i.test(error.message)) {
    return jsonError("conflict", error.message, 409);
  }
  return jsonError("internal_error", "An internal error occurred", 500);
}

// PATCH /api/v1/identity-matches/[id] — analyst/admin decision on a pending
// match. `merged` resolves the lead onto the matched company; every other
// decision only closes the review row (rejected_merge returns a still-
// unresolved lead to `unresolved_lead`). Audited via decidedBy/decidedAt.
export async function PATCH(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  try {
    const actor = await requireRole("analyst", "admin");
    await verifyCsrfRequest(request);

    const id = uuidSchema.safeParse((await context.params).id);
    if (!id.success) {
      return jsonError("validation_failed", "Invalid match id", 400);
    }
    const body = identityMatchCandidateDecisionSchema.safeParse(
      await request.json(),
    );
    if (!body.success) {
      return jsonError(
        "validation_failed",
        "Invalid decision payload",
        400,
        body.error.flatten(),
      );
    }

    const result = await applyIdentityMatchDecision(id.data, {
      decision: body.data.decision,
      decidedBy: actor.id,
      ...(body.data.note === undefined ? {} : { note: body.data.note }),
    });
    return jsonSuccess(jsonValue(result), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
