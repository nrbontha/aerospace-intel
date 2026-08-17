import { uuidSchema } from "@asi/contracts";
import { getCustomerRecord } from "@asi/database";

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
      return jsonError("validation_failed", "Invalid customer id", 400);
    }
    const customer = await getCustomerRecord(id.data);
    return customer === null
      ? jsonError("not_found", "Customer not found", 404)
      : jsonSuccess(jsonValue(customer), {
          headers: { "Cache-Control": "private, no-store" },
        });
  } catch (error) {
    return handleCatalogRouteError(error);
  }
}
