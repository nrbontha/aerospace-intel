import {
  BUILD_TO_PRINT_SHARE_VALUES,
  EMPLOYEES_BAND_VALUES,
  OWNERSHIP_TYPE_VALUES,
  REVENUE_BAND_VALUES,
} from "./bands.js";

/**
 * Pure canonical-state → feature-record mapping.
 *
 * This module is deliberately FREE of any import from the scoring engine
 * (@asi/research): it produces a plain `Record<string, unknown>` in exactly
 * the shape `extractFeatureVector` (packages/research/src/scoring-axial/
 * features.ts) accepts, so all storage stays in @asi/database and the
 * engine call happens in the orchestration layer (apps/web scoring glue).
 *
 * Mapping rules:
 *  - Only fields that actually exist in the canonical catalog are mapped;
 *    everything without a canonical source becomes the EXPLICIT `unknown`
 *    member required by featureVectorSchema (never a guessed default).
 *  - The canonical `ownership_type` enum (private/public/subsidiary/...)
 *    is narrower than the engine's ownership taxonomy, so it maps
 *    conservatively: private→independent_founder, public→public_sub,
 *    subsidiary→strategic_sub; government/joint_venture/cooperative have
 *    no engine equivalent and map to `unknown`.
 */

export type RevenueBand = (typeof REVENUE_BAND_VALUES)[number];
export type EmployeesBand = (typeof EMPLOYEES_BAND_VALUES)[number];
export type FeatureOwnershipType = (typeof OWNERSHIP_TYPE_VALUES)[number];
export type BuildToPrintShare = (typeof BUILD_TO_PRINT_SHARE_VALUES)[number];

export interface MoneyRange {
  amountLower: number | null;
  amountUpper: number | null;
}

export interface CountRange {
  countLower: number | null;
  countUpper: number | null;
}

function midpoint(lower: number | null, upper: number | null): number | null {
  if (lower !== null && upper !== null) return (lower + upper) / 2;
  return lower ?? upper;
}

/** Map a USD revenue range to the frozen revenue band ladder. */
export function revenueBandFromRange(range: MoneyRange | null): RevenueBand {
  const value = range === null ? null : midpoint(range.amountLower, range.amountUpper);
  if (value === null || !Number.isFinite(value)) return "unknown";
  if (value < 5_000_000) return "<5m";
  if (value < 10_000_000) return "5-10m";
  if (value < 20_000_000) return "10-20m";
  if (value < 35_000_000) return "20-35m";
  // Ladder tops out at 35-50m; larger revenues stay in the top band (the
  // engine's fit veto reads the band ordinally, so this still fails <$50m).
  return "35-50m";
}

/**
 * Map an employee-count range to the frozen employees band ladder. Ranges
 * spanning two bands resolve to the band of the midpoint; the ladder tops
 * out at 250-500 and larger counts stay in that top band.
 */
export function employeesBandFromRange(range: CountRange | null): EmployeesBand {
  const value = range === null ? null : midpoint(range.countLower, range.countUpper);
  if (value === null || !Number.isFinite(value)) return "unknown";
  if (value < 20) return "<20";
  if (value < 50) return "20-50";
  if (value < 100) return "50-100";
  if (value < 250) return "100-250";
  // Ladder tops out at 250-500; larger counts stay in the top band.
  return "250-500";
}

const CANONICAL_OWNERSHIP_TO_FEATURE: Record<string, FeatureOwnershipType> = {
  private: "independent_founder",
  public: "public_sub",
  subsidiary: "strategic_sub",
  government: "unknown",
  joint_venture: "unknown",
  cooperative: "unknown",
  unknown: "unknown",
};

export function mapOwnershipType(canonicalType: string): FeatureOwnershipType {
  return CANONICAL_OWNERSHIP_TO_FEATURE[canonicalType] ?? "unknown";
}

const BTP_RISK_TO_SHARE: Record<string, BuildToPrintShare> = {
  none: "none",
  low: "minor",
  medium: "minor",
  high: "major",
  unknown: "unknown",
};

/** golden_examples.build_to_print_risk → engine build-to-print share. */
export function mapBuildToPrintRisk(risk: string): BuildToPrintShare {
  return BTP_RISK_TO_SHARE[risk] ?? "unknown";
}

export type QualificationStatus = "present" | "claimed" | "absent" | "unknown";

/** A certification row on file means present; no row is NOT evidence of absence. */
export function certificationStatus(
  standards: readonly string[],
  pattern: RegExp,
): QualificationStatus {
  return standards.some((standard) => pattern.test(standard)) ? "present" : "unknown";
}

export interface CanonicalCompanyState {
  company: {
    id: string;
    displayName: string;
    legalName: string;
    websiteUrl: string | null;
  };
  domains: { domain: string; isPrimary: boolean; verifiedAt: Date | null }[];
  identifiers: { type: string; value: string }[];
  latestRevenue: MoneyRange | null;
  latestEmployees: CountRange | null;
  ownership: { type: string } | null;
  certificationStandards: string[];
  platformNames: string[];
  goldenBuildToPrintRisk: string | null;
  evidenceCounts: {
    sourceCount: number;
    primarySourceCount: number;
    conflictCount: number;
    freshestObservationDaysOld: number | null;
  };
}

/** Best identity domain: primary first, then any domain, then website host. */
export function pickIdentityDomain(state: CanonicalCompanyState): string | null {
  const primary = state.domains.find((d) => d.isPrimary) ?? state.domains[0];
  if (primary !== undefined) return primary.domain;
  if (state.company.websiteUrl !== null && state.company.websiteUrl !== "") {
    try {
      return new URL(state.company.websiteUrl).hostname.replace(/^www\./, "");
    } catch {
      // unparseable website URL — not an identity source
    }
  }
  return null;
}

/**
 * Build the raw record consumed by extractFeatureVector. Deterministic:
 * identical canonical state ⇒ byte-identical output (and therefore an
 * identical feature snapshot sha256).
 */
export function buildFeatureRecordInput(state: CanonicalCompanyState): Record<string, unknown> {
  const domain = pickIdentityDomain(state);
  const cage = state.identifiers.find((i) => i.type === "cage")?.value;
  const uei = state.identifiers.find((i) => i.type === "uei")?.value;
  const standards = state.certificationStandards;

  // No canonical field distinguishes distribution/pure-service business
  // models or aftermarket orientation yet — explicit unknowns by design.
  return {
    identity: {
      ...(domain === null ? {} : { domain }),
      ...(cage === undefined ? {} : { cage }),
      ...(uei === undefined ? {} : { uei }),
    },
    revenue_band: revenueBandFromRange(state.latestRevenue),
    employees_band: employeesBandFromRange(state.latestEmployees),
    ownership_type:
      state.ownership === null ? "unknown" : mapOwnershipType(state.ownership.type),
    distributes_products: "unknown",
    pure_service: "unknown",
    build_to_print_share:
      state.goldenBuildToPrintRisk === null
        ? "unknown"
        : mapBuildToPrintRisk(state.goldenBuildToPrintRisk),
    proprietary_product_evidence: "none",
    qualifications: {
      as9100: certificationStatus(standards, /as\s*9100/i),
      nadcap: certificationStatus(standards, /nadcap/i),
      pma: "unknown",
      qpl: "unknown",
      oem_approved: "unknown",
      itar_signal: "unknown",
    },
    platforms: state.platformNames.slice(0, 20),
    aftermarket: "unknown",
    source_count: state.evidenceCounts.sourceCount,
    primary_source_count: state.evidenceCounts.primarySourceCount,
    conflict_count: state.evidenceCounts.conflictCount,
    freshest_observation_days_old: state.evidenceCounts.freshestObservationDaysOld,
    identity_resolved: Boolean(
      (state.domains.find((d) => d.isPrimary)?.verifiedAt ?? null) !== null ||
        cage !== undefined ||
        uei !== undefined,
    ),
  };
}
