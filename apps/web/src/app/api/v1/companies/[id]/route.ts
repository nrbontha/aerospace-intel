import { uuidSchema } from "@asi/contracts";
import { getCompanyRecord, getSupplierScoreInputs } from "@asi/database";
import { scoreSupplier } from "@asi/research";

import { jsonError, jsonSuccess } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { AuthorizationError } from "@/lib/rbac";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

function jsonValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, jsonValue(child)]),
    );
  }
  return value;
}

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
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    await requireUser();

    const id = uuidSchema.safeParse((await context.params).id);
    if (!id.success) {
      return jsonError("validation_failed", "Invalid company id", 400);
    }

    const company = await getCompanyRecord(id.data);
    if (company === null) {
      return jsonError("not_found", "Company not found", 404);
    }
    const scoreInputs = await getSupplierScoreInputs(id.data);
    return jsonSuccess(
      jsonValue({
        ...company,
        scorecard: scoreInputs === null ? null : scoreSupplier(scoreInputs),
      }),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
