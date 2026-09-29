import type { NextRequest } from "next/server";

import { jsonError, jsonSuccess } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { handleCatalogRouteError } from "@/lib/catalog-api";
import type { SignalOverviewPageDto } from "@/lib/signal-analyst";
import {
  listSignalAnalystOverviews,
  parseSignalOverviewCursor,
  SIGNAL_PAGE_LIMIT_MAX,
  type SignalOverviewReadiness,
  type SignalOverviewSort,
  type SourceSignalAnalystOverviewCursor,
} from "@/lib/signal-analyst.server";

export const dynamic = "force-dynamic";

const QUERY_PARAMETERS = [
  "limit",
  "sort",
  "q",
  "readiness",
  "cursor",
] as const;

function boundedLimit(value: string | null): number | null {
  if (value === null) return 50;
  if (!/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= SIGNAL_PAGE_LIMIT_MAX
    ? parsed
    : null;
}

function parseCursor(value: string): SourceSignalAnalystOverviewCursor | null {
  try {
    return parseSignalOverviewCursor(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireUser();
    const params = request.nextUrl.searchParams;
    if (
      params.has("afterCreatedAt") ||
      params.has("afterSignalId") ||
      QUERY_PARAMETERS.some((name) => params.getAll(name).length > 1)
    ) {
      return jsonError(
        "validation_failed",
        "Use one opaque cursor with the current signal query",
        400,
      );
    }

    const limit = boundedLimit(params.get("limit"));
    if (limit === null) {
      return jsonError(
        "validation_failed",
        `limit must be an integer from 1 to ${SIGNAL_PAGE_LIMIT_MAX}`,
        400,
      );
    }

    const sortValue = params.get("sort") ?? "priority";
    if (sortValue !== "priority" && sortValue !== "newest") {
      return jsonError(
        "validation_failed",
        "sort must be priority or newest",
        400,
      );
    }
    const sort: SignalOverviewSort = sortValue;

    const readinessValue = params.get("readiness");
    if (
      readinessValue !== null &&
      readinessValue !== "ready" &&
      readinessValue !== "needs_research" &&
      readinessValue !== "blocked" &&
      readinessValue !== "unscored"
    ) {
      return jsonError(
        "validation_failed",
        "readiness must be ready, needs_research, blocked, or unscored",
        400,
      );
    }
    const readiness =
      readinessValue === null
        ? undefined
        : (readinessValue as SignalOverviewReadiness);

    const rawQuery = params.get("q");
    const q = rawQuery?.trim();
    if (q !== undefined && q.length > 200) {
      return jsonError(
        "validation_failed",
        "q must be at most 200 characters",
        400,
      );
    }

    const rawCursor = params.get("cursor");
    const after = rawCursor === null ? undefined : parseCursor(rawCursor);
    if (after === null) {
      return jsonError(
        "validation_failed",
        "Invalid source-signal cursor",
        400,
      );
    }

    let page: SignalOverviewPageDto;
    try {
      page = await listSignalAnalystOverviews({
        limit,
        sort,
        ...(q === undefined || q === "" ? {} : { q }),
        ...(readiness === undefined ? {} : { readiness }),
        ...(after === undefined ? {} : { after }),
      });
    } catch (error) {
      if (error instanceof TypeError) {
        return jsonError(
          "validation_failed",
          "Cursor does not match the current signal query",
          400,
        );
      }
      throw error;
    }

    return jsonSuccess(page, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return handleCatalogRouteError(error);
  }
}
