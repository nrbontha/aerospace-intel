import { uuidSchema } from "@asi/contracts";
import { getDatabase, getExperimentRun, listExperimentRuns } from "@asi/database";
import { type NextRequest } from "next/server";

import { jsonError, jsonSuccess, jsonValue } from "@/lib/api";
import { requireUser } from "@/lib/auth";
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
  return jsonError("internal_error", "An internal error occurred", 500);
}

export async function GET(
  _request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  try {
    await requireUser();
    const id = uuidSchema.safeParse((await context.params).id);
    if (!id.success) {
      return jsonError("validation_failed", "Invalid experiment run id", 400);
    }

    const db = getDatabase();
    const run = await getExperimentRun(db, id.data);
    if (run === null) {
      return jsonError("not_found", "Experiment run not found", 404);
    }
    const { records: children } = await listExperimentRuns(db, {
      lineageParentId: id.data,
      limit: 100,
    });

    return jsonSuccess(jsonValue({ ...run, children }), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
