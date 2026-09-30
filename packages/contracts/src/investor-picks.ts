import { z } from "zod";

import { instantSchema, uuidSchema } from "./schemas.js";

export const investorReferenceSetValues = ["golden"] as const;
export const investorPickOriginKindValues = [
  "manual",
  "golden",
  "booie",
] as const;
export const investorPickReadinessValues = [
  "ready",
  "needs_research",
  "blocked",
  "unknown",
] as const;

export const investorReferenceSetSchema = z.enum(investorReferenceSetValues);
export const investorPickOriginKindSchema = z.enum(investorPickOriginKindValues);
export const investorPickReadinessSchema = z.enum(investorPickReadinessValues);

const pickNoteSchema = z.string().trim().max(4_000);
const pickNameSchema = z.string().trim().min(1).max(500);
const candidateDomainSchema = z.string().trim().min(1).max(253);

export const investorPickOriginDtoSchema = z.strictObject({
  kind: investorPickOriginKindSchema,
  label: z.string(),
  snapshotId: uuidSchema.nullable(),
  snapshotKey: z.string().nullable(),
  memberId: uuidSchema.nullable(),
  sourceRow: z.number().int().min(0).nullable(),
});

export const investorPickDtoSchema = z.strictObject({
  id: uuidSchema,
  sourceSignalId: uuidSchema,
  name: z.string(),
  domain: z.string().nullable(),
  verifiedDomain: z.string().nullable(),
  identityVerified: z.boolean(),
  note: z.string().nullable(),
  active: z.boolean(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
  origins: z.array(investorPickOriginDtoSchema).readonly(),
  researchScore: z.number().nullable(),
  readiness: investorPickReadinessSchema,
  jevCurrent: z.boolean(),
  museStatus: z.string().nullable(),
});

export const investorReferenceSetDtoSchema = z.strictObject({
  key: investorReferenceSetSchema,
  label: z.string(),
  snapshotKeys: z.array(z.string()).min(1).readonly(),
  available: z.boolean(),
  memberCount: z.number().int().min(0),
  importedMemberCount: z.number().int().min(0),
});

export const investorPicksPageDtoSchema = z.strictObject({
  items: z.array(investorPickDtoSchema).readonly(),
  total: z.number().int().min(0),
  canManage: z.boolean(),
  referenceSets: z.array(investorReferenceSetDtoSchema).readonly(),
});

export const investorPickCreateInputSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("existing"),
    sourceSignalId: uuidSchema,
    note: pickNoteSchema.optional(),
  }),
  z.strictObject({
    mode: z.literal("manual"),
    name: pickNameSchema,
    domain: candidateDomainSchema.optional(),
    note: pickNoteSchema.optional(),
  }),
]);

export const investorPickUpdateInputSchema = z
  .strictObject({
    active: z.boolean().optional(),
    note: pickNoteSchema.optional(),
  })
  .refine(
    (input) => input.active !== undefined || input.note !== undefined,
    "At least one field must be supplied",
  );

export const investorReferenceImportInputSchema = z.strictObject({
  set: investorReferenceSetSchema,
});

export const investorReferenceImportResultDtoSchema = z.strictObject({
  set: investorReferenceSetSchema,
  memberCount: z.number().int().min(0),
  createdPicks: z.number().int().min(0),
  createdSignals: z.number().int().min(0),
  alreadyImported: z.number().int().min(0),
  inactivePreserved: z.number().int().min(0),
});

export type InvestorReferenceSet = z.infer<typeof investorReferenceSetSchema>;
export type InvestorPickOriginDto = z.infer<typeof investorPickOriginDtoSchema>;
export type InvestorPickDto = z.infer<typeof investorPickDtoSchema>;
export type InvestorReferenceSetDto = z.infer<
  typeof investorReferenceSetDtoSchema
>;
export type InvestorPicksPageDto = z.infer<typeof investorPicksPageDtoSchema>;
export type InvestorPickCreateInput = z.infer<
  typeof investorPickCreateInputSchema
>;
export type InvestorPickUpdateInput = z.infer<
  typeof investorPickUpdateInputSchema
>;
export type InvestorReferenceImportInput = z.infer<
  typeof investorReferenceImportInputSchema
>;
export type InvestorReferenceImportResultDto = z.infer<
  typeof investorReferenceImportResultDtoSchema
>;
