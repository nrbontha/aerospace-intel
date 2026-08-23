/**
 * Ground-truth loader for the entity-resolution benchmark.
 *
 * Reads the live database (catalog companies + domains + aliases + facility
 * states, known-universe snapshot members, campaign leads) so the benchmark
 * always measures against current DB reality instead of a stale in-code copy.
 */
import { sql } from "drizzle-orm";

import type { Database } from "@asi/database/client";

import type {
  GroundTruth,
  KnownCompany,
  LeadRecord,
  MemberRecord,
} from "./types.js";

interface CompanyRow {
  [column: string]: unknown;
  id: string;
  legal_name: string;
  display_name: string;
  domains: string[] | null;
  aliases: string[] | null;
  us_state: string | null;
}

interface MemberRow {
  [column: string]: unknown;
  snapshot_id: string;
  snapshot_name: string;
  raw_name: string;
  normalized_domain: string | null;
}

interface LeadRow {
  [column: string]: unknown;
  id: string;
  raw_name: string;
  possible_domain: string | null;
  resolved_company_id: string | null;
  status: string;
}

export const GOLDEN_SNAPSHOT_NAME = "Golden Set v01";
export const GRATA_SNAPSHOT_NAME = "Grata Enrichment v01";
export const PIPELINE_SNAPSHOT_NAME = "Preliminary Pipeline v01";

/** Load the full ground truth from the database. */
export async function loadGroundTruth(db: Database): Promise<GroundTruth> {
  const companyResult = await db.execute<CompanyRow>(sql`
    SELECT c.id,
           c.legal_name,
           c.display_name,
           (SELECT array_agg(d.domain ORDER BY d.is_primary DESC, d.domain)
              FROM company_domains d WHERE d.company_id = c.id) AS domains,
           (SELECT array_agg(a.alias ORDER BY a.alias)
              FROM company_aliases a WHERE a.company_id = c.id) AS aliases,
           (SELECT min(upper(f.region)) FROM facilities f
             WHERE f.company_id = c.id
               AND f.country_code IS NOT NULL AND upper(f.country_code) = 'US'
               AND f.region IS NOT NULL) AS us_state
    FROM companies c
    ORDER BY c.legal_name
  `);

  const memberResult = await db.execute<MemberRow>(sql`
    SELECT s.id AS snapshot_id,
           s.name AS snapshot_name,
           m.raw_name,
           m.normalized_domain
    FROM known_universe_members m
    JOIN known_universe_snapshots s ON s.id = m.snapshot_id
    ORDER BY s.name, m.raw_name
  `);

  const leadResult = await db.execute<LeadRow>(sql`
    SELECT l.id, l.raw_name, l.possible_domain,
           l.resolved_company_id::text AS resolved_company_id,
           l.status
    FROM leads l
    ORDER BY l.raw_name
  `);

  const companies: KnownCompany[] = companyResult.rows.map((row) => ({
    companyId: row.id,
    legalName: row.legal_name,
    displayName: row.display_name,
    domains: row.domains ?? [],
    aliases: row.aliases ?? [],
    usState: row.us_state,
  }));

  const toMember = (row: MemberRow): MemberRecord => ({
    snapshotId: row.snapshot_id,
    snapshotName: row.snapshot_name,
    rawName: row.raw_name,
    normalizedDomain: row.normalized_domain,
  });

  const goldenMembers = memberResult.rows
    .filter(
      (row) =>
        row.snapshot_name.startsWith(GOLDEN_SNAPSHOT_NAME) ||
        row.snapshot_name.startsWith(GRATA_SNAPSHOT_NAME),
    )
    .map(toMember);
  const pipelineMembers = memberResult.rows
    .filter((row) => row.snapshot_name.startsWith(PIPELINE_SNAPSHOT_NAME))
    .map(toMember);

  const goldenDomains = new Set(
    goldenMembers
      .map((m) => m.normalizedDomain)
      .filter((d): d is string => d !== null),
  );
  let overlap = 0;
  for (const member of pipelineMembers) {
    if (
      member.normalizedDomain !== null &&
      goldenDomains.has(member.normalizedDomain)
    ) {
      overlap += 1;
    }
  }

  const leads: LeadRecord[] = leadResult.rows.map((row) => ({
    leadId: row.id,
    rawName: row.raw_name,
    domain: row.possible_domain,
    resolvedCompanyId: row.resolved_company_id,
    status: row.status,
  }));

  return {
    companies,
    goldenMembers,
    pipelineMembers,
    leads,
    goldenPipelineDomainOverlap: overlap,
  };
}
