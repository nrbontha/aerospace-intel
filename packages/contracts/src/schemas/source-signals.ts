import { z } from "zod";
import {
  confidenceSchema,
  instantSchema,
  paginatedQuerySchema,
  uuidSchema,
} from "../schemas.js";

// ---------------------------------------------------------------------------
// Source signals are raw external observations. They are never leads or
// targets until qualification has independently created a verified lead.
// ---------------------------------------------------------------------------

export const sourceSignalStatusValues = [
  "queued_qualification",
  "qualifying",
  "qualified",
  "rejected",
  "quarantined",
] as const;

export const ownershipRiskValues = [
  "none",
  "low",
  "medium",
  "high",
  "unknown",
] as const;

export const sourceSignalDecisionValues = [
  "qualified",
  "rejected",
  "quarantined",
] as const;

export const sourceSignalStatusSchema = z.enum(sourceSignalStatusValues);
export const ownershipRiskSchema = z.enum(ownershipRiskValues);
export const sourceSignalDecisionSchema = z.enum(sourceSignalDecisionValues);

const sourceKeySchema = z.string().trim().min(1).max(100);
const sourceLocatorSchema = z.string().trim().min(1).max(2_000);
const sourceFingerprintSchema = z.string().trim().min(1).max(500);
const optionalText = z.string().trim().min(1).max(300).nullable();
const jsonObjectSchema = z.record(z.string(), z.unknown());

export const sourceSignalDtoSchema = z.strictObject({
  id: uuidSchema,
  sourceKey: sourceKeySchema,
  sourceLocator: sourceLocatorSchema,
  sourceFingerprint: sourceFingerprintSchema,
  agentId: uuidSchema.nullable(),
  rawName: z.string().trim().min(1).max(500),
  rawDomain: z.string().trim().min(1).max(253).nullable(),
  uei: optionalText,
  cage: optionalText,
  city: optionalText,
  state: optionalText,
  country: optionalText,
  awardCount: z.number().int().min(0).nullable(),
  awardValue: z.number().min(0).nullable(),
  freshestAward: instantSchema.nullable(),
  sourcePayload: jsonObjectSchema,
  status: sourceSignalStatusSchema,
  qualification: jsonObjectSchema,
  leadId: uuidSchema.nullable(),
  companyId: uuidSchema.nullable(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
  qualifiedAt: instantSchema.nullable(),
  rejectedAt: instantSchema.nullable(),
});

export const sourceSignalListQuerySchema = paginatedQuerySchema.extend({
  status: sourceSignalStatusSchema.optional(),
  sourceKey: sourceKeySchema.optional(),
  city: z.string().trim().min(1).max(300).optional(),
  state: z.string().trim().min(1).max(300).optional(),
  minAwardValue: z.coerce.number().min(0).optional(),
  q: z.string().trim().min(1).max(200).optional(),
});

/** A qualifier's terminal decision; persist it in source_signals.qualification. */
export const sourceSignalQualificationDecisionSchema = z.strictObject({
  decision: sourceSignalDecisionSchema,
  reason: z.string().trim().min(1).max(10_000),
  evidenceUrls: z.array(z.url()).max(50),
  manufacturerEvidence: z.boolean(),
  aerospaceEvidence: z.boolean(),
  ownershipRisk: ownershipRiskSchema,
  confidence: confidenceSchema,
});

export type SourceSignalStatus = (typeof sourceSignalStatusValues)[number];
export type OwnershipRisk = (typeof ownershipRiskValues)[number];
export type SourceSignalDecision = (typeof sourceSignalDecisionValues)[number];
export type SourceSignalDto = z.infer<typeof sourceSignalDtoSchema>;
export type SourceSignalListQuery = z.infer<typeof sourceSignalListQuerySchema>;
export type SourceSignalQualificationDecision = z.infer<
  typeof sourceSignalQualificationDecisionSchema
>;
