/**
 * Reconcile every currently observable stale FAA review input without making
 * provider calls. The command fails closed when locked source-revision rows
 * prevent a complete one-shot drain.
 *
 * Usage:
 *   npx tsx scripts/reconcile-stale-reviews.mts
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { closeDatabase, getDatabase } from "../packages/database/src/client.js";
import {
  CurrentReviewInputDrainIncompleteError,
  drainCurrentReviewInputs,
} from "../packages/research/src/faa-ensemble/runner.js";

for (const line of existsSync(".env.local")
  ? readFileSync(".env.local", "utf8").split("\n")
  : []) {
  const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/u);
  const key = match?.[1];
  const value = match?.[2];
  if (
    key !== undefined &&
    value !== undefined &&
    process.env[key] === undefined
  ) {
    process.env[key] = value;
  }
}

async function main(): Promise<void> {
  try {
    const result = await drainCurrentReviewInputs(getDatabase());
    console.log(
      `[review-reconcile] source-revision=${result.sourceRevisionChanges} input-contract=${result.inputContractChanges} passes=${result.reconciliationPasses} provider-calls=0`,
    );
  } catch (error) {
    if (error instanceof CurrentReviewInputDrainIncompleteError) {
      console.error(
        `[review-reconcile] incomplete reason=${error.reason} source-revision=${error.partialResult.sourceRevisionChanges} input-contract=${error.partialResult.inputContractChanges} passes=${error.partialResult.reconciliationPasses} remaining-source-revision=${error.remainingSourceRevisionChanges} provider-calls=0`,
      );
    }
    throw error;
  } finally {
    await closeDatabase();
  }
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  await main();
}
