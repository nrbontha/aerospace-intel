export const SOURCE_SCORE_DIMENSION_KEYS = [
  "reliability",
  "freshness",
  "authority",
] as const;

export const SUPPLIER_SCORE_DIMENSION_KEYS = [
  "identity_completeness",
  "evidence_coverage",
  "review_completeness",
  "qualification_specificity",
  "recency",
] as const;

export type SourceScoreDimensionKey =
  (typeof SOURCE_SCORE_DIMENSION_KEYS)[number];
export type SupplierScoreDimensionKey =
  (typeof SUPPLIER_SCORE_DIMENSION_KEYS)[number];

export interface ScoreDimension {
  readonly key: string;
  readonly label: string;
  readonly value: number | null;
  readonly method: string;
}

export interface Scorecard {
  readonly subjectType: string;
  readonly subjectId: string;
  readonly overall: number | null;
  readonly completeness: number;
  readonly presentCount: number;
  readonly missingCount: number;
  readonly dimensions: readonly ScoreDimension[];
}

export interface SourceScoreInputs {
  readonly subjectId: string;
  readonly access: "public" | "authorized" | "restricted_metadata_only";
  readonly hasPublisher: boolean;
  readonly documentCount: number;
  readonly evidenceCount: number;
  readonly acceptedObservationCount: number;
  readonly rejectedObservationCount: number;
  readonly latestRetrievedAt: Date | string | null;
  readonly persistedReliability: number | null;
  readonly persistedFreshness: number | null;
  readonly persistedAuthority: number | null;
  readonly now?: Date;
}

export interface SupplierScoreInputs {
  readonly subjectId: string;
  readonly hasLegalName: boolean;
  readonly hasWebsite: boolean;
  readonly hasCountry: boolean;
  readonly hasDomain: boolean;
  readonly observationCount: number;
  readonly canonicalFactCount: number;
  readonly evidenceCount: number;
  readonly qualificationCount: number;
  readonly qualificationsWithPlatform: number;
  readonly qualificationsWithCustomer: number;
  readonly latestObservationAt: Date | string | null;
  readonly hasCompletedResearch: boolean;
  readonly now?: Date;
}

const SOURCE_LABELS: Record<SourceScoreDimensionKey, string> = {
  reliability: "Reliability",
  freshness: "Freshness",
  authority: "Authority",
};

const SUPPLIER_LABELS: Record<SupplierScoreDimensionKey, string> = {
  identity_completeness: "Identity completeness",
  evidence_coverage: "Evidence coverage",
  review_completeness: "Review completeness",
  qualification_specificity: "Qualification specificity",
  recency: "Evidence recency",
};

export function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return Math.round(value * 100) / 100;
}

export function freshnessFromAgeDays(days: number): number {
  if (!Number.isFinite(days) || days < 0) return clampScore(0);
  if (days <= 30) return clampScore(100 - days * 0.2);
  if (days <= 365) return clampScore(94 - ((days - 30) * 44) / 335);
  if (days <= 1095) return clampScore(50 - ((days - 365) * 40) / 730);
  return clampScore(Math.max(1, 10 - (days - 1095) / 365));
}

export function parseScore(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  return clampScore(parsed);
}

export function aggregateScorecard(input: {
  readonly subjectType: string;
  readonly subjectId: string;
  readonly dimensions: readonly ScoreDimension[];
  readonly weights?: Readonly<Record<string, number>>;
}): Scorecard {
  const present = input.dimensions.filter(
    (dimension) => dimension.value !== null,
  );
  const missingCount = input.dimensions.length - present.length;
  const completeness =
    input.dimensions.length === 0
      ? 0
      : present.length / input.dimensions.length;

  if (present.length === 0) {
    return {
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      overall: null,
      completeness,
      presentCount: 0,
      missingCount,
      dimensions: input.dimensions,
    };
  }

  let weightSum = 0;
  let weighted = 0;
  for (const dimension of present) {
    const weight = Math.max(0, input.weights?.[dimension.key] ?? 1);
    weightSum += weight;
    weighted += (dimension.value as number) * weight;
  }

  return {
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    overall: weightSum === 0 ? null : clampScore(weighted / weightSum),
    completeness,
    presentCount: present.length,
    missingCount,
    dimensions: input.dimensions,
  };
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function ageDays(at: Date | string | null | undefined, now: Date): number | null {
  const date = toDate(at);
  if (date === null) return null;
  return Math.max(0, (now.getTime() - date.getTime()) / 86_400_000);
}

export function scoreSource(input: SourceScoreInputs): Scorecard {
  const now = input.now ?? new Date();
  const reviewed =
    input.acceptedObservationCount + input.rejectedObservationCount;

  const reliability =
    input.persistedReliability !== null
      ? parseScore(input.persistedReliability)
      : reviewed === 0
        ? null
        : clampScore(
            (input.acceptedObservationCount / reviewed) * 100,
          );

  const freshness =
    input.persistedFreshness !== null
      ? parseScore(input.persistedFreshness)
      : input.documentCount === 0
        ? null
        : (() => {
            const days = ageDays(input.latestRetrievedAt, now);
            return days === null ? null : freshnessFromAgeDays(days);
          })();

  const authority =
    input.persistedAuthority !== null
      ? parseScore(input.persistedAuthority)
      : input.access === "restricted_metadata_only"
        ? null
        : input.hasPublisher || input.evidenceCount > 0
          ? clampScore(
              (input.hasPublisher ? 55 : 20) +
                (input.access === "public" ? 20 : 10) +
                Math.min(25, input.evidenceCount * 5),
            )
          : null;

  return aggregateScorecard({
    subjectType: "data_source",
    subjectId: input.subjectId,
    dimensions: [
      {
        key: "reliability",
        label: SOURCE_LABELS.reliability,
        value: reliability,
        method:
          input.persistedReliability !== null
            ? "recorded_assessment"
            : reviewed === 0
              ? "unassessed"
              : "accepted_observation_ratio",
      },
      {
        key: "freshness",
        label: SOURCE_LABELS.freshness,
        value: freshness,
        method:
          input.persistedFreshness !== null
            ? "recorded_assessment"
            : input.documentCount === 0
              ? "unassessed"
              : "latest_document_age",
      },
      {
        key: "authority",
        label: SOURCE_LABELS.authority,
        value: authority,
        method:
          input.persistedAuthority !== null
            ? "recorded_assessment"
            : input.access === "restricted_metadata_only"
              ? "unassessed_restricted_metadata"
              : authority === null
                ? "unassessed"
                : "publisher_access_and_evidence",
      },
    ],
  });
}

export function scoreSupplier(input: SupplierScoreInputs): Scorecard {
  const now = input.now ?? new Date();
  const identityParts = [
    input.hasLegalName,
    input.hasWebsite,
    input.hasCountry,
    input.hasDomain,
  ];
  const identityCompleteness = clampScore(
    (identityParts.filter(Boolean).length / identityParts.length) * 100,
  );

  const evidenceCoverage = input.hasCompletedResearch
    ? clampScore(Math.min(100, input.observationCount * 12 + input.evidenceCount * 8))
    : null;

  const reviewCompleteness =
    input.observationCount === 0
      ? null
      : clampScore((input.canonicalFactCount / input.observationCount) * 100);

  const qualificationSpecificity =
    input.qualificationCount === 0
      ? null
      : clampScore(
          ((input.qualificationsWithPlatform +
            input.qualificationsWithCustomer) /
            (input.qualificationCount * 2)) *
            100,
        );

  const recency = input.hasCompletedResearch
    ? (() => {
        const days = ageDays(input.latestObservationAt, now);
        return days === null ? null : freshnessFromAgeDays(days);
      })()
    : null;

  return aggregateScorecard({
    subjectType: "company",
    subjectId: input.subjectId,
    dimensions: [
      {
        key: "identity_completeness",
        label: SUPPLIER_LABELS.identity_completeness,
        value: identityCompleteness,
        method: "recorded_identity_fields",
      },
      {
        key: "evidence_coverage",
        label: SUPPLIER_LABELS.evidence_coverage,
        value: evidenceCoverage,
        method: input.hasCompletedResearch
          ? "observation_and_evidence_counts"
          : "unassessed",
      },
      {
        key: "review_completeness",
        label: SUPPLIER_LABELS.review_completeness,
        value: reviewCompleteness,
        method:
          input.observationCount === 0
            ? "unassessed"
            : "canonical_over_observation_ratio",
      },
      {
        key: "qualification_specificity",
        label: SUPPLIER_LABELS.qualification_specificity,
        value: qualificationSpecificity,
        method:
          input.qualificationCount === 0
            ? "unassessed"
            : "scoped_qualification_dimensions",
      },
      {
        key: "recency",
        label: SUPPLIER_LABELS.recency,
        value: recency,
        method: recency === null ? "unassessed" : "latest_observation_age",
      },
    ],
  });
}
