import { z } from "zod";

/** Shared ensemble decision: high-recall filter, never a bare boolean. */
export const ensembleDecisionSchema = z.enum([
  "reject",
  "research",
  "high_priority",
]);
export type EnsembleDecision = z.infer<typeof ensembleDecisionSchema>;

/** Graded relevance of the company to aerospace/defense work. */
export const relevanceLevelSchema = z.enum([
  "none",
  "weak",
  "moderate",
  "strong",
]);
export type RelevanceLevel = z.infer<typeof relevanceLevelSchema>;

/** Graded strength of observed manufacturing evidence. */
export const manufacturingEvidenceLevelSchema = z.enum([
  "none",
  "weak",
  "moderate",
  "strong",
]);
export type ManufacturingEvidenceLevel = z.infer<
  typeof manufacturingEvidenceLevelSchema
>;

/** Risk that the chosen decision drops a genuine supplier (false negative). */
export const falseNegativeRiskSchema = z.enum(["low", "medium", "high"]);
export type FalseNegativeRisk = z.infer<typeof falseNegativeRiskSchema>;

const evaluatorShape = {
  decision: ensembleDecisionSchema,
  confidence: z.number().int().min(0).max(100),
  company_type: z.string().min(1),
  aerospace_defense_relevance: relevanceLevelSchema,
  manufacturing_evidence: manufacturingEvidenceLevelSchema,
  thesis_signals: z.array(z.string()).default([]),
  disqualifiers: z.array(z.string()).default([]),
  missing_evidence: z.array(z.string()).default([]),
  false_negative_risk: falseNegativeRiskSchema,
  reason: z.string().min(1),
};

/** Single-model qualification judgment (prompt `faa_qualification_v1`). */
export const evaluatorResultSchema = z.object(evaluatorShape);
export type EvaluatorResult = z.infer<typeof evaluatorResultSchema>;

/** Adjudicator's final judgment (prompt `faa_adjudicator_v1`); spec shape. */
export const adjudicatorResultSchema = z.object({
  decision: ensembleDecisionSchema,
  confidence: z.number().int().min(0).max(100),
  disagreement_type: z.string().min(1),
  model_a_error: z.string().min(1),
  model_b_error: z.string().min(1),
  decisive_evidence: z.array(z.string()).default([]),
  missing_evidence: z.array(z.string()).default([]),
  false_negative_risk: falseNegativeRiskSchema,
  reason: z.string().min(1),
});
export type AdjudicatorResult = z.infer<typeof adjudicatorResultSchema>;

export type ParseSuccess<T> = { readonly ok: true; readonly data: T };
export type ParseFailure = { readonly ok: false; readonly error: string };
export type ParseOutcome<T> = ParseSuccess<T> | ParseFailure;

/**
 * Validate an evaluator payload. Returns failure instead of throwing, and
 * never coerces prose or malformed output into a decision (a reject must be
 * an explicit, schema-valid model judgment).
 */
export function parseEvaluatorResult(
  value: unknown,
): ParseOutcome<EvaluatorResult> {
  const parsed = evaluatorResultSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: parsed.error.message };
  return { ok: true, data: parsed.data };
}

/** Same failure-instead-of-throw contract for adjudicator payloads. */
export function parseAdjudicatorResult(
  value: unknown,
): ParseOutcome<AdjudicatorResult> {
  const parsed = adjudicatorResultSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: parsed.error.message };
  return { ok: true, data: parsed.data };
}
