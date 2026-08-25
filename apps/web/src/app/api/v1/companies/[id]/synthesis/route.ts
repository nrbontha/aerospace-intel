import { uuidSchema } from "@asi/contracts";
import {
  acceptSynthesisGroup,
  getCompanySynthesisTrail,
  getDatabase,
  rejectSynthesisGroup,
  SynthesisPreconditionError,
  SynthesisStaleGroupError,
} from "@asi/database";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { jsonError, jsonSuccess, jsonValue } from "@/lib/api";
import { requireRole, requireUser, verifyCsrfRequest } from "@/lib/auth";
import { AuthorizationError } from "@/lib/rbac";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const reviewSchema = z.object({
  action: z.enum(["accept", "reject"]),
  sourceDocumentId: uuidSchema,
  expectedObservationIds: z.array(uuidSchema),
  reason: z.string().trim().min(1).max(2000).optional(),
});

function handleRouteError(error: unknown): Response {
  if (error instanceof AuthorizationError) {
    return jsonError(
      error.status === 401 ? "unauthorized" : "forbidden",
      error.message,
      error.status,
    );
  }
  if (error instanceof SynthesisStaleGroupError) {
    return jsonError("conflict", error.message, 409, {
      code: error.code,
      expectedObservationIds: [...error.expectedObservationIds],
      currentObservationIds: [...error.currentObservationIds],
    });
  }
  if (error instanceof SynthesisPreconditionError) {
    return jsonError("conflict", error.message, 409, { code: error.code });
  }
  return jsonError("internal_error", "An internal error occurred", 500);
}

/** Any authenticated role may inspect the source-backed synthesis trail. */
export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    await requireUser();
    const id = uuidSchema.safeParse((await context.params).id);
    if (!id.success) {
      return jsonError("validation_failed", "Invalid company id", 400);
    }

    const trail = await getCompanySynthesisTrail(id.data);
    if (trail === null) {
      return jsonError("not_found", "Company not found", 404);
    }
    return jsonSuccess(jsonValue(trail), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Analysts and administrators review a complete source document atomically. */
export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  try {
    const user = await requireRole("analyst", "admin");
    await verifyCsrfRequest(request);

    const id = uuidSchema.safeParse((await context.params).id);
    if (!id.success) {
      return jsonError("validation_failed", "Invalid company id", 400);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("bad_request", "Request body must be valid JSON", 400);
    }
    const parsed = reviewSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(
        "validation_failed",
        "Invalid synthesis review request",
        400,
        parsed.error.flatten(),
      );
    }

    const reviewInput = {
      companyId: id.data,
      sourceDocumentId: parsed.data.sourceDocumentId,
      reviewerId: user.id,
      expectedObservationIds: parsed.data.expectedObservationIds,
    };
    const result = parsed.data.action === "accept"
      ? await acceptSynthesisGroup(getDatabase(), reviewInput)
      : await rejectSynthesisGroup(getDatabase(), {
          ...reviewInput,
          ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }),
        });

    return jsonSuccess(jsonValue({ action: parsed.data.action, ...result }), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
