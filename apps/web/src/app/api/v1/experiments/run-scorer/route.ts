import { experimentRunDtoSchema } from "@asi/contracts";
import { getDatabase, recordExperimentRun } from "@asi/database";
import { type NextRequest } from "next/server";
import { requireRole, verifyCsrfRequest } from "@/lib/auth";
import { jsonError, jsonSuccess, jsonValue } from "@/lib/api";
import { AuthorizationError } from "@/lib/rbac";

import {
  runGoldenSetEvaluation,
  runScorerRequestSchema,
} from "../_lib/run-scorer";

export const dynamic = "force-dynamic";

function handleRouteError(error: unknown): Response {
  if (error instanceof AuthorizationError) {
    return jsonError(
      error.status === 401 ? "unauthorized" : "forbidden",
      error.message,
      error.status,
    );
  }
  if (error instanceof Error && error.name === "ZodError") {
    return jsonError(
      "validation_failed",
      "Invalid scoring program",
      400,
      JSON.parse(error.message),
    );
  }
  return jsonError("internal_error", "An internal error occurred", 500);
}

/**
 * Run the scoring-axial evaluation harness over the frozen v1 golden
 * fixtures and journal the result as an append-only `scorer` run.
 */
export async function POST(request: NextRequest): Promise<Response> {
  try {
    const user = await requireRole("analyst", "admin");
    await verifyCsrfRequest(request);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("bad_request", "Request body must be valid JSON", 400);
    }
    const parsed = runScorerRequestSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(
        "validation_failed",
        "Invalid run-scorer request",
        400,
        parsed.error.flatten(),
      );
    }

    const outcome = await runGoldenSetEvaluation(
      getDatabase(),
      parsed.data,
      user.id,
    );

    const run = await recordExperimentRun(
      getDatabase(),
      {
        kind: "scorer",
        label: parsed.data.label,
        primaryMetricName: outcome.primaryMetricName,
        primaryMetricValue: outcome.primaryMetricValue ?? undefined,
        result: outcome.result,
      },
      user.id,
    );
    const validated = experimentRunDtoSchema.parse(run);

    return jsonSuccess(jsonValue(validated), {
      status: 201,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
