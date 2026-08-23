import { and, asc, desc, eq, ilike, max, sql } from "drizzle-orm";

import type {
  ExperimentRunCreate,
  ExperimentRunDto,
  ProgramAxis,
  ScoringProgramCreate,
  ScoringProgramDto,
} from "@asi/contracts";

import type { Database } from "../client.js";
import {
  auditEvents,
  experimentRuns,
  scoringPrograms,
  type SelectRow,
} from "../schema.js";

/**
 * Persistence for the scoring-axial experiment journal.
 *
 * `experiment_runs` is append-only (enforced by the
 * `deny_experiment_runs_mutation` trigger): decisions are journaled as NEW
 * lineage-child rows pointing at the run they decide, never as updates.
 * All mutating helpers accept the acting user id so the caller route can
 * have the mutation and its audit event committed atomically.
 */

export type ExperimentRunRow = SelectRow<typeof experimentRuns>;
export type ScoringProgramRow = SelectRow<typeof scoringPrograms>;

/** Program DTO with the champion flag every list/detail caller needs. */
export type ScoringProgramView = ScoringProgramDto & { isChampion: boolean };

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function toRunDto(row: ExperimentRunRow): ExperimentRunDto {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    primaryMetricName: row.primaryMetricName ?? undefined,
    primaryMetricValue:
      row.primaryMetricValue === null ? undefined : Number(row.primaryMetricValue),
    result: row.result,
    keep: row.keep ?? undefined,
    decision: row.decision ?? undefined,
    lineageParentId: row.lineageParentId ?? undefined,
    campaignId: row.campaignId ?? undefined,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

function toProgramDto(row: ScoringProgramRow, isChampion: boolean): ScoringProgramView {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    axis: row.axis,
    program: row.program,
    complexity: row.complexity === null ? undefined : Number(row.complexity),
    status: row.status,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    isChampion,
  };
}

// ---------------------------------------------------------------------------
// Audit helper (routes pass the authenticated actor; same transaction)
// ---------------------------------------------------------------------------

export interface ExperimentAuditInput {
  readonly action: string;
  readonly entityType: "scoring_program" | "experiment_run";
  readonly entityId: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly metadata?: Record<string, unknown>;
}

/** Append one audit event; call with the SAME db/tx that did the mutation. */
export async function recordExperimentAudit(
  db: Database,
  actorUserId: string | null | undefined,
  input: ExperimentAuditInput,
): Promise<void> {
  await db.insert(auditEvents).values({
    actorUserId: actorUserId ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    before: input.before ?? null,
    after: input.after ?? null,
    metadata: input.metadata ?? {},
  });
}

// ---------------------------------------------------------------------------
// Experiment runs
// ---------------------------------------------------------------------------

/** Append-only insert of one experiment_runs journal row. */
export async function recordExperimentRun(
  db: Database,
  input: ExperimentRunCreate,
  actorUserId?: string | null,
): Promise<ExperimentRunDto> {
  const [row] = await db
    .insert(experimentRuns)
    .values({
      kind: input.kind,
      label: input.label,
      primaryMetricName: input.primaryMetricName ?? null,
      primaryMetricValue:
        input.primaryMetricValue === undefined ? null : String(input.primaryMetricValue),
      result: input.result ?? {},
      keep: input.keep ?? null,
      decision: input.decision ?? null,
      lineageParentId: input.lineageParentId ?? null,
      campaignId: input.campaignId ?? null,
      createdBy: actorUserId ?? null,
    })
    .returning();
  if (row === undefined) throw new Error("experiment_run insert returned no row");
  // Every journal append is audit-evented; routes pass the acting user,
  // background callers may leave the actor null.
  await recordExperimentAudit(db, actorUserId, {
    action: "create",
    entityType: "experiment_run",
    entityId: row.id,
    after: row.result,
    metadata: { kind: row.kind, label: row.label },
  });
  return toRunDto(row);
}

export async function getExperimentRun(
  db: Database,
  id: string,
): Promise<ExperimentRunDto | null> {
  const [row] = await db
    .select()
    .from(experimentRuns)
    .where(eq(experimentRuns.id, id))
    .limit(1);
  return row === undefined ? null : toRunDto(row);
}

export interface ExperimentRunFilters {
  /** Only runs whose lineage parent is this run id. */
  readonly lineageParentId?: string | undefined;
  readonly kind?: ExperimentRunCreate["kind"] | undefined;
  readonly keep?: boolean | undefined;
  /** Substring match on the label. */
  readonly label?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

/** Chronological journal listing (newest first) with lineage children inlined. */
export async function listExperimentRuns(
  db: Database,
  filters: ExperimentRunFilters = {},
): Promise<{ records: ExperimentRunDto[]; total: number }> {
  const conditions = [
    filters.kind === undefined ? undefined : eq(experimentRuns.kind, filters.kind),
    filters.lineageParentId === undefined
      ? undefined
      : eq(experimentRuns.lineageParentId, filters.lineageParentId),
    filters.keep === undefined ? undefined : eq(experimentRuns.keep, filters.keep),
    filters.label === undefined || filters.label === ""
      ? undefined
      : ilike(experimentRuns.label, `%${filters.label}%`),
  ].filter((condition) => condition !== undefined);
  const where =
    conditions.length === 0 ? undefined : and(...conditions);

  const rows = await db
    .select()
    .from(experimentRuns)
    .where(where)
    .orderBy(desc(experimentRuns.createdAt), desc(experimentRuns.id))
    .limit(filters.limit ?? 100)
    .offset(filters.offset ?? 0);

  const [countRow] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(experimentRuns)
    .where(where);

  return { records: rows.map(toRunDto), total: countRow?.c ?? 0 };
}

// ---------------------------------------------------------------------------
// Scoring programs
// ---------------------------------------------------------------------------

export async function getScoringProgram(
  db: Database,
  id: string,
): Promise<ScoringProgramView | null> {
  const [row] = await db
    .select()
    .from(scoringPrograms)
    .where(eq(scoringPrograms.id, id))
    .limit(1);
  return row === undefined ? null : toProgramDto(row, row.status === "champion");
}

export async function getChampionProgram(
  db: Database,
  axis: ProgramAxis,
): Promise<ScoringProgramView | null> {
  const [row] = await db
    .select()
    .from(scoringPrograms)
    .where(and(eq(scoringPrograms.axis, axis), eq(scoringPrograms.status, "champion")))
    .orderBy(desc(scoringPrograms.version))
    .limit(1);
  return row === undefined ? null : toProgramDto(row, true);
}

export interface ProgramListFilters {
  readonly axis?: ProgramAxis;
  readonly status?: ScoringProgramDto["status"];
}

/** Programs ordered champion-first, then by name/version. */
export async function listScoringPrograms(
  db: Database,
  filters: ProgramListFilters = {},
): Promise<ScoringProgramView[]> {
  const conditions = [
    filters.axis === undefined ? undefined : eq(scoringPrograms.axis, filters.axis),
    filters.status === undefined
      ? undefined
      : eq(scoringPrograms.status, filters.status),
  ].filter((condition) => condition !== undefined);

  const rows = await db
    .select()
    .from(scoringPrograms)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(
      // champions first within an axis
      sql`case when ${scoringPrograms.status} = 'champion' then 0 else 1 end`,
      asc(scoringPrograms.name),
      desc(scoringPrograms.version),
    );

  return rows.map((row) => toProgramDto(row, row.status === "champion"));
}

/**
 * Register a program. Versioning rule: when (name, version) is already
 * taken, the insert bumps to the next free version for that name — callers
 * never collide on re-registration.
 */
export async function upsertProgram(
  db: Database,
  create: ScoringProgramCreate,
  actorUserId?: string | null,
): Promise<ScoringProgramDto> {
  return db.transaction(async (tx): Promise<ScoringProgramDto> => {
    const [maxRow] = await tx
      .select({ maxVersion: max(scoringPrograms.version) })
      .from(scoringPrograms)
      .where(eq(scoringPrograms.name, create.name));
    const requestedFree =
      maxRow?.maxVersion === null || create.version > maxRow!.maxVersion!;
    const version = requestedFree ? create.version : maxRow!.maxVersion! + 1;

    const [row] = await tx
      .insert(scoringPrograms)
      .values({
        name: create.name,
        version,
        axis: create.axis,
        program: create.program,
        status: "challenger",
        complexity:
          create.complexity === undefined ? null : String(create.complexity),
        createdBy: actorUserId ?? null,
      })
      .returning();
    if (row === undefined) throw new Error("scoring_program insert returned no row");
    await recordExperimentAudit(tx, actorUserId, {
      action: "create",
      entityType: "scoring_program",
      entityId: row.id,
      after: row.program,
      metadata: { name: row.name, version: row.version, axis: row.axis },
    });
    return toProgramDto(row, false);
  });
}

class ProgramMutationError extends Error {}

async function loadProgramForUpdate(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  id: string,
): Promise<ScoringProgramRow> {
  const [row] = await tx
    .select()
    .from(scoringPrograms)
    .where(eq(scoringPrograms.id, id))
    .for("update")
    .limit(1);
  if (row === undefined) {
    throw new ProgramMutationError(`scoring program ${id} not found`);
  }
  return row;
}

/**
 * Transactional promotion: any current champion on the same axis is archived,
 * then the target becomes champion. Idempotent-safe: promoting an existing
 * champion is a no-op flip that still journals the audit event.
 */
export async function promoteProgram(
  db: Database,
  id: string,
  rationale: string,
  actorUserId?: string | null,
  /** Extra audit metadata (e.g. promotion-gate evidence). */
  auditMetadata: Record<string, unknown> = {},
): Promise<ScoringProgramDto> {
  return db.transaction(async (tx): Promise<ScoringProgramDto> => {
    const target = await loadProgramForUpdate(tx, id);
    const previousChampions = await tx
      .select()
      .from(scoringPrograms)
      .where(
        and(
          eq(scoringPrograms.axis, target.axis),
          eq(scoringPrograms.status, "champion"),
        ),
      )
      .for("update");

    for (const champion of previousChampions) {
      if (champion.id === target.id) continue;
      await tx
        .update(scoringPrograms)
        .set({ status: "archived" })
        .where(eq(scoringPrograms.id, champion.id));
    }

    const [updated] = await tx
      .update(scoringPrograms)
      .set({ status: "champion" })
      .where(eq(scoringPrograms.id, target.id))
      .returning();
    if (updated === undefined) {
      throw new ProgramMutationError(`scoring program ${id} not found`);
    }

    await recordExperimentAudit(tx, actorUserId, {
      action: "promote",
      entityType: "scoring_program",
      entityId: updated.id,
      before: { status: target.status },
      after: { status: updated.status },
      metadata: {
        rationale,
        axis: updated.axis,
        archivedChampionIds: previousChampions
          .filter((c) => c.id !== target.id)
          .map((c) => c.id),
        ...auditMetadata,
      },
    });
    return toProgramDto(updated, true);
  });
}

/** Champion → challenger (revert). */
export async function demoteProgram(
  db: Database,
  id: string,
  rationale: string,
  actorUserId?: string | null,
): Promise<ScoringProgramDto> {
  return db.transaction(async (tx): Promise<ScoringProgramDto> => {
    const target = await loadProgramForUpdate(tx, id);
    const [updated] = await tx
      .update(scoringPrograms)
      .set({ status: target.status === "champion" ? "challenger" : target.status })
      .where(eq(scoringPrograms.id, target.id))
      .returning();
    if (updated === undefined) {
      throw new ProgramMutationError(`scoring program ${id} not found`);
    }
    await recordExperimentAudit(tx, actorUserId, {
      action: "demote",
      entityType: "scoring_program",
      entityId: updated.id,
      before: { status: target.status },
      after: { status: updated.status },
      metadata: { rationale },
    });
    return toProgramDto(updated, updated.status === "champion");
  });
}

export async function rejectProgram(
  db: Database,
  id: string,
  rationale: string,
  actorUserId?: string | null,
): Promise<ScoringProgramDto> {
  return db.transaction(async (tx): Promise<ScoringProgramDto> => {
    const target = await loadProgramForUpdate(tx, id);
    const [updated] = await tx
      .update(scoringPrograms)
      .set({ status: "rejected" })
      .where(eq(scoringPrograms.id, target.id))
      .returning();
    if (updated === undefined) {
      throw new ProgramMutationError(`scoring program ${id} not found`);
    }
    await recordExperimentAudit(tx, actorUserId, {
      action: "reject",
      entityType: "scoring_program",
      entityId: updated.id,
      before: { status: target.status },
      after: { status: updated.status },
      metadata: { rationale },
    });
    return toProgramDto(updated, false);
  });
}
// ---------------------------------------------------------------------------
// Promotion gate (evaluated over the append-only journal record)
// ---------------------------------------------------------------------------

/** Minimum primary-metric gain over the current champion to count as real. */
export const PROMOTION_GATE_EPSILON = 0.02;

/** One serialized entry of a scorer run's `result.entries` (run-scorer shape). */
export interface PromotionGateRunEntry {
  readonly programId: string | null;
  readonly name: string;
  readonly role: "champion" | "challenger";
  readonly axis?: string;
  readonly rank?: number | null;
  readonly strongVsNegativeSeparation?: number | null;
  readonly vetoAudit?: { readonly passed?: boolean } | null;
  readonly leakedFields?: readonly string[];
}

export interface PromotionGateEvaluation {
  readonly allowed: boolean;
  /** Human-readable failure reasons; empty when allowed. */
  readonly reasons: readonly string[];
  /** Metric evidence recorded on the promotion audit event. */
  readonly metricSnapshot: {
    readonly challengerMetric: number | null;
    readonly championMetric: number | null;
    readonly gain: number | null;
  } | null;
}

/**
 * Decide whether `programId` may be promoted based on the stored experiment
 * run: the program must be an evaluated challenger of the run whose entry is
 * veto-audit clean, leakage clean, and improves the primary metric beyond
 * epsilon over the same-axis champion baseline recorded in the SAME run.
 * Legacy runs without per-entry axis data fail closed.
 */
export function evaluatePromotionGate(
  run: ExperimentRunDto | null,
  programId: string,
): PromotionGateEvaluation {
  if (run === null) {
    return {
      allowed: false,
      reasons: ["experiment run not found"],
      metricSnapshot: null,
    };
  }
  const result: unknown = run.result;
  const rawEntries =
    result !== null && typeof result === "object" && "entries" in result
      ? result.entries
      : undefined;
  // jsonb written by run-scorer's serializedEntries; every read below is
  // optional-chained/guarded, so a malformed row fails closed.
  const entries: readonly PromotionGateRunEntry[] = Array.isArray(rawEntries)
    ? (rawEntries as readonly PromotionGateRunEntry[])
    : [];
  if (entries.length === 0) {
    return {
      allowed: false,
      reasons: ["run result has no evaluated program entries"],
      metricSnapshot: null,
    };
  }
  const challenger = entries.find(
    (entry) => entry.role === "challenger" && entry.programId === programId,
  );
  if (challenger === undefined) {
    return {
      allowed: false,
      reasons: [`program ${programId} is not a challenger evaluated by this run`],
      metricSnapshot: null,
    };
  }
  const reasons: string[] = [];
  if (challenger.axis === undefined) {
    reasons.push("run entry predates per-axis attribution (legacy run)");
  }
  const championBaseline =
    challenger.axis === undefined
      ? undefined
      : entries.find(
          (entry) => entry.role === "champion" && entry.axis === challenger.axis,
        );
  if (challenger.axis !== undefined && championBaseline === undefined) {
    reasons.push(`no ${challenger.axis} champion baseline in the run`);
  }
  if (challenger.vetoAudit?.passed !== true) {
    reasons.push("veto audit is not clean");
  }
  if ((challenger.leakedFields ?? []).length > 0) {
    reasons.push(`leaked fields: ${challenger.leakedFields!.join(",")}`);
  }
  const challengerMetric = challenger.strongVsNegativeSeparation ?? null;
  const championMetric = championBaseline?.strongVsNegativeSeparation ?? null;
  const gain =
    challengerMetric !== null && championMetric !== null
      ? challengerMetric - championMetric
      : null;
  if (gain === null || !(gain > PROMOTION_GATE_EPSILON)) {
    reasons.push(
      `primary metric gain ${gain === null ? "unknown" : gain.toFixed(4)} not beyond epsilon ${PROMOTION_GATE_EPSILON}`,
    );
  }
  return {
    allowed: reasons.length === 0,
    reasons,
    metricSnapshot: { challengerMetric, championMetric, gain },
  };
}
