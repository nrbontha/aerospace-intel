import { asc, count, eq, sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.js";
import {
  unifiedTargets,
  type NewUnifiedTarget,
  type UnifiedTarget,
  type UnifiedTargetTier,
} from "../schema.js";

export type { UnifiedTarget, UnifiedTargetTier };
export type { NewUnifiedTarget };

export type UpsertUnifiedTargetInput = Omit<
  NewUnifiedTarget,
  "id" | "normalizedName" | "createdAt" | "updatedAt"
> & {
  normalizedName?: string;
};

/**
 * Canonical normalization: collapse whitespace, trim, lowercase, strip one
 * trailing legal-entity suffix. MUST match normalizeUnifiedName in
 * scripts/populate-unified-targets.mts.
 */
export function normalizeTargetName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[,.\s]+$/, "")
    .replace(
      /\s+(llc|inc|corp|corporation|incorporated|co|company|ltd|limited|lp|llp|pllc|plc)\.?$/,
      "",
    )
    .replace(/[,.\s]+$/, "");
}

export const AUTHORITATIVE_PRE_JEV_SNAPSHOT_KEYS = [
  "golden-set-v01",
  "preliminary-pipeline-v01",
  "ma-pipeline-20260926",
  "booie-original29-2026-09-09",
  "ma-priorities-sample36-2026-09-09",
] as const;

export const ORIGINAL_BOOIE_LIST_NAMES = [
  "Ametek Ameron LLC d/b/a Mass Systems",
  "B/E Aerospace Inc, DBA, SMR Technologies Inc",
  "Butler National Corporation",
  "Avcon Industries",
  "BNC Tempe",
  "CPI Eimac Division",
  "Dart Aerospace",
  "Jet Parts Engineering, Inc. (JPE)",
  "Kirkhill Aircraft Parts Company",
  "PRECISION AIRMOTIVE LLC",
  "Raisbeck Engineering Inc",
  "Robertson Fuel Systems LLC",
  "Shadin Avionics",
  "Sirius Technologies, Inc., DBA Flight Display System",
  "Turbine Kinetics Inc, Subsidiary of HEICO Corp",
  "Vibro-Meter Corp",
  "Wellman Products Group",
  "Meggitt Thermal Systems Inc",
  "VisionSafe Corporation",
  "Electronics International",
  "Alpha Aviation",
  "Composite Specialties",
  "Concorde Battery",
  "Middle Fork",
  "M-20 Oil",
  "Keddeg",
  "Whelen",
  "Delta Flight Products",
  "Skydweller",
] as const;

const ORIGINAL_BOOIE_NORMALIZED_NAMES: Readonly<Record<string, true>> =
  Object.fromEntries(
    ORIGINAL_BOOIE_LIST_NAMES.map((name) => [normalizeTargetName(name), true]),
  );

/** Exact original-list presence only. It is report provenance, never evidence. */
export function isOriginalBooieListName(name: string): boolean {
  return ORIGINAL_BOOIE_NORMALIZED_NAMES[normalizeTargetName(name)] === true;
}

export function normalizeTargetDomain(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "") return null;
  try {
    const url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`,
    );
    return url.hostname
      .toLowerCase()
      .replace(/^www\./, "")
      .replace(/\.$/, "");
  } catch {
    return null;
  }
}

export interface KnownUniverseIdentity {
  normalizedName: string | null;
  normalizedDomain: string | null;
}

export type KnownUniverseMatchBasis = "exact_domain" | "exact_name" | null;

/**
 * Authoritative membership identity: exact domain, or exact name only when
 * the source member has no usable domain. Probable aliases never auto-match.
 */
export function matchKnownUniverseIdentity(
  target: KnownUniverseIdentity,
  member: KnownUniverseIdentity,
): KnownUniverseMatchBasis {
  const targetDomain = normalizeTargetDomain(target.normalizedDomain);
  const memberDomain = normalizeTargetDomain(member.normalizedDomain);
  if (
    targetDomain !== null &&
    memberDomain !== null &&
    targetDomain === memberDomain
  ) {
    return "exact_domain";
  }
  if (
    memberDomain === null &&
    target.normalizedName !== null &&
    member.normalizedName !== null &&
    normalizeTargetName(target.normalizedName) ===
      normalizeTargetName(member.normalizedName)
  ) {
    return "exact_name";
  }
  return null;
}

export interface SignalResearchEvidence {
  version?: string;
  signalId?: string;
  identity?: {
    status?: string;
    verifiedDomain?: string | null;
    proofEvidenceIds?: readonly string[];
  };
  website?: {
    status?: string;
    offering?: string;
    namedProductEvidenceIds?: readonly string[];
  };
  ownership?: {
    status?: string;
    supportEvidenceIds?: readonly string[];
  };
  size?: {
    status?: string;
    assessment?: string;
    indicators?: readonly {
      kind?: string;
      evidenceId?: string;
    }[];
  };
  headquarters?: {
    status?: string;
    city?: string | null;
    state?: string | null;
    country?: string | null;
    supportEvidenceIds?: readonly string[];
  };
  missingFacts?: readonly string[];
  evidenceRefs?: readonly {
    evidenceId?: string;
    stage?: string;
    role?: string;
    url?: string;
    quote?: string;
    firstParty?: boolean;
  }[];
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const text = stringOrUndefined(item);
        return text === undefined ? [] : [text];
      })
    : [];
}

/** Defensive reader for the durable, versioned signal research snapshot. */
export function parseSignalResearchEvidence(
  value: unknown,
): SignalResearchEvidence {
  const root = recordOrNull(value) ?? {};
  const identity = recordOrNull(root["identity"]) ?? {};
  const website = recordOrNull(root["website"]) ?? {};
  const ownership = recordOrNull(root["ownership"]) ?? {};
  const size = recordOrNull(root["size"]) ?? {};
  const headquarters = recordOrNull(root["headquarters"]) ?? {};
  const sizeIndicators = Array.isArray(size["indicators"])
    ? size["indicators"].flatMap((item) => {
        const indicator = recordOrNull(item);
        if (indicator === null) return [];
        const kind = stringOrUndefined(indicator["kind"]);
        const evidenceId = stringOrUndefined(indicator["evidenceId"]);
        return [
          {
            ...(kind === undefined ? {} : { kind }),
            ...(evidenceId === undefined ? {} : { evidenceId }),
          },
        ];
      })
    : [];
  const evidenceRefs = Array.isArray(root["evidenceRefs"])
    ? root["evidenceRefs"].flatMap((item) => {
        const ref = recordOrNull(item);
        if (ref === null) return [];
        const role = stringOrUndefined(ref["role"]);
        const evidenceId = stringOrUndefined(ref["evidenceId"]);
        const stage = stringOrUndefined(ref["stage"]);
        const url = stringOrUndefined(ref["url"]);
        const quote = stringOrUndefined(ref["quote"]);
        const firstParty =
          typeof ref["firstParty"] === "boolean"
            ? ref["firstParty"]
            : undefined;
        return [
          {
            ...(role === undefined ? {} : { role }),
            ...(evidenceId === undefined ? {} : { evidenceId }),
            ...(stage === undefined ? {} : { stage }),
            ...(url === undefined ? {} : { url }),
            ...(quote === undefined ? {} : { quote }),
            ...(firstParty === undefined ? {} : { firstParty }),
          },
        ];
      })
    : [];
  const version = stringOrUndefined(root["version"]);
  const signalId = stringOrUndefined(root["signalId"]);
  const identityStatus = stringOrUndefined(identity["status"]);
  const websiteStatus = stringOrUndefined(website["status"]);
  const offering = stringOrUndefined(website["offering"]);
  const ownershipStatus = stringOrUndefined(ownership["status"]);
  const sizeStatus = stringOrUndefined(size["status"]);
  const sizeAssessment = stringOrUndefined(size["assessment"]);
  const headquartersStatus = stringOrUndefined(headquarters["status"]);
  return {
    ...(version === undefined ? {} : { version }),
    ...(signalId === undefined ? {} : { signalId }),
    identity: {
      ...(identityStatus === undefined ? {} : { status: identityStatus }),
      verifiedDomain: stringOrUndefined(identity["verifiedDomain"]) ?? null,
      proofEvidenceIds: stringList(identity["proofEvidenceIds"]),
    },
    website: {
      ...(websiteStatus === undefined ? {} : { status: websiteStatus }),
      ...(offering === undefined ? {} : { offering }),
      namedProductEvidenceIds: stringList(website["namedProductEvidenceIds"]),
    },
    ownership: {
      ...(ownershipStatus === undefined ? {} : { status: ownershipStatus }),
      supportEvidenceIds: stringList(ownership["supportEvidenceIds"]),
    },
    size: {
      ...(sizeStatus === undefined ? {} : { status: sizeStatus }),
      ...(sizeAssessment === undefined ? {} : { assessment: sizeAssessment }),
      indicators: sizeIndicators,
    },
    headquarters: {
      ...(headquartersStatus === undefined
        ? {}
        : { status: headquartersStatus }),
      city: stringOrUndefined(headquarters["city"]) ?? null,
      state: stringOrUndefined(headquarters["state"]) ?? null,
      country: stringOrUndefined(headquarters["country"]) ?? null,
      supportEvidenceIds: stringList(headquarters["supportEvidenceIds"]),
    },
    missingFacts: stringList(root["missingFacts"]),
    evidenceRefs,
  };
}

export interface PromotionEvidenceInput {
  finalDecision: string | null;
  jevDecision: string | null;
  museDecision: string | null;
  researchEvidence: unknown;
  jevDisqualifiers?: readonly string[];
  museDisqualifiers?: readonly string[];
}

export interface PromotionEvidenceAssessment {
  status: "ready" | "diligence_hold" | "excluded";
  reasons: string[];
  verifiedDomain: string | null;
}

const US_COUNTRIES: Readonly<Record<string, true>> = {
  us: true,
  usa: true,
  "united states": true,
  "united states of america": true,
};

export function hasResearchSupportEvidence(
  ids: readonly string[],
  stage: string,
  refs: NonNullable<SignalResearchEvidence["evidenceRefs"]>,
): boolean {
  const expected = new Set(ids);
  return refs.some(
    (ref) =>
      ref.role === "support" &&
      ref.stage === stage &&
      ref.evidenceId !== undefined &&
      expected.has(ref.evidenceId),
  );
}

/**
 * Final acquisition gate. Unknown ownership, size, or HQ remains a visible
 * diligence hold; model agreement cannot manufacture any of these facts.
 */
export function assessPromotionEvidence(
  input: PromotionEvidenceInput,
): PromotionEvidenceAssessment {
  const evidence = parseSignalResearchEvidence(input.researchEvidence);
  const reasons: string[] = [];
  const excluded: string[] = [];
  const refs = evidence.evidenceRefs ?? [];
  const identityDomain = normalizeTargetDomain(
    evidence.identity?.verifiedDomain,
  );
  const identityProofIds = new Set(evidence.identity?.proofEvidenceIds ?? []);
  const hasIdentityProof = refs.some(
    (ref) =>
      ref.role === "support" &&
      ref.firstParty === true &&
      ref.stage === "domain" &&
      ref.evidenceId !== undefined &&
      identityProofIds.has(ref.evidenceId),
  );
  const verifiedDomain =
    evidence.identity?.status === "verified" && hasIdentityProof
      ? identityDomain
      : null;
  if (verifiedDomain === null) {
    reasons.push("verified official identity/domain missing");
  }

  const namedProductIds = new Set(
    evidence.website?.namedProductEvidenceIds ?? [],
  );
  const hasFirstPartyProductProof = refs.some(
    (ref) =>
      ref.role === "support" &&
      ref.firstParty === true &&
      ref.stage === "website" &&
      ref.evidenceId !== undefined &&
      namedProductIds.has(ref.evidenceId),
  );
  if (!hasFirstPartyProductProof) {
    reasons.push("supplier-owned named product evidence missing");
  }

  const ownership = evidence.ownership?.status;
  const hasOwnershipProof = hasResearchSupportEvidence(
    evidence.ownership?.supportEvidenceIds ?? [],
    "ownership",
    refs,
  );
  if (
    hasOwnershipProof &&
    (ownership === "acquired" ||
      ownership === "pe_owned" ||
      ownership === "public_parent" ||
      ownership === "dead")
  ) {
    excluded.push(`ownership exclusion: ${ownership}`);
  } else if (ownership !== "independent" || !hasOwnershipProof) {
    reasons.push("independent ownership unverified");
  }

  const revenueIndicatorIds = (evidence.size?.indicators ?? []).flatMap(
    (indicator) =>
      indicator.kind === "revenue" && indicator.evidenceId !== undefined
        ? [indicator.evidenceId]
        : [],
  );
  const hasRevenueProof = hasResearchSupportEvidence(
    revenueIndicatorIds,
    "size",
    refs,
  );
  if (evidence.size?.assessment === "over_50m" && hasRevenueProof) {
    excluded.push("sourced revenue exceeds $50m");
  } else if (evidence.size?.assessment !== "under_50m" || !hasRevenueProof) {
    reasons.push("sub-$50m revenue unverified");
  }

  const hqCountry = evidence.headquarters?.country?.trim().toLowerCase();
  const hasHqProof = hasResearchSupportEvidence(
    evidence.headquarters?.supportEvidenceIds ?? [],
    "hq",
    refs,
  );
  if (
    evidence.headquarters?.status !== "supported" ||
    hqCountry === undefined ||
    US_COUNTRIES[hqCountry] !== true ||
    !hasHqProof
  ) {
    reasons.push("US headquarters unverified");
  }

  const disqualifiers = [
    ...(input.jevDisqualifiers ?? []),
    ...(input.museDisqualifiers ?? []),
  ]
    .map((item) => item.trim())
    .filter((item) => item !== "");
  if (disqualifiers.length > 0) {
    excluded.push(...disqualifiers.map((item) => `review exclusion: ${item}`));
  }

  if (
    input.finalDecision !== "high_priority" ||
    input.jevDecision !== "high_priority" ||
    input.museDecision !== "high_priority"
  ) {
    reasons.push("same-input Jev and Muse high-priority agreement missing");
  }

  if (excluded.length > 0) {
    return {
      status: "excluded",
      reasons: [...excluded, ...reasons],
      verifiedDomain,
    };
  }
  if (reasons.length > 0) {
    return { status: "diligence_hold", reasons, verifiedDomain };
  }
  return { status: "ready", reasons: [], verifiedDomain };
}

export interface ExpectedFaaReviewInputContract {
  readonly version: string;
  readonly policy: {
    readonly ladder: string;
    readonly analyst: string;
    readonly jevModel: string;
    readonly museModel: string;
    readonly evaluatorPrompt: string;
  };
}

export function matchesExpectedReviewInputContract(
  inputManifest: unknown,
  expected: ExpectedFaaReviewInputContract | null,
): boolean {
  if (expected === null) return false;
  const manifest = recordOrNull(inputManifest);
  const policy = recordOrNull(manifest?.["policy"]);
  if (manifest === null || policy === null) return false;
  return (
    manifest["version"] === expected.version &&
    policy["ladder"] === expected.policy.ladder &&
    policy["analyst"] === expected.policy.analyst &&
    policy["jevModel"] === expected.policy.jevModel &&
    policy["museModel"] === expected.policy.museModel &&
    policy["evaluatorPrompt"] === expected.policy.evaluatorPrompt
  );
}

export function reviewInputManifestMatchesSourceRevision(
  inputManifest: unknown,
  sourceRevision: number | null,
): boolean {
  const manifest = recordOrNull(inputManifest);
  return (
    sourceRevision !== null && manifest?.["sourceRevision"] === sourceRevision
  );
}

export interface CurrentReviewLinkage {
  phase: string | null;
  stateInputHash: string | null;
  stateJevEvaluationId: string | null;
  stateSourceRevision: number | null;
  signalSourceRevision: number | null;
  inputManifest: unknown;
  resultInputHash: string | null;
  resultJevEvaluationId: string | null;
  resultMuseEvaluationId: string | null;
  jev: {
    id: string | null;
    signalId: string | null;
    inputHash: string | null;
    decision: string | null;
    error: string | null;
  };
  muse: {
    id: string | null;
    signalId: string | null;
    inputHash: string | null;
    decision: string | null;
    error: string | null;
  };
  signalId: string | null;
}

/** Source revision, hash, and evaluation pointers must all be current. */
export function hasCurrentReviewLinkage(value: CurrentReviewLinkage): boolean {
  const hash = value.stateInputHash;
  return (
    value.phase === "settled" &&
    hash !== null &&
    value.signalId !== null &&
    value.stateSourceRevision !== null &&
    value.signalSourceRevision !== null &&
    value.stateSourceRevision === value.signalSourceRevision &&
    reviewInputManifestMatchesSourceRevision(
      value.inputManifest,
      value.stateSourceRevision,
    ) &&
    value.resultInputHash === hash &&
    value.stateJevEvaluationId !== null &&
    value.resultJevEvaluationId === value.stateJevEvaluationId &&
    value.resultMuseEvaluationId !== null &&
    value.jev.id === value.resultJevEvaluationId &&
    value.muse.id === value.resultMuseEvaluationId &&
    value.jev.signalId === value.signalId &&
    value.muse.signalId === value.signalId &&
    value.jev.inputHash === hash &&
    value.muse.inputHash === hash &&
    value.jev.error === null &&
    value.muse.error === null &&
    value.jev.decision !== null &&
    value.muse.decision !== null
  );
}

/** Current review proof also requires the caller's expected model/policy contract. */
export function isCurrentReviewLinkage(
  value: CurrentReviewLinkage,
  expectedContract: ExpectedFaaReviewInputContract | null,
): boolean {
  return (
    hasCurrentReviewLinkage(value) &&
    matchesExpectedReviewInputContract(value.inputManifest, expectedContract)
  );
}

/** SQL fragment ranking a tier string without downgrading on merge. */
export type TierRankExpr = SQL;

function tierRankExpr(columnRef: string): TierRankExpr {
  return sql.raw(
    `(CASE ${columnRef} WHEN 'reference' THEN 4 WHEN 'high_interest' THEN 3 WHEN 'evaluate' THEN 2 ELSE 1 END)`,
  );
}

/** SQL fragment unioning two JSONB string arrays with dedupe. */
export type JsonbArrayUnionExpr = SQL;

function jsonbArrayUnionExpr(column: string): JsonbArrayUnionExpr {
  return sql.raw(
    `(SELECT COALESCE(jsonb_agg(DISTINCT e), '[]'::jsonb) FROM jsonb_array_elements_text(COALESCE("unified_targets"."${column}", '[]'::jsonb) || COALESCE(excluded."${column}", '[]'::jsonb)) AS u(e))`,
  );
}

const MACHINE_ONLY_PROJECTION_SQL = sql`
  COALESCE("unified_targets"."origins", '[]'::jsonb) <@ '["faa_ensemble"]'::jsonb
  AND "unified_targets"."golden_v1_member" = false
  AND COALESCE("unified_targets"."pipeline_decision", 'unreviewed') = 'unreviewed'
  AND NOT EXISTS (
    SELECT 1
    FROM candidates candidate
    WHERE candidate.id = "unified_targets"."candidate_id"
      AND candidate.tier_source::text = 'human'
  )
`;

/**
 * Ownership merge: any non-unknown value wins over unknown. When both sides
 * are known the existing row wins (first writer retains precision).
 * Pipeline-decision merge: terminal passes (pass_acquired, pass_scale,
 * pass_dead, pass_sector) outrank add, which outranks hold, which outranks
 * unreviewed. `add` is only ever written from an explicit investor verdict,
 * never derived automatically, so it can safely outrank hold/unreviewed here.
 */
/** SQL fragment ranking a pipeline_decision: terminal passes > add > hold > unreviewed. */
function pipelineDecisionRankExpr(columnRef: string): SQL {
  return sql.raw(
    `(CASE ${columnRef} WHEN 'pass_acquired' THEN 4 WHEN 'pass_scale' THEN 4 WHEN 'pass_dead' THEN 4 WHEN 'pass_sector' THEN 4 WHEN 'add' THEN 3 WHEN 'hold' THEN 2 ELSE 1 END)`,
  );
}

/**
 * Insert one target while keeping source identity/provenance additive.
 * Current ensemble fields replace older machine-only projections, including
 * with NULL. Rationale from curated/candidate, reference, or human-protected
 * records remains durable across an ensemble refresh. The population
 * entrypoint separately clears stale machine-only assessment state.
 */
export async function upsertUnifiedTarget(
  db: Database,
  input: UpsertUnifiedTargetInput,
): Promise<UnifiedTarget> {
  const { normalizedName, ...rest } = input;
  const values = {
    ...rest,
    normalizedName: normalizedName ?? normalizeTargetName(input.companyName),
  };
  const rows = await db
    .insert(unifiedTargets)
    .values(values)
    .onConflictDoUpdate({
      target: unifiedTargets.normalizedName,
      setWhere: sql`
        "unified_targets"."domain" IS NULL
        OR excluded."domain" IS NULL
        OR lower(regexp_replace(rtrim("unified_targets"."domain", '.'), '^www\\.', '', 'i'))
          = lower(regexp_replace(rtrim(excluded."domain", '.'), '^www\\.', '', 'i'))
      `,
      set: {
        companyName: sql`excluded."company_name"`,
        domain: sql`COALESCE(excluded."domain", "unified_targets"."domain")`,
        websiteUrl: sql`COALESCE(excluded."website_url", "unified_targets"."website_url")`,
        city: sql`COALESCE(excluded."city", "unified_targets"."city")`,
        stateCode: sql`COALESCE(excluded."state_code", "unified_targets"."state_code")`,
        countryCode: sql`COALESCE(excluded."country_code", "unified_targets"."country_code")`,
        origins: jsonbArrayUnionExpr("origins"),
        goldenV1Member: sql`"unified_targets"."golden_v1_member" OR COALESCE(excluded."golden_v1_member", false)`,
        tier: sql`CASE
          WHEN COALESCE(excluded."origins", '[]'::jsonb) ? 'faa_ensemble'
            AND EXISTS (
              SELECT 1
              FROM candidates candidate
              WHERE candidate.id = "unified_targets"."candidate_id"
                AND candidate.tier_source::text = 'human'
            )
            THEN "unified_targets"."tier"
          WHEN COALESCE(excluded."origins", '[]'::jsonb) ? 'faa_ensemble'
            AND COALESCE("unified_targets"."origins", '[]'::jsonb) <@ '["faa_ensemble"]'::jsonb
            THEN excluded."tier"
          WHEN ${tierRankExpr('excluded."tier"')} > ${tierRankExpr('"unified_targets"."tier"')}
            THEN excluded."tier"
          ELSE "unified_targets"."tier"
        END`,
        investorPriority: sql`CASE
          WHEN COALESCE(excluded."origins", '[]'::jsonb) ? 'faa_ensemble'
            AND EXISTS (
              SELECT 1
              FROM candidates candidate
              WHERE candidate.id = "unified_targets"."candidate_id"
                AND candidate.tier_source::text = 'human'
            )
            THEN "unified_targets"."investor_priority"
          WHEN COALESCE(excluded."origins", '[]'::jsonb) ? 'faa_ensemble'
            AND COALESCE("unified_targets"."origins", '[]'::jsonb) <@ '["faa_ensemble"]'::jsonb
            THEN excluded."investor_priority"
          WHEN "unified_targets"."investor_priority" IS NULL THEN excluded."investor_priority"
          WHEN excluded."investor_priority" IS NULL THEN "unified_targets"."investor_priority"
          WHEN excluded."investor_priority" < "unified_targets"."investor_priority" THEN excluded."investor_priority"
          ELSE "unified_targets"."investor_priority"
        END`,
        oversizeFlag: sql`COALESCE("unified_targets"."oversize_flag", false) OR COALESCE(excluded."oversize_flag", false)`,
        proprietaryBasis: sql`CASE
          WHEN (CASE excluded."proprietary_basis" WHEN 'product' THEN 3 WHEN 'process_only' THEN 2 WHEN 'unknown' THEN 1 ELSE 0 END)
             > (CASE "unified_targets"."proprietary_basis" WHEN 'product' THEN 3 WHEN 'process_only' THEN 2 WHEN 'unknown' THEN 1 ELSE 0 END)
            THEN excluded."proprietary_basis"
          ELSE COALESCE("unified_targets"."proprietary_basis", excluded."proprietary_basis")
        END`,
        pipelineStatus: sql`COALESCE(excluded."pipeline_status", "unified_targets"."pipeline_status")`,
        ownershipStatus: sql`CASE
          WHEN "unified_targets"."ownership_status" IS NULL OR "unified_targets"."ownership_status" = 'unknown' THEN COALESCE(excluded."ownership_status", "unified_targets"."ownership_status")
          WHEN excluded."ownership_status" IS NULL OR excluded."ownership_status" = 'unknown' THEN "unified_targets"."ownership_status"
          ELSE "unified_targets"."ownership_status"
        END`,
        pipelineDecision: sql`CASE WHEN ${pipelineDecisionRankExpr('excluded."pipeline_decision"')} > ${pipelineDecisionRankExpr('"unified_targets"."pipeline_decision"')} THEN excluded."pipeline_decision" ELSE "unified_targets"."pipeline_decision" END`,
        fit: sql`COALESCE(excluded."fit", "unified_targets"."fit")`,
        novelty: sql`COALESCE(excluded."novelty", "unified_targets"."novelty")`,
        confidence: sql`COALESCE(excluded."confidence", "unified_targets"."confidence")`,
        actionability: sql`COALESCE(excluded."actionability", "unified_targets"."actionability")`,
        ensembleDecision: sql`CASE
          WHEN COALESCE(excluded."origins", '[]'::jsonb) ? 'faa_ensemble'
            THEN excluded."ensemble_decision"
          ELSE COALESCE(excluded."ensemble_decision", "unified_targets"."ensemble_decision")
        END`,
        ensembleConfidence: sql`CASE
          WHEN COALESCE(excluded."origins", '[]'::jsonb) ? 'faa_ensemble'
            THEN excluded."ensemble_confidence"
          ELSE COALESCE(excluded."ensemble_confidence", "unified_targets"."ensemble_confidence")
        END`,
        whyInteresting: sql`CASE
          WHEN COALESCE(excluded."origins", '[]'::jsonb) ? 'faa_ensemble'
            AND ${MACHINE_ONLY_PROJECTION_SQL}
            THEN excluded."why_interesting"
          ELSE COALESCE("unified_targets"."why_interesting", excluded."why_interesting")
        END`,
        risks: sql`CASE
          WHEN COALESCE(excluded."origins", '[]'::jsonb) ? 'faa_ensemble'
            AND ${MACHINE_ONLY_PROJECTION_SQL}
            THEN excluded."risks"
          ELSE COALESCE("unified_targets"."risks", excluded."risks")
        END`,
        unknowns: sql`CASE
          WHEN COALESCE(excluded."origins", '[]'::jsonb) ? 'faa_ensemble'
            AND ${MACHINE_ONLY_PROJECTION_SQL}
            THEN excluded."unknowns"
          ELSE COALESCE("unified_targets"."unknowns", excluded."unknowns")
        END`,
        evidenceUrls: jsonbArrayUnionExpr("evidence_urls"),
        companyId: sql`COALESCE(excluded."company_id", "unified_targets"."company_id")`,
        signalId: sql`COALESCE(excluded."signal_id", "unified_targets"."signal_id")`,
        candidateId: sql`COALESCE(excluded."candidate_id", "unified_targets"."candidate_id")`,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  const row = rows[0];
  if (row !== undefined) return row;
  const preserved = await getUnifiedTarget(db, values.normalizedName);
  if (preserved !== null) return preserved;
  throw new Error(
    `unified_targets upsert returned no row for ${values.normalizedName}`,
  );
}

/** Read one target by company name (normalized before lookup). */
export async function getUnifiedTarget(
  db: Database,
  name: string,
): Promise<UnifiedTarget | null> {
  const rows = await db
    .select()
    .from(unifiedTargets)
    .where(eq(unifiedTargets.normalizedName, normalizeTargetName(name)))
    .limit(1);
  return rows[0] ?? null;
}

/** List targets, optionally filtered by tier, alphabetically, capped. */
export async function listUnifiedTargets(
  db: Database,
  tier?: UnifiedTargetTier,
  limit = 50,
): Promise<UnifiedTarget[]> {
  const capped = Math.min(Math.max(1, Math.trunc(limit)), 500);
  const base = db.select().from(unifiedTargets);
  if (tier === undefined) {
    return base.orderBy(asc(unifiedTargets.companyName)).limit(capped);
  }
  return base
    .where(eq(unifiedTargets.tier, tier))
    .orderBy(asc(unifiedTargets.companyName))
    .limit(capped);
}

/** Row counts per tier; every tier is present even when empty. */
export async function countByTier(
  db: Database,
): Promise<Record<UnifiedTargetTier, number>> {
  const counts: Record<UnifiedTargetTier, number> = {
    reference: 0,
    high_interest: 0,
    evaluate: 0,
    needs_research: 0,
  };
  const rows = await db
    .select({ tier: unifiedTargets.tier, n: count() })
    .from(unifiedTargets)
    .groupBy(unifiedTargets.tier);
  for (const row of rows) {
    const tier = row.tier as UnifiedTargetTier;
    if (tier in counts) counts[tier] = Number(row.n);
  }
  return counts;
}
