import { and, asc, count, eq, sql } from "drizzle-orm";

import type { Database } from "../client.js";
import { getDatabase } from "../client.js";
import { companies, identityMatchCandidates, leads } from "../schema.js";

/**
 * Read models for the lead pipeline: analyst lead list (with per-lead match
 * summary) and the pending identity-match review queue.
 */

export interface LeadListQuery {
  campaignId?: string;
  status?: string;
  /** Server-side text search across lead name, possible domain and resolved company display name. */
  query?: string;
  page: number;
  pageSize: number;
}

export interface LeadListRow {
  id: string;
  campaignId: string | null;
  rawName: string;
  status: string;
  possibleDomain: string | null;
  possibleLocation: string | null;
  possibleIdentifiers: unknown[];
  context: Record<string, unknown>;
  resolvedCompanyId: string | null;
  createdAt: Date;
  matchSummary: {
    pending: number;
    merged: number;
    rejected: number;
  };
}

/** Paginated lead list ordered newest-first, with identity-match tallies. */
export async function listLeads(
  query: LeadListQuery,
  options: { db?: Database } = {},
): Promise<{ records: LeadListRow[]; total: number }> {
  const db = options.db ?? getDatabase();
  const filters = [
    ...(query.campaignId === undefined
      ? []
      : [eq(leads.campaignId, query.campaignId)]),
    ...(query.status === undefined ? [] : [sql`${leads.status} = ${query.status}`]),
    ...(query.query === undefined || query.query.length === 0
      ? []
      : [
          sql`(${leads.rawName} ilike ${`%${query.query}%`}
            or ${leads.possibleDomain} ilike ${`%${query.query}%`}
            or ${companies.displayName} ilike ${`%${query.query}%`})`,
        ]),
  ];
  const where = filters.length === 0 ? undefined : and(...filters);

  const rows = await db
    .select({
      id: leads.id,
      campaignId: leads.campaignId,
      rawName: leads.rawName,
      status: leads.status,
      possibleDomain: leads.possibleDomain,
      possibleLocation: leads.possibleLocation,
      possibleIdentifiers: leads.possibleIdentifiers,
      context: leads.context,
      resolvedCompanyId: leads.resolvedCompanyId,
      createdAt: leads.createdAt,
      pending: sql<number>`count(${identityMatchCandidates.id}) filter (where ${identityMatchCandidates.decision} = 'pending')`,
      merged: sql<number>`count(${identityMatchCandidates.id}) filter (where ${identityMatchCandidates.decision} = 'merged')`,
      rejected: sql<number>`count(${identityMatchCandidates.id}) filter (where ${identityMatchCandidates.decision} in ('rejected_merge','alias','parent_subsidiary','acquired_into'))`,
    })
    .from(leads)
    .leftJoin(
      identityMatchCandidates,
      eq(identityMatchCandidates.leadId, leads.id),
    )
    // Search may match the resolved company's display name.
    .leftJoin(companies, eq(companies.id, leads.resolvedCompanyId))
    .where(where)
    .groupBy(leads.id)
    .orderBy(sql`${leads.createdAt} desc`)
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  const [totalRow] = await db
    .select({ total: count() })
    .from(leads)
    .leftJoin(companies, eq(companies.id, leads.resolvedCompanyId))
    .where(where);

  return {
    records: rows.map((row) => ({
      ...row,
      matchSummary: {
        pending: Number(row.pending),
        merged: Number(row.merged),
        rejected: Number(row.rejected),
      },
    })),
    total: totalRow?.total ?? 0,
  };
}

export interface IdentityMatchQueueRow {
  id: string;
  leadId: string;
  companyId: string;
  leadRawName: string;
  leadStatus: string;
  companyDisplayName: string;
  signalType: string;
  features: Record<string, unknown>;
  confidence: string;
  explanation: string | null;
  decision: string;
  createdAt: Date;
}

/**
 * Review queue: identity-match candidates in the given decision state
 * (default `pending`) with lead + company display context.
 */
export async function listIdentityMatches(
  query: { status?: string; page: number; pageSize: number },
  options: { db?: Database } = {},
): Promise<{ records: IdentityMatchQueueRow[]; total: number }> {
  const db = options.db ?? getDatabase();
  const decision = query.status ?? "pending";
  const where = sql`${identityMatchCandidates.decision} = ${decision}`;

  const rows = await db
    .select({
      id: identityMatchCandidates.id,
      leadId: identityMatchCandidates.leadId,
      companyId: identityMatchCandidates.companyId,
      leadRawName: leads.rawName,
      leadStatus: leads.status,
      companyDisplayName: companies.displayName,
      signalType: identityMatchCandidates.signalType,
      features: identityMatchCandidates.features,
      confidence: identityMatchCandidates.confidence,
      explanation: identityMatchCandidates.explanation,
      decision: identityMatchCandidates.decision,
      createdAt: identityMatchCandidates.createdAt,
    })
    .from(identityMatchCandidates)
    .innerJoin(leads, eq(leads.id, identityMatchCandidates.leadId))
    .innerJoin(companies, eq(companies.id, identityMatchCandidates.companyId))
    .where(where)
    .orderBy(asc(identityMatchCandidates.createdAt))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  const [totalRow] = await db
    .select({ total: count() })
    .from(identityMatchCandidates)
    .where(where);

  return { records: rows, total: totalRow?.total ?? 0 };
}
