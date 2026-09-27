/**
 * Measure JEv question variants against labeled verdicts.
 *
 * Usage: npx tsx scripts/jev-tune-measure.mts <variants.json> <labeled.tsv>
 * TSV: raw_name, city, state, source_payload JSON, muse_decision, muse_confidence.
 * Prints per-variant agreement / HP recall / reject precision / cost.
 */
import { readFileSync } from "node:fs";

import { callJev } from "../packages/research/src/faa-ensemble/jev.js";

interface Variant {
  disposition: unknown;
  manufacturer: unknown;
  oversize: unknown;
}

function parsePayload(raw: string): Record<string, unknown> {
  const attempts = [raw];
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    attempts.push(trimmed.slice(1, -1).replace(/""/g, '"'));
  }
  attempts.push(raw.replace(/""/g, '"'));
  for (const text of attempts) {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      // try next repair
    }
  }
  return {};
}
function toState(cells: string[]): Record<string, unknown> {
  const payload = parsePayload(cells[3] ?? "{}");
  const makes = Array.isArray(payload["makes"])
    ? (payload["makes"] as unknown[])
        .filter((m): m is string => typeof m === "string")
        .slice(0, 12)
    : [];
  return {
    company_name: cells[0] ?? "",
    city: cells[1] || null,
    address: payload["address"] ?? null,
    part_count: (() => {
      const count = payload["partCount"] ?? payload["part_count"];
      return count == null ? null : String(count);
    })(),
  };
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY ?? "";
  if (apiKey === "") throw new Error("OPENROUTER_API_KEY is required");
  const variants = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Record<
    string,
    Variant
  >;
  const lines = readFileSync(process.argv[3]!, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
  const rows = lines.map((l) => {
    const cells = l.split("\t");
    return { cells, label: cells[4] ?? "research" };
  });
  for (const [name, variant] of Object.entries(variants)) {
    let agree = 0;
    let hp = 0;
    let hpHit = 0;
    let rej = 0;
    let rejHit = 0;
    let cost = 0;
    let errors = 0;
    for (const row of rows) {
      try {
        const result = await callJev(apiKey, toState(row.cells), {
          disposition: variant.disposition,
          manufacturer: variant.manufacturer,
          oversize: variant.oversize,
        });
        cost += result.costUsd ?? 0;
        const choice = String(result.answers["disposition"]?.choice ?? "");
        if (choice === row.label) agree += 1;
        if (row.label === "high_priority") {
          hp += 1;
          if (choice === "high_priority") hpHit += 1;
        }
        if (choice === "reject") {
          rej += 1;
          if (row.label === "reject") rejHit += 1;
        }
      } catch (error) {
        errors += 1;
        if (errors <= 3)
          console.error("row error:", String(error).slice(0, 300));
      }
    }
    console.log(
      `${name}: n=${rows.length} agreement=${(agree / rows.length).toFixed(3)} ` +
        `hp_recall=${hp ? `${hpHit}/${hp}` : "n/a"} reject_precision=${rej ? `${rejHit}/${rej}` : "n/a"} ` +
        `cost=${cost.toFixed(5)} errors=${errors}`,
    );
  }
}

await main();
