import {
  entityReferenceSchema,
  instantSchema,
  researchTargetTypeSchema,
  uuidSchema,
} from "@asi/contracts";
import { z } from "zod";

export const researchJobNameValues = [
  "research.company.v1",
  "research.source.v1",
  "research.discover.v1",
  "research.platform.v1",
  "research.part.v1",
  "research.refresh.v1",
  "campaign-process.v1",
  "leads.ingest.v1",
  "candidate-research.v1",
] as const;

export const researchJobNameSchema = z.enum(researchJobNameValues);
export type ResearchJobName = z.infer<typeof researchJobNameSchema>;

const jobBaseShape = {
  researchRunId: uuidSchema,
  requestedByUserId: uuidSchema,
} as const;

export const companyResearchJobPayloadSchema = z.strictObject({
  ...jobBaseShape,
  name: z.literal("research.company.v1"),
  companyId: uuidSchema,
});

export const sourceResearchJobPayloadSchema = z.strictObject({
  ...jobBaseShape,
  name: z.literal("research.source.v1"),
  dataSourceId: uuidSchema,
});

export const discoverResearchJobPayloadSchema = z.strictObject({
  ...jobBaseShape,
  name: z.literal("research.discover.v1"),
  objective: z.string().trim().min(1).max(2_000),
  targetTypes: z.array(researchTargetTypeSchema).min(1).max(7),
  seedTerms: z.array(z.string().trim().min(1).max(300)).max(50).optional(),
});

export const platformResearchJobPayloadSchema = z.strictObject({
  ...jobBaseShape,
  name: z.literal("research.platform.v1"),
  platformId: uuidSchema,
});

export const partResearchJobPayloadSchema = z.strictObject({
  ...jobBaseShape,
  name: z.literal("research.part.v1"),
  partId: uuidSchema,
});

export const refreshResearchJobPayloadSchema = z.strictObject({
  ...jobBaseShape,
  name: z.literal("research.refresh.v1"),
  target: entityReferenceSchema,
  staleBefore: instantSchema.optional(),
});

export const campaignProcessJobPayloadSchema = z.strictObject({
  name: z.literal("campaign-process.v1"),
  campaignId: uuidSchema,
});

export const leadsIngestJobPayloadSchema = z.strictObject({
  name: z.literal("leads.ingest.v1"),
  campaignId: uuidSchema,
});

export const candidateResearchJobPayloadSchema = z.strictObject({
  name: z.literal("candidate-research.v1"),
  researchRunId: uuidSchema,
  companyId: uuidSchema,
  domain: z.string().trim().min(1).max(253),
});

export const researchJobPayloadSchema = z.discriminatedUnion("name", [
  companyResearchJobPayloadSchema,
  sourceResearchJobPayloadSchema,
  discoverResearchJobPayloadSchema,
  platformResearchJobPayloadSchema,
  partResearchJobPayloadSchema,
  refreshResearchJobPayloadSchema,
  campaignProcessJobPayloadSchema,
  leadsIngestJobPayloadSchema,
  candidateResearchJobPayloadSchema,
]);

export type CampaignProcessJobPayload = z.infer<
  typeof campaignProcessJobPayloadSchema
>;

export type CompanyResearchJobPayload = z.infer<
  typeof companyResearchJobPayloadSchema
>;
export type SourceResearchJobPayload = z.infer<
  typeof sourceResearchJobPayloadSchema
>;
export type DiscoverResearchJobPayload = z.infer<
  typeof discoverResearchJobPayloadSchema
>;
export type PlatformResearchJobPayload = z.infer<
  typeof platformResearchJobPayloadSchema
>;
export type PartResearchJobPayload = z.infer<
  typeof partResearchJobPayloadSchema
>;
export type RefreshResearchJobPayload = z.infer<
  typeof refreshResearchJobPayloadSchema
>;
export type ResearchJobPayload = z.infer<typeof researchJobPayloadSchema>;

export type LeadsIngestJobPayload = z.infer<typeof leadsIngestJobPayloadSchema>;

export type CandidateResearchJobPayload = z.infer<
  typeof candidateResearchJobPayloadSchema
>;

const jobIdentityShape = {
  name: researchJobNameSchema,
  researchRunId: uuidSchema,
} as const;

export const researchJobProgressEnvelopeSchema = z.strictObject({
  type: z.literal("progress"),
  job: z.strictObject(jobIdentityShape),
  progress: z
    .strictObject({
      phase: z.string().trim().min(1).max(100),
      completedUnits: z.number().int().min(0),
      totalUnits: z.number().int().min(1),
      message: z.string().trim().min(1).max(500).optional(),
      updatedAt: instantSchema,
    })
    .refine((value) => value.completedUnits <= value.totalUnits, {
      message: "completedUnits cannot exceed totalUnits",
      path: ["completedUnits"],
    }),
});

export const researchJobResultEnvelopeSchema = z.strictObject({
  type: z.literal("result"),
  job: z.strictObject(jobIdentityShape),
  result: z.strictObject({
    sourceDocumentIds: z.array(uuidSchema).max(10_000),
    observationIds: z.array(uuidSchema).max(10_000),
    proposalIds: z.array(uuidSchema).max(10_000),
    actualCostUsd: z.number().min(0).optional(),
    finishedAt: instantSchema,
  }),
});

export const researchJobErrorCodeValues = [
  "invalid_payload",
  "not_found",
  "permission_denied",
  "tool_timeout",
  "tool_failed",
  "model_failed",
  "budget_exhausted",
  "cancelled",
  "internal_error",
] as const;

export const researchJobErrorEnvelopeSchema = z.strictObject({
  type: z.literal("error"),
  job: z.strictObject(jobIdentityShape),
  error: z.strictObject({
    code: z.enum(researchJobErrorCodeValues),
    message: z.string().trim().min(1).max(1_000),
    retryable: z.boolean(),
    attempt: z.number().int().min(1).max(10),
    details: z.json().optional(),
    failedAt: instantSchema,
  }),
});

export const researchJobEnvelopeSchema = z.discriminatedUnion("type", [
  researchJobProgressEnvelopeSchema,
  researchJobResultEnvelopeSchema,
  researchJobErrorEnvelopeSchema,
]);

export type ResearchJobProgressEnvelope = z.infer<
  typeof researchJobProgressEnvelopeSchema
>;
export type ResearchJobResultEnvelope = z.infer<
  typeof researchJobResultEnvelopeSchema
>;
export type ResearchJobErrorEnvelope = z.infer<
  typeof researchJobErrorEnvelopeSchema
>;
export type ResearchJobEnvelope = z.infer<typeof researchJobEnvelopeSchema>;
