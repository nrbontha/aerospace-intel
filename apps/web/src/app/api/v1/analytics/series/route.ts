import { getDashboardSeries } from "@asi/database";

import { jsonSuccess, jsonValue } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { handleCatalogRouteError } from "@/lib/catalog-api";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    await requireUser();
    const series = await getDashboardSeries(30);
    return jsonSuccess(jsonValue(series), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return handleCatalogRouteError(error);
  }
}
