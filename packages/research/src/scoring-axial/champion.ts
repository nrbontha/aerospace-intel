import { and, desc, eq } from "drizzle-orm";

import { scoringPrograms, type Database } from "@asi/database";

import {
  DEFAULT_ACTIONABILITY_PROGRAM,
  DEFAULT_FIT_PROGRAM,
  scoringProgramSchema,
  type ScoringProgram,
} from "./dsl.js";

/**
 * Champion resolution for the PRODUCTION scoring paths.
 *
 * Scoring must always evaluate the current per-axis champion persisted in
 * scoring_programs (what the Lab promotes) and only fall back to the shipped
 * default program when no champion exists. Hardcoding DEFAULT_*_PROGRAM in
 * production paths silently ignores every promotion decision.
 */

export interface ResolvedChampionProgram {
  /** The parsed, validated scoring program to evaluate. */
  readonly program: ScoringProgram;
  /**
   * scoring_programs.id of the resolved champion row; null when the shipped
   * default fallback was used (no champion registered on this axis).
   */
  readonly scoringProgramId: string | null;
}

function fallbackProgram(axis: "fit" | "actionability"): ScoringProgram {
  return axis === "fit" ? DEFAULT_FIT_PROGRAM : DEFAULT_ACTIONABILITY_PROGRAM;
}

/**
 * Resolve the current champion scoring program for one axis. Returns the
 * stored champion (program JSON re-validated via scoringProgramSchema) or
 * the shipped default when no champion exists on the axis.
 */
export async function getChampionProgramOrFallback(
  db: Database,
  axis: "fit" | "actionability",
): Promise<ResolvedChampionProgram> {
  const [row] = await db
    .select({
      id: scoringPrograms.id,
      name: scoringPrograms.name,
      program: scoringPrograms.program,
    })
    .from(scoringPrograms)
    .where(and(eq(scoringPrograms.axis, axis), eq(scoringPrograms.status, "champion")))
    .orderBy(desc(scoringPrograms.version))
    .limit(1);
  if (row === undefined) {
    return { program: fallbackProgram(axis), scoringProgramId: null };
  }
  const program = scoringProgramSchema.parse({
    ...(row.program as Record<string, unknown>),
    name: row.name,
  }) as ScoringProgram;
  return { program, scoringProgramId: row.id };
}
