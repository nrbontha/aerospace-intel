import { extractFeatureVector, type FeatureVector } from "../features.js";
import type { EvaluationEntry, EvaluationDataset } from "../evaluate.js";

/**
 * FROZEN v1 dataset: feature vectors for all 18 real golden-set companies,
 * encoded from data/ADCO-golden-set.xlsx ("Golden Set Targets" + "Grata Data"
 * sheets), plus two synthetic negative business-model controls.
 *
 * Encoding conventions (documented once, applied everywhere):
 *  - Ownership: named private owner or bare "Private" → independent_founder;
 *    PE firm name (Vance Street Capital, Loar Group) → pe_owned; public
 *    parent (HEICO, TransDigm) → public_sub. No family ownership was
 *    asserted anywhere in the workbook, so independent_family is never used.
 *  - Revenue band: workbook "Estimated revenue" ($m). Where the workbook says
 *    n/a, the Grata Revenue Estimate (in $m) is used instead.
 *  - Qualifications/proprietary evidence: only what the workbook text asserts.
 *    "patented" → patented; trademark/product lines or proprietary processes
 *    in production → demonstrated; marketing claims → claimed; unstated →
 *    unknown (never defaulted).
 *  - Evidence telemetry (source counts, recency): the workbook carries none,
 *    so these are ILLUSTRATIVE FROZEN VALUES chosen to be internally
 *    consistent per company; they exist so confidence/routing behavior is
 *    deterministic and testable.
 *
 * DO NOT edit these vectors casually: scoring-axial.test.ts pins exact
 * behaviors against them and they define the frozen v1 baseline.
 */

type VecSpec = Record<string, unknown>;

function vec(spec: VecSpec): FeatureVector {
  return extractFeatureVector(spec);
}

// --- 18 golden companies -----------------------------------------------------

const ADPMA = vec({
  domain: "adpma.com",
  revenue_band: "<5m",
  employees_band: "unknown",
  ownership_type: "independent_founder", // Mollenhour Gross
  build_to_print_share: "none",
  proprietary_product_evidence: "demonstrated", // proprietary aircraft parts line
  qualifications: { pma: "present" }, // FAA-PMA aftermarket supplier
  aftermarket: true,
  source_count: 5,
  primary_source_count: 2,
  conflict_count: 0,
  freshest_observation_days_old: 60,
  identity_resolved: true,
});

const ARMSTRONG = vec({
  domain: "armstrong-mfg.com",
  revenue_band: "5-10m",
  ownership_type: "independent_founder", // Private
  build_to_print_share: "minor",
  proprietary_product_evidence: "claimed", // own aviation pump line
  qualifications: { oem_approved: "unknown" },
  aftermarket: false,
  source_count: 4,
  primary_source_count: 1,
  conflict_count: 0,
  freshest_observation_days_old: 120,
  identity_resolved: true,
});

const FIBER_DYNAMICS = vec({
  domain: "fiberdynamics.net",
  revenue_band: "10-20m",
  ownership_type: "independent_founder", // Private
  build_to_print_share: "none",
  proprietary_product_evidence: "demonstrated", // proprietary LCRTM process in production
  qualifications: {},
  aftermarket: false,
  source_count: 4,
  primary_source_count: 2,
  conflict_count: 0,
  freshest_observation_days_old: 90,
  identity_resolved: true,
});

const TEMPEST_AERO = vec({
  domain: "tempestaero.com",
  revenue_band: "20-35m",
  ownership_type: "pe_owned", // Vance Street Capital
  build_to_print_share: "none",
  proprietary_product_evidence: "demonstrated", // six PMA brands
  qualifications: { pma: "present" },
  aftermarket: true,
  source_count: 5,
  primary_source_count: 2,
  conflict_count: 1,
  freshest_observation_days_old: 150,
  identity_resolved: true,
});

const JAY_EM = vec({
  domain: "jay-em.com",
  revenue_band: "<5m",
  ownership_type: "independent_founder", // Private
  build_to_print_share: "major", // "likely more build-to-print"
  proprietary_product_evidence: "none",
  qualifications: {},
  aftermarket: false,
  source_count: 3,
  primary_source_count: 1,
  conflict_count: 0,
  freshest_observation_days_old: 200,
  identity_resolved: true,
});

const AMC_FASTENERS = vec({
  domain: "aero-space.us",
  revenue_band: "5-10m",
  ownership_type: "independent_founder", // Private
  build_to_print_share: "major", // built-to-print fastener production
  proprietary_product_evidence: "claimed", // licensed producer of drive-system fasteners
  qualifications: {},
  aftermarket: false,
  source_count: 3,
  primary_source_count: 1,
  conflict_count: 1,
  freshest_observation_days_old: 240,
  identity_resolved: true,
});

const SKYBOLT = vec({
  domain: "skybolt.com",
  revenue_band: "10-20m",
  ownership_type: "independent_founder", // Private
  build_to_print_share: "none",
  proprietary_product_evidence: "patented", // patented designs, registered trademarks
  qualifications: {},
  aftermarket: true,
  platforms: [],
  source_count: 5,
  primary_source_count: 2,
  conflict_count: 0,
  freshest_observation_days_old: 45,
  identity_resolved: true,
});

const ACMT = vec({
  domain: "acmt-usa.com",
  revenue_band: "20-35m",
  ownership_type: "independent_founder", // Private
  build_to_print_share: "major", // "likely more build-to-print"
  proprietary_product_evidence: "claimed", // internally developed robotics/automation
  qualifications: {},
  aftermarket: false,
  source_count: 4,
  primary_source_count: 1,
  conflict_count: 0,
  freshest_observation_days_old: 180,
  identity_resolved: true,
});

const PDI_GROUP = vec({
  domain: "thepdigroup.com",
  revenue_band: "20-35m",
  ownership_type: "independent_founder", // Private
  build_to_print_share: "minor", // mix of BTP (specialized) and proprietary
  proprietary_product_evidence: "claimed",
  qualifications: { itar_signal: "claimed" }, // defense spares
  aftermarket: false,
  source_count: 4,
  primary_source_count: 2,
  conflict_count: 0,
  freshest_observation_days_old: 130,
  identity_resolved: true,
});

const SKYLOCK = vec({
  domain: "skylock.com",
  revenue_band: "20-35m",
  ownership_type: "independent_founder", // Private
  build_to_print_share: "minor",
  proprietary_product_evidence: "claimed", // "appears to own design/IP, though TBD"
  qualifications: { oem_approved: "claimed" }, // military approvals claim
  aftermarket: false,
  source_count: 3,
  primary_source_count: 1,
  conflict_count: 1,
  freshest_observation_days_old: 210,
  identity_resolved: true,
});

const DAC_ENGINEERED = vec({
  domain: "dac-ep.com",
  revenue_band: "5-10m",
  ownership_type: "pe_owned", // Loar Group
  build_to_print_share: "none",
  proprietary_product_evidence: "demonstrated", // engineered PMA brake replacements
  qualifications: { pma: "present" },
  aftermarket: true,
  source_count: 4,
  primary_source_count: 2,
  conflict_count: 0,
  freshest_observation_days_old: 100,
  identity_resolved: true,
});

const MCNEIL = vec({
  domain: "mcneilindustries.com",
  revenue_band: "5-10m",
  ownership_type: "independent_founder", // Private
  build_to_print_share: "minor",
  proprietary_product_evidence: "demonstrated", // trademarked MAXAM bearing line
  qualifications: {},
  aftermarket: "unknown",
  source_count: 4,
  primary_source_count: 1,
  conflict_count: 0,
  freshest_observation_days_old: 160,
  identity_resolved: true,
});

const ROMCO = vec({
  domain: "romco.net",
  revenue_band: "20-35m",
  ownership_type: "independent_founder", // Private
  build_to_print_share: "minor",
  proprietary_product_evidence: "claimed", // proprietary products for specific markets
  qualifications: {},
  aftermarket: false,
  source_count: 3,
  primary_source_count: 1,
  conflict_count: 0,
  freshest_observation_days_old: 300,
  identity_resolved: true,
});

const COLE_INSTRUMENT = vec({
  domain: "cole-switches.com",
  revenue_band: "10-20m",
  ownership_type: "independent_founder", // Private
  build_to_print_share: "none",
  proprietary_product_evidence: "patented", // patented products + part numbers on site
  qualifications: {},
  aftermarket: false,
  source_count: 4,
  primary_source_count: 2,
  conflict_count: 0,
  freshest_observation_days_old: 110,
  identity_resolved: true,
});

const ROSEN_AVIATION = vec({
  domain: "rosenaviation.com",
  revenue_band: "5-10m", // workbook n/a → Grata estimate $4.9m
  ownership_type: "public_sub", // HEICO Corporation
  build_to_print_share: "none",
  proprietary_product_evidence: "claimed",
  qualifications: {},
  aftermarket: true,
  source_count: 5,
  primary_source_count: 2,
  conflict_count: 0,
  freshest_observation_days_old: 80,
  identity_resolved: true,
});

const JET_PARTS_ENGINEERING = vec({
  domain: "jetpartsengineering.com",
  revenue_band: "5-10m", // workbook n/a → Grata estimate ~$5m
  ownership_type: "public_sub", // TransDigm Group
  build_to_print_share: "none",
  proprietary_product_evidence: "claimed",
  qualifications: { pma: "present" },
  aftermarket: true,
  source_count: 5,
  primary_source_count: 3,
  conflict_count: 0,
  freshest_observation_days_old: 70,
  identity_resolved: true,
});

const SOUTHWEST_ANTENNAS = vec({
  domain: "southwestantennas.com",
  revenue_band: "5-10m", // workbook n/a → Grata estimate ~$5m
  ownership_type: "public_sub", // HEICO Corporation
  build_to_print_share: "none",
  proprietary_product_evidence: "claimed",
  qualifications: {},
  aftermarket: false,
  source_count: 4,
  primary_source_count: 2,
  conflict_count: 0,
  freshest_observation_days_old: 95,
  identity_resolved: true,
});

const SERVOTRONICS = vec({
  domain: "servotronics.com",
  revenue_band: "<5m", // workbook n/a → Grata estimate $3.7m
  ownership_type: "public_sub", // TransDigm Group
  build_to_print_share: "none",
  proprietary_product_evidence: "demonstrated", // off-the-shelf product lines
  qualifications: { oem_approved: "claimed" },
  aftermarket: false,
  source_count: 4,
  primary_source_count: 2,
  conflict_count: 1,
  freshest_observation_days_old: 140,
  identity_resolved: true,
});

// --- negative business-model controls ----------------------------------------

const PURE_DISTRIBUTOR_NEGATIVE = vec({
  domain: "pure-distributor.example",
  revenue_band: "unknown", // also exercises the <$50m hard requirement on unknown
  ownership_type: "independent_founder",
  distributes_products: true,
  build_to_print_share: "none",
  proprietary_product_evidence: "none",
  aftermarket: true,
  source_count: 2,
  primary_source_count: 0,
  conflict_count: 0,
  freshest_observation_days_old: null,
  identity_resolved: false,
});

const PURE_BTP_SHOP_NEGATIVE = vec({
  domain: "pure-btp-shop.example",
  revenue_band: "35-50m", // also exercises the >$35m side of the hard requirement
  ownership_type: "independent_founder",
  build_to_print_share: "major",
  proprietary_product_evidence: "none",
  aftermarket: false,
  source_count: 3,
  primary_source_count: 1,
  conflict_count: 0,
  freshest_observation_days_old: 400,
  identity_resolved: true,
});

export const DISTRIBUTOR_VETO_RULE = "businessModel.distributes_products:in";
export const BTP_VETO_RULE = "businessModel.build_to_print_share:equals";
export const REVENUE_VETO_RULE = "size.revenueBand:gt";
export const OWNERSHIP_SEVERE_VETO_RULE = "ownership.ownershipType:in";

function entry(
  id: string,
  label: EvaluationEntry["label"],
  features: FeatureVector,
  expectedVetos?: EvaluationEntry["expectedVetos"],
): EvaluationEntry {
  return expectedVetos
    ? { id, label, features, expectedVetos }
    : { id, label, features };
}

/**
 * The frozen v1 golden dataset: 18 real companies + 2 negative controls.
 * Holdout is a stratified slice removed from separation/LOOCV computation.
 */
export const GOLDEN_DATASET_V1: EvaluationDataset = {
  name: "golden-v1",
  entries: [
    entry("adpma", "strong_positive", ADPMA),
    entry("armstrong-mfg", "strong_positive", ARMSTRONG),
    entry("fiber-dynamics", "strong_positive", FIBER_DYNAMICS),
    entry("tempest-aero", "positive_with_caveat", TEMPEST_AERO, [
      { axis: "actionability", rule: OWNERSHIP_SEVERE_VETO_RULE },
    ]),
    entry("jay-em-aerospace", "borderline", JAY_EM),
    entry("amc-fasteners", "borderline", AMC_FASTENERS),
    entry("skybolt", "strong_positive", SKYBOLT),
    entry("acmt", "borderline", ACMT),
    entry("pdi-group", "strong_positive", PDI_GROUP),
    entry("skylock-industries", "positive_with_caveat", SKYLOCK),
    entry("dac-engineered", "positive_with_caveat", DAC_ENGINEERED, [
      { axis: "actionability", rule: OWNERSHIP_SEVERE_VETO_RULE },
    ]),
    entry("mcneil-industries", "strong_positive", MCNEIL),
    entry("romco-manufacturing", "positive_with_caveat", ROMCO),
    entry("cole-instrument", "strong_positive", COLE_INSTRUMENT),
    entry("pure-distributor-negative", "negative_business_model", PURE_DISTRIBUTOR_NEGATIVE, [
      { axis: "fit", rule: DISTRIBUTOR_VETO_RULE },
    ]),
    entry("pure-btp-shop-negative", "negative_business_model", PURE_BTP_SHOP_NEGATIVE, [
      { axis: "fit", rule: BTP_VETO_RULE },
    ]),
  ],
  holdout: [
    // Public-sub wish-list archetypes + one strong positive, kept out of the
    // candidate metrics but included in veto auditing.
    entry("rosen-aviation", "ideal_archetype_but_unactionable", ROSEN_AVIATION, [
      { axis: "actionability", rule: OWNERSHIP_SEVERE_VETO_RULE },
    ]),
    entry("jet-parts-engineering", "ideal_archetype_but_unactionable", JET_PARTS_ENGINEERING, [
      { axis: "actionability", rule: OWNERSHIP_SEVERE_VETO_RULE },
    ]),
    entry("southwest-antennas", "ideal_archetype_but_unactionable", SOUTHWEST_ANTENNAS, [
      { axis: "actionability", rule: OWNERSHIP_SEVERE_VETO_RULE },
    ]),
    entry("servotronics", "ideal_archetype_but_unactionable", SERVOTRONICS, [
      { axis: "actionability", rule: OWNERSHIP_SEVERE_VETO_RULE },
    ]),
  ],
};

/** All 20 entries including holdout — for audits that must see everything. */
export const ALL_GOLDEN_ENTRIES_V1: EvaluationEntry[] = [
  ...GOLDEN_DATASET_V1.entries,
  ...(GOLDEN_DATASET_V1.holdout ?? []),
];
