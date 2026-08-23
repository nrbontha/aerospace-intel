import { z } from "zod";

/**
 * Frozen feature schema version for the axial scoring engine.
 *
 * Bump this whenever the FeatureVector shape or the ordinal semantics of any
 * band/enum changes; scoring programs and frozen datasets are pinned to a
 * version so old evaluations stay reproducible.
 */
export const FEATURE_SCHEMA_VERSION = "v1";

export const REVENUE_BAND_VALUES = [
  "<5m",
  "5-10m",
  "10-20m",
  "20-35m",
  "35-50m",
  "unknown",
] as const;
export const EMPLOYEES_BAND_VALUES = [
  "<20",
  "20-50",
  "50-100",
  "100-250",
  "250-500",
  "unknown",
] as const;
export const OWNERSHIP_TYPE_VALUES = [
  "independent_founder",
  "independent_family",
  "pe_owned",
  "strategic_sub",
  "public_sub",
  "unknown",
] as const;
export const BUILD_TO_PRINT_SHARE_VALUES = [
  "none",
  "minor",
  "major",
  "unknown",
] as const;
export const PROPRIETARY_EVIDENCE_VALUES = [
  "none",
  "claimed",
  "demonstrated",
  "patented",
] as const;
export const QUALIFICATION_STATUS_VALUES = [
  "present",
  "claimed",
  "absent",
  "unknown",
] as const;

/**
 * Boolean-or-'unknown' trilean. `unknown` MUST be explicit: absence of
 * evidence is never coerced to false (or true) anywhere in the engine.
 */
export const boolOrUnknownSchema = z.union([
  z.boolean(),
  z.literal("unknown"),
]);

const qualificationStatusSchema = z.enum(QUALIFICATION_STATUS_VALUES);

export const featureVectorSchema = z
  .object({
    /**
     * Identity strings ride along for joins/display ONLY. They are NOT in the
     * scoring-feature allowlist (`FEATURE_KEYS`) and any program referencing
     * them fails leakageScan — company names/domains are not evidence.
     */
    identity: z
      .object({
        domain: z.string(),
        cage: z.string().optional(),
        uei: z.string().optional(),
      })
      .strict(),
    size: z
      .object({
        revenueBand: z.enum(REVENUE_BAND_VALUES),
        employeesBand: z.enum(EMPLOYEES_BAND_VALUES),
      })
      .strict(),
    ownership: z
      .object({
        // `unknown` must be explicit — never defaulted from other fields.
        ownershipType: z.enum(OWNERSHIP_TYPE_VALUES),
      })
      .strict(),
    businessModel: z
      .object({
        distributesProducts: boolOrUnknownSchema,
        pureService: boolOrUnknownSchema,
        buildToPrintShare: z.enum(BUILD_TO_PRINT_SHARE_VALUES),
        proprietaryProductEvidence: z.enum(PROPRIETARY_EVIDENCE_VALUES),
      })
      .strict(),
    qualifications: z
      .object({
        pma: qualificationStatusSchema,
        as9100: qualificationStatusSchema,
        nadcap: qualificationStatusSchema,
        qpl: qualificationStatusSchema,
        oemApproved: qualificationStatusSchema,
        itarSignal: qualificationStatusSchema,
      })
      .strict(),
    platforms: z.array(z.string()).max(20),
    aftermarket: boolOrUnknownSchema,
    evidence: z
      .object({
        sourceCount: z.number().int().gte(0),
        primarySourceCount: z.number().int().gte(0),
        conflictCount: z.number().int().gte(0),
        freshestObservationDaysOld: z.number().int().gte(0).nullable(),
        identityResolved: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type FeatureVector = z.infer<typeof featureVectorSchema>;
export type RevenueBand = (typeof REVENUE_BAND_VALUES)[number];
export type EmployeesBand = (typeof EMPLOYEES_BAND_VALUES)[number];
export type OwnershipType = (typeof OWNERSHIP_TYPE_VALUES)[number];
export type QualificationStatus = (typeof QUALIFICATION_STATUS_VALUES)[number];

/**
 * The closed allowlist of feature references a ScoringProgram may touch.
 *
 * Deliberately EXCLUDES every identity string (domain / CAGE / UEI / name) and
 * any operational pipeline field (priority, stage, contact recency, …): those
 * are outcomes or bookkeeping, never scoring inputs. leakageScan() enforces
 * this list and evaluateProgram() refuses to run a leaked program.
 */
export const FEATURE_KEYS = [
  "size.revenueBand",
  "size.employeesBand",
  "ownership.ownershipType",
  "businessModel.distributes_products",
  "businessModel.pure_service",
  "businessModel.build_to_print_share",
  "businessModel.proprietary_product_evidence",
  "qualifications.pma",
  "qualifications.as9100",
  "qualifications.nadcap",
  "qualifications.qpl",
  "qualifications.oem_approved",
  "qualifications.itar_signal",
  "platforms",
  "aftermarket",
  "evidence.sourceCount",
  "evidence.primarySourceCount",
  "evidence.conflictCount",
  "evidence.freshestObservationDaysOld",
  "evidence.identityResolved",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

// Type guard preserving narrowing — used by leakageScan and evaluateProgram.
export function isFeatureKey(key: string): key is FeatureKey {
  return (FEATURE_KEYS as readonly string[]).includes(key);
}

function requireEnum<T extends string>(
  raw: unknown,
  field: string,
  values: readonly T[],
): T {
  if (raw === null || raw === undefined) return "unknown" as T;
  if (typeof raw === "string" && (values as readonly string[]).includes(raw)) {
    return raw as T;
  }
  throw new Error(
    `extractFeatureVector: invalid value for ${field}: ${JSON.stringify(raw)}`,
  );
}

function requireBoolOrUnknown(raw: unknown, field: string): boolean | "unknown" {
  if (raw === null || raw === undefined) return "unknown";
  if (typeof raw === "boolean") return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "unknown") return "unknown";
  throw new Error(
    `extractFeatureVector: invalid boolean for ${field}: ${JSON.stringify(raw)}`,
  );
}
function requireInt(raw: unknown, field: string, fallback?: number): number {
  if ((raw === null || raw === undefined) && fallback !== undefined) {
    return fallback;
  }
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return raw;
  if (typeof raw === "string" && /^-?\d+$/.test(raw.trim())) {
    const parsed = Number.parseInt(raw, 10);
    if (parsed >= 0) return parsed;
  }
  throw new Error(
    `extractFeatureVector: invalid non-negative integer for ${field}: ${JSON.stringify(raw)}`,
  );
}

function optString(raw: unknown): string | undefined {
  if (typeof raw === "string" && raw.length > 0) return raw;
  return undefined;
}

function subRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null
    ? (raw as Record<string, unknown>)
    : {};
}

const KNOWN_RAW_KEYS: Record<string, true> = {
  identity: true,
  domain: true,
  company_name: true,
  cage: true,
  uei: true,
  revenue_band: true,
  revenueBand: true,
  employees_band: true,
  employeesBand: true,
  ownership_type: true,
  ownershipType: true,
  distributes_products: true,
  distributesProducts: true,
  pure_service: true,
  pureService: true,
  build_to_print_share: true,
  buildToPrintShare: true,
  proprietary_product_evidence: true,
  qualifications: true,
  platforms: true,
  aftermarket: true,
  source_count: true,
  primary_source_count: true,
  conflict_count: true,
  freshest_observation_days_old: true,
  freshestObservationDaysOld: true,
  identity_resolved: true,
};


/**
 * THE single future DB-mapping choke point.
 *
 * Everything downstream (programs, axes, priorities, evaluation harness)
 * consumes FeatureVectors exclusively. When the database is wired up, only
 * this function learns about row shapes; no SQL result ever reaches a scorer
 * directly. Missing/null inputs become the EXPLICIT `unknown` members — the
 * engine never guesses a default ownership, revenue band, or capability.
 *
 * Accepted input keys (flat or nested): identity{domain,cage,uei},
 * revenue_band/revenueBand, employees_band/employeesBand, ownership_type/
 * ownershipType, distributes_products, pure_service, build_to_print_share,
 * proprietary_product_evidence, qualifications{pma,as9100,nadcap,qpl,
 * oem_approved,oemApproved,itar_signal,itarSignal}, platforms, aftermarket,
 * source_count, primary_source_count, conflict_count,
 * freshest_observation_days_old, identity_resolved.
 */
export function extractFeatureVector(
  rawRecord: Record<string, unknown>,
): FeatureVector {
  // Typo guard: an unrecognized key is a mapping bug, not a silent no-op.
  for (const key of Object.keys(rawRecord)) {
    if (KNOWN_RAW_KEYS[key] !== true) {
      throw new Error(`extractFeatureVector: unrecognized input key "${key}"`);
    }
  }
  const identity = subRecord(rawRecord.identity);
  const qualifications = subRecord(rawRecord.qualifications);
  const evidence = subRecord(rawRecord.evidence);

  const daysOldRaw =
    rawRecord.freshest_observation_days_old ??
    rawRecord.freshestObservationDaysOld ??
    evidence.freshestObservationDaysOld;
  const daysOld =
    daysOldRaw === null || daysOldRaw === undefined
      ? null
      : requireInt(daysOldRaw, "freshest_observation_days_old");

  const candidate = {
    identity: {
      domain:
        optString(identity.domain) ??
        optString(rawRecord.domain) ??
        optString(rawRecord.company_name) ??
        "",
      cage: optString(identity.cage) ?? optString(rawRecord.cage),
      uei: optString(identity.uei) ?? optString(rawRecord.uei),
    },
    size: {
      revenueBand: requireEnum(
        rawRecord.revenue_band ?? rawRecord.revenueBand,
        "revenue_band",
        REVENUE_BAND_VALUES,
      ),
      employeesBand: requireEnum(
        rawRecord.employees_band ?? rawRecord.employeesBand,
        "employees_band",
        EMPLOYEES_BAND_VALUES,
      ),
    },
    ownership: {
      ownershipType: requireEnum(
        rawRecord.ownership_type ?? rawRecord.ownershipType,
        "ownership_type",
        OWNERSHIP_TYPE_VALUES,
      ),
    },
    businessModel: {
      distributesProducts: requireBoolOrUnknown(
        rawRecord.distributes_products ?? rawRecord.distributesProducts,
        "distributes_products",
      ),
      pureService: requireBoolOrUnknown(
        rawRecord.pure_service ?? rawRecord.pureService,
        "pure_service",
      ),
      buildToPrintShare: requireEnum(
        rawRecord.build_to_print_share ?? rawRecord.buildToPrintShare,
        "build_to_print_share",
        BUILD_TO_PRINT_SHARE_VALUES,
      ),
      // This enum has no 'unknown' member by design: 'none' IS its null
      // state ("no proprietary-product evidence on file").
      proprietaryProductEvidence: requireEnum(
        rawRecord.proprietary_product_evidence ??
          rawRecord.proprietaryProductEvidence ??
          "none",
        "proprietary_product_evidence",
        PROPRIETARY_EVIDENCE_VALUES,
      ),
    },
    qualifications: {
      pma: requireEnum(qualifications.pma, "qualifications.pma", QUALIFICATION_STATUS_VALUES),
      as9100: requireEnum(qualifications.as9100, "qualifications.as9100", QUALIFICATION_STATUS_VALUES),
      nadcap: requireEnum(qualifications.nadcap, "qualifications.nadcap", QUALIFICATION_STATUS_VALUES),
      qpl: requireEnum(qualifications.qpl, "qualifications.qpl", QUALIFICATION_STATUS_VALUES),
      oemApproved: requireEnum(
        qualifications.oem_approved ?? qualifications.oemApproved,
        "qualifications.oem_approved",
        QUALIFICATION_STATUS_VALUES,
      ),
      itarSignal: requireEnum(
        qualifications.itar_signal ?? qualifications.itarSignal,
        "qualifications.itar_signal",
        QUALIFICATION_STATUS_VALUES,
      ),
    },
    platforms: Array.isArray(rawRecord.platforms)
      ? rawRecord.platforms.map((p) => String(p))
      : [],
    aftermarket: requireBoolOrUnknown(rawRecord.aftermarket, "aftermarket"),
    evidence: {
      // Absent count keys mean "no known sources" — a real 0, not unknown.
      sourceCount: requireInt(
        rawRecord.source_count ?? evidence.sourceCount,
        "source_count",
        0,
      ),
      primarySourceCount: requireInt(
        rawRecord.primary_source_count ?? evidence.primarySourceCount,
        "primary_source_count",
        0,
      ),
      conflictCount: requireInt(
        rawRecord.conflict_count ?? evidence.conflictCount,
        "conflict_count",
        0,
      ),
      freshestObservationDaysOld: daysOld,
      identityResolved:
        requireBoolOrUnknown(
          rawRecord.identity_resolved ?? evidence.identityResolved,
          "identity_resolved",
        ) === true,
    },
  };

  return featureVectorSchema.parse(candidate);
}
