import { candidateListQuerySchema, uuidSchema } from "@asi/contracts";
import {
  getDatabase,
  queryCandidates,
  RepositoryNotFoundError,
} from "@asi/database";
import { type NextRequest } from "next/server";

import { jsonError, jsonPage, jsonSuccess, jsonValue } from "@/lib/api";
import { requireRole, requireUser, verifyCsrfRequest } from "@/lib/auth";
import { promoteCompany } from "@/lib/candidate-scoring";
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
  if (error instanceof RepositoryNotFoundError) {
    return jsonError("not_found", "Candidate not found", 404);
  }
  if (error instanceof Error && /not found/i.test(error.message)) {
    return jsonError("not_found", error.message, 404);
  }
  return jsonError("internal_error", "An internal error occurred", 500);
}

/** Promote a resolved company to a scored, routed candidate (analyst/admin). */
export async function POST(request: NextRequest): Promise<Response> {
  try {
    await requireRole("analyst", "admin");
    await verifyCsrfRequest(request);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("bad_request", "Request body must be valid JSON", 400);
    }
    const companyId =
      typeof body === "object" && body !== null
        ? uuidSchema.safeParse((body as Record<string, unknown>).companyId)
        : undefined;
    if (companyId === undefined || !companyId.success) {
      return jsonError(
        "validation_failed",
        "companyId (uuid) is required",
        400,
        companyId === undefined ? undefined : companyId.error.flatten(),
      );
    }

    const result = await promoteCompany(getDatabase(), companyId.data);
    return jsonSuccess(jsonValue(result.candidate), {
      status: result.appendedScoreRows ? 201 : 200,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** List/filter candidates (all roles). */
export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireUser();
    const query = candidateListQuerySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    if (!query.success) {
      return jsonError(
        "validation_failed",
        "Invalid candidate query",
        400,
        query.error.flatten(),
      );
    }
    const result = await queryCandidates(getDatabase(), query.data);
    return jsonPage(result.records, result.page, result.pageSize, result.total);
  } catch (error) {
    return handleRouteError(error);
  }
}
