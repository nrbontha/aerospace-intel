import { scoringProgramCreateSchema } from "@asi/contracts";
import {
  getDatabase,
  listScoringPrograms,
  upsertProgram,
} from "@asi/database";
import { complexityScore, scoringProgramSchema } from "@asi/research/scoring-axial";
import { type NextRequest } from "next/server";

import { jsonError, jsonSuccess, jsonValue } from "@/lib/api";
import { requireRole, requireUser, verifyCsrfRequest } from "@/lib/auth";
import { AuthorizationError } from "@/lib/rbac";

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
      "Program JSON failed the scoring DSL schema",
      400,
      JSON.parse(error.message),
    );
  }
  return jsonError("internal_error", "An internal error occurred", 500);
}

/** Register a challenger program (admin/analyst); versioned per name. */
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
    const create = scoringProgramCreateSchema.safeParse(body);
    if (!create.success) {
      return jsonError(
        "validation_failed",
        "Invalid scoring program registration",
        400,
        create.error.flatten(),
      );
    }

    // The program JSON must satisfy the full DSL schema (weights sum to 1,
    // veto clauses well-formed) — not just the loose storage envelope.
    const program = scoringProgramSchema.parse(create.data.program);

    const registered = await upsertProgram(
      getDatabase(),
      {
        ...create.data,
        program: program as unknown as Record<string, unknown>,
        complexity: create.data.complexity ?? complexityScore(program),
      },
      user.id,
    );

    return jsonSuccess(jsonValue(registered), {
      status: 201,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** List programs, optionally by axis, champion flagged (all roles). */
export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireUser();
    const axisRaw = request.nextUrl.searchParams.get("axis");
    if (
      axisRaw !== null &&
      axisRaw !== "fit" &&
      axisRaw !== "actionability"
    ) {
      return jsonError("validation_failed", "Invalid axis filter", 400);
    }
    const programs = await listScoringPrograms(
      getDatabase(),
      axisRaw === null ? {} : { axis: axisRaw },
    );

    return jsonSuccess(jsonValue({ records: programs }), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
