import { z } from "zod";

import { uuidSchema } from "@asi/contracts";
import { getDatabase, rejectProgram } from "@asi/database";
import { type NextRequest } from "next/server";

import { jsonError, jsonSuccess, jsonValue } from "@/lib/api";
import { requireRole, verifyCsrfRequest } from "@/lib/auth";
import { AuthorizationError } from "@/lib/rbac";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const rejectSchema = z.strictObject({
  rationale: z.string().trim().min(1).max(10_000),
});

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

/** Reject a challenger program (terminal status). */
export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  try {
    const user = await requireRole("analyst", "admin");
    await verifyCsrfRequest(request);

    const id = uuidSchema.safeParse((await context.params).id);
    if (!id.success) {
      return jsonError("validation_failed", "Invalid scoring program id", 400);
    }

    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const parsed = rejectSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(
        "validation_failed",
        "rationale (string) is required",
        400,
        parsed.error.flatten(),
      );
    }

    const rejected = await rejectProgram(
      getDatabase(),
      id.data,
      parsed.data.rationale,
      user.id,
    );

    return jsonSuccess(jsonValue(rejected), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
