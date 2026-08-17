import { qualificationListQuerySchema } from "@asi/contracts";
import { listQualificationRecords } from "@asi/database";
import { type NextRequest } from "next/server";

import { jsonError, jsonPage } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { handleCatalogRouteError } from "@/lib/catalog-api";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireUser();
    const query = qualificationListQuerySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    if (!query.success) {
      return jsonError(
        "validation_failed",
        "Invalid qualification query",
        400,
        query.error.flatten(),
      );
    }
    const result = await listQualificationRecords({
      page: query.data.page,
      pageSize: query.data.pageSize,
      ...(query.data.query === undefined ? {} : { query: query.data.query }),
      ...(query.data.facilityId === undefined
        ? {}
        : { facilityId: query.data.facilityId }),
      ...(query.data.partId === undefined ? {} : { partId: query.data.partId }),
      ...(query.data.platformId === undefined
        ? {}
        : { platformId: query.data.platformId }),
      ...(query.data.customerCompanyId === undefined
        ? {}
        : { customerCompanyId: query.data.customerCompanyId }),
      ...(query.data.scarcity === undefined
        ? {}
        : { scarcity: query.data.scarcity }),
    });
    return jsonPage(result.records, result.page, result.pageSize, result.total);
  } catch (error) {
    return handleCatalogRouteError(error);
  }
}
