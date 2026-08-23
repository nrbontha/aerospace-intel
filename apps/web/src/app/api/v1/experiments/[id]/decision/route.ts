import { z } from "zod";

import { experimentRunDtoSchema, uuidSchema } from "@asi/contracts";
import {
  getDatabase,
  getExperimentRun,
  promoteProgram,
  recordExperimentAudit,
  recordExperimentRun,
} from "@asi/database";
import { selectKeepPromotion } from "@/app/api/v1/experiments/_lib/run-scorer";
import { type NextRequest } from "next/server";

import { jsonError, jsonSuccess, jsonValue } from "@/lib/api";
import { requireRole, verifyCsrfRequest } from "@/lib/auth";
import { AuthorizationError } from "@/lib/rbac";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const decisionSchema = z.strictObject({
  keep: z.boolean(),
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
  return jsonError("internal_error", "An internal error occurred", 500);
}

/**
 * Keep/revert decision on a scorer run. The journal is append-only, so the
 * decision is recorded as a NEW lineage-child run. Keeping the run promotes
 * its best-ranked challenger program (transactional champion flip).
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
      return jsonError("validation_failed", "Invalid experiment run id", 400);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("bad_request", "Request body must be valid JSON", 400);
    }
    const parsed = decisionSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(
        "validation_failed",
        "keep (boolean) and rationale (string) are required",
        400,
        parsed.error.flatten(),
      );
    }

    const db = getDatabase();
    const parent = await getExperimentRun(db, id.data);
    if (parent === null) {
      return jsonError("not_found", "Experiment run not found", 404);
    }

    // Keep promotes ONLY the top-ranked challenger of the run's own evaluated
    // axis (see selectKeepPromotion); everything else requires its own run.
    const entries = Array.isArray(
      (parent.result as { entries?: unknown }).entries,
    )
      ? ((parent.result as { entries: Parameters<typeof selectKeepPromotion>[0] }).entries ?? [])
      : [];
    const selection = selectKeepPromotion(entries);

    let promotedProgramId: string | null = null;
    if (parsed.data.keep && selection.ok) {
      await promoteProgram(
        db,
        selection.programId,
        `keep decision on run ${parent.id}: ${parsed.data.rationale}`,
        user.id,
      );
      promotedProgramId = selection.programId;
    }

    const decision = await recordExperimentRun(
      db,
      {
        kind: parent.kind,
        label: `${parent.label} — decision`,
        primaryMetricName: parent.primaryMetricName,
        primaryMetricValue: parent.primaryMetricValue,
        result: {
          decidedRunId: parent.id,
          keep: parsed.data.keep,
          promotedProgramId,
          ...(parsed.data.keep && !selection.ok
            ? { promotionSkippedReason: selection.reason }
            : {}),
        },
        keep: parsed.data.keep,
        decision: parsed.data.rationale,
        lineageParentId: parent.id,
      },
      user.id,
    );

    await recordExperimentAudit(db, user.id, {
      action: parsed.data.keep ? "keep" : "revert",
      entityType: "experiment_run",
      entityId: decision.id,
      after: { lineageParentId: parent.id, promotedProgramId },
      metadata: { rationale: parsed.data.rationale },
    });

    return jsonSuccess(jsonValue(experimentRunDtoSchema.parse(decision)), {
      status: 201,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
