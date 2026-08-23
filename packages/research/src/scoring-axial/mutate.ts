import {
  scoringProgramSchema,
  vetoRuleKey,
  type ProgramVetoClause,
  type ScoringProgram,
} from "./dsl.js";
import { mulberry32 } from "./evaluate.js";

/**
 * Deterministic challenger generation: no LLM, no randomness beyond the
 * integer seed. Every operator takes a program + seed and returns a
 * schema-valid ScoringProgram (weights re-normalized to sum 1 before parse).
 * Same inputs ⇒ identical challenger, forever.
 */

const JITTER_MAGNITUDE = 0.12;

/** Scale weights so they sum to exactly 1 (schema tolerance is ±0.01). */
function renormalize(program: ScoringProgram): ScoringProgram {
  const sum =
    program.components.reduce((acc, c) => acc + c.weight, 0) +
    program.interactions.reduce((acc, i) => acc + i.weight, 0);
  const scale = sum === 0 ? 1 : 1 / sum;
  return scoringProgramSchema.parse({
    ...program,
    components: program.components.map((c) => ({
      ...c,
      weight: c.weight * scale,
    })),
    interactions: program.interactions.map((i) => ({
      ...i,
      weight: i.weight * scale,
    })),
  });
}

/**
 * Nudge every component weight by ±JITTER_MAGNITUDE (seeded uniform), then
 * renormalize. Explores the weight simplex around the champion.
 */
export function jitterWeights(program: ScoringProgram, seed: number): ScoringProgram {
  const rng = mulberry32(seed);
  return renormalize({
    ...program,
    components: program.components.map((c) => ({
      ...c,
      weight: Math.max(
        0,
        c.weight + (rng() * 2 - 1) * JITTER_MAGNITUDE * c.weight + (rng() * 2 - 1) * 0.01,
      ),
    })),
  });
}

/**
 * Nudge the program's complexityPenalty (its main "threshold") up or down by
 * a seeded step, clamped to ≥0. Cheap, safe mutation for local search.
 */
export function moveThreshold(program: ScoringProgram, seed: number): ScoringProgram {
  const rng = mulberry32(seed);
  const delta = (rng() * 2 - 1) * 0.05;
  return scoringProgramSchema.parse({
    ...program,
    complexityPenalty: Math.max(0, program.complexityPenalty + delta),
  });
}

/**
 * Remove one seeded component and renormalize the survivors. Structural
 * simplification: the challenger must justify fewer moving parts with metric
 * gain (see decidePromotion).
 */
export function dropComponent(program: ScoringProgram, seed: number): ScoringProgram {
  if (program.components.length <= 1) return program;
  const rng = mulberry32(seed);
  const dropIdx = Math.floor(rng() * program.components.length);
  return renormalize({
    ...program,
    components: program.components.filter((_, i) => i !== dropIdx),
  });
}

/**
 * Add one seeded interaction between two component features that are not
 * already interacting, taking 10% of total weight (renormalized). Interactions
 * capture e.g. proprietary-evidence × build-to-print trade-offs that additive
 * weights cannot express.
 */
export function addInteraction(program: ScoringProgram, seed: number): ScoringProgram {
  const rng = mulberry32(seed);
  const existing = new Set(
    program.interactions.map((i) =>
      vetoRuleKey({
        feature: [...i.features].sort().join("+"),
        operator: "in",
      }),
    ),
  );
  const candidates: Array<[string, string]> = [];
  for (let i = 0; i < program.components.length; i += 1) {
    for (let j = i + 1; j < program.components.length; j += 1) {
      const a = program.components[i] as { feature: string };
      const b = program.components[j] as { feature: string };
      const key = vetoRuleKey({
        feature: [a.feature, b.feature].sort().join("+"),
        operator: "in",
      });
      if (!existing.has(key)) candidates.push([a.feature, b.feature]);
    }
  }
  if (candidates.length === 0) return program;
  const pick = candidates[Math.floor(rng() * candidates.length)] as [string, string];
  const interaction: { features: [string, string]; weight: number } = {
    features: pick,
    weight: 0.1,
  };
  return renormalize({
    ...program,
    interactions: [...program.interactions, interaction],
  });
}

/** Seeded operator dispatch — useful for exhaustive challenger sweeps. */
export const MUTATION_OPERATORS = {
  jitterWeights,
  moveThreshold,
  dropComponent,
  addInteraction,
} as const;

export type MutationOperator = keyof typeof MUTATION_OPERATORS;

export function mutate(
  program: ScoringProgram,
  operator: MutationOperator,
  seed: number,
): ScoringProgram {
  return MUTATION_OPERATORS[operator](program, seed);
}

export type { ProgramVetoClause };
