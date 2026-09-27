/**
 * FROZEN v1 dataset: all 29 Booie-reviewed names from the 2026-09-09
 * "Nikhil New Targets" investor review (ADCO MA Pipeline workbook).
 *
 * Source of truth: `packages/database/src/unified-targets/populate.ts`
 * (ROUND2_ACQUIRED_MAP, ROUND2_ADD_KEYS, ROUND2_HOLD_KEYS,
 * ROUND2_DEAD_KEYS, ROUND2_SECTOR_ENTRIES) and the shared-contract owner
 * map in `scripts/import-investor-feedback.mts` (OWNER_MAP_ENTRIES).
 * Owner strings and acquisition years follow Booie's commentary verbatim;
 * year is null where no year was stated.
 *
 * Split: every row is 'test'. This set is HELD-OUT — never tune thresholds,
 * weights, or program rules against it; report metrics only.
 *
 * DO NOT edit these rows casually: they encode frozen investor ground truth
 * and define the held-out baseline for scoring-axial validation.
 */

export const DATASET_VERSION = "investor-verdicts-v1";

/** Dataset split for every row in this file. Held-out: never tune against it. */
export const INVESTOR_VERDICT_SPLIT = "test" as const;
export type InvestorVerdictSplit = typeof INVESTOR_VERDICT_SPLIT;

export type InvestorVerdict =
  "add" | "hold" | "pass_acquired" | "pass_dead" | "pass_sector";

export type ExpectedOwnershipStatus =
  | "independent"
  | "pe_owned"
  | "strategic_owned"
  | "public"
  | "dead"
  | "unknown";

export type ExpectedPipelineDecision =
  "add" | "hold" | "pass_acquired" | "pass_dead" | "pass_sector";

export interface InvestorVerdictEntry {
  /** Company name as reviewed (matches the Nikhil New Targets sheet). */
  name: string;
  /** Booie's verdict for this name. */
  verdict: InvestorVerdict;
  /** Acquiring owner exactly as named in Booie's commentary, else null. */
  owner: string | null;
  /** Acquisition year when stated, otherwise null. */
  year: number | null;
  expectedOwnershipStatus: ExpectedOwnershipStatus;
  expectedPipelineDecision: ExpectedPipelineDecision;
  /** Verdict mapping rationale (provenance for non-obvious rows). */
  note: string;
  split: InvestorVerdictSplit;
}

function verdictEntry(
  name: string,
  verdict: InvestorVerdict,
  owner: string | null,
  year: number | null,
  expectedOwnershipStatus: ExpectedOwnershipStatus,
  expectedPipelineDecision: ExpectedPipelineDecision,
  note: string,
): InvestorVerdictEntry {
  return {
    name,
    verdict,
    owner,
    year,
    expectedOwnershipStatus,
    expectedPipelineDecision,
    note,
    split: INVESTOR_VERDICT_SPLIT,
  };
}

// --- pass_acquired: 19 relevant-but-acquired archetype references ------------
// Strategics (TransDigm / HEICO / Parker Hannifin / Ametek / Carlisle and
// public-Butler subsidiaries) → strategic_owned; PE buyers (Loar / TJC /
// Acorn / Vance Street / Stephens / unnamed firms) → pe_owned; Butler
// National stays public → public.

const ACQUIRED: InvestorVerdictEntry[] = [
  verdictEntry(
    "Ametek Ameron LLC d/b/a Mass Systems",
    "pass_acquired",
    "Ametek",
    2009,
    "strategic_owned",
    "pass_acquired",
    "Acquired by Ametek in 2009.",
  ),
  verdictEntry(
    "B/E Aerospace Inc, DBA, SMR Technologies Inc",
    "pass_acquired",
    "Loar Group",
    2019,
    "pe_owned",
    "pass_acquired",
    "B/E Aerospace SMR acquired by Loar Group in 2019.",
  ),
  verdictEntry(
    "Butler National Corporation",
    "pass_acquired",
    "public (~$98M revenue, $38M EBITDA)",
    null,
    "public",
    "pass_acquired",
    "Public company, never acquired; retained as the archetype reference for its subsidiaries Avcon Industries + BNC Tempe. Owner field records public-market scale, not a buyer.",
  ),
  verdictEntry(
    "Avcon Industries",
    "pass_acquired",
    "Butler National Corporation (public)",
    null,
    "strategic_owned",
    "pass_acquired",
    "Subsidiary of public Butler National — unactionable via the parent listing.",
  ),
  verdictEntry(
    "BNC Tempe",
    "pass_acquired",
    "Butler National Corporation (public)",
    null,
    "strategic_owned",
    "pass_acquired",
    "Tempe subsidiary of public Butler National — unactionable via the parent listing.",
  ),
  verdictEntry(
    "CPI Eimac Division",
    "pass_acquired",
    "CPI (TJC portfolio company)",
    null,
    "pe_owned",
    "pass_acquired",
    "Acquired as an add-on for CPI, a TJC portfolio company.",
  ),
  verdictEntry(
    "Dart Aerospace",
    "pass_acquired",
    "TransDigm",
    null,
    "strategic_owned",
    "pass_acquired",
    "Acquired by TransDigm.",
  ),
  verdictEntry(
    "Jet Parts Engineering, Inc. (JPE)",
    "pass_acquired",
    "TransDigm",
    null,
    "strategic_owned",
    "pass_acquired",
    "JPE acquired by TransDigm.",
  ),
  verdictEntry(
    "Kirkhill Aircraft Parts Company",
    "pass_acquired",
    "TransDigm (via Esterline)",
    null,
    "strategic_owned",
    "pass_acquired",
    "Acquired by TransDigm via the Esterline acquisition.",
  ),
  verdictEntry(
    "PRECISION AIRMOTIVE LLC",
    "pass_acquired",
    "McFarlane Aviation (via Vance Street Capital)",
    null,
    "pe_owned",
    "pass_acquired",
    "Add-on for McFarlane Aviation via Vance Street Capital.",
  ),
  verdictEntry(
    "Raisbeck Engineering Inc",
    "pass_acquired",
    "Acorn Capital",
    2016,
    "pe_owned",
    "pass_acquired",
    "Acquired by Acorn Capital in 2016.",
  ),
  verdictEntry(
    "Robertson Fuel Systems LLC",
    "pass_acquired",
    "HEICO",
    2016,
    "strategic_owned",
    "pass_acquired",
    "Acquired by HEICO in 2016 for $255M.",
  ),
  verdictEntry(
    "Shadin Avionics",
    "pass_acquired",
    "Two PE firms",
    2020,
    "pe_owned",
    "pass_acquired",
    "Acquired by two PE firms in 2020 (firms unnamed in commentary).",
  ),
  verdictEntry(
    "Sirius Technologies, Inc., DBA Flight Display System",
    "pass_acquired",
    "Vance Street Partners",
    2021,
    "pe_owned",
    "pass_acquired",
    "Sirius/Flight Display acquired by Vance Street Partners in 2021.",
  ),
  verdictEntry(
    "Turbine Kinetics Inc, Subsidiary of HEICO Corp",
    "pass_acquired",
    "HEICO",
    null,
    "strategic_owned",
    "pass_acquired",
    "Subsidiary of / acquired by HEICO; no year stated.",
  ),
  verdictEntry(
    "Vibro-Meter Corp",
    "pass_acquired",
    "Parker Hannifin (via Meggitt)",
    null,
    "strategic_owned",
    "pass_acquired",
    "Acquired by Parker Hannifin via Meggitt.",
  ),
  verdictEntry(
    "Wellman Products Group",
    "pass_acquired",
    "Carlisle Companies",
    null,
    "strategic_owned",
    "pass_acquired",
    "Acquired by Carlisle Companies.",
  ),
  verdictEntry(
    "Meggitt Thermal Systems Inc",
    "pass_acquired",
    "Parker Hannifin",
    2022,
    "strategic_owned",
    "pass_acquired",
    "Acquired by Parker Hannifin in 2022.",
  ),
  verdictEntry(
    "VisionSafe Corporation",
    "pass_acquired",
    "The Stephens Group",
    2024,
    "pe_owned",
    "pass_acquired",
    "Acquired by The Stephens Group in 2024.",
  ),
];

// --- add: sole Add-to-Pipeline=Yes verdict -----------------------------------

const ADD: InvestorVerdictEntry[] = [
  verdictEntry(
    "Electronics International",
    "add",
    null,
    null,
    "independent",
    "add",
    "Sole Add-to-Pipeline=Yes verdict; `add` is only ever produced from this explicit investor verdict, never derived.",
  ),
];

// --- hold: Relevant Maybe, or Relevant Yes with Add Maybe --------------------

const HOLD: InvestorVerdictEntry[] = [
  verdictEntry(
    "Alpha Aviation",
    "hold",
    null,
    null,
    "unknown",
    "hold",
    "Relevant Maybe, or Relevant Yes with Add Maybe; no ownership signal in commentary.",
  ),
  verdictEntry(
    "Composite Specialties",
    "hold",
    null,
    null,
    "unknown",
    "hold",
    "Relevant Maybe, or Relevant Yes with Add Maybe; no ownership signal in commentary.",
  ),
  verdictEntry(
    "Concorde Battery",
    "hold",
    null,
    null,
    "unknown",
    "hold",
    "Relevant Maybe, or Relevant Yes with Add Maybe; no ownership signal in commentary.",
  ),
  verdictEntry(
    "Middle Fork",
    "hold",
    null,
    null,
    "unknown",
    "hold",
    "Relevant Maybe, or Relevant Yes with Add Maybe; no ownership signal in commentary.",
  ),
  verdictEntry(
    "M-20 Oil",
    "hold",
    null,
    null,
    "unknown",
    "hold",
    "Matches both m-20 oil and m20 oil key variants (same company); Relevant Maybe, or Relevant Yes with Add Maybe.",
  ),
];

// --- pass_dead: acquired 2008, no longer exists -------------------------------

const DEAD: InvestorVerdictEntry[] = [
  verdictEntry(
    "Keddeg",
    "pass_dead",
    null,
    2008,
    "dead",
    "pass_dead",
    "Acquired 2008 (buyer unnamed in commentary); no longer exists.",
  ),
];

// --- pass_sector: wrong-sector / too-large ------------------------------------

const SECTOR: InvestorVerdictEntry[] = [
  verdictEntry(
    "Whelen",
    "pass_sector",
    null,
    null,
    "independent",
    "pass_sector",
    "Law-enforcement lighting + very large — off-thesis by sector and scale, not ownership.",
  ),
  verdictEntry(
    "Delta Flight Products",
    "pass_sector",
    null,
    null,
    "strategic_owned",
    "pass_sector",
    "Captive of Delta Air Lines — off-thesis by ownership structure and sector.",
  ),
  verdictEntry(
    "Skydweller",
    "pass_sector",
    null,
    null,
    "unknown",
    "pass_sector",
    "Platform OEM, already off-thesis by scale; no ownership signal in commentary.",
  ),
];

/**
 * The frozen v1 investor-verdicts dataset: 19 acquired + 1 add + 5 hold +
 * 1 dead + 3 sector = 29 held-out rows. Tune NOTHING against these;
 * report only.
 */
export const INVESTOR_VERDICTS_V1: InvestorVerdictEntry[] = [
  ...ACQUIRED,
  ...ADD,
  ...HOLD,
  ...DEAD,
  ...SECTOR,
];
