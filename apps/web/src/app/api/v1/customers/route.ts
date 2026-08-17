import { customerListQuerySchema } from "@asi/contracts";
import { listCustomerRecords } from "@asi/database";
import { type NextRequest } from "next/server";

import { jsonError, jsonPage } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { handleCatalogRouteError } from "@/lib/catalog-api";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireUser();
    const query = customerListQuerySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    if (!query.success) {
      return jsonError(
        "validation_failed",
        "Invalid customer query",
        400,
        query.error.flatten(),
      );
    }
    const result = await listCustomerRecords({
      page: query.data.page,
      pageSize: query.data.pageSize,
      ...(query.data.query === undefined ? {} : { query: query.data.query }),
      ...(query.data.country === undefined ? {} : { country: query.data.country }),
    });
    return jsonPage(result.records, result.page, result.pageSize, result.total);
  } catch (error) {
    return handleCatalogRouteError(error);
  }
}
