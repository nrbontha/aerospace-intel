/**
 * FROZEN v1 dataset: representative dev sample of the ADCO M&A pipeline
 * (2026-09-09 snapshot), stratified evenly across investor Priority 1/2/3.
 *
 * Source of truth: the 2026-09-09 M&A Pipeline CSV as captured in the
 * production known-universe snapshot (full-set distribution: P1=50,
 * P2=182, P3=71; 303 rows). This file encodes a 36-row stratified sample
 * (12/12/12) staged for fixture use. Revenue/employees are snapshot values;
 * ownership is the snapshot's verbatim ownership text (blank where unstated).
 *
 * Split: every row is 'dev'. Tune freely against this set; the 29-row
 * investor-verdicts set is the held-out test set and MUST stay untouched.
 *
 * DO NOT edit these rows casually: scoring-axial dev/validation tooling
 * pins expectations against them.
 */

export const DATASET_VERSION = "ma-priorities-v1";

/** Dataset split for every row in this file. Safe to tune against. */
export const MA_PRIORITY_SPLIT = "dev" as const;
export type MaPrioritySplit = typeof MA_PRIORITY_SPLIT;

export type MaPipelinePriority = 1 | 2 | 3;

export interface MaPriorityEntry {
  /** Company name as listed in the pipeline snapshot. */
  name: string;
  domain: string | null;
  /** Investor pipeline priority (1 = highest attention). */
  priority: MaPipelinePriority;
  category: string | null;
  /** Snapshot revenue in USD, null where unstated. */
  revenue: number | null;
  /** Snapshot headcount, null where unstated. */
  employees: number | null;
  /** Verbatim snapshot ownership text, null where unstated. */
  ownership: string | null;
  /**
   * Expected investorPriority mapping. Identity: the pipeline rank IS the
   * investor rank (see deriveInvestorAssessment in
   * packages/database/src/unified-targets/populate.ts — only process-only
   * evidence demotes a P1 to 2 at assessment time, which is a scoring
   * behavior under test, not a fixture relabeling).
   */
  expectedInvestorPriority: MaPipelinePriority;
  /** Mapping rationale for non-obvious rows; omitted where identity is obvious. */
  rationale?: string;
  split: MaPrioritySplit;
}

function row(
  name: string,
  domain: string | null,
  priority: MaPipelinePriority,
  category: string | null,
  revenue: number | null,
  employees: number | null,
  ownership: string | null,
  rationale?: string,
): MaPriorityEntry {
  return {
    name,
    domain,
    priority,
    category,
    revenue,
    employees,
    ownership,
    expectedInvestorPriority: priority,
    ...(rationale !== undefined ? { rationale } : {}),
    split: MA_PRIORITY_SPLIT,
  };
}

// --- Priority 1 (12 rows) --------------------------------------------------------

const PRIORITY_1: MaPriorityEntry[] = [
  row(
    "Fluid Conditioning Products, Inc.",
    "fcp-filters.com",
    1,
    null,
    7000000,
    35,
    "Private",
  ),
  row(
    "Cole Instrument Corporation",
    "cole-switches.com",
    1,
    "Avionics, Electrical & Sensors",
    18987000,
    null,
    "Private",
  ),
  row(
    "Ingenium Aerospace, LLC",
    "ingeniumaerospace.com",
    1,
    "Avionics, Electrical & Sensors",
    16584411,
    null,
    "Private",
  ),
  row(
    "Rogerson Corporation",
    "rogerson.com",
    1,
    "Avionics, Electrical & Sensors",
    43236000,
    null,
    "Private",
  ),
  row(
    "Alliance Aerospace Engineering",
    "alliance-aerospace.com",
    1,
    "Aircraft Aftermarket & MRO",
    21360000,
    null,
    "Private",
    "Distinct from the P2 'Alliance Aerospace Group, LLC' (alliance.aero) — similar names, different companies; do not conflate.",
  ),
  row(
    "American Metal Bearing (AMB)",
    "ambco.net",
    1,
    "Mechanical Components & Machining",
    8500000,
    27,
    "Private",
  ),
  row(
    "Phaostron Instrument & Elect",
    "phaostron.com",
    1,
    "Avionics, Electrical & Sensors",
    8288000,
    null,
    "Private",
  ),
  row(
    "Av-DEC (Aviation Devices & Electronic Components)",
    "avdec.com",
    1,
    "Composites, Structures & Materials",
    null,
    null,
    null,
    "P1 with no revenue, headcount, or ownership stated — thin record held at P1 on source attention alone.",
  ),
  row(
    "HiRel Connectors Inc.",
    "hirelco.net",
    1,
    "Avionics, Electrical & Sensors",
    18700000,
    null,
    null,
    "P1 with ownership unstated; rank rests on product fit, not ownership.",
  ),
  row(
    "Rapco Fleet Support, Inc. (RFS)",
    "rfsbrakes.com",
    1,
    "Aircraft Aftermarket & MRO",
    7606000,
    null,
    "Private",
  ),
  row(
    "ValveTech",
    "valvetech.net",
    1,
    "Mechanical Components & Machining",
    11500000,
    null,
    null,
    "Promoted to P1 in the 2026-09-09 snapshot (older workbook had it at P3); ownership unstated here.",
  ),
  row(
    "Northstar",
    "northstar-e.com",
    1,
    "Fuel, Fluid & Environmental Systems",
    16015000,
    null,
    "Private",
  ),
];

// --- Priority 2 (12 rows) --------------------------------------------------------

const PRIORITY_2: MaPriorityEntry[] = [
  row(
    "Dayton T. Brown, Inc.",
    "dtb.com",
    2,
    null,
    66000000,
    317,
    "Private",
    "Largest revenue in the sample ($66M, 317 staff) yet only P2 — testing/services-heavy profile caps investor attention.",
  ),
  row(
    "Advanced Interconnections",
    "advanced.com",
    2,
    "Avionics, Electrical & Sensors",
    9000000,
    null,
    null,
    "Ownership unstated; interconnect scope spans non-aerospace end markets (medical, automotive, telecom).",
  ),
  row(
    "ALFA International Corporation",
    "alfaadhesives.com",
    2,
    "Composites, Structures & Materials",
    null,
    null,
    null,
    "P2 with no financials, headcount, or ownership stated — adhesive/consumables profile.",
  ),
  row(
    "NetAcquire Corporation",
    "netacquire.com",
    2,
    "Avionics, Electrical & Sensors",
    5312000,
    null,
    "Private",
  ),
  row(
    "MS Electronix, Inc.",
    "mselectronix.com",
    2,
    "Avionics, Electrical & Sensors",
    700000,
    null,
    "Private",
    "Micro-scale ($700k revenue) retained at P2 — MIL-SPEC connector fit outweighs scale.",
  ),
  row(
    "Aimtek",
    "aimtek.com",
    2,
    null,
    null,
    null,
    "Source Engineering & Manufacturing",
    "Ownership cell holds a source tag ('Source Engineering & Manufacturing'), not an owner — treat as unstated.",
  ),
  row(
    "Elinor Coatings, LLC",
    "elinorcoatings.com",
    2,
    "Composites, Structures & Materials",
    null,
    null,
    null,
    "No financials or ownership; consulting/services-flavored description — borderline process-only, which would demote a P1 but holds at P2.",
  ),
  row(
    "Alliance Aerospace Group, LLC",
    "alliance.aero",
    2,
    "Aircraft Aftermarket & MRO",
    5064606,
    null,
    "Private",
    "Distinct from the P1 'Alliance Aerospace Engineering' (alliance-aerospace.com) — similar names, different companies; do not conflate.",
  ),
  row(
    "Sentek Instrument",
    "sentekinstrument.com",
    2,
    null,
    2000000,
    7,
    "Private",
  ),
  row(
    "MWT Materials, Inc.",
    "mwtmaterials.com",
    2,
    "Composites, Structures & Materials",
    1455000,
    10,
    "Private",
  ),
  row(
    "Aerospace Sealants",
    "aerospace-sealants.com",
    2,
    "Composites, Structures & Materials",
    22063000,
    null,
    "Private",
  ),
  row(
    "Silicon Designs",
    "silicondesigns.com",
    2,
    null,
    16000000,
    65,
    "Private",
  ),
];

// --- Priority 3 (12 rows) --------------------------------------------------------

const PRIORITY_3: MaPriorityEntry[] = [
  row(
    "Cascade Gasket & Manufacturing Company",
    "cascadegasket.com",
    3,
    "Composites, Structures & Materials",
    34200000,
    null,
    null,
    "Large revenue ($34M) at P3 with ownership unstated — gasket/commodity profile caps rank despite scale.",
  ),
  row(
    "HyTech Spring and Machine",
    "hytechspring.com",
    3,
    "Mechanical Components & Machining",
    45730000,
    null,
    "Private",
    "Largest P3 revenue ($45.7M); contract-manufacturer (process-only) profile — the archetype deriveInvestorAssessment would demote from P1.",
  ),
  row(
    "American Precision Spring Corporation",
    "americanprecspring.com",
    3,
    "Mechanical Components & Machining",
    5525000,
    null,
    "Private",
  ),
  row(
    "Quantaflex Printed Electronics",
    "quantaflex.com",
    3,
    "Avionics, Electrical & Sensors",
    1455000,
    10,
    "Private",
  ),
  row(
    "All Products Mfg. & Supply, Inc.",
    "apgasket.com",
    3,
    "Composites, Structures & Materials",
    4670000,
    null,
    null,
    "Ownership unstated; die-cutting/fabrication job-shop profile.",
  ),
  row(
    "W And G Machine Company",
    "gmachine.com",
    3,
    "Aircraft Aftermarket & MRO",
    23908000,
    null,
    "Private",
  ),
  row(
    "Aerospace Manufacturing Corporation",
    "aero-space.us",
    3,
    "Mechanical Components & Machining",
    9563000,
    45,
    "Private",
    "Built-to-print fastener production stated outright — process-only evidence, consistent with P3.",
  ),
  row(
    "CBS Fasteners",
    "cbsfasteners.com",
    3,
    "Mechanical Components & Machining",
    7120000,
    null,
    null,
    "Ownership unstated; externally-threaded-fastener commodity profile.",
  ),
  row(
    "CDM Electronics, Inc.",
    "cdmelectronics.com",
    3,
    "Avionics, Electrical & Sensors",
    36030000,
    67,
    "Private",
  ),
  row(
    "Heartland Precision Fasteners",
    "heartlandfasteners.com",
    3,
    "Mechanical Components & Machining",
    13540000,
    null,
    null,
    "Ownership unstated; fastener commodity profile.",
  ),
  row(
    "Bandy Manufacturing",
    "bandymanufacturing.com",
    3,
    "Mechanical Components & Machining",
    22540000,
    null,
    "Novaria Group",
    "PE-platform owned (Novaria Group) yet ranked P3 — ownership alone neither promotes nor demotes the pipeline rank in this snapshot.",
  ),
  row(
    "JRI Inc dba J R industries",
    "jri.com",
    3,
    "Avionics, Electrical & Sensors",
    12576000,
    51,
    "Private",
  ),
];

/**
 * The frozen v1 MA-priorities dev dataset: 12 Priority-1 + 12 Priority-2 +
 * 12 Priority-3 = 36 rows sampled from the 303-row Priority 1-3 pipeline
 * (full-set distribution P1=50 / P2=182 / P3=71). Split is 'dev' throughout:
 * safe to tune against. The investor-verdicts set stays held-out.
 */
export const MA_PRIORITIES_V1: MaPriorityEntry[] = [
  ...PRIORITY_1,
  ...PRIORITY_2,
  ...PRIORITY_3,
];
