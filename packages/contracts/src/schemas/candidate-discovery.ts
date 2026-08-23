import { z } from "zod";
import { instantSchema, paginatedQuerySchema, uuidSchema } from "../schemas.js";

// ---------------------------------------------------------------------------
// Enum value arrays (shared with the Drizzle schema)
// ---------------------------------------------------------------------------

export const candidateStatusValues = [
  "queued_research",
  "in_research",
  "research_ready",
  "partner_review",
  "shortlist",
  "hold",
  "rejected",
  "watchlist",
  "archived",
] as const;
export const noveltyStatusValues = [
  "not_matched_to_current_known_universe",
  "possible_known_universe_match",
  "confirmed_known_company",
  "unable_to_assess",
] as const;
export const scoreAxisValues = ["fit", "novelty", "confidence", "actionability"] as const;
export const programAxisValues = [
  "fit",
  "actionability",
  "novelty",
  "confidence",
] as const;
export const programStatusValues = [
  "champion",
  "challenger",
  "rejected",
  "archived",
] as const;
export const experimentKindValues = [
  "scorer",
  "research_policy",
  "enrichment_benchmark",
  "blind_discovery",
  "entity_resolution",
  "evidence_quality",
  "efficiency",
] as const;
export const feedbackChannelValues = [
  "identity",
  "investment",
  "research_quality",
  "source",
] as const;
export const researchQuestionStatusValues = ["open", "answered", "stale"] as const;
export const campaignStatusValues = [
  "draft",
  "queued",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "budget_exhausted",
  "frontier_exhausted",
] as const;
export const frontierItemTypeValues = [
  "source",
  "query",
  "url",
  "document",
  "pdf",
  "spreadsheet",
  "company",
  "facility",
  "domain",
  "alias",
  "cage_code",
  "uei",
  "pma_holder",
  "part_number",
  "nsn",
  "niin",
  "qualification",
  "certification",
  "platform",
  "subsystem",
  "product_family",
  "lead",
  "research_question",
] as const;
export const frontierItemStatusValues = [
  "pending",
  "in_progress",
  "done",
  "failed",
  "skipped",
  "blocked",
] as const;

export const candidateStatusSchema = z.enum(candidateStatusValues);
export const noveltyStatusSchema = z.enum(noveltyStatusValues);
export const scoreAxisSchema = z.enum(scoreAxisValues);
export const programAxisSchema = z.enum(programAxisValues);
export const programStatusSchema = z.enum(programStatusValues);
export const experimentKindSchema = z.enum(experimentKindValues);
export const feedbackChannelSchema = z.enum(feedbackChannelValues);
export const researchQuestionStatusSchema = z.enum(researchQuestionStatusValues);
export const campaignStatusSchema = z.enum(campaignStatusValues);
export const frontierItemTypeSchema = z.enum(frontierItemTypeValues);
export const frontierItemStatusSchema = z.enum(frontierItemStatusValues);

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);
const axisScoreSchema = z.number().min(-1).max(101).nullable();
const displayName = z.string().trim().min(1).max(300);

const nonEmptyUpdate = (value: object): boolean =>
  Object.keys(value).length > 0;

/** At least one entity reference is required on feedback and questions. */
const hasEntityRef = (
  v: {
    companyId?: string | undefined;
    candidateId?: string | undefined;
    leadId?: string | undefined;
  },
): boolean =>
  v.companyId !== undefined ||
  v.candidateId !== undefined ||
  v.leadId !== undefined;

// ---------------------------------------------------------------------------
// Candidates and scores
// ---------------------------------------------------------------------------

export const rationaleSchema = z.strictObject({
  whyInteresting: z.array(z.string().trim().min(1).max(2_000)),
  risks: z.array(z.string().trim().min(1).max(2_000)),
  unknowns: z.array(z.string().trim().min(1).max(2_000)),
});

export const currentScoresSchema = z.record(
  z.string(),
  axisScoreSchema,
);

export const candidateDtoSchema = z.strictObject({
  id: uuidSchema,
  companyId: uuidSchema,
  status: candidateStatusSchema,
  noveltyStatus: noveltyStatusSchema,
  noveltySnapshotIds: z.array(uuidSchema),
  rationale: rationaleSchema,
  currentScores: currentScoresSchema,
  researchPriority: z.number().min(0).max(100).nullable(),
  partnerReviewPriority: z.number().min(0).max(100).nullable(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});

export const candidateListQuerySchema = paginatedQuerySchema.extend({
  status: candidateStatusSchema.optional(),
  noveltyStatus: noveltyStatusSchema.optional(),
  minFit: z.number().min(-1).max(101).optional(),
  maxFit: z.number().min(-1).max(101).optional(),
  minNovelty: z.number().min(-1).max(101).optional(),
  maxNovelty: z.number().min(-1).max(101).optional(),
  minConfidence: z.number().min(-1).max(101).optional(),
  maxConfidence: z.number().min(-1).max(101).optional(),
  minActionability: z.number().min(-1).max(101).optional(),
  maxActionability: z.number().min(-1).max(101).optional(),
});

export const scoreRecordDtoSchema = z.strictObject({
  id: uuidSchema,
  candidateId: uuidSchema,
  axis: scoreAxisSchema,
  value: axisScoreSchema.nullable(),
  scoringProgramId: uuidSchema.nullable(),
  featureSchemaVersion: z.string().trim().min(1).max(50),
  details: z.record(z.string(), z.unknown()),
  computedAt: instantSchema,
});

// ---------------------------------------------------------------------------
// Scoring programs
// ---------------------------------------------------------------------------

export const scoringProgramCreateSchema = z.strictObject({
  name: displayName,
  version: z.number().int().min(1),
  axis: programAxisSchema,
  program: z.record(z.string(), z.unknown()),
  complexity: z.number().min(0).max(999).optional(),
});

export const scoringProgramDtoSchema = z.strictObject({
  id: uuidSchema,
  ...scoringProgramCreateSchema.shape,
  status: programStatusSchema,
  createdBy: uuidSchema.nullable(),
  createdAt: instantSchema,
});

export const scoringProgramPromoteActionSchema = z.strictObject({
  status: z.enum(["champion", "rejected", "archived"]),
  note: z.string().trim().max(10_000).optional(),
});

// ---------------------------------------------------------------------------
// Experiment runs (append-only journal)
// ---------------------------------------------------------------------------

export const experimentRunCreateSchema = z.strictObject({
  kind: experimentKindSchema,
  label: z.string().trim().min(1).max(500),
  primaryMetricName: z.string().trim().min(1).max(200).optional(),
  primaryMetricValue: z.number().optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  keep: z.boolean().optional(),
  decision: z.string().trim().max(10_000).optional(),
  lineageParentId: uuidSchema.optional(),
  campaignId: uuidSchema.optional(),
});

export const experimentRunDtoSchema = z.strictObject({
  id: uuidSchema,
  ...experimentRunCreateSchema.shape,
  result: z.record(z.string(), z.unknown()),
  createdBy: uuidSchema.nullable(),
  createdAt: instantSchema,
});

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

const feedbackEntityRefs = {
  companyId: uuidSchema.optional(),
  candidateId: uuidSchema.optional(),
  leadId: uuidSchema.optional(),
} as const;

const investmentFeedbackActions = [
  "strong_fit",
  "possible_fit",
  "shortlist",
  "hold",
  "needs_more_research",
  "reject",
  "historical_ideal_unactionable",
] as const;
const identityFeedbackActions = [
  "same_company",
  "different_company",
  "duplicate",
  "alias",
  "subsidiary",
  "parent",
  "acquired_into",
  "already_in_pipeline",
  "already_known_outside_pipeline",
  "incorrect_match",
  "correct_match",
] as const;

export const investmentFeedbackCreateSchema = z.strictObject({
  channel: z.literal("investment"),
  action: z.enum(investmentFeedbackActions),
  ...feedbackEntityRefs,
  reason: z.string().trim().max(10_000).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  notes: z.string().trim().max(10_000).optional(),
});

export const identityFeedbackCreateSchema = z.strictObject({
  channel: z.literal("identity"),
  action: z.enum(identityFeedbackActions),
  ...feedbackEntityRefs,
  reason: z.string().trim().max(10_000).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  notes: z.string().trim().max(10_000).optional(),
});

export const openFeedbackCreateSchema = z.strictObject({
  channel: z.enum(["research_quality", "source"]),
  action: z.string().trim().min(1).max(200),
  ...feedbackEntityRefs,
  reason: z.string().trim().max(10_000).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  notes: z.string().trim().max(10_000).optional(),
});

export const feedbackCreateSchema = z
  .discriminatedUnion("channel", [
    identityFeedbackCreateSchema,
    investmentFeedbackCreateSchema,
    openFeedbackCreateSchema,
  ])
  .refine(hasEntityRef, {
    message: "At least one of companyId, candidateId, or leadId is required",
  });

export const feedbackDtoSchema = z.strictObject({
  id: uuidSchema,
  channel: feedbackChannelSchema,
  action: z.string().trim().min(1).max(200),
  companyId: uuidSchema.nullable(),
  candidateId: uuidSchema.nullable(),
  leadId: uuidSchema.nullable(),
  reason: z.string().max(10_000).nullable(),
  payload: z.record(z.string(), z.unknown()),
  notes: z.string().max(10_000).nullable(),
  actor: uuidSchema,
  createdAt: instantSchema,
});

// ---------------------------------------------------------------------------
// Research questions
// ---------------------------------------------------------------------------

export const researchQuestionCreateSchema = z
  .strictObject({
    candidateId: uuidSchema.optional(),
    companyId: uuidSchema.optional(),
    question: z.string().trim().min(1).max(2_000),
    priority: z.number().min(0).max(100).optional(),
  })
  .refine(hasEntityRef, {
    message: "Either candidateId or companyId is required",
  });

export const researchQuestionDtoSchema = z.strictObject({
  id: uuidSchema,
  candidateId: uuidSchema.nullable(),
  companyId: uuidSchema.nullable(),
  question: z.string().trim().min(1).max(2_000),
  status: researchQuestionStatusSchema,
  answer: z.record(z.string(), z.unknown()).nullable(),
  priority: z.number().min(0).max(100).nullable(),
  createdAt: instantSchema,
  closedAt: instantSchema.nullable(),
});

// ---------------------------------------------------------------------------
// Research campaigns
// ---------------------------------------------------------------------------

export const campaignSeedsSchema = z.strictObject({
  sources: z.array(z.string().trim().min(1).max(300)).default([]),
  platforms: z.array(z.string().trim().min(1).max(300)).default([]),
  capabilities: z.array(z.string().trim().min(1).max(300)).default([]),
  geography: z.array(z.string().trim().min(1).max(300)).default([]),
});

export const campaignCreateSchema = z.strictObject({
  name: displayName,
  objective: z.string().trim().max(10_000).optional(),
  thesisVersion: z.string().trim().max(100).optional(),
  policyVersion: z.string().trim().max(100).optional(),
  seeds: campaignSeedsSchema.optional(),
  excludedSources: z.array(z.string().trim().min(1).max(300)).optional(),
  budgetUsd: z.number().min(0).optional(),
  concurrency: z.number().int().min(1).max(16).optional(),
  maxDepth: z.number().int().min(0).max(16).optional(),
});

export const campaignUpdateSchema = campaignCreateSchema
  .omit({ name: true })
  .partial()
  .refine(nonEmptyUpdate, "At least one field must be supplied");

export const campaignDtoSchema = z.strictObject({
  id: uuidSchema,
  name: displayName,
  objective: z.string().max(10_000).nullable(),
  thesisVersion: z.string().max(100),
  policyVersion: z.string().max(100),
  seeds: campaignSeedsSchema,
  excludedSources: z.array(z.string()),
  budgetUsd: z.number().min(0).nullable(),
  spendUsd: z.number().min(0),
  concurrency: z.number().int().min(1).max(16),
  maxDepth: z.number().int().min(0),
  status: campaignStatusSchema,
  creator: uuidSchema.nullable(),
  startedAt: instantSchema.nullable(),
  pausedAt: instantSchema.nullable(),
  completedAt: instantSchema.nullable(),
  metrics: z.record(z.string(), z.unknown()),
  createdAt: instantSchema,
});

export const campaignLifecycleActionValues = [
  "start",
  "pause",
  "resume",
  "cancel",
] as const;
export const campaignLifecycleActionSchema = z.enum(
  campaignLifecycleActionValues,
);
export const campaignTransitionSchema = z.strictObject({
  action: campaignLifecycleActionSchema,
  note: z.string().trim().max(10_000).optional(),
});

// ---------------------------------------------------------------------------
// Frontier items
// ---------------------------------------------------------------------------

export const frontierItemDtoSchema = z.strictObject({
  id: uuidSchema,
  campaignId: uuidSchema,
  itemType: frontierItemTypeSchema,
  normalizedValue: z.string().trim().min(1).max(2_000),
  parentItemId: uuidSchema.nullable(),
  discoveryPath: z.string().max(10_000).nullable(),
  priority: z.number().nullable(),
  estimatedValue: z.number().nullable(),
  estimatedCostUsd: z.number().min(0),
  depth: z.number().int().min(0),
  status: frontierItemStatusSchema,
  attemptCount: z.number().int().min(0),
  lastAttemptAt: instantSchema.nullable(),
  nextAttemptAt: instantSchema.nullable(),
  idempotencyKey: z.string().trim().min(1).max(500).nullable(),
  normalizedUrl: z.string().max(2_000).nullable(),
  contentSha256: sha256Schema.nullable(),
  failureReason: z.string().max(10_000).nullable(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: instantSchema,
  completedAt: instantSchema.nullable(),
});

export const frontierItemListQuerySchema = paginatedQuerySchema.extend({
  campaignId: uuidSchema.optional(),
  itemType: frontierItemTypeSchema.optional(),
  status: frontierItemStatusSchema.optional(),
  parentItemId: uuidSchema.optional(),
  maxDepth: z.number().int().min(0).optional(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CandidateStatus = (typeof candidateStatusValues)[number];
export type NoveltyStatus = (typeof noveltyStatusValues)[number];
export type ScoreAxis = (typeof scoreAxisValues)[number];
export type ProgramAxis = (typeof programAxisValues)[number];
export type ProgramStatus = (typeof programStatusValues)[number];
export type ExperimentKind = (typeof experimentKindValues)[number];
export type FeedbackChannel = (typeof feedbackChannelValues)[number];
export type ResearchQuestionStatus =
  (typeof researchQuestionStatusValues)[number];
export type CampaignStatus = (typeof campaignStatusValues)[number];
export type FrontierItemType = (typeof frontierItemTypeValues)[number];
export type FrontierItemStatus = (typeof frontierItemStatusValues)[number];

export type Rationale = z.infer<typeof rationaleSchema>;
export type CurrentScores = z.infer<typeof currentScoresSchema>;
export type CandidateDto = z.infer<typeof candidateDtoSchema>;
export type CandidateListQuery = z.infer<typeof candidateListQuerySchema>;
export type ScoreRecordDto = z.infer<typeof scoreRecordDtoSchema>;
export type ScoringProgramCreate = z.infer<typeof scoringProgramCreateSchema>;
export type ScoringProgramDto = z.infer<typeof scoringProgramDtoSchema>;
export type ScoringProgramPromoteAction = z.infer<
  typeof scoringProgramPromoteActionSchema
>;
export type ExperimentRunCreate = z.infer<typeof experimentRunCreateSchema>;
export type ExperimentRunDto = z.infer<typeof experimentRunDtoSchema>;
export type InvestmentFeedbackCreate = z.infer<
  typeof investmentFeedbackCreateSchema
>;
export type IdentityFeedbackCreate = z.infer<
  typeof identityFeedbackCreateSchema
>;
export type OpenFeedbackCreate = z.infer<typeof openFeedbackCreateSchema>;
export type FeedbackCreate = z.infer<typeof feedbackCreateSchema>;
export type FeedbackDto = z.infer<typeof feedbackDtoSchema>;
export type ResearchQuestionCreate = z.infer<
  typeof researchQuestionCreateSchema
>;
export type ResearchQuestionDto = z.infer<typeof researchQuestionDtoSchema>;
export type CampaignSeeds = z.infer<typeof campaignSeedsSchema>;
export type CampaignCreate = z.infer<typeof campaignCreateSchema>;
export type CampaignUpdate = z.infer<typeof campaignUpdateSchema>;
export type CampaignDto = z.infer<typeof campaignDtoSchema>;
export type CampaignLifecycleAction =
  (typeof campaignLifecycleActionValues)[number];
export type CampaignTransition = z.infer<typeof campaignTransitionSchema>;
export type FrontierItemDto = z.infer<typeof frontierItemDtoSchema>;
export type FrontierItemListQuery = z.infer<
  typeof frontierItemListQuerySchema
>;
