import { uuidSchema } from "@asi/contracts";
import { getDatabase, updateResearchQuestionRecord } from "@asi/database";
import { type NextRequest } from "next/server";

import { jsonError, jsonSuccess, jsonValue } from "@/lib/api";
import { requireRole, verifyCsrfRequest } from "@/lib/auth";
import { AuthorizationError } from "@/lib/rbac";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const UPDATE_STATUSES: readonly string[] = ["open", "answered", "stale"];

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
 * Answer/close (or re-open) a research question. Contract gap note: the
 * contracts package defines no update schema for research questions yet,
 * so the minimal shape is validated here inline.
 */
export async function PATCH(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  try {
    await requireRole("analyst", "admin");
    await verifyCsrfRequest(request);

    const id = uuidSchema.safeParse((await context.params).id);
    if (!id.success) {
      return jsonError("validation_failed", "Invalid question id", 400);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("bad_request", "Request body must be valid JSON", 400);
    }
    if (typeof body !== "object" || body === null) {
      return jsonError("bad_request", "Request body must be a JSON object", 400);
    }
    const record = body as Record<string, unknown>;
    const answer = record.answer;
    const status = record.status;
    const answerValid =
      answer === undefined ||
      (typeof answer === "object" && answer !== null && !Array.isArray(answer));
    const statusValid = typeof status === "string" && UPDATE_STATUSES.includes(status);
    if (!answerValid || !statusValid) {
      return jsonError(
        "validation_failed",
        `answer must be an object when present and status must be one of ${UPDATE_STATUSES.join(", ")}`,
        400,
      );
    }

    const updated = await updateResearchQuestionRecord(getDatabase(), {
      questionId: id.data,
      ...(answer === undefined ? {} : { answer: answer as Record<string, unknown> }),
      status: status as "open" | "answered" | "stale",
    });
    if (updated === null) {
      return jsonError("not_found", "Research question not found", 404);
    }
    return jsonSuccess(jsonValue(updated), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
