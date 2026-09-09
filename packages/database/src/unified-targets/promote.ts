/**
 * Promote high-priority FAA ensemble results into leads.
 *
 * Selects `faa_ensemble_results` rows with `final_decision = 'high_priority'`
 * that have at least one successful (non-error) evaluation, skips signals or
 * companies that already have a non-discarded lead, and creates leads through
 * the SAME creation path the source-signal qualifier uses:
 * `ingestLeadCandidates` (packages/database/src/leads/ingest.ts, called from
 * apps/worker/src/supervisor/handlers.ts `qualifySourceSignal`).
 *
 * Library entry point: `promoteEnsembleLeads(db, opts?)`.
 * CLI lives in `scripts/promote-ensemble-leads.mts` (thin wrapper).
 */
import {
  ingestLeadCandidates,
  type LeadCandidateInput,
} from "../leads/ingest.js";
import { queryFnFor, type QueryableDb } from "./populate.js";

/**
 * Stable campaign id for ensemble promotions. Fixed (not random) so reruns
 * hit the ingestion dedupe key instead of creating duplicate leads.
 */
export const ENSEMBLE_PROMOTION_CAMPAIGN_ID =
  "7fa3c1e2-9b4d-4f6a-8c2e-1a5b9d3f7e6c0";

export interface PromoteEnsembleLeadsOptions {
  /** Max high-priority results to consider. Defaults to 25. */
  limit?: number;
  /** When true, select and count but create no leads. */
  dryRun?: boolean;
}

export interface PromoteEnsembleLeadsResult {
  promoted: number;
  skipped: number;
}

interface PromotionCandidate {
  signalId: string;
  rawName: string;
  rawDomain: string | null;
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

function textOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function awardCountOrZero(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return 0;
}

function awardValueOrZero(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function awardDateOrUndefined(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return undefined;
}

function toLeadCandidate(candidate: PromotionCandidate): LeadCandidateInput {
  return {
    rawName: candidate.rawName,
    ...(candidate.rawDomain === null
      ? {}
      : { domain: candidate.rawDomain }),
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

/**
 * Promote up to `limit` high-priority ensemble results to leads.
 * Returns `{ promoted, skipped }`.
 */
export async function promoteEnsembleLeads(
  db: QueryableDb,
  opts: PromoteEnsembleLeadsOptions = {},
): Promise<PromoteEnsembleLeadsResult> {
  const limit = opts.limit ?? 25;
  const dryRun = opts.dryRun ?? false;
  const query = queryFnFor(db);

  const { rows } = await query(
    `SELECT s.id AS signal_id, s.raw_name, s.raw_domain, s.uei, s.cage,
            s.city, s.state, s.award_count, s.award_value, s.freshest_award,
            s.source_locator, s.lead_id, s.company_id
     FROM faa_ensemble_results r
     JOIN source_signals s ON s.id = r.signal_id
     WHERE r.final_decision = 'high_priority'
       AND EXISTS (
         SELECT 1 FROM faa_ensemble_evaluations e
         WHERE e.signal_id = r.signal_id
           AND e.error IS NULL
           AND e.decision IS NOT NULL
       )
     ORDER BY r.final_confidence DESC NULLS LAST, r.created_at ASC
     LIMIT $1`,
    [limit],
  );

  const candidates: PromotionCandidate[] = [];
  for (const row of rows) {
    const rawName = textOrNull(row["raw_name"]);
    const signalId = textOrNull(row["signal_id"]);
    const sourceLocator = textOrNull(row["source_locator"]);
    if (rawName === null || signalId === null || sourceLocator === null) {
      continue;
    }
    candidates.push({
      signalId,
      rawName,
      rawDomain: textOrNull(row["raw_domain"]),
      uei: textOrNull(row["uei"]),
      cage: textOrNull(row["cage"]),
      city: textOrNull(row["city"]),
      state: textOrNull(row["state"]),
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
  const rawNames = [...new Set(candidates.map((candidate) => candidate.rawName))];

  // One lookup for every non-discarded lead already covering these signals,
  // companies, or raw names (e.g. created earlier by the live qualifier).
  const { rows: existingLeads } = await query(
    `SELECT id, raw_name, resolved_company_id FROM leads
     WHERE status <> 'discarded'
       AND (id = ANY($1::uuid[]) OR resolved_company_id = ANY($2::uuid[]) OR raw_name = ANY($3::text[]))`,
    [leadIds, companyIds, rawNames],
  );
  const coveredLeadIds = new Set(
    existingLeads.flatMap((row) =>
      typeof row["id"] === "string" ? [row["id"]] : [],
    ),
  );
  const coveredCompanyIds = new Set(
    existingLeads.flatMap((row) =>
      typeof row["resolved_company_id"] === "string"
        ? [row["resolved_company_id"]]
        : [],
    ),
  );
  const coveredNames = new Set(
    existingLeads.flatMap((row) =>
      typeof row["raw_name"] === "string" ? [row["raw_name"]] : [],
    ),
  );

  const promotable = candidates.filter(
    (candidate) =>
      (candidate.leadId === null || !coveredLeadIds.has(candidate.leadId)) &&
      (candidate.companyId === null ||
        !coveredCompanyIds.has(candidate.companyId)) &&
      !coveredNames.has(candidate.rawName),
  );
  const skipped = candidates.length - promotable.length;
  if (dryRun || promotable.length === 0) {
    return { promoted: promotable.length, skipped };
  }

  // SAME creation path the qualifier uses (handlers.ts qualifySourceSignal):
  // ingestLeadCandidates runs identity resolution + company creation and is
  // idempotent per (campaign, name, domain).
  const summary = await ingestLeadCandidates(
    ENSEMBLE_PROMOTION_CAMPAIGN_ID,
    promotable.map(toLeadCandidate),
  );

  // Link each promoted signal to its lead (fill only NULL lead_id, never
  // overwrite) so reruns skip via the lead check above.
  for (const candidate of promotable) {
    const found = await query(
      `SELECT id FROM leads
       WHERE campaign_id = $1::uuid AND raw_name = $2
       ORDER BY created_at DESC LIMIT 1`,
      [ENSEMBLE_PROMOTION_CAMPAIGN_ID, candidate.rawName],
    );
    const leadId = found.rows[0]?.["id"];
    if (typeof leadId !== "string") continue;
    await query(
      `UPDATE source_signals SET lead_id = $1::uuid, updated_at = now()
       WHERE id = $2::uuid AND lead_id IS NULL`,
      [leadId, candidate.signalId],
    );
  }

  return {
    promoted: summary.created,
    skipped: skipped + summary.duplicateSkipped,
  };
}
