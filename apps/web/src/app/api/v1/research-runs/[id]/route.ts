import { uuidSchema } from "@asi/contracts";
import { getResearchRunRecord } from "@asi/database";
import type { NextRequest } from "next/server";

import { jsonError, jsonSuccess } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { AuthorizationError } from "@/lib/rbac";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(
  _request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  try {
    await requireUser();

    const id = uuidSchema.safeParse((await context.params).id);
    if (!id.success) {
      return jsonError("validation_failed", "Invalid research run id", 400);
    }

    const run = await getResearchRunRecord(id.data);
    return run === null
      ? jsonError("not_found", "Research run not found", 404)
      : jsonSuccess(run);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return jsonError(
        error.status === 401 ? "unauthorized" : "forbidden",
        error.message,
        error.status,
      );
    }
    return jsonError("internal_error", "An internal error occurred", 500);
  }
}
