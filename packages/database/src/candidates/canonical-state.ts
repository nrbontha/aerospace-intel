import { sql } from "drizzle-orm";

import type { Database } from "../client.js";

/**
 * Read-model loaders that assemble everything promotion needs from the
 * canonical catalog. Pure data in / data out — no scoring-engine imports;
 * the engine mapping happens in apps/web/src/lib/candidate-scoring.ts.
 */

import { PROBABLE_BASE_THRESHOLD, SAME_STATE_BONUS } from "../snapshots/matching.js";
import type { CanonicalCompanyState } from "./mapping.js";

/** Per-active-snapshot known-universe match verdict for one company. */
export interface SnapshotMatchVerdict {
  snapshotId: string;
  /** exact | probable | possible | none — mirrors the engine's MemberMatchStatus. */
  status: "exact" | "probable" | "possible" | "none";
}

export interface EvidenceSummary {
  sourceCount: number;
  primarySourceCount: number;
  conflictCount: number;
  freshestObservationDaysOld: number | null;
}

type MatchRow = {
  snapshot_id: string;
  resolved: boolean;
  domain_hit: boolean;
  best_name_sim: string | null;
};

type CountRow = { n: string };

/**
 * Match a company against every ACTIVE known-universe snapshot, mirroring
 * the import-time matching semantics (domain join beats trigram name
 * similarity; the widened window below PROBABLE_BASE_THRESHOLD − bonus
 * still counts as merely "possible").
 */
export async function activeSnapshotMatchVerdicts(
  db: Database,
  input: { companyId: string; domain: string | null; displayName: string },
): Promise<SnapshotMatchVerdict[]> {
  const result = await db.execute<MatchRow>(sql`
    SELECT s.id AS snapshot_id,
           bool_or(m.company_id = ${input.companyId}
                OR m.matched_company_id = ${input.companyId}) AS resolved,
           bool_or(m.normalized_domain IS NOT NULL
               AND ${input.domain}::text IS NOT NULL
               AND lower(m.normalized_domain) = lower(${input.domain}::text)) AS domain_hit,
           max(similarity(${input.displayName}, m.normalized_name)) AS best_name_sim
    FROM known_universe_snapshots s
    JOIN known_universe_members m ON m.snapshot_id = s.id
    WHERE s.active
    GROUP BY s.id
  `);
  const widenedThreshold = PROBABLE_BASE_THRESHOLD - SAME_STATE_BONUS;
  return result.rows.map((row) => {
    const sim = row.best_name_sim === null ? 0 : Number(row.best_name_sim);
    if (row.resolved) return { snapshotId: row.snapshot_id, status: "exact" };
    if (row.domain_hit || sim >= PROBABLE_BASE_THRESHOLD) {
      return { snapshotId: row.snapshot_id, status: "probable" };
    }
    if (sim >= widenedThreshold) {
      return { snapshotId: row.snapshot_id, status: "possible" };
    }
    return { snapshotId: row.snapshot_id, status: "none" };
  });
}

/**
 * Evidence-quality inputs for computeConfidence. Primary sources are a
 * documented heuristic until a first-class flag exists: authorized-access
 * feeds or sources scored reliability ≥ 80.
 */
export async function companyEvidenceSummary(
  db: Database,
  companyId: string,
): Promise<EvidenceSummary> {
  const sourceResult = await db.execute<{ total: string; primary: string }>(sql`
    SELECT count(DISTINCT t.source_id)::text AS total,
           count(DISTINCT t.source_id) FILTER (WHERE ds.access = 'authorized'
                                                OR ds.reliability_score >= 80)::text AS primary
    FROM (
      SELECT csl.data_source_id AS source_id
      FROM company_source_links csl WHERE csl.company_id = ${companyId}
      UNION
      SELECT sd.data_source_id AS source_id
      FROM source_document_links sdl
      JOIN source_documents sd ON sd.id = sdl.source_document_id
      WHERE sdl.company_id = ${companyId}
    ) t
    JOIN data_sources ds ON ds.id = t.source_id
  `);
  const conflictRows = await db.execute<CountRow>(sql`
    SELECT count(*)::text AS n FROM observations
    WHERE subject_type = 'company' AND subject_id = ${companyId}
      AND conflict_status <> 'none'
  `);
  const freshness = await db.execute<{ days_old: string | null }>(sql`
    SELECT min(days_old)::text AS days_old FROM (
      SELECT extract(epoch FROM (now() - observed_at)) / 86400 AS days_old
      FROM ownership_observations WHERE company_id = ${companyId}
      UNION ALL
      SELECT extract(epoch FROM (now() - observed_at)) / 86400
      FROM financial_observations WHERE company_id = ${companyId}
      UNION ALL
      SELECT extract(epoch FROM (now() - observed_at)) / 86400
      FROM employee_observations WHERE company_id = ${companyId}
      UNION ALL
      SELECT extract(epoch FROM (now() - o.observed_at)) / 86400
      FROM observations o
      WHERE o.subject_type = 'company' AND o.subject_id = ${companyId}
    ) ages
  `);
  const rawDaysOld = freshness.rows[0]?.days_old ?? null;
  return {
    sourceCount: Number(sourceResult.rows[0]?.total ?? "0"),
    primarySourceCount: Number(sourceResult.rows[0]?.primary ?? "0"),
    conflictCount: Number(conflictRows.rows[0]?.n ?? "0"),
    freshestObservationDaysOld:
      rawDaysOld === null ? null : Math.max(0, Math.round(Number(rawDaysOld))),
  };
}

type RevenueRow = {
  amount_lower: string | null;
  amount_upper: string | null;
};

type EmployeeRow = {
  employee_count_lower: number | null;
  employee_count_upper: number | null;
};

type OwnershipRow = { type: string };

type CompanyRow = {
  id: string;
  display_name: string;
  legal_name: string;
  website_url: string | null;
  description: string | null;
};

type CapabilitySignalRow = { text: string };

/**
 * Assemble the canonical company state consumed by buildFeatureRecordInput.
 * Latest-wins per observation family (revenue, employees, ownership),
 * ordered by period end / validity window / observation recency.
 */
export async function loadCanonicalCompanyState(
  db: Database,
  companyId: string,
): Promise<CanonicalCompanyState> {
  const companyRows = await db.execute<CompanyRow>(sql`
    SELECT id, display_name, legal_name, website_url, description
    FROM companies WHERE id = ${companyId}
  `);
  const company = companyRows.rows[0];
  if (company === undefined) {
    throw new Error(`Company ${companyId} not found`);
  }

  const [
    domains,
    identifiers,
    revenue,
    employees,
    ownership,
    certs,
    platforms,
    golden,
    observationSignals,
    companyCapabilityNames,
  ] =
    await Promise.all([
      db.execute<{ domain: string; is_primary: boolean; verified_at: Date | null }>(sql`
        SELECT domain, is_primary, verified_at FROM company_domains
        WHERE company_id = ${companyId}
        ORDER BY is_primary DESC, created_at ASC
      `),
      db.execute<{ type: string; value: string }>(sql`
        SELECT type::text AS type, value FROM company_identifiers
        WHERE company_id = ${companyId} AND type IN ('cage', 'uei')
        ORDER BY created_at ASC
      `),
      db.execute<RevenueRow>(sql`
        SELECT amount_lower, amount_upper FROM financial_observations
        WHERE company_id = ${companyId} AND metric = 'revenue'
        ORDER BY period_end DESC NULLS LAST, observed_at DESC LIMIT 1
      `),
      db.execute<EmployeeRow>(sql`
        SELECT employee_count_lower, employee_count_upper FROM employee_observations
        WHERE company_id = ${companyId}
        ORDER BY as_of_date DESC NULLS LAST, observed_at DESC LIMIT 1
      `),
      db.execute<OwnershipRow>(sql`
        SELECT type::text AS type FROM ownership_observations
        WHERE company_id = ${companyId}
          AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)
        ORDER BY observed_at DESC LIMIT 1
      `),
      db.execute<{ standard: string }>(sql`
        SELECT DISTINCT c.standard FROM certifications c
        LEFT JOIN facilities f ON f.id = c.facility_id
        WHERE c.status = 'active'
          AND (c.company_id = ${companyId} OR f.company_id = ${companyId})
      `),
      db.execute<{ name: string }>(sql`
        SELECT DISTINCT p.name FROM facility_qualifications fq
        JOIN facilities f ON f.id = fq.facility_id
        JOIN platforms p ON p.id = fq.platform_id
        WHERE f.company_id = ${companyId}
        LIMIT 20
      `),
      db.execute<{ build_to_print_risk: string | null }>(sql`
        SELECT build_to_print_risk::text AS build_to_print_risk FROM golden_examples
        WHERE company_id = ${companyId}
        ORDER BY created_at DESC LIMIT 1
      `),
      db.execute<CapabilitySignalRow>(sql`
        SELECT value::text AS text FROM observations
        WHERE subject_type = 'company' AND subject_id = ${companyId}
          AND field_key IN ('capability', 'description')
          AND review_status <> 'rejected'
        ORDER BY created_at DESC LIMIT 50
      `),
      db.execute<CapabilitySignalRow>(sql`
        SELECT DISTINCT c.name AS text
        FROM company_capabilities cc
        JOIN capabilities c ON c.id = cc.capability_id
        WHERE cc.company_id = ${companyId} AND cc.status = 'active'
        LIMIT 20
      `),
    ]);

  const revenueRow = revenue.rows[0];
  const employeeRow = employees.rows[0];
  const ownershipRow = ownership.rows[0];

  return {
    company: {
      id: company.id,
      displayName: company.display_name,
      legalName: company.legal_name,
      websiteUrl: company.website_url,
      description: company.description,
    },
    domains: domains.rows.map((d) => ({
      domain: d.domain,
      isPrimary: d.is_primary,
      verifiedAt: d.verified_at === null ? null : new Date(d.verified_at),
    })),
    identifiers: identifiers.rows.map((i) => ({ type: i.type, value: i.value })),
    latestRevenue:
      revenueRow === undefined
        ? null
        : {
            amountLower:
              revenueRow.amount_lower === null ? null : Number(revenueRow.amount_lower),
            amountUpper:
              revenueRow.amount_upper === null ? null : Number(revenueRow.amount_upper),
          },
    latestEmployees:
      employeeRow === undefined
        ? null
        : {
            countLower: employeeRow.employee_count_lower,
            countUpper: employeeRow.employee_count_upper,
          },
    ownership: ownershipRow ?? null,
    platformNames: platforms.rows.map((p) => p.name),
    certificationStandards: certs.rows.map((c) => c.standard),
    capabilitySignals: [
      ...observationSignals.rows.map((row) => row.text),
      ...companyCapabilityNames.rows.map((row) => row.text),
    ],
    goldenBuildToPrintRisk: golden.rows[0]?.build_to_print_risk ?? null,
    evidenceCounts: await companyEvidenceSummary(db, companyId),
  };
}
