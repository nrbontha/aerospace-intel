/**
 * Head-to-head bake-off: JEv vs Muse screening judgments.
 *
 * Samples backed Muse verdicts (all high_priority + all reject + random
 * research fill), asks JEv the same disposition question from the same
 * evidence, and reports agreement, HP recall, reject precision, cost,
 * and latency. No pipeline writes: results print + JSON file only.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { getDatabase, closeDatabase } from "@asi/database";

import { callJev } from "../packages/research/src/faa-ensemble/jev.js";

interface SampleRow {
  signalId: string;
  rawName: string;
  city: string | null;
  state: string | null;
  payload: Record<string, unknown>;
  museDecision: string;
}

const DISPOSITION_QUESTION = {
  type: "choice",
  instructions:
    "Which pipeline disposition fits this aerospace/defense company as a potential sub-$50M acquisition target?",
  criteria: {
    high_priority:
      "Niche aerospace/defense manufacturer with proprietary or qualified products (PMA/STC/TSO, patents, branded components) and small private indicators.",
    research:
      "Plausibly relevant aerospace manufacturer but key facts (ownership, size, proprietary status) are missing.",
    reject:
      "Clearly outside the thesis: airline, airport, government, university, major prime, obviously large strategic, pure consultancy/software, distributor without manufacturing, or unrelated industry.",
  },
};

const MANUFACTURER_QUESTION = {
  type: "noul",
  instructions:
    "Does this company manufacture physical aerospace/defense products?",
  criteria: {
    true: "Designs or builds components, assemblies, parts, or systems.",
    false: "Services, distribution, software, or unrelated business only.",
  },
};

const OVERSIZE_QUESTION = {
  type: "noul",
  instructions:
    "Is there affirmative evidence this is a major prime or obviously large strategic company (or its named subsidiary)?",
  criteria: {
    true: "Major prime, Fortune-scale group, or named subsidiary thereof.",
    false: "Small or mid-size supplier, or size unknown.",
  },
};

function toState(row: SampleRow): Record<string, unknown> {
  const payload = row.payload;
  const makes = Array.isArray(payload["makes"])
    ? (payload["makes"] as unknown[])
        .filter((m): m is string => typeof m === "string")
        .slice(0, 12)
    : [];
  return {
    company_name: row.rawName,
    city: row.city,
    state: row.state,
    address: payload["address"] ?? null,
    part_count: payload["partCount"] ?? payload["part_count"] ?? null,
    makes,
    latest_supplement_date:
      payload["latest_supplement_date"] ??
      payload["latestSupplementDate"] ??
      null,
    guid_url: payload["guid_url"] ?? payload["guidUrl"] ?? null,
  };
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY ?? "";
  if (apiKey === "") throw new Error("OPENROUTER_API_KEY is required");
  const limit = Number(process.argv[2] ?? 100);
  const db = getDatabase();
  try {
    const { sql } = await import("drizzle-orm");
    const result = await db.execute<{
      signalId: string;
      rawName: string;
      city: string | null;
      state: string | null;
      source_payload: unknown;
      muse_decision: string;
    }>(sql`
      WITH backed AS (
        SELECT s.id AS signal_id, s.raw_name, s.city, s.state, s.source_payload,
               r.final_decision AS muse_decision,
               ROW_NUMBER() OVER (PARTITION BY r.final_decision ORDER BY random()) AS rn
        FROM faa_ensemble_results r JOIN source_signals s ON s.id = r.signal_id
        WHERE EXISTS (SELECT 1 FROM faa_ensemble_evaluations e WHERE e.signal_id = r.signal_id AND e.error IS NULL AND e.model_id LIKE 'meta/%')
      )
      SELECT * FROM backed
      WHERE muse_decision != 'research' OR rn <= ${limit}
      ORDER BY muse_decision, rn LIMIT ${limit}`);
    const sample = result.rows;
    console.log(`sample=${sample.length}`);
    let agree = 0;
    let hpRecall = 0;
    let hpTotal = 0;
    let rejectPrecision = 0;
    let rejectTotal = 0;
    let cost = 0;
    const t0 = Date.now();
    const details: Array<Record<string, unknown>> = [];
    for (const row of sample) {
      const state = toState({
        signalId: row.signalId,
        rawName: row.rawName,
        city: row.city,
        state: row.state,
        payload: (row.source_payload ?? {}) as Record<string, unknown>,
        museDecision: row.muse_decision,
      });
      const started = Date.now();
      try {
        const jevResult = await callJev(apiKey, state, {
          disposition: DISPOSITION_QUESTION,
          manufacturer: MANUFACTURER_QUESTION,
          oversize: OVERSIZE_QUESTION,
        });
        cost += jevResult.costUsd ?? 0;
        const choice = jevResult.answers["disposition"]?.choice ?? null;
        const match = choice === row.muse_decision;
        if (match) agree += 1;
        if (row.muse_decision === "high_priority") {
          hpTotal += 1;
          if (choice === "high_priority") hpRecall += 1;
        }
        if (choice === "reject") {
          rejectTotal += 1;
          if (row.muse_decision === "reject") rejectPrecision += 1;
        }
        details.push({
          name: row.rawName,
          muse: row.muse_decision,
          jev: choice,
          confidence: jevResult.answers["disposition"]?.confidence ?? null,
          ms: Date.now() - started,
        });
      } catch (error) {
        details.push({
          name: row.rawName,
          muse: row.muse_decision,
          jev: `ERROR: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    const ms = Date.now() - t0;
    const report = {
      n: sample.length,
      agreement: sample.length ? agree / sample.length : 0,
      hpRecall: hpTotal ? hpRecall / hpTotal : null,
      hpTotal,
      rejectPrecision: rejectTotal ? rejectPrecision / rejectTotal : null,
      rejectTotal,
      costUsd: cost,
      msTotal: ms,
      msPerSignal: sample.length ? ms / sample.length : 0,
      details,
    };
    console.log(JSON.stringify(report, null, 2).slice(0, 3000));
    await mkdir("/tmp", { recursive: true });
    await writeFile(
      `/tmp/jev-benchmark-${Date.now()}.json`,
      JSON.stringify(report, null, 2),
    );
  } finally {
    await closeDatabase().catch(() => undefined);
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  await main();
}
