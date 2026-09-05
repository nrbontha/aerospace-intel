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
 * Additive evidence classifiers distinguish proprietary manufactured products
 * from proprietary processes, a Products menu from a capabilities-only site,
 * and affirmative size indicators without estimating revenue. The legacy
 * `build_to_print_risk` remains `unknown`: these rules do not invent it.
 */
export type ProposalRuleInput = {
  /** Standardized ownership classification, e.g. from the Grata sheet. */
  ownership: string | null;
  /** Direct owner name when known, cited in rationales for traceability. */
  ownerName?: string | null;
  /**
   * Website, company-description, or source text used only for deterministic
   * keyword classification. An array is concatenated as independent evidence
   * fragments; omitted evidence remains `unknown`.
   */
  keywordEvidence?: string | readonly string[] | null;
  /** Site navigation or page evidence for Products vs capabilities/services. */
  websiteEvidence?: string | readonly string[] | null;
  /** Affirmative employee, revenue, facility, or scale evidence. */
  sizeEvidence?: string | readonly string[] | null;
};

export type ProposedLabelSet = {
  archetypeFit: LabelScale;
  currentActionability: LabelScale;
  businessModelFit: LabelScale;
  ownershipFit: LabelScale;
  goldenExampleType: GoldenExampleType;
  /** Rules always propose `unknown`; human review may set a real value. */
  buildToPrintRisk: BuildToPrintRisk;
  /** Product-IP evidence; `process_only` never represents proprietary product. */
  proprietaryProduct: ProprietaryProduct;
  /** Products navigation is strong product-fit evidence; capabilities-only leans BTP. */
  websiteOffering: WebsiteOffering;
  /** Affirmative categorical size evidence; never an inferred revenue value. */
  sizeEvidence: SizeEvidence;
  rationale: string;
};

export type ProprietaryProduct =
  | "patented_product"
  | "demonstrated_product"
  | "claimed_product"
  | "process_only"
  | "none"
  | "unknown";

export type WebsiteOffering = "products_menu" | "capabilities_only" | "unknown";

export type SizeEvidence = "small_indicators" | "large_indicators" | "unknown";

export type ProposalEvidenceInput =
  string | readonly string[] | null | undefined;

const PUBLIC_SUBSIDIARY = "public subsidiary";
const SPONSOR_BACKED = ["private equity add-on", "investor backed"] as const;

function contains(value: string | null, needle: string): boolean {
  return value !== null && value.toLowerCase().includes(needle);
}

function evidenceText(input: ProposalEvidenceInput): string {
  if (typeof input === "string") return input.toLowerCase();
  if (Array.isArray(input)) {
    return input
      .filter((fragment): fragment is string => typeof fragment === "string")
      .join(" ")
      .toLowerCase();
  }
  return "";
}

const PROCESS_ONLY_KEYWORDS =
  /\b(?:kitting|assembl(?:y|ies)|services?|repair|overhaul|maintenance|mro)\b/i;
const PRODUCT_CATALOG_KEYWORDS =
  /\b(?:products?\s*(?:menu|catalog|catalogue|dropdown|line|lines|page)|product\s+offering|our\s+products?)\b/i;
const PATENTED_PRODUCT_KEYWORDS = /\bpatent(?:ed|s)?\b/i;
const DEMONSTRATED_PRODUCT_KEYWORDS =
  /\b(?:brand(?:ed)?|trademark(?:ed)?|pma|stc|tso)\b/i;
const CLAIMED_PRODUCT_KEYWORDS =
  /\b(?:proprietary\s+(?:products?|components?|parts?|systems?)|manufactur(?:e|es|ed|ing)\s+(?:products?|components?|parts?|systems?)|design(?:ed|s)?\s+(?:products?|components?|parts?|systems?))\b/i;

/**
 * Products/catalog evidence qualifies product-IP keyword evidence. Kitting,
 * assembly, services, and repair alone are a proprietary process, never a
 * proprietary product. A capabilities-only site establishes observed absence
 * of a product offering; no fetched or inconclusive site remains `unknown`.
 */
export function classifyProprietaryProduct(
  keywordEvidence: ProposalEvidenceInput,
  websiteOffering: WebsiteOffering = "unknown",
): ProprietaryProduct {
  const evidence = evidenceText(keywordEvidence);
  const hasCatalog =
    PRODUCT_CATALOG_KEYWORDS.test(evidence) ||
    websiteOffering === "products_menu";

  if (hasCatalog && PATENTED_PRODUCT_KEYWORDS.test(evidence)) {
    return "patented_product";
  }
  if (hasCatalog && DEMONSTRATED_PRODUCT_KEYWORDS.test(evidence)) {
    return "demonstrated_product";
  }
  if (hasCatalog && CLAIMED_PRODUCT_KEYWORDS.test(evidence)) {
    return "claimed_product";
  }
  if (PROCESS_ONLY_KEYWORDS.test(evidence)) return "process_only";
  if (websiteOffering === "capabilities_only") return "none";
  return "unknown";
}

/**
 * A Products menu, dropdown, catalog, or page is a strong fit. Capabilities
 * or services without a Products signal are build-to-print leaning.
 */
export function classifyWebsiteOffering(
  websiteEvidence: ProposalEvidenceInput,
): WebsiteOffering {
  const evidence = evidenceText(websiteEvidence);
  if (/\bproducts?\b/i.test(evidence)) return "products_menu";
  if (/\b(?:capabilities|services?)\b/i.test(evidence)) {
    return "capabilities_only";
  }
  return "unknown";
}

/**
 * Only affirmative source text can establish scale. No revenue number is
 * derived from ownership, facilities, employee bands, or any other proxy.
 */
export function classifySizeEvidence(
  sizeEvidence: ProposalEvidenceInput,
): SizeEvidence {
  const evidence = evidenceText(sizeEvidence);
  const hasLargeEmployees =
    /\b(?:500|[6-9]\d{2}|[1-9]\d{3,})\+?\s+(?:employees?|people|staff|workforce)\b/i.test(
      evidence,
    ) ||
    /\b(?:over|more than|at least)\s+500\s+(?:employees?|people|staff|workforce)\b/i.test(
      evidence,
    );
  const hasLargeRevenue =
    /\$\s*(?:50|[5-9]\d|[1-9]\d{2,})\s*(?:m|million)\b/i.test(evidence) ||
    /\b(?:50|[5-9]\d|[1-9]\d{2,})\s*(?:m|million)\s+(?:in\s+)?revenue\b/i.test(
      evidence,
    );
  const hasPrimeScale = /\b(?:prime[-\s]scale|prime-scale facilities)\b/i.test(
    evidence,
  );

  if (hasLargeEmployees || hasLargeRevenue || hasPrimeScale) {
    return "large_indicators";
  }
  if (
    /\b(?:small (?:business|manufacturer|company|firm)|family[-\s]owned|owner[-\s]operated|under 100 employees?|less than 100 employees?)\b/i.test(
      evidence,
    )
  ) {
    return "small_indicators";
  }
  return "unknown";
}

export function proposeLabels(input: ProposalRuleInput): ProposedLabelSet {
  const ownership = input.ownership === undefined ? null : input.ownership;
  const owner = input.ownerName === undefined ? null : input.ownerName;
  const websiteOffering = classifyWebsiteOffering(input.websiteEvidence);
  const proprietaryProduct = classifyProprietaryProduct(
    input.keywordEvidence,
    websiteOffering,
  );
  const sizeEvidence = classifySizeEvidence(input.sizeEvidence);

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
      proprietaryProduct,
      websiteOffering,
      sizeEvidence,
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
      proprietaryProduct,
      websiteOffering,
      sizeEvidence,
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
    proprietaryProduct,
    websiteOffering,
    sizeEvidence,
    rationale:
      `${ownershipClause} — clean private-ownership profile matching the ` +
      `golden-set qualifying parameters.`,
  };
}
