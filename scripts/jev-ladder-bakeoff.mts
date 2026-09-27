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
} from "../packages/research/src/faa-ensemble/runner.js";
import { INVESTOR_VERDICTS_V1 } from "../packages/research/src/scoring-axial/fixtures/investor-verdicts.js";

interface Variant {
  r1Threshold: number;
  vetoStatuses: string[];
  r2Mode: "choice" | "strict-product" | "lenient";
  order: "ladder" | "disposition-first";
  vetoFirst: boolean;
}

const variant: Variant = JSON.parse(
  readFileSync(
    new URL("./jev-ladder-variant.json", import.meta.url),
    "utf8",
  ),
);
const apiKey = process.env.OPENROUTER_API_KEY ?? "";
if (!apiKey) throw new Error("OPENROUTER_API_KEY is required");
const model = process.env.JEV_MODEL ?? "typesafe/jev-1.13";
const repeats = Number(process.env.BAKEOFF_REPEATS ?? "1");

const r2Questions = {
  choice: JEV_PRODUCT_PROCESS_QUESTION,
  "strict-product": {
    type: "choice",
    instructions:
      "Does this company sell a proprietary manufactured PRODUCT with a name, brand, catalog SKU, PMA/STC article, or patent? Answer product ONLY on a named article; marketing capabilities alone are process.",
    criteria: (JEV_PRODUCT_PROCESS_QUESTION.criteria as Record<string, string>),
  },
  lenient: {
    type: "choice",
    instructions:
      "Might this company sell any proprietary manufactured product, even on thin evidence?",
    criteria: (JEV_PRODUCT_PROCESS_QUESTION.criteria as Record<string, string>),
  },
} as const;

async function runVariant(
  name: string,
  domain: string | null,
  ownership: string,
): Promise<{ final: string; exit: string; cost: number }> {
  const pkg = buildEvidencePackage(
    {
      id: `bakeoff-${name}`,
      raw_name: name,
      raw_domain: domain,
      cage: null,
      uei: null,
      city: null,
      state: null,
      country: null,
      award_count: null,
      freshest_award: null,
      created_at: new Date().toISOString(),
      source_payload: {},
    },
    undefined,
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
  if (
    variant.vetoFirst &&
    variant.vetoStatuses.includes(pkg.ownershipStatus ?? "unknown")
  )
    return { final: "reject", exit: "r0-veto", cost };
  if (variant.order === "disposition-first" || variant.order === "vet-then-disposition") {
    if (variant.order === "vet-then-disposition") {
      const over = await ask({ oversize: JEV_OVERSIZE_QUESTION });
      const overNoul = over.answers["oversize"]?.noul;
      if (typeof overNoul === "number" && overNoul >= 0.5)
        return { final: "reject", exit: "r0-oversize", cost };
    }
    const d = await ask({ disposition: JEV_DISPOSITION_QUESTION });
    const choice = String(d.answers["disposition"]?.choice ?? "");
    if (["high_priority", "research", "reject"].includes(choice))
      return { final: choice, exit: "r0-disposition", cost };
  }
  const r1 = await ask({ manufacturer: JEV_MANUFACTURER_QUESTION });
  const noul = r1.answers["manufacturer"]?.noul;
  if (typeof noul === "number" && noul < variant.r1Threshold)
    return { final: "reject", exit: "r1", cost };
  if (variant.order === "screen-then-disposition") {
    const d = await ask({ disposition: JEV_DISPOSITION_QUESTION });
    const choice = String(d.answers["disposition"]?.choice ?? "");
    if (["high_priority", "research", "reject"].includes(choice))
      return { final: choice, exit: "r1-disposition", cost };
  }
  const r2 = await ask({
    product_vs_process: r2Questions[variant.r2Mode],
  });
  if (String(r2.answers["product_vs_process"]?.choice ?? "") === "process")
    return { final: "research", exit: "r2", cost };
  if (variant.vetoStatuses.includes(pkg.ownershipStatus ?? "unknown"))
    return { final: "reject", exit: "r3-veto", cost };
  const r3 = await ask({ oversize: JEV_OVERSIZE_QUESTION });
  const over = r3.answers["oversize"]?.noul;
  if (typeof over === "number" && over >= 0.5)
    return { final: "reject", exit: "r3", cost };
  const r4 = await ask({ disposition: JEV_DISPOSITION_QUESTION });
  const choice = String(r4.answers["disposition"]?.choice ?? "research");
  return {
    final: ["high_priority", "research", "reject"].includes(choice)
      ? choice
      : "research",
    exit: "r4",
    cost,
  };
}

let miss = 0;
let totalCost = 0;
const exitCounts: Record<string, number> = {};
for (let rep = 0; rep < repeats; rep++) {
  for (const entry of INVESTOR_VERDICTS_V1) {
    const ownership =
      entry.expectedOwnershipStatus === "unknown"
        ? "unknown"
        : entry.expectedOwnershipStatus;
    const { final, exit, cost } = await runVariant(
      entry.name,
      null,
      ownership,
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
        `MISS rep=${rep} name=${entry.name} verdict=${entry.verdict} final=${final} exit=${exit}`,
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
