import { z } from "zod";

export const apiVersion = "v1" as const;
export const apiVersionSchema = z.literal(apiVersion);

export const roleValues = ["admin", "analyst", "viewer"] as const;
export const sourceAccessValues = [
  "public",
  "authorized",
  "restricted_metadata_only",
] as const;
export const sourceIngestionValues = [
  "manual",
  "upload",
  "web_fetch",
  "api",
  "import",
] as const;
export const companyStatusValues = [
  "active",
  "inactive",
  "acquired",
  "defunct",
  "unknown",
] as const;
export const recordStatusValues = ["draft", "active", "archived"] as const;
export const ownershipTypeValues = [
  "private",
  "public",
  "subsidiary",
  "government",
  "joint_venture",
  "cooperative",
  "unknown",
] as const;
export const identifierTypeValues = [
  "cage",
  "duns",
  "uei",
  "lei",
  "naics",
  "sic",
  "ticker",
  "internal",
] as const;
export const contactVerificationStatusValues = [
  "unverified",
  "source_verified",
  "directly_verified",
  "stale",
  "invalid",
] as const;
export const qualificationScarcityValues = [
  "confirmed_sole_source",
  "confirmed_constrained_source",
  "likely_dominant_source",
  "unverified_company_claim",
  "multiple_qualified_sources",
  "not_assessed",
] as const;
export const observationReviewStatusValues = [
  "pending",
  "accepted",
  "rejected",
  "superseded",
] as const;
export const observationConflictStatusValues = [
  "none",
  "potential",
  "confirmed",
  "resolved",
] as const;
export const researchTargetTypeValues = [
  "company",
  "facility",
  "contact",
  "platform",
  "part",
  "qualification",
  "data_source",
] as const;
export const researchRunStatusValues = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export const proposalStatusValues = [
  "pending",
  "accepted",
  "rejected",
  "superseded",
] as const;
export const importStatusValues = [
  "queued",
  "validating",
  "ready",
  "processing",
  "completed",
  "failed",
  "cancelled",
] as const;
export const evidenceExtractionStatusValues = [
  "pending",
  "processing",
  "completed",
  "failed",
] as const;

export const roleSchema = z.enum(roleValues);
export const sourceAccessSchema = z.enum(sourceAccessValues);
export const sourceIngestionSchema = z.enum(sourceIngestionValues);
export const companyStatusSchema = z.enum(companyStatusValues);
export const recordStatusSchema = z.enum(recordStatusValues);
export const ownershipTypeSchema = z.enum(ownershipTypeValues);
export const identifierTypeSchema = z.enum(identifierTypeValues);
export const contactVerificationStatusSchema = z.enum(
  contactVerificationStatusValues,
);
export const qualificationScarcitySchema = z.enum(qualificationScarcityValues);
export const observationReviewStatusSchema = z.enum(
  observationReviewStatusValues,
);
export const observationConflictStatusSchema = z.enum(
  observationConflictStatusValues,
);
export const researchTargetTypeSchema = z.enum(researchTargetTypeValues);
export const researchRunStatusSchema = z.enum(researchRunStatusValues);
export const proposalStatusSchema = z.enum(proposalStatusValues);
export const importStatusSchema = z.enum(importStatusValues);
export const evidenceExtractionStatusSchema = z.enum(
  evidenceExtractionStatusValues,
);

export type Role = z.infer<typeof roleSchema>;
export type SourceAccess = z.infer<typeof sourceAccessSchema>;
export type SourceIngestion = z.infer<typeof sourceIngestionSchema>;
export type CompanyStatus = z.infer<typeof companyStatusSchema>;
export type RecordStatus = z.infer<typeof recordStatusSchema>;
export type OwnershipType = z.infer<typeof ownershipTypeSchema>;
export type IdentifierType = z.infer<typeof identifierTypeSchema>;
export type ContactVerificationStatus = z.infer<
  typeof contactVerificationStatusSchema
>;
export type QualificationScarcity = z.infer<typeof qualificationScarcitySchema>;
export type ObservationReviewStatus = z.infer<
  typeof observationReviewStatusSchema
>;
export type ObservationConflictStatus = z.infer<
  typeof observationConflictStatusSchema
>;
export type ResearchTargetType = z.infer<typeof researchTargetTypeSchema>;
export type ResearchRunStatus = z.infer<typeof researchRunStatusSchema>;
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;
export type ImportStatus = z.infer<typeof importStatusSchema>;
export type EvidenceExtractionStatus = z.infer<
  typeof evidenceExtractionStatusSchema
>;

export const uuidSchema = z.uuid();
export const dateSchema = z.iso.date();
export const instantSchema = z.iso.datetime({ offset: true });
export const confidenceSchema = z.number().min(0).max(1);
export const scoreSchema = z.number().min(0).max(100);
export const countryCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/);
export const metadataSchema = z.record(z.string().min(1).max(100), z.json());

export const paginatedQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export const pageMetaSchema = z.strictObject({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(100),
  totalItems: z.number().int().min(0),
  totalPages: z.number().int().min(0),
});
export const requestMetaSchema = z.strictObject({
  requestId: z.string().trim().min(1).optional(),
});
export const apiErrorCodeValues = [
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "validation_failed",
  "rate_limited",
  "internal_error",
] as const;
export const apiErrorSchema = z.strictObject({
  code: z.enum(apiErrorCodeValues),
  message: z.string().trim().min(1).max(500),
  details: z.json().optional(),
});
export const errorEnvelopeSchema = z.strictObject({ error: apiErrorSchema });
export const successEnvelopeSchema = <T extends z.ZodType>(data: T) =>
  z.strictObject({ data, meta: requestMetaSchema.optional() });
export const paginatedEnvelopeSchema = <T extends z.ZodType>(item: T) =>
  z.strictObject({ data: z.array(item), meta: pageMetaSchema });

const id = z.uuid();
const name = z.string().trim().min(1).max(300);
const timestamps = {
  id,
  createdAt: instantSchema,
  updatedAt: instantSchema,
} as const;
const nonEmptyUpdate = (value: object) => Object.keys(value).length > 0;

export const entityReferenceSchema = z.strictObject({
  type: researchTargetTypeSchema,
  id,
});
export const identifierSchema = z.strictObject({
  type: identifierTypeSchema,
  value: z.string().trim().min(1).max(100),
  issuingCountry: countryCodeSchema.optional(),
});
export const moneySchema = z.strictObject({
  amount: z.string().regex(/^-?\d+(?:\.\d+)?$/),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/),
});

export const companyCreateSchema = z.strictObject({
  legalName: name,
  commonName: name.optional(),
  description: z.string().trim().max(10_000).optional(),
  websiteUrl: z.url().optional(),
  headquartersCountry: countryCodeSchema.optional(),
  status: companyStatusSchema.default("unknown"),
  ownershipType: ownershipTypeSchema.default("unknown"),
  parentCompanyId: id.optional(),
  identifiers: z.array(identifierSchema).max(100).default([]),
});
export const companySchema = z.strictObject({
  ...timestamps,
  ...companyCreateSchema.shape,
});
export const companyUpdateSchema = companyCreateSchema
  .partial()
  .refine(nonEmptyUpdate, "At least one field must be supplied");
export const companyListQuerySchema = paginatedQuerySchema.extend({
  query: z.string().trim().max(200).optional(),
  status: companyStatusSchema.optional(),
  ownershipType: ownershipTypeSchema.optional(),
  country: countryCodeSchema.optional(),
});

export const dataSourceCreateSchema = z.strictObject({
  name,
  description: z.string().trim().max(10_000).optional(),
  homepageUrl: z.url().optional(),
  access: sourceAccessSchema,
  ingestionMethod: sourceIngestionSchema,
  status: recordStatusSchema.default("active"),
  metadata: metadataSchema.default({}),
});
export const dataSourceSchema = z.strictObject({
  ...timestamps,
  ...dataSourceCreateSchema.shape,
});
export const dataSourceUpdateSchema = dataSourceCreateSchema
  .partial()
  .refine(nonEmptyUpdate, "At least one field must be supplied");
export const dataSourceListQuerySchema = paginatedQuerySchema.extend({
  query: z.string().trim().max(200).optional(),
  access: sourceAccessSchema.optional(),
  ingestionMethod: sourceIngestionSchema.optional(),
  status: recordStatusSchema.optional(),
});
export const sourceDocumentCreateSchema = z
  .strictObject({
    dataSourceId: id,
    title: z.string().trim().min(1).max(500),
    originalUrl: z.url().optional(),
    storageKey: z.string().trim().min(1).max(1_000).optional(),
    mediaType: z.string().trim().min(1).max(200),
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/i),
    retrievedAt: instantSchema,
    metadata: metadataSchema.default({}),
  })
  .refine(
    (v) => v.originalUrl !== undefined || v.storageKey !== undefined,
    "An original URL or durable storage key is required",
  );
export const sourceDocumentSchema = z.strictObject({
  ...timestamps,
  ...sourceDocumentCreateSchema.shape,
});

export const addressSchema = z.strictObject({
  line1: z.string().trim().min(1).max(300),
  line2: z.string().trim().min(1).max(300).optional(),
  city: z.string().trim().min(1).max(200),
  region: z.string().trim().min(1).max(200).optional(),
  postalCode: z.string().trim().min(1).max(30).optional(),
  country: countryCodeSchema,
});
export const facilityCreateSchema = z
  .strictObject({
    companyId: id,
    name,
    address: addressSchema.optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    status: recordStatusSchema.default("active"),
  })
  .refine(
    (v) => (v.latitude === undefined) === (v.longitude === undefined),
    "Latitude and longitude must be supplied together",
  );
export const facilitySchema = z.strictObject({
  ...timestamps,
  ...facilityCreateSchema.shape,
});
export const facilityUpdateSchema = z
  .strictObject({
    companyId: id.optional(),
    name: name.optional(),
    address: addressSchema.optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    status: recordStatusSchema.optional(),
  })
  .refine(nonEmptyUpdate, "At least one field must be supplied");

export const contactCreateSchema = z.strictObject({
  companyId: id,
  facilityId: id.optional(),
  fullName: name,
  title: name.optional(),
  email: z.email().optional(),
  phone: z.string().trim().min(3).max(50).optional(),
  verificationStatus: contactVerificationStatusSchema.default("unverified"),
  verifiedAt: instantSchema.optional(),
  status: recordStatusSchema.default("active"),
});
export const contactSchema = z.strictObject({
  ...timestamps,
  ...contactCreateSchema.shape,
});
export const contactUpdateSchema = contactCreateSchema
  .partial()
  .refine(nonEmptyUpdate, "At least one field must be supplied");

export const platformCreateSchema = z.strictObject({
  name,
  manufacturerCompanyId: id.optional(),
  parentPlatformId: id.optional(),
  variantName: name.optional(),
  description: z.string().trim().max(10_000).optional(),
  status: recordStatusSchema.default("active"),
});
export const platformSchema = z.strictObject({
  ...timestamps,
  ...platformCreateSchema.shape,
});
export const platformUpdateSchema = platformCreateSchema
  .partial()
  .refine(nonEmptyUpdate, "At least one field must be supplied");
export const partCreateSchema = z.strictObject({
  partNumber: z.string().trim().min(1).max(200),
  name,
  manufacturerCompanyId: id.optional(),
  description: z.string().trim().max(10_000).optional(),
  status: recordStatusSchema.default("active"),
});
export const partSchema = z.strictObject({
  ...timestamps,
  ...partCreateSchema.shape,
});
export const partUpdateSchema = partCreateSchema
  .partial()
  .refine(nonEmptyUpdate, "At least one field must be supplied");

export const qualificationCreateSchema = z
  .strictObject({
    facilityId: id,
    partId: id,
    platformId: id.optional(),
    subsystem: name.optional(),
    customerCompanyId: id.optional(),
    validFrom: dateSchema.optional(),
    validTo: dateSchema.optional(),
    scarcity: qualificationScarcitySchema.default("not_assessed"),
    confidence: confidenceSchema.optional(),
    status: recordStatusSchema.default("active"),
  })
  .refine(
    (v) =>
      v.validFrom === undefined ||
      v.validTo === undefined ||
      v.validFrom <= v.validTo,
    { message: "validFrom must be on or before validTo", path: ["validTo"] },
  );
export const qualificationSchema = z.strictObject({
  ...timestamps,
  ...qualificationCreateSchema.shape,
});
export const qualificationUpdateSchema = z
  .strictObject({
    facilityId: id.optional(),
    partId: id.optional(),
    platformId: id.optional(),
    subsystem: name.optional(),
    customerCompanyId: id.optional(),
    validFrom: dateSchema.optional(),
    validTo: dateSchema.optional(),
    scarcity: qualificationScarcitySchema.optional(),
    confidence: confidenceSchema.optional(),
    status: recordStatusSchema.optional(),
  })
  .refine(nonEmptyUpdate, "At least one field must be supplied");

export const observationCreateSchema = z.strictObject({
  target: entityReferenceSchema,
  field: z.string().trim().min(1).max(200),
  rawValue: z.json(),
  normalizedValue: z.json().optional(),
  sourceDocumentId: id,
  observedAt: instantSchema.optional(),
  confidence: confidenceSchema.optional(),
  conflictStatus: observationConflictStatusSchema.default("none"),
});
export const observationSchema = z.strictObject({
  ...timestamps,
  ...observationCreateSchema.shape,
  reviewStatus: observationReviewStatusSchema,
  reviewedAt: instantSchema.optional(),
  reviewedByUserId: id.optional(),
});
export const evidenceLocatorSchema = z.strictObject({
  page: z.number().int().min(1).optional(),
  section: z.string().trim().min(1).max(500).optional(),
  startOffset: z.number().int().min(0).optional(),
  endOffset: z.number().int().min(0).optional(),
});
export const evidenceCreateSchema = z.strictObject({
  sourceDocumentId: id,
  excerpt: z.string().trim().min(1).max(20_000),
  locator: evidenceLocatorSchema.optional(),
  extractionStatus: evidenceExtractionStatusSchema.default("pending"),
  extractorName: z.string().trim().min(1).max(200).optional(),
  extractedAt: instantSchema.optional(),
});
export const evidenceSchema = z.strictObject({
  ...timestamps,
  ...evidenceCreateSchema.shape,
});
export const evidenceExtractionSchema = z.strictObject({
  evidenceId: id,
  field: z.string().trim().min(1).max(200),
  value: z.json(),
  confidence: confidenceSchema,
  notes: z.string().trim().max(5_000).optional(),
});

export const researchTargetSchema = z.strictObject({
  type: researchTargetTypeSchema,
  id,
  objective: z.string().trim().min(1).max(2_000),
});
export const researchRunCreateSchema = z.strictObject({
  targets: z.array(researchTargetSchema).min(1).max(100),
  requestedModel: z.string().trim().min(1).max(200).optional(),
  maxAttempts: z.number().int().min(1).max(10).default(3),
  maxCostUsd: z.number().min(0).max(10_000).optional(),
  metadata: metadataSchema.default({}),
});
export const researchRunSchema = z.strictObject({
  ...timestamps,
  ...researchRunCreateSchema.shape,
  status: researchRunStatusSchema,
  progress: z.number().min(0).max(1),
  startedAt: instantSchema.optional(),
  finishedAt: instantSchema.optional(),
  error: apiErrorSchema.optional(),
  actualCostUsd: z.number().min(0).optional(),
});
export const researchRunListQuerySchema = paginatedQuerySchema.extend({
  status: researchRunStatusSchema.optional(),
  targetType: researchTargetTypeSchema.optional(),
});

export const proposalCreateSchema = z.strictObject({
  researchRunId: id,
  observationId: id,
  target: entityReferenceSchema,
  field: z.string().trim().min(1).max(200),
  proposedValue: z.json(),
  rationale: z.string().trim().min(1).max(10_000),
  confidence: confidenceSchema.optional(),
});
export const proposalSchema = z.strictObject({
  ...timestamps,
  ...proposalCreateSchema.shape,
  status: proposalStatusSchema,
  reviewedAt: instantSchema.optional(),
  reviewedByUserId: id.optional(),
  reviewNote: z.string().trim().max(10_000).optional(),
});
export const proposalDecisionSchema = z.strictObject({
  note: z.string().trim().max(10_000).optional(),
});
export const proposalListQuerySchema = paginatedQuerySchema.extend({
  status: proposalStatusSchema.optional(),
  researchRunId: id.optional(),
  targetType: researchTargetTypeSchema.optional(),
});

export const importFormatValues = ["csv", "jsonl", "xlsx"] as const;
export const importEntityValues = [
  "companies",
  "facilities",
  "contacts",
  "platforms",
  "parts",
  "qualifications",
  "data_sources",
] as const;
export const importCreateSchema = z.strictObject({
  entity: z.enum(importEntityValues),
  format: z.enum(importFormatValues),
  storageKey: z.string().trim().min(1).max(1_000),
  fileName: z.string().trim().min(1).max(500),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  dryRun: z.boolean().default(false),
});
export const importSchema = z.strictObject({
  ...timestamps,
  ...importCreateSchema.shape,
  status: importStatusSchema,
  totalRows: z.number().int().min(0).optional(),
  processedRows: z.number().int().min(0),
  acceptedRows: z.number().int().min(0),
  rejectedRows: z.number().int().min(0),
  error: apiErrorSchema.optional(),
});
export const exportFormatValues = ["csv", "jsonl"] as const;
export const exportStatusValues = [
  "queued",
  "processing",
  "completed",
  "failed",
  "expired",
] as const;
export const exportCreateSchema = z.strictObject({
  entity: z.enum(importEntityValues),
  format: z.enum(exportFormatValues),
  filters: metadataSchema.default({}),
});
export const exportSchema = z.strictObject({
  ...timestamps,
  ...exportCreateSchema.shape,
  status: z.enum(exportStatusValues),
  storageKey: z.string().trim().min(1).max(1_000).optional(),
  expiresAt: instantSchema.optional(),
  error: apiErrorSchema.optional(),
});

export const loginSchema = z.strictObject({
  email: z.email(),
  password: z.string().min(12).max(1_000),
});
export const userCreateSchema = z.strictObject({
  email: z.email(),
  displayName: z.string().trim().min(1).max(200),
  password: z.string().min(12).max(1_000),
  role: roleSchema,
});
export const userUpdateSchema = z
  .strictObject({
    displayName: z.string().trim().min(1).max(200).optional(),
    role: roleSchema.optional(),
    disabled: z.boolean().optional(),
  })
  .refine(nonEmptyUpdate, "At least one field must be supplied");
export const userSchema = z.strictObject({
  ...timestamps,
  email: z.email(),
  displayName: z.string().trim().min(1).max(200),
  role: roleSchema,
  disabled: z.boolean(),
});

export type PaginatedQuery = z.infer<typeof paginatedQuerySchema>;
export type PageMeta = z.infer<typeof pageMetaSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
export type SuccessEnvelope<T> = {
  data: T;
  meta?: z.infer<typeof requestMetaSchema>;
};
export type PaginatedEnvelope<T> = { data: T[]; meta: PageMeta };
export type EntityReference = z.infer<typeof entityReferenceSchema>;
export type Identifier = z.infer<typeof identifierSchema>;
export type CompanyCreate = z.infer<typeof companyCreateSchema>;
export type Company = z.infer<typeof companySchema>;
export type DataSourceCreate = z.infer<typeof dataSourceCreateSchema>;
export type DataSource = z.infer<typeof dataSourceSchema>;
export type SourceDocumentCreate = z.infer<typeof sourceDocumentCreateSchema>;
export type SourceDocument = z.infer<typeof sourceDocumentSchema>;
export type FacilityCreate = z.infer<typeof facilityCreateSchema>;
export type Facility = z.infer<typeof facilitySchema>;
export type ContactCreate = z.infer<typeof contactCreateSchema>;
export type Contact = z.infer<typeof contactSchema>;
export type PlatformCreate = z.infer<typeof platformCreateSchema>;
export type Platform = z.infer<typeof platformSchema>;
export type PartCreate = z.infer<typeof partCreateSchema>;
export type Part = z.infer<typeof partSchema>;
export type QualificationCreate = z.infer<typeof qualificationCreateSchema>;
export type Qualification = z.infer<typeof qualificationSchema>;
export type ObservationCreate = z.infer<typeof observationCreateSchema>;
export type Observation = z.infer<typeof observationSchema>;
export type EvidenceCreate = z.infer<typeof evidenceCreateSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type EvidenceExtraction = z.infer<typeof evidenceExtractionSchema>;
export type ResearchTarget = z.infer<typeof researchTargetSchema>;
export type ResearchRunCreate = z.infer<typeof researchRunCreateSchema>;
export type ResearchRun = z.infer<typeof researchRunSchema>;
export type ProposalCreate = z.infer<typeof proposalCreateSchema>;
export type Proposal = z.infer<typeof proposalSchema>;
export type ImportCreate = z.infer<typeof importCreateSchema>;
export type Import = z.infer<typeof importSchema>;
export type ExportCreate = z.infer<typeof exportCreateSchema>;
export type Export = z.infer<typeof exportSchema>;
export type UserCreate = z.infer<typeof userCreateSchema>;
export type User = z.infer<typeof userSchema>;

export type ApiErrorCode = z.infer<typeof apiErrorSchema.shape.code>;
export type RequestMeta = z.infer<typeof requestMetaSchema>;
export type Money = z.infer<typeof moneySchema>;
export type Address = z.infer<typeof addressSchema>;
export type CompanyUpdate = z.infer<typeof companyUpdateSchema>;
export type CompanyListQuery = z.infer<typeof companyListQuerySchema>;
export type DataSourceUpdate = z.infer<typeof dataSourceUpdateSchema>;
export type DataSourceListQuery = z.infer<typeof dataSourceListQuerySchema>;
export type FacilityUpdate = z.infer<typeof facilityUpdateSchema>;
export type ContactUpdate = z.infer<typeof contactUpdateSchema>;
export type PlatformUpdate = z.infer<typeof platformUpdateSchema>;
export type PartUpdate = z.infer<typeof partUpdateSchema>;
export type QualificationUpdate = z.infer<typeof qualificationUpdateSchema>;
export type EvidenceLocator = z.infer<typeof evidenceLocatorSchema>;
export type ResearchRunListQuery = z.infer<typeof researchRunListQuerySchema>;
export type ProposalDecision = z.infer<typeof proposalDecisionSchema>;
export type ProposalListQuery = z.infer<typeof proposalListQuerySchema>;
export type ImportFormat = (typeof importFormatValues)[number];
export type ImportEntity = (typeof importEntityValues)[number];
export type ExportFormat = (typeof exportFormatValues)[number];
export type ExportStatus = (typeof exportStatusValues)[number];
export type Login = z.infer<typeof loginSchema>;
export type UserUpdate = z.infer<typeof userUpdateSchema>;

export const v1Schemas = {
  company: companySchema,
  dataSource: dataSourceSchema,
  sourceDocument: sourceDocumentSchema,
  facility: facilitySchema,
  contact: contactSchema,
  platform: platformSchema,
  part: partSchema,
  qualification: qualificationSchema,
  observation: observationSchema,
  evidence: evidenceSchema,
  researchRun: researchRunSchema,
  proposal: proposalSchema,
  import: importSchema,
  export: exportSchema,
  user: userSchema,
  errorEnvelope: errorEnvelopeSchema,
} as const;
