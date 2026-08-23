import {
  knownUniverseSnapshotListQuerySchema,
  snapshotSourceTypeSchema,
} from "@asi/contracts";
import {
  auditEvents,
  createKnownUniverseSnapshot,
  getDatabase,
  knownUniverseSnapshots,
  parseGoldenSetTargetsFromWorkbook,
  parseGrataDataFromWorkbook,
  parsePipelineFromWorkbook,
  readWorkbook,
  sha256Hex,
  SnapshotKeyConflictError,
} from "@asi/database";
import { and, count, eq, ilike, or, type SQL } from "drizzle-orm";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { jsonError, jsonPage, jsonSuccess, jsonValue } from "@/lib/api";
import { requireRole, requireUser, verifyCsrfRequest } from "@/lib/auth";
import { handleCatalogRouteError } from "@/lib/catalog-api";
import {
  MAX_SNAPSHOT_UPLOAD_BYTES,
  MAX_SNAPSHOT_UPLOAD_ROWS,
  validateWorkbookUpload,
} from "@/lib/snapshot-upload-guard";

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

/** SheetJS bounded-read options applied to every snapshot upload. */
const WORKBOOK_READ_LIMITS = {
  maxSheets: 32,
  sheetRows: MAX_SNAPSHOT_UPLOAD_ROWS + 10,
} as const;

function membersFromWorkbook(
  sourceType: (typeof snapshotSourceTypeSchema)["options"][number],
  bytes: Uint8Array,
): SnapshotMemberUpload[] | null {
  const wb = readWorkbook(bytes, WORKBOOK_READ_LIMITS);
  if (sourceType === "golden_set_workbook") {
    return parseGoldenSetTargetsFromWorkbook(wb).companies.map(
      (company) => ({
        rawName: company.name,
        rawDomain: company.domain,
        sourceRow: company.workbookRow,
        rawPayload: company.grataPayload,
      }),
    );
  }
  if (sourceType === "grata_enrichment") {
    return parseGrataDataFromWorkbook(wb).map((row) => ({
      rawName: row.name,
      rawDomain: row.domain,
      sourceRow: row.workbookRow,
      rawPayload: row.grataPayload,
    }));
  }
  if (sourceType === "preliminary_pipeline") {
    return parsePipelineFromWorkbook(wb).rows.map((row) => ({
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

    // Enforce the size cap BEFORE formData() buffers the whole body. The
    // multipart framing adds a small constant overhead; allow for it.
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_SNAPSHOT_UPLOAD_BYTES + 64 * 1024
    ) {
      return jsonError(
        "validation_failed",
        `Upload body exceeds the ${MAX_SNAPSHOT_UPLOAD_BYTES} byte limit`,
        413,
      );
    }

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
    const guard = validateWorkbookUpload({
      name: file.name,
      size: file.size,
      type: file.type,
    });
    if (!guard.ok) {
      return jsonError(guard.code, guard.message, guard.status);
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
    if (members.length > MAX_SNAPSHOT_UPLOAD_ROWS) {
      return jsonError(
        "validation_failed",
        `Workbook exceeds the ${MAX_SNAPSHOT_UPLOAD_ROWS} row limit (${members.length} rows)`,
        422,
      );
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
