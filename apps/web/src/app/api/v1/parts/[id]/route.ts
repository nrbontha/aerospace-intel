import { uuidSchema } from "@asi/contracts";
import { getPartRecord } from "@asi/database";

import { jsonError, jsonSuccess, jsonValue } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { handleCatalogRouteError } from "@/lib/catalog-api";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    await requireUser();
    const id = uuidSchema.safeParse((await context.params).id);
    if (!id.success) {
      return jsonError("validation_failed", "Invalid part id", 400);
    }
    const part = await getPartRecord(id.data);
    return part === null
      ? jsonError("not_found", "Part not found", 404)
      : jsonSuccess(jsonValue(part), {
          headers: { "Cache-Control": "private, no-store" },
        });
  } catch (error) {
    return handleCatalogRouteError(error);
  }
}
