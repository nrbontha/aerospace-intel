import { companyAliasCreateSchema, uuidSchema } from "@asi/contracts";
import {
  createCompanyAliasRecord,
  RepositoryConflictError,
  RepositoryNotFoundError,
} from "@asi/database";
import type { NextRequest } from "next/server";

import { jsonError, jsonSuccess, jsonValue } from "@/lib/api";
import { requireRole, verifyCsrfRequest } from "@/lib/auth";
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
  if (error instanceof RepositoryNotFoundError) {
    return jsonError("not_found", "Company not found", 404);
  }
  if (error instanceof RepositoryConflictError) {
    return jsonError("conflict", error.message, 409);
  }
  return jsonError("internal_error", "An internal error occurred", 500);
}

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  try {
    await requireRole("analyst", "admin");
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

    const input = companyAliasCreateSchema.safeParse(body);
    if (!input.success) {
      return jsonError(
        "validation_failed",
        "Invalid company alias",
        400,
        input.error.flatten(),
      );
    }

    const created = await createCompanyAliasRecord({
      companyId: id.data,
      alias: input.data.alias,
      aliasType: input.data.aliasType,
      ...(input.data.isPrimary === undefined
        ? {}
        : { isPrimary: input.data.isPrimary }),
    });
    return jsonSuccess(jsonValue(created), {
      status: 201,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
