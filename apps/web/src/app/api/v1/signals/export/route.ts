import {
  dateStamp,
  exportSourceSignals,
  getDatabase,
  normalizeSignalOverviewQuery,
  type NormalizedSignalOverviewQuery,
  type SignalOverviewReadiness,
  type SignalOverviewSort,
  type UnifiedExportFormat,
} from "@asi/database";
import { currentFaaReviewInputContract } from "@asi/research";
import type { NextRequest } from "next/server";

import { jsonError } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { handleCatalogRouteError } from "@/lib/catalog-api";

export const dynamic = "force-dynamic";

const QUERY_PARAMETERS = ["format", "sort", "q", "readiness"] as const;

export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireUser();
    const params = request.nextUrl.searchParams;
    if (QUERY_PARAMETERS.some((name) => params.getAll(name).length > 1)) {
      return jsonError(
        "validation_failed",
        "Use each export query parameter at most once",
        400,
      );
    }
    const requestedFormat = params.get("format") ?? "csv";
    if (requestedFormat !== "csv" && requestedFormat !== "json") {
      return jsonError(
        "validation_failed",
        "format must be csv or json",
        400,
      );
    }
    const format: UnifiedExportFormat = requestedFormat;
    const expectedReviewInputContract = currentFaaReviewInputContract();
    let normalized: NormalizedSignalOverviewQuery;
    try {
      normalized = normalizeSignalOverviewQuery({
        expectedReviewInputContract,
        ...(params.has("sort")
          ? { sort: params.get("sort") as SignalOverviewSort }
          : {}),
        ...(params.has("q") ? { q: params.get("q") ?? "" } : {}),
        ...(params.has("readiness")
          ? {
              readiness: params.get(
                "readiness",
              ) as SignalOverviewReadiness,
            }
          : {}),
      });
    } catch (error) {
      if (error instanceof TypeError) {
        return jsonError("validation_failed", error.message, 400);
      }
      throw error;
    }
    const exported = await exportSourceSignals(getDatabase(), format, {
      expectedReviewInputContract,
      sort: normalized.sort,
      ...(normalized.q === null ? {} : { q: normalized.q }),
      ...(normalized.readiness === null
        ? {}
        : { readiness: normalized.readiness }),
    });
    return new Response(exported.body, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="source-signals-${dateStamp()}.${format}"`,
        "Content-Type":
          format === "csv"
            ? "text/csv; charset=utf-8"
            : "application/json; charset=utf-8",
        "X-Row-Count": String(exported.rowCount),
      },
    });
  } catch (error) {
    return handleCatalogRouteError(error);
  }
}
