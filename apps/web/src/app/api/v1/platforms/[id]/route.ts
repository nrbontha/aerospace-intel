import { uuidSchema } from "@asi/contracts";
import { getPlatformRecord } from "@asi/database";

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
      return jsonError("validation_failed", "Invalid platform id", 400);
    }
    const platform = await getPlatformRecord(id.data);
    return platform === null
      ? jsonError("not_found", "Platform not found", 404)
      : jsonSuccess(jsonValue(platform), {
          headers: { "Cache-Control": "private, no-store" },
        });
  } catch (error) {
    return handleCatalogRouteError(error);
  }
}
