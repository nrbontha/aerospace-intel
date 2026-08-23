import { goldenExampleListQuerySchema } from "@asi/contracts";
import { getDatabase, goldenExamples } from "@asi/database";
import { and, count, eq, ilike, or, type SQL } from "drizzle-orm";
import { type NextRequest } from "next/server";

import { jsonError, jsonPage, jsonValue } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { handleCatalogRouteError } from "@/lib/catalog-api";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireUser();
    const query = goldenExampleListQuerySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    if (!query.success) {
      return jsonError(
        "validation_failed",
        "Invalid golden example query",
        400,
        query.error.flatten(),
      );
    }

    const conditions: SQL[] = [];
    if (query.data.reviewStatus !== undefined) {
      conditions.push(eq(goldenExamples.reviewStatus, query.data.reviewStatus));
    }
    if (query.data.goldenExampleType !== undefined) {
      conditions.push(
        eq(goldenExamples.goldenExampleType, query.data.goldenExampleType),
      );
    }
    if (query.data.query !== undefined) {
      const pattern = `%${query.data.query}%`;
      conditions.push(
        or(
          ilike(goldenExamples.name, pattern),
          ilike(goldenExamples.domain, pattern),
        ) as SQL,
      );
    }
    const where = conditions.length === 0 ? undefined : and(...conditions);

    const db = getDatabase();
    const totalResult = await db
      .select({ value: count() })
      .from(goldenExamples)
      .where(where);
    const total = Number(totalResult[0]?.value ?? 0);
    const records = await db
      .select()
      .from(goldenExamples)
      .where(where)
      .orderBy(goldenExamples.workbookRow, goldenExamples.createdAt)
      .limit(query.data.pageSize)
      .offset((query.data.page - 1) * query.data.pageSize);
    return jsonPage(
      records.map(jsonValue),
      query.data.page,
      query.data.pageSize,
      total,
    );
  } catch (error) {
    return handleCatalogRouteError(error);
  }
}
