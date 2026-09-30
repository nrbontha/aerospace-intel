import { uuidSchema } from "@asi/contracts";
import type { NextRequest } from "next/server";

import { jsonError, jsonSuccess } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { handleCatalogRouteError } from "@/lib/catalog-api";
import {
  readSignalTimeline,
  SIGNAL_TIMELINE_LIMIT_MAX,
} from "@/lib/signal-analyst.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const QUERY_PARAMETERS = ["limit", "after"] as const;

function boundedLimit(value: string | null): number | null {
  if (value === null) return 50;
  if (!/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) &&
    parsed >= 1 &&
    parsed <= SIGNAL_TIMELINE_LIMIT_MAX
    ? parsed
    : null;
}

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  try {
    await requireUser();
    const signalId = uuidSchema.safeParse((await context.params).id);
    if (!signalId.success) {
      return jsonError("validation_failed", "Invalid source signal id", 400);
    }

    const params = request.nextUrl.searchParams;
    if (
      [...params.keys()].some(
        (name) =>
          !QUERY_PARAMETERS.includes(name as (typeof QUERY_PARAMETERS)[number]),
      ) ||
      QUERY_PARAMETERS.some((name) => params.getAll(name).length > 1)
    ) {
      return jsonError(
        "validation_failed",
        "Use one limit and one opaque timeline cursor",
        400,
      );
    }

    const limit = boundedLimit(params.get("limit"));
    if (limit === null) {
      return jsonError(
        "validation_failed",
        `limit must be an integer from 1 to ${SIGNAL_TIMELINE_LIMIT_MAX}`,
        400,
      );
    }

    const after = params.get("after");
    if (after !== null && after.length > 1_024) {
      return jsonError(
        "validation_failed",
        "Invalid source-signal timeline cursor",
        400,
      );
    }

    try {
      const page = await readSignalTimeline(signalId.data, {
        limit,
        ...(after === null ? {} : { after }),
      });
      if (page === null) {
        return jsonError("not_found", "Source signal not found", 404);
      }
      return jsonSuccess(page, {
        headers: { "Cache-Control": "private, no-store" },
      });
    } catch (error) {
      if (error instanceof TypeError) {
        return jsonError(
          "validation_failed",
          "Invalid source-signal timeline cursor",
          400,
        );
      }
      throw error;
    }
  } catch (error) {
    return handleCatalogRouteError(error);
  }
}
