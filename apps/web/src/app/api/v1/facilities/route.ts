import { facilityListQuerySchema } from "@asi/contracts";
import { listFacilityRecords } from "@asi/database";
import { type NextRequest } from "next/server";

import { jsonError, jsonPage } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { handleCatalogRouteError } from "@/lib/catalog-api";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireUser();
    const query = facilityListQuerySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    if (!query.success) {
      return jsonError(
        "validation_failed",
        "Invalid facility query",
        400,
        query.error.flatten(),
      );
    }
    const result = await listFacilityRecords({
      page: query.data.page,
      pageSize: query.data.pageSize,
      ...(query.data.query === undefined ? {} : { query: query.data.query }),
      ...(query.data.status === undefined ? {} : { status: query.data.status }),
      ...(query.data.companyId === undefined
        ? {}
        : { companyId: query.data.companyId }),
      ...(query.data.country === undefined ? {} : { country: query.data.country }),
    });
    return jsonPage(result.records, result.page, result.pageSize, result.total);
  } catch (error) {
    return handleCatalogRouteError(error);
  }
}
