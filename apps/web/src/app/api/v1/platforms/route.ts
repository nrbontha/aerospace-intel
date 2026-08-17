import { platformListQuerySchema } from "@asi/contracts";
import { listPlatformRecords } from "@asi/database";
import { type NextRequest } from "next/server";

import { jsonError, jsonPage } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { handleCatalogRouteError } from "@/lib/catalog-api";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireUser();
    const query = platformListQuerySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    if (!query.success) {
      return jsonError(
        "validation_failed",
        "Invalid platform query",
        400,
        query.error.flatten(),
      );
    }
    const result = await listPlatformRecords({
      page: query.data.page,
      pageSize: query.data.pageSize,
      ...(query.data.query === undefined ? {} : { query: query.data.query }),
      ...(query.data.manufacturerCompanyId === undefined
        ? {}
        : { manufacturerCompanyId: query.data.manufacturerCompanyId }),
    });
    return jsonPage(result.records, result.page, result.pageSize, result.total);
  } catch (error) {
    return handleCatalogRouteError(error);
  }
}
