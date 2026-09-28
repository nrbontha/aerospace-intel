import { and, asc, eq, isNull, sql } from "drizzle-orm";

import type { Database } from "../client.js";
import {
  faaEnsembleEvaluations,
  faaEnsembleResults,
  faaReviewModelUsage,
  sourceSignals,
  type FaaEnsembleEvaluation,
  type FaaEnsembleResult,
  type FaaReviewModelUsage,
  type NewFaaEnsembleEvaluation,
  type NewFaaEnsembleResult,
  type NewFaaReviewModelUsage,
  type SourceSignal,
  type SourceSignalStatus,
} from "../schema.js";

export type FaaReviewModelUsageReceiptInput = NewFaaReviewModelUsage & {
  readonly id: string;
};

/**
 * Append one provider-response receipt. The caller allocates the UUID before
 * the provider call and reuses it for any persistence retry; a retry after an
 * ambiguous database outcome therefore cannot duplicate the observed charge.
 */
export async function insertFaaReviewModelUsageReceipt(
  db: Database,
  input: FaaReviewModelUsageReceiptInput,
): Promise<FaaReviewModelUsage> {
  const inserted = await db
    .insert(faaReviewModelUsage)
    .values(input)
    .onConflictDoNothing({ target: faaReviewModelUsage.id })
    .returning();
  if (inserted[0] !== undefined) return inserted[0];

  const existing = await db
    .select()
    .from(faaReviewModelUsage)
    .where(eq(faaReviewModelUsage.id, input.id))
    .limit(1);
  if (existing[0] === undefined) {
    throw new Error(`FAA review usage receipt ${input.id} was not persisted`);
  }
  return existing[0];
}

/**
 * Persist one model's vote once per immutable input revision. A repeated
 * (signal, model, prompt, input) vote resolves to null instead of a second row.
 */
export async function insertEvaluation(
  db: Database,
  input: NewFaaEnsembleEvaluation,
): Promise<FaaEnsembleEvaluation | null> {
  const rows = await db
    .insert(faaEnsembleEvaluations)
    .values(input)
    .onConflictDoNothing({
      target: [
        faaEnsembleEvaluations.signalId,
        faaEnsembleEvaluations.modelId,
        faaEnsembleEvaluations.promptVersion,
        faaEnsembleEvaluations.inputHash,
      ],
    })
    .returning();
  return rows[0] ?? null;
}

/** Read every recorded vote for one signal, oldest first. */
export async function getEvaluations(
  db: Database,
  signalId: string,
): Promise<FaaEnsembleEvaluation[]> {
  return db
    .select()
    .from(faaEnsembleEvaluations)
    .where(eq(faaEnsembleEvaluations.signalId, signalId))
    .orderBy(asc(faaEnsembleEvaluations.createdAt));
}

/**
 * Persist the ensemble outcome for a signal. The insert is idempotent; when a
 * result row already exists it is refreshed in place and returned.
 */
export async function insertOrUpdateResult(
  db: Database,
  input: NewFaaEnsembleResult,
): Promise<FaaEnsembleResult> {
  const inserted = await db
    .insert(faaEnsembleResults)
    .values(input)
    .onConflictDoNothing({ target: faaEnsembleResults.signalId })
    .returning();
  const created = inserted[0];
  if (created !== undefined) return created;

  const updates: Partial<NewFaaEnsembleResult> = {
    ...input,
    updatedAt: new Date(),
  };
  delete updates.id;
  delete updates.signalId;
  const rows = await db
    .update(faaEnsembleResults)
    .set(updates)
    .where(eq(faaEnsembleResults.signalId, input.signalId))
    .returning();
  const updated = rows[0];
  if (updated === undefined) {
    throw new Error(
      `faa_ensemble_results upsert returned no row for signal ${input.signalId}`,
    );
  }
  return updated;
}

/** Read the ensemble outcome for one signal, or null when not yet run. */
export async function getResult(
  db: Database,
  signalId: string,
): Promise<FaaEnsembleResult | null> {
  const rows = await db
    .select()
    .from(faaEnsembleResults)
    .where(eq(faaEnsembleResults.signalId, signalId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * List signals in the given status that have no ensemble result yet, oldest
 * first with `queued_qualification` rows ahead of any other status.
 */
export async function listSignalsWithoutResults(
  db: Database,
  status: SourceSignalStatus = "queued_qualification",
  limit = 50,
): Promise<SourceSignal[]> {
  const capped = Math.min(Math.max(1, Math.trunc(limit)), 500);
  const rows = await db
    .select({ signal: sourceSignals })
    .from(sourceSignals)
    .leftJoin(
      faaEnsembleResults,
      eq(faaEnsembleResults.signalId, sourceSignals.id),
    )
    .where(and(eq(sourceSignals.status, status), isNull(faaEnsembleResults.id)))
    .orderBy(
      sql`CASE WHEN ${sourceSignals.status} = 'queued_qualification' THEN 0 ELSE 1 END`,
      asc(sourceSignals.createdAt),
    )
    .limit(capped);
  return rows.map((row) => row.signal);
}
