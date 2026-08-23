/**
 * Entity-resolution benchmark runner.
 *
 * Runs the two production identity matchers over labeled perturbation cases:
 *   A. `matchMember` (snapshot import path: exact domain join + pg_trgm
 *      probable-name rule) — read-only.
 *   B. `ingestLeadCandidates` (leads identity resolution: identifiers →
 *      domain → trgm probable, plus per-campaign dedupe) — exercised on a
 *      synthetic campaign id with full row cleanup afterwards.
 *
 * Emits a report object (persisted as JSON by the CLI script) and records an
 * `entity_resolution` experiment_runs journal row.
 */
import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import {
  getDatabase,
  ingestLeadCandidates,
  matchMember,
  normalizeDomain,
  parseUsStateCode,
  PROBABLE_BASE_THRESHOLD,
  recordExperimentRun,
  type LeadCandidateInput,
} from "@asi/database";
import type { Database } from "@asi/database/client";

import { loadGroundTruth } from "./ground-truth.js";
import {
  aliasCapture,
  countFalseMerges,
  OPERATING_THRESHOLD,
  thresholdSweep,
  type FalseMergeReport,
  type ThresholdPoint,
} from "./metrics.js";
import { buildPerturbationCases } from "./perturbations.js";
import type { ErCase, ErOutcome } from "./types.js";

export { OPERATING_THRESHOLD, PROBABLE_BASE_THRESHOLD };

export interface EntityResolutionReport {
  readonly kind: "entity_resolution";
  readonly generatedAt: string;
  readonly seed: number;
  readonly groundTruth: {
    readonly companies: number;
    readonly goldenMembers: number;
    readonly pipelineMembers: number;
    readonly leads: number;
    readonly goldenPipelineDomainOverlap: number;
  };
  readonly caseCount: number;
  readonly casesByKind: Record<string, number>;
  readonly snapshotMatcher: {
    readonly operatingThreshold: number;
    readonly exactPrecision: number | null;
    readonly exactRecall: number | null;
    readonly probableAtThreshold: ThresholdPoint;
    readonly sweep: readonly ThresholdPoint[];
    readonly falseMerges: FalseMergeReport;
    readonly aliasCapture: ReturnType<typeof aliasCapture>;
    readonly byKind: Record<
      string,
      { tp: number; fp: number; fn: number; tn: number }
    >;
  };
  readonly leadsMatcher: {
    readonly summary: {
      created: number;
      resolvedExact: number;
      probableReview: number;
      unresolved: number;
      duplicateSkipped: number;
    };
    /** Domain-bearing positives that resolved exactly to the right company. */
    readonly domainExactHits: number;
    readonly domainExactTotal: number;
    readonly domainExactMisses: readonly string[];
    /** Name-only positives routed to probable review with the RIGHT company. */
    readonly probableCorrect: number;
    readonly probableWrong: readonly string[];
    /** Negative cases (confusables/family) that leaked a link. */
    readonly negativeLeaks: readonly string[];
    /** Duplicate replays correctly skipped by the per-campaign dedupe key. */
    readonly duplicateSkipped: number;
  };
  readonly parentSubsidiary: {
    readonly family: "yulista";
    readonly siblingsTested: number;
    readonly siblingMerges: number;
    /** Whether the matcher supports an automatic related-link. */
    readonly automaticRelatedLinkSupport: boolean;
    readonly manualDecisionOptions: readonly string[];
  };
  readonly findings: readonly string[];
}

interface LeadsPathEntry {
  readonly erCase: ErCase;
  readonly candidate: LeadCandidateInput;
}

/**
 * Build the leads-ingestion subset. Domain-bearing UNMATCHED cases are
 * deliberately excluded: the production path creates canonical companies for
 * unmatched-with-domain leads, which would pollute the catalog.
 */
export function buildLeadsPathPlan(
  cases: readonly ErCase[],
): { entries: LeadsPathEntry[]; replayEntries: LeadsPathEntry[]; skippedDomainNegatives: number } {
  const entries: LeadsPathEntry[] = [];
  let skippedDomainNegatives = 0;

  for (const c of cases) {
    if (c.kind === "member_replay" || c.kind === "lead_replay") continue;
    if (c.domain !== null && c.expectedCompanyId === null) {
      skippedDomainNegatives += 1;
      continue;
    }
    const base: LeadCandidateInput = {
      rawName: c.rawName,
      awardCount: 1,
      totalAwardValueUsd: 25_000,
      sourceLocator: `bench://entity-resolution/${c.caseId}`,
    };
    if (c.domain !== null) {
      const domain = normalizeDomain(c.domain);
      if (domain !== null) {
        entries.push({ erCase: c, candidate: { ...base, domain } });
      }
      continue;
    }
    if (
      c.expectedCompanyId !== null ||
      c.kind === "confusable_negative" ||
      c.kind === "family_sibling"
    ) {
      entries.push({ erCase: c, candidate: base });
    }
  }

  // Duplicate replays: re-send every entry once; each second row must be
  // recognized via the per-campaign dedupe key.
  const replayEntries = entries.map((e) => ({ ...e }));
  return { entries, replayEntries, skippedDomainNegatives };
}

function predictsAt(outcome: ErOutcome, threshold: number): boolean {
  return (
    outcome.matchStatus === "exact" ||
    (outcome.matchStatus === "probable" &&
      outcome.confidence !== null &&
      outcome.confidence >= threshold)
  );
}

function byKindCounts(
  cases: readonly ErCase[],
  outcomes: ReadonlyMap<string, ErOutcome>,
  threshold: number,
): Record<string, { tp: number; fp: number; fn: number; tn: number }> {
  const result: Record<string, { tp: number; fp: number; fn: number; tn: number }> = {};
  for (const c of cases) {
    const outcome = outcomes.get(c.caseId);
    if (outcome === undefined) continue;
    const predicted = predictsAt(outcome, threshold);
    const expected = c.expectedCompanyId !== null;
    const bucket = (result[c.kind] ??= { tp: 0, fp: 0, fn: 0, tn: 0 });
    if (expected && predicted) bucket.tp += 1;
    else if (!expected && predicted) bucket.fp += 1;
    else if (expected && !predicted) bucket.fn += 1;
    else bucket.tn += 1;
  }
  return result;
}

/** Run every case through the read-only production snapshot matcher. */
async function runSnapshotMatcher(
  db: Database,
  cases: readonly ErCase[],
): Promise<Map<string, ErOutcome>> {
  const outcomes = new Map<string, ErOutcome>();
  for (const c of cases) {
    // State-append cases carry trailing "- CT" style text; parse it the same
    // way the snapshot import parses workbook HQ text so the state bonus is
    // exercised as designed.
    const stateCode =
      c.kind === "state_append" ? parseUsStateCode(c.rawName) : null;
    const match = await matchMember(db, {
      rawName: c.rawName,
      normalizedDomain: normalizeDomain(c.domain ?? ""),
      stateCode,
    });
    outcomes.set(c.caseId, {
      caseId: c.caseId,
      matchStatus: match.matchStatus,
      confidence: match.matchConfidence,
      matchedCompanyId: match.matchedCompanyId,
    });
  }
  return outcomes;
}

interface LeadRowOutcome {
  readonly caseId: string;
  readonly status: string;
  readonly resolvedCompanyId: string | null;
  /** Company proposed by a pending probable-match review row, when any. */
  readonly proposedCompanyId: string | null;
}

async function loadLeadOutcomes(
  db: Database,
  campaignId: string,
): Promise<Map<string, LeadRowOutcome>> {
  const rows = await db.execute<{
    locator: string | null;
    status: string;
    resolved_company_id: string | null;
    proposed_company_id: string | null;
  }>(sql`
    SELECT l.context->>'sourceLocator' AS locator,
           l.status,
           l.resolved_company_id::text AS resolved_company_id,
           imc.company_id::text AS proposed_company_id
    FROM leads l
    LEFT JOIN identity_match_candidates imc
      ON imc.lead_id = l.id AND imc.decision = 'pending'
    WHERE l.campaign_id = ${campaignId}
  `);
  const out = new Map<string, LeadRowOutcome>();
  for (const row of rows.rows) {
    // sourceLocator shape: bench://entity-resolution/<caseId>
    const parts = (row.locator ?? "").split("/");
    const caseId = parts.at(-1) ?? "";
    if (caseId.startsWith("er-")) {
      out.set(caseId, {
        caseId,
        status: row.status,
        resolvedCompanyId: row.resolved_company_id,
        proposedCompanyId: row.proposed_company_id,
      });
    }
  }
  return out;
}

async function runLeadsMatcher(
  db: Database,
  plan: ReturnType<typeof buildLeadsPathPlan>,
): Promise<{
  summary: EntityResolutionReport["leadsMatcher"]["summary"];
  leadOutcomes: Map<string, LeadRowOutcome>;
}> {
  const campaignId = randomUUID();
  const liveCandidates = plan.entries.map((e) => e.candidate);
  const replayCandidates = plan.replayEntries.map((e) => e.candidate);

  const summary = await ingestLeadCandidates(campaignId, liveCandidates);
  // Second pass: every row must now be recognized as a duplicate.
  const replaySummary = await ingestLeadCandidates(campaignId, replayCandidates);

  const leadOutcomes = await loadLeadOutcomes(db, campaignId);

  // Cleanup: remove every synthetic row. leads.campaign_id is a plain column
  // (no FK cascade), so delete candidates + leads explicitly first.
  await db.execute(sql`
    DELETE FROM identity_match_candidates
    WHERE lead_id IN (SELECT id FROM leads WHERE campaign_id = ${campaignId})
  `);
  await db.execute(sql`DELETE FROM leads WHERE campaign_id = ${campaignId}`);

  return {
    summary: {
      created: summary.created,
      resolvedExact: summary.resolvedExact,
      probableReview: summary.probableReview,
      unresolved: summary.unresolved,
      duplicateSkipped: summary.duplicateSkipped + replaySummary.duplicateSkipped,
    },
    leadOutcomes,
  };
}

function leadsMatcherReport(
  plan: ReturnType<typeof buildLeadsPathPlan>,
  summary: EntityResolutionReport["leadsMatcher"]["summary"],
  leadOutcomes: ReadonlyMap<string, LeadRowOutcome>,
): EntityResolutionReport["leadsMatcher"] {
  const domainPositives = plan.entries.filter(
    (e) => e.candidate.domain !== undefined && e.erCase.expectedCompanyId !== null,
  );
  const domainExactMisses = domainPositives
    .filter((e) => {
      const outcome = leadOutcomes.get(e.erCase.caseId);
      return (
        outcome === undefined ||
        outcome.status !== "resolved" ||
        outcome.resolvedCompanyId !== e.erCase.expectedCompanyId
      );
    })
    .map((e) => `${e.erCase.caseId}:${e.erCase.rawName}`);

  const nameOnlyPositives = plan.entries.filter(
    (e) => e.candidate.domain === undefined && e.erCase.expectedCompanyId !== null,
  );
  const probableCorrect = nameOnlyPositives.filter((e) => {
    const outcome = leadOutcomes.get(e.erCase.caseId);
    // Production routes name-only trigram hits to review, never auto-merge;
    // the pending identity_match_candidates row carries the proposed
    // company. Correct behavior = held for review WITH the right proposal.
    return (
      outcome !== undefined &&
      outcome.resolvedCompanyId === null &&
      outcome.proposedCompanyId === e.erCase.expectedCompanyId
    );
  }).length;
  const probableWrong = nameOnlyPositives
    .filter((e) => {
      const outcome = leadOutcomes.get(e.erCase.caseId);
      return (
        outcome !== undefined &&
        (outcome.resolvedCompanyId !== null ||
          (outcome.proposedCompanyId !== null &&
            outcome.proposedCompanyId !== e.erCase.expectedCompanyId))
      );
    })
    .map((e) => `${e.erCase.caseId}:${e.erCase.rawName}`);

  const negatives = plan.entries.filter(
    (e) =>
      e.erCase.expectedCompanyId === null &&
      (e.erCase.kind === "confusable_negative" || e.erCase.kind === "family_sibling"),
  );
  const negativeLeaks = negatives
    .filter((e) => {
      const outcome = leadOutcomes.get(e.erCase.caseId);
      return (
        outcome !== undefined &&
        (outcome.status === "resolving" || outcome.resolvedCompanyId !== null)
      );
    })
    .map((e) => `${e.erCase.caseId}:${e.erCase.rawName}`);

  return {
    summary,
    domainExactHits: domainPositives.length - domainExactMisses.length,
    domainExactTotal: domainPositives.length,
    domainExactMisses,
    probableCorrect,
    probableWrong,
    negativeLeaks,
    duplicateSkipped: summary.duplicateSkipped,
  };
}

export interface RunEntityResolutionOptions {
  readonly seed?: number;
}

export async function runEntityResolutionBenchmark(
  options: RunEntityResolutionOptions = {},
): Promise<EntityResolutionReport> {
  const seed = options.seed ?? 20260823;
  const db = getDatabase();

  const truth = await loadGroundTruth(db);
  const cases = buildPerturbationCases(truth, seed);

  const outcomes = await runSnapshotMatcher(db, cases);
  const operating = thresholdSweep(cases, outcomes, [OPERATING_THRESHOLD])[0]!;

  let exactTp = 0;
  let exactFp = 0;
  let exactFn = 0;
  for (const c of cases) {
    const o = outcomes.get(c.caseId);
    if (o === undefined) continue;
    const expected = c.expectedCompanyId !== null;
    if (o.matchStatus === "exact" && expected) exactTp += 1;
    else if (o.matchStatus === "exact" && !expected) exactFp += 1;
    else if (o.matchStatus !== "exact" && expected) exactFn += 1;
  }

  const sweep = thresholdSweep(cases, outcomes);
  const falseMerges = countFalseMerges(cases, outcomes, OPERATING_THRESHOLD);
  const alias = aliasCapture(cases, outcomes, OPERATING_THRESHOLD);

  const plan = buildLeadsPathPlan(cases);
  const { summary, leadOutcomes } = await runLeadsMatcher(db, plan);
  const leadsReport = leadsMatcherReport(plan, summary, leadOutcomes);

  const casesByKind: Record<string, number> = {};
  for (const c of cases) {
    casesByKind[c.kind] = (casesByKind[c.kind] ?? 0) + 1;
  }

  const yulistaCases = cases.filter((c) => c.family === "yulista");
  const siblingMerges = falseMerges.familySiblingMerges;

  const findings: string[] = [];
  const totalFalseMerges =
    falseMerges.wrongCompanyMerges + falseMerges.familySiblingMerges;
  findings.push(
    totalFalseMerges === 0
      ? "No false merges at the operating threshold: the Zephyr Tool Group / Zephyr International confusable pair and all Yulista family siblings stayed unlinked."
      : `${totalFalseMerges} false merge(s) at the operating threshold — see snapshotMatcher.falseMerges.detail.`,
  );
  findings.push(
    "The production matcher has NO automatic parent/subsidiary or related-link concept: probable matches are held for analyst review, and the only related-link mechanism is a manual identity-match decision (parent_subsidiary).",
  );
  findings.push(
    "Thresholds below the 0.72 production floor are unreachable through matchMember: the SQL rule enforces 0.72 internally, so the reported sweep plateaus below it. Lowering the operating point requires a matcher change, not a decision change.",
  );

  const report: EntityResolutionReport = {
    kind: "entity_resolution",
    generatedAt: new Date().toISOString(),
    seed,
    groundTruth: {
      companies: truth.companies.length,
      goldenMembers: truth.goldenMembers.length,
      pipelineMembers: truth.pipelineMembers.length,
      leads: truth.leads.length,
      goldenPipelineDomainOverlap: truth.goldenPipelineDomainOverlap,
    },
    caseCount: cases.length,
    casesByKind,
    snapshotMatcher: {
      operatingThreshold: OPERATING_THRESHOLD,
      exactPrecision: exactTp + exactFp > 0 ? exactTp / (exactTp + exactFp) : null,
      exactRecall: exactTp + exactFn > 0 ? exactTp / (exactTp + exactFn) : null,
      probableAtThreshold: operating,
      sweep,
      falseMerges,
      aliasCapture: alias,
      byKind: byKindCounts(cases, outcomes, OPERATING_THRESHOLD),
    },
    leadsMatcher: leadsReport,
    parentSubsidiary: {
      family: "yulista",
      siblingsTested: yulistaCases.length,
      siblingMerges,
      automaticRelatedLinkSupport: false,
      manualDecisionOptions: [
        "merged",
        "rejected_merge",
        "alias",
        "parent_subsidiary",
        "acquired_into",
      ],
    },
    findings,
  };

  await recordExperimentRun(db, {
    kind: "entity_resolution",
    label: `Entity-resolution benchmark ${report.generatedAt}`,
    primaryMetricName: "probable_f1",
    primaryMetricValue: operating.f1 ?? 0,
    result: {
      caseCount: report.caseCount,
      exactPrecision: report.snapshotMatcher.exactPrecision,
      exactRecall: report.snapshotMatcher.exactRecall,
      falseMerges: totalFalseMerges,
      aliasCaptureRate: report.snapshotMatcher.aliasCapture.rate,
      leadsSummary: report.leadsMatcher.summary,
      findings: [...report.findings],
    },
    keep: true,
  });

  return report;
}
