import { uuidSchema } from "@asi/contracts";
import type { NextRequest } from "next/server";

import { jsonError, jsonSuccess } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { handleCatalogRouteError } from "@/lib/catalog-api";
import {
  readSignalAnalystDetail,
  SIGNAL_HISTORY_LIMIT_MAX,
  SIGNAL_STEP_LIMIT_MAX,
} from "@/lib/signal-analyst.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

function boundedLimit(
  value: string | null,
  fallback: number,
  maximum: number,
): number | null {
  if (value === null) return fallback;
  if (!/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum
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
    const caseLimit = boundedLimit(
      request.nextUrl.searchParams.get("caseLimit"),
      10,
      SIGNAL_HISTORY_LIMIT_MAX,
    );
    const stepLimit = boundedLimit(
      request.nextUrl.searchParams.get("stepLimit"),
      25,
      SIGNAL_STEP_LIMIT_MAX,
    );
    if (caseLimit === null || stepLimit === null) {
      return jsonError(
        "validation_failed",
        `caseLimit must be 1-${SIGNAL_HISTORY_LIMIT_MAX} and stepLimit must be 1-${SIGNAL_STEP_LIMIT_MAX}`,
        400,
      );
    }
    const detail = await readSignalAnalystDetail(signalId.data, {
      caseLimit,
      stepLimit,
    });
    if (detail === null) {
      return jsonError("not_found", "Source signal not found", 404);
    }
    return jsonSuccess(detail, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return handleCatalogRouteError(error);
  }
}
