import { exportCreateSchema, exportQuerySchema } from "@asi/contracts";
import { exportRecords, type ExportEntity, type ExportFormat } from "@asi/database";
import { type NextRequest } from "next/server";

import { jsonError } from "@/lib/api";
import { requireUser, verifyCsrfRequest } from "@/lib/auth";
import { handleCatalogRouteError } from "@/lib/catalog-api";

export const dynamic = "force-dynamic";

function fileResponse(file: {
  body: string;
  contentType: string;
  fileName: string;
  rowCount: number;
}): Response {
  return new Response(file.body, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": file.contentType,
      "Content-Disposition": `attachment; filename="${file.fileName}"`,
      "X-Row-Count": String(file.rowCount),
    },
  });
}

async function runExport(input: {
  entity: ExportEntity;
  format: ExportFormat;
  query?: string;
}): Promise<Response> {
  const file = await exportRecords({
    entity: input.entity,
    format: input.format,
    ...(input.query === undefined ? {} : { query: input.query }),
  });
  return fileResponse(file);
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireUser();
    const parsed = exportQuerySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    if (!parsed.success) {
      return jsonError(
        "validation_failed",
        "Invalid export query",
        400,
        parsed.error.flatten(),
      );
    }
    return await runExport({
      entity: parsed.data.entity,
      format: parsed.data.format,
      ...(parsed.data.query === undefined ? {} : { query: parsed.data.query }),
    });
  } catch (error) {
    return handleCatalogRouteError(error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    await requireUser();
    await verifyCsrfRequest(request);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("bad_request", "Request body must be valid JSON", 400);
    }
    const parsed = exportCreateSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(
        "validation_failed",
        "Invalid export request",
        400,
        parsed.error.flatten(),
      );
    }
    const query =
      typeof parsed.data.filters.query === "string"
        ? parsed.data.filters.query
        : undefined;
    return await runExport({
      entity: parsed.data.entity,
      format: parsed.data.format,
      ...(query === undefined ? {} : { query }),
    });
  } catch (error) {
    return handleCatalogRouteError(error);
  }
}
