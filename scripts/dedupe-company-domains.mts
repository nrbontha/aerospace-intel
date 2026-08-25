import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  closeDatabase,
  getDatabase,
  normalizeDomain,
  type Database,
  withVerifiedDomainLock,
} from "@asi/database";
import { sql } from "drizzle-orm";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type DbLike = Database | Tx;

export interface CompanyDomainDedupeCompany {
  readonly id: string;
  readonly legalName: string;
  readonly createdAt: Date;
  readonly resolvedLeadCount: number;
  readonly evidenceCount: number;
}

export interface CompanyDomainDedupePlan {
  readonly domain: string;
  readonly survivor: CompanyDomainDedupeCompany;
  readonly duplicates: readonly CompanyDomainDedupeCompany[];
}

export interface CompanyDomainDedupeReport {
  readonly mode: "dry-run" | "apply";
  readonly plans: readonly CompanyDomainDedupePlan[];
  readonly mergedCompanyCount: number;
}

const normalizedSql = (column: ReturnType<typeof sql.raw>) =>
  sql`lower(regexp_replace(rtrim(split_part(regexp_replace(btrim(${column}), '^[a-z][a-z0-9+.-]*://', '', 'i'), '/', 1), '.'), '^www\\.', '', 'i'))`;

async function duplicateDomains(db: DbLike, requestedDomain: string | null): Promise<string[]> {
  const domainExpression = normalizedSql(sql.raw("d.domain"));
  const leadExpression = normalizedSql(sql.raw("l.possible_domain"));
  const leadUrlExpression = normalizedSql(sql.raw("l.url"));
  const websiteExpression = normalizedSql(sql.raw("c.website_url"));
  const result = await db.execute<{ domain: string }>(sql`
    WITH domain_companies AS (
      SELECT ${domainExpression} AS domain, d.company_id
      FROM company_domains d
      UNION
      SELECT ${leadExpression} AS domain, l.resolved_company_id AS company_id
      FROM leads l
      WHERE l.status = 'resolved'
        AND l.resolved_company_id IS NOT NULL
        AND l.possible_domain IS NOT NULL
      UNION
      SELECT ${leadUrlExpression} AS domain, l.resolved_company_id AS company_id
      FROM leads l
      WHERE l.status = 'resolved'
        AND l.resolved_company_id IS NOT NULL
        AND l.url IS NOT NULL
      UNION
      SELECT ${websiteExpression} AS domain, c.id AS company_id
      FROM companies c
      WHERE c.status <> 'inactive' AND c.website_url IS NOT NULL
    )
    SELECT domain
    FROM domain_companies
    WHERE domain IS NOT NULL
      ${requestedDomain === null ? sql`` : sql`AND domain = ${requestedDomain}`}
    GROUP BY domain
    HAVING count(DISTINCT company_id) > 1
    ORDER BY domain
  `);
  return result.rows.map((row) => row.domain);
}

async function planForDomain(
  db: DbLike,
  domain: string,
): Promise<CompanyDomainDedupePlan | null> {
  const domainExpression = normalizedSql(sql.raw("d.domain"));
  const leadExpression = normalizedSql(sql.raw("l.possible_domain"));
  const leadUrlExpression = normalizedSql(sql.raw("l.url"));
  const websiteExpression = normalizedSql(sql.raw("c.website_url"));
  const result = await db.execute<{
    id: string;
    legal_name: string;
    created_at: Date;
    resolved_lead_count: number;
    evidence_count: number;
  }>(sql`
    WITH attached AS (
      SELECT d.company_id
      FROM company_domains d
      WHERE ${domainExpression} = ${domain}
      UNION
      SELECT l.resolved_company_id AS company_id
      FROM leads l
      WHERE l.status = 'resolved'
        AND l.resolved_company_id IS NOT NULL
        AND ${leadExpression} = ${domain}
      UNION
      SELECT l.resolved_company_id AS company_id
      FROM leads l
      WHERE l.status = 'resolved'
        AND l.resolved_company_id IS NOT NULL
        AND ${leadUrlExpression} = ${domain}
      UNION
      SELECT c.id AS company_id
      FROM companies c
      WHERE c.status <> 'inactive' AND ${websiteExpression} = ${domain}
    )
    SELECT c.id, c.legal_name, c.created_at,
      (SELECT count(*)::int FROM leads l WHERE l.status = 'resolved' AND l.resolved_company_id = c.id)
        AS resolved_lead_count,
      (
        (SELECT count(*) FROM observations o WHERE o.subject_type = 'company' AND o.subject_id = c.id) +
        (SELECT count(*) FROM ownership_observations o WHERE o.company_id = c.id) +
        (SELECT count(*) FROM financial_observations o WHERE o.company_id = c.id) +
        (SELECT count(*) FROM employee_observations o WHERE o.company_id = c.id) +
        (SELECT count(*) FROM source_document_links l WHERE l.company_id = c.id) +
        (SELECT count(*) FROM company_source_links l WHERE l.company_id = c.id)
      )::int AS evidence_count
    FROM companies c
    JOIN attached a ON a.company_id = c.id
    ORDER BY resolved_lead_count DESC, evidence_count DESC, c.created_at ASC, c.id ASC
  `);
  const companies = result.rows.map((row) => ({
    id: row.id,
    legalName: row.legal_name,
    createdAt: row.created_at,
    resolvedLeadCount: row.resolved_lead_count,
    evidenceCount: row.evidence_count,
  }));
  const survivor = companies[0];
  if (survivor === undefined || companies.length < 2) return null;
  return { domain, survivor, duplicates: companies.slice(1) };
}

export async function selectCompanyDomainDedupePlans(
  db: DbLike,
  options: { readonly domain?: string; readonly all?: boolean } = {},
): Promise<CompanyDomainDedupePlan[]> {
  if (options.all === true && options.domain !== undefined) {
    throw new Error("use either --domain or --all, not both");
  }
  const requestedDomain =
    options.domain === undefined ? null : normalizeDomain(options.domain);
  if (options.domain !== undefined && requestedDomain === null) {
    throw new Error(`invalid domain: ${options.domain}`);
  }
  if (requestedDomain === null && options.all !== true) {
    throw new Error("a domain scope is required (use --domain <domain>; --all is explicit)");
  }
  const domains = await duplicateDomains(db, requestedDomain);
  const plans: CompanyDomainDedupePlan[] = [];
  for (const domain of domains) {
    const plan = await planForDomain(db, domain);
    if (plan !== null) plans.push(plan);
  }
  return plans;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

async function mergeCandidates(tx: Tx, sourceCompanyId: string, targetCompanyId: string): Promise<void> {
  const result = await tx.execute<{
    id: string;
    company_id: string;
    rationale: unknown;
    novelty_snapshot_ids: string[];
    current_scores: Record<string, number | null>;
    research_priority: string | null;
    partner_review_priority: string | null;
  }>(sql`
    SELECT id, company_id, rationale, novelty_snapshot_ids, current_scores,
      research_priority, partner_review_priority
    FROM candidates
    WHERE company_id IN (${sourceCompanyId}, ${targetCompanyId})
    ORDER BY created_at, id
    FOR UPDATE
  `);
  const source = result.rows.find((row) => row.company_id === sourceCompanyId);
  if (source === undefined) return;
  const target = result.rows.find((row) => row.company_id === targetCompanyId);
  if (target === undefined) {
    await tx.execute(sql`UPDATE candidates SET company_id = ${targetCompanyId}, updated_at = now() WHERE id = ${source.id}`);
    return;
  }

  const scoreCounts = await tx.execute<{ candidate_id: string; count: number }>(sql`
    SELECT candidate_id, count(*)::int AS count
    FROM candidate_scores
    WHERE candidate_id IN (${source.id}, ${target.id})
    GROUP BY candidate_id
  `);
  const sourceScoreCount =
    scoreCounts.rows.find((row) => row.candidate_id === source.id)?.count ?? 0;
  const targetScoreCount =
    scoreCounts.rows.find((row) => row.candidate_id === target.id)?.count ?? 0;
  if (sourceScoreCount > 0 && targetScoreCount > 0) {
    throw new Error(
      `cannot safely consolidate candidates ${source.id} and ${target.id}: both have append-only candidate_scores`,
    );
  }
  const kept = sourceScoreCount > 0 ? source : target;
  const removed = kept.id === source.id ? target : source;
  const sourceRationale = (source.rationale ?? {}) as Record<string, unknown>;
  const targetRationale = (target.rationale ?? {}) as Record<string, unknown>;
  const rationale = {
    whyInteresting: [...new Set([...strings(targetRationale["whyInteresting"]), ...strings(sourceRationale["whyInteresting"])])],
    risks: [...new Set([...strings(targetRationale["risks"]), ...strings(sourceRationale["risks"])])],
    unknowns: [...new Set([...strings(targetRationale["unknowns"]), ...strings(sourceRationale["unknowns"])])],
  };
  const noveltySnapshotIds =
    `{${[...new Set([...target.novelty_snapshot_ids, ...source.novelty_snapshot_ids])].join(",")}}`;
  await tx.execute(sql`
    UPDATE candidates
    SET rationale = ${JSON.stringify(rationale)}::jsonb,
        novelty_snapshot_ids = ${noveltySnapshotIds}::uuid[],
        current_scores = ${JSON.stringify({ ...source.current_scores, ...target.current_scores })}::jsonb,
        research_priority = coalesce(research_priority, ${removed.research_priority}::numeric),
        partner_review_priority = coalesce(partner_review_priority, ${removed.partner_review_priority}::numeric),
        updated_at = now()
    WHERE id = ${kept.id}
  `);
  await tx.execute(sql`UPDATE feedback SET candidate_id = ${kept.id} WHERE candidate_id = ${removed.id}`);
  await tx.execute(sql`UPDATE research_questions SET candidate_id = ${kept.id} WHERE candidate_id = ${removed.id}`);
  await tx.execute(sql`DELETE FROM candidates WHERE id = ${removed.id}`);
  if (kept.company_id === sourceCompanyId) {
    await tx.execute(sql`UPDATE candidates SET company_id = ${targetCompanyId}, updated_at = now() WHERE id = ${kept.id}`);
  }
}

async function transferCompanyReferences(
  tx: Tx,
  sourceCompanyId: string,
  targetCompanyId: string,
): Promise<void> {
  await mergeCandidates(tx, sourceCompanyId, targetCompanyId);

  await tx.execute(sql`UPDATE leads SET resolved_company_id = ${targetCompanyId}, updated_at = now() WHERE resolved_company_id = ${sourceCompanyId}`);
  await tx.execute(sql`
    DELETE FROM identity_match_candidates s
    WHERE s.company_id = ${sourceCompanyId}
      AND EXISTS (
        SELECT 1 FROM identity_match_candidates t
        WHERE t.lead_id = s.lead_id AND t.company_id = ${targetCompanyId}
      )
  `);
  await tx.execute(sql`UPDATE identity_match_candidates SET company_id = ${targetCompanyId} WHERE company_id = ${sourceCompanyId}`);
  await tx.execute(sql`UPDATE source_signals SET company_id = ${targetCompanyId}, updated_at = now() WHERE company_id = ${sourceCompanyId}`);

  await tx.execute(sql`
    INSERT INTO company_aliases (company_id, alias, alias_type, is_primary, created_at)
    SELECT ${targetCompanyId}, alias, alias_type, false, created_at
    FROM company_aliases WHERE company_id = ${sourceCompanyId}
    ON CONFLICT DO NOTHING
  `);
  await tx.execute(sql`
    INSERT INTO company_aliases (company_id, alias, alias_type, is_primary)
    SELECT ${targetCompanyId}, name, 'merged_name', false
    FROM (
      SELECT legal_name AS name FROM companies WHERE id = ${sourceCompanyId}
      UNION SELECT display_name AS name FROM companies WHERE id = ${sourceCompanyId}
    ) names
    WHERE name IS NOT NULL
    ON CONFLICT DO NOTHING
  `);
  await tx.execute(sql`DELETE FROM company_aliases WHERE company_id = ${sourceCompanyId}`);
  await tx.execute(sql`UPDATE company_identifiers SET company_id = ${targetCompanyId}, updated_at = now() WHERE company_id = ${sourceCompanyId}`);

  await tx.execute(sql`
    INSERT INTO company_capabilities (company_id, capability_id, status, confidence, valid_from, valid_to, created_at, updated_at)
    SELECT ${targetCompanyId}, capability_id, status, confidence, valid_from, valid_to, created_at, updated_at
    FROM company_capabilities WHERE company_id = ${sourceCompanyId}
    ON CONFLICT DO NOTHING
  `);
  await tx.execute(sql`DELETE FROM company_capabilities WHERE company_id = ${sourceCompanyId}`);
  await tx.execute(sql`
    INSERT INTO company_source_links (data_source_id, company_id, relationship, external_key, created_at)
    SELECT data_source_id, ${targetCompanyId}, relationship, external_key, created_at
    FROM company_source_links WHERE company_id = ${sourceCompanyId}
    ON CONFLICT DO NOTHING
  `);
  await tx.execute(sql`DELETE FROM company_source_links WHERE company_id = ${sourceCompanyId}`);
  await tx.execute(sql`UPDATE source_document_links SET company_id = ${targetCompanyId} WHERE company_id = ${sourceCompanyId}`);

  await tx.execute(sql`UPDATE observations SET subject_id = ${targetCompanyId} WHERE subject_type = 'company' AND subject_id = ${sourceCompanyId}`);
  await tx.execute(sql`UPDATE ownership_observations SET company_id = ${targetCompanyId} WHERE company_id = ${sourceCompanyId}`);
  await tx.execute(sql`UPDATE ownership_observations SET parent_company_id = ${targetCompanyId} WHERE parent_company_id = ${sourceCompanyId} AND company_id <> ${targetCompanyId}`);
  await tx.execute(sql`UPDATE financial_observations SET company_id = ${targetCompanyId} WHERE company_id = ${sourceCompanyId}`);
  await tx.execute(sql`UPDATE employee_observations SET company_id = ${targetCompanyId} WHERE company_id = ${sourceCompanyId}`);

  await tx.execute(sql`UPDATE facilities SET company_id = ${targetCompanyId}, updated_at = now() WHERE company_id = ${sourceCompanyId}`);
  await tx.execute(sql`UPDATE contacts SET company_id = ${targetCompanyId}, updated_at = now() WHERE company_id = ${sourceCompanyId}`);
  await tx.execute(sql`UPDATE certifications SET company_id = ${targetCompanyId}, updated_at = now() WHERE company_id = ${sourceCompanyId}`);
  await tx.execute(sql`
    INSERT INTO feature_snapshots (company_id, schema_version, features, content_sha256, thesis_version, created_at)
    SELECT ${targetCompanyId}, schema_version, features, content_sha256, thesis_version, created_at
    FROM feature_snapshots WHERE company_id = ${sourceCompanyId}
    ON CONFLICT DO NOTHING
  `);
  await tx.execute(sql`DELETE FROM feature_snapshots WHERE company_id = ${sourceCompanyId}`);

  await tx.execute(sql`UPDATE known_universe_members SET company_id = ${targetCompanyId} WHERE company_id = ${sourceCompanyId}`);
  await tx.execute(sql`UPDATE known_universe_members SET matched_company_id = ${targetCompanyId} WHERE matched_company_id = ${sourceCompanyId}`);
  await tx.execute(sql`UPDATE golden_examples SET company_id = ${targetCompanyId} WHERE company_id = ${sourceCompanyId}`);
  await tx.execute(sql`UPDATE feedback SET company_id = ${targetCompanyId} WHERE company_id = ${sourceCompanyId}`);
  await tx.execute(sql`UPDATE research_questions SET company_id = ${targetCompanyId} WHERE company_id = ${sourceCompanyId}`);
  await tx.execute(sql`UPDATE research_runs SET target_id = ${targetCompanyId} WHERE target_type = 'company' AND target_id = ${sourceCompanyId}`);
}

async function transferDomainsLast(
  tx: Tx,
  sourceCompanyId: string,
  targetCompanyId: string,
): Promise<void> {
  const rows = await tx.execute<{ id: string; domain: string }>(sql`
    SELECT id, domain FROM company_domains WHERE company_id = ${sourceCompanyId} ORDER BY created_at, id
  `);
  for (const relation of rows.rows) {
    const target = await tx.execute<{ id: string }>(sql`
      SELECT id FROM company_domains
      WHERE company_id = ${targetCompanyId} AND lower(domain) = lower(${relation.domain})
      LIMIT 1
    `);
    if (target.rows[0] === undefined) {
      await tx.execute(sql`UPDATE company_domains SET company_id = ${targetCompanyId} WHERE id = ${relation.id}`);
    } else {
      await tx.execute(sql`DELETE FROM company_domains WHERE id = ${relation.id}`);
    }
  }
}

async function mergeOneCompany(
  tx: Tx,
  domain: string,
  sourceCompanyId: string,
  targetCompanyId: string,
): Promise<void> {
  const snapshots = await tx.execute<{ id: string; snapshot: Record<string, unknown> }>(sql`
    SELECT id, to_jsonb(c.*) AS snapshot
    FROM companies c
    WHERE id IN (${sourceCompanyId}, ${targetCompanyId})
    FOR UPDATE
  `);
  const source = snapshots.rows.find((row) => row.id === sourceCompanyId)?.snapshot;
  const target = snapshots.rows.find((row) => row.id === targetCompanyId)?.snapshot;
  if (source === undefined || target === undefined) throw new Error("both merge companies must exist");

  await transferCompanyReferences(tx, sourceCompanyId, targetCompanyId);
  await tx.execute(sql`
    UPDATE companies target
    SET description = coalesce(target.description, source.description),
        headquarters_country_code = coalesce(target.headquarters_country_code, source.headquarters_country_code),
        website_url = coalesce(target.website_url, source.website_url),
        founded_year = coalesce(target.founded_year, source.founded_year),
        updated_at = now()
    FROM companies source
    WHERE target.id = ${targetCompanyId} AND source.id = ${sourceCompanyId}
  `);
  await tx.execute(sql`UPDATE companies SET status = 'inactive', updated_at = now() WHERE id = ${sourceCompanyId}`);
  await transferDomainsLast(tx, sourceCompanyId, targetCompanyId);

  const after = await tx.execute<{ snapshot: Record<string, unknown> }>(sql`
    SELECT to_jsonb(c.*) AS snapshot FROM companies c WHERE id = ${targetCompanyId}
  `);
  const merge = await tx.execute<{ id: string }>(sql`
    INSERT INTO entity_merges (
      entity_type, source_entity_id, target_entity_id, reason,
      source_snapshot, target_snapshot_before, target_snapshot_after
    ) VALUES (
      'company', ${sourceCompanyId}, ${targetCompanyId},
      ${`duplicate canonical company attachment for verified domain ${domain}`},
      ${JSON.stringify(source)}::jsonb, ${JSON.stringify(target)}::jsonb,
      ${JSON.stringify(after.rows[0]?.snapshot ?? target)}::jsonb
    ) RETURNING id
  `);
  const mergeId = merge.rows[0]?.id;
  if (mergeId === undefined) throw new Error("entity merge insert returned no row");
  await tx.execute(sql`
    INSERT INTO audit_events (action, entity_type, entity_id, before, after, metadata)
    VALUES (
      'company.domain_duplicate_merged', 'entity_merge', ${mergeId},
      ${JSON.stringify({ sourceCompanyId, targetCompanyId })}::jsonb,
      ${JSON.stringify({ survivorCompanyId: targetCompanyId })}::jsonb,
      ${JSON.stringify({ domain, reason: "verified-domain canonical dedupe" })}::jsonb
    )
  `);
}

export async function dedupeCompanyDomains(
  db: Database,
  options: { readonly domain?: string; readonly all?: boolean; readonly apply?: boolean },
): Promise<CompanyDomainDedupeReport> {
  const plans = await selectCompanyDomainDedupePlans(db, options);
  if (options.apply !== true) return { mode: "dry-run", plans, mergedCompanyCount: 0 };

  let mergedCompanyCount = 0;
  for (const originalPlan of plans) {
    await db.transaction(async (tx) => {
      await withVerifiedDomainLock(tx, originalPlan.domain, async (domain) => {
        const currentPlan = await planForDomain(tx, domain);
        if (currentPlan === null) return;
        for (const duplicate of currentPlan.duplicates) {
          await mergeOneCompany(tx, domain, duplicate.id, currentPlan.survivor.id);
          mergedCompanyCount += 1;
        }
      });
    });
  }
  return { mode: "apply", plans, mergedCompanyCount };
}

function loadDatabaseUrl(): void {
  if (process.env.DATABASE_URL) return;
  for (const candidate of [path.join(process.cwd(), ".env.local"), path.join(process.cwd(), ".env")]) {
    if (!existsSync(candidate)) continue;
    const match = readFileSync(candidate, "utf8").match(/^DATABASE_URL=(.*)$/m);
    if (match?.[1]) {
      process.env.DATABASE_URL = match[1].trim();
      return;
    }
  }
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const domain = argumentValue("--domain");
  const all = process.argv.includes("--all");
  const apply = process.argv.includes("--apply");
  loadDatabaseUrl();
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required (.env.local or environment)");
  const report = await dedupeCompanyDomains(getDatabase(), {
    ...(domain === undefined ? {} : { domain }),
    all,
    apply,
  });
  console.log(`${report.mode}: ${report.plans.length} duplicate domain group(s), ${report.mergedCompanyCount} company merge(s)`);
  for (const plan of report.plans) {
    console.log(
      `${plan.domain}: survivor ${plan.survivor.id} (${plan.survivor.resolvedLeadCount} leads, ${plan.survivor.evidenceCount} evidence); ` +
        `duplicates ${plan.duplicates.map((company) => company.id).join(", ")}`,
    );
  }
  await closeDatabase();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
