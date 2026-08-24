/**
 * One-shot lead domain-resolution runner (Wave B).
 *
 * Drives the SAME path as the resolve_domain supervisor agent — production
 * deps (browser-UA SafeFetchDomainProber + OpenRouter prompt-contract judge)
 * built by buildDomainResolutionDeps — without needing a worker restart.
 *
 * Usage:
 *   set -a; source .env.local; set +a
 *   npx tsx scripts/resolve-leads-once.mts [--limit N]
 *
 * Prints one line per lead outcome plus a cost/aggregate summary.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { closeDatabase, getDatabase, resolveLeadDomain } from "@asi/database";

import {
  buildDomainResolutionDeps,
  judgeCostUsd,
  selectDomainResolutionBatch,
} from "../apps/worker/src/supervisor/handlers.js";

function loadDatabaseUrl(): void {
  if (process.env.DATABASE_URL !== undefined && process.env.DATABASE_URL !== "") return;
  for (const candidate of [path.join(process.cwd(), ".env.local"), path.join(process.cwd(), ".env")]) {
    if (!existsSync(candidate)) continue;
    for (const line of readFileSync(candidate, "utf8").split("\n")) {
      const match = /^DATABASE_URL=(.*)$/.exec(line.trim());
      if (match?.[1] !== undefined) {
        process.env.DATABASE_URL = match[1].trim();
        return;
      }
    }
  }
}

const limitFlagIndex = process.argv.indexOf("--limit");
let limit = 5;
if (limitFlagIndex !== -1) {
  const raw = process.argv[limitFlagIndex + 1];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    console.error("--limit must be a positive integer");
    process.exit(2);
  }
  limit = parsed;
}

loadDatabaseUrl();
if (process.env.DATABASE_URL === undefined) {
  console.error("DATABASE_URL is required (.env.local or environment)");
  process.exit(2);
}

const runtime = buildDomainResolutionDeps();
if (runtime === null) {
  console.error("OpenRouter is not configured (OPENROUTER_API_KEY missing) — cannot resolve domains");
  process.exit(1);
}

const db = getDatabase();
const batch = await selectDomainResolutionBatch(db, limit);
console.log(`selected ${batch.length} unresolved lead(s) without a possible_domain`);

const counts = { verified: 0, noDomain: 0, mismatched: 0, errors: 0 };
for (const lead of batch) {
  try {
    const result = await resolveLeadDomain(db, lead.id, runtime.deps, { maxCandidates: 3 });
    switch (result.outcome) {
      case "domain_verified":
        counts.verified += 1;
        console.log(
          `VERIFIED   ${lead.rawName} -> ${result.domain} ` +
            `(confidence=${result.confidence?.toFixed(2)}, company=${result.companyId})`,
        );
        break;
      case "no_domain_found":
        counts.noDomain += 1;
        console.log(`NO_DOMAIN  ${lead.rawName}`);
        break;
      case "identity_mismatch":
        counts.mismatched += 1;
        console.log(`MISMATCH   ${lead.rawName} (attempts kept in lead context)`);
        break;
      default:
        console.log(`SKIPPED    ${lead.rawName} (${result.outcome})`);
    }
  } catch (error) {
    counts.errors += 1;
    console.log(`ERROR      ${lead.rawName}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(
  `\nsummary: ${JSON.stringify(counts)} of ${batch.length} selected, ` +
    `modelCostUsd=${judgeCostUsd(runtime.judge).toFixed(6)}`,
);
await closeDatabase();
