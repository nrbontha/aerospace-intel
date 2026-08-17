import {
  dataSourceCreateSchema,
  dataSourceListQuerySchema,
} from "@asi/contracts";
import { createDataSourceRecord, listDataSourceRecords } from "@asi/database";
import { NextResponse, type NextRequest } from "next/server";

import { jsonError, jsonSuccess } from "@/lib/api";
import { requireRole, requireUser, verifyCsrfRequest } from "@/lib/auth";
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

function serializeSource(record: unknown): unknown {
  if (typeof record !== "object" || record === null) return jsonValue(record);

  const {
    baseUrl,
    homepageUrl,
    ingestion,
    ingestionMethod,
    notes,
    description,
    ...source
  } = record as Record<string, unknown>;
  const publicHomepageUrl = homepageUrl ?? baseUrl;
  const publicIngestionMethod = ingestionMethod ?? ingestion;
  const publicDescription = description ?? notes;

  return jsonValue({
    ...source,
    ...(publicHomepageUrl == null ? {} : { homepageUrl: publicHomepageUrl }),
    ...(publicIngestionMethod == null
      ? {}
      : { ingestionMethod: publicIngestionMethod }),
    ...(publicDescription == null ? {} : { description: publicDescription }),
  });
}

function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  if ("cause" in error) return postgresErrorCode(error.cause);
  return undefined;
}

function handleRouteError(error: unknown): Response {
  if (error instanceof AuthorizationError) {
    return jsonError(
      error.status === 401 ? "unauthorized" : "forbidden",
      error.message,
      error.status,
    );
  }
  if (postgresErrorCode(error) === "23505") {
    return jsonError("conflict", "That data source already exists", 409);
  }
  return jsonError("internal_error", "An internal error occurred", 500);
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireUser();

    const query = dataSourceListQuerySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    if (!query.success) {
      return jsonError(
        "validation_failed",
        "Invalid data source query",
        400,
        query.error.flatten(),
      );
    }

    const { page, pageSize } = query.data;
    if (query.data.status !== undefined && query.data.status !== "active") {
      return NextResponse.json(
        {
          data: [],
          meta: { page, pageSize, totalItems: 0, totalPages: 0 },
        },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    }

    const result = await listDataSourceRecords({
      page,
      pageSize,
      ...(query.data.query === undefined ? {} : { query: query.data.query }),
      ...(query.data.access === undefined ? {} : { access: query.data.access }),
      ...(query.data.ingestionMethod === undefined
        ? {}
        : { ingestion: query.data.ingestionMethod }),
    });

    return NextResponse.json(
      {
        data: result.records.map(serializeSource),
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

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const actor = await requireRole("analyst", "admin");
    await verifyCsrfRequest(request);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("bad_request", "Request body must be valid JSON", 400);
    }

    const input = dataSourceCreateSchema.safeParse(body);
    if (!input.success) {
      return jsonError(
        "validation_failed",
        "Invalid data source",
        400,
        input.error.flatten(),
      );
    }

    const created = await createDataSourceRecord(
      {
        name: input.data.name,
        ...(input.data.description === undefined
          ? {}
          : { description: input.data.description }),
        ...(input.data.homepageUrl === undefined
          ? {}
          : { homepageUrl: input.data.homepageUrl }),
        access: input.data.access,
        ingestionMethod: input.data.ingestionMethod,
        status: input.data.status,
        metadata: input.data.metadata,
      },
      actor.id,
    );
    return jsonSuccess(serializeSource(created), {
      status: 201,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
