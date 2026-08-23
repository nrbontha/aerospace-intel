import { uuidSchema } from "@asi/contracts";
import {
  getDatabase,
  knownUniverseSnapshots,
  listSnapshotMembers,
} from "@asi/database";
import { eq, sql } from "drizzle-orm";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { jsonError, jsonSuccess, jsonValue } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { handleCatalogRouteError } from "@/lib/catalog-api";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

type BreakdownRow = {
  match_status: string;
  count: number;
}

async function matchBreakdown(
  db: ReturnType<typeof getDatabase>,
  snapshotId: string,
): Promise<Record<string, number>> {
  const result = await db.execute<BreakdownRow>(sql`
    SELECT match_status, count(*)::int AS count
    FROM known_universe_members
    WHERE snapshot_id = ${snapshotId}
    GROUP BY match_status
  `);
  return Object.fromEntries(
    result.rows.map((row) => [row.match_status, row.count]),
  );
}

/** Local query contract — pagination + member filters (contract gap noted). */
const membersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  matchStatus: z
    .enum(["exact", "probable", "possible", "none", "unresolved"])
    .optional(),
  query: z.string().trim().max(200).optional(),
});

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  try {
    await requireUser();
    const id = uuidSchema.safeParse((await context.params).id);
    if (!id.success) {
      return jsonError("validation_failed", "Invalid snapshot id", 400);
    }
    const query = membersQuerySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    if (!query.success) {
      return jsonError(
        "validation_failed",
        "Invalid member query",
        400,
        query.error.flatten(),
      );
    }

    const db = getDatabase();
    const snapshots = await db
      .select()
      .from(knownUniverseSnapshots)
      .where(eq(knownUniverseSnapshots.id, id.data))
      .limit(1);
    const snapshot = snapshots[0];
    if (snapshot === undefined) {
      return jsonError("not_found", "Snapshot not found", 404);
    }

    const { records, total } = await listSnapshotMembers(db, {
      snapshotId: snapshot.id,
      page: query.data.page,
      pageSize: query.data.pageSize,
      ...(query.data.matchStatus === undefined
        ? {}
        : { matchStatus: query.data.matchStatus }),
      ...(query.data.query === undefined ? {} : { query: query.data.query }),
    });

    return jsonSuccess(
      jsonValue({
        snapshot,
        totalMembers: total,
        matchBreakdown: await matchBreakdown(db, snapshot.id),
        membersPage: {
          page: query.data.page,
          pageSize: query.data.pageSize,
          totalItems: total,
          totalPages: Math.ceil(total / query.data.pageSize) || 0,
        },
        members: records,
      }),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return handleCatalogRouteError(error);
  }
}
