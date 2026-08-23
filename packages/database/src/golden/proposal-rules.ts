import type {
  BuildToPrintRisk,
  GoldenExampleType,
  LabelScale,
} from "@asi/contracts";

/**
 * Proposed-label RULES for golden examples — pure, deterministic, no model
 * calls. The Grata sheet's standardized `Ownership` value drives everything:
 *
 * - "Public Subsidiary" → ideal archetype but unactionable (public parent
 *   makes the target impossible to acquire); actionability negative.
 * - "Private Equity Add-On" | "Investor Backed" → positive target with a
 *   sponsor caveat; actionability neutral.
 * - anything else (Private/Bootstrapped/unknown) → strong positive.
 *
 * build_to_print_risk is always `unknown`: no source column speaks to it and
 * nothing may be invented.
 */
export type ProposalRuleInput = {
  /** Standardized ownership classification, e.g. from the Grata sheet. */
  ownership: string | null;
  /** Direct owner name when known, cited in rationales for traceability. */
  ownerName?: string | null;
};

export type ProposedLabelSet = {
  archetypeFit: LabelScale;
  currentActionability: LabelScale;
  businessModelFit: LabelScale;
  ownershipFit: LabelScale;
  goldenExampleType: GoldenExampleType;
  /** Rules always propose `unknown`; human review may set a real value. */
  buildToPrintRisk: BuildToPrintRisk;
  rationale: string;
};

const PUBLIC_SUBSIDIARY = "public subsidiary";
const SPONSOR_BACKED = ["private equity add-on", "investor backed"] as const;

function contains(value: string | null, needle: string): boolean {
  return value !== null && value.toLowerCase().includes(needle);
}

export function proposeLabels(input: ProposalRuleInput): ProposedLabelSet {
  const ownership = input.ownership === undefined ? null : input.ownership;
  const owner = input.ownerName === undefined ? null : input.ownerName;

  if (contains(ownership, PUBLIC_SUBSIDIARY)) {
    const ownerClause =
      owner === null || owner.trim() === ""
        ? ""
        : ` (owner on record: ${owner.trim()})`;
    return {
      archetypeFit: "strong_positive",
      currentActionability: "negative",
      businessModelFit: "strong_positive",
      ownershipFit: "negative",
      goldenExampleType: "ideal_archetype_but_unactionable",
      buildToPrintRisk: "unknown",
      rationale:
        `Ownership is "${ownership}"${ownerClause} — a publicly held parent ` +
        `makes this profile an ideal archetype that is unactionable as an ` +
        `acquisition target due to its public ownership.`,
    };
  }

  if (SPONSOR_BACKED.some((marker) => contains(ownership, marker))) {
    return {
      archetypeFit: "strong_positive",
      currentActionability: "neutral",
      businessModelFit: "positive",
      ownershipFit: "neutral",
      goldenExampleType: "positive_with_caveat",
      buildToPrintRisk: "unknown",
      rationale:
        `Ownership is "${ownership}" — a sponsor-backed profile fits the ` +
        `target archetype but carries a financial-sponsor caveat: any path ` +
        `runs through an informed owner with a process, not a proprietary ` +
        `opportunity.`,
    };
  }

  const ownershipClause =
    ownership === null || ownership.trim() === ""
      ? "No disqualifying ownership signal"
      : `Ownership is "${ownership}"`;
  return {
    archetypeFit: "strong_positive",
    currentActionability: "positive",
    businessModelFit: "strong_positive",
    ownershipFit: "positive",
    goldenExampleType: "strong_positive",
    buildToPrintRisk: "unknown",
    rationale:
      `${ownershipClause} — clean private-ownership profile matching the ` +
      `golden-set qualifying parameters.`,
  };
}
