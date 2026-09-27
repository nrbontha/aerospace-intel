/**
 * JEV bakeoff evidence freeze (one-shot, ~$0.50 Exa spend).
 *
 *   npx tsx scripts/jev-bakeoff-evidence.ts [--out scripts/jev-bakeoff-evidence.json]
 *
 * For each of the 29 names in INVESTOR_VERDICTS_V1:
 *   1. resolve the official domain via ExaSearchClient.searchOfficialDomainCandidates
 *      ({ legalName: name }), taking the top candidate as the best guess with a
 *      `domainConfidence: high | low` flag (high = a significant name token
 *      appears in the candidate title/url/domain, else low);
 *   2. call fetchWebsiteEvidence(apiKey, domain, name) — SKIPPED when confidence
 *      is low (spend cap);
 *   3. store { domain, domainConfidence, websiteOffering,
 *      excerptsTrimmedTo500Chars, ownershipHints, sizeHints } keyed by verdict
 *      name. On any failure store { error: true } and continue — never throws.
 *
 * Spend: one Exa search (~$0.005) per name + up to 3 contents pages (~$0.01 each)
 * for high-confidence domains only. fetchWebsiteEvidence enforces the shared
 * daily budget gate internally; search spend is recorded via recordExaSpendUsd.
 * Reports per-name domain hit rate + total Exa spend to stdout.
 */
import process from "node:process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { INVESTOR_VERDICTS_V1 } from "../packages/research/src/scoring-axial/fixtures/investor-verdicts.js";
import { ExaSearchClient } from "../packages/research/src/search/exa.js";
import { fetchWebsiteEvidence } from "../packages/research/src/enrichment/website.js";
import {
  EXA_CONTENTS_COST_USD,
  EXA_SEARCH_COST_USD,
  recordExaSpendUsd,
} from "../packages/research/src/enrichment/exa-budget.js";

// ---------------------------------------------------------------------------
// env bootstrap (mirror scripts/bench-enrichment.ts: source .env.local)
// ---------------------------------------------------------------------------
for (const line of existsSync(".env.local")
  ? readFileSync(".env.local", "utf8").split("\n")
  : []) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/u);
  const key = match?.[1];
  const value = match?.[2];
  if (key !== undefined && value !== undefined && process.env[key] === undefined) {
    process.env[key] = value.trim().replace(/^["']|["']$/gu, "");
  }
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const apiKey = process.env["EXA_API_KEY"];
if (apiKey === undefined || apiKey.trim().length === 0) {
  console.error("EXA_API_KEY is not configured; cannot freeze evidence.");
  process.exit(1);
}

const outPath = argValue("--out") ?? "scripts/jev-bakeoff-evidence.json";

// Tokens too generic to confirm a domain match.
const GENERIC_TOKENS = new Set([
  "llc",
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "company",
  "co",
  "ltd",
  "pllc",
  "dba",
  "subsidiary",
  "division",
  "group",
  "holdings",
  "international",
  "associates",
  "systems",
  "system",
  "industries",
  "industry",
  "products",
  "product",
  "technologies",
  "technology",
  "engineering",
  "aerospace",
  "aviation",
  "aircraft",
  "the",
  "and",
  "of",
]);

function significantTokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((t) => t.length >= 3 && !GENERIC_TOKENS.has(t));
}

type FrozenCase =
  | {
      readonly domain: string;
      readonly domainConfidence: "high" | "low";
      readonly websiteOffering: string;
      readonly excerptsTrimmedTo500Chars: string;
      readonly ownershipHints: readonly string[];
      readonly sizeHints: readonly string[];
      readonly fetchSkipped: boolean;
      readonly exaCostUsd: number;
    }
  | { readonly error: true };

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const client = new ExaSearchClient({ apiKey });
const frozen: Record<string, FrozenCase> = {};
let highConfidence = 0;
let anyDomain = 0;
let errors = 0;
let skippedLow = 0;
let totalSpendUsd = 0;

for (const entry of INVESTOR_VERDICTS_V1) {
  const name = entry.name;
  try {
    const candidates = await client.searchOfficialDomainCandidates({
      legalName: name,
    });
    recordExaSpendUsd(EXA_SEARCH_COST_USD);
    let spend = EXA_SEARCH_COST_USD;

    const top = candidates[0];
    if (top === undefined) {
      frozen[name] = { error: true };
      errors += 1;
      console.log(`MISS  ${name} — no candidates`);
    } else {
      anyDomain += 1;
      const haystack =
        `${top.title} ${top.url} ${top.domain}`.toLowerCase();
      const tokens = significantTokens(name);
      const matched =
        tokens.length > 0 && tokens.some((t) => haystack.includes(t));
      const domainConfidence = matched ? "high" : "low";
      if (matched) highConfidence += 1;

      if (!matched) {
        skippedLow += 1;
        frozen[name] = {
          domain: top.domain,
          domainConfidence,
          websiteOffering: "unknown",
          excerptsTrimmedTo500Chars: "",
          ownershipHints: [],
          sizeHints: [],
          fetchSkipped: true,
          exaCostUsd: spend,
        };
        console.log(`LOW   ${name} -> ${top.domain} (fetch skipped)`);
      } else {
        const site = await fetchWebsiteEvidence(apiKey, top.domain, name, {
          client,
        });
        spend += site.costUsd;
        frozen[name] = {
          domain: top.domain,
          domainConfidence,
          websiteOffering: site.websiteOffering,
          excerptsTrimmedTo500Chars: site.excerpts.slice(0, 500),
          ownershipHints: site.ownershipHints,
          sizeHints: site.sizeHints,
          fetchSkipped: false,
          exaCostUsd: spend,
        };
        const pages = `${site.fetchesSucceeded}/${site.fetchesAttempted}`;
        console.log(
          `HIT   ${name} -> ${top.domain} [${site.websiteOffering}, pages ${pages}]`,
        );
      }
    }
    totalSpendUsd += spend;
  } catch {
    frozen[name] = { error: true };
    errors += 1;
    console.log(`ERROR ${name} — stored {error:true}`);
  }
  await sleep(300);
}

writeFileSync(outPath, `${JSON.stringify(frozen, null, 2)}\n`);

const total = INVESTOR_VERDICTS_V1.length;
const hitRate =
  total === 0 ? "n/a" : `${((highConfidence / total) * 100).toFixed(1)}%`;
const anyRate =
  total === 0 ? "n/a" : `${((anyDomain / total) * 100).toFixed(1)}%`;
console.log("---");
console.log(`names: ${total}`);
console.log(`high-confidence domains: ${highConfidence} (${hitRate})`);
console.log(`any-domain guesses: ${anyDomain} (${anyRate})`);
console.log(`low-confidence fetches skipped: ${skippedLow}`);
console.log(`errors: ${errors}`);
console.log(
  `total Exa spend: $${totalSpendUsd.toFixed(3)} ` +
    `(search ${EXA_SEARCH_COST_USD}/call, contents $${EXA_CONTENTS_COST_USD}/page)`,
);
console.log(`wrote ${outPath}`);
