/**
 * Export the `unified_targets` acquisition-target table (migration 0008) to
 * CSV or JSON for the updated golden-set / target feed.
 *
 * Library entry point: `exportUnifiedTargets(db, format, tier?, context?)`.
 * CLI lives in `scripts/export-unified-targets.mts` (thin wrapper).
 */
import path from "node:path";
import process from "node:process";

import { queryFnFor, type QueryableDb } from "./populate.js";
import {
  AUTHORITATIVE_PRE_JEV_SNAPSHOT_KEYS,
  assessPromotionEvidence,
  hasCurrentReviewLinkage,
  isCurrentReviewLinkage,
  isOriginalBooieListName,
  matchesExpectedReviewInputContract,
  normalizeTargetDomain,
  parseSignalResearchEvidence,
  reviewInputManifestMatchesSourceRevision,
  type ExpectedFaaReviewInputContract,
} from "./records.js";
export type { ExpectedFaaReviewInputContract } from "./records.js";

// ---------------------------------------------------------------------------
// Contract: human-readable CSV headers + tier set (mirror migration 0008)
// ---------------------------------------------------------------------------

export const UNIFIED_CSV_HEADERS = [
  "Company Name",
  "Domain",
  "Website",
  "City",
  "State",
  "Country",
  "Tier",
  "Priority",
  "Oversize Flag",
  "Proprietary Basis",
  "Origins",
  "Golden v1",
  "Pipeline Status",
  "Ownership Status",
  "Pipeline Decision",
  "Fit",
  "Novelty",
  "Confidence",
  "Actionability",
  "Ensemble Decision",
  "Ensemble Confidence",
  "Why Interesting",
  "Risks",
  "Unknowns",
  "Evidence URLs",
  "Review Phase",
  "Review Status",
  "Review Input Hash",
  "Jev Decision",
  "Muse Decision",
  "Models Agree",
  "Promotion Status",
  "Promotion Holds",
  "Research Missing Facts",
  "Pre-JEv Membership",
  "Membership Match Basis",
  "Membership Provenance",
  "Possible Identity Match",
  "Membership Coverage Disclosure",
  "Original Booie List Presence",
  "Original Booie List Source",
] as const;

export const UNIFIED_TIERS = [
  "reference",
  "high_interest",
  "evaluate",
  "needs_research",
] as const;

export type UnifiedExportFormat = "csv" | "json";

export interface ExportUnifiedTargetsOptions {
  readonly format: UnifiedExportFormat;
  readonly tier: string | null;
  readonly out: string;
}

export interface ExportUnifiedTargetsContext {
  readonly expectedReviewInputContract: ExpectedFaaReviewInputContract | null;
}

/** YYYYMMDD stamp for the default --out filename. */
export function dateStamp(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

export function defaultExportPath(format: UnifiedExportFormat): string {
  const ext = format === "json" ? "json" : "csv";
  return path.join("exports", `unified-targets-${dateStamp()}.${ext}`);
}

export function parseExportArgs(
  argv: readonly string[],
): ExportUnifiedTargetsOptions {
  let format: UnifiedExportFormat = "csv";
  let tier: string | null = null;
  let out: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--format" && i + 1 < argv.length) {
      const value = argv[++i]!.trim().toLowerCase();
      if (value !== "csv" && value !== "json") {
        throw new Error(`--format must be csv|json (got "${argv[i]}")`);
      }
      format = value;
    } else if (arg === "--tier" && i + 1 < argv.length) {
      const value = argv[++i]!.trim().toLowerCase();
      if (!(UNIFIED_TIERS as readonly string[]).includes(value)) {
        throw new Error(
          `--tier must be one of ${(UNIFIED_TIERS as readonly string[]).join("|")} (got "${argv[i]}")`,
        );
      }
      tier = value;
    } else if (arg === "--out" && i + 1 < argv.length) {
      out = argv[++i]!;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: export-unified-targets.mts [--format csv|json] [--tier TIER] [--out PATH]",
      );
      process.exit(0);
    }
  }
  return { format, tier, out: out ?? defaultExportPath(format) };
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

const UNIFIED_TARGET_COLUMNS = [
  "company_name",
  "domain",
  "website_url",
  "city",
  "state_code",
  "country_code",
  "tier",
  "investor_priority",
  "oversize_flag",
  "proprietary_basis",
  "origins",
  "golden_v1_member",
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
] as const;

const EXPORT_COLUMNS = [
  ...UNIFIED_TARGET_COLUMNS,
  "review_phase",
  "review_status",
  "review_input_hash",
  "jev_decision",
  "muse_decision",
  "models_agree",
  "promotion_status",
  "promotion_holds",
  "research_missing_facts",
  "pre_jev_membership",
  "membership_match_basis",
  "membership_provenance",
  "possible_identity_match",
  "membership_coverage_disclosure",
  "original_booie_list_presence",
  "original_booie_list_source",
] as const;

function joinList(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const items = (value as unknown[])
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v !== "");
  return items.length === 0 ? null : items.join("; ");
}

function cellText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value === "" ? null : value;
  if (typeof value === "number" || typeof value === "boolean") {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

/** Map one `unified_targets` row to the human-readable CSV record. */
export function toCsvRecord(
  row: Record<string, unknown>,
): Record<string, string> {
  const cells: Record<string, string | null> = {
    "Company Name": cellText(row["company_name"]),
    Domain: cellText(row["domain"]),
    Website: cellText(row["website_url"]),
    City: cellText(row["city"]),
    State: cellText(row["state_code"]),
    Country: cellText(row["country_code"]),
    Tier: cellText(row["tier"]),
    Priority: cellText(row["investor_priority"]),
    "Oversize Flag": row["oversize_flag"] === true ? "yes" : "no",
    "Proprietary Basis": cellText(row["proprietary_basis"]),
    Origins: joinList(row["origins"]),
    "Golden v1": row["golden_v1_member"] === true ? "yes" : "no",
    "Pipeline Status": cellText(row["pipeline_status"]),
    "Ownership Status": cellText(row["ownership_status"]),
    "Pipeline Decision": cellText(row["pipeline_decision"]),
    Fit: cellText(row["fit"]),
    Novelty: cellText(row["novelty"]),
    Confidence: cellText(row["confidence"]),
    Actionability: cellText(row["actionability"]),
    "Ensemble Decision": cellText(row["ensemble_decision"]),
    "Ensemble Confidence": cellText(row["ensemble_confidence"]),
    "Why Interesting": cellText(row["why_interesting"]),
    Risks: cellText(row["risks"]),
    Unknowns: cellText(row["unknowns"]),
    "Evidence URLs": joinList(row["evidence_urls"]),
    "Review Phase": cellText(row["review_phase"]),
    "Review Status": cellText(row["review_status"]),
    "Review Input Hash": cellText(row["review_input_hash"]),
    "Jev Decision": cellText(row["jev_decision"]),
    "Muse Decision": cellText(row["muse_decision"]),
    "Models Agree":
      row["models_agree"] === true
        ? "yes"
        : row["models_agree"] === false
          ? "no"
          : "",
    "Promotion Status": cellText(row["promotion_status"]),
    "Promotion Holds": joinList(row["promotion_holds"]),
    "Research Missing Facts": joinList(row["research_missing_facts"]),
    "Pre-JEv Membership": row["pre_jev_membership"] === true ? "yes" : "no",
    "Membership Match Basis": joinList(row["membership_match_basis"]),
    "Membership Provenance": joinList(row["membership_provenance"]),
    "Possible Identity Match":
      row["possible_identity_match"] === true ? "yes" : "no",
    "Membership Coverage Disclosure": cellText(
      row["membership_coverage_disclosure"],
    ),
    "Original Booie List Presence":
      row["original_booie_list_presence"] === true ? "yes" : "no",
    "Original Booie List Source": cellText(row["original_booie_list_source"]),
  };
  return Object.fromEntries(
    UNIFIED_CSV_HEADERS.map((h) => [h, cells[h] ?? ""]),
  ) as Record<string, string>;
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
  return value;
}

export function stringifyUnifiedCsv(
  rows: readonly Record<string, unknown>[],
): string {
  const lines = [UNIFIED_CSV_HEADERS.map(csvEscape).join(",")];
  for (const row of rows) {
    const record = toCsvRecord(row);
    lines.push(UNIFIED_CSV_HEADERS.map((h) => csvEscape(record[h]!)).join(","));
  }
  return `${lines.join("\n")}\n`;
}

interface MembershipProjection {
  snapshotKey?: string;
  sourceRow?: number;
  contentSha256?: string;
  rawName?: string;
  rawDomain?: string;
  matchBasis?: string;
}

function membershipRows(value: unknown): MembershipProjection[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    typeof item === "object" && item !== null && !Array.isArray(item)
      ? [item as MembershipProjection]
      : [],
  );
}

const IDENTITY_CONFLICT_REASON =
  "verified identity domain conflicts with the target, source, or linked company";

function hasIdentityDomainConflict(
  row: Record<string, unknown>,
  verifiedDomain: string,
): boolean {
  for (const value of [row["domain"], row["source_raw_domain"]]) {
    if (typeof value !== "string") continue;
    const normalized = normalizeTargetDomain(value);
    if (normalized !== null && normalized !== verifiedDomain) return true;
  }
  const knownCompanyDomains = row["known_company_domains"];
  return (
    Array.isArray(knownCompanyDomains) &&
    knownCompanyDomains.some((value) => {
      if (typeof value !== "string") return false;
      const normalized = normalizeTargetDomain(value);
      return normalized !== null && normalized !== verifiedDomain;
    })
  );
}

/**
 * Add review and provenance semantics to one database row. Exported as a pure
 * behavior seam so report consumers cannot silently relabel stale reviews.
 */
export function enrichUnifiedExportRow(
  row: Record<string, unknown>,
  context?: ExportUnifiedTargetsContext,
): Record<string, unknown> {
  const text = (key: string): string | null => {
    const value = row[key];
    return typeof value === "string" && value.trim() !== ""
      ? value.trim()
      : null;
  };
  const revision = (key: string): number | null => {
    const value = row[key];
    if (typeof value === "number" && Number.isInteger(value)) return value;
    if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  };
  const linkage = {
    phase: text("review_phase"),
    stateInputHash: text("review_input_hash"),
    stateJevEvaluationId: text("state_jev_evaluation_id"),
    stateSourceRevision: revision("state_source_revision"),
    signalSourceRevision: revision("signal_source_revision"),
    inputManifest: row["review_input_manifest"],
    resultInputHash: text("result_input_hash"),
    resultJevEvaluationId: text("result_jev_evaluation_id"),
    resultMuseEvaluationId: text("result_muse_evaluation_id"),
    signalId: text("signal_id"),
    jev: {
      id: text("jev_evaluation_id"),
      signalId: text("jev_signal_id"),
      inputHash: text("jev_input_hash"),
      decision: text("jev_decision"),
      error: text("jev_error"),
    },
    muse: {
      id: text("muse_evaluation_id"),
      signalId: text("muse_signal_id"),
      inputHash: text("muse_input_hash"),
      decision: text("muse_decision"),
      error: text("muse_error"),
    },
  };
  const expectedContract = context?.expectedReviewInputContract ?? null;
  const storedLinkageCurrent = hasCurrentReviewLinkage(linkage);
  const current = isCurrentReviewLinkage(linkage, expectedContract);
  const contractCurrent = matchesExpectedReviewInputContract(
    linkage.inputManifest,
    expectedContract,
  );
  const currentJevLinkage =
    linkage.phase === "settled" &&
    linkage.stateInputHash !== null &&
    linkage.signalId !== null &&
    linkage.stateSourceRevision !== null &&
    linkage.signalSourceRevision !== null &&
    linkage.stateSourceRevision === linkage.signalSourceRevision &&
    reviewInputManifestMatchesSourceRevision(
      linkage.inputManifest,
      linkage.stateSourceRevision,
    ) &&
    linkage.stateJevEvaluationId !== null &&
    linkage.jev.id === linkage.stateJevEvaluationId &&
    linkage.jev.signalId === linkage.signalId &&
    linkage.jev.inputHash === linkage.stateInputHash &&
    linkage.jev.error === null &&
    linkage.jev.decision !== null;
  const currentJev = currentJevLinkage && contractCurrent;
  const research = parseSignalResearchEvidence(row["research_evidence"]);
  const assessment = assessPromotionEvidence({
    finalDecision: current ? text("result_final_decision") : null,
    jevDecision: current ? linkage.jev.decision : null,
    museDecision: current ? linkage.muse.decision : null,
    researchEvidence: row["research_evidence"],
    jevDisqualifiers: Array.isArray(row["jev_disqualifiers"])
      ? (row["jev_disqualifiers"] as unknown[]).filter(
          (item): item is string => typeof item === "string",
        )
      : [],
    museDisqualifiers: Array.isArray(row["muse_disqualifiers"])
      ? (row["muse_disqualifiers"] as unknown[]).filter(
          (item): item is string => typeof item === "string",
        )
      : [],
  });
  const identityConflict =
    assessment.status === "ready" &&
    assessment.verifiedDomain !== null &&
    hasIdentityDomainConflict(row, assessment.verifiedDomain);
  const promotionAssessment = identityConflict
    ? {
        status: "diligence_hold" as const,
        reasons: [IDENTITY_CONFLICT_REASON],
      }
    : assessment;
  const memberships = membershipRows(row["memberships"]);
  const possibleMatches = membershipRows(row["possible_memberships"]);
  const companyName = text("company_name") ?? "";
  const originalBooiePresence =
    isOriginalBooieListName(companyName) &&
    memberships.some(
      (member) => member.snapshotKey === "booie-original29-2026-09-09",
    );
  const hasCurrentStoredReview = storedLinkageCurrent || currentJevLinkage;
  const reviewStatus = current
    ? "current_complete"
    : currentJev
      ? "current_jev_complete"
      : hasCurrentStoredReview && expectedContract === null
        ? "current_policy_unverified"
        : hasCurrentStoredReview
          ? "stale_or_incompatible"
          : linkage.phase === null
            ? "not_started"
            : linkage.stateInputHash === null
              ? "legacy_unlinked"
              : linkage.phase === "settled"
                ? "stale_or_incomplete"
                : `in_${linkage.phase}`;
  const promotionStatus = current
    ? text("result_final_decision") === "high_priority"
      ? promotionAssessment.status
      : assessment.status === "excluded"
        ? "excluded"
        : "not_eligible"
    : "not_current";
  return {
    ...row,
    review_status: reviewStatus,
    models_agree:
      current && linkage.jev.decision !== null && linkage.muse.decision !== null
        ? linkage.jev.decision === linkage.muse.decision
        : null,
    promotion_status: promotionStatus,
    promotion_holds: promotionAssessment.reasons,
    research_missing_facts: [...(research.missingFacts ?? [])],
    pre_jev_membership: memberships.length > 0,
    membership_match_basis: [
      ...new Set(
        memberships.flatMap((member) =>
          member.matchBasis === undefined ? [] : [member.matchBasis],
        ),
      ),
    ],
    membership_provenance: memberships.map((member) => {
      const rowPart =
        member.sourceRow === undefined ? "" : ` row ${member.sourceRow}`;
      const hashPart =
        member.contentSha256 === undefined
          ? ""
          : ` sha256:${member.contentSha256}`;
      return `${member.snapshotKey ?? "unknown snapshot"}${rowPart} (${member.matchBasis ?? "unknown basis"})${hashPart}`;
    }),
    possible_identity_match: possibleMatches.length > 0,
    membership_coverage_disclosure:
      "Membership reflects the available historical snapshots identified in provenance. Sampled lists are not complete-source coverage, and absence is not proof of novelty.",
    original_booie_list_presence: originalBooiePresence,
    original_booie_list_source: originalBooiePresence
      ? "booie-original29-2026-09-09 (exact original-name membership; report-only)"
      : null,
  };
}

// ---------------------------------------------------------------------------
// Library entry point
// ---------------------------------------------------------------------------

/**
 * Export target facts alongside independently-labelled review and prior-list
 * provenance. Membership never changes the review or promotion status.
 * Current-policy labels require an explicit expected input contract; omitting
 * it keeps exports read-only and reports stored work as policy-unverified.
 */
export async function exportUnifiedTargets(
  db: QueryableDb,
  format: UnifiedExportFormat,
  tier?: string | null,
  context?: ExportUnifiedTargetsContext,
): Promise<string> {
  const query = queryFnFor(db);
  const where = tier === undefined || tier === null ? "" : "WHERE ut.tier = $2";
  const params: unknown[] = [AUTHORITATIVE_PRE_JEV_SNAPSHOT_KEYS];
  if (tier !== undefined && tier !== null) params.push(tier);
  const targetColumns = UNIFIED_TARGET_COLUMNS.map(
    (column) => `ut.${column}`,
  ).join(", ");
  const { rows } = await query(
    `SELECT ${targetColumns},
            ut.signal_id,
            st.phase AS review_phase,
            st.input_hash AS review_input_hash,
            st.input_manifest AS review_input_manifest,
            st.source_revision AS state_source_revision,
            s.review_revision AS signal_source_revision,
            st.jev_evaluation_id AS state_jev_evaluation_id,
            s.raw_domain AS source_raw_domain,
            (
              SELECT array_agg(domain.domain)
              FROM company_domains domain
              WHERE domain.company_id = s.company_id
            ) AS known_company_domains,
            st.research_evidence,
            r.input_hash AS result_input_hash,
            r.jev_evaluation_id AS result_jev_evaluation_id,
            r.muse_evaluation_id AS result_muse_evaluation_id,
            r.final_decision AS result_final_decision,
            jev.id AS jev_evaluation_id,
            jev.signal_id AS jev_signal_id,
            jev.input_hash AS jev_input_hash,
            jev.decision AS jev_decision,
            jev.error AS jev_error,
            jev.disqualifiers AS jev_disqualifiers,
            muse.id AS muse_evaluation_id,
            muse.signal_id AS muse_signal_id,
            muse.input_hash AS muse_input_hash,
            muse.decision AS muse_decision,
            muse.error AS muse_error,
            muse.disqualifiers AS muse_disqualifiers,
            exact_members.memberships,
            possible_members.possible_memberships
     FROM unified_targets ut
     LEFT JOIN signal_review_state st ON st.signal_id = ut.signal_id
     LEFT JOIN source_signals s ON s.id = ut.signal_id
     LEFT JOIN faa_ensemble_results r
       ON r.signal_id = ut.signal_id
      AND st.source_revision = s.review_revision
      AND st.input_manifest->'sourceRevision' = to_jsonb(st.source_revision)
      AND r.input_hash = st.input_hash
      AND r.jev_evaluation_id = st.jev_evaluation_id
     LEFT JOIN faa_ensemble_evaluations jev
       ON jev.id = st.jev_evaluation_id
      AND st.source_revision = s.review_revision
      AND st.input_manifest->'sourceRevision' = to_jsonb(st.source_revision)
      AND jev.signal_id = ut.signal_id
      AND jev.input_hash = st.input_hash
     LEFT JOIN faa_ensemble_evaluations muse
       ON muse.id = r.muse_evaluation_id
      AND muse.signal_id = ut.signal_id
      AND muse.input_hash = st.input_hash
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(
         jsonb_build_object(
           'snapshotKey', snapshot.key,
           'sourceRow', member.source_row,
           'contentSha256', snapshot.content_sha256,
           'rawName', member.raw_name,
           'rawDomain', member.raw_domain,
           'matchBasis', CASE
             WHEN member.normalized_domain IS NOT NULL THEN 'exact_domain'
             ELSE 'exact_name'
           END
         )
         ORDER BY snapshot.key, member.source_row
       ) AS memberships
       FROM known_universe_snapshots snapshot
       JOIN known_universe_members member
         ON member.snapshot_id = snapshot.id
       WHERE snapshot.active = true
         AND snapshot.key = ANY($1::text[])
         AND (
           (
             member.normalized_domain IS NOT NULL
             AND ut.domain IS NOT NULL
             AND lower(regexp_replace(rtrim(member.normalized_domain, '.'), '^www\\.', '', 'i'))
               = lower(regexp_replace(rtrim(ut.domain, '.'), '^www\\.', '', 'i'))
           )
           OR (
             member.normalized_domain IS NULL
             AND member.normalized_name IS NOT NULL
             AND lower(member.normalized_name) = lower(ut.normalized_name)
           )
         )
     ) exact_members ON true
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(
         jsonb_build_object(
           'snapshotKey', snapshot.key,
           'sourceRow', member.source_row,
           'contentSha256', snapshot.content_sha256,
           'rawName', member.raw_name,
           'rawDomain', member.raw_domain
         )
         ORDER BY snapshot.key, member.source_row
       ) AS possible_memberships
       FROM known_universe_snapshots snapshot
       JOIN known_universe_members member
         ON member.snapshot_id = snapshot.id
       WHERE snapshot.active = true
         AND snapshot.key = ANY($1::text[])
         AND member.normalized_domain IS NOT NULL
         AND member.normalized_name IS NOT NULL
         AND lower(member.normalized_name) = lower(ut.normalized_name)
         AND (
           ut.domain IS NULL
           OR lower(regexp_replace(rtrim(member.normalized_domain, '.'), '^www\\.', '', 'i'))
             <> lower(regexp_replace(rtrim(ut.domain, '.'), '^www\\.', '', 'i'))
         )
     ) possible_members ON true
     ${where}
     ORDER BY ut.company_name`,
    params,
  );
  const projected = rows
    .map((row) => enrichUnifiedExportRow(row, context))
    .map((row) =>
      Object.fromEntries(EXPORT_COLUMNS.map((column) => [column, row[column]])),
    );
  if (format === "json") return `${JSON.stringify(projected, null, 2)}\n`;
  return stringifyUnifiedCsv(projected);
}
