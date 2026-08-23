import { goldenExampleReviewSchema, uuidSchema } from "@asi/contracts";
import { getDatabase, reviewGoldenExample } from "@asi/database";
import { type NextRequest } from "next/server";

import { jsonError, jsonSuccess, jsonValue } from "@/lib/api";
import { requireRole, verifyCsrfRequest } from "@/lib/auth";
import { handleCatalogRouteError } from "@/lib/catalog-api";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Analyst review decision on a golden example's proposed labels.
 * Requires the reviewed-labels enum set plus a mandatory rationale; the
 * decision and rationale are persisted and audited.
 */
export async function PATCH(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  try {
    const actor = await requireRole("analyst", "admin");
    await verifyCsrfRequest(request);
    const id = uuidSchema.safeParse((await context.params).id);
    if (!id.success) {
      return jsonError("validation_failed", "Invalid golden example id", 400);
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("validation_failed", "Request body must be JSON", 400);
    }
    const payload = goldenExampleReviewSchema.safeParse(body);
    if (!payload.success) {
      return jsonError(
        "validation_failed",
        "Invalid review payload: reviewed labels must use the label enums and a rationale is required",
        400,
        payload.error.flatten(),
      );
    }

    const requestId = request.headers.get("x-request-id")?.trim();
    const updated = await reviewGoldenExample(getDatabase(), {
      exampleId: id.data,
      reviewerId: actor.id,
      rationale: payload.data.rationale,
      ...(payload.data.reviewNotes === undefined
        ? {}
        : { reviewNotes: payload.data.reviewNotes }),
      labels: {
        ...(payload.data.archetypeFit === undefined
          ? {}
          : { archetypeFit: payload.data.archetypeFit }),
        ...(payload.data.currentActionability === undefined
          ? {}
          : { currentActionability: payload.data.currentActionability }),
        ...(payload.data.businessModelFit === undefined
          ? {}
          : { businessModelFit: payload.data.businessModelFit }),
        ...(payload.data.ownershipFit === undefined
          ? {}
          : { ownershipFit: payload.data.ownershipFit }),
        ...(payload.data.goldenExampleType === undefined
          ? {}
          : { goldenExampleType: payload.data.goldenExampleType }),
        ...(payload.data.buildToPrintRisk === undefined
          ? {}
          : { buildToPrintRisk: payload.data.buildToPrintRisk }),
      },
      ...(requestId ? { requestId: requestId.slice(0, 500) } : {}),
    });

    if (updated === null) {
      return jsonError("not_found", "Golden example not found", 404);
    }
    return jsonSuccess(jsonValue(updated));
  } catch (error) {
    return handleCatalogRouteError(error);
  }
}
