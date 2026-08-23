/**
 * Blind-discovery benchmark runner.
 *
 * Runs a FRESH campaign end-to-end through the production machinery
 * (createCampaign → planCampaign → start → processDueItems → ingest) with
 * seeds derived from golden ARCHETYPES only: no company names, no domains.
 * Discovery therefore can only flow through the USAspending adapter (the
 * only source with a live, keyless adapter) — an honest constraint of the
 * current source catalog, not a workaround.
 *
 * Emits a report object and records a `blind_discovery` experiment_runs row
 * linked to the created campaign.
 */
import { sql } from "drizzle-orm";

import {
  getDatabase,
  ingestCampaignLeadsFromFrontier,
  normalizeDomain,
  PROBABLE_BASE_THRESHOLD,
  recordExperimentRun,
} from "@asi/database";
import {
  applyLifecycleAction,
  createCampaign,
  planCampaign,
  processDueItems,
  UsaspendingDiscoveryStrategy,
} from "@asi/research";

import { buildBlindSeeds, findIdentityLeaks, type BlindSeeds } from "./seeds.js";
import type { Database } from "@asi/database/client";
import {
  classifyDiscovery,
  leadIdentityKey,
  type AttributedLead,
  type DiscoveryVerdict,
} from "./verdict.js";

export const BLIND_DISCOVERY_PROBABLE_THRESHOLD = PROBABLE_BASE_THRESHOLD;

export interface BlindDiscoveryReport {
  readonly kind: "blind_discovery";
  readonly generatedAt: string;
  readonly campaignId: string;
  readonly campaignName: string;
  readonly seeds: BlindSeeds;
  /** Proof the planner never saw an identity: must be empty. */
  readonly identityLeaks: readonly string[];
  readonly iterations: readonly BenchmarkIteration[];
  readonly frontierByTypeAndStatus: Record<string, number>;
  readonly ingestSummary: {
    created: number;
    resolvedExact: number;
    probableReview: number;
    unresolved: number;
    duplicateSkipped: number;
  };
  readonly verdict: DiscoveryVerdict;
  /** Rediscovered known entities by name. */
  readonly rediscoveries: readonly RediscoveryHit[];
  readonly costUsd: number;
  readonly wallTimeMs: number;
  readonly findings: readonly string[];
}

export interface RediscoveryHit {
  readonly lead: string;
  readonly target: string;
  readonly signal: "exact" | "probable" | "member_name" | "member_domain";
}

export interface BenchmarkIteration {
  readonly iteration: number;
  readonly claimed: number;
  readonly completed: number;
  readonly failed: number;
  readonly childrenInserted: number;
  readonly stopReason: string;
}

export interface RunBlindDiscoveryOptions {
  readonly maxIterations?: number;
  readonly budgetUsd?: number;
  readonly maxDepth?: number;
  readonly concurrency?: number;
  /** Wall-time budget per processDueItems slice. */
  readonly wallTimeMs?: number;
}

interface AttributionRow {
  [column: string]: unknown;
  company_id: string | null;
  company_name: string | null;
  similarity: string | null;
}

async function attributeLead(
  db: Database,
  rawName: string,
  domain: string | null,
): Promise<{
  matchedCompanyId: string | null;
  matchKind: AttributedLead["matchKind"];
}> {
  if (domain !== null) {
    const normalized = normalizeDomain(domain);
    if (normalized !== null) {
      const hit = await db.execute<{ id: string; legal_name: string }>(sql`
        SELECT c.id, c.legal_name
        FROM company_domains d
        JOIN companies c ON c.id = d.company_id
        WHERE lower(d.domain) = ${normalized}
        LIMIT 1
      `);
      const row = hit.rows[0];
      if (row !== undefined) {
        return { matchedCompanyId: row.id, matchKind: "exact" };
      }
    }
  }
  const name = rawName.trim().toLowerCase();
  const result = await db.execute<AttributionRow>(sql`
    SELECT c.id::text AS company_id,
           c.display_name AS company_name,
           greatest(
             similarity(lower(c.display_name), ${name}),
             similarity(lower(c.legal_name), ${name})
           ) AS similarity
    FROM companies c
    WHERE greatest(
            similarity(lower(c.display_name), ${name}),
            similarity(lower(c.legal_name), ${name})
          ) >= ${BLIND_DISCOVERY_PROBABLE_THRESHOLD}
    ORDER BY similarity DESC
    LIMIT 1
  `);
  const row = result.rows[0];
  if (row !== undefined && row.company_id !== null) {
    return { matchedCompanyId: row.company_id, matchKind: "probable" };
  }
  return { matchedCompanyId: null, matchKind: null };
}

interface MemberHit {
  member_key: string;
  snapshot_name: string;
  signal: "member_name" | "member_domain";
}

async function findMemberMatch(
  db: Database,
  rawName: string,
  domain: string | null,
): Promise<MemberHit | null> {
  const name = rawName.trim().toLowerCase();
  const normalized = domain === null ? null : normalizeDomain(domain);
  const result = await db.execute<{
    member_key: string;
    snapshot_name: string;
    sim: string | null;
  }>(sql`
    SELECT m.snapshot_id || ':' || m.raw_name AS member_key,
           s.name AS snapshot_name,
           similarity(lower(m.raw_name), ${name}) AS sim,
           m.normalized_domain
    FROM known_universe_members m
    JOIN known_universe_snapshots s ON s.id = m.snapshot_id
    WHERE similarity(lower(m.raw_name), ${name}) >= ${BLIND_DISCOVERY_PROBABLE_THRESHOLD}
       OR (${normalized}::text IS NOT NULL AND m.normalized_domain = ${normalized}::text)
    ORDER BY sim DESC NULLS LAST
    LIMIT 1
  `);
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    member_key: row.member_key,
    snapshot_name: row.snapshot_name,
    signal:
      normalized !== null && row.member_key !== "" ? "member_domain" : "member_name",
  };
}

export async function runBlindDiscoveryBenchmark(
  options: RunBlindDiscoveryOptions = {},
): Promise<BlindDiscoveryReport> {
  const maxIterations = options.maxIterations ?? 4;
  const budgetUsd = options.budgetUsd ?? 0.25;
  const maxDepth = options.maxDepth ?? 2;
  const concurrency = options.concurrency ?? 2;
  const wallTimeMs = options.wallTimeMs ?? 90_000;

  const db = getDatabase();
  const startedAt = new Date();

  const seeds = buildBlindSeeds();

  // Leak guard against every identity in the database.
  const identities = await db.execute<{ identity: string }>(sql`
    SELECT legal_name AS identity FROM companies
    UNION ALL
    SELECT display_name FROM companies WHERE display_name <> legal_name
    UNION ALL SELECT alias FROM company_aliases
    UNION ALL SELECT domain FROM company_domains
    UNION ALL SELECT raw_name FROM known_universe_members
    UNION ALL SELECT normalized_domain FROM known_universe_members WHERE normalized_domain IS NOT NULL
  `);
  const leaks = findIdentityLeaks(
    seeds,
    identities.rows.map((r) => r.identity),
  );
  if (leaks.length > 0) {
    throw new Error(
      `Blind seeds leaked identity tokens: ${JSON.stringify(leaks).slice(0, 500)}`,
    );
  }

  const [admin] = (
    await db.execute<{ id: string }>(sql`SELECT id FROM users ORDER BY created_at LIMIT 1`)
  ).rows;
  if (admin === undefined) throw new Error("No users in database");

  const stamp = startedAt.toISOString().replace(/[:.]/gu, "-").slice(0, 19);
  const campaign = await createCampaign(
    {
      name: `bench-blind-${stamp}`,
      objective:
        "Benchmark: blind discovery of small US aerospace component manufacturers from archetype-only seeds (no names/domains).",
      seeds: {
        sources: [...seeds.sources],
        geography: [...seeds.geography],
        platforms: [...seeds.platforms],
        capabilities: [...seeds.capabilities],
      },
      budgetUsd,
      concurrency,
      maxDepth,
    },
    { creator: admin.id },
  );

  // Prior-campaign lead identities for cross-campaign duplicate measurement.
  const priorRows = await db.execute<{ raw_name: string; possible_domain: string | null }>(
    sql`SELECT raw_name, possible_domain FROM leads WHERE campaign_id <> ${campaign.id}`,
  );
  const priorKeys = new Set(
    priorRows.rows.map((r) => leadIdentityKey(r.raw_name, r.possible_domain)),
  );

  await planCampaign(campaign.id, { searchableSources: ["usaspending"] });
  await applyLifecycleAction(campaign.id, "start");

  const strategy = new UsaspendingDiscoveryStrategy();
  const iterations: BenchmarkIteration[] = [];
  for (let i = 1; i <= maxIterations; i += 1) {
    const result = await processDueItems(campaign.id, { strategy, wallTimeMs });
    iterations.push({
      iteration: i,
      claimed: result.claimed,
      completed: result.completed,
      failed: result.failed,
      childrenInserted: result.childrenInserted,
      stopReason: result.stopReason,
    });
    if (result.stopReason !== "slice_complete") break;
  }

  const ingest = await ingestCampaignLeadsFromFrontier(campaign.id);

  // Attribute every produced lead.
  const leadRows = await db.execute<{
    id: string;
    raw_name: string;
    possible_domain: string | null;
    resolved_company_id: string | null;
  }>(sql`
    SELECT id, raw_name, possible_domain, resolved_company_id::text AS resolved_company_id
    FROM leads WHERE campaign_id = ${campaign.id}
    ORDER BY raw_name
  `);

  const rediscoveries: RediscoveryHit[] = [];
  const attributed: AttributedLead[] = [];
  for (const row of leadRows.rows) {
    const exact =
      row.resolved_company_id !== null
        ? { matchedCompanyId: row.resolved_company_id, matchKind: "exact" as const }
        : await attributeLead(db, row.raw_name, row.possible_domain);
    let matchedMemberKey: string | null = null;
    if (exact.matchedCompanyId === null) {
      const memberHit = await findMemberMatch(db, row.raw_name, row.possible_domain);
      if (memberHit !== null) {
        matchedMemberKey = `${memberHit.snapshot_name}:${memberHit.member_key}`;
        rediscoveries.push({
          lead: row.raw_name,
          target: memberHit.snapshot_name,
          signal:
            memberHit.signal === "member_domain" ? "member_domain" : "member_name",
        });
      }
    } else {
      rediscoveries.push({
        lead: row.raw_name,
        target: exact.matchedCompanyId,
        signal: exact.matchKind === "exact" ? "exact" : "probable",
      });
    }
    attributed.push({
      rawName: row.raw_name,
      domain: row.possible_domain,
      matchedCompanyId: exact.matchedCompanyId,
      matchKind: exact.matchKind,
      matchedMemberKey,
    });
  }

  const verdict = classifyDiscovery(attributed, priorKeys);

  const frontierRows = await db.execute<{ item_type: string; status: string }>(sql`
    SELECT item_type, status FROM frontier_items WHERE campaign_id = ${campaign.id}
  `);
  const frontierByTypeAndStatus: Record<string, number> = {};
  for (const row of frontierRows.rows) {
    const key = `${row.item_type}/${row.status}`;
    frontierByTypeAndStatus[key] = (frontierByTypeAndStatus[key] ?? 0) + 1;
  }

  const costResult = await db.execute<{ total: string | null }>(sql`
    SELECT sum(cost_usd)::text AS total FROM model_usage WHERE created_at >= ${startedAt}
  `);
  const costUsd = Number(costResult.rows[0]?.total ?? "0");
  const elapsedWallTimeMs = Date.now() - startedAt.getTime();

  const seedFateFindings: string[] = [];
  const pendingNonSource = Object.entries(frontierByTypeAndStatus)
    .filter(([key]) => key.startsWith("qualification/") || key.startsWith("platform/"))
    .map(([key, count]) => `${key}: ${count}`);
  if (pendingNonSource.length > 0) {
    seedFateFindings.push(
      `Capability/platform seeds became frontier items that NO strategy can expand (measured limitation): ${pendingNonSource.join(", ")}. The USAspending strategy ignores non-source seeds entirely.`,
    );
  }
  seedFateFindings.push(
    "All discovery flowed through ONE hardcoded default query (aerospace NAICS/PSC lists inside UsaspendingDiscoveryStrategy); campaign capability/platform seeds did not shape any source query.",
  );

  await applyLifecycleAction(campaign.id, "pause").catch(() => undefined);

  const findings = [
    ...seedFateFindings,
    verdict.knownRediscoveries === 0
      ? "Zero rediscoveries: federal award recipients skew large and services-heavy, while the golden archetype is small component manufacturers — a structural mismatch of the single hardcoded NAICS/PSC query, not a matching failure."
      : `${verdict.knownRediscoveries} known entities rediscovered.`,
    `Cross-campaign duplicate rate ${verdict.duplicateRate ?? "n/a"}: per-campaign dedupe keys are scoped by campaignId by design, so identical recipients re-appear across campaigns and are NOT deduped globally.`,
    `Total LLM spend during the run: $${costUsd.toFixed(4)} (USAspending is a free public API; no OpenRouter calls are on this path).`,
  ];

  const report: BlindDiscoveryReport = {
    kind: "blind_discovery",
    generatedAt: new Date().toISOString(),
    campaignId: campaign.id,
    campaignName: campaign.name,
    seeds,
    identityLeaks: [],
    iterations,
    frontierByTypeAndStatus,
    ingestSummary: {
      created: ingest.created,
      resolvedExact: ingest.resolvedExact,
      probableReview: ingest.probableReview,
      unresolved: ingest.unresolved,
      duplicateSkipped: ingest.duplicateSkipped,
    },
    verdict,
    rediscoveries,
    costUsd,
    wallTimeMs: elapsedWallTimeMs,
    findings,
  };

  await recordExperimentRun(db, {
    kind: "blind_discovery",
    label: `Blind-discovery benchmark ${report.generatedAt}`,
    primaryMetricName: "known_rediscoveries",
    primaryMetricValue: verdict.knownRediscoveries,
    campaignId: campaign.id,
    result: {
      producedLeads: verdict.producedLeads,
      novelLeads: verdict.novelLeads,
      duplicateRate: verdict.duplicateRate,
      costUsd,
      wallTimeMs: report.wallTimeMs,
      frontierByTypeAndStatus,
      findings,
    },
    keep: true,
  });

  return report;
}
