import { z } from "zod";

import type { ProgramAxis } from "@asi/contracts";
import {
  DEFAULT_ACTIONABILITY_PROGRAM,
  DEFAULT_FIT_PROGRAM,
  GOLDEN_DATASET_V1,
  complexityScore,
  runEvaluation,
  scoringProgramSchema,
  type EvaluationRun,
  type PrimaryMetricKey,
  type ScoringProgram,
} from "@asi/research/scoring-axial";

import {
  getChampionProgram,
  upsertProgram,
  type Database,
} from "@asi/database";

/**
 * Server-side scorer evaluation over the frozen v1 golden fixtures.
 * Pure compute + persistence wiring shared by the run-scorer route.
 */

export const runScorerRequestSchema = z.strictObject({
  label: z.string().trim().min(1).max(500),
  /** Challenger programs to evaluate (and register) alongside champions. */
  programs: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1).max(200),
        program: z.record(z.string(), z.unknown()),
      }),
    )
    .max(10)
    .default([]),
  /** Champion axes to include as baselines. Defaults to both fit+actionability. */
  axes: z.array(z.enum(["fit", "actionability"])).min(1).max(2).optional(),
  primaryMetric: z
    .enum(["strongVsNegativeSeparation", "separationMinusComplexityPenalty"])
    .default("strongVsNegativeSeparation"),
});

export type RunScorerRequest = z.infer<typeof runScorerRequestSchema>;

export interface RunScorerEntry {
  readonly programId: string | null;
  readonly name: string;
  readonly role: "champion" | "challenger";
  readonly axis: ProgramAxis;
  readonly metrics: unknown;
}

export interface RunScorerOutcome {
  readonly primaryMetricName: PrimaryMetricKey;
  readonly primaryMetricValue: number | null;
  readonly result: Record<string, unknown>;
  readonly summary: EvaluationRun;
}

/** Replace NaN/Infinity with null so jsonb accepts every value. */
function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function sanitize(value: unknown): unknown {
  if (typeof value === "number") return finiteOrNull(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        sanitize(child),
      ]),
    );
  }
  return value;
}

/**
 * Evaluate challenger programs against the frozen golden set next to the
 * current per-axis champions. Challenger rows are registered (versioned)
 * so a later keep-decision can promote them by id.
 */
export async function runGoldenSetEvaluation(
  db: Database,
  request: RunScorerRequest,
  actorUserId: string | null,
): Promise<RunScorerOutcome> {
  const axes =
    request.axes ??
    (request.programs.length === 0
      ? (["fit", "actionability"] as ProgramAxis[])
      : ([...new Set(request.programs.map((entry) => entry.program.axis))] as ProgramAxis[]));

  const evaluationSet: Array<{ name: string; program: ScoringProgram }> = [];
  const entries: Array<{
    programId: string | null;
    name: string;
    role: "champion" | "challenger";
    axis: ProgramAxis;
  }> = [];
  // Champions first (baselines), never re-registered. Axes without a stored
  // champion and without a shipped default are skipped.
  for (const axis of axes) {
    const champion = await getChampionProgram(db, axis);
    const fallback =
      axis === "fit"
        ? DEFAULT_FIT_PROGRAM
        : axis === "actionability"
          ? DEFAULT_ACTIONABILITY_PROGRAM
          : null;
    if (champion === null && fallback === null) continue;
    const program =
      champion === null || champion.program === undefined
        ? fallback!
        : ({ ...champion.program, name: champion.name } as unknown as ScoringProgram);
    const name = champion?.name ?? `default-${axis}`;
    evaluationSet.push({ name, program });
    entries.push({
      programId: champion?.id ?? null,
      name,
      role: "champion",
      axis,
    });
  }

  // Challengers: validated, then persisted for later promotion decisions.
  for (const candidate of request.programs) {
    const parsed = scoringProgramSchema.parse(candidate.program) as ScoringProgram;
    const registered = await upsertProgram(
      db,
      {
        name: candidate.name,
        version: 1,
        axis: parsed.axis,
        program: parsed as unknown as Record<string, unknown>,
        complexity: complexityScore(parsed),
      },
      actorUserId,
    );
    const name = `${candidate.name} v${registered.version}`;
    evaluationSet.push({ name, program: parsed });
    entries.push({
      programId: registered.id,
      name,
      role: "challenger",
      axis: registered.axis,
    });
  }

  const run = runEvaluation(evaluationSet, GOLDEN_DATASET_V1, {
    primaryMetric: request.primaryMetric,
  });

  const metricsByName = new Map(
    run.results.map((result) => [result.name, result]),
  );

  const serializedEntries = entries.map((entry) => {
    const metrics = metricsByName.get(entry.name);
    return {
      ...entry,
      rank: metrics?.rank ?? null,
      strongVsNegativeSeparation: metrics?.strongVsNegativeSeparation ?? null,
      bootstrap: metrics?.bootstrap ?? null,
      loocv: metrics?.loocv ?? null,
      complexity: metrics?.complexity ?? null,
      holdoutSeparation: metrics?.holdoutSeparation ?? null,
      vetoAudit: metrics?.vetoAudit ?? null,
      leakedFields: metrics?.leakedFields ?? [],
    };
  });

  const rankedChallengers = serializedEntries
    .filter((entry) => entry.role === "challenger" && entry.rank !== null)
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  const leader =
    rankedChallengers[0] ??
    [...serializedEntries].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))[0];

  const result = sanitize({
    dataset: run.datasetName,
    primaryMetric: run.primaryMetric,
    entries: serializedEntries,
    ranking: run.results.map((r) => ({ rank: r.rank, name: r.name })),
  }) as Record<string, unknown>;

  return {
    primaryMetricName: run.primaryMetric,
    primaryMetricValue:
      leader === undefined
        ? null
        : finiteOrNull(Number(leader.strongVsNegativeSeparation)),
    result,
    summary: run,
  };
}

export interface KeepPromotionEntry {
  readonly programId?: string | null;
  readonly role?: string;
  readonly axis?: string;
  readonly rank?: number | null;
}

export type KeepPromotionSelection =
  | { readonly ok: true; readonly programId: string; readonly axis: ProgramAxis }
  | { readonly ok: false; readonly reason: string };

/**
 * Which challenger a keep-decision may promote.
 *
 * ONLY programs evaluated by THIS run are eligible (they must appear as
 * challenger entries in the stored result), and keep applies solely to the
 * top-ranked challenger of the run's single evaluated axis — every other
 * axis' challenger requires its own run and decision. Runs that mixed axes,
 * or legacy runs without per-entry axis attribution, promote nothing
 * (fail closed).
 */
export function selectKeepPromotion(
  entries: readonly KeepPromotionEntry[],
): KeepPromotionSelection {
  const challengers = entries.filter(
    (entry) => entry.role === "challenger" && entry.programId != null,
  );
  if (challengers.length === 0) {
    return { ok: false, reason: "run evaluated no registered challengers" };
  }
  const axes = new Set(
    challengers.map((entry) => entry.axis).filter((axis): axis is string => axis != null),
  );
  if (axes.size !== 1) {
    return {
      ok: false,
      reason:
        axes.size === 0
          ? "run entries lack axis attribution (legacy run); promote explicitly instead"
          : `run mixed ${axes.size} axes; each axis requires its own decision`,
    };
  }
  const axis = [...axes][0]! as ProgramAxis;
  const ranked = challengers
    .filter((entry) => entry.axis === axis && entry.rank != null)
    .sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER));
  const winner = ranked[0];
  if (winner === undefined || winner.programId == null) {
    return { ok: false, reason: `no ranked ${axis} challenger in this run` };
  }
  return { ok: true, programId: winner.programId, axis };
}

