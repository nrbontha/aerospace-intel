import { uuidSchema } from "@asi/contracts";
import {
  getDataSourceRecord,
  getSourceScoreInputs,
  listSourceDocumentRecords,
} from "@asi/database";
import { scoreSource } from "@asi/research";

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
      return jsonError("validation_failed", "Invalid data source id", 400);
    }

    const source = await getDataSourceRecord(id.data);
    if (source === null) {
      return jsonError("not_found", "Data source not found", 404);
    }
    const [scoreInputs, documents] = await Promise.all([
      getSourceScoreInputs(id.data),
      listSourceDocumentRecords(id.data),
    ]);
    const serialized = serializeSource(source);
    return jsonSuccess(
      typeof serialized === "object" && serialized !== null
        ? {
            ...serialized,
            documents: jsonValue(documents),
            scorecard: scoreInputs === null ? null : scoreSource(scoreInputs),
          }
        : serialized,
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
