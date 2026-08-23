/**
 * Deterministic perturbation generator for the entity-resolution benchmark.
 *
 * Pure: given a ground truth, produce labeled match cases. A seeded PRNG
 * (mulberry32) makes every run reproducible; no DB or network access.
 */
import { normalizeDomain, normalizeLegalName } from "@asi/database";

import type { ErCase, ErCaseKind, GroundTruth, KnownCompany } from "./types.js";

/** Deterministic 32-bit PRNG (mulberry32). Exported for determinism tests. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DEFAULT_ER_SEED = 20260823;

/** Suffixes that are pure legal decoration and safe to strip/swap. */
export const LEGAL_SUFFIXES = [
  "Inc.",
  "Inc",
  "Incorporated",
  "LLC",
  "L.L.C.",
  "Corp.",
  "Corp",
  "Corporation",
  "Co.",
  "Company",
] as const;

/**
 * Distinctive name parts that LOOK like suffixes but carry identity
 * ("Spirit AeroSystems Holdings", "Barnes Group") — usable as swap-in
 * variants but never stripped from a base name.
 */
const SWAP_ONLY_SUFFIXES = ["Holdings", "Group"] as const;

/**
 * HQ city per company id for the demo primes (public knowledge, stable).
 * Companies without an entry simply skip the city-append perturbation.
 */
export const HQ_CITY_BY_COMPANY_ID: Record<string, string> = {
  "e9f7e28b-afd4-40b3-9e98-246b27881cd1": "Chicago", // Boeing
  "0ba98bd9-9771-4260-ae7e-ad7e781783b5": "Bethesda", // Lockheed Martin
  "c3b126e0-8abd-4e78-8a73-7110bc46985c": "Falls Church", // Northrop Grumman
  "44d7133e-19c1-40b7-8cf4-41d8fe995964": "Arlington", // RTX
  "c3efc32d-0804-46d9-bfb4-a365f2ec4d52": "Pittsburgh", // Howmet
  "dc11d0d7-baf8-42e1-8eab-b35822075c3f": "Milford", // Hitchiner
  "15587656-6df6-4ea9-a3c4-b15fc2bdb0dd": "East Aurora", // Moog
  "d5bffe18-b14a-453c-8a72-d2a6c22b094b": "Wichita", // Spirit AeroSystems
  "9d74f8b3-5a9e-4c81-a0ba-030fd0026320": "Portland", // Precision Castparts
  "d4262213-f5a7-4009-8b43-b3b3985d3363": "Bristol", // Barnes Group
};

/** Strip trailing legal suffixes so perturbations do not stack them. */
export function stripLegalSuffixes(name: string): string {
  let current = name.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      const pattern = new RegExp(
        `[,\\s]+${suffix.replace(/\./gu, "\\.").replace(/\s+/gu, "\\s+")}$`,
        "iu",
      );
      const next = current.replace(pattern, "").trim().replace(/,$/u, "");
      if (next !== current && next.length > 0) {
        current = next;
        changed = true;
      }
    }
  }
  return current;
}

function swapSuffix(base: string, rand: () => number): string {
  const vocabulary = [...LEGAL_SUFFIXES, ...SWAP_ONLY_SUFFIXES];
  const suffix = vocabulary[Math.floor(rand() * vocabulary.length)]!;
  return `${base}, ${suffix}`;
}

function addNoise(base: string, rand: () => number): string {
  // Always apply one STRUCTURAL mutation first: the leads-path dedupe key
  // trims and lowercases, so casing/edge whitespace alone would collide
  // with the plain name.
  let out = base.replace(/,\s*/u, " , ").replace(" ", "  ");
  const ops = Math.floor(rand() * 3);
  for (let i = 0; i < ops; i += 1) {
    const op = Math.floor(rand() * 4);
    if (op === 0) out = out.replace(/,\s*/u, "  ,  ");
    else if (op === 1) out = out.toUpperCase();
    else if (op === 2) out = ` ${out.replace(/\s+/gu, "   ")} `;
    else out = out.replace(" ", "-");
  }
  return out;
}

/** Transpose the two central words of a multi-word distinctive name. */
export function transposeNameOrder(name: string): string | null {
  const words = name.split(/\s+/u).filter((w) => w.length > 0);
  if (words.length < 2) return null;
  const mid = Math.floor(words.length / 2);
  const a = words[mid - 1]!;
  const b = words[mid]!;
  if (a.toLowerCase() === b.toLowerCase()) return null;
  const swapped = [...words.slice(0, mid - 1), b, a, ...words.slice(mid + 1)];
  return swapped.join(" ");
}

interface CaseAccumulator {
  readonly cases: ErCase[];
  counter: number;
}

function pushCase(
  acc: CaseAccumulator,
  kind: ErCaseKind,
  rawName: string,
  domain: string | null,
  expectedCompanyId: string | null,
  note: string,
  family: string | null,
): void {
  acc.counter += 1;
  acc.cases.push({
    caseId: `er-${String(acc.counter).padStart(4, "0")}`,
    kind,
    rawName,
    domain,
    expectedCompanyId,
    note,
    family,
  });
}

/**
 * Build the full labeled case set. Includes:
 * - exact legal names + primary-domain cases (should resolve exactly),
 * - legal-suffix / punctuation-noise / transposed / city+state append
 *   perturbations (should resolve probable),
 * - alias + display-name + former-name-style cases (alias capture),
 * - golden/pipeline member replays and lead replays,
 * - deliberate confusables (must NOT match), incl. Zephyr Tool Group,
 * - Yulista family siblings (must NOT match anything nor each other).
 */
export function buildPerturbationCases(
  truth: GroundTruth,
  seed: number = DEFAULT_ER_SEED,
): ErCase[] {
  const rand = mulberry32(seed);
  const acc: CaseAccumulator = { cases: [], counter: 0 };

  for (const company of truth.companies) {
    pushCompanyCases(acc, company, rand);
  }

  // Member replays: re-match raw member rows from both snapshots.
  for (const member of truth.goldenMembers) {
    pushCase(
      acc,
      "member_replay",
      member.rawName,
      member.normalizedDomain,
      null, // members are not canonical companies; correct outcome is none/probable-at-most
      `golden/pipeline member replay: ${member.snapshotName}`,
      null,
    );
  }
  // Lead replays: names already ingested by campaign d834469d.
  for (const lead of truth.leads) {
    pushCase(
      acc,
      "lead_replay",
      lead.rawName,
      lead.domain,
      lead.resolvedCompanyId,
      `lead replay (${lead.status})`,
      lead.rawName.toUpperCase().includes("YULISTA") ? "yulista" : null,
    );
  }

  // Deliberate confusables: near-name entities that must NOT merge.
  const zephyr = truth.companies.find((c) => c.domains.includes("zephyrintl.com"));
  if (zephyr !== undefined) {
    pushCase(
      acc,
      "confusable_negative",
      "Zephyr Tool Group, LLC",
      null,
      null,
      "confusable of Zephyr International LLC — must never merge",
      null,
    );
    pushCase(
      acc,
      "confusable_negative",
      "Zephyr International Group Inc.",
      null,
      null,
      "confusable of Zephyr International LLC — must never merge",
      null,
    );
  }
  const york = truth.companies.find((c) => c.domains.includes("yorkpmh.com"));
  if (york !== undefined) {
    // Dropped distinctive middle token: legitimately hard probable case.
    pushCase(
      acc,
      "confusable_negative",
      "York Precision Hydraulics LLC",
      null,
      null,
      "token-dropped near-name of York Precision — measured, expected hard",
      null,
    );
  }

  // Yulista family siblings (from the real campaign leads): must not merge
  // with each other nor with any catalog company.
  const yulistaNames = [
    "YULISTA AEROSPACE & DEFENSE LLC",
    "YULISTA AVIATION, INC.",
    "YULISTA SUPPORT SERVICES LLC",
    "YULISTA CONTRACT SERVICES LLC",
    "YULISTA INTEGRATED SOLUTIONS, LLC",
  ];
  for (const name of yulistaNames) {
    pushCase(
      acc,
      "family_sibling",
      name,
      null,
      null,
      "Yulista family sibling — siblings must not merge with each other",
      "yulista",
    );
  }

  return acc.cases;
}

function pushCompanyCases(
  acc: CaseAccumulator,
  company: KnownCompany,
  rand: () => number,
): void {
  const base = stripLegalSuffixes(company.legalName);

  pushCase(
    acc,
    "exact_name",
    company.legalName,
    null,
    company.companyId,
    `legal name of ${company.displayName}`,
    null,
  );

  const primaryDomain = company.domains[0];
  if (primaryDomain !== undefined) {
    pushCase(
      acc,
      "exact_name",
      company.legalName,
      primaryDomain,
      company.companyId,
      `primary domain of ${company.displayName}`,
      null,
    );
    // Domain noise: www prefix + trailing dot + uppercase must still hit.
    const noisy = `HTTPS://${primaryDomain.toUpperCase()}.`;
    pushCase(
      acc,
      "whitespace_punct_noise",
      // Textual noise (not just casing): the leads path lowercases names in
      // its per-campaign dedupe key, so a case-only change would collide
      // with the plain-domain case above.
      addNoise(company.legalName, rand),
      noisy,
      company.companyId,
      `noisy domain variant of ${company.displayName}`,
      null,
    );
  }

  pushCase(
    acc,
    "legal_suffix_variant",
    swapSuffix(base, rand),
    null,
    company.companyId,
    `legal-suffix variant of ${company.displayName}`,
    null,
  );

  pushCase(
    acc,
    "whitespace_punct_noise",
    addNoise(company.legalName, rand),
    null,
    company.companyId,
    `punctuation/whitespace noise on ${company.displayName}`,
    null,
  );

  const transposed = transposeNameOrder(base);
  if (transposed !== null) {
    pushCase(
      acc,
      "transposed_order",
      `${transposed}, ${company.legalName.includes("LLC") ? "LLC" : "Inc."}`,
      null,
      company.companyId,
      `transposed word order for ${company.displayName}`,
      null,
    );
  }

  const city = HQ_CITY_BY_COMPANY_ID[company.companyId];
  if (city !== undefined) {
    pushCase(
      acc,
      "city_append",
      `${company.legalName} (${city})`,
      null,
      company.companyId,
      `HQ city appended for ${company.displayName}`,
      null,
    );
  }
  if (company.usState !== null) {
    pushCase(
      acc,
      "state_append",
      `${company.legalName} - ${company.usState}`,
      null,
      company.companyId,
      `HQ state appended for ${company.displayName}`,
      null,
    );
  }

  // Alias capture: display name, registered aliases, former-name style.
  pushCase(
    acc,
    "alias_short_name",
    company.displayName,
    null,
    company.companyId,
    `display name of ${company.displayName}`,
    null,
  );
  for (const alias of company.aliases) {
    pushCase(
      acc,
      "alias_short_name",
      alias,
      null,
      company.companyId,
      `registered alias of ${company.displayName}`,
      null,
    );
  }
  pushCase(
    acc,
    "former_name_style",
    base,
    null,
    company.companyId,
    `former-name style (no suffix) of ${company.displayName}`,
    null,
  );
}

/** Normalized identity of a case, mirroring snapshot import semantics. */
export function caseIdentityKey(c: Pick<ErCase, "rawName" | "domain">): string {
  const domain = normalizeDomain(c.domain ?? "");
  const name = normalizeLegalName(c.rawName);
  return domain === null ? `n:${name}` : `d:${domain}|n:${name}`;
}
