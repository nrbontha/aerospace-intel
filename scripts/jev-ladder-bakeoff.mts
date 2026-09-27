/**
 * JEv ladder bakeoff: scores ladder variants against Booie's 29 labeled
 * investor verdicts (real company names + expected pipeline decisions).
 *
 * Variant config: scripts/jev-ladder-variant.json { r1Threshold, vetoStatuses,
 * r2Mode ("choice" | "strict-product" | "lenient"), order ("ladder" |
 * "disposition-first"), r4Required ("hp" | "hp-or-research") }.
 *
 * Scoring (miss = 0 is perfect):
 * - verdict "add" -> final must be high_priority (else miss)
 * - verdict "hold" -> final must NOT be reject (else miss)
 * - verdict pass_* -> final must be reject (else miss)
 *
 * Emits `METRIC ladder_miss=N` plus ASI lines. Never touches the database;
 * rung flow replicates runLadderSignal via callJev directly.
 */
import { readFileSync } from "node:fs";
import { callJev } from "../packages/research/src/faa-ensemble/jev.js";
import {
  JEV_DISPOSITION_QUESTION,
  JEV_MANUFACTURER_QUESTION,
  JEV_OVERSIZE_QUESTION,
  JEV_PRODUCT_PROCESS_QUESTION,
  buildEvidencePackage,
  matchGovernmentRecipientName,
  matchNonprofitAcademicName,
} from "../packages/research/src/faa-ensemble/runner.js";
import { INVESTOR_VERDICTS_V1 } from "../packages/research/src/scoring-axial/fixtures/investor-verdicts.js";

interface Variant {
  r1Threshold: number;
  r1Mode?: "default" | "broad";
  vetoStatuses: string[];
  r2Mode: "choice" | "strict-product" | "lenient";
  r3Mode?: "default" | "scale";
  r4Mode?: "default" | "sector-sharp" | "platform-sharp";
  order:
    | "ladder"
    | "disposition-first"
    | "screen-then-disposition"
    | "vet-then-disposition";
  vetoFirst: boolean;
  enriched: boolean;
  r2Continue: boolean;
  flipRule: boolean;
  flipYears?: number;
}
const evidenceByName: Record<string, unknown> = JSON.parse(
  readFileSync(new URL("./jev-bakeoff-evidence.json", import.meta.url), "utf8"),
);

const variant: Variant = JSON.parse(
  readFileSync(new URL("./jev-ladder-variant.json", import.meta.url), "utf8"),
);
const r1Questions = {
  default: JEV_MANUFACTURER_QUESTION,
  broad: {
    type: "noul",
    instructions:
      "Could this company plausibly design, build, or integrate physical aerospace/defense products or test systems, broadly construed? Answer true unless it is clearly services, distribution, software, or unrelated business only.",
    criteria: {
      true: "Any plausible hardware, product, or test-system footprint.",
      false: "Clearly services, distribution, software, or unrelated only.",
    },
  },
} as const;
const r2Questions = {
  choice: JEV_PRODUCT_PROCESS_QUESTION,
  "strict-product": {
    type: "choice",
    instructions:
      "Does this company sell a proprietary manufactured PRODUCT with a name, brand, catalog SKU, PMA/STC article, or patent? Answer product ONLY on a named article; marketing capabilities alone are process.",
    criteria: JEV_PRODUCT_PROCESS_QUESTION.criteria as Record<string, string>,
  },
  lenient: {
    type: "choice",
    instructions:
      "Might this company sell any proprietary manufactured product, even on thin evidence?",
    criteria: JEV_PRODUCT_PROCESS_QUESTION.criteria as Record<string, string>,
  },
} as const;
const r4Questions = {
  default: JEV_DISPOSITION_QUESTION,
  "sector-sharp": {
    type: "choice",
    instructions: JEV_DISPOSITION_QUESTION.instructions as string,
    criteria: {
      ...(JEV_DISPOSITION_QUESTION.criteria as Record<string, string>),
      reject:
        (JEV_DISPOSITION_QUESTION.criteria as Record<string, string>).reject +
        " Manufacturers whose end markets are primarily non-aerospace (emergency vehicles, automotive, marine, industrial) are reject even when they make physical products.",
    },
  },
  "platform-sharp": {
    type: "choice",
    instructions: JEV_DISPOSITION_QUESTION.instructions as string,
    criteria: {
      ...(JEV_DISPOSITION_QUESTION.criteria as Record<string, string>),
      reject:
        (JEV_DISPOSITION_QUESTION.criteria as Record<string, string>).reject +
        " Manufacturers whose end markets are primarily non-aerospace (emergency vehicles, automotive, marine, industrial) are reject even when they make physical products. Companies developing whole aircraft or unmanned platform systems as their product are platform OEMs, not component suppliers, and are reject.",
    },
  },
} as const;
const r3Questions = {
  default: JEV_OVERSIZE_QUESTION,
  scale: {
    type: "noul",
    instructions:
      "Is there affirmative evidence this company operates at large-company scale (multi-state facilities, 100+ employees, Fortune-scale parent) or is a major prime, named subsidiary thereof, or platform aircraft OEM?",
    criteria: {
      true: "Large-scale operator, prime, subsidiary, or whole-aircraft OEM.",
      false: "Small single-site supplier, or scale unknown.",
    },
  },
} as const;

const apiKey = process.env.OPENROUTER_API_KEY ?? "";
if (!apiKey) throw new Error("OPENROUTER_API_KEY is required");
const model = process.env.JEV_MODEL ?? "typesafe/jev-1.13";
const repeats = Number(process.env.BAKEOFF_REPEATS ?? "1");

async function runVariant(
  name: string,
  domain: string | null,
  ownership: string,
  year?: number | null,
  synthetic?: {
    makes?: string[];
    modelsSample?: string[];
    excerpts?: string;
    websiteOffering?: string;
  },
): Promise<{ final: string; exit: string; cost: number; flipped?: boolean }> {
  const frozen =
    variant.enriched === true
      ? (evidenceByName[name] as
          | {
              domain?: string;
              websiteOffering?: string;
              excerptsTrimmedTo500Chars?: string;
              ownershipHints?: string[];
              sizeHints?: string[];
              productHints?: string[];
              error?: boolean;
            }
          | undefined)
      : undefined;
  const website =
    synthetic?.excerpts !== undefined ||
    synthetic?.websiteOffering !== undefined
      ? {
          websiteOffering: synthetic?.websiteOffering ?? "products_menu",
          excerpts: synthetic?.excerpts ?? "",
          ownershipHints: [],
          sizeHints: [],
        }
      : frozen !== undefined &&
          frozen.error !== true &&
          typeof frozen.websiteOffering === "string"
        ? {
            websiteOffering: frozen.websiteOffering,
            excerpts: frozen.excerptsTrimmedTo500Chars ?? "",
            ownershipHints: frozen.ownershipHints ?? [],
            sizeHints: frozen.sizeHints ?? [],
            productHints: frozen.productHints ?? [],
          }
        : undefined;
  const pkg = buildEvidencePackage(
    {
      id: `bakeoff-${name}`,
      raw_name: name,
      raw_domain: (frozen?.domain as string | undefined) ?? domain,
      cage: null,
      uei: null,
      city: null,
      state: null,
      country: null,
      award_count: synthetic ? 12 : null,
      freshest_award: null,
      created_at: new Date().toISOString(),
      source_payload:
        synthetic?.makes !== undefined
          ? {
              makes: synthetic.makes,
              models_sample: synthetic.modelsSample ?? [],
            }
          : {},
    },
    website as never,
    (ownership === "dead" ? "dead" : ownership) as never,
  );
  const state = {
    company_name: pkg.name,
    domain: pkg.domain,
    identifiers: {},
    location: {},
    part_count: pkg.partCount,
    makes: pkg.makes,
    models_sample: pkg.modelsSample,
    latest_supplement_date: pkg.supplementDate,
    website_offering: pkg.websiteOffering,
    ownership_status: pkg.ownershipStatus,
    product_evidence: pkg.productEvidence,
  };
  let cost = 0;
  const ask = async (q: Record<string, unknown>) => {
    const r = await callJev(apiKey, state, q, { model });
    cost += r.costUsd ?? 0;
    return r;
  };
  const flipYear = typeof year === "number" ? year : null;
  const flipYears = variant.flipYears ?? 5;
  const isFlip =
    variant.flipRule === true &&
    pkg.ownershipStatus === "pe_owned" &&
    flipYear !== null &&
    flipYear <= new Date().getFullYear() - flipYears;
  // Deterministic r0 name-shape rungs (mirror of runLadderSignal: same
  // matchers, same order, identity before ownership). Reject rungs exit
  // r0-veto; personal-name / single-token rungs persist an abstain row and
  // continue in production, so they are no-ops here by construction.
  if (matchNonprofitAcademicName(pkg.name) !== null)
    return { final: "reject", exit: "r0-veto", cost, flipped: isFlip };
  if (matchGovernmentRecipientName(pkg.name) !== null)
    return { final: "reject", exit: "r0-veto", cost, flipped: isFlip };
  if (
    variant.vetoFirst &&
    !isFlip &&
    variant.vetoStatuses.includes(pkg.ownershipStatus ?? "unknown")
  )
    return { final: "reject", exit: "r0-veto", cost, flipped: false };
  if (variant.order === "disposition-first") {
    const d = await ask({ disposition: JEV_DISPOSITION_QUESTION });
    const choice = String(d.answers["disposition"]?.choice ?? "");
    if (["high_priority", "research", "reject"].includes(choice))
      return { final: choice, exit: "r0-disposition", cost, flipped: isFlip };
  }
  if (variant.order === "vet-then-disposition") {
    const over0 = await ask({ oversize: JEV_OVERSIZE_QUESTION });
    const over0Noul = over0.answers["oversize"]?.noul;
    if (typeof over0Noul === "number" && over0Noul >= 0.5)
      return { final: "reject", exit: "r0-oversize", cost, flipped: isFlip };
    const d = await ask({ disposition: JEV_DISPOSITION_QUESTION });
    const choice = String(d.answers["disposition"]?.choice ?? "");
    if (["high_priority", "research", "reject"].includes(choice))
      return { final: choice, exit: "r0-disposition", cost, flipped: isFlip };
  }
  const r1 = await ask({
    manufacturer: r1Questions[variant.r1Mode ?? "default"],
  });
  const noul = r1.answers["manufacturer"]?.noul;
  if (typeof noul === "number" && noul < variant.r1Threshold)
    return { final: "reject", exit: "r1", cost, flipped: isFlip };
  if (variant.order === "screen-then-disposition") {
    const d = await ask({ disposition: JEV_DISPOSITION_QUESTION });
    const choice = String(d.answers["disposition"]?.choice ?? "");
    if (["high_priority", "research", "reject"].includes(choice))
      return { final: choice, exit: "r1-disposition", cost, flipped: isFlip };
  }
  const r2 = await ask({
    product_vs_process: r2Questions[variant.r2Mode],
  });
  if (
    String(r2.answers["product_vs_process"]?.choice ?? "") === "process" &&
    variant.r2Continue !== true
  )
    return { final: "research", exit: "r2", cost, flipped: isFlip };
  if (
    !isFlip &&
    variant.vetoStatuses.includes(pkg.ownershipStatus ?? "unknown")
  )
    return { final: "reject", exit: "r3-veto", cost, flipped: isFlip };
  const r3 = await ask({ oversize: r3Questions[variant.r3Mode ?? "default"] });
  const over = r3.answers["oversize"]?.noul;
  if (typeof over === "number" && over >= 0.5)
    return { final: "reject", exit: "r3", cost, flipped: isFlip };
  const r4 = await ask({
    disposition: r4Questions[variant.r4Mode ?? "default"],
  });
  const choice = String(r4.answers["disposition"]?.choice ?? "research");
  return {
    final: ["high_priority", "research", "reject"].includes(choice)
      ? choice
      : "research",
    exit: "r4",
    cost,
    flipped: isFlip,
  };
}

let miss = 0;
let totalCost = 0;
const exitCounts: Record<string, number> = {};
const extras: {
  name: string;
  ownership: string;
  expected: string;
  synthetic?: {
    makes?: string[];
    modelsSample?: string[];
    excerpts?: string;
    websiteOffering?: string;
  };
}[] = JSON.parse(
  readFileSync(new URL("./jev-bakeoff-extras.json", import.meta.url), "utf8"),
);
for (let rep = 0; rep < repeats; rep++) {
  for (const entry of INVESTOR_VERDICTS_V1) {
    const ownership =
      entry.expectedOwnershipStatus === "unknown"
        ? "unknown"
        : entry.expectedOwnershipStatus;
    const { final, exit, cost, flipped } = await runVariant(
      entry.name,
      null,
      ownership,
      entry.year ?? null,
    );
    totalCost += cost;
    exitCounts[exit] = (exitCounts[exit] ?? 0) + 1;
    let bad = false;
    if (entry.verdict === "add" && final !== "high_priority") bad = true;
    else if (entry.verdict === "hold" && final === "reject") bad = true;
    else if (entry.verdict.startsWith("pass_") && final !== "reject")
      bad = true;
    if (bad) {
      miss += 1;
      console.log(
        `${flipped === true ? "FLIP-MISS" : "MISS"} rep=${rep} name=${entry.name} verdict=${entry.verdict} final=${final} exit=${exit}`,
      );
    } else if (flipped === true) {
      console.log(
        `FLIP-OK rep=${rep} name=${entry.name} final=${final} exit=${exit}`,
      );
    }
  }
  for (const extra of extras) {
    const { final, exit, cost } = await runVariant(
      extra.name,
      null,
      extra.ownership,
      null,
      extra.synthetic,
    );
    exitCounts[exit] = (exitCounts[exit] ?? 0) + 1;
    if (final !== extra.expected) {
      miss += 1;
      console.log(
        `MISS rep=${rep} name=${extra.name} verdict=extra-${extra.expected} final=${final} exit=${exit}`,
      );
    }
  }
}
console.log(`EXITS ${JSON.stringify(exitCounts)}`);
console.log(`COST totalUsd=${totalCost.toFixed(4)}`);
console.log(`METRIC ladder_miss=${miss}`);
console.log(
  `ASI cases=${INVESTOR_VERDICTS_V1.length * repeats} cost_usd=${totalCost.toFixed(4)}`,
);
