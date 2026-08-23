import { inArray, sql } from "drizzle-orm";

import type { FeedbackCreate } from "@asi/contracts";

import type { Database } from "../client.js";
import { auditEvents, feedback } from "../schema.js";

/**
 * Feedback journal CRUD. Channel/action validity is enforced by the API
 * contract schema upstream and re-checked by DB CHECK constraints here.
 * Every write lands an audit event.
 */

export interface FeedbackDtoShape {
  id: string;
  channel: string;
  action: string;
  companyId: string | null;
  candidateId: string | null;
  leadId: string | null;
  reason: string | null;
  payload: Record<string, unknown>;
  notes: string | null;
  actor: string;
  createdAt: string;
}

export type CreateFeedbackInput = FeedbackCreate & {
  actor: string;
};

function toFeedbackDto(row: typeof feedback.$inferSelect): FeedbackDtoShape {
  return {
    id: row.id,
    channel: row.channel,
    action: row.action,
    companyId: row.companyId,
    candidateId: row.candidateId,
    leadId: row.leadId,
    reason: row.reason,
    payload: row.payload,
    notes: row.notes,
    actor: row.actor,
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : new Date(row.createdAt).toISOString(),
  };
}

export async function createFeedbackRecord(
  db: Database,
  input: CreateFeedbackInput,
): Promise<FeedbackDtoShape> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(feedback)
      .values({
        channel: input.channel,
        action: input.action,
        ...(input.companyId === undefined ? {} : { companyId: input.companyId }),
        ...(input.candidateId === undefined ? {} : { candidateId: input.candidateId }),
        ...(input.leadId === undefined ? {} : { leadId: input.leadId }),
        reason: input.reason ?? null,
        payload: input.payload ?? {},
        notes: input.notes ?? null,
        actor: input.actor,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error("feedback insert returned no row");

    await tx.insert(auditEvents).values({
      actorUserId: input.actor,
      action: "feedback.create",
      entityType: "feedback",
      entityId: row.id,
      after: {
        channel: row.channel,
        action: row.action,
        companyId: row.companyId,
        candidateId: row.candidateId,
        leadId: row.leadId,
      },
    });
    return toFeedbackDto(row);
  });
}

export interface FeedbackListFilters {
  channel?: string;
  candidateId?: string;
  companyId?: string;
  page: number;
  pageSize: number;
}

export interface FeedbackListPage {
  records: FeedbackDtoShape[];
  page: number;
  pageSize: number;
  total: number;
}

export async function listFeedbackRecords(
  db: Database,
  filters: FeedbackListFilters,
): Promise<FeedbackListPage> {
  const conditions = [];
  // Conditions reference the raw-SQL alias `feedback f` below; drizzle eq() would
  // emit table-qualified columns that do not resolve against the alias.
  if (filters.channel !== undefined) conditions.push(sql`f.channel = ${filters.channel}`);
  if (filters.candidateId !== undefined) {
    conditions.push(sql`f.candidate_id = ${filters.candidateId}`);
  }
  if (filters.companyId !== undefined) conditions.push(sql`f.company_id = ${filters.companyId}`);
  const whereClause =
    conditions.length === 0 ? sql`` : sql` WHERE ${sql.join(conditions, sql` AND `)}`;
  const offset = (filters.page - 1) * filters.pageSize;

  const [ids, totals] = await Promise.all([
    db.execute<{ id: string }>(sql`
      SELECT f.id FROM feedback f${whereClause}
      ORDER BY f.created_at DESC, f.id DESC
      LIMIT ${filters.pageSize} OFFSET ${offset}
    `),
    db.execute<{ total: string }>(
      sql`SELECT count(*)::text AS total FROM feedback f${whereClause}`,
    ),
  ]);
  const rows =
    ids.rows.length === 0
      ? []
      : await db.select().from(feedback).where(inArray(feedback.id, ids.rows.map((r) => r.id)));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const records = ids.rows
    .map((r) => byId.get(r.id))
    .filter((row) => row !== undefined)
    .map((row) => toFeedbackDto(row));
  return {
    records,
    page: filters.page,
    pageSize: filters.pageSize,
    total: Number(totals.rows[0]?.total ?? "0"),
  };
}
