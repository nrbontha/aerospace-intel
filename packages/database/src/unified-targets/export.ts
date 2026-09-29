/**
 * Export the `unified_targets` acquisition-target table (migration 0008) to
 * CSV or JSON for the updated golden-set / target feed.
 *
 * Library entry point: `exportUnifiedTargets(db, format, tier?, context?)`.
 * CLI lives in `scripts/export-unified-targets.mts` (thin wrapper).
 */
import path from "node:path";
import process from "node:process";

import { PgDialect } from "drizzle-orm/pg-core";

import {
  investorRankingSql,
  normalizeSignalOverviewQuery,
  UNSCORED_INVESTOR_RANKING,
  type InvestorRanking,
  type SignalOverviewReadiness,
  type SignalOverviewSort,
} from "../investor-ranking.js";

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
  "Investor Ranking Score",
  "Investor Ranking Status",
  "Investor Ranking Readiness",
  "Investor Ranking Policy",
  "Investor Ranking Breakdown",
  "Investor Ranking Blockers",
  "Investor Ranking Updated At",
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
  "Triage Current",
  "Jev Triage Version",
  "Product Fit",
  "Acquisition Readiness",
  "Research Priority",
  "Triage Reason Codes",
  "Triage Explanation",
  "Research Gaps",
  "Analyst Case ID",
  "Analyst Case Status",
  "Analyst Episode Current",
  "Analyst Proof Current",
  "Analyst Memo Current",
  "Analyst Input Hash",
  "Analyst Retry At",
  "Analyst Stop Reason",
] as const;

export const SOURCE_SIGNAL_CSV_HEADERS = [
  "Signal ID",
  "Created At",
  "Source Key",
  "Source Locator",
  "Source Fingerprint",
  "Raw Name",
  "Raw Domain",
  "UEI",
  "CAGE",
  "City",
  "State",
  "Country",
  "Award Count",
  "Award Value",
  "Freshest Award",
  "Signal Status",
  "Review Revision",
  "Lead ID",
  "Company ID",
  "Investor Ranking Score",
  "Investor Ranking Status",
  "Investor Ranking Readiness",
  "Investor Ranking Policy",
  "Investor Ranking Breakdown",
  "Investor Ranking Blockers",
  "Investor Ranking Updated At",
  "Review Phase",
  "Review Input Hash",
  "Review Retry At",
  "Review Error",
  "Triage Current",
  "Jev Decision",
  "Jev Confidence",
  "Triage Version",
  "Product Fit",
  "Acquisition Readiness",
  "Research Priority",
  "Triage Reason Codes",
  "Triage Explanation",
  "Research Gaps",
  "Analyst Case ID",
  "Analyst Case Status",
  "Analyst Episode Current",
  "Analyst Proof Current",
  "Analyst Memo Current",
  "Analyst Input Hash",
  "Analyst Retry At",
  "Analyst Stop Reason",
  "Analyst Memo",
  "Analyst Step Count",
  "Provider Known Cost USD",
  "Provider Unknown Estimated Cost USD",
  "Provider Receipt Count",
  "Provider Unknown Receipt Count",
  "Model Known Cost USD",
  "Model Receipt Count",
  "Model Unknown Receipt Count",
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

export interface SourceSignalExportContext
  extends ExportUnifiedTargetsContext {
  readonly sort?: SignalOverviewSort;
  readonly q?: string;
  readonly readiness?: SignalOverviewReadiness;
}

export interface SourceSignalExportResult {
  readonly body: string;
  readonly rowCount: number;
}

const PG_DIALECT = new PgDialect();

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

const INVESTOR_RANKING_EXPORT_COLUMNS = ["readiness", "ranking"] as const;

const ANALYST_EXPORT_COLUMNS = [
  "triage_current",
  "jev_triage_version",
  "jev_product_fit",
  "jev_acquisition_readiness",
  "jev_research_priority",
  "jev_reason_codes",
  "jev_explanation",
  "jev_research_gaps",
  "analyst_case_id",
  "analyst_case_status",
  "analyst_episode_current",
  "analyst_proof_current",
  "analyst_memo_current",
  "analyst_input_hash",
  "analyst_next_attempt_at",
  "analyst_stop_reason",
] as const;

const EXPORT_COLUMNS = [
  ...UNIFIED_TARGET_COLUMNS,
  ...INVESTOR_RANKING_EXPORT_COLUMNS,
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
  ...ANALYST_EXPORT_COLUMNS,
] as const;

const SOURCE_SIGNAL_EXPORT_COLUMNS = [
  "signal_id",
  ...INVESTOR_RANKING_EXPORT_COLUMNS,
  "created_at",
  "source_key",
  "source_locator",
  "source_fingerprint",
  "raw_name",
  "raw_domain",
  "uei",
  "cage",
  "city",
  "state",
  "country",
  "award_count",
  "award_value",
  "freshest_award",
  "signal_status",
  "review_revision",
  "lead_id",
  "company_id",
  "qualification",
  "source_payload",
  "review_phase",
  "review_input_hash",
  "review_retry_at",
  "review_last_error",
  ...ANALYST_EXPORT_COLUMNS,
  "jev_decision",
  "jev_confidence",
  "analyst_memo",
  "analyst_step_count",
  "provider_known_cost_usd",
  "provider_unknown_estimated_cost_usd",
  "provider_receipt_count",
  "provider_unknown_receipt_count",
  "model_known_cost_usd",
  "model_receipt_count",
  "model_unknown_receipt_count",
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

function rankingForExport(row: Record<string, unknown>): InvestorRanking {
  const ranking = row["ranking"];
  return ranking !== null && typeof ranking === "object" && !Array.isArray(ranking)
    ? (ranking as unknown as InvestorRanking)
    : UNSCORED_INVESTOR_RANKING;
}

/** Map one `unified_targets` row to the human-readable CSV record. */
export function toCsvRecord(
  row: Record<string, unknown>,
): Record<string, string> {
  const ranking = rankingForExport(row);
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
    "Investor Ranking Score": cellText(ranking.score),
    "Investor Ranking Status": ranking.status,
    "Investor Ranking Readiness": cellText(row["readiness"]) ?? "unscored",
    "Investor Ranking Policy": ranking.policyVersion,
    "Investor Ranking Breakdown": cellText(ranking.breakdown),
    "Investor Ranking Blockers": joinList(ranking.blockers),
    "Investor Ranking Updated At": ranking.updatedAt,
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
    "Triage Current": row["triage_current"] === true ? "yes" : "no",
    "Jev Triage Version": cellText(row["jev_triage_version"]),
    "Product Fit": cellText(row["jev_product_fit"]),
    "Acquisition Readiness": cellText(row["jev_acquisition_readiness"]),
    "Research Priority": cellText(row["jev_research_priority"]),
    "Triage Reason Codes": joinList(row["jev_reason_codes"]),
    "Triage Explanation": cellText(row["jev_explanation"]),
    "Research Gaps": cellText(row["jev_research_gaps"]),
    "Analyst Case ID": cellText(row["analyst_case_id"]),
    "Analyst Case Status": cellText(row["analyst_case_status"]),
    "Analyst Episode Current":
      row["analyst_episode_current"] === true ? "yes" : "no",
    "Analyst Proof Current":
      row["analyst_proof_current"] === true ? "yes" : "no",
    "Analyst Memo Current":
      row["analyst_memo_current"] === true ? "yes" : "no",
    "Analyst Input Hash": cellText(row["analyst_input_hash"]),
    "Analyst Retry At": cellText(row["analyst_next_attempt_at"]),
    "Analyst Stop Reason": cellText(row["analyst_stop_reason"]),
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

function yesNo(value: unknown): string {
  return value === true ? "yes" : value === false ? "no" : "";
}

/** Map a raw source-signal analyst row without implying a canonical company. */
export function toSourceSignalCsvRecord(
  row: Record<string, unknown>,
): Record<string, string> {
  const ranking = rankingForExport(row);
  const cells: Record<string, string | null> = {
    "Signal ID": cellText(row["signal_id"]),
    "Created At": cellText(row["created_at"]),
    "Source Key": cellText(row["source_key"]),
    "Source Locator": cellText(row["source_locator"]),
    "Source Fingerprint": cellText(row["source_fingerprint"]),
    "Raw Name": cellText(row["raw_name"]),
    "Raw Domain": cellText(row["raw_domain"]),
    UEI: cellText(row["uei"]),
    CAGE: cellText(row["cage"]),
    City: cellText(row["city"]),
    State: cellText(row["state"]),
    Country: cellText(row["country"]),
    "Award Count": cellText(row["award_count"]),
    "Award Value": cellText(row["award_value"]),
    "Freshest Award": cellText(row["freshest_award"]),
    "Signal Status": cellText(row["signal_status"]),
    "Review Revision": cellText(row["review_revision"]),
    "Lead ID": cellText(row["lead_id"]),
    "Company ID": cellText(row["company_id"]),
    "Investor Ranking Score": cellText(ranking.score),
    "Investor Ranking Status": ranking.status,
    "Investor Ranking Readiness": cellText(row["readiness"]) ?? "unscored",
    "Investor Ranking Policy": ranking.policyVersion,
    "Investor Ranking Breakdown": cellText(ranking.breakdown),
    "Investor Ranking Blockers": joinList(ranking.blockers),
    "Investor Ranking Updated At": ranking.updatedAt,
    "Review Phase": cellText(row["review_phase"]),
    "Review Input Hash": cellText(row["review_input_hash"]),
    "Review Retry At": cellText(row["review_retry_at"]),
    "Review Error": cellText(row["review_last_error"]),
    "Triage Current": yesNo(row["triage_current"]),
    "Jev Decision": cellText(row["jev_decision"]),
    "Jev Confidence": cellText(row["jev_confidence"]),
    "Triage Version": cellText(row["jev_triage_version"]),
    "Product Fit": cellText(row["jev_product_fit"]),
    "Acquisition Readiness": cellText(row["jev_acquisition_readiness"]),
    "Research Priority": cellText(row["jev_research_priority"]),
    "Triage Reason Codes": joinList(row["jev_reason_codes"]),
    "Triage Explanation": cellText(row["jev_explanation"]),
    "Research Gaps": cellText(row["jev_research_gaps"]),
    "Analyst Case ID": cellText(row["analyst_case_id"]),
    "Analyst Case Status": cellText(row["analyst_case_status"]),
    "Analyst Episode Current": yesNo(row["analyst_episode_current"]),
    "Analyst Proof Current": yesNo(row["analyst_proof_current"]),
    "Analyst Memo Current": yesNo(row["analyst_memo_current"]),
    "Analyst Input Hash": cellText(row["analyst_input_hash"]),
    "Analyst Retry At": cellText(row["analyst_next_attempt_at"]),
    "Analyst Stop Reason": cellText(row["analyst_stop_reason"]),
    "Analyst Memo": cellText(row["analyst_memo"]),
    "Analyst Step Count": cellText(row["analyst_step_count"]),
    "Provider Known Cost USD": cellText(row["provider_known_cost_usd"]),
    "Provider Unknown Estimated Cost USD": cellText(
      row["provider_unknown_estimated_cost_usd"],
    ),
    "Provider Receipt Count": cellText(row["provider_receipt_count"]),
    "Provider Unknown Receipt Count": cellText(
      row["provider_unknown_receipt_count"],
    ),
    "Model Known Cost USD": cellText(row["model_known_cost_usd"]),
    "Model Receipt Count": cellText(row["model_receipt_count"]),
    "Model Unknown Receipt Count": cellText(row["model_unknown_receipt_count"]),
  };
  return Object.fromEntries(
    SOURCE_SIGNAL_CSV_HEADERS.map((header) => [header, cells[header] ?? ""]),
  ) as Record<string, string>;
}

export function stringifySourceSignalCsv(
  rows: readonly Record<string, unknown>[],
): string {
  const lines = [SOURCE_SIGNAL_CSV_HEADERS.map(csvEscape).join(",")];
  for (const row of rows) {
    const record = toSourceSignalCsvRecord(row);
    lines.push(
      SOURCE_SIGNAL_CSV_HEADERS.map((header) =>
        csvEscape(record[header]!),
      ).join(","),
    );
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

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function boundedMemoText(
  value: unknown,
  maximum: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    value.length <= maximum &&
    (allowEmpty || value.trim().length > 0)
  );
}

function validSignalAnalystMemo(value: unknown): Record<string, unknown> | null {
  const memo = objectValue(value);
  const summary = objectValue(memo?.["summary"]);
  if (
    memo === null ||
    summary === null ||
    !hasExactKeys(memo, [
      "version",
      "inputHash",
      "createdAt",
      "summary",
      "answers",
      "nextActions",
    ]) ||
    !hasExactKeys(summary, ["label", "text"]) ||
    memo["version"] !== "signal-analyst-memo-v1" ||
    typeof memo["inputHash"] !== "string" ||
    !/^[0-9a-f]{64}$/u.test(memo["inputHash"]) ||
    typeof memo["createdAt"] !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      memo["createdAt"],
    ) ||
    !Number.isFinite(Date.parse(memo["createdAt"])) ||
    summary["label"] !== "model_analysis" ||
    !boundedMemoText(summary["text"], 4_000) ||
    !Array.isArray(memo["answers"]) ||
    !memo["answers"].every((candidate) => {
      const answer = objectValue(candidate);
      return (
        answer !== null &&
        hasExactKeys(answer, [
          "gapId",
          "field",
          "status",
          "answer",
          "evidenceIds",
        ]) &&
        boundedMemoText(answer["gapId"], 256) &&
        boundedMemoText(answer["field"], 128) &&
        (answer["status"] === "answered" ||
          answer["status"] === "unresolved" ||
          answer["status"] === "conflicted") &&
        (answer["answer"] === null ||
          boundedMemoText(answer["answer"], 4_000, true)) &&
        Array.isArray(answer["evidenceIds"]) &&
        answer["evidenceIds"].length <= 64 &&
        answer["evidenceIds"].every((id) => boundedMemoText(id, 256))
      );
    }) ||
    !Array.isArray(memo["nextActions"]) ||
    memo["nextActions"].length > 32 ||
    !memo["nextActions"].every((action) =>
      boundedMemoText(action, 4_000),
    )
  ) {
    return null;
  }
  return memo;
}

function validJevTriage(value: unknown): Record<string, unknown> | null {
  const triage = objectValue(value);
  return triage?.["version"] === "jev-triage-v1" &&
    (triage["decision"] === "reject" ||
      triage["decision"] === "research" ||
      triage["decision"] === "high_priority") &&
    (triage["confidence"] === null ||
      (typeof triage["confidence"] === "number" &&
        Number.isFinite(triage["confidence"]))) &&
    (triage["productFit"] === "supported_product" ||
      triage["productFit"] === "plausible_supplier" ||
      triage["productFit"] === "process_or_service" ||
      triage["productFit"] === "unknown" ||
      triage["productFit"] === "outside_scope") &&
    (triage["acquisitionReadiness"] === "ready" ||
      triage["acquisitionReadiness"] === "needs_research" ||
      triage["acquisitionReadiness"] === "blocked") &&
    (triage["researchPriority"] === 1 ||
      triage["researchPriority"] === 2 ||
      triage["researchPriority"] === 3) &&
    Array.isArray(triage["reasonCodes"]) &&
    triage["reasonCodes"].every((code) => typeof code === "string") &&
    typeof triage["explanation"] === "string" &&
    Array.isArray(triage["observations"]) &&
    Array.isArray(triage["gaps"])
    ? triage
    : null;
}

function analystExportFields(
  row: Record<string, unknown>,
  expectedContract: ExpectedFaaReviewInputContract | null,
  triageCurrent: boolean,
  triage: Record<string, unknown> | null,
): Record<string, unknown> {
  const caseSourceRevision = Number(row["analyst_source_revision"]);
  const signalSourceRevision = Number(row["signal_source_revision"]);
  const analystInputHash =
    typeof row["analyst_input_hash"] === "string"
      ? row["analyst_input_hash"]
      : null;
  const reviewInputHash =
    typeof row["review_input_hash"] === "string"
      ? row["review_input_hash"]
      : null;
  const analystStatus =
    typeof row["analyst_case_status"] === "string"
      ? row["analyst_case_status"]
      : null;
  const analystEpisodeCurrent =
    expectedContract !== null &&
    Number.isInteger(caseSourceRevision) &&
    Number.isInteger(signalSourceRevision) &&
    caseSourceRevision === signalSourceRevision &&
    row["analyst_policy_version"] === expectedContract.policy.analyst &&
    analystStatus !== null &&
    analystStatus !== "superseded";
  const analystProofCurrent =
    analystEpisodeCurrent &&
    triageCurrent &&
    reviewInputHash !== null &&
    analystInputHash === reviewInputHash;
  const memo = validSignalAnalystMemo(row["analyst_memo"]);
  const memoCurrent =
    analystProofCurrent &&
    analystStatus === "completed" &&
    memo !== null &&
    memo["inputHash"] === reviewInputHash;
  return {
    triage_current: triageCurrent,
    jev_triage_version: triage?.["version"] ?? null,
    jev_product_fit: triage?.["productFit"] ?? null,
    jev_acquisition_readiness: triage?.["acquisitionReadiness"] ?? null,
    jev_research_priority: triage?.["researchPriority"] ?? null,
    jev_reason_codes: triage?.["reasonCodes"] ?? [],
    jev_explanation: triage?.["explanation"] ?? null,
    jev_research_gaps: triage?.["gaps"] ?? [],
    analyst_case_id: row["analyst_case_id"] ?? null,
    analyst_case_status: analystStatus,
    analyst_episode_current: analystEpisodeCurrent,
    analyst_proof_current: analystProofCurrent,
    analyst_memo_current: memoCurrent,
    analyst_input_hash: analystInputHash,
    analyst_next_attempt_at: row["analyst_next_attempt_at"] ?? null,
    analyst_stop_reason: row["analyst_stop_reason"] ?? null,
  };
}

/**
 * Label one raw source-signal row using the same proof chain as the analyst UI.
 * Historical case and memo payloads remain present but are never promoted by
 * a case-view flag alone.
 */
export function enrichSourceSignalExportRow(
  row: Record<string, unknown>,
  context?: ExportUnifiedTargetsContext,
): Record<string, unknown> {
  const expectedContract = context?.expectedReviewInputContract ?? null;
  const stateSourceRevision = row["state_source_revision"];
  const signalSourceRevision = row["signal_source_revision"];
  const triage = validJevTriage(row["jev_parsed"]);
  const triageCurrent =
    expectedContract !== null &&
    typeof stateSourceRevision === "number" &&
    Number.isInteger(stateSourceRevision) &&
    typeof signalSourceRevision === "number" &&
    Number.isInteger(signalSourceRevision) &&
    stateSourceRevision === signalSourceRevision &&
    (row["review_phase"] === "muse" || row["review_phase"] === "settled") &&
    typeof row["review_input_hash"] === "string" &&
    row["state_jev_evaluation_id"] === row["jev_evaluation_id"] &&
    row["signal_id"] === row["jev_signal_id"] &&
    row["review_input_hash"] === row["jev_input_hash"] &&
    row["jev_model_id"] === expectedContract.policy.jevModel &&
    row["jev_error"] == null &&
    row["jev_decision"] != null &&
    triage !== null &&
    matchesExpectedReviewInputContract(
      row["review_input_manifest"],
      expectedContract,
    ) &&
    matchesExpectedReviewInputContract(
      row["jev_input_manifest"],
      expectedContract,
    ) &&
    reviewInputManifestMatchesSourceRevision(
      row["review_input_manifest"],
      stateSourceRevision,
    );
  return {
    ...row,
    ...analystExportFields(row, expectedContract, triageCurrent, triage),
  };
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
  const jevProofLinkage =
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
  const currentJevLinkage = linkage.phase === "settled" && jevProofLinkage;
  const currentJev = currentJevLinkage && contractCurrent;
  const triage = validJevTriage(row["jev_parsed"]);
  const triageCurrent =
    (linkage.phase === "muse" || linkage.phase === "settled") &&
    jevProofLinkage &&
    contractCurrent &&
    row["jev_model_id"] === expectedContract?.policy.jevModel &&
    triage !== null &&
    matchesExpectedReviewInputContract(
      row["jev_input_manifest"],
      expectedContract,
    );
  const reviewManifest = objectValue(row["review_input_manifest"]);
  const manifestEvidence = objectValue(reviewManifest?.["evidence"]);
  const sourcedSupport = objectValue(manifestEvidence?.["sourcedSupport"]);
  const admittedIdentityDomain =
    triageCurrent &&
    manifestEvidence?.["identityStatus"] === "verified" &&
    sourcedSupport?.["identity"] === true &&
    typeof manifestEvidence["domain"] === "string"
      ? normalizeTargetDomain(manifestEvidence["domain"])
      : null;
  const rankingIdentityConflict =
    admittedIdentityDomain !== null &&
    hasIdentityDomainConflict(row, admittedIdentityDomain);
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
    ranking_identity_conflict: rankingIdentityConflict,
    readiness: rankingIdentityConflict
      ? "unscored"
      : (row["readiness"] ?? "unscored"),
    ranking: rankingIdentityConflict
      ? UNSCORED_INVESTOR_RANKING
      : rankingForExport(row),
    ...analystExportFields(row, expectedContract, triageCurrent, triage),
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
  const rankingQuery = PG_DIALECT.sqlToQuery(
    investorRankingSql({
      expectedReviewInputContract:
        context?.expectedReviewInputContract ?? null,
    }),
  );
  const params: unknown[] = [...rankingQuery.params];
  params.push(AUTHORITATIVE_PRE_JEV_SNAPSHOT_KEYS);
  const snapshotKeysParam = `$${params.length}`;
  params.push(context?.expectedReviewInputContract?.policy.analyst ?? "");
  const analystPolicyParam = `$${params.length}`;
  let where = "";
  if (tier !== undefined && tier !== null) {
    params.push(tier);
    where = `WHERE ut.tier = $${params.length}`;
  }
  const targetColumns = UNIFIED_TARGET_COLUMNS.map(
    (column) => `ut.${column}`,
  ).join(", ");
  const { rows } = await query(
    `WITH ranked AS (${rankingQuery.sql})
     SELECT ${targetColumns},
            ut.signal_id,
            ut.id AS target_id,
            to_char(
              ut.created_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS target_created_at_text,
            ranked.readiness,
            ranked.ranking,
            ranked.ranking_bucket,
            ranked.ranking_sort_score,
            ranked.created_at_text AS ranking_created_at_text,
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
            jev.model_id AS jev_model_id,
            jev.prompt_version AS jev_prompt_version,
            jev.input_manifest AS jev_input_manifest,
            jev.parsed AS jev_parsed,
            jev.error AS jev_error,
            jev.disqualifiers AS jev_disqualifiers,
            muse.id AS muse_evaluation_id,
            muse.signal_id AS muse_signal_id,
            muse.input_hash AS muse_input_hash,
            muse.decision AS muse_decision,
            muse.error AS muse_error,
            muse.disqualifiers AS muse_disqualifiers,
            analyst.id AS analyst_case_id,
            analyst.source_revision AS analyst_source_revision,
            analyst.policy_version AS analyst_policy_version,
            analyst.input_hash AS analyst_input_hash,
            analyst.status AS analyst_case_status,
            analyst.memo AS analyst_memo,
            analyst.next_attempt_at AS analyst_next_attempt_at,
            analyst.stop_reason AS analyst_stop_reason,
            exact_members.memberships,
            possible_members.possible_memberships
     FROM unified_targets ut
     LEFT JOIN signal_review_state st ON st.signal_id = ut.signal_id
     LEFT JOIN source_signals s ON s.id = ut.signal_id
     LEFT JOIN ranked ON ranked.signal_id = ut.signal_id
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
       SELECT ac.id, ac.source_revision, ac.policy_version, ac.input_hash,
              ac.status, ac.memo, ac.next_attempt_at, ac.stop_reason
       FROM signal_analyst_cases ac
       WHERE ac.signal_id = s.id
       ORDER BY (ac.policy_version = ${analystPolicyParam}) DESC,
                ac.created_at DESC,
                ac.id DESC
       LIMIT 1
     ) analyst ON true
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
         AND snapshot.key = ANY(${snapshotKeysParam}::text[])
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
         AND snapshot.key = ANY(${snapshotKeysParam}::text[])
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
     ORDER BY
       COALESCE(ranked.ranking_bucket, 1) ASC,
       COALESCE(ranked.ranking_sort_score, -1) DESC,
       COALESCE(ranked.created_at, ut.created_at) DESC,
       ranked.signal_id DESC NULLS LAST,
       ut.id DESC`,
    params,
  );
  const enrichedRows = rows.map((row) =>
    enrichUnifiedExportRow(
      {
        ...row,
        readiness: row["readiness"] ?? "unscored",
        ranking: rankingForExport(row),
      },
      context,
    ),
  );
  if (enrichedRows.some((row) => row["ranking_identity_conflict"] === true)) {
    enrichedRows.sort((left, right) => {
      const leftBucket =
        left["ranking_identity_conflict"] === true
          ? 1
          : Number(left["ranking_bucket"] ?? 1);
      const rightBucket =
        right["ranking_identity_conflict"] === true
          ? 1
          : Number(right["ranking_bucket"] ?? 1);
      if (leftBucket !== rightBucket) return leftBucket - rightBucket;
      const leftScore =
        left["ranking_identity_conflict"] === true
          ? -1
          : Number(left["ranking_sort_score"] ?? -1);
      const rightScore =
        right["ranking_identity_conflict"] === true
          ? -1
          : Number(right["ranking_sort_score"] ?? -1);
      if (leftScore !== rightScore) return rightScore - leftScore;
      const leftCreatedAt = String(
        left["ranking_created_at_text"] ??
          left["target_created_at_text"] ??
          "",
      );
      const rightCreatedAt = String(
        right["ranking_created_at_text"] ??
          right["target_created_at_text"] ??
          "",
      );
      if (leftCreatedAt !== rightCreatedAt) {
        return leftCreatedAt < rightCreatedAt ? 1 : -1;
      }
      const leftSignalId = String(left["signal_id"] ?? "");
      const rightSignalId = String(right["signal_id"] ?? "");
      if (leftSignalId !== rightSignalId) {
        return leftSignalId < rightSignalId ? 1 : -1;
      }
      const leftTargetId = String(left["target_id"] ?? "");
      const rightTargetId = String(right["target_id"] ?? "");
      if (leftTargetId === rightTargetId) return 0;
      return leftTargetId < rightTargetId ? 1 : -1;
    });
  }
  const projected = enrichedRows.map((enriched) =>
    Object.fromEntries(
      EXPORT_COLUMNS.map((column) => [column, enriched[column]]),
    ),
  );
  if (format === "json") return `${JSON.stringify(projected, null, 2)}\n`;
  return stringifyUnifiedCsv(projected);
}

/**
 * Export every raw source signal, including unpromoted records, with current
 * Jev/analyst proof labels and whole-case spend. The query is deliberately
 * set-based: visible action pagination never changes case-wide accounting.
 */
export async function exportSourceSignals(
  db: QueryableDb,
  format: UnifiedExportFormat,
  context?: SourceSignalExportContext,
): Promise<SourceSignalExportResult> {
  const query = queryFnFor(db);
  const expectedReviewInputContract =
    context?.expectedReviewInputContract ?? null;
  const normalized = normalizeSignalOverviewQuery({
    expectedReviewInputContract,
    ...(context?.sort === undefined ? {} : { sort: context.sort }),
    ...(context?.q === undefined ? {} : { q: context.q }),
    ...(context?.readiness === undefined
      ? {}
      : { readiness: context.readiness }),
  });
  const rankingQuery = PG_DIALECT.sqlToQuery(
    investorRankingSql({ expectedReviewInputContract }),
  );
  const params: unknown[] = [...rankingQuery.params];
  params.push(expectedReviewInputContract?.policy.analyst ?? "");
  const analystPolicyParam = `$${params.length}`;
  const filters: string[] = [];
  if (normalized.q !== null) {
    const literal = normalized.q
      .replaceAll("\\", "\\\\")
      .replaceAll("%", "\\%")
      .replaceAll("_", "\\_");
    params.push(literal);
    const queryParam = `$${params.length}`;
    filters.push(
      `(ranked.raw_name ILIKE '%' || ${queryParam} || '%' ESCAPE '\\' ` +
        `OR COALESCE(ranked.raw_domain, '') ILIKE '%' || ${queryParam} || '%' ESCAPE '\\')`,
    );
  }
  if (normalized.readiness !== null) {
    params.push(normalized.readiness);
    filters.push(`ranked.readiness = $${params.length}`);
  }
  const where = filters.length === 0 ? "TRUE" : filters.join(" AND ");
  const orderBy =
    normalized.sort === "priority"
      ? `ranked.ranking_bucket ASC,
         ranked.ranking_sort_score DESC,
         ranked.created_at DESC,
         ranked.signal_id DESC`
      : "ranked.created_at DESC, ranked.signal_id DESC";
  const { rows } = await query(
    `WITH ranked AS (${rankingQuery.sql})
     SELECT
       s.id AS signal_id,
       ranked.readiness,
       ranked.ranking,
       to_char(
         s.created_at AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
       ) AS created_at,
       s.source_key,
       s.source_locator,
       s.source_fingerprint,
       s.raw_name,
       s.raw_domain,
       s.uei,
       s.cage,
       s.city,
       s.state,
       s.country,
       s.award_count,
       s.award_value::text AS award_value,
       CASE WHEN s.freshest_award IS NULL THEN NULL ELSE to_char(
         s.freshest_award AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
       ) END AS freshest_award,
       s.status AS signal_status,
       s.review_revision,
       s.lead_id,
       s.company_id,
       ${format === "json" ? "s.qualification, s.source_payload," : ""}
       st.phase AS review_phase,
       st.input_hash AS review_input_hash,
       st.input_manifest AS review_input_manifest,
       st.source_revision AS state_source_revision,
       s.review_revision AS signal_source_revision,
       st.jev_evaluation_id AS state_jev_evaluation_id,
       to_char(
         st.next_attempt_at AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
       ) AS review_retry_at,
       st.last_error AS review_last_error,
       jev.id AS jev_evaluation_id,
       jev.signal_id AS jev_signal_id,
       jev.model_id AS jev_model_id,
       jev.prompt_version AS jev_prompt_version,
       jev.input_hash AS jev_input_hash,
       jev.input_manifest AS jev_input_manifest,
       jev.parsed AS jev_parsed,
       jev.decision AS jev_decision,
       jev.confidence AS jev_confidence,
       jev.error AS jev_error,
       analyst.id AS analyst_case_id,
       analyst.source_revision AS analyst_source_revision,
       analyst.policy_version AS analyst_policy_version,
       analyst.input_hash AS analyst_input_hash,
       analyst.status AS analyst_case_status,
       analyst.memo AS analyst_memo,
       CASE WHEN analyst.next_attempt_at IS NULL THEN NULL ELSE to_char(
         analyst.next_attempt_at AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
       ) END AS analyst_next_attempt_at,
       analyst.stop_reason AS analyst_stop_reason,
       COALESCE(accounting.analyst_step_count, 0)::integer
         AS analyst_step_count,
       COALESCE(accounting.provider_known_cost_usd, '0')::text
         AS provider_known_cost_usd,
       COALESCE(accounting.provider_unknown_estimated_cost_usd, '0')::text
         AS provider_unknown_estimated_cost_usd,
       COALESCE(accounting.provider_receipt_count, 0)::integer
         AS provider_receipt_count,
       COALESCE(accounting.provider_unknown_receipt_count, 0)::integer
         AS provider_unknown_receipt_count,
       COALESCE(accounting.model_known_cost_usd, '0')::text
         AS model_known_cost_usd,
       COALESCE(accounting.model_receipt_count, 0)::integer
         AS model_receipt_count,
       COALESCE(accounting.model_unknown_receipt_count, 0)::integer
         AS model_unknown_receipt_count
     FROM ranked
     JOIN source_signals s ON s.id = ranked.signal_id
     LEFT JOIN signal_review_state st ON st.signal_id = s.id
     LEFT JOIN faa_ensemble_evaluations jev
       ON jev.id = st.jev_evaluation_id
     LEFT JOIN LATERAL (
       SELECT ac.id, ac.source_revision, ac.policy_version, ac.input_hash,
              ac.status, ac.memo, ac.next_attempt_at, ac.stop_reason
       FROM signal_analyst_cases ac
       WHERE ac.signal_id = s.id
       ORDER BY (ac.policy_version = ${analystPolicyParam}) DESC,
                ac.created_at DESC,
                ac.id DESC
       LIMIT 1
     ) analyst ON true
     LEFT JOIN LATERAL (
       WITH case_steps AS (
         SELECT step.id, step.model_usage_receipt_id
         FROM signal_analyst_steps step
         WHERE step.case_id = analyst.id
       ),
       provider AS (
         SELECT
           COALESCE(sum(usage.actual_cost_usd)
             FILTER (WHERE usage.actual_cost_usd IS NOT NULL), 0)::text
             AS known_cost,
           COALESCE(sum(usage.estimated_cost_usd)
             FILTER (WHERE usage.actual_cost_usd IS NULL), 0)::text
             AS unknown_estimated_cost,
           count(*)::integer AS receipt_count,
           count(*) FILTER (WHERE usage.actual_cost_usd IS NULL)::integer
             AS unknown_receipt_count
         FROM research_provider_usage usage
         JOIN case_steps step ON step.id = usage.analyst_step_id
       ),
       model_receipts AS (
         SELECT DISTINCT usage.id, usage.cost_usd
         FROM faa_review_model_usage usage
         JOIN case_steps step ON step.model_usage_receipt_id = usage.id
       ),
       model AS (
         SELECT
           COALESCE(sum(cost_usd)
             FILTER (WHERE cost_usd IS NOT NULL), 0)::text AS known_cost,
           count(*)::integer AS receipt_count,
           count(*) FILTER (WHERE cost_usd IS NULL)::integer
             AS unknown_receipt_count
         FROM model_receipts
       )
       SELECT
         (SELECT count(*) FROM case_steps)::integer AS analyst_step_count,
         provider.known_cost AS provider_known_cost_usd,
         provider.unknown_estimated_cost
           AS provider_unknown_estimated_cost_usd,
         provider.receipt_count AS provider_receipt_count,
         provider.unknown_receipt_count AS provider_unknown_receipt_count,
         model.known_cost AS model_known_cost_usd,
         model.receipt_count AS model_receipt_count,
         model.unknown_receipt_count AS model_unknown_receipt_count
       FROM provider CROSS JOIN model
     ) accounting ON analyst.id IS NOT NULL
     WHERE ${where}
     ORDER BY ${orderBy}`,
    params,
  );
  const projected = rows.map((row) => {
    const enriched = enrichSourceSignalExportRow(row, context);
    return Object.fromEntries(
      SOURCE_SIGNAL_EXPORT_COLUMNS.map((column) => [column, enriched[column]]),
    );
  });
  return {
    body:
      format === "json"
        ? `${JSON.stringify(projected, null, 2)}\n`
        : stringifySourceSignalCsv(projected),
    rowCount: projected.length,
  };
}
