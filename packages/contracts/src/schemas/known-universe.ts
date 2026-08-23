import { z } from "zod";
import {
  dateSchema,
  instantSchema,
  paginatedQuerySchema,
  uuidSchema,
} from "../schemas.js";

export const snapshotSourceTypeValues = [
  "golden_set_workbook",
  "grata_enrichment",
  "preliminary_pipeline",
  "manual",
  "external_export",
] as const;
export const snapshotMemberMatchStatusValues = [
  "exact",
  "probable",
  "possible",
  "none",
  "unresolved",
] as const;
export const goldenExampleTypeValues = [
  "strong_positive",
  "positive_with_caveat",
  "borderline",
  "negative_business_model",
  "ideal_archetype_but_unactionable",
  "known_non_target",
  "unclassified",
] as const;
export const labelScaleValues = [
  "strong_positive",
  "positive",
  "neutral",
  "negative",
  "unknown",
] as const;
export const buildToPrintRiskValues = [
  "none",
  "low",
  "medium",
  "high",
  "unknown",
] as const;
export const leadStatusValues = [
  "new",
  "resolving",
  "resolved",
  "unresolved_lead",
  "discarded",
] as const;
export const matchDecisionValues = [
  "pending",
  "merged",
  "rejected_merge",
  "alias",
  "parent_subsidiary",
  "acquired_into",
] as const;
export const reviewStatusValues = [
  "unclassified",
  "proposed",
  "reviewed",
] as const;

export const snapshotSourceTypeSchema = z.enum(snapshotSourceTypeValues);
export const snapshotMemberMatchStatusSchema = z.enum(
  snapshotMemberMatchStatusValues,
);
export const goldenExampleTypeSchema = z.enum(goldenExampleTypeValues);
export const labelScaleSchema = z.enum(labelScaleValues);
export const buildToPrintRiskSchema = z.enum(buildToPrintRiskValues);
export const leadStatusSchema = z.enum(leadStatusValues);
export const matchDecisionSchema = z.enum(matchDecisionValues);
export const reviewStatusSchema = z.enum(reviewStatusValues);

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);
const confidence03Schema = z.number().min(0).max(1);
const snapshotKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/, "Lowercase key with dots, dashes, colons, or digits");
const displayName = z.string().trim().min(1).max(300);

const nonEmptyUpdate = (value: object): boolean =>
  Object.keys(value).length > 0;

// ---------------------------------------------------------------------------
// Known-universe snapshots and members
// ---------------------------------------------------------------------------

export const knownUniverseSnapshotCreateSchema = z.strictObject({
  key: snapshotKeySchema,
  name: displayName,
  sourceType: snapshotSourceTypeSchema,
  importFileName: z.string().trim().min(1).max(500).optional(),
  contentSha256: sha256Schema.optional(),
  effectiveDate: dateSchema.optional(),
  notes: z.string().trim().max(10_000).optional(),
  rowCount: z.number().int().min(0).optional(),
});

export const knownUniverseSnapshotSchema = z.strictObject({
  id: uuidSchema,
  ...knownUniverseSnapshotCreateSchema.shape,
  rowCount: z.number().int().min(0),
  active: z.boolean(),
  createdBy: uuidSchema.nullable(),
  createdAt: instantSchema,
});

export const knownUniverseSnapshotUpdateSchema =
  knownUniverseSnapshotCreateSchema
    .omit({ key: true, sourceType: true })
    .partial()
    .refine(nonEmptyUpdate, "At least one field must be supplied");

export const knownUniverseSnapshotListQuerySchema = paginatedQuerySchema.extend({
  sourceType: snapshotSourceTypeSchema.optional(),
  active: z.boolean().optional(),
  query: z.string().trim().max(200).optional(),
});

export const knownUniverseMemberSchema = z.strictObject({
  id: uuidSchema,
  snapshotId: uuidSchema,
  companyId: uuidSchema.nullable(),
  matchedCompanyId: uuidSchema.nullable(),
  rawName: z.string().trim().min(1).max(1_000),
  rawDomain: z.string().trim().max(500).nullable(),
  normalizedDomain: z.string().trim().max(500).nullable(),
  normalizedName: z.string().trim().max(500).nullable(),
  matchStatus: snapshotMemberMatchStatusSchema,
  matchConfidence: confidence03Schema.nullable(),
  rawPayload: z.record(z.string(), z.unknown()),
  sourceRow: z.number().int().positive().nullable(),
  createdAt: instantSchema,
});

export const knownUniverseMemberListQuerySchema = paginatedQuerySchema.extend({
  snapshotId: uuidSchema.optional(),
  matchStatus: snapshotMemberMatchStatusSchema.optional(),
  query: z.string().trim().max(200).optional(),
});

// ---------------------------------------------------------------------------
// Golden examples
// ---------------------------------------------------------------------------

export const proposedLabelsSchema = z.strictObject({
  archetypeFit: labelScaleSchema.optional(),
  currentActionability: labelScaleSchema.optional(),
  businessModelFit: labelScaleSchema.optional(),
  ownershipFit: labelScaleSchema.optional(),
  goldenExampleType: goldenExampleTypeSchema.optional(),
  buildToPrintRisk: buildToPrintRiskSchema.optional(),
  rationale: z.string().trim().max(10_000).optional(),
});

export const reviewedLabelsSchema = z.strictObject({
  archetypeFit: labelScaleSchema.optional(),
  currentActionability: labelScaleSchema.optional(),
  businessModelFit: labelScaleSchema.optional(),
  ownershipFit: labelScaleSchema.optional(),
  goldenExampleType: goldenExampleTypeSchema.optional(),
  buildToPrintRisk: buildToPrintRiskSchema.optional(),
});

/** Reviewer decision payload: labels plus a mandatory rationale. */
export const goldenExampleReviewSchema = reviewedLabelsSchema.extend({
  rationale: z.string().trim().min(1).max(10_000),
  reviewNotes: z.string().trim().max(10_000).optional(),
});

export const goldenExampleSchema = z.strictObject({
  id: uuidSchema,
  companyId: uuidSchema.nullable(),
  snapshotId: uuidSchema.nullable(),
  name: displayName,
  domain: z.string().trim().max(500).nullable(),
  descriptionRaw: z.string().max(10_000).nullable(),
  grataPayload: z.record(z.string(), z.unknown()),
  workbookRow: z.number().int().positive().nullable(),
  proposedLabels: proposedLabelsSchema,
  archetypeFit: labelScaleSchema.nullable(),
  currentActionability: labelScaleSchema.nullable(),
  businessModelFit: labelScaleSchema.nullable(),
  ownershipFit: labelScaleSchema.nullable(),
  goldenExampleType: goldenExampleTypeSchema.nullable(),
  buildToPrintRisk: buildToPrintRiskSchema.nullable(),
  reviewNotes: z.string().max(10_000).nullable(),
  reviewStatus: reviewStatusSchema,
  reviewedBy: uuidSchema.nullable(),
  reviewedAt: instantSchema.nullable(),
  createdAt: instantSchema,
});

export const goldenExampleListQuerySchema = paginatedQuerySchema.extend({
  snapshotId: uuidSchema.optional(),
  reviewStatus: reviewStatusSchema.optional(),
  goldenExampleType: goldenExampleTypeSchema.optional(),
  query: z.string().trim().max(200).optional(),
});

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

export const leadCreateSchema = z.strictObject({
  researchRunId: uuidSchema.optional(),
  campaignId: uuidSchema.optional(),
  sourceDocumentId: uuidSchema.optional(),
  rawName: z.string().trim().min(1).max(1_000),
  context: z.record(z.string(), z.unknown()).optional(),
  url: z.url().max(2_000).optional(),
  possibleDomain: z.string().trim().max(500).optional(),
  possibleLocation: z.string().trim().max(500).optional(),
  possibleIdentifiers: z.array(z.record(z.string(), z.unknown())).optional(),
  possibleProducts: z.array(z.string().trim().min(1).max(300)).optional(),
  extractionMethod: z.string().trim().max(200).optional(),
  extractionConfidence: confidence03Schema.optional(),
});

export const leadSchema = z.strictObject({
  id: uuidSchema,
  ...leadCreateSchema.shape,
  status: leadStatusSchema,
  resolvedCompanyId: uuidSchema.nullable(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});

export const leadUpdateSchema = leadCreateSchema.partial();

export const leadResolveDecisionSchema = z.strictObject({
  resolvedCompanyId: uuidSchema,
  note: z.string().trim().max(10_000).optional(),
});

export const leadListQuerySchema = paginatedQuerySchema.extend({
  status: leadStatusSchema.optional(),
  researchRunId: uuidSchema.optional(),
  resolvedCompanyId: uuidSchema.optional(),
  query: z.string().trim().max(200).optional(),
});

// ---------------------------------------------------------------------------
// Identity match candidates
// ---------------------------------------------------------------------------

export const identityMatchCandidateSchema = z.strictObject({
  id: uuidSchema,
  leadId: uuidSchema,
  companyId: uuidSchema,
  signalType: z.string().trim().min(1).max(100),
  features: z.record(z.string(), z.unknown()),
  confidence: confidence03Schema,
  explanation: z.string().max(10_000).nullable(),
  decision: matchDecisionSchema,
  decidedBy: uuidSchema.nullable(),
  decidedAt: instantSchema.nullable(),
  createdAt: instantSchema,
});

export const identityMatchCandidateDecisionSchema = z.strictObject({
  decision: z.enum(["merged", "rejected_merge", "alias", "parent_subsidiary", "acquired_into"]),
  note: z.string().trim().max(10_000).optional(),
});

export type SnapshotSourceType = (typeof snapshotSourceTypeValues)[number];
export type SnapshotMemberMatchStatus = z.infer<typeof snapshotMemberMatchStatusSchema>;
export type GoldenExampleType = z.infer<typeof goldenExampleTypeSchema>;
export type LabelScale = z.infer<typeof labelScaleSchema>;
export type BuildToPrintRisk = z.infer<typeof buildToPrintRiskSchema>;
export type LeadStatus = z.infer<typeof leadStatusSchema>;
export type MatchDecision = z.infer<typeof matchDecisionSchema>;
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;
export type KnownUniverseSnapshotCreate = z.infer<
  typeof knownUniverseSnapshotCreateSchema
>;
export type KnownUniverseSnapshot = z.infer<typeof knownUniverseSnapshotSchema>;
export type KnownUniverseSnapshotUpdate = z.infer<
  typeof knownUniverseSnapshotUpdateSchema
>;
export type KnownUniverseSnapshotListQuery = z.infer<
  typeof knownUniverseSnapshotListQuerySchema
>;
export type KnownUniverseMember = z.infer<typeof knownUniverseMemberSchema>;
export type KnownUniverseMemberListQuery = z.infer<
  typeof knownUniverseMemberListQuerySchema
>;
export type ProposedLabels = z.infer<typeof proposedLabelsSchema>;
export type ReviewedLabels = z.infer<typeof reviewedLabelsSchema>;
export type GoldenExampleReview = z.infer<typeof goldenExampleReviewSchema>;
export type GoldenExample = z.infer<typeof goldenExampleSchema>;
export type GoldenExampleListQuery = z.infer<typeof goldenExampleListQuerySchema>;
export type LeadCreate = z.infer<typeof leadCreateSchema>;
export type Lead = z.infer<typeof leadSchema>;
export type LeadUpdate = z.infer<typeof leadUpdateSchema>;
export type LeadResolveDecision = z.infer<typeof leadResolveDecisionSchema>;
export type LeadListQuery = z.infer<typeof leadListQuerySchema>;
export type IdentityMatchCandidate = z.infer<typeof identityMatchCandidateSchema>;
export type IdentityMatchCandidateDecision = z.infer<
  typeof identityMatchCandidateDecisionSchema
>;
