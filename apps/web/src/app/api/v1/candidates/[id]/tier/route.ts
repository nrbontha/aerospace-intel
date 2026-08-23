import {
  resolveEffectiveTier,
  tierOverrideSchema,
  tierOverrideValues,
  uuidSchema,
} from "@asi/contracts";
import { getDatabase, setHumanTier } from "@asi/database";
import { type NextRequest } from "next/server";

import { jsonError, jsonSuccess, jsonValue } from "@/lib/api";
import { requireRole, verifyCsrfRequest } from "@/lib/auth";
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

/**
 * Human tier override (REDESIGN_PLAN §2.1). Audited: setHumanTier writes
 * tier_override + flips tier_source to 'human' (engine re-routing never
 * clobbers it), records investment feedback, and lands a
 * 'candidate.tier_overridden' audit event in one transaction.
 */
export async function POST(
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
    const record =
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>)
        : {};
    const parsed = tierOverrideSchema.safeParse(record.tier);
    if (!parsed.success) {
      return jsonError(
        "validation_failed",
        `tier must be one of: ${tierOverrideValues.join(", ")}`,
        400,
        parsed.error.flatten(),
      );
    }
    const note = record.note;
    if (
      note !== undefined &&
      (typeof note !== "string" || note.trim().length > 2000)
    ) {
      return jsonError(
        "validation_failed",
        "note must be a string of at most 2000 characters",
        400,
      );
    }

    const updated = await setHumanTier(getDatabase(), {
      candidateId: id.data,
      tier: parsed.data,
      actorId: user.id,
      ...(typeof note === "string" && note.trim() !== ""
        ? { note: note.trim() }
        : {}),
    });
    return jsonSuccess(
      jsonValue({
        id: updated.id,
        status: updated.status,
        tierOverride: updated.tierOverride,
        tierSource: updated.tierSource,
        effectiveTier: resolveEffectiveTier(updated.status, updated.tierOverride),
      }),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
