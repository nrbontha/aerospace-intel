import { uuidSchema } from "@asi/contracts";
import { getImportRecord } from "@asi/database";

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
      return jsonError("validation_failed", "Invalid import id", 400);
    }
    const record = await getImportRecord(id.data);
    return record === null
      ? jsonError("not_found", "Import not found", 404)
      : jsonSuccess(jsonValue(record), {
          headers: { "Cache-Control": "private, no-store" },
        });
  } catch (error) {
    return handleCatalogRouteError(error);
  }
}
