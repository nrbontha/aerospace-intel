/**
 * Enrichment benchmark — field-by-field comparison of our extracted profile
 * against the golden_examples grata_payload reference, plus report aggregation.
 *
 * Pure module: no I/O, no model calls, no database.
 */
import {
  classifyOwnership,
  grataNumber,
  normalizeState,
  type EnrichmentProfile,
  type OwnershipGroup,
} from "./schema.js";

export type FieldVerdict =
  | "match"
  | "mismatch"
  | "our_missing"
  | "grata_missing"
  | "incomparable";

export type DisagreementClass =
  | "our_likely_error"
  | "grata_likely_error"
  | "date_mismatch"
  | "source_conflict"
  | "incomparable"
  | "unresolved";

export const COMPARISON_FIELDS = [
  "hq_state",
  "hq_city",
  "revenue_estimate_usd",
  "employees",
  "ownership_class",
  "manufactures_products",
  "distributes",
  "services",
  "pma_mentioned",
  "proprietary_language",
  "description",
] as const;
export type ComparisonField = (typeof COMPARISON_FIELDS)[number];

/** Numeric estimates (revenue, headcount) count as matching within this relative band. */
export const NUMERIC_TOLERANCE = 0.35;

export interface FieldComparison {
  readonly field: ComparisonField;
  readonly ours: string | number | boolean | null;
  readonly grata: string | number | boolean | null;
  readonly verdict: FieldVerdict;
  readonly disagreement: DisagreementClass | null;
  readonly note: string;
}

export interface ComparisonContext {
  /** Concatenated fetched page text; sharpens blame for flag disagreements. */
  readonly pageText?: string;
  /** Year the benchmark runs (default: actual current year); anchors date_mismatch detection. */
  readonly currentYear?: number;
}

type GrataPayload = Record<string, unknown>;

interface RawOutcome {
  ours: string | number | boolean | null;
  grata: string | number | boolean | null;
  verdict: FieldVerdict;
  note: string;
  blame?: () => DisagreementClass;
}

const CURRENT_YEAR_FALLBACK = new Date().getUTCFullYear();

function firstGrataString(payload: GrataPayload, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function grataDescriptionText(payload: GrataPayload): string {
  return [
    firstGrataString(payload, ["Description"]) ?? "",
    firstGrataString(payload, ["Misc. details", "Misc details"]) ?? "",
    firstGrataString(payload, ["Business Model"]) ?? "",
  ].join(" ");
}

function numericOutcome(
  ours: number,
  grata: number,
): { verdict: "match" | "mismatch"; relativeDelta: number } {
  const relativeDelta = Math.abs(ours - grata) / Math.abs(grata);
  return {
    verdict: relativeDelta <= NUMERIC_TOLERANCE ? "match" : "mismatch",
    relativeDelta,
  };
}

function percent(delta: number): string {
  return `${(delta * 100).toFixed(1)}%`;
}

/**
 * A revenue mismatch where our own basis cites a past fiscal period is classified
 * as estimate-date drift rather than an outright error.
 */
function looksLikeDatedBasis(profile: EnrichmentProfile, contextYear: number): boolean {
  const basis = profile.size.revenueBasis;
  if (basis === undefined) return false;
  const years = [...basis.matchAll(/\b(?:19|20)\d{2}\b/gu)].map((match) =>
    Number.parseInt(match[0], 10),
  );
  return years.some((year) => year < contextYear);
}

function flagBlame(
  oursTrue: boolean,
  grataStatesFact: boolean,
  pageText: string | undefined,
  evidencePattern: RegExp,
): DisagreementClass {
  if (pageText === undefined) return "unresolved";
  const pageSupportsFact = evidencePattern.test(pageText);
  if (!oursTrue && grataStatesFact && pageSupportsFact) return "our_likely_error";
  if (oursTrue && !pageSupportsFact && grataStatesFact) return "our_likely_error";
  if (oursTrue && pageSupportsFact && !grataStatesFact) return "grata_likely_error";
  if (!oursTrue && !grataStatesFact && pageSupportsFact) return "grata_likely_error";
  return "unresolved";
}

function absentOr(
  oursPresent: boolean,
  grataPresent: boolean,
  compared: () => RawOutcome,
): RawOutcome {
  if (!oursPresent && !grataPresent) {
    return { ours: null, grata: null, verdict: "incomparable", note: "absent on both sides" };
  }
  if (!oursPresent) {
    return { ours: null, grata: null, verdict: "our_missing", note: "our profile omitted this field" };
  }
  if (!grataPresent) {
    return { ours: null, grata: null, verdict: "grata_missing", note: "grata reference has no value" };
  }
  return compared();
}

function exactTextCompare(
  ours: string,
  grata: string,
  fieldLabel: string,
  normalize: (value: string) => string,
  context?: ComparisonContext,
): RawOutcome {
  const normalizedOurs = normalize(ours);
  const normalizedGrata = normalize(grata);
  return normalizedOurs === normalizedGrata
    ? {
        ours: normalizedOurs,
        grata: normalizedGrata,
        verdict: "match",
        note: `${fieldLabel} exact after normalization`,
      }
    : {
        ours: normalizedOurs,
        grata: normalizedGrata,
        verdict: "mismatch",
        note: `${fieldLabel} exact-match rule failed`,
        blame: () => {
          // Page text breaks ties: if the fetched pages support OUR value but
          // not grata's, grata is likely stale; the reverse blames our model.
          if (context?.pageText === undefined) return "source_conflict";
          const normalizedPage = normalize(context.pageText);
          const supportsOurs = normalizedPage.includes(normalizedOurs);
          const supportsGrata = normalizedPage.includes(normalizedGrata);
          if (supportsOurs && !supportsGrata) return "grata_likely_error";
          if (supportsGrata && !supportsOurs) return "our_likely_error";
          return "source_conflict";
        },
      };
}

function numericFieldCompare(
  ours: number,
  grata: number,
  datedBasis: () => DisagreementClass,
): RawOutcome {
  const outcome = numericOutcome(ours, grata);
  return outcome.verdict === "match"
    ? {
        ours,
        grata,
        verdict: "match",
        note: `relative delta ${percent(outcome.relativeDelta)} within ±35%`,
      }
    : {
        ours,
        grata,
        verdict: "mismatch",
        note: `relative delta ${percent(outcome.relativeDelta)} exceeds ±35%`,
        blame: datedBasis,
      };
}

function compareScalarField(
  field: Exclude<ComparisonField, "manufactures_products" | "distributes" | "services" | "pma_mentioned" | "proprietary_language" | "description">,
  profile: EnrichmentProfile,
  payload: GrataPayload,
  context: ComparisonContext,
): RawOutcome {
  switch (field) {
    case "hq_state": {
      const ours = profile.identity.hqState;
      const grata = firstGrataString(payload, ["State"]);
      return absentOr(
        ours !== undefined && ours.length > 0,
        grata !== null,
        () =>
          exactTextCompare(ours!, grata!, "state", normalizeState, context),
      );
    }
    case "hq_city": {
      const ours = profile.identity.hqCity;
      const grata = firstGrataString(payload, ["City"]);
      const normalizeCity = (value: string) =>
        value.replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
      return absentOr(
        ours !== undefined && ours.length > 0,
        grata !== null,
        () => exactTextCompare(ours!, grata!, "city", normalizeCity, context),
      );
    }
    case "revenue_estimate_usd": {
      const ours = profile.size.revenueEstimateUsd;
      const grata =
        grataNumber(payload["Revenue Estimate"]) ??
        grataNumber(payload["Estimated revenue"]);
      return absentOr(ours !== undefined, grata !== null, () =>
        numericFieldCompare(ours!, grata!, () =>
          looksLikeDatedBasis(profile, context.currentYear ?? CURRENT_YEAR_FALLBACK)
            ? "date_mismatch"
            : "unresolved",
        ),
      );
    }
    case "employees": {
      const ours = profile.size.employees;
      const grata = grataNumber(payload["Employee Estimate"]);
      return absentOr(ours !== undefined, grata !== null, () =>
        numericFieldCompare(ours!, grata!, () => "unresolved"),
      );
    }
    case "ownership_class": {
      const ours = profile.ownership.ownershipType;
      const grata = firstGrataString(payload, ["Ownership"]);
      const ourGroup: OwnershipGroup = classifyOwnership(ours);
      const grataGroup: OwnershipGroup = classifyOwnership(grata);
      return absentOr(ours.length > 0, grata !== null, () =>
        ourGroup === grataGroup
          ? {
              ours: ourGroup,
              grata: grataGroup,
              verdict: "match",
              note: "same ownership group after keyword mapping",
            }
          : {
              ours: ourGroup,
              grata: grataGroup,
              verdict: "mismatch",
              note: `keyword mapping diverged ("${ours}" → ${ourGroup}, "${grata}" → ${grataGroup})`,
              blame: () => "source_conflict",
            },
      );
    }
  }
}

interface BusinessExpectation {
  manufactures: boolean | null;
  distributes: boolean | null;
  services: boolean | null;
}

function businessModelExpectation(payload: GrataPayload): BusinessExpectation {
  const text = grataDescriptionText(payload);
  const expect = (pattern: RegExp): boolean | null =>
    pattern.test(text) ? true : null;
  return {
    manufactures: expect(/\bmanufactur/iu),
    distributes: expect(/\b(distribut|reseller)/iu),
    services: expect(/\b(service|mro|aftermarket)/iu),
  };
}

function compareBooleanFlag(
  ours: boolean,
  grataStatesFact: boolean,
  evidencePattern: RegExp,
  context: ComparisonContext,
  factLabel: string,
): RawOutcome {
  // Grata silence is not evidence of absence: only comparable when Grata's own
  // reference text explicitly states (or structurally implies) the fact.
  if (!grataStatesFact) {
    return {
      ours,
      grata: null,
      verdict: "incomparable",
      note: `grata reference does not state ${factLabel}`,
    };
  }
  if (ours) {
    return { ours, grata: true, verdict: "match", note: `both sides indicate ${factLabel}` };
  }
  return {
    ours,
    grata: true,
    verdict: "mismatch",
    note: `grata indicates ${factLabel}; our extraction said no`,
    blame: () => flagBlame(false, true, context.pageText, evidencePattern),
  };
}

function compareProfileAgainstPayload(
  profile: EnrichmentProfile,
  payload: GrataPayload,
  context: ComparisonContext,
): FieldComparison[] {
  const finalize = (field: ComparisonField, raw: RawOutcome): FieldComparison => ({
    field,
    ours: raw.ours,
    grata: raw.grata,
    verdict: raw.verdict,
    disagreement:
      raw.verdict === "incomparable"
        ? "incomparable"
        : raw.verdict === "mismatch"
          ? (raw.blame?.() ?? "unresolved")
          : null,
    note: raw.note,
  });

  const scalarFields = [
    "hq_state",
    "hq_city",
    "revenue_estimate_usd",
    "employees",
    "ownership_class",
  ] as const;

  const expectation = businessModelExpectation(payload);
  const grataText = grataDescriptionText(payload);
  const pmaEvidence = /\bpma\b|parts manufacturer approval/iu;
  const proprietaryEvidence = /\bproprietary|\bpatented\b|\btrade secret/iu;

  const flagFields: ReadonlyArray<{
    field: ComparisonField;
    ours: boolean;
    expected: boolean | null;
    pattern: RegExp;
    label: string;
  }> = [
    {
      field: "manufactures_products",
      ours: profile.business.manufacturesProducts,
      expected: expectation.manufactures,
      pattern: /\bmanufactur/iu,
      label: "manufacturing",
    },
    {
      field: "distributes",
      ours: profile.business.distributes,
      expected: expectation.distributes,
      pattern: /\b(distribut|reseller)/iu,
      label: "distribution",
    },
    {
      field: "services",
      ours: profile.business.services,
      expected: expectation.services,
      pattern: /\b(service|mro|aftermarket)/iu,
      label: "services",
    },
    {
      field: "pma_mentioned",
      ours: profile.business.pmaMentioned,
      expected: pmaEvidence.test(grataText) ? true : null,
      pattern: pmaEvidence,
      label: "PMA mention",
    },
    {
      field: "proprietary_language",
      ours: profile.business.proprietaryLanguage,
      expected: proprietaryEvidence.test(grataText) ? true : null,
      pattern: proprietaryEvidence,
      label: "proprietary language",
    },
  ];

  return [
    ...scalarFields.map((field) =>
      finalize(field, compareScalarField(field, profile, payload, context)),
    ),
    ...flagFields.map((flag) =>
      finalize(
        flag.field,
        compareBooleanFlag(
          flag.ours,
          flag.expected === true,
          flag.pattern,
          context,
          flag.label,
        ),
      ),
    ),
    finalize("description", {
      ours: profile.business.descriptionOneLiner,
      grata: firstGrataString(payload, ["Description"]),
      verdict: "incomparable",
      note: "free-text descriptions are recorded for coverage only, never scored",
    }),
  ];
}

/**
 * Compare one extracted profile against its grata_payload reference.
 * `context.pageText` sharpens disagreement blame for flag fields; without it
 * flag mismatches resolve to `unresolved`.
 */
export function compareProfiles(
  ours: EnrichmentProfile,
  grataPayload: GrataPayload,
  context: ComparisonContext = {},
): FieldComparison[] {
  return compareProfileAgainstPayload(ours, grataPayload, context);
}

export interface AggregateMetrics {
  /** Per field: share of companies where our profile produced a value. */
  readonly fieldCoverage: Record<ComparisonField, number>;
  /** Per field: matches / (matches + mismatches); null when nothing was comparable. */
  readonly matchRatesByField: Record<ComparisonField, number | null>;
  readonly comparableByField: Record<ComparisonField, number>;
  readonly disagreementCounts: Record<DisagreementClass, number>;
  /** All-field match rate across every comparable comparison. */
  readonly overallMatchRate: number | null;
}

function emptyDisagreementCounts(): Record<DisagreementClass, number> {
  return {
    our_likely_error: 0,
    grata_likely_error: 0,
    date_mismatch: 0,
    source_conflict: 0,
    incomparable: 0,
    unresolved: 0,
  };
}

export interface CompanyComparisonsLike {
  readonly name: string;
  readonly domain: string;
  readonly comparisons: readonly FieldComparison[];
}

export function aggregateComparisons(
  perCompany: readonly CompanyComparisonsLike[],
): AggregateMetrics {
  const coverageHits = Object.fromEntries(
    COMPARISON_FIELDS.map((field) => [field, 0]),
  ) as Record<ComparisonField, number>;
  const matches = Object.fromEntries(
    COMPARISON_FIELDS.map((field) => [field, 0]),
  ) as Record<ComparisonField, number>;
  const comparable = Object.fromEntries(
    COMPARISON_FIELDS.map((field) => [field, 0]),
  ) as Record<ComparisonField, number>;
  const disagreements = emptyDisagreementCounts();
  let totalComparable = 0;
  let totalMatches = 0;

  for (const company of perCompany) {
    for (const comparison of company.comparisons) {
      const oursProduced =
        comparison.ours !== null &&
        comparison.verdict !== "our_missing" &&
        comparison.verdict !== "grata_missing";
      if (oursProduced) coverageHits[comparison.field] += 1;
      if (comparison.verdict === "match" || comparison.verdict === "mismatch") {
        comparable[comparison.field] += 1;
        totalComparable += 1;
        if (comparison.verdict === "match") {
          matches[comparison.field] += 1;
          totalMatches += 1;
        } else if (comparison.disagreement !== null) {
          disagreements[comparison.disagreement] += 1;
        }
      } else if (comparison.disagreement !== null) {
        disagreements[comparison.disagreement] += 1;
      }
    }
  }

  const fieldCoverage = Object.fromEntries(
    COMPARISON_FIELDS.map((field) => [
      field,
      perCompany.length === 0 ? 0 : coverageHits[field] / perCompany.length,
    ]),
  ) as Record<ComparisonField, number>;
  const matchRatesByField = Object.fromEntries(
    COMPARISON_FIELDS.map((field) => [
      field,
      comparable[field] === 0 ? null : matches[field] / comparable[field],
    ]),
  ) as Record<ComparisonField, number | null>;

  return {
    fieldCoverage,
    matchRatesByField,
    comparableByField: comparable,
    disagreementCounts: disagreements,
    overallMatchRate: totalComparable === 0 ? null : totalMatches / totalComparable,
  };
}
