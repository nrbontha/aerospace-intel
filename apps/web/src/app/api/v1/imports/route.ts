import { importListQuerySchema } from "@asi/contracts";
import {
  ImportValidationError,
  listImportRecords,
  processImportBatch,
  type ImportableEntity,
} from "@asi/database";
import { type NextRequest } from "next/server";

import { jsonError, jsonPage, jsonSuccess, jsonValue } from "@/lib/api";
import { requireRole, requireUser, verifyCsrfRequest } from "@/lib/auth";
import { handleCatalogRouteError } from "@/lib/catalog-api";

export const dynamic = "force-dynamic";

const IMPORTABLE = new Set<ImportableEntity>(["companies", "facilities"]);

export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireUser();
    const query = importListQuerySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    if (!query.success) {
      return jsonError(
        "validation_failed",
        "Invalid import query",
        400,
        query.error.flatten(),
      );
    }
    const result = await listImportRecords({
      page: query.data.page,
      pageSize: query.data.pageSize,
      ...(query.data.query === undefined ? {} : { query: query.data.query }),
      ...(query.data.status === undefined ? {} : { status: query.data.status }),
    });
    return jsonPage(result.records, result.page, result.pageSize, result.total);
  } catch (error) {
    return handleCatalogRouteError(error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const actor = await requireRole("analyst", "admin");
    await verifyCsrfRequest(request);
    const form = await request.formData();
    const entityValue = String(form.get("entity") ?? "");
    const file = form.get("file");
    const dryRun = String(form.get("dryRun") ?? "false") === "true";
    if (!IMPORTABLE.has(entityValue as ImportableEntity)) {
      return jsonError(
        "validation_failed",
        "Only companies and facilities CSV imports are supported",
        400,
      );
    }
    if (!(file instanceof File)) {
      return jsonError("validation_failed", "A CSV file is required", 400);
    }
    const content = new Uint8Array(await file.arrayBuffer());
    const requestId = request.headers.get("x-request-id")?.trim();
    const batch = await processImportBatch({
      actorUserId: actor.id,
      content,
      dryRun,
      entity: entityValue as ImportableEntity,
      fileName: file.name || `${entityValue}.csv`,
      ...(requestId ? { requestId: requestId.slice(0, 500) } : {}),
    });
    return jsonSuccess(jsonValue(batch), { status: dryRun ? 200 : 201 });
  } catch (error) {
    if (error instanceof ImportValidationError) {
      return jsonError("validation_failed", error.message, 400);
    }
    return handleCatalogRouteError(error);
  }
}
