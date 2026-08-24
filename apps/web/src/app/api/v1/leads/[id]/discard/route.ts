import { z } from "zod";

import { discardLead, LeadNotFoundError } from "@asi/database";
import { getDatabase } from "@asi/database/client";
import type { NextRequest } from "next/server";

import { jsonError, jsonSuccess, jsonValue } from "@/lib/api";
import { requireRole, verifyCsrfRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const discardBodySchema = z.strictObject({
  reason: z.string().trim().min(4, "reason must be at least 4 characters").max(500),
});

// POST /api/v1/leads/[id]/discard — analyst/admin rejection of a lead.
// Terminal status change + audited reason; idempotent for discarded leads.
export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  try {
    const actor = await requireRole("analyst", "admin");
    await verifyCsrfRequest(request);

    const id = z.string().uuid().safeParse((await context.params).id);
    if (!id.success) {
      return jsonError("validation_failed", "Invalid lead id", 400);
    }
    const body = discardBodySchema.safeParse(await request.json());
    if (!body.success) {
      return jsonError("validation_failed", "A reason of at least 4 characters is required", 400, {
        fieldErrors: body.error.flatten().fieldErrors,
      });
    }

    const result = await discardLead(getDatabase(), id.data, actor.id, body.data.reason);
    return jsonSuccess(jsonValue(result), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof LeadNotFoundError) {
      return jsonError("not_found", error.message, 404);
    }
    return jsonError("internal_error", "An internal error occurred", 500);
  }
}
