import { companyListQuerySchema } from "@asi/contracts";
import { listCompanyRecords } from "@asi/database";
import { NextResponse, type NextRequest } from "next/server";

import { jsonError } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { AuthorizationError } from "@/lib/rbac";

export const dynamic = "force-dynamic";

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

export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireUser();

    const query = companyListQuerySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    if (!query.success) {
      return jsonError(
        "validation_failed",
        "Invalid company query",
        400,
        query.error.flatten(),
      );
    }

    const result = await listCompanyRecords({
      page: query.data.page,
      pageSize: query.data.pageSize,
      ...(query.data.query === undefined ? {} : { query: query.data.query }),
      ...(query.data.status === undefined ? {} : { status: query.data.status }),
    });

    return NextResponse.json(
      {
        data: result.records.map(jsonValue),
        meta: {
          page: result.page,
          pageSize: result.pageSize,
          totalItems: result.total,
          totalPages: Math.ceil(result.total / result.pageSize),
        },
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
