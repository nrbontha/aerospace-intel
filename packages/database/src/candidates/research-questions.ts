import { eq, inArray, sql } from "drizzle-orm";

import type { ResearchQuestionCreate } from "@asi/contracts";

import type { Database } from "../client.js";
import { researchQuestions } from "../schema.js";

/**
 * Research question lifecycle CRUD: create → answer/close. Status values
 * are the contract's open/answered/stale; closing (answered/stale) stamps
 * closed_at.
 */

export interface ResearchQuestionDtoShape {
  id: string;
  candidateId: string | null;
  companyId: string | null;
  question: string;
  status: string;
  answer: Record<string, unknown> | null;
  priority: number | null;
  createdAt: string;
  closedAt: string | null;
}

function toQuestionDto(
  row: typeof researchQuestions.$inferSelect,
): ResearchQuestionDtoShape {
  return {
    id: row.id,
    candidateId: row.candidateId,
    companyId: row.companyId,
    question: row.question,
    status: row.status,
    answer: row.answer,
    priority: row.priority === null ? null : Number(row.priority),
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : new Date(row.createdAt).toISOString(),
    closedAt:
      row.closedAt === null
        ? null
        : row.closedAt instanceof Date
          ? row.closedAt.toISOString()
          : new Date(row.closedAt).toISOString(),
  };
}

export interface CreateResearchQuestionInput extends ResearchQuestionCreate {
  actor?: string;
}

export async function createResearchQuestionRecord(
  db: Database,
  input: CreateResearchQuestionInput,
): Promise<ResearchQuestionDtoShape> {
  const rows = await db
    .insert(researchQuestions)
    .values({
      ...(input.candidateId === undefined ? {} : { candidateId: input.candidateId }),
      ...(input.companyId === undefined ? {} : { companyId: input.companyId }),
      question: input.question,
      ...(input.priority === undefined ? {} : { priority: input.priority.toFixed(2) }),
    })
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error("research_questions insert returned no row");
  return toQuestionDto(row);
}

export interface ResearchQuestionListFilters {
  candidateId?: string;
  companyId?: string;
  status?: string;
  page: number;
  pageSize: number;
}

export interface ResearchQuestionListPage {
  records: ResearchQuestionDtoShape[];
  page: number;
  pageSize: number;
  total: number;
}

export async function listResearchQuestionRecords(
  db: Database,
  filters: ResearchQuestionListFilters,
): Promise<ResearchQuestionListPage> {
  const conditions = [];
  if (filters.candidateId !== undefined) {
    conditions.push(sql`rq.candidate_id = ${filters.candidateId}`);
  }
  if (filters.companyId !== undefined) {
    conditions.push(sql`rq.company_id = ${filters.companyId}`);
  }
  if (filters.status !== undefined) {
    conditions.push(sql`rq.status = ${filters.status}`);
  }
  const whereClause =
    conditions.length === 0 ? sql`` : sql` WHERE ${sql.join(conditions, sql` AND `)}`;
  const offset = (filters.page - 1) * filters.pageSize;

  const [ids, totals] = await Promise.all([
    db.execute<{ id: string }>(sql`
      SELECT rq.id FROM research_questions rq${whereClause}
      ORDER BY rq.priority DESC NULLS LAST, rq.created_at DESC
      LIMIT ${filters.pageSize} OFFSET ${offset}
    `),
    db.execute<{ total: string }>(
      sql`SELECT count(*)::text AS total FROM research_questions rq${whereClause}`,
    ),
  ]);
  const rows =
    ids.rows.length === 0
      ? []
      : await db
          .select()
          .from(researchQuestions)
          .where(inArray(researchQuestions.id, ids.rows.map((r) => r.id)));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const records = ids.rows
    .map((r) => byId.get(r.id))
    .filter((row) => row !== undefined)
    .map((row) => toQuestionDto(row));
  return {
    records,
    page: filters.page,
    pageSize: filters.pageSize,
    total: Number(totals.rows[0]?.total ?? "0"),
  };
}

export interface UpdateResearchQuestionInput {
  questionId: string;
  /** Answer payload; required whenever the question is being answered/closed. */
  answer?: Record<string, unknown>;
  status: "answered" | "stale" | "open";
}

/** Answer/close a question. `open` re-opens and clears closure metadata. */
export async function updateResearchQuestionRecord(
  db: Database,
  input: UpdateResearchQuestionInput,
): Promise<ResearchQuestionDtoShape | null> {
  const rows = await db
    .update(researchQuestions)
    .set({
      ...(input.answer === undefined ? {} : { answer: input.answer }),
      status: input.status as never,
      closedAt: input.status === "open" ? null : sql`now()`,
    })
    .where(eq(researchQuestions.id, input.questionId))
    .returning();
  const row = rows[0];
  return row === undefined ? null : toQuestionDto(row);
}
