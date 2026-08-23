import { getDatabase } from "@asi/database";
import { sql } from "drizzle-orm";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { jsonError, jsonSuccess, jsonValue } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { handleCatalogRouteError } from "@/lib/catalog-api";

export const dynamic = "force-dynamic";

/**
 * Novelty search across ACTIVE known-universe snapshots and the canonical
 * companies catalog. Query contract is defined locally — no matching shape
 * exists in packages/contracts yet (reported gap).
 */
const searchQuerySchema = z
  .object({
    q: z.string().trim().min(2).max(200).optional(),
    domain: z.string().trim().min(3).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(25),
  })
  .refine(
    (value) => value.q !== undefined || value.domain !== undefined,
    "Provide ?q= or ?domain=",
  );

type MemberHitRow = {
  member_id: string;
  snapshot_id: string;
  snapshot_key: string;
  raw_name: string;
  normalized_domain: string | null;
  match_status: string;
}

type CompanyHitRow = {
  company_id: string;
  display_name: string;
  legal_name: string;
  domain: string | null;
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireUser();
    const query = searchQuerySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    if (!query.success) {
      return jsonError(
        "validation_failed",
        "Invalid known-universe search query",
        400,
        query.error.flatten(),
      );
    }
    const { q, domain, limit } = query.data;
    const namePattern = q === undefined ? null : `%${q.toLowerCase()}%`;
    // A bare domain query also matches when passed via ?domain=.
    const bareDomain =
      (domain ?? (q !== undefined && q.includes(".") && !q.includes(" ") ? q : undefined))?.toLowerCase() ??
      null;

    const db = getDatabase();
    const memberHits = await db.execute<MemberHitRow>(sqlMembers({
      namePattern,
      bareDomain,
      limit,
    }));
    const companyHits = await db.execute<CompanyHitRow>(sqlCompanies({
      namePattern,
      bareDomain,
      limit,
    }));

    const members = memberHits.rows.map((row) => ({
      kind: "known_universe_member" as const,
      memberId: row.member_id,
      snapshotId: row.snapshot_id,
      snapshotKey: row.snapshot_key,
      rawName: row.raw_name,
      normalizedDomain: row.normalized_domain,
      matchStatus: row.match_status,
    }));
    const companies = companyHits.rows.map((row) => ({
      kind: "company" as const,
      companyId: row.company_id,
      displayName: row.display_name,
      legalName: row.legal_name,
      domain: row.domain,
    }));

    return jsonSuccess(
      jsonValue({
        query: { ...(q === undefined ? {} : { q }), ...(domain === undefined ? {} : { domain }) },
        summary: {
          knownUniverseMemberHits: members.length,
          companyHits: companies.length,
          novel: members.length === 0 && companies.length === 0,
        },
        results: [...companies, ...members],
      }),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return handleCatalogRouteError(error);
  }
}

function sqlMembers(input: {
  namePattern: string | null;
  bareDomain: string | null;
  limit: number;
}) {
  return sql`
    SELECT m.id AS member_id, s.id AS snapshot_id, s.key AS snapshot_key,
           m.raw_name, m.normalized_domain, m.match_status::text AS match_status
    FROM known_universe_members m
    JOIN known_universe_snapshots s ON s.id = m.snapshot_id
    WHERE s.active
      AND (
        (${input.namePattern}::text IS NOT NULL AND
         (lower(m.raw_name) LIKE ${input.namePattern}
          OR lower(coalesce(m.normalized_name, '')) LIKE ${input.namePattern}))
        OR (${input.bareDomain}::text IS NOT NULL AND
         lower(coalesce(m.normalized_domain, '')) LIKE ${"%" + (input.bareDomain ?? "") + "%"})
      )
    ORDER BY s.created_at DESC, m.raw_name
    LIMIT ${input.limit}
  `;
}

function sqlCompanies(input: {
  namePattern: string | null;
  bareDomain: string | null;
  limit: number;
}) {
  return sql`
    SELECT DISTINCT c.id AS company_id, c.display_name, c.legal_name,
           (SELECT lower(d.domain) FROM company_domains d
            WHERE d.company_id = c.id ORDER BY d.is_primary DESC LIMIT 1) AS domain
    FROM companies c
    WHERE (
      (${input.namePattern}::text IS NOT NULL AND
       (lower(c.display_name) LIKE ${input.namePattern}
        OR lower(c.legal_name) LIKE ${input.namePattern}))
      OR (${input.bareDomain}::text IS NOT NULL AND
       EXISTS (SELECT 1 FROM company_domains d2
               WHERE d2.company_id = c.id AND lower(d2.domain) LIKE ${"%" + (input.bareDomain ?? "") + "%"}))
    )
    ORDER BY c.display_name
    LIMIT ${input.limit}
  `;
}
