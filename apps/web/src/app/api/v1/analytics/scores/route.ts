import { uuidSchema } from "@asi/contracts";
import {
  getSourceScoreInputs,
  getSupplierScoreInputs,
} from "@asi/database";
import { scoreSource, scoreSupplier } from "@asi/research";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { jsonError, jsonSuccess } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { handleCatalogRouteError } from "@/lib/catalog-api";

export const dynamic = "force-dynamic";

const querySchema = z.strictObject({
  subjectType: z.enum(["company", "data_source"]),
  subjectId: uuidSchema,
});

export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireUser();
    const parsed = querySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    if (!parsed.success) {
      return jsonError(
        "validation_failed",
        "Invalid score query",
        400,
        parsed.error.flatten(),
      );
    }

    if (parsed.data.subjectType === "company") {
      const inputs = await getSupplierScoreInputs(parsed.data.subjectId);
      if (inputs === null) {
        return jsonError("not_found", "Company not found", 404);
      }
      return jsonSuccess(scoreSupplier(inputs), {
        headers: { "Cache-Control": "private, no-store" },
      });
    }

    const inputs = await getSourceScoreInputs(parsed.data.subjectId);
    if (inputs === null) {
      return jsonError("not_found", "Data source not found", 404);
    }
    return jsonSuccess(scoreSource(inputs), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return handleCatalogRouteError(error);
  }
}
