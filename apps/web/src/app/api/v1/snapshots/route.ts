import {
  knownUniverseSnapshotListQuerySchema,
  snapshotSourceTypeSchema,
} from "@asi/contracts";
import {
  auditEvents,
  createKnownUniverseSnapshot,
  getDatabase,
  knownUniverseSnapshots,
  parseGoldenSetTargets,
  parseGrataData,
  parsePipeline,
  sha256Hex,
  SnapshotKeyConflictError,
} from "@asi/database";
import { and, count, eq, ilike, or, type SQL } from "drizzle-orm";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { jsonError, jsonPage, jsonSuccess, jsonValue } from "@/lib/api";
import { requireRole, requireUser, verifyCsrfRequest } from "@/lib/auth";
import { handleCatalogRouteError } from "@/lib/catalog-api";

export const dynamic = "force-dynamic";

/**
 * Local multipart/query contract pieces. The shared contracts package does
 * not export a snapshot key schema nor a workbook-upload shape yet — this is
 * a reported contract gap; do not treat these as the canonical definitions.
 */
const snapshotKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/);

const uploadFormSchema = z.object({
  key: snapshotKeySchema,
  name: z.string().trim().min(1).max(300),
  sourceType: snapshotSourceTypeSchema,
  effectiveDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  notes: z.string().trim().max(10_000).optional(),
});

interface SnapshotMemberUpload {
  rawName: string;
  rawDomain: string | null;
  sourceRow: number;
  rawPayload: Record<string, unknown>;
}

function membersFromWorkbook(
  sourceType: (typeof snapshotSourceTypeSchema)["options"][number],
  bytes: Uint8Array,
): SnapshotMemberUpload[] | null {
  if (sourceType === "golden_set_workbook") {
    return parseGoldenSetTargets(bytes).companies.map(
      (company) => ({
        rawName: company.name,
        rawDomain: company.domain,
        sourceRow: company.workbookRow,
        rawPayload: company.grataPayload,
      }),
    );
  }
  if (sourceType === "grata_enrichment") {
    return parseGrataData(bytes).map((row) => ({
      rawName: row.name,
      rawDomain: row.domain,
      sourceRow: row.workbookRow,
      rawPayload: row.grataPayload,
    }));
  }
  if (sourceType === "preliminary_pipeline") {
    return parsePipeline(bytes).rows.map((row) => ({
      rawName: row.companyName,
      rawDomain: typeof row.domain === "string" ? row.domain : null,
      sourceRow: row.workbookRow,
      // Verbatim mapped fields; Priority is preserved as text inside.
      rawPayload: {
        companyName: row.companyName,
        category: row.category,
        domain: row.domain,
        stage: row.stage,
        status: row.status,
        Priority: row.rawPriority,
        description: row.description,
        revenue: row.revenue,
        ebitda: row.ebitda,
        ebitdaMargin: row.ebitdaMargin,
        employees: row.employees,
        situationUpdate: row.situationUpdate,
        situationUpdateDate: row.situationUpdateDate,
        nextAction: row.nextAction,
        contactMade: row.contactMade,
        ndaSignedDate: row.ndaSignedDate,
        ioiLoi: row.ioiLoi,
        source: row.source,
        processType: row.processType,
        hq: row.hq,
        ownership: row.ownership,
        contactName: row.contactName,
        contactTitle: row.contactTitle,
        contactEmail: row.contactEmail,
      },
    }));
  }
  // manual / external_export snapshots have no workbook representation yet.
  return null;
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireUser();
    const query = knownUniverseSnapshotListQuerySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    if (!query.success) {
      return jsonError(
        "validation_failed",
        "Invalid snapshot query",
        400,
        query.error.flatten(),
      );
    }
    const conditions: SQL[] = [];
    if (query.data.sourceType !== undefined) {
      conditions.push(eq(knownUniverseSnapshots.sourceType, query.data.sourceType));
    }
    if (query.data.active !== undefined) {
      conditions.push(eq(knownUniverseSnapshots.active, query.data.active));
    }
    if (query.data.query !== undefined) {
      const pattern = `%${query.data.query}%`;
      conditions.push(
        or(
          ilike(knownUniverseSnapshots.key, pattern),
          ilike(knownUniverseSnapshots.name, pattern),
        ) as SQL,
      );
    }
    const where =
      conditions.length === 0 ? undefined : and(...conditions);

    const db = getDatabase();
    const totalResult = await db
      .select({ value: count() })
      .from(knownUniverseSnapshots)
      .where(where);
    const total = Number(totalResult[0]?.value ?? 0);
    const records = await db
      .select()
      .from(knownUniverseSnapshots)
      .where(where)
      .orderBy(knownUniverseSnapshots.effectiveDate, knownUniverseSnapshots.createdAt)
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

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const actor = await requireRole("analyst", "admin");
    await verifyCsrfRequest(request);
    const form = await request.formData();
    const file = form.get("file");
    const parsedForm = uploadFormSchema.safeParse({
      key: String(form.get("key") ?? ""),
      name: String(form.get("name") ?? ""),
      sourceType: String(form.get("sourceType") ?? ""),
      ...(form.get("effectiveDate") === null
        ? {}
        : { effectiveDate: String(form.get("effectiveDate")) }),
      ...(form.get("notes") === null ? {} : { notes: String(form.get("notes")) }),
    });
    if (!parsedForm.success) {
      return jsonError(
        "validation_failed",
        "Invalid snapshot upload",
        400,
        parsedForm.error.flatten(),
      );
    }
    if (!(file instanceof File)) {
      return jsonError("validation_failed", "An xlsx workbook file is required", 400);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let members: SnapshotMemberUpload[];
    try {
      const parsed = membersFromWorkbook(parsedForm.data.sourceType, bytes);
      if (parsed === null) {
        return jsonError(
          "bad_request",
          `Workbook upload is not supported for source type ${parsedForm.data.sourceType}`,
          400,
        );
      }
      members = parsed;
    } catch {
      return jsonError("validation_failed", "File is not a valid xlsx workbook", 400);
    }
    if (members.length === 0) {
      return jsonError(
        "bad_request",
        `Workbook upload is not supported for source type ${parsedForm.data.sourceType}`,
        400,
      );
    }

    const result = await createKnownUniverseSnapshot(getDatabase(), {
      key: parsedForm.data.key,
      name: parsedForm.data.name,
      sourceType: parsedForm.data.sourceType,
      importFileName: file.name || `${parsedForm.data.key}.xlsx`,
      effectiveDate: parsedForm.data.effectiveDate ?? null,
      notes: parsedForm.data.notes ?? null,
      createdBy: actor.id,
      contentSha256: sha256Hex(bytes),
      members,
    });
    if (result.status === "created") {
      await getDatabase().insert(auditEvents).values({
        actorUserId: actor.id,
        action: "known_universe.snapshot_created",
        entityType: "known_universe_snapshot",
        entityId: result.snapshot.id,
        requestId: request.headers.get("x-request-id"),
        metadata: {
          key: parsedForm.data.key,
          memberCount: result.memberCount,
          matchBreakdown: result.matchBreakdown,
        },
      });
    }
    return jsonSuccess(jsonValue(result), { status: 201 });
  } catch (error) {
    if (error instanceof SnapshotKeyConflictError) {
      return jsonError("conflict", error.message, 409, {
        key: error.key,
        storedSha256: error.storedSha256,
        incomingSha256: error.incomingSha256,
      });
    }
    return handleCatalogRouteError(error);
  }
}
