import { z } from "zod";

import {
  FEATURE_KEYS,
  type FeatureVector,
  isFeatureKey,
} from "./features.js";

/**
 * Scoring program DSL.
 *
 * A program is a declarative, serializable description of ONE axis (fit or
 * actionability). Programs never see raw records, names, domains, or pipeline
 * state — only frozen FeatureVector fields. Evaluation is pure: same program
 * + same vector ⇒ byte-identical result, forever.
 */

export const PROGRAM_AXIS_VALUES = ["fit", "actionability"] as const;
export const MISSING_POLICY_VALUES = [
  "zero",
  "exclude_renormalize",
  "floor_0.5",
] as const;
export const VETO_SEVERITY_VALUES = ["hard", "severe"] as const;

/**
 * A `severe` veto does not remove the company from scoring — it caps the axis
 * score at this ceiling no matter what the component weights say. This is what
 * makes sponsor/strategic/public ownership structurally un-scoreable-around:
 * the cap is applied AFTER aggregation and cannot be out-weighted.
 */
export const SEVERE_VETO_CAP = 25;

export const WEIGHT_SUM_TOLERANCE = 0.01;

const featureRefSchema = z.string();
// Deliberately a plain string: leakageScan() is the enforcement point for the
// FeatureVector allowlist (so that referencing 'pipeline_priority' produces an
// auditable leak finding rather than an opaque parse error).

export const vetoClauseSchema = z.object({
  feature: featureRefSchema,
  operator: z.enum(["in", "equals", "gt", "lt"]),
  value: z.unknown(),
});

export const hardVetoSchema = vetoClauseSchema.extend({
  severity: z.enum(VETO_SEVERITY_VALUES),
  /**
   * Contradictory-evidence escape hatch: if ANY clause here matches, the veto
   * is suppressed. This encodes e.g. "distributor veto fires unless there is
   * proprietary-product evidence contradicting pure distribution".
   */
  unlessAny: z.array(vetoClauseSchema).optional(),
});

export const programComponentSchema = z.object({
  feature: featureRefSchema,
  weight: z.number().finite(),
});

export const programInteractionSchema = z.object({
  features: z.tuple([featureRefSchema, featureRefSchema]),
  weight: z.number().finite(),
});

export const evidenceRequirementSchema = z.object({
  minPrimarySources: z.number().int().gte(0),
  minSources: z.number().int().gte(0),
});

export const scoringProgramSchema = z
  .object({
    name: z.string().min(1).optional(),
    version: z.number().int(),
    axis: z.enum(PROGRAM_AXIS_VALUES),
    hardVetoes: z.array(hardVetoSchema).default([]),
    components: z.array(programComponentSchema).min(1),
    interactions: z.array(programInteractionSchema).default([]),
    /**
     * Features whose absence makes the whole axis UNSCOREABLE (null), distinct
     * from missingPolicy which only handles absent contributions. The default
     * actionability program lists ownership.ownershipType here: with unknown
     * ownership there is NO honest actionability number.
     */
    nullWhenMissing: z.array(z.string()).default([]),
    missingPolicy: z.enum(MISSING_POLICY_VALUES),
    complexityPenalty: z.number().gte(0),
    evidenceRequirement: evidenceRequirementSchema.optional(),
  })
  .strict()
  .refine(
    (program) => {
      const sum =
        program.components.reduce((acc, c) => acc + c.weight, 0) +
        program.interactions.reduce((acc, i) => acc + i.weight, 0);
      return Math.abs(sum - 1) <= WEIGHT_SUM_TOLERANCE;
    },
    {
      message: `component + interaction weights must sum to 1 ± ${WEIGHT_SUM_TOLERANCE}`,
    },
  );

export type ScoringProgram = z.infer<typeof scoringProgramSchema>;
export type ProgramVetoClause = z.infer<typeof vetoClauseSchema>;
export type HardVeto = z.infer<typeof hardVetoSchema>;

/** Parse-validate helper; fills defaulted arrays so literals stay terse. */
export function defineProgram(
  candidate: z.input<typeof scoringProgramSchema> & { name: string },
): ScoringProgram {
  return scoringProgramSchema.parse(candidate);
}

// ---------------------------------------------------------------------------
// Feature value extraction + ordinal semantics
// ---------------------------------------------------------------------------

const MISSING = Symbol("missing");
type Normalized = number | typeof MISSING;

const REVENUE_BAND_SCORE: Record<string, number> = {
  "<5m": 0.75,
  "5-10m": 1,
  "10-20m": 0.85,
  // Sweet spot tapers as deal size grows past ~$20m.
  "20-35m": 0.65,
  "35-50m": 0.4,
};
const EMPLOYEES_BAND_SCORE: Record<string, number> = {
  "<20": 0.8,
  "20-50": 1,
  "50-100": 0.9,
  "100-250": 0.7,
  "250-500": 0.45,
};
const OWNERSHIP_TYPE_SCORE: Record<string, number> = {
  independent_founder: 1,
  independent_family: 0.9,
  pe_owned: 0.2,
  strategic_sub: 0.15,
  public_sub: 0.05,
};

/**
 * Ordinal rank used by 'gt'/'lt' veto operators on band features. `unknown`
 * ranks ABOVE every known band (+Infinity): a '<$50m' style hard requirement
 * expressed as `gt 20-35m` therefore fires for both 35-50m AND unknown — an
 * unknown band can never silently satisfy a bounded requirement.
 */
const BAND_RANK: Record<string, number> = {
  "<5m": 0,
  "<20": 0,
  "5-10m": 1,
  "20-50": 1,
  "10-20m": 2,
  "50-100": 2,
  "20-35m": 3,
  "100-250": 3,
  "35-50m": 4,
  "250-500": 4,
  unknown: Number.POSITIVE_INFINITY,
};

function trileanScore(raw: boolean | "unknown", whenTrue: number, whenFalse: number): Normalized {
  if (raw === "unknown") return MISSING;
  return raw ? whenTrue : whenFalse;
}

/**
 * Map a FeatureVector field to [0,1] fitness-for-purpose, or MISSING.
 * Ordinal choices are documented per line; they encode the investment thesis
 * (privately-held, engineered/proprietary, qualified, <$50m US manufacturers).
 */
export function normalizeFeature(fv: FeatureVector, key: string): Normalized {
  switch (key) {
    case "size.revenueBand":
      return REVENUE_BAND_SCORE[fv.size.revenueBand] ?? MISSING;
    case "size.employeesBand":
      return EMPLOYEES_BAND_SCORE[fv.size.employeesBand] ?? MISSING;
    case "ownership.ownershipType":
      return OWNERSHIP_TYPE_SCORE[fv.ownership.ownershipType] ?? MISSING;
    case "businessModel.distributes_products":
      // Manufacturing your own product line scores above reselling others'.
      return trileanScore(fv.businessModel.distributesProducts, 0.25, 1);
    case "businessModel.pure_service":
      return trileanScore(fv.businessModel.pureService, 0, 1);
    case "businessModel.build_to_print_share":
      switch (fv.businessModel.buildToPrintShare) {
        case "none": return 1;
        case "minor": return 0.7;
        case "major": return 0.15;
        default: return MISSING;
      }
    case "businessModel.proprietary_product_evidence":
      switch (fv.businessModel.proprietaryProductEvidence) {
        case "patented": return 1;
        case "demonstrated": return 0.85;
        case "claimed": return 0.55;
        case "none": return 0;
        default: return MISSING;
      }
    case "qualifications.pma":
    case "qualifications.as9100":
    case "qualifications.nadcap":
    case "qualifications.qpl":
    case "qualifications.oem_approved":
    case "qualifications.itar_signal": {
      const quals: Record<string, string> = {
        "qualifications.pma": fv.qualifications.pma,
        "qualifications.as9100": fv.qualifications.as9100,
        "qualifications.nadcap": fv.qualifications.nadcap,
        "qualifications.qpl": fv.qualifications.qpl,
        "qualifications.oem_approved": fv.qualifications.oemApproved,
        "qualifications.itar_signal": fv.qualifications.itarSignal,
      };
      switch (quals[key]) {
        case "present": return 1;
        case "claimed": return 0.6;
        case "absent": return 0;
        default: return MISSING;
      }
    }
    case "platforms":
      // Named platform positions are scarce; saturate at four.
      return Math.min(fv.platforms.length / 4, 1);
    case "aftermarket":
      return trileanScore(fv.aftermarket, 1, 0.3);
    case "evidence.sourceCount":
      return Math.min(fv.evidence.sourceCount / 6, 1);
    case "evidence.primarySourceCount":
      return Math.min(fv.evidence.primarySourceCount / 3, 1);
    case "evidence.conflictCount":
      return 1 - Math.min(fv.evidence.conflictCount / 3, 1);
    case "evidence.freshestObservationDaysOld":
      if (fv.evidence.freshestObservationDaysOld === null) return MISSING;
      return Math.max(0, 1 - fv.evidence.freshestObservationDaysOld / 1095);
    case "evidence.identityResolved":
      return fv.evidence.identityResolved ? 1 : 0;
    default:
      throw new Error(`normalizeFeature: unknown feature key "${key}"`);
  }
}

function rawFeatureValue(fv: FeatureVector, key: string): unknown {
  switch (key) {
    case "size.revenueBand": return fv.size.revenueBand;
    case "size.employeesBand": return fv.size.employeesBand;
    case "ownership.ownershipType": return fv.ownership.ownershipType;
    case "businessModel.distributes_products": return fv.businessModel.distributesProducts;
    case "businessModel.pure_service": return fv.businessModel.pureService;
    case "businessModel.build_to_print_share": return fv.businessModel.buildToPrintShare;
    case "businessModel.proprietary_product_evidence": return fv.businessModel.proprietaryProductEvidence;
    case "qualifications.pma": return fv.qualifications.pma;
    case "qualifications.as9100": return fv.qualifications.as9100;
    case "qualifications.nadcap": return fv.qualifications.nadcap;
    case "qualifications.qpl": return fv.qualifications.qpl;
    case "qualifications.oem_approved": return fv.qualifications.oemApproved;
    case "qualifications.itar_signal": return fv.qualifications.itarSignal;
    case "platforms": return fv.platforms;
    case "aftermarket": return fv.aftermarket;
    case "evidence.sourceCount": return fv.evidence.sourceCount;
    case "evidence.primarySourceCount": return fv.evidence.primarySourceCount;
    case "evidence.conflictCount": return fv.evidence.conflictCount;
    case "evidence.freshestObservationDaysOld": return fv.evidence.freshestObservationDaysOld;
    case "evidence.identityResolved": return fv.evidence.identityResolved;
    default:
      throw new Error(`rawFeatureValue: unknown feature key "${key}"`);
  }
}

function bandAwareRank(key: string, raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return Number.NaN;
  if (key === "size.revenueBand" || key === "size.employeesBand") {
    return BAND_RANK[raw] ?? Number.NaN;
  }
  return Number.NaN;
}

function clauseMatches(fv: FeatureVector, clause: ProgramVetoClause): boolean {
  if (!isFeatureKey(clause.feature)) return false;
  const raw = rawFeatureValue(fv, clause.feature);
  // Missing facts never satisfy positive matches: 'unknown' trileans/enums
  // fire nothing under equals/in. Band features still participate in gt/lt,
  // where 'unknown' deliberately carries the +Infinity rank (see BAND_RANK).
  if (raw === null || raw === undefined) return false;
  switch (clause.operator) {
    case "equals":
      return raw !== "unknown" && raw === clause.value;
    case "in":
      return (
        raw !== "unknown" &&
        Array.isArray(clause.value) &&
        clause.value.includes(raw)
      );
    case "gt":
      return bandAwareRank(clause.feature, raw) > bandAwareRank(clause.feature, clause.value);
    case "lt":
      return bandAwareRank(clause.feature, raw) < bandAwareRank(clause.feature, clause.value);
    default:
      return false;
  }
}

export function vetoRuleKey(clause: Pick<HardVeto, "feature" | "operator">): string {
  return `${clause.feature}:${clause.operator}`;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface ProgramContribution {
  feature: string;
  weight: number;
  /** Normalized [0,1] value, or null when the fact was missing. */
  value: number | null;
  contribution: number;
}

export interface MissingHandling {
  feature: string;
  handling: "zero" | "excluded_renormalized" | "floored_0.5" | "required_null";
}

export interface ProgramEvaluation {
  /** 0..100, or null when the axis is un-scoreable for this vector. */
  score: number | null;
  veto?: { rule: string; reason: string };
  contributions: ProgramContribution[];
  missingHandled: MissingHandling[];
}

export function leakageScan(program: ScoringProgram): {
  clean: boolean;
  leaked: string[];
} {
  const referenced: string[] = [];
  for (const v of program.hardVetoes) {
    referenced.push(v.feature);
    for (const u of v.unlessAny ?? []) referenced.push(u.feature);
  }
  for (const c of program.components) referenced.push(c.feature);
  for (const i of program.interactions) {
    referenced.push(i.features[0], i.features[1]);
  }
  referenced.push(...program.nullWhenMissing);

  const allowlist = FEATURE_KEYS as readonly string[];
  const leaked = [...new Set(referenced.filter((key) => !allowlist.includes(key)))];
  return { clean: leaked.length === 0, leaked };
}

interface WeightedTerm {
  kind: "component" | "interaction";
  weight: number;
  features: string[];
}

function evaluateTerms(program: ScoringProgram): WeightedTerm[] {
  const terms: WeightedTerm[] = program.components.map((c) => ({
    kind: "component",
    weight: c.weight,
    features: [c.feature],
  }));
  for (const i of program.interactions) {
    terms.push({ kind: "interaction", weight: i.weight, features: [...i.features] });
  }
  return terms;
}

/**
 * Pure, deterministic, total evaluation of one axis program against one
 * frozen feature vector. Throws only on programs leaking non-feature fields —
 * a program bug, never a data condition.
 */
export function evaluateProgram(
  program: ScoringProgram,
  fv: FeatureVector,
): ProgramEvaluation {
  const leak = leakageScan(program);
  if (!leak.clean) {
    throw new Error(
      `evaluateProgram: program references non-feature fields: ${leak.leaked.join(", ")}`,
    );
  }

  // 1. Hard vetoes: any hit makes the axis un-scoreable outright.
  for (const rule of program.hardVetoes) {
    const contradicted = (rule.unlessAny ?? []).some((u) => clauseMatches(fv, u));
    if (contradicted || !clauseMatches(fv, rule)) continue;
    if (rule.severity === "hard") {
      return {
        score: null,
        veto: {
          rule: vetoRuleKey(rule),
          reason: `hard veto: ${rule.feature} ${rule.operator} ${JSON.stringify(rule.value)}`,
        },
        contributions: [],
        missingHandled: [],
      };
    }
    // severity 'severe': keep scoring; the post-aggregation cap below makes
    // the ceiling un-scoreable-around regardless of component weights.
  }

  // 2. Required-feature nullability (e.g. unknown ownership → no actionability).
  const missingHandled: MissingHandling[] = [];
  for (const required of program.nullWhenMissing) {
    if (normalizeFeature(fv, required) === MISSING) {
      return {
        score: null,
        veto: {
          rule: "required_feature_missing",
          reason: `required feature ${required} is unknown; axis is un-scoreable`,
        },
        contributions: [],
        missingHandled: [{ feature: required, handling: "required_null" }],
      };
    }
  }

  // 3. Evidence floor.
  if (program.evidenceRequirement) {
    const { minSources, minPrimarySources } = program.evidenceRequirement;
    if (
      fv.evidence.sourceCount < minSources ||
      fv.evidence.primarySourceCount < minPrimarySources
    ) {
      return {
        score: null,
        veto: {
          rule: "evidence_requirement",
          reason: `insufficient evidence: ${fv.evidence.sourceCount} sources (${fv.evidence.primarySourceCount} primary) < required ${minSources} (${minPrimarySources} primary)`,
        },
        contributions: [],
        missingHandled: [],
      };
    }
  }

  // 4. Weighted aggregation under the chosen missing policy.
  const policy = program.missingPolicy;
  const terms = evaluateTerms(program);
  let numerator = 0;
  let denominator = 0;
  const contributions: ProgramContribution[] = [];

  for (const term of terms) {
    const values = term.features.map((f) => normalizeFeature(fv, f));
    for (let idx = 0; idx < term.features.length; idx += 1) {
      const feature = term.features[idx];
      if (feature !== undefined && values[idx] === MISSING) {
        missingHandled.push({
          feature,
          handling:
            policy === "zero"
              ? "zero"
              : policy === "exclude_renormalize"
                ? "excluded_renormalized"
                : "floored_0.5",
        });
      }
    }

    let termValue: number | typeof MISSING;
    if (term.kind === "component") {
      const first = values[0];
      termValue = first === undefined ? MISSING : first;
    } else {
      const allPresent = values.every((v) => v !== MISSING);
      if (allPresent) {
        termValue = values.reduce<number>((acc, v) => acc * (v as number), 1);
      } else if (policy === "floor_0.5") {
        termValue = values.reduce<number>(
          (acc, v) => acc * (v === MISSING || v === undefined ? 0.5 : v),
          1,
        );
      } else {
        termValue = MISSING;
      }
    }

    if (termValue === MISSING && policy === "exclude_renormalize") {
      continue; // drops from the denominator as well
    }
    const effective =
      termValue === MISSING
        ? policy === "zero"
          ? 0
          : 0.5
        : (termValue as number);

    denominator += term.weight;
    numerator += term.weight * effective;
    if (term.kind === "component") {
      contributions.push({
        feature: term.features[0] as string,
        weight: term.weight,
        value: values[0] === MISSING || values[0] === undefined ? null : (values[0] as number),
        contribution: term.weight * effective,
      });
    }
  }

  if (denominator <= 0) {
    return {
      score: null,
      veto: { rule: "no_scoring_terms", reason: "every component was excluded under exclude_renormalize" },
      contributions,
      missingHandled,
    };
  }

  let score = (numerator / denominator) * 100;
  let severeVeto: ProgramEvaluation["veto"];
  for (const rule of program.hardVetoes) {
    if (rule.severity !== "severe") continue;
    const contradicted = (rule.unlessAny ?? []).some((u) => clauseMatches(fv, u));
    if (!contradicted && clauseMatches(fv, rule)) {
      score = Math.min(score, SEVERE_VETO_CAP);
      severeVeto = {
        rule: vetoRuleKey(rule),
        reason: `severe veto: score capped at ${SEVERE_VETO_CAP} (${rule.feature} ${rule.operator} ${JSON.stringify(rule.value)})`,
      };
    }
  }
  score = Math.min(100, Math.max(0, score));

  return severeVeto
    ? { score, contributions, missingHandled, veto: severeVeto }
    : { score, contributions, missingHandled };
}

// ---------------------------------------------------------------------------
// Default programs (validated at module load — they must always parse)
// ---------------------------------------------------------------------------

/**
 * Default FIT program. Encodes the golden-set thesis: independent, sub-$50m,
 * engineering/proprietary-driven, qualified US manufacturers. Pure-distributor
 * and pure build-to-print shops are hard vetoes (with a contradictory-evidence
 * escape via demonstrated/patented proprietary products); revenue >$50m OR
 * UNKNOWN fails the <$50m requirement (BAND_RANK puts unknown at +Infinity).
 */
export const DEFAULT_FIT_PROGRAM: ScoringProgram = scoringProgramSchema.parse({
  name: "default-fit-v1",
  version: 1,
  axis: "fit",
  missingPolicy: "exclude_renormalize",
  complexityPenalty: 0.05,
  hardVetoes: [
    {
      feature: "businessModel.distributes_products",
      operator: "in",
      value: [true],
      severity: "hard",
      // Contradictory evidence: patented/demonstrated own products mean this
      // is not a PURE distributor even if distribution is observed.
      unlessAny: [
        {
          feature: "businessModel.proprietary_product_evidence",
          operator: "in",
          value: ["claimed", "demonstrated", "patented"],
        },
      ],
    },
    {
      feature: "businessModel.build_to_print_share",
      operator: "equals",
      value: "major",
      severity: "hard",
      unlessAny: [
        {
          feature: "businessModel.proprietary_product_evidence",
          operator: "in",
          value: ["demonstrated", "patented"],
        },
      ],
    },
    {
      // "<$50m" hard requirement. Fires for 35-50m and — deliberately — for
      // unknown, which can never satisfy the bound (see BAND_RANK).
      feature: "size.revenueBand",
      operator: "gt",
      value: "20-35m",
      severity: "hard",
    },
  ],
  components: [
    { feature: "ownership.ownershipType", weight: 0.18 },
    { feature: "size.revenueBand", weight: 0.1 },
    { feature: "businessModel.proprietary_product_evidence", weight: 0.2 },
    { feature: "businessModel.build_to_print_share", weight: 0.12 },
    { feature: "qualifications.pma", weight: 0.08 },
    { feature: "qualifications.as9100", weight: 0.06 },
    { feature: "qualifications.nadcap", weight: 0.04 },
    { feature: "qualifications.qpl", weight: 0.03 },
    { feature: "qualifications.oem_approved", weight: 0.05 },
    { feature: "aftermarket", weight: 0.06 },
    { feature: "platforms", weight: 0.04 },
    { feature: "evidence.primarySourceCount", weight: 0.04 },
  ],
});

/**
 * Default ACTIONABILITY program. Can we actually DO something with this
 * company? Independence dominates; unknown ownership nulls the axis entirely;
 * sponsor/strategic/public ownership caps the score at 25 regardless of
 * anything else.
 */
export const DEFAULT_ACTIONABILITY_PROGRAM: ScoringProgram = scoringProgramSchema.parse({
  name: "default-actionability-v1",
  version: 1,
  axis: "actionability",
  missingPolicy: "zero",
  complexityPenalty: 0.03,
  nullWhenMissing: ["ownership.ownershipType"],
  hardVetoes: [
    {
      // Sponsor (PE), strategic, and public ownership cannot yield an
      // actionable score above SEVERE_VETO_CAP — un-scoreable-around by
      // construction (post-aggregation cap, not a weight).
      feature: "ownership.ownershipType",
      operator: "in",
      value: ["pe_owned", "strategic_sub", "public_sub"],
      severity: "severe",
    },
    {
      // A pure reseller is not an actionable supplier target.
      feature: "businessModel.distributes_products",
      operator: "equals",
      value: true,
      severity: "hard",
      unlessAny: [
        {
          feature: "businessModel.proprietary_product_evidence",
          operator: "in",
          value: ["demonstrated", "patented"],
        },
      ],
    },
  ],
  components: [
    { feature: "ownership.ownershipType", weight: 0.45 },
    { feature: "size.revenueBand", weight: 0.15 },
    { feature: "aftermarket", weight: 0.1 },
    { feature: "businessModel.build_to_print_share", weight: 0.1 },
    { feature: "businessModel.proprietary_product_evidence", weight: 0.1 },
    { feature: "qualifications.oem_approved", weight: 0.05 },
    { feature: "evidence.sourceCount", weight: 0.05 },
  ],
});
