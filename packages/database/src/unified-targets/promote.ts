/**
 * Promote only evidence-complete, same-input Jev+Muse decisions into leads.
 *
 * An exclusive lock on durable review state and a shared lock on its material
 * source revision are held across lead ingestion. Neither review invalidation
 * nor source/human edits can cross the final durable promotion boundary.
 */
import { sql } from "drizzle-orm";

import { getDatabase, type Database } from "../client.js";
import {
  ingestLeadCandidates,
  type LeadCandidateInput,
} from "../leads/ingest.js";
import { lockCurrentSignalReviewSource } from "../signal-reviews.js";
import { queryFnFor, type QueryableDb } from "./populate.js";
import {
  assessPromotionEvidence,
  normalizeTargetDomain,
  parseSignalResearchEvidence,
  type ExpectedFaaReviewInputContract,
} from "./records.js";

export const ENSEMBLE_PROMOTION_CAMPAIGN_ID =
  "a870d77a-d6b0-4f91-ac1e-f75e94d561ca";

export interface PromoteEnsembleLeadsOptions {
  /** Max current high-priority results to consider. Defaults to 25. */
  limit?: number;
  /** Select and assess without creating or linking leads. */
  dryRun?: boolean;
  /** Exact current model/prompt/policy contract. */
  expectedReviewInputContract: ExpectedFaaReviewInputContract;
}

export interface PromoteEnsembleLeadsResult {
  promoted: number;
  eligible: number;
  held: number;
  excluded: number;
  skipped: number;
}

interface PromotionCandidate {
  signalId: string;
  inputHash: string;
  sourceRevision: number;
  jevEvaluationId: string;
  museEvaluationId: string;
  rawName: string;
  verifiedDomain: string;
  uei: string | null;
  cage: string | null;
  city: string | null;
  state: string | null;
  awardCount: number;
  totalAwardValueUsd: number;
  freshestAwardDate: string | undefined;
  sourceLocator: string;
  leadId: string | null;
  companyId: string | null;
}

export interface ExistingLeadCoverage {
  leadIds: ReadonlySet<string>;
  companyIds: ReadonlySet<string>;
  rawNames: ReadonlySet<string>;
}

/** Exact durable identities only; no substring or probable alias suppression. */
export function isPromotionCandidateCovered(
  candidate: Pick<PromotionCandidate, "leadId" | "companyId" | "rawName">,
  coverage: ExistingLeadCoverage,
): boolean {
  return (
    (candidate.leadId !== null && coverage.leadIds.has(candidate.leadId)) ||
    (candidate.companyId !== null &&
      coverage.companyIds.has(candidate.companyId)) ||
    coverage.rawNames.has(candidate.rawName)
  );
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const text = textOrNull(item);
        return text === null ? [] : [text];
      })
    : [];
}

function awardCountOrZero(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function awardValueOrZero(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function awardDateOrUndefined(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  return textOrNull(value) ?? undefined;
}
function integerOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function toLeadCandidate(candidate: PromotionCandidate): LeadCandidateInput {
  return {
    rawName: candidate.rawName,
    domain: candidate.verifiedDomain,
    ...(candidate.uei === null ? {} : { uei: candidate.uei }),
    ...(candidate.cage === null ? {} : { cageCode: candidate.cage }),
    ...(candidate.city === null ? {} : { city: candidate.city }),
    ...(candidate.state === null ? {} : { state: candidate.state }),
    awardCount: candidate.awardCount,
    totalAwardValueUsd: candidate.totalAwardValueUsd,
    ...(candidate.freshestAwardDate === undefined
      ? {}
      : { freshestAwardDate: candidate.freshestAwardDate }),
    sourceLocator: candidate.sourceLocator,
  };
}

function transactionDatabaseFor(db: QueryableDb): Database {
  const candidate = db as Database;
  return typeof candidate.transaction === "function"
    ? candidate
    : getDatabase();
}

async function ingestWhileCurrent(
  db: Database,
  candidate: PromotionCandidate,
  expectedContract: ExpectedFaaReviewInputContract,
): Promise<{ created: number; duplicateSkipped: number; current: boolean }> {
  return db.transaction(async (tx) => {
    const current = await tx.execute<{ signal_id: string }>(sql`
      SELECT st.signal_id
      FROM signal_review_state st
      JOIN faa_ensemble_results r ON r.signal_id = st.signal_id
      JOIN faa_ensemble_evaluations jev ON jev.id = r.jev_evaluation_id
      JOIN faa_ensemble_evaluations muse ON muse.id = r.muse_evaluation_id
      WHERE st.signal_id = ${candidate.signalId}::uuid
        AND st.phase = 'settled'
        AND st.input_hash = ${candidate.inputHash}
        AND st.source_revision = ${candidate.sourceRevision}
        AND st.input_manifest->'sourceRevision'
          = to_jsonb(st.source_revision)
        AND r.input_hash = st.input_hash
        AND st.jev_evaluation_id = ${candidate.jevEvaluationId}::uuid
        AND r.jev_evaluation_id = ${candidate.jevEvaluationId}::uuid
        AND r.muse_evaluation_id = ${candidate.museEvaluationId}::uuid
        AND r.final_decision = 'high_priority'
        AND jev.signal_id = st.signal_id
        AND muse.signal_id = st.signal_id
        AND jev.input_hash = st.input_hash
        AND muse.input_hash = st.input_hash
        AND jev.error IS NULL
        AND muse.error IS NULL
        AND jev.decision = 'high_priority'
        AND muse.decision = 'high_priority'
        AND st.input_manifest->>'version' = ${expectedContract.version}
        AND st.input_manifest->'policy'->>'ladder' = ${expectedContract.policy.ladder}
        AND st.input_manifest->'policy'->>'jevModel' = ${expectedContract.policy.jevModel}
        AND st.input_manifest->'policy'->>'museModel' = ${expectedContract.policy.museModel}
        AND st.input_manifest->'policy'->>'evaluatorPrompt' = ${expectedContract.policy.evaluatorPrompt}
        AND st.input_manifest->'policy'->>'jevAuditSampleRate'
          = ${String(expectedContract.policy.jevAuditSampleRate)}
      FOR UPDATE OF st
    `);
    if (
      current.rows.length === 0 ||
      !(await lockCurrentSignalReviewSource(
        tx,
        candidate.signalId,
        candidate.sourceRevision,
      ))
    ) {
      return { created: 0, duplicateSkipped: 0, current: false };
    }

    const summary = await ingestLeadCandidates(ENSEMBLE_PROMOTION_CAMPAIGN_ID, [
      toLeadCandidate(candidate),
    ]);
    const found = await tx.execute<{ id: string }>(sql`
      SELECT id
      FROM leads
      WHERE campaign_id = ${ENSEMBLE_PROMOTION_CAMPAIGN_ID}::uuid
        AND raw_name = ${candidate.rawName}
        AND possible_domain = ${candidate.verifiedDomain}
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const leadId = found.rows[0]?.id;
    if (leadId !== undefined) {
      await tx.execute(sql`
        UPDATE source_signals
        SET lead_id = ${leadId}::uuid, updated_at = now()
        WHERE id = ${candidate.signalId}::uuid
          AND lead_id IS NULL
      `);
    }
    return {
      created: summary.created,
      duplicateSkipped: summary.duplicateSkipped,
      current: true,
    };
  });
}

export async function promoteEnsembleLeads(
  db: QueryableDb,
  opts: PromoteEnsembleLeadsOptions,
): Promise<PromoteEnsembleLeadsResult> {
  const expectedContract = opts?.expectedReviewInputContract;
  if (expectedContract === undefined) {
    throw new TypeError(
      "promoteEnsembleLeads requires expectedReviewInputContract",
    );
  }
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? 25)), 250);
  const dryRun = opts.dryRun ?? false;
  const query = queryFnFor(db);
  const { rows } = await query(
    `SELECT s.id AS signal_id, s.raw_name, s.raw_domain, s.uei, s.cage,
            s.award_count, s.award_value, s.freshest_award,
            s.source_locator, s.lead_id, s.company_id,
            (
              SELECT array_agg(domain.domain)
              FROM company_domains domain
              WHERE domain.company_id = s.company_id
            ) AS known_company_domains,
            st.input_hash, st.source_revision, st.research_evidence,
            r.jev_evaluation_id, r.muse_evaluation_id,
            jev.decision AS jev_decision,
            jev.disqualifiers AS jev_disqualifiers,
            muse.decision AS muse_decision,
            muse.disqualifiers AS muse_disqualifiers
     FROM signal_review_state st
     JOIN faa_ensemble_results r ON r.signal_id = st.signal_id
     JOIN faa_ensemble_evaluations jev ON jev.id = r.jev_evaluation_id
     JOIN faa_ensemble_evaluations muse ON muse.id = r.muse_evaluation_id
     JOIN source_signals s ON s.id = r.signal_id
     WHERE st.phase = 'settled'
       AND st.input_hash IS NOT NULL
       AND st.source_revision = s.review_revision
       AND st.input_manifest->'sourceRevision' = to_jsonb(st.source_revision)
       AND r.input_hash = st.input_hash
       AND r.jev_evaluation_id = st.jev_evaluation_id
       AND jev.signal_id = r.signal_id
       AND muse.signal_id = r.signal_id
       AND jev.input_hash = r.input_hash
       AND muse.input_hash = r.input_hash
       AND jev.error IS NULL
       AND muse.error IS NULL
       AND r.final_decision = 'high_priority'
       AND jev.decision = 'high_priority'
       AND muse.decision = 'high_priority'
       AND st.input_manifest->>'version' = $2
       AND st.input_manifest->'policy'->>'ladder' = $3
       AND st.input_manifest->'policy'->>'jevModel' = $4
       AND st.input_manifest->'policy'->>'museModel' = $5
       AND st.input_manifest->'policy'->>'evaluatorPrompt' = $6
       AND st.input_manifest->'policy'->>'jevAuditSampleRate' = $7
     ORDER BY r.final_confidence DESC NULLS LAST, r.updated_at ASC
     LIMIT $1`,
    [
      limit,
      expectedContract.version,
      expectedContract.policy.ladder,
      expectedContract.policy.jevModel,
      expectedContract.policy.museModel,
      expectedContract.policy.evaluatorPrompt,
      String(expectedContract.policy.jevAuditSampleRate),
    ],
  );

  let held = 0;
  let excluded = 0;
  const candidates: PromotionCandidate[] = [];
  for (const row of rows) {
    const evidence = parseSignalResearchEvidence(row["research_evidence"]);
    const assessment = assessPromotionEvidence({
      finalDecision: "high_priority",
      jevDecision: textOrNull(row["jev_decision"]),
      museDecision: textOrNull(row["muse_decision"]),
      researchEvidence: row["research_evidence"],
      jevDisqualifiers: stringList(row["jev_disqualifiers"]),
      museDisqualifiers: stringList(row["muse_disqualifiers"]),
    });
    if (assessment.status !== "ready" || assessment.verifiedDomain === null) {
      if (assessment.status === "excluded") excluded++;
      else held++;
      continue;
    }
    const knownDomains = [
      textOrNull(row["raw_domain"]),
      ...stringList(row["known_company_domains"]),
    ].flatMap((value) => {
      const domain = normalizeTargetDomain(value);
      return domain === null ? [] : [domain];
    });
    if (knownDomains.some((domain) => domain !== assessment.verifiedDomain)) {
      held++;
      continue;
    }
    const signalId = textOrNull(row["signal_id"]);
    const inputHash = textOrNull(row["input_hash"]);
    const jevEvaluationId = textOrNull(row["jev_evaluation_id"]);
    const museEvaluationId = textOrNull(row["muse_evaluation_id"]);
    const sourceRevision = integerOrNull(row["source_revision"]);
    const rawName = textOrNull(row["raw_name"]);
    const sourceLocator = textOrNull(row["source_locator"]);
    if (
      signalId === null ||
      inputHash === null ||
      jevEvaluationId === null ||
      sourceRevision === null ||
      museEvaluationId === null ||
      rawName === null ||
      sourceLocator === null
    ) {
      held++;
      continue;
    }
    candidates.push({
      signalId,
      inputHash,
      sourceRevision,
      jevEvaluationId,
      museEvaluationId,
      rawName,
      verifiedDomain: assessment.verifiedDomain,
      uei: textOrNull(row["uei"]),
      cage: textOrNull(row["cage"]),
      city:
        evidence.headquarters?.status === "supported"
          ? (evidence.headquarters.city ?? null)
          : null,
      state:
        evidence.headquarters?.status === "supported"
          ? (evidence.headquarters.state ?? null)
          : null,
      awardCount: awardCountOrZero(row["award_count"]),
      totalAwardValueUsd: awardValueOrZero(row["award_value"]),
      freshestAwardDate: awardDateOrUndefined(row["freshest_award"]),
      sourceLocator,
      leadId: textOrNull(row["lead_id"]),
      companyId: textOrNull(row["company_id"]),
    });
  }

  const leadIds = candidates.flatMap((candidate) =>
    candidate.leadId === null ? [] : [candidate.leadId],
  );
  const companyIds = candidates.flatMap((candidate) =>
    candidate.companyId === null ? [] : [candidate.companyId],
  );
  const rawNames = [
    ...new Set(candidates.map((candidate) => candidate.rawName)),
  ];
  const { rows: existingLeads } = await query(
    `SELECT id, raw_name, resolved_company_id
     FROM leads
     WHERE status <> 'discarded'
       AND (
         id = ANY($1::uuid[])
         OR resolved_company_id = ANY($2::uuid[])
         OR raw_name = ANY($3::text[])
       )`,
    [leadIds, companyIds, rawNames],
  );
  const coverage: ExistingLeadCoverage = {
    leadIds: new Set(
      existingLeads.flatMap((row) =>
        typeof row["id"] === "string" ? [row["id"]] : [],
      ),
    ),
    companyIds: new Set(
      existingLeads.flatMap((row) =>
        typeof row["resolved_company_id"] === "string"
          ? [row["resolved_company_id"]]
          : [],
      ),
    ),
    rawNames: new Set(
      existingLeads.flatMap((row) =>
        typeof row["raw_name"] === "string" ? [row["raw_name"]] : [],
      ),
    ),
  };
  const promotable = candidates.filter(
    (candidate) => !isPromotionCandidateCovered(candidate, coverage),
  );
  let skipped = candidates.length - promotable.length;
  if (dryRun || promotable.length === 0) {
    return {
      promoted: 0,
      eligible: promotable.length,
      held,
      excluded,
      skipped,
    };
  }

  const transactionDb = transactionDatabaseFor(db);
  let promoted = 0;
  for (const candidate of promotable) {
    const outcome = await ingestWhileCurrent(
      transactionDb,
      candidate,
      expectedContract,
    );
    if (!outcome.current) {
      skipped++;
      continue;
    }
    promoted += outcome.created;
    skipped += outcome.duplicateSkipped;
  }
  return {
    promoted,
    eligible: promotable.length,
    held,
    excluded,
    skipped,
  };
}
