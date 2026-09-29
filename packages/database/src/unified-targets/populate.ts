/**
 * Project current source and review state into `unified_targets`.
 *
 * Reconciliation removes only attributable stale ensemble assessments.
 * Source identity, evidence, reference membership, and investor-entered facts
 * remain durable across every population pass.
 *
 * Library entry point: `populateUnifiedTargets(db, opts)`.
 * CLI lives in `scripts/populate-unified-targets.mts` (thin wrapper).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { Database } from "../client.js";
import {
  assessPromotionEvidence,
  hasResearchSupportEvidence,
  normalizeTargetDomain,
  parseSignalResearchEvidence,
  type ExpectedFaaReviewInputContract,
} from "./records.js";

// ---------------------------------------------------------------------------
// Query surface (pg Pool works directly; drizzle Database via $client)
// ---------------------------------------------------------------------------

/** Rows returned by every populate query (pg `rows` shape). */
export type PopulateQueryFn = (
  text: string,
  params: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

/** Anything with a pg-style `query()` — a Pool, or a drizzle Database. */
export interface PoolLike {
  query(
    text: string,
    params: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

export type QueryableDb = PoolLike | Database | { $client: PoolLike };

/**
 * Normalize the `db` argument to a `(text, params) => { rows }` function.
 * Accepts a pg Pool directly or a drizzle Database (uses its `$client` pool).
 */
export function queryFnFor(db: QueryableDb): PopulateQueryFn {
  const candidate = db as unknown as {
    query?: PoolLike["query"];
    $client?: unknown;
  };
  if (typeof candidate.query === "function") {
    // Call as a method so pg Pool keeps its receiver.
    return (text, params) => candidate.query!(text, params);
  }
  const client = candidate.$client as PoolLike | undefined;
  if (client !== undefined && typeof client.query === "function") {
    return (text, params) => client.query(text, params);
  }
  throw new Error(
    "populateUnifiedTargets: db must be a pg Pool or a drizzle Database (expected query() or $client.query())",
  );
}

export interface MachineProjectionReconciliation {
  staleMachineAssessments: number;
  correctedFalseInference: number;
}

const MACHINE_ONLY_PROJECTION_SQL = `
  unified_targets.origins <@ '["faa_ensemble"]'::jsonb
  AND unified_targets.golden_v1_member = false
  AND COALESCE(unified_targets.pipeline_decision, 'unreviewed') = 'unreviewed'
  AND NOT EXISTS (
    SELECT 1 FROM candidates candidate
    WHERE candidate.id = unified_targets.candidate_id
      AND candidate.tier_source::text = 'human'
  )`;
const STALE_MACHINE_ONLY_PROJECTION_SQL =
  MACHINE_ONLY_PROJECTION_SQL.replaceAll("unified_targets.", "ut.");

/**
 * Clear ensemble-owned assessment columns that have no current review matching
 * the expected input contract, without touching durable identity, source
 * evidence, list membership, or investor judgments. Legacy Infinite
 * Electronics leaks are bounded to exact names, the known conflicting domain
 * or inferred value pair, and FAA provenance; the feedback repair also refuses
 * to cross any source-level human-review marker.
 */
export async function reconcileUnifiedTargetMachineProjections(
  db: QueryableDb,
  expectedReviewInputContract: ExpectedFaaReviewInputContract,
): Promise<MachineProjectionReconciliation> {
  if (expectedReviewInputContract === undefined) {
    throw new TypeError(
      "reconcileUnifiedTargetMachineProjections requires expectedReviewInputContract",
    );
  }
  const query = queryFnFor(db);
  const stale = await query(
    `UPDATE unified_targets ut
     SET tier = CASE
           WHEN ${STALE_MACHINE_ONLY_PROJECTION_SQL}
             AND ut.ensemble_decision IN ('high_priority', 'research')
             AND ut.tier IN ('high_interest', 'evaluate')
           THEN 'needs_research'
           ELSE ut.tier
         END,
         investor_priority = CASE WHEN ${STALE_MACHINE_ONLY_PROJECTION_SQL}
           THEN NULL ELSE ut.investor_priority END,
         proprietary_basis = CASE WHEN ${STALE_MACHINE_ONLY_PROJECTION_SQL}
           THEN 'unknown' ELSE ut.proprietary_basis END,
         oversize_flag = CASE WHEN ${STALE_MACHINE_ONLY_PROJECTION_SQL}
           THEN false ELSE ut.oversize_flag END,
         ensemble_decision = NULL,
         ensemble_confidence = NULL,
         pipeline_status = CASE
           WHEN ut.pipeline_status IN ('ready', 'diligence_hold', 'excluded', 'jev_complete')
             THEN NULL
           ELSE ut.pipeline_status
         END,
         why_interesting = CASE WHEN ${STALE_MACHINE_ONLY_PROJECTION_SQL}
           THEN NULL ELSE ut.why_interesting END,
         risks = CASE WHEN ${STALE_MACHINE_ONLY_PROJECTION_SQL}
           THEN NULL ELSE ut.risks END,
         unknowns = CASE WHEN ${STALE_MACHINE_ONLY_PROJECTION_SQL}
           THEN NULL ELSE ut.unknowns END,
         updated_at = now()
     WHERE ut.origins ? $1
       AND (
         ut.ensemble_decision IS NOT NULL
         OR ut.ensemble_confidence IS NOT NULL
         OR ut.pipeline_status IN ('ready', 'diligence_hold', 'excluded', 'jev_complete')
         OR ut.why_interesting IS NOT NULL
         OR ut.risks IS NOT NULL
         OR ut.unknowns IS NOT NULL
       )
       AND NOT EXISTS (
         SELECT 1
         FROM signal_review_state st
         JOIN source_signals s
           ON s.id = st.signal_id
          AND s.review_revision = st.source_revision
         JOIN faa_ensemble_evaluations jev
           ON jev.id = st.jev_evaluation_id
          AND jev.signal_id = st.signal_id
          AND jev.input_hash = st.input_hash
          AND jev.error IS NULL
          AND jev.decision IN ('research', 'high_priority')
         WHERE st.signal_id = ut.signal_id
           AND st.phase = 'settled'
           AND st.input_hash IS NOT NULL
           AND st.input_manifest->'sourceRevision' = to_jsonb(st.source_revision)
           AND st.input_manifest->>'version' = $2
           AND st.input_manifest->'policy'->>'ladder' = $3
           AND st.input_manifest->'policy'->>'jevModel' = $4
           AND st.input_manifest->'policy'->>'museModel' = $5
           AND st.input_manifest->'policy'->>'evaluatorPrompt' = $6
           AND st.input_manifest->'policy'->>'analyst' = $7
       )
     RETURNING ut.id`,
    [
      ORIGIN_FAA_ENSEMBLE,
      expectedReviewInputContract.version,
      expectedReviewInputContract.policy.ladder,
      expectedReviewInputContract.policy.jevModel,
      expectedReviewInputContract.policy.museModel,
      expectedReviewInputContract.policy.evaluatorPrompt,
      expectedReviewInputContract.policy.analyst,
    ],
  );
  const correctedIdentity = await query(
    `UPDATE unified_targets ut
     SET domain = NULL,
         website_url = NULL,
         tier = CASE
           WHEN ut.tier = 'high_interest' THEN 'needs_research'
           ELSE ut.tier
         END,
         proprietary_basis = 'unknown',
         pipeline_status = NULL,
         evidence_urls = (
           SELECT COALESCE(jsonb_agg(url), '[]'::jsonb)
           FROM jsonb_array_elements_text(ut.evidence_urls) AS evidence(url)
           WHERE lower(url) NOT LIKE '%infiniteelectronics.com%'
         ),
         updated_at = now()
     WHERE ut.normalized_name = $1
       AND ut.origins ? $2
       AND lower(regexp_replace(rtrim(ut.domain, '.'), '^www\\.', '', 'i'))
         = $3
     RETURNING ut.id`,
    [
      normalizeUnifiedName("Electronics International"),
      ORIGIN_FAA_ENSEMBLE,
      "infiniteelectronics.com",
    ],
  );
  const correctedFeedback = await query(
    `UPDATE unified_targets ut
     SET ownership_status = 'unknown',
         pipeline_decision = 'unreviewed',
         updated_at = now()
     WHERE ut.normalized_name = $1
       AND ut.origins ? $2
       AND ut.signal_id IS NOT NULL
       AND ut.ownership_status = 'independent'
       AND ut.pipeline_decision = 'add'
       AND NOT EXISTS (
         SELECT 1
         FROM source_signals ss
         WHERE ss.id = ut.signal_id
           AND COALESCE(
             ss.qualification ?| ARRAY[
               'humanDecision',
               'humanOverride',
               'reviewedByUserId',
               'reviewedBy',
               'humanReviewedAt',
               'humanReviewNote'
             ]
             OR ss.qualification->>'decisionSource' = 'human'
             OR ss.qualification->>'reviewSource' = 'human',
             false
           )
       )
     RETURNING ut.id`,
    [
      normalizeUnifiedName("Infinite Electronics International"),
      ORIGIN_FAA_ENSEMBLE,
    ],
  );
  return {
    staleMachineAssessments: stale.rows.length,
    correctedFalseInference:
      correctedIdentity.rows.length + correctedFeedback.rows.length,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in tests/unified-targets.test.ts)
// ---------------------------------------------------------------------------

export const ORIGIN_GOLDEN_V1 = "golden_v1";
export const ORIGIN_CURATED = "curated";
export const ORIGIN_DISCOVERY = "discovery";
export const ORIGIN_FAA_ENSEMBLE = "faa_ensemble";

/** Tier rank: higher wins, never downgrades on merge. */
export const TIER_RANK: Record<string, number> = {
  needs_research: 1,
  evaluate: 2,
  high_interest: 3,
  reference: 4,
};

/**
 * Contract normalization: lowercase, trim, collapse whitespace, strip one
 * trailing legal-entity suffix. MUST match normalizeTargetName in
 * packages/database/src/unified-targets/records.ts.
 */
export function normalizeUnifiedName(name: string): string {
  return name
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[,.\s]+$/, "")
    .replace(
      /\s+(llc|inc|corp|corporation|incorporated|co|company|ltd|limited|lp|llp|pllc|plc)\.?$/,
      "",
    )
    .replace(/[,.\s]+$/, "");
}

/** Tier-no-downgrade merge: returns the higher-ranked of two tiers. */

/**
 * Entity-resolution benchmark fixtures (e.g. "New Domain Foundry a534ffe2",
 * "Aero Precision Machining mt5u8ng8", "Shared Brand ...") are seeded into
 * dev databases by tests. They must never leak into the shareable set.
 */
export function isSyntheticTargetName(name: string): boolean {
  const trimmed = name.trim();
  if (/^(New Domain|Shared Brand)\b/i.test(trimmed)) return true;
  if (/\s(mt[a-z0-9]{6}|[a-f0-9]{8})$/i.test(trimmed)) return true;
  return false;
}

/**
 * Names categorically off-thesis by scale (mega-cap primes/strategics that
 * can never be sub-$50M acquisitions). Documented, minimal, test-pinned.
 * Everything else is judged by evidence, not fame.
 */
const OFF_THESIS_NAMES = new Set(["anduril industries", "skydweller us"]);

export function isOffThesisName(name: string): boolean {
  return OFF_THESIS_NAMES.has(normalizeUnifiedName(name));
}

/**
 * Affirmative non-independence stated in the name itself ("Subsidiary of
 * HEICO", "Division of ..."). Flags oversize/owned rather than dropping.
 */
export function isSubsidiaryName(name: string): boolean {
  return /\b(subsidiary|division|unit)\s+of\b/i.test(name);
}

// Projection vocabulary. Prior-list verdict labels are intentionally absent:
// list membership is exported as provenance and never classified into these
// current evidence fields.

export type OwnershipStatus =
  | "independent"
  | "pe_owned"
  | "strategic_owned"
  | "public"
  | "dead"
  | "unknown";

export type PipelineDecision =
  | "add"
  | "hold"
  | "pass_acquired"
  | "pass_scale"
  | "pass_dead"
  | "pass_sector"
  | "unreviewed";

/** Ownership merge: any non-unknown value wins; both known keeps existing. */
export function mergeOwnershipStatus(
  existing: OwnershipStatus | string | null | undefined,
  incoming: OwnershipStatus | string | null | undefined,
): OwnershipStatus {
  const known = (v: string | null | undefined): v is OwnershipStatus =>
    v === "independent" ||
    v === "pe_owned" ||
    v === "strategic_owned" ||
    v === "public" ||
    v === "dead";
  if (known(existing)) return existing;
  if (known(incoming)) return incoming;
  return "unknown";
}

const PIPELINE_DECISION_RANK: Record<string, number> = {
  pass_acquired: 4,
  pass_scale: 4,
  pass_dead: 4,
  pass_sector: 4,
  add: 3,
  hold: 2,
  unreviewed: 1,
};

/**
 * Pipeline-decision merge: terminal passes outrank add, which outranks hold,
 * which outranks unreviewed. Ties keep the existing value. `add` is only
 * ever produced from an explicit investor verdict, never derived
 * automatically, so letting it win over hold/unreviewed is safe.
 */
export function mergePipelineDecision(
  existing: PipelineDecision | string | null | undefined,
  incoming: PipelineDecision | string | null | undefined,
): PipelineDecision {
  const rank = (v: string | null | undefined): number =>
    PIPELINE_DECISION_RANK[v ?? "unreviewed"] ?? 1;
  const normalize = (v: string | null | undefined): PipelineDecision =>
    v === "add" ||
    v === "hold" ||
    v === "pass_acquired" ||
    v === "pass_scale" ||
    v === "pass_dead" ||
    v === "pass_sector"
      ? v
      : "unreviewed";
  return rank(incoming) > rank(existing)
    ? normalize(incoming)
    : normalize(existing);
}
export function higherTier(a: string, b: string): string {
  return (TIER_RANK[a] ?? 0) >= (TIER_RANK[b] ?? 0) ? a : b;
}

/**
 * Curated CSV `screen_status` → tier. `credible_target` is high_interest;
 * anything else needs more evidence (evaluate). Rejects are excluded (null).
 */
export function mapCuratedTier(screenStatus: string | null): string | null {
  const status = (screenStatus ?? "").trim().toLowerCase();
  if (status === "credible_target") return "high_interest";
  if (status === "reject" || status === "rejected") return null;
  return "evaluate";
}

/**
 * Candidate status → tier. research_ready is high_interest, queued research
 * still needs research, everything else is evaluate. Rejects are excluded.
 */
export function mapCandidateTier(status: string | null): string | null {
  const s = (status ?? "").trim().toLowerCase();
  if (s === "research_ready") return "high_interest";
  if (s === "queued_research" || s === "queued") return "needs_research";
  if (s === "rejected" || s === "archived") return null;
  return "evaluate";
}

export function mapCandidateProjectionTier(
  status: string | null,
  tierOverride: string | null,
  tierSource: string | null,
): string | null {
  if (tierSource !== "human" || tierOverride === null) {
    return mapCandidateTier(status);
  }
  if (tierOverride === "high_interest") return "high_interest";
  if (tierOverride === "evaluate") return "evaluate";
  if (tierOverride === "watchlist" || tierOverride === "low_interest") {
    return "needs_research";
  }
  return mapCandidateTier(status);
}

export type InvestorPriority = 1 | 2 | 3;
export type ProprietaryBasis = "product" | "process_only" | "unknown";

export interface InvestorAssessment {
  investorPriority: InvestorPriority;
  proprietaryBasis: ProprietaryBasis;
}

const PROCESS_ONLY_EVIDENCE =
  /\b(kitting|assembly|build[\s-]*to[\s-]*print|btp|capabilit(?:y|ies)[\s-]*only|services?[\s-]*only)\b/i;
const PROPRIETARY_PRODUCT_EVIDENCE =
  /\b(?:catalog(?:ue)?|patented|proprietary[\s_-]+(?:part|component|product|system))\b|\b(?:pma|stc|tso)(?:\b|_)/i;
const IDENTITY_THIN_EVIDENCE =
  /\b(identity[\s-]*(?:thin|uncertain|unresolved)|thin[\s-]*identity)\b/i;
/** Stock qualifier sentence present in every discovery rationale; not evidence. */
const BOILERPLATE_PRODUCT_PHRASE =
  /verified from first-party pages as a us aerospace\/defense physical-product manufacturer\.?/gi;

/** Classify evidence without treating a proprietary process as a product. */
export function mapProprietaryBasis(
  evidence: string | null | undefined,
): ProprietaryBasis {
  if (!evidence) return "unknown";
  const scrubbed = evidence.replace(BOILERPLATE_PRODUCT_PHRASE, " ");
  if (PROCESS_ONLY_EVIDENCE.test(scrubbed)) return "process_only";
  if (PROPRIETARY_PRODUCT_EVIDENCE.test(scrubbed)) return "product";
  return "unknown";
}

/**
 * Preserve source attention unless process-only evidence prevents P1.
 * Product evidence supports, but never manufactures, a source's attention rank.
 */
export function deriveInvestorAssessment(
  defaultPriority: InvestorPriority,
  evidence: string | null | undefined,
): InvestorAssessment {
  const proprietaryBasis = mapProprietaryBasis(evidence);
  return {
    investorPriority:
      proprietaryBasis === "process_only" && defaultPriority === 1
        ? 2
        : defaultPriority,
    proprietaryBasis,
  };
}

export function mapCuratedInvestorAssessment(
  screenStatus: string | null,
  evidence: string | null | undefined,
): InvestorAssessment {
  return deriveInvestorAssessment(
    (screenStatus ?? "").trim().toLowerCase() === "credible_target" ? 1 : 2,
    evidence,
  );
}

export function mapDiscoveryInvestorAssessment(
  status: string | null,
  confidence: number | null,
  websiteUrl: string | null,
  evidence: string | null | undefined,
): InvestorAssessment {
  const normalizedStatus = (status ?? "").trim().toLowerCase();
  const defaultPriority: InvestorPriority =
    confidence === 0 ||
    websiteUrl === null ||
    IDENTITY_THIN_EVIDENCE.test(evidence ?? "")
      ? 3
      : normalizedStatus === "research_ready"
        ? 1
        : normalizedStatus === "queued_research" ||
            normalizedStatus === "queued"
          ? 3
          : 2;
  return deriveInvestorAssessment(defaultPriority, evidence);
}

/** Extract a bare lowercase domain from a website URL (null when absent). */
export function domainFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const bare = url
    .trim()
    .replace(/^https?:\/\//i, "")
    .split("/")[0]!
    .replace(/^www\./i, "")
    .trim()
    .toLowerCase();
  return bare === "" ? null : bare;
}

const US_STATE_CODES: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
  "district of columbia": "DC",
};

/**
 * Parse curated `hq` values like "Conway, South Carolina, US" into
 * city / state_code / country_code.
 */
export function parseHq(hq: string | null | undefined): {
  city: string | null;
  stateCode: string | null;
  countryCode: string | null;
} {
  const empty = { city: null, stateCode: null, countryCode: null };
  if (!hq || hq.trim() === "") return empty;
  const parts = hq.split(",").map((p) => p.trim());
  const city = parts[0] === "" ? null : (parts[0] ?? null);
  let stateCode: string | null = null;
  let countryCode: string | null = null;
  if (parts.length >= 3) {
    const stateName = (parts[1] ?? "").toLowerCase();
    stateCode =
      US_STATE_CODES[stateName] ??
      (parts[1]!.trim() === "" ? null : (parts[1] ?? null));
    const country = (parts[2] ?? "").toLowerCase();
    countryCode =
      country === "us" || country === "usa" || country === "united states"
        ? "US"
        : parts[2]!.trim().toUpperCase().slice(0, 2) || null;
  } else if (parts.length === 2) {
    const tail = (parts[1] ?? "").toLowerCase();
    if (tail === "us" || tail === "usa" || tail === "united states") {
      countryCode = "US";
    } else {
      stateCode =
        US_STATE_CODES[tail] ??
        (parts[1]!.trim() === "" ? null : (parts[1] ?? null));
    }
  }
  return { city, stateCode, countryCode };
}

/** Join a rationale string array into display text (null when empty). */
export function rationaleText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const items = value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v !== "");
  return items.length === 0 ? null : items.join("; ");
}

/** Coerce a current_scores axis value to a number (null when absent). */
export function scoreNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(String(value));
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Minimal CSV parser (curated export is small; handles quoted commas)
// ---------------------------------------------------------------------------

export function parseSimpleCsv(text: string): Record<string, string>[] {
  const source = text.replace(/^\uFEFF/, "");
  const table: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      table.push(row);
      row = [];
      field = "";
    } else if (ch === "\r") {
      // skip; \n handles the break
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    table.push(row);
  }
  if (table.length === 0) return [];
  const headers = table[0]!.map((h) => h.trim());
  return table.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    headers.forEach((h, idx) => {
      record[h] = (cells[idx] ?? "").trim();
    });
    return record;
  });
}

// ---------------------------------------------------------------------------
// Upsert plumbing (raw SQL, idempotent on normalized_name)
// ---------------------------------------------------------------------------

export interface UnifiedTargetRow {
  companyName: string;
  domain: string | null;
  websiteUrl: string | null;
  city: string | null;
  stateCode: string | null;
  countryCode: string | null;
  origin: string;
  goldenV1Member: boolean;
  tier: string;
  investorPriority: InvestorPriority;
  oversizeFlag: boolean;
  proprietaryBasis: ProprietaryBasis;
  ownershipStatus: OwnershipStatus;
  pipelineDecision: PipelineDecision;
  pipelineStatus: string | null;
  fit: number | null;
  novelty: number | null;
  confidence: number | null;
  actionability: number | null;
  ensembleDecision: string | null;
  ensembleConfidence: number | null;
  whyInteresting: string | null;
  risks: string | null;
  unknowns: string | null;
  evidenceUrls: string[];
  companyId: string | null;
  signalId: string | null;
  candidateId: string | null;
}

const UPSERT_COLUMNS = [
  "company_name",
  "normalized_name",
  "domain",
  "website_url",
  "city",
  "state_code",
  "country_code",
  "origins",
  "golden_v1_member",
  "tier",
  "investor_priority",
  "oversize_flag",
  "proprietary_basis",
  "pipeline_status",
  "ownership_status",
  "pipeline_decision",
  "fit",
  "novelty",
  "confidence",
  "actionability",
  "ensemble_decision",
  "ensemble_confidence",
  "why_interesting",
  "risks",
  "unknowns",
  "evidence_urls",
  "company_id",
  "signal_id",
  "candidate_id",
] as const;

function proprietaryBasisRank(basis: ProprietaryBasis): number {
  return basis === "product" ? 3 : basis === "process_only" ? 2 : 1;
}

function firstNonNull<T>(a: T | null, b: T | null): T | null {
  return a ?? b;
}

export function hasConflictingTargetDomains(
  existing: string | null,
  incoming: string | null,
): boolean {
  const existingDomain = normalizeTargetDomain(existing);
  const incomingDomain = normalizeTargetDomain(incoming);
  return (
    existingDomain !== null &&
    incomingDomain !== null &&
    existingDomain !== incomingDomain
  );
}
/**
 * Fold rows sharing a normalized name so a single INSERT batch never hits
 * the same conflict target twice (e.g. one company with two candidate rows).
 * Keeps the highest tier, unions origins/evidence, prefers first non-null scalars.
 */
export function mergeBatchDuplicates(
  rows: readonly UnifiedTargetRow[],
): UnifiedTargetRow[] {
  const byName = new Map<string, UnifiedTargetRow>();
  for (const row of rows) {
    const key = normalizeUnifiedName(row.companyName);
    const existing = byName.get(key);
    if (existing === undefined) {
      byName.set(key, {
        ...row,
        ownershipStatus: row.ownershipStatus ?? "unknown",
        pipelineDecision: row.pipelineDecision ?? "unreviewed",
        evidenceUrls: [...row.evidenceUrls],
      });
      continue;
    }
    if (hasConflictingTargetDomains(existing.domain, row.domain)) {
      continue;
    }
    const rank = (t: string): number => TIER_RANK[t] ?? 0;
    byName.set(key, {
      ...existing,
      domain: firstNonNull(existing.domain, row.domain),
      websiteUrl: firstNonNull(existing.websiteUrl, row.websiteUrl),
      city: firstNonNull(existing.city, row.city),
      stateCode: firstNonNull(existing.stateCode, row.stateCode),
      countryCode: firstNonNull(existing.countryCode, row.countryCode),
      goldenV1Member: existing.goldenV1Member || row.goldenV1Member,
      tier: rank(row.tier) > rank(existing.tier) ? row.tier : existing.tier,
      pipelineStatus: firstNonNull(existing.pipelineStatus, row.pipelineStatus),
      ownershipStatus: mergeOwnershipStatus(
        existing.ownershipStatus,
        row.ownershipStatus,
      ),
      pipelineDecision: mergePipelineDecision(
        existing.pipelineDecision,
        row.pipelineDecision,
      ),
      investorPriority:
        row.investorPriority < existing.investorPriority
          ? row.investorPriority
          : existing.investorPriority,
      oversizeFlag: existing.oversizeFlag || row.oversizeFlag,
      proprietaryBasis:
        proprietaryBasisRank(row.proprietaryBasis) >
        proprietaryBasisRank(existing.proprietaryBasis)
          ? row.proprietaryBasis
          : existing.proprietaryBasis,
      novelty: firstNonNull(existing.novelty, row.novelty),
      confidence: firstNonNull(existing.confidence, row.confidence),
      actionability: firstNonNull(existing.actionability, row.actionability),
      ensembleDecision: firstNonNull(
        existing.ensembleDecision,
        row.ensembleDecision,
      ),
      ensembleConfidence: firstNonNull(
        existing.ensembleConfidence,
        row.ensembleConfidence,
      ),
      whyInteresting: firstNonNull(existing.whyInteresting, row.whyInteresting),
      risks: firstNonNull(existing.risks, row.risks),
      unknowns: firstNonNull(existing.unknowns, row.unknowns),
      evidenceUrls: [
        ...new Set([...existing.evidenceUrls, ...row.evidenceUrls]),
      ],
      companyId: firstNonNull(existing.companyId, row.companyId),
      signalId: firstNonNull(existing.signalId, row.signalId),
      candidateId: firstNonNull(existing.candidateId, row.candidateId),
    });
  }
  return [...byName.values()];
}

const EXISTING_RANK_SQL =
  "CASE unified_targets.tier WHEN 'reference' THEN 4 WHEN 'high_interest' THEN 3 WHEN 'evaluate' THEN 2 ELSE 1 END";
const EXCLUDED_RANK_SQL =
  "CASE EXCLUDED.tier WHEN 'reference' THEN 4 WHEN 'high_interest' THEN 3 WHEN 'evaluate' THEN 2 ELSE 1 END";
const PIPELINE_DECISION_EXISTING_RANK_SQL =
  "CASE unified_targets.pipeline_decision WHEN 'pass_acquired' THEN 4 WHEN 'pass_scale' THEN 4 WHEN 'pass_dead' THEN 4 WHEN 'pass_sector' THEN 4 WHEN 'add' THEN 3 WHEN 'hold' THEN 2 ELSE 1 END";
const PIPELINE_DECISION_EXCLUDED_RANK_SQL =
  "CASE EXCLUDED.pipeline_decision WHEN 'pass_acquired' THEN 4 WHEN 'pass_scale' THEN 4 WHEN 'pass_dead' THEN 4 WHEN 'pass_sector' THEN 4 WHEN 'add' THEN 3 WHEN 'hold' THEN 2 ELSE 1 END";

const CONFLICT_CLAUSE = `ON CONFLICT (normalized_name) DO UPDATE SET
  domain = COALESCE(unified_targets.domain, EXCLUDED.domain),
  website_url = COALESCE(unified_targets.website_url, EXCLUDED.website_url),
  city = COALESCE(unified_targets.city, EXCLUDED.city),
  state_code = COALESCE(unified_targets.state_code, EXCLUDED.state_code),
  country_code = COALESCE(unified_targets.country_code, EXCLUDED.country_code),
  origins = (SELECT COALESCE(jsonb_agg(DISTINCT e), '[]'::jsonb)
             FROM jsonb_array_elements_text(unified_targets.origins || EXCLUDED.origins) AS e),
  golden_v1_member = unified_targets.golden_v1_member OR EXCLUDED.golden_v1_member,
  tier = CASE
    WHEN EXCLUDED.origins ? 'faa_ensemble'
      AND EXISTS (
        SELECT 1
        FROM candidates candidate
        WHERE candidate.id = unified_targets.candidate_id
          AND candidate.tier_source::text = 'human'
      )
      THEN unified_targets.tier
    WHEN EXCLUDED.origins ? 'faa_ensemble'
      AND unified_targets.origins <@ '["faa_ensemble"]'::jsonb
      THEN EXCLUDED.tier
    WHEN (${EXCLUDED_RANK_SQL}) > (${EXISTING_RANK_SQL})
      THEN EXCLUDED.tier
    ELSE unified_targets.tier
  END,
  investor_priority = CASE
    WHEN EXCLUDED.origins ? 'faa_ensemble'
      AND EXISTS (
        SELECT 1
        FROM candidates candidate
        WHERE candidate.id = unified_targets.candidate_id
          AND candidate.tier_source::text = 'human'
      )
      THEN unified_targets.investor_priority
    WHEN EXCLUDED.origins ? 'faa_ensemble'
      AND unified_targets.origins <@ '["faa_ensemble"]'::jsonb
      THEN EXCLUDED.investor_priority
    WHEN unified_targets.investor_priority IS NULL THEN EXCLUDED.investor_priority
    WHEN EXCLUDED.investor_priority IS NULL THEN unified_targets.investor_priority
    WHEN EXCLUDED.investor_priority < unified_targets.investor_priority THEN EXCLUDED.investor_priority
    ELSE unified_targets.investor_priority
  END,
  oversize_flag = CASE
    WHEN EXCLUDED.origins ? 'faa_ensemble' AND ${MACHINE_ONLY_PROJECTION_SQL}
      THEN EXCLUDED.oversize_flag
    ELSE COALESCE(unified_targets.oversize_flag, false) OR COALESCE(EXCLUDED.oversize_flag, false)
  END,
  proprietary_basis = CASE
    WHEN EXCLUDED.origins ? 'faa_ensemble' AND ${MACHINE_ONLY_PROJECTION_SQL}
      THEN EXCLUDED.proprietary_basis
    WHEN (CASE EXCLUDED.proprietary_basis WHEN 'product' THEN 3 WHEN 'process_only' THEN 2 WHEN 'unknown' THEN 1 ELSE 0 END)
       > (CASE unified_targets.proprietary_basis WHEN 'product' THEN 3 WHEN 'process_only' THEN 2 WHEN 'unknown' THEN 1 ELSE 0 END)
      THEN EXCLUDED.proprietary_basis
    ELSE COALESCE(unified_targets.proprietary_basis, EXCLUDED.proprietary_basis)
  END,
  pipeline_status = CASE
    WHEN EXCLUDED.origins ? 'faa_ensemble' THEN EXCLUDED.pipeline_status
    ELSE COALESCE(unified_targets.pipeline_status, EXCLUDED.pipeline_status)
  END,
  ownership_status = CASE
    WHEN unified_targets.ownership_status IS NULL OR unified_targets.ownership_status = 'unknown' THEN COALESCE(EXCLUDED.ownership_status, unified_targets.ownership_status)
    WHEN EXCLUDED.ownership_status IS NULL OR EXCLUDED.ownership_status = 'unknown' THEN unified_targets.ownership_status
    ELSE unified_targets.ownership_status
  END,
  pipeline_decision = CASE WHEN (${PIPELINE_DECISION_EXCLUDED_RANK_SQL}) > (${PIPELINE_DECISION_EXISTING_RANK_SQL})
              THEN EXCLUDED.pipeline_decision ELSE unified_targets.pipeline_decision END,
  fit = COALESCE(unified_targets.fit, EXCLUDED.fit),
  novelty = COALESCE(unified_targets.novelty, EXCLUDED.novelty),
  confidence = COALESCE(unified_targets.confidence, EXCLUDED.confidence),
  actionability = COALESCE(unified_targets.actionability, EXCLUDED.actionability),
  ensemble_decision = CASE
    WHEN EXCLUDED.origins ? 'faa_ensemble' THEN EXCLUDED.ensemble_decision
    ELSE COALESCE(EXCLUDED.ensemble_decision, unified_targets.ensemble_decision)
  END,
  ensemble_confidence = CASE
    WHEN EXCLUDED.origins ? 'faa_ensemble' THEN EXCLUDED.ensemble_confidence
    ELSE COALESCE(EXCLUDED.ensemble_confidence, unified_targets.ensemble_confidence)
  END,
  why_interesting = CASE
    WHEN EXCLUDED.origins ? 'faa_ensemble' AND ${MACHINE_ONLY_PROJECTION_SQL}
      THEN EXCLUDED.why_interesting
    ELSE COALESCE(unified_targets.why_interesting, EXCLUDED.why_interesting)
  END,
  risks = CASE
    WHEN EXCLUDED.origins ? 'faa_ensemble' AND ${MACHINE_ONLY_PROJECTION_SQL}
      THEN EXCLUDED.risks
    ELSE COALESCE(unified_targets.risks, EXCLUDED.risks)
  END,
  unknowns = CASE
    WHEN EXCLUDED.origins ? 'faa_ensemble' AND ${MACHINE_ONLY_PROJECTION_SQL}
      THEN EXCLUDED.unknowns
    ELSE COALESCE(unified_targets.unknowns, EXCLUDED.unknowns)
  END,
  evidence_urls = (SELECT COALESCE(jsonb_agg(DISTINCT e), '[]'::jsonb)
                   FROM jsonb_array_elements_text(unified_targets.evidence_urls || EXCLUDED.evidence_urls) AS e),
  company_id = COALESCE(unified_targets.company_id, EXCLUDED.company_id),
  signal_id = COALESCE(unified_targets.signal_id, EXCLUDED.signal_id),
  candidate_id = COALESCE(unified_targets.candidate_id, EXCLUDED.candidate_id),
  updated_at = now()
WHERE unified_targets.domain IS NULL
   OR EXCLUDED.domain IS NULL
   OR lower(regexp_replace(rtrim(unified_targets.domain, '.'), '^www\\.', '', 'i'))
      = lower(regexp_replace(rtrim(EXCLUDED.domain, '.'), '^www\\.', '', 'i'))`;

/**
 * Bulk upsert one source batch. Returns per-source inserted/merged counts
 * (`xmax = 0` marks freshly inserted rows). Chunked at UPSERT_CHUNK_ROWS:
 * 29 columns/row means 250 rows stay far under PostgreSQL's 65,535-parameter
 * ceiling and keep bind payloads small.
 */
export const UPSERT_CHUNK_ROWS = 250;

export async function upsertBatch(
  query: PopulateQueryFn,
  rows: readonly UnifiedTargetRow[],
): Promise<SourceCounts> {
  if (rows.length === 0) return { inserted: 0, merged: 0 };
  // Entity-resolution benchmark fixtures live in dev databases; they must
  // never leak into the shareable golden set.
  const deduped = mergeBatchDuplicates(
    rows.filter((r) => !isSyntheticTargetName(r.companyName)),
  );
  let inserted = 0;
  let merged = 0;
  for (let start = 0; start < deduped.length; start += UPSERT_CHUNK_ROWS) {
    const chunk = deduped.slice(start, start + UPSERT_CHUNK_ROWS);
    const outcome = await upsertChunk(query, chunk);
    inserted += outcome.inserted;
    merged += outcome.merged;
  }
  return { inserted, merged };
}

async function upsertChunk(
  query: PopulateQueryFn,
  chunk: readonly UnifiedTargetRow[],
): Promise<SourceCounts> {
  const params: unknown[] = [];
  const tuples = chunk.map((r) => {
    const values: unknown[] = [
      r.companyName,
      normalizeUnifiedName(r.companyName),
      r.domain,
      r.websiteUrl,
      r.city,
      r.stateCode,
      r.countryCode,
      JSON.stringify([r.origin]),
      r.goldenV1Member,
      r.tier,
      r.investorPriority,
      r.oversizeFlag,
      r.proprietaryBasis,
      r.pipelineStatus,
      r.ownershipStatus ?? "unknown",
      r.pipelineDecision ?? "unreviewed",
      r.fit,
      r.novelty,
      r.confidence,
      r.actionability,
      r.ensembleDecision,
      r.ensembleConfidence,
      r.whyInteresting,
      r.risks,
      r.unknowns,
      JSON.stringify(r.evidenceUrls),
      r.companyId,
      r.signalId,
      r.candidateId,
    ];
    const placeholders = values.map((v) => {
      params.push(v);
      return `$${params.length}`;
    });
    // origins / evidence_urls ride as JSON text cast to jsonb.
    placeholders[7] += "::jsonb";
    placeholders[25] += "::jsonb";
    return `(${placeholders.join(", ")})`;
  });
  const text =
    `INSERT INTO unified_targets (${UPSERT_COLUMNS.join(", ")}) VALUES ${tuples.join(", ")} ` +
    `${CONFLICT_CLAUSE} RETURNING (xmax = 0) AS inserted`;
  const result = await query(text, params);
  let inserted = 0;
  for (const row of result.rows) {
    if ("inserted" in row && row.inserted === true) inserted++;
  }
  return { inserted, merged: result.rows.length - inserted };
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export interface SourceCounts {
  inserted: number;
  merged: number;
  reconciliation?: MachineProjectionReconciliation;
}

async function loadGolden(
  query: (
    text: string,
    params: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>,
): Promise<UnifiedTargetRow[]> {
  const { rows } = await query(
    `SELECT m.raw_name AS name,
            m.normalized_domain AS domain,
            COALESCE(
              m.company_id,
              CASE
                WHEN m.match_status::text = 'exact' THEN m.matched_company_id
                ELSE NULL
              END
            ) AS company_id,
            c.website_url, c.headquarters_country_code
     FROM known_universe_snapshots snapshot
     JOIN known_universe_members m ON m.snapshot_id = snapshot.id
     LEFT JOIN companies c
       ON c.id = COALESCE(
         m.company_id,
         CASE
           WHEN m.match_status::text = 'exact' THEN m.matched_company_id
           ELSE NULL
         END
       )
     WHERE snapshot.key = 'golden-set-v01'
       AND snapshot.active = true`,
    [],
  );
  return rows.flatMap((r) => {
    const name = String(r["name"] ?? "").trim();
    if (name === "") return [];
    const domain = normalizeTargetDomain(
      typeof r["domain"] === "string" ? r["domain"] : null,
    );
    const websiteUrl =
      typeof r["website_url"] === "string" && r["website_url"] !== ""
        ? (r["website_url"] as string)
        : domain === null
          ? null
          : `https://${domain}`;
    return [
      {
        companyName: name,
        domain,
        websiteUrl,
        city: null,
        stateCode: null,
        countryCode:
          typeof r["headquarters_country_code"] === "string"
            ? (r["headquarters_country_code"] as string)
            : null,
        origin: ORIGIN_GOLDEN_V1,
        goldenV1Member: true,
        tier: "reference",
        investorPriority: 3,
        proprietaryBasis: "unknown",
        oversizeFlag: false,
        ownershipStatus: "unknown",
        pipelineDecision: "unreviewed",
        pipelineStatus: null,
        fit: null,
        novelty: null,
        confidence: null,
        actionability: null,
        ensembleDecision: null,
        ensembleConfidence: null,
        whyInteresting: null,
        risks: null,
        unknowns: null,
        evidenceUrls: [],
        companyId:
          typeof r["company_id"] === "string"
            ? (r["company_id"] as string)
            : null,
        signalId: null,
        candidateId: null,
      } satisfies UnifiedTargetRow,
    ];
  });
}

function loadCurated(csvPath: string): UnifiedTargetRow[] {
  const text = readFileSync(csvPath, "utf8");
  return parseSimpleCsv(text).flatMap((r) => {
    const name = (r["company"] ?? "").trim();
    if (name === "") return [];
    const tier = mapCuratedTier(r["screen_status"] ?? "");
    if (tier === null) return [];
    const websiteUrl = (r["website_url"] ?? "").trim() || null;
    const hq = parseHq(r["hq"] ?? "");
    const evidenceUrls = [
      r["government_evidence_url"],
      r["company_evidence_url"],
      r["ownership_or_risk_evidence_url"],
    ]
      .map((u) => (u ?? "").trim())
      .filter((u) => u !== "");
    const investorAssessment = mapCuratedInvestorAssessment(
      r["screen_status"] ?? "",
      [r["fit_summary"], r["key_risk"]].join(" "),
    );
    return [
      {
        companyName: name,
        domain: domainFromUrl(websiteUrl),
        websiteUrl,
        city: hq.city,
        stateCode: hq.stateCode,
        countryCode: hq.countryCode,
        origin: ORIGIN_CURATED,
        goldenV1Member: false,
        tier,
        ...investorAssessment,
        oversizeFlag: false,
        pipelineStatus: null,
        ownershipStatus: "unknown",
        pipelineDecision: "unreviewed",
        fit: null,
        novelty: null,
        confidence: null,
        actionability: null,
        ensembleDecision: null,
        ensembleConfidence: null,
        whyInteresting: (r["fit_summary"] ?? "").trim() || null,
        risks: (r["key_risk"] ?? "").trim() || null,
        unknowns: null,
        evidenceUrls,
        companyId: null,
        signalId: null,
        candidateId: null,
      } satisfies UnifiedTargetRow,
    ];
  });
}

async function loadDiscovery(
  query: (
    text: string,
    params: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>,
): Promise<UnifiedTargetRow[]> {
  const { rows } = await query(
    `SELECT c.id AS company_id, cand.id AS candidate_id,
            COALESCE(NULLIF(c.display_name, ''), c.legal_name) AS name,
            c.website_url, c.headquarters_country_code,
            cand.status::text AS status,
            cand.tier_override::text AS tier_override,
            cand.tier_source::text AS tier_source,
            cand.current_scores, cand.rationale
     FROM candidates cand
     JOIN companies c ON c.id = cand.company_id
     WHERE cand.status::text NOT IN ('rejected', 'archived')
        OR cand.tier_source::text = 'human'`,
    [],
  );
  return rows.flatMap((r) => {
    const name = String(r["name"] ?? "").trim();
    if (name === "" || isOffThesisName(name)) return [];
    const status =
      typeof r["status"] === "string" ? (r["status"] as string) : null;
    const tierOverride =
      typeof r["tier_override"] === "string"
        ? (r["tier_override"] as string)
        : null;
    const tierSource =
      typeof r["tier_source"] === "string"
        ? (r["tier_source"] as string)
        : null;
    const tier = mapCandidateProjectionTier(status, tierOverride, tierSource);
    if (tier === null) return [];
    const scores = (r["current_scores"] ?? {}) as Record<string, unknown>;
    const rationale = (r["rationale"] ?? {}) as Record<string, unknown>;
    const websiteUrl =
      typeof r["website_url"] === "string" && r["website_url"] !== ""
        ? (r["website_url"] as string)
        : null;
    const investorAssessment = mapDiscoveryInvestorAssessment(
      status,
      scoreNumber(scores["confidence"]),
      websiteUrl,
      [
        rationaleText(rationale["whyInteresting"]),
        rationaleText(rationale["risks"]),
        rationaleText(rationale["unknowns"]),
      ].join(" "),
    );
    return [
      {
        companyName: name,
        domain: domainFromUrl(websiteUrl),
        websiteUrl,
        city: null,
        stateCode: null,
        countryCode:
          typeof r["headquarters_country_code"] === "string"
            ? (r["headquarters_country_code"] as string)
            : null,
        origin: ORIGIN_DISCOVERY,
        goldenV1Member: false,
        tier,
        ...investorAssessment,
        investorPriority:
          tierSource === "human"
            ? tier === "high_interest"
              ? 1
              : tier === "evaluate"
                ? 2
                : 3
            : investorAssessment.investorPriority,
        oversizeFlag: isSubsidiaryName(name),
        pipelineStatus: status,
        fit: scoreNumber(scores["fit"]),
        novelty: scoreNumber(scores["novelty"]),
        confidence: scoreNumber(scores["confidence"]),
        actionability: scoreNumber(scores["actionability"]),
        ensembleDecision: null,
        ensembleConfidence: null,
        ownershipStatus: "unknown",
        pipelineDecision: "unreviewed",
        whyInteresting: rationaleText(rationale["whyInteresting"]),
        risks: rationaleText(rationale["risks"]),
        unknowns: rationaleText(rationale["unknowns"]),
        evidenceUrls: [] as string[],
        companyId:
          typeof r["company_id"] === "string"
            ? (r["company_id"] as string)
            : null,
        signalId: null,
        candidateId:
          typeof r["candidate_id"] === "string"
            ? (r["candidate_id"] as string)
            : null,
      } satisfies UnifiedTargetRow,
    ];
  });
}

export function mapEnsembleProjectionTier(
  decision: string | null,
  promotionStatus: "ready" | "diligence_hold" | "excluded",
  hasSupportedProductFit: boolean,
): "high_interest" | "evaluate" | "needs_research" {
  if (decision === "high_priority") {
    return promotionStatus === "ready" ? "high_interest" : "evaluate";
  }
  return hasSupportedProductFit ? "evaluate" : "needs_research";
}

async function loadEnsemble(
  query: (
    text: string,
    params: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>,
  expectedReviewInputContract: ExpectedFaaReviewInputContract,
): Promise<UnifiedTargetRow[]> {
  const { rows } = await query(
    `SELECT st.signal_id, r.final_decision, r.final_confidence, r.reason,
            r.muse_evaluation_id,
            st.research_evidence,
            jev.decision AS jev_decision,
            jev.disqualifiers AS jev_disqualifiers,
            jev.missing_evidence AS jev_missing_evidence,
            muse.decision AS muse_decision,
            muse.disqualifiers AS muse_disqualifiers,
            muse.missing_evidence AS muse_missing_evidence,
            s.raw_name, s.source_payload
     FROM signal_review_state st
     JOIN source_signals s ON s.id = st.signal_id
     JOIN faa_ensemble_evaluations jev
       ON jev.id = st.jev_evaluation_id
      AND jev.signal_id = st.signal_id
      AND jev.input_hash = st.input_hash
      AND jev.error IS NULL
      AND jev.decision IS NOT NULL
     LEFT JOIN faa_ensemble_results r
       ON r.signal_id = st.signal_id
      AND r.input_hash = st.input_hash
      AND r.jev_evaluation_id = st.jev_evaluation_id
     LEFT JOIN faa_ensemble_evaluations muse
       ON muse.id = r.muse_evaluation_id
      AND muse.signal_id = st.signal_id
      AND muse.input_hash = st.input_hash
      AND muse.error IS NULL
      AND muse.decision IS NOT NULL
     WHERE st.phase = 'settled'
       AND st.input_hash IS NOT NULL
       AND st.source_revision = s.review_revision
       AND st.input_manifest->'sourceRevision' = to_jsonb(st.source_revision)
       AND st.input_manifest->>'version' = $1
       AND st.input_manifest->'policy'->>'ladder' = $2
       AND st.input_manifest->'policy'->>'jevModel' = $3
       AND st.input_manifest->'policy'->>'museModel' = $4
       AND st.input_manifest->'policy'->>'evaluatorPrompt' = $5
       AND st.input_manifest->'policy'->>'analyst' = $6
       AND jev.decision IN ('research', 'high_priority')`,
    [
      expectedReviewInputContract.version,
      expectedReviewInputContract.policy.ladder,
      expectedReviewInputContract.policy.jevModel,
      expectedReviewInputContract.policy.museModel,
      expectedReviewInputContract.policy.evaluatorPrompt,
      expectedReviewInputContract.policy.analyst,
    ],
  );
  return rows.flatMap((r) => {
    const name = String(r["raw_name"] ?? "").trim();
    const signalId =
      typeof r["signal_id"] === "string" ? (r["signal_id"] as string) : null;
    if (name === "" || signalId === null) return [];
    const finalDecision =
      typeof r["final_decision"] === "string"
        ? (r["final_decision"] as string)
        : null;
    const jevDecision =
      typeof r["jev_decision"] === "string"
        ? (r["jev_decision"] as string)
        : null;
    const museDecision =
      typeof r["muse_decision"] === "string"
        ? (r["muse_decision"] as string)
        : null;
    const hasMuseResult =
      finalDecision !== null &&
      museDecision !== null &&
      typeof r["muse_evaluation_id"] === "string";
    const decision = hasMuseResult ? finalDecision : jevDecision;
    const asStringList = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.filter(
            (item): item is string =>
              typeof item === "string" && item.trim() !== "",
          )
        : [];
    const jevDisqualifiers = asStringList(r["jev_disqualifiers"]);
    const museDisqualifiers = asStringList(r["muse_disqualifiers"]);
    const researchEvidence = parseSignalResearchEvidence(
      r["research_evidence"],
    );
    const promotion = assessPromotionEvidence({
      finalDecision: hasMuseResult ? finalDecision : null,
      jevDecision,
      museDecision,
      researchEvidence: r["research_evidence"],
      jevDisqualifiers,
      museDisqualifiers,
    });
    const evidenceRefs = researchEvidence.evidenceRefs ?? [];
    const revenueIndicatorIds = (
      researchEvidence.size?.indicators ?? []
    ).flatMap((indicator) =>
      indicator.kind === "revenue" && indicator.evidenceId !== undefined
        ? [indicator.evidenceId]
        : [],
    );
    const sizeSupported = hasResearchSupportEvidence(
      revenueIndicatorIds,
      "size",
      evidenceRefs,
    );
    const sizeAssessment = sizeSupported
      ? researchEvidence.size?.assessment
      : "unknown";
    // Evidence supports promotion assessment but cannot create human facts.
    const namedProductIds = new Set(
      researchEvidence.website?.namedProductEvidenceIds ?? [],
    );
    const hasProductProof = evidenceRefs.some(
      (ref) =>
        ref.role === "support" &&
        ref.firstParty === true &&
        ref.stage === "website" &&
        ref.evidenceId !== undefined &&
        namedProductIds.has(ref.evidenceId),
    );
    const hasSupportedProductFit =
      promotion.verifiedDomain !== null && hasProductProof;
    const missing = [
      ...(researchEvidence.missingFacts ?? []),
      ...asStringList(r["jev_missing_evidence"]),
      ...asStringList(r["muse_missing_evidence"]),
      ...promotion.reasons,
    ];
    const disqualifiers = [...jevDisqualifiers, ...museDisqualifiers];
    const evidenceUrls = (researchEvidence.evidenceRefs ?? []).flatMap((ref) =>
      ref.url === undefined ? [] : [ref.url],
    );
    const payload = (r["source_payload"] ?? {}) as Record<string, unknown>;
    const guidUrl =
      typeof payload["guid_url"] === "string" && payload["guid_url"] !== ""
        ? (payload["guid_url"] as string)
        : typeof payload["guidUrl"] === "string" && payload["guidUrl"] !== ""
          ? (payload["guidUrl"] as string)
          : null;
    if (guidUrl !== null) evidenceUrls.push(guidUrl);
    const hq = researchEvidence.headquarters;
    const hqSupportedByEvidence = hasResearchSupportEvidence(
      hq?.supportEvidenceIds ?? [],
      "hq",
      evidenceRefs,
    );
    const supportedHq = hq?.status === "supported" && hqSupportedByEvidence;
    const confidenceValue = hasMuseResult ? r["final_confidence"] : null;
    const conf =
      typeof confidenceValue === "number"
        ? confidenceValue
        : typeof confidenceValue === "string" && confidenceValue.trim() !== ""
          ? Number(confidenceValue)
          : Number.NaN;
    const reason =
      hasMuseResult &&
      typeof r["reason"] === "string" &&
      r["reason"].trim() !== ""
        ? (r["reason"] as string).trim()
        : null;
    const tier = mapEnsembleProjectionTier(
      decision,
      promotion.status,
      hasSupportedProductFit,
    );
    return [
      {
        companyName: name,
        domain: promotion.verifiedDomain,
        websiteUrl:
          promotion.verifiedDomain === null
            ? null
            : `https://${promotion.verifiedDomain}`,
        city: supportedHq ? (hq.city ?? null) : null,
        stateCode: supportedHq ? (hq.state ?? null) : null,
        countryCode: supportedHq ? (hq.country ?? null) : null,
        origin: ORIGIN_FAA_ENSEMBLE,
        goldenV1Member: false,
        tier,
        investorPriority:
          promotion.status === "ready" ? 1 : tier === "evaluate" ? 2 : 3,
        proprietaryBasis: hasProductProof ? "product" : "unknown",
        oversizeFlag: sizeAssessment === "over_50m",
        pipelineStatus: hasMuseResult ? promotion.status : "jev_complete",
        fit: null,
        novelty: null,
        confidence: null,
        actionability: null,
        ensembleDecision: decision,
        ensembleConfidence: Number.isFinite(conf) ? conf : null,
        ownershipStatus: "unknown",
        pipelineDecision: "unreviewed",
        whyInteresting: reason,
        risks:
          disqualifiers.length === 0
            ? null
            : [...new Set(disqualifiers)].join("; "),
        unknowns:
          missing.length === 0 ? null : [...new Set(missing)].join("; "),
        evidenceUrls: [...new Set(evidenceUrls)],
        companyId: null,
        signalId,
        candidateId: null,
      } satisfies UnifiedTargetRow,
    ];
  });
}

// ---------------------------------------------------------------------------
// Library entry point
// ---------------------------------------------------------------------------

/** Default curated CSV location (repo root), mirroring the CLI default. */
export const DEFAULT_CURATED_CSV_PATH = path.join(
  "exports",
  "curated-aerospace-targets-evidence.csv",
);

export function parsePopulateArgs(argv: readonly string[]): {
  curatedPath: string;
} {
  let curatedPath = DEFAULT_CURATED_CSV_PATH;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--curated" && i + 1 < argv.length) {
      curatedPath = argv[i + 1]!;
      i++;
    }
  }
  return { curatedPath };
}

export interface PopulateUnifiedTargetsOptions {
  /** Exact current model/prompt/policy contract. */
  expectedReviewInputContract: ExpectedFaaReviewInputContract;
  /** Curated CSV path; defaults to `exports/curated-aerospace-targets-evidence.csv`. */
  curatedCsvPath?: string;
}

export type PopulateSourceKey =
  | typeof ORIGIN_GOLDEN_V1
  | typeof ORIGIN_CURATED
  | typeof ORIGIN_DISCOVERY
  | typeof ORIGIN_FAA_ENSEMBLE;

/**
 * Run the full refresh. Only attributable stale ensemble assessments are
 * invalidated before reference, curated, candidate, and current-review replay.
 * Durable identity, evidence, membership, and human facts remain unchanged,
 * and the same entrypoint is idempotent on retry.
 */
export async function populateUnifiedTargets(
  db: QueryableDb,
  opts: PopulateUnifiedTargetsOptions,
): Promise<Record<PopulateSourceKey, SourceCounts>> {
  const expectedReviewInputContract = opts?.expectedReviewInputContract;
  if (expectedReviewInputContract === undefined) {
    throw new TypeError(
      "populateUnifiedTargets requires expectedReviewInputContract",
    );
  }
  const query = queryFnFor(db);
  const curatedPath = opts.curatedCsvPath ?? DEFAULT_CURATED_CSV_PATH;
  const reconciliation = await reconcileUnifiedTargetMachineProjections(
    db,
    expectedReviewInputContract,
  );
  const goldenV1 = await upsertBatch(query, await loadGolden(query));
  const curated = await upsertBatch(
    query,
    existsSync(curatedPath) ? loadCurated(curatedPath) : [],
  );
  const discovery = await upsertBatch(query, await loadDiscovery(query));
  const faaEnsemble = await upsertBatch(
    query,
    await loadEnsemble(query, expectedReviewInputContract),
  );
  return {
    [ORIGIN_GOLDEN_V1]: goldenV1,
    [ORIGIN_CURATED]: curated,
    [ORIGIN_DISCOVERY]: discovery,
    [ORIGIN_FAA_ENSEMBLE]: { ...faaEnsemble, reconciliation },
  };
}
