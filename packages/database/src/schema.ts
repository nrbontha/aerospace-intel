import {
  buildToPrintRiskValues,
  campaignStatusValues,
  candidateStatusValues,
  companyStatusValues,
  contactVerificationStatusValues,
  evidenceExtractionStatusValues,
  experimentKindValues,
  feedbackChannelValues,
  frontierItemStatusValues,
  frontierItemTypeValues,
  goldenExampleTypeValues,
  identifierTypeValues,
  importStatusValues,
  labelScaleValues,
  leadStatusValues,
  matchDecisionValues,
  observationConflictStatusValues,
  noveltyStatusValues,
  observationReviewStatusValues,
  ownershipTypeValues,
  programAxisValues,
  programStatusValues,
  proposalStatusValues,
  qualificationScarcityValues,
  recordStatusValues,
  researchQuestionStatusValues,
  researchRunStatusValues,
  researchTargetTypeValues,
  reviewStatusValues,
  roleValues,
  scoreAxisValues,
  snapshotMemberMatchStatusValues,
  sourceAccessValues,
  sourceIngestionValues,
} from "@asi/contracts";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const ct = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const ut = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const conf = (name = "confidence") => numeric(name, { precision: 5, scale: 4 });

export const userRole = pgEnum("user_role", roleValues);
export const sourceAccess = pgEnum("source_access", sourceAccessValues);
export const sourceIngestion = pgEnum(
  "source_ingestion",
  sourceIngestionValues,
);
export const companyStatus = pgEnum("company_status", companyStatusValues);
export const recordStatus = pgEnum("record_status", recordStatusValues);
export const ownershipType = pgEnum("ownership_type", ownershipTypeValues);
export const identifierType = pgEnum("identifier_type", identifierTypeValues);
export const contactVerificationStatus = pgEnum(
  "contact_verification_status",
  contactVerificationStatusValues,
);
export const qualificationScarcity = pgEnum(
  "qualification_scarcity",
  qualificationScarcityValues,
);
export const observationReviewStatus = pgEnum(
  "observation_review_status",
  observationReviewStatusValues,
);
export const observationConflictStatus = pgEnum(
  "observation_conflict_status",
  observationConflictStatusValues,
);
export const researchTargetType = pgEnum(
  "research_target_type",
  researchTargetTypeValues,
);
export const researchRunStatus = pgEnum(
  "research_run_status",
  researchRunStatusValues,
);
export const proposalStatus = pgEnum("proposal_status", proposalStatusValues);
export const importStatus = pgEnum("import_status", importStatusValues);
export const evidenceExtractionStatus = pgEnum(
  "evidence_extraction_status",
  evidenceExtractionStatusValues,
);
export const financialMetric = pgEnum("financial_metric", [
  "revenue",
  "ebitda",
  "operating_income",
  "net_income",
  "backlog",
  "enterprise_value",
]);
export const observationValueKind = pgEnum("observation_value_kind", [
  "text",
  "number",
  "boolean",
  "date",
  "money",
  "range",
  "entity_reference",
  "structured",
]);
export const researchToolCallStatus = pgEnum("research_tool_call_status", [
  "started",
  "succeeded",
  "failed",
  "blocked",
]);
export const modelUsageStatus = pgEnum("model_usage_status", [
  "succeeded",
  "failed",
]);
export const proposalReviewDecision = pgEnum("proposal_review_decision", [
  "accepted",
  "rejected",
  "superseded",
]);
export const mergeStatus = pgEnum("merge_status", ["applied", "reverted"]);
export const importRowStatus = pgEnum("import_row_status", [
  "pending",
  "validated",
  "imported",
  "rejected",
]);
export const snapshotMemberMatchStatus = pgEnum(
  "snapshot_member_match_status",
  snapshotMemberMatchStatusValues,
);
export const goldenExampleType = pgEnum(
  "golden_example_type",
  goldenExampleTypeValues,
);
export const labelScale = pgEnum("label_scale", labelScaleValues);
export const buildToPrintRisk = pgEnum(
  "build_to_print_risk",
  buildToPrintRiskValues,
);
export const leadStatus = pgEnum("lead_status", leadStatusValues);
export const matchDecision = pgEnum("match_decision", matchDecisionValues);
export const candidateStatus = pgEnum("candidate_status", candidateStatusValues);
export const noveltyStatus = pgEnum("novelty_status", noveltyStatusValues);
export const scoreAxis = pgEnum("score_axis", scoreAxisValues);
export const programAxis = pgEnum("program_axis", programAxisValues);
export const programStatus = pgEnum("program_status", programStatusValues);
export const experimentKind = pgEnum("experiment_kind", experimentKindValues);
export const feedbackChannel = pgEnum("feedback_channel", feedbackChannelValues);
export const researchQuestionStatus = pgEnum(
  "research_question_status",
  researchQuestionStatusValues,
);
export const campaignStatus = pgEnum("campaign_status", campaignStatusValues);
export const frontierItemType = pgEnum("frontier_item_type", frontierItemTypeValues);
export const frontierItemStatus = pgEnum(
  "frontier_item_status",
  frontierItemStatusValues,
);
export const reviewStatus = pgEnum("review_status", reviewStatusValues);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: userRole("role").notNull().default("viewer"),
    isDisabled: boolean("is_disabled").notNull().default(false),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: ct(),
    updatedAt: ut(),
  },
  (t) => [uniqueIndex("users_email_lower_uidx").on(sql`lower(${t.email})`)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    csrfTokenHash: varchar("csrf_token_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    ipHash: varchar("ip_hash", { length: 64 }),
    userAgent: text("user_agent"),
    createdAt: ct(),
  },
  (t) => [
    uniqueIndex("sessions_token_hash_uidx").on(t.tokenHash),
    index("sessions_user_expiry_idx").on(t.userId, t.expiresAt),
    check("sessions_expiry_chk", sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);

export const rateLimits = pgTable(
  "rate_limits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: text("scope").notNull(),
    subjectHash: varchar("subject_hash", { length: 64 }).notNull(),
    windowStartedAt: timestamp("window_started_at", {
      withTimezone: true,
    }).notNull(),
    windowSeconds: integer("window_seconds").notNull(),
    requestCount: integer("request_count").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    updatedAt: ut(),
  },
  (t) => [
    uniqueIndex("rate_limits_scope_subject_window_uidx").on(
      t.scope,
      t.subjectHash,
      t.windowStartedAt,
    ),
    index("rate_limits_expires_idx").on(t.expiresAt),
    check(
      "rate_limits_window_chk",
      sql`${t.windowSeconds} > 0 AND ${t.requestCount} >= 0`,
    ),
  ],
);

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    legalName: text("legal_name").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description"),
    status: companyStatus("status").notNull().default("active"),
    headquartersCountryCode: varchar("headquarters_country_code", {
      length: 2,
    }),
    websiteUrl: text("website_url"),
    foundedYear: integer("founded_year"),
    createdAt: ct(),
    updatedAt: ut(),
  },
  (t) => [
    index("companies_status_idx").on(t.status),
    index("companies_name_trgm_idx").using(
      "gin",
      t.displayName.asc().op("gin_trgm_ops"),
    ),
    index("companies_search_idx").using(
      "gin",
      sql`to_tsvector('english', coalesce(${t.legalName}, '') || ' ' || coalesce(${t.displayName}, '') || ' ' || coalesce(${t.description}, ''))`,
    ),
    check(
      "companies_year_chk",
      sql`${t.foundedYear} IS NULL OR ${t.foundedYear} BETWEEN 1700 AND 2200`,
    ),
  ],
);

export const companyAliases = pgTable(
  "company_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
    aliasType: text("alias_type").notNull().default("name"),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: ct(),
  },
  (t) => [
    uniqueIndex("company_aliases_company_alias_uidx").on(
      t.companyId,
      sql`lower(${t.alias})`,
    ),
    index("company_aliases_trgm_idx").using(
      "gin",
      t.alias.asc().op("gin_trgm_ops"),
    ),
  ],
);
export const companyDomains = pgTable(
  "company_domains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: ct(),
  },
  (t) => [
    uniqueIndex("company_domains_domain_uidx").on(sql`lower(${t.domain})`),
  ],
);
export const companyIdentifiers = pgTable(
  "company_identifiers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    type: identifierType("type").notNull(),
    value: text("value").notNull(),
    issuingCountryCode: varchar("issuing_country_code", { length: 2 }),
    createdAt: ct(),
    updatedAt: ut(),
  },
  (t) => [
    uniqueIndex("company_identifiers_natural_uidx").on(
      t.type,
      sql`upper(${t.value})`,
      sql`coalesce(${t.issuingCountryCode}, '')`,
    ),
  ],
);

export const facilities = pgTable(
  "facilities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    facilityType: text("facility_type"),
    addressLine1: text("address_line_1"),
    addressLine2: text("address_line_2"),
    city: text("city"),
    region: text("region"),
    postalCode: text("postal_code"),
    countryCode: varchar("country_code", { length: 2 }).notNull(),
    latitude: numeric("latitude", { precision: 9, scale: 6 }),
    longitude: numeric("longitude", { precision: 9, scale: 6 }),
    status: recordStatus("status").notNull().default("active"),
    createdAt: ct(),
    updatedAt: ut(),
  },
  (t) => [
    index("facilities_company_idx").on(t.companyId),
    index("facilities_location_idx").on(t.countryCode, t.region, t.city),
    index("facilities_name_trgm_idx").using(
      "gin",
      t.name.asc().op("gin_trgm_ops"),
    ),
    check(
      "facilities_coordinates_chk",
      sql`(${t.latitude} IS NULL OR ${t.latitude} BETWEEN -90 AND 90) AND (${t.longitude} IS NULL OR ${t.longitude} BETWEEN -180 AND 180)`,
    ),
  ],
);
export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id, {
      onDelete: "set null",
    }),
    facilityId: uuid("facility_id").references(() => facilities.id, {
      onDelete: "set null",
    }),
    fullName: text("full_name").notNull(),
    title: text("title"),
    email: text("email"),
    phone: text("phone"),
    verificationStatus: contactVerificationStatus("verification_status")
      .notNull()
      .default("unverified"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    status: recordStatus("status").notNull().default("active"),
    createdAt: ct(),
    updatedAt: ut(),
  },
  (t) => [
    index("contacts_company_idx").on(t.companyId),
    index("contacts_facility_idx").on(t.facilityId),
    index("contacts_name_trgm_idx").using(
      "gin",
      t.fullName.asc().op("gin_trgm_ops"),
    ),
    check(
      "contacts_parent_chk",
      sql`${t.companyId} IS NOT NULL OR ${t.facilityId} IS NOT NULL`,
    ),
  ],
);

export const capabilities = pgTable(
  "capabilities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    parentId: uuid("parent_id").references((): AnyPgColumn => capabilities.id, {
      onDelete: "restrict",
    }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: ct(),
    updatedAt: ut(),
  },
  (t) => [
    uniqueIndex("capabilities_code_uidx").on(t.code),
    index("capabilities_parent_idx").on(t.parentId),
    index("capabilities_search_idx").using(
      "gin",
      sql`to_tsvector('english', ${t.name} || ' ' || coalesce(${t.description}, ''))`,
    ),
  ],
);
export const companyCapabilities = pgTable(
  "company_capabilities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    capabilityId: uuid("capability_id")
      .notNull()
      .references(() => capabilities.id, { onDelete: "restrict" }),
    status: recordStatus("status").notNull().default("active"),
    confidence: conf(),
    validFrom: date("valid_from"),
    validTo: date("valid_to"),
    createdAt: ct(),
    updatedAt: ut(),
  },
  (t) => [
    uniqueIndex("company_capabilities_uidx").on(t.companyId, t.capabilityId),
    check(
      "company_capabilities_ranges_chk",
      sql`(${t.confidence} IS NULL OR ${t.confidence} BETWEEN 0 AND 1) AND (${t.validFrom} IS NULL OR ${t.validTo} IS NULL OR ${t.validFrom} <= ${t.validTo})`,
    ),
  ],
);
export const facilityCapabilities = pgTable(
  "facility_capabilities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "cascade" }),
    capabilityId: uuid("capability_id")
      .notNull()
      .references(() => capabilities.id, { onDelete: "restrict" }),
    status: recordStatus("status").notNull().default("active"),
    confidence: conf(),
    validFrom: date("valid_from"),
    validTo: date("valid_to"),
    createdAt: ct(),
    updatedAt: ut(),
  },
  (t) => [
    uniqueIndex("facility_capabilities_uidx").on(t.facilityId, t.capabilityId),
    check(
      "facility_capabilities_ranges_chk",
      sql`(${t.confidence} IS NULL OR ${t.confidence} BETWEEN 0 AND 1) AND (${t.validFrom} IS NULL OR ${t.validTo} IS NULL OR ${t.validFrom} <= ${t.validTo})`,
    ),
  ],
);
export const certifications = pgTable(
  "certifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id, {
      onDelete: "cascade",
    }),
    facilityId: uuid("facility_id").references(() => facilities.id, {
      onDelete: "cascade",
    }),
    standard: text("standard").notNull(),
    certificateNumber: text("certificate_number"),
    issuingBody: text("issuing_body"),
    issuedOn: date("issued_on"),
    expiresOn: date("expires_on"),
    status: recordStatus("status").notNull().default("active"),
    createdAt: ct(),
    updatedAt: ut(),
  },
  (t) => [
    index("certifications_company_idx").on(t.companyId),
    index("certifications_facility_idx").on(t.facilityId),
    uniqueIndex("certifications_natural_uidx").on(
      sql`coalesce(${t.companyId}::text, '')`,
      sql`coalesce(${t.facilityId}::text, '')`,
      t.standard,
      sql`coalesce(${t.certificateNumber}, '')`,
    ),
    check(
      "certifications_owner_dates_chk",
      sql`num_nonnulls(${t.companyId}, ${t.facilityId}) = 1 AND (${t.issuedOn} IS NULL OR ${t.expiresOn} IS NULL OR ${t.issuedOn} <= ${t.expiresOn})`,
    ),
  ],
);

export const platformFamilies = pgTable(
  "platform_families",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    manufacturerCompanyId: uuid("manufacturer_company_id").references(
      () => companies.id,
      { onDelete: "set null" },
    ),
    description: text("description"),
    createdAt: ct(),
    updatedAt: ut(),
  },
  (t) => [
    uniqueIndex("platform_families_natural_uidx").on(
      sql`lower(${t.name})`,
      sql`coalesce(${t.manufacturerCompanyId}::text, '')`,
    ),
  ],
);
export const platforms = pgTable(
  "platforms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id").references(() => platformFamilies.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    platformType: text("platform_type"),
    manufacturerCompanyId: uuid("manufacturer_company_id").references(
      () => companies.id,
      { onDelete: "set null" },
    ),
    description: text("description"),
    createdAt: ct(),
    updatedAt: ut(),
  },
  (t) => [
    uniqueIndex("platforms_natural_uidx").on(
      sql`lower(${t.name})`,
      sql`coalesce(${t.manufacturerCompanyId}::text, '')`,
    ),
    index("platforms_name_trgm_idx").using(
      "gin",
      t.name.asc().op("gin_trgm_ops"),
    ),
  ],
);
export const platformVariants = pgTable(
  "platform_variants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    platformId: uuid("platform_id")
      .notNull()
      .references(() => platforms.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    designation: text("designation"),
    enteredServiceOn: date("entered_service_on"),
    retiredOn: date("retired_on"),
    createdAt: ct(),
    updatedAt: ut(),
  },
  (t) => [
    uniqueIndex("platform_variants_uidx").on(
      t.platformId,
      sql`lower(${t.name})`,
    ),
    check(
      "platform_variants_dates_chk",
      sql`${t.enteredServiceOn} IS NULL OR ${t.retiredOn} IS NULL OR ${t.enteredServiceOn} <= ${t.retiredOn}`,
    ),
  ],
);
export const subsystems = pgTable(
  "subsystems",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    parentId: uuid("parent_id").references((): AnyPgColumn => subsystems.id, {
      onDelete: "restrict",
    }),
    code: text("code"),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: ct(),
    updatedAt: ut(),
  },
  (t) => [
    uniqueIndex("subsystems_code_uidx").on(t.code),
    index("subsystems_name_trgm_idx").using(
      "gin",
      t.name.asc().op("gin_trgm_ops"),
    ),
  ],
);
export const parts = pgTable(
  "parts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    manufacturerCompanyId: uuid("manufacturer_company_id").references(
      () => companies.id,
      { onDelete: "set null" },
    ),
    partNumber: text("part_number").notNull(),
    name: text("name"),
    description: text("description"),
    lifecycleStatus: recordStatus("lifecycle_status")
      .notNull()
      .default("active"),
    createdAt: ct(),
    updatedAt: ut(),
  },
  (t) => [
    uniqueIndex("parts_natural_uidx").on(
      sql`upper(${t.partNumber})`,
      sql`coalesce(${t.manufacturerCompanyId}::text, '')`,
    ),
    index("parts_number_trgm_idx").using(
      "gin",
      t.partNumber.asc().op("gin_trgm_ops"),
    ),
    index("parts_search_idx").using(
      "gin",
      sql`to_tsvector('english', ${t.partNumber} || ' ' || coalesce(${t.name}, '') || ' ' || coalesce(${t.description}, ''))`,
    ),
  ],
);
export const partAlternateIds = pgTable(
  "part_alternate_ids",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    partId: uuid("part_id")
      .notNull()
      .references(() => parts.id, { onDelete: "cascade" }),
    identifierType: text("identifier_type").notNull(),
    identifierValue: text("identifier_value").notNull(),
    authority: text("authority"),
    createdAt: ct(),
  },
  (t) => [
    uniqueIndex("part_alternate_ids_natural_uidx").on(
      t.identifierType,
      sql`upper(${t.identifierValue})`,
      sql`coalesce(${t.authority}, '')`,
    ),
    index("part_alternate_ids_trgm_idx").using(
      "gin",
      t.identifierValue.asc().op("gin_trgm_ops"),
    ),
  ],
);

export const facilityQualifications = pgTable(
  "facility_qualifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "cascade" }),
    partId: uuid("part_id")
      .notNull()
      .references(() => parts.id, { onDelete: "cascade" }),
    platformId: uuid("platform_id").references(() => platforms.id, {
      onDelete: "cascade",
    }),
    platformVariantId: uuid("platform_variant_id").references(
      () => platformVariants.id,
      { onDelete: "cascade" },
    ),
    subsystemId: uuid("subsystem_id").references(() => subsystems.id, {
      onDelete: "set null",
    }),
    customerCompanyId: uuid("customer_company_id").references(
      () => companies.id,
      { onDelete: "set null" },
    ),
    qualificationReference: text("qualification_reference"),
    scarcity: qualificationScarcity("scarcity")
      .notNull()
      .default("not_assessed"),
    validFrom: date("valid_from"),
    validTo: date("valid_to"),
    confidence: conf(),
    createdAt: ct(),
    updatedAt: ut(),
  },
  (t) => [
    unique("facility_qualifications_context_uidx")
      .on(
        t.facilityId,
        t.partId,
        t.platformId,
        t.platformVariantId,
        t.subsystemId,
        t.customerCompanyId,
        t.validFrom,
      )
      .nullsNotDistinct(),
    index("facility_qualifications_part_idx").on(t.partId),
    check(
      "facility_qualifications_ranges_chk",
      sql`(${t.platformVariantId} IS NULL OR ${t.platformId} IS NOT NULL) AND (${t.validFrom} IS NULL OR ${t.validTo} IS NULL OR ${t.validFrom} <= ${t.validTo}) AND (${t.confidence} IS NULL OR ${t.confidence} BETWEEN 0 AND 1)`,
    ),
  ],
);

export const contracts = pgTable(
  "contracts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contractNumber: text("contract_number").notNull(),
    title: text("title"),
    awardingOrganization: text("awarding_organization"),
    customerCompanyId: uuid("customer_company_id").references(
      () => companies.id,
      { onDelete: "set null" },
    ),
    supplierCompanyId: uuid("supplier_company_id").references(
      () => companies.id,
      { onDelete: "set null" },
    ),
    platformId: uuid("platform_id").references(() => platforms.id, {
      onDelete: "set null",
    }),
    startDate: date("start_date"),
    endDate: date("end_date"),
    amountLower: numeric("amount_lower", { precision: 22, scale: 2 }),
    amountUpper: numeric("amount_upper", { precision: 22, scale: 2 }),
    currency: varchar("currency", { length: 3 }),
    status: recordStatus("status").notNull().default("active"),
    createdAt: ct(),
    updatedAt: ut(),
  },
  (t) => [
    uniqueIndex("contracts_natural_uidx").on(
      sql`upper(${t.contractNumber})`,
      sql`coalesce(${t.awardingOrganization}, '')`,
    ),
    index("contracts_supplier_idx").on(t.supplierCompanyId),
    index("contracts_search_idx").using(
      "gin",
      sql`to_tsvector('english', ${t.contractNumber} || ' ' || coalesce(${t.title}, '') || ' ' || coalesce(${t.awardingOrganization}, ''))`,
    ),
    check(
      "contracts_ranges_chk",
      sql`(${t.amountLower} IS NULL OR ${t.amountUpper} IS NULL OR ${t.amountLower} <= ${t.amountUpper}) AND (${t.startDate} IS NULL OR ${t.endDate} IS NULL OR ${t.startDate} <= ${t.endDate})`,
    ),
  ],
);
export const procurements = pgTable(
  "procurements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contractId: uuid("contract_id").references(() => contracts.id, {
      onDelete: "set null",
    }),
    buyerCompanyId: uuid("buyer_company_id").references(() => companies.id, {
      onDelete: "set null",
    }),
    supplierCompanyId: uuid("supplier_company_id").references(
      () => companies.id,
      { onDelete: "set null" },
    ),
    facilityId: uuid("facility_id").references(() => facilities.id, {
      onDelete: "set null",
    }),
    partId: uuid("part_id").references(() => parts.id, {
      onDelete: "set null",
    }),
    solicitationNumber: text("solicitation_number"),
    awardNumber: text("award_number"),
    quantityLower: numeric("quantity_lower", { precision: 20, scale: 4 }),
    quantityUpper: numeric("quantity_upper", { precision: 20, scale: 4 }),
    unit: text("unit"),
    amountLower: numeric("amount_lower", { precision: 22, scale: 2 }),
    amountUpper: numeric("amount_upper", { precision: 22, scale: 2 }),
    currency: varchar("currency", { length: 3 }),
    awardedOn: date("awarded_on"),
    deliveryFrom: date("delivery_from"),
    deliveryTo: date("delivery_to"),
    createdAt: ct(),
    updatedAt: ut(),
  },
  (t) => [
    index("procurements_supplier_idx").on(t.supplierCompanyId),
    index("procurements_part_idx").on(t.partId),
    check(
      "procurements_ranges_chk",
      sql`(${t.quantityLower} IS NULL OR ${t.quantityUpper} IS NULL OR ${t.quantityLower} <= ${t.quantityUpper}) AND (${t.amountLower} IS NULL OR ${t.amountUpper} IS NULL OR ${t.amountLower} <= ${t.amountUpper}) AND (${t.deliveryFrom} IS NULL OR ${t.deliveryTo} IS NULL OR ${t.deliveryFrom} <= ${t.deliveryTo})`,
    ),
  ],
);

export const dataSources = pgTable(
  "data_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    sourceType: text("source_type").notNull(),
    baseUrl: text("base_url"),
    access: sourceAccess("access").notNull().default("public"),
    ingestion: sourceIngestion("ingestion").notNull().default("manual"),
    publisher: text("publisher"),
    jurisdiction: text("jurisdiction"),
    reliabilityScore: numeric("reliability_score", { precision: 5, scale: 2 }),
    freshnessScore: numeric("freshness_score", { precision: 5, scale: 2 }),
    authorityScore: numeric("authority_score", { precision: 5, scale: 2 }),
    notes: text("notes"),
    createdAt: ct(),
    updatedAt: ut(),
  },
  (t) => [
    uniqueIndex("data_sources_natural_uidx").on(
      sql`lower(${t.name})`,
      sql`coalesce(${t.publisher}, '')`,
    ),
    check(
      "data_sources_scores_chk",
      sql`(${t.reliabilityScore} IS NULL OR ${t.reliabilityScore} BETWEEN 0 AND 100) AND (${t.freshnessScore} IS NULL OR ${t.freshnessScore} BETWEEN 0 AND 100) AND (${t.authorityScore} IS NULL OR ${t.authorityScore} BETWEEN 0 AND 100)`,
    ),
  ],
);
export const sourceDocuments = pgTable(
  "source_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dataSourceId: uuid("data_source_id")
      .notNull()
      .references(() => dataSources.id, { onDelete: "restrict" }),
    canonicalUrl: text("canonical_url"),
    title: text("title"),
    documentType: text("document_type"),
    publishedOn: date("published_on"),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    contentSha256: varchar("content_sha256", { length: 64 }),
    storageKey: text("storage_key"),
    mimeType: text("mime_type"),
    byteLength: bigint("byte_length", { mode: "number" }),
    languageCode: varchar("language_code", { length: 16 }),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: ct(),
  },
  (t) => [
    uniqueIndex("source_documents_source_url_uidx").on(
      t.dataSourceId,
      t.canonicalUrl,
    ),
    uniqueIndex("source_documents_hash_uidx").on(t.contentSha256),
    index("source_documents_title_trgm_idx").using(
      "gin",
      t.title.asc().op("gin_trgm_ops"),
    ),
    check(
      "source_documents_locator_chk",
      sql`(${t.canonicalUrl} IS NOT NULL OR ${t.storageKey} IS NOT NULL) AND (${t.byteLength} IS NULL OR ${t.byteLength} >= 0)`,
    ),
  ],
);
export const companySourceLinks = pgTable(
  "company_source_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dataSourceId: uuid("data_source_id")
      .notNull()
      .references(() => dataSources.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    relationship: text("relationship").notNull().default("mentions"),
    externalKey: text("external_key"),
    createdAt: ct(),
  },
  (t) => [
    uniqueIndex("company_source_links_uidx").on(
      t.dataSourceId,
      t.companyId,
      t.relationship,
    ),
  ],
);
export const sourceDocumentLinks = pgTable(
  "source_document_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceDocumentId: uuid("source_document_id")
      .notNull()
      .references(() => sourceDocuments.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").references(() => companies.id, {
      onDelete: "cascade",
    }),
    facilityId: uuid("facility_id").references(() => facilities.id, {
      onDelete: "cascade",
    }),
    partId: uuid("part_id").references(() => parts.id, { onDelete: "cascade" }),
    platformId: uuid("platform_id").references(() => platforms.id, {
      onDelete: "cascade",
    }),
    contractId: uuid("contract_id").references(() => contracts.id, {
      onDelete: "cascade",
    }),
    relationship: text("relationship").notNull().default("mentions"),
    createdAt: ct(),
  },
  (t) => [
    index("source_document_links_document_idx").on(t.sourceDocumentId),
    check(
      "source_document_links_target_chk",
      sql`num_nonnulls(${t.companyId}, ${t.facilityId}, ${t.partId}, ${t.platformId}, ${t.contractId}) = 1`,
    ),
  ],
);
export const evidence = pgTable(
  "evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceDocumentId: uuid("source_document_id")
      .notNull()
      .references(() => sourceDocuments.id, { onDelete: "restrict" }),
    extractionStatus: evidenceExtractionStatus("extraction_status")
      .notNull()
      .default("pending"),
    quote: text("quote"),
    locator: text("locator"),
    pageNumber: integer("page_number"),
    startOffset: integer("start_offset"),
    endOffset: integer("end_offset"),
    extractedByUserId: uuid("extracted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    extractionMethod: text("extraction_method").notNull(),
    contentSha256: varchar("content_sha256", { length: 64 }),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: ct(),
  },
  (t) => [
    index("evidence_document_idx").on(t.sourceDocumentId),
    check(
      "evidence_location_chk",
      sql`(${t.quote} IS NOT NULL OR ${t.locator} IS NOT NULL) AND (${t.pageNumber} IS NULL OR ${t.pageNumber} > 0) AND (${t.startOffset} IS NULL OR ${t.endOffset} IS NULL OR (${t.startOffset} >= 0 AND ${t.startOffset} <= ${t.endOffset}))`,
    ),
  ],
);

export const ownershipObservations = pgTable(
  "ownership_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    parentCompanyId: uuid("parent_company_id").references(() => companies.id, {
      onDelete: "restrict",
    }),
    type: ownershipType("type").notNull(),
    ownerName: text("owner_name"),
    ownershipPercentLower: numeric("ownership_percent_lower", {
      precision: 7,
      scale: 4,
    }),
    ownershipPercentUpper: numeric("ownership_percent_upper", {
      precision: 7,
      scale: 4,
    }),
    validFrom: date("valid_from"),
    validTo: date("valid_to"),
    confidence: conf().notNull(),
    evidenceId: uuid("evidence_id")
      .notNull()
      .references(() => evidence.id, { onDelete: "restrict" }),
    observedAt: timestamp("observed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: ct(),
  },
  (t) => [
    index("ownership_observations_company_idx").on(t.companyId, t.observedAt),
    check(
      "ownership_observations_ranges_chk",
      sql`(${t.parentCompanyId} IS NOT NULL OR ${t.ownerName} IS NOT NULL) AND (${t.parentCompanyId} IS NULL OR ${t.parentCompanyId} <> ${t.companyId}) AND (${t.ownershipPercentLower} IS NULL OR ${t.ownershipPercentLower} BETWEEN 0 AND 100) AND (${t.ownershipPercentUpper} IS NULL OR ${t.ownershipPercentUpper} BETWEEN 0 AND 100) AND (${t.ownershipPercentLower} IS NULL OR ${t.ownershipPercentUpper} IS NULL OR ${t.ownershipPercentLower} <= ${t.ownershipPercentUpper}) AND (${t.validFrom} IS NULL OR ${t.validTo} IS NULL OR ${t.validFrom} <= ${t.validTo}) AND ${t.confidence} BETWEEN 0 AND 1`,
    ),
  ],
);
export const financialObservations = pgTable(
  "financial_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    metric: financialMetric("metric").notNull(),
    amountLower: numeric("amount_lower", { precision: 22, scale: 2 }),
    amountUpper: numeric("amount_upper", { precision: 22, scale: 2 }),
    currency: varchar("currency", { length: 3 }).notNull(),
    periodStart: date("period_start"),
    periodEnd: date("period_end"),
    fiscalYear: integer("fiscal_year"),
    confidence: conf().notNull(),
    evidenceId: uuid("evidence_id")
      .notNull()
      .references(() => evidence.id, { onDelete: "restrict" }),
    observedAt: timestamp("observed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: ct(),
  },
  (t) => [
    index("financial_observations_company_idx").on(
      t.companyId,
      t.metric,
      t.periodEnd,
    ),
    check(
      "financial_observations_ranges_chk",
      sql`(${t.amountLower} IS NULL OR ${t.amountUpper} IS NULL OR ${t.amountLower} <= ${t.amountUpper}) AND (${t.periodStart} IS NULL OR ${t.periodEnd} IS NULL OR ${t.periodStart} <= ${t.periodEnd}) AND ${t.confidence} BETWEEN 0 AND 1`,
    ),
  ],
);
export const employeeObservations = pgTable(
  "employee_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    employeeCountLower: integer("employee_count_lower"),
    employeeCountUpper: integer("employee_count_upper"),
    asOfDate: date("as_of_date"),
    confidence: conf().notNull(),
    evidenceId: uuid("evidence_id")
      .notNull()
      .references(() => evidence.id, { onDelete: "restrict" }),
    observedAt: timestamp("observed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: ct(),
  },
  (t) => [
    index("employee_observations_company_idx").on(t.companyId, t.asOfDate),
    check(
      "employee_observations_ranges_chk",
      sql`(${t.employeeCountLower} IS NULL OR ${t.employeeCountLower} >= 0) AND (${t.employeeCountUpper} IS NULL OR ${t.employeeCountUpper} >= 0) AND (${t.employeeCountLower} IS NULL OR ${t.employeeCountUpper} IS NULL OR ${t.employeeCountLower} <= ${t.employeeCountUpper}) AND ${t.confidence} BETWEEN 0 AND 1`,
    ),
  ],
);
export const observations = pgTable(
  "observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    fieldKey: text("field_key").notNull(),
    valueKind: observationValueKind("value_kind").notNull(),
    value: jsonb("value").$type<unknown>().notNull(),
    normalizedText: text("normalized_text"),
    unit: text("unit"),
    validFrom: date("valid_from"),
    validTo: date("valid_to"),
    observedAt: timestamp("observed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    confidence: conf().notNull(),
    evidenceId: uuid("evidence_id")
      .notNull()
      .references(() => evidence.id, { onDelete: "restrict" }),
    reviewStatus: observationReviewStatus("review_status")
      .notNull()
      .default("pending"),
    conflictStatus: observationConflictStatus("conflict_status")
      .notNull()
      .default("none"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: ct(),
  },
  (t) => [
    index("observations_subject_field_idx").on(
      t.subjectType,
      t.subjectId,
      t.fieldKey,
      t.observedAt,
    ),
    index("observations_evidence_idx").on(t.evidenceId),
    check(
      "observations_ranges_chk",
      sql`${t.confidence} BETWEEN 0 AND 1 AND (${t.validFrom} IS NULL OR ${t.validTo} IS NULL OR ${t.validFrom} <= ${t.validTo})`,
    ),
  ],
);

export const researchRuns = pgTable(
  "research_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    targetType: researchTargetType("target_type").notNull(),
    targetId: uuid("target_id"),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    status: researchRunStatus("status").notNull().default("queued"),
    objective: text("objective").notNull(),
    input: jsonb("input")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    promptVersion: text("prompt_version").notNull(),
    progressPercent: numeric("progress_percent", { precision: 5, scale: 2 }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: ct(),
    updatedAt: ut(),
  },
  (t) => [
    index("research_runs_target_idx").on(t.targetType, t.targetId),
    index("research_runs_status_idx").on(t.status, t.createdAt),
    check(
      "research_runs_progress_dates_chk",
      sql`(${t.progressPercent} IS NULL OR ${t.progressPercent} BETWEEN 0 AND 100) AND (${t.startedAt} IS NULL OR ${t.completedAt} IS NULL OR ${t.startedAt} <= ${t.completedAt})`,
    ),
  ],
);
export const researchToolCalls = pgTable(
  "research_tool_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    researchRunId: uuid("research_run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "restrict" }),
    sequence: integer("sequence").notNull(),
    toolName: text("tool_name").notNull(),
    status: researchToolCallStatus("status").notNull(),
    request: jsonb("request").$type<unknown>().notNull(),
    response: jsonb("response").$type<unknown>(),
    requestSha256: varchar("request_sha256", { length: 64 }).notNull(),
    responseSha256: varchar("response_sha256", { length: 64 }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    error: jsonb("error").$type<unknown>(),
    createdAt: ct(),
  },
  (t) => [
    uniqueIndex("research_tool_calls_run_sequence_uidx").on(
      t.researchRunId,
      t.sequence,
    ),
    check(
      "research_tool_calls_ranges_chk",
      sql`${t.sequence} >= 0 AND (${t.durationMs} IS NULL OR ${t.durationMs} >= 0) AND (${t.completedAt} IS NULL OR ${t.startedAt} <= ${t.completedAt})`,
    ),
  ],
);
export const modelUsage = pgTable(
  "model_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    researchRunId: uuid("research_run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "restrict" }),
    sequence: integer("sequence").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    status: modelUsageStatus("status").notNull(),
    promptSha256: varchar("prompt_sha256", { length: 64 }).notNull(),
    responseSha256: varchar("response_sha256", { length: 64 }),
    request: jsonb("request").$type<unknown>().notNull(),
    response: jsonb("response").$type<unknown>(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costUsd: numeric("cost_usd", { precision: 14, scale: 8 }),
    latencyMs: integer("latency_ms"),
    error: jsonb("error").$type<unknown>(),
    createdAt: ct(),
  },
  (t) => [
    uniqueIndex("model_usage_run_sequence_uidx").on(
      t.researchRunId,
      t.sequence,
    ),
    check(
      "model_usage_nonnegative_chk",
      sql`${t.sequence} >= 0 AND (${t.inputTokens} IS NULL OR ${t.inputTokens} >= 0) AND (${t.outputTokens} IS NULL OR ${t.outputTokens} >= 0) AND (${t.costUsd} IS NULL OR ${t.costUsd} >= 0) AND (${t.latencyMs} IS NULL OR ${t.latencyMs} >= 0)`,
    ),
  ],
);
export const researchProposals = pgTable(
  "research_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    researchRunId: uuid("research_run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "restrict" }),
    observationId: uuid("observation_id")
      .notNull()
      .references(() => observations.id, { onDelete: "restrict" }),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    fieldKey: text("field_key").notNull(),
    status: proposalStatus("status").notNull().default("pending"),
    rationale: text("rationale"),
    proposedByModelUsageId: uuid("proposed_by_model_usage_id").references(
      () => modelUsage.id,
      { onDelete: "restrict" },
    ),
    createdAt: ct(),
    updatedAt: ut(),
  },
  (t) => [
    uniqueIndex("research_proposals_run_observation_uidx").on(
      t.researchRunId,
      t.observationId,
    ),
    index("research_proposals_status_idx").on(t.status, t.createdAt),
  ],
);
export const proposalReviews = pgTable(
  "proposal_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => researchProposals.id, { onDelete: "restrict" }),
    reviewerUserId: uuid("reviewer_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    decision: proposalReviewDecision("decision").notNull(),
    reason: text("reason"),
    createdAt: ct(),
  },
  (t) => [index("proposal_reviews_proposal_idx").on(t.proposalId, t.createdAt)],
);
export const canonicalFacts = pgTable(
  "canonical_facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    fieldKey: text("field_key").notNull(),
    currentObservationId: uuid("current_observation_id")
      .notNull()
      .references(() => observations.id, { onDelete: "restrict" }),
    acceptedProposalId: uuid("accepted_proposal_id").references(
      () => researchProposals.id,
      { onDelete: "restrict" },
    ),
    supersededObservationId: uuid("superseded_observation_id").references(
      () => observations.id,
      { onDelete: "restrict" },
    ),
    effectiveFrom: timestamp("effective_from", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: ct(),
    updatedAt: ut(),
  },
  (t) => [
    uniqueIndex("canonical_facts_subject_field_uidx").on(
      t.subjectType,
      t.subjectId,
      t.fieldKey,
    ),
    uniqueIndex("canonical_facts_observation_uidx").on(t.currentObservationId),
    check(
      "canonical_facts_superseded_chk",
      sql`${t.supersededObservationId} IS NULL OR ${t.supersededObservationId} <> ${t.currentObservationId}`,
    ),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    requestId: text("request_id"),
    before: jsonb("before").$type<unknown>(),
    after: jsonb("after").$type<unknown>(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: ct(),
  },
  (t) => [
    index("audit_events_entity_idx").on(t.entityType, t.entityId, t.createdAt),
    index("audit_events_actor_idx").on(t.actorUserId, t.createdAt),
  ],
);
export const entityMerges = pgTable(
  "entity_merges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityType: text("entity_type").notNull(),
    sourceEntityId: uuid("source_entity_id").notNull(),
    targetEntityId: uuid("target_entity_id").notNull(),
    status: mergeStatus("status").notNull().default("applied"),
    reason: text("reason").notNull(),
    sourceSnapshot: jsonb("source_snapshot").$type<unknown>().notNull(),
    targetSnapshotBefore: jsonb("target_snapshot_before")
      .$type<unknown>()
      .notNull(),
    targetSnapshotAfter: jsonb("target_snapshot_after")
      .$type<unknown>()
      .notNull(),
    mergedByUserId: uuid("merged_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    revertedByUserId: uuid("reverted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    mergedAt: timestamp("merged_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revertedAt: timestamp("reverted_at", { withTimezone: true }),
    createdAt: ct(),
  },
  (t) => [
    index("entity_merges_source_idx").on(t.entityType, t.sourceEntityId),
    index("entity_merges_target_idx").on(t.entityType, t.targetEntityId),
    check(
      "entity_merges_integrity_chk",
      sql`${t.sourceEntityId} <> ${t.targetEntityId} AND ((${t.status} = 'reverted') = (${t.revertedAt} IS NOT NULL))`,
    ),
  ],
);
export const savedViews = pgTable(
  "saved_views",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    resourceType: text("resource_type").notNull(),
    definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
    isShared: boolean("is_shared").notNull().default(false),
    createdAt: ct(),
    updatedAt: ut(),
  },
  (t) => [
    uniqueIndex("saved_views_owner_resource_name_uidx").on(
      t.ownerUserId,
      t.resourceType,
      sql`lower(${t.name})`,
    ),
  ],
);
export const imports = pgTable(
  "imports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    dataSourceId: uuid("data_source_id").references(() => dataSources.id, {
      onDelete: "set null",
    }),
    status: importStatus("status").notNull().default("queued"),
    fileName: text("file_name").notNull(),
    storageKey: text("storage_key").notNull(),
    contentSha256: varchar("content_sha256", { length: 64 }).notNull(),
    mapping: jsonb("mapping")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    rowCount: integer("row_count"),
    importedCount: integer("imported_count").notNull().default(0),
    rejectedCount: integer("rejected_count").notNull().default(0),
    error: jsonb("error").$type<unknown>(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: ct(),
    updatedAt: ut(),
  },
  (t) => [
    uniqueIndex("imports_hash_uidx").on(t.contentSha256),
    index("imports_status_idx").on(t.status, t.createdAt),
    check(
      "imports_counts_dates_chk",
      sql`(${t.rowCount} IS NULL OR ${t.rowCount} >= 0) AND ${t.importedCount} >= 0 AND ${t.rejectedCount} >= 0 AND (${t.startedAt} IS NULL OR ${t.completedAt} IS NULL OR ${t.startedAt} <= ${t.completedAt})`,
    ),
  ],
);
export const importRows = pgTable(
  "import_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    importId: uuid("import_id")
      .notNull()
      .references(() => imports.id, { onDelete: "cascade" }),
    rowNumber: integer("row_number").notNull(),
    status: importRowStatus("status").notNull().default("pending"),
    rawData: jsonb("raw_data").$type<Record<string, unknown>>().notNull(),
    normalizedData: jsonb("normalized_data").$type<Record<string, unknown>>(),
    targetEntityType: text("target_entity_type"),
    targetEntityId: uuid("target_entity_id"),
    errors: jsonb("errors").$type<unknown>(),
    createdAt: ct(),
    updatedAt: ut(),
  },
  (t) => [
    uniqueIndex("import_rows_import_number_uidx").on(t.importId, t.rowNumber),
    index("import_rows_status_idx").on(t.importId, t.status),
    check(
      "import_rows_integrity_chk",
      sql`${t.rowNumber} > 0 AND ((${t.targetEntityType} IS NULL) = (${t.targetEntityId} IS NULL))`,
    ),
  ],
);
export const scoringWeights = pgTable(
  "scoring_weights",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: text("scope").notNull().default("global"),
    dimension: text("dimension").notNull(),
    weight: numeric("weight", { precision: 8, scale: 6 }).notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true })
      .notNull()
      .defaultNow(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: ct(),
  },
  (t) => [
    uniqueIndex("scoring_weights_scope_dimension_from_uidx").on(
      t.scope,
      t.dimension,
      t.validFrom,
    ),
    check(
      "scoring_weights_ranges_chk",
      sql`${t.weight} BETWEEN 0 AND 1 AND (${t.validTo} IS NULL OR ${t.validFrom} < ${t.validTo})`,
    ),
  ],
);

export const knownUniverseSnapshots = pgTable(
  "known_universe_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    sourceType: text("source_type").notNull(),
    importFileName: text("import_file_name"),
    contentSha256: char("content_sha256", { length: 64 }),
    effectiveDate: date("effective_date"),
    notes: text("notes"),
    rowCount: integer("row_count").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: ct(),
  },
  (t) => [
    uniqueIndex("known_universe_snapshots_key_uidx").on(t.key),
    check(
      "known_universe_snapshots_integrity_chk",
      sql`${t.rowCount} >= 0 AND ${t.sourceType} IN ('golden_set_workbook','grata_enrichment','preliminary_pipeline','manual','external_export')`,
    ),
  ],
);
export const knownUniverseMembers = pgTable(
  "known_universe_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => knownUniverseSnapshots.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").references(() => companies.id, {
      onDelete: "set null",
    }),
    matchedCompanyId: uuid("matched_company_id").references(
      () => companies.id,
      { onDelete: "set null" },
    ),
    rawName: text("raw_name").notNull(),
    rawDomain: text("raw_domain"),
    normalizedDomain: text("normalized_domain"),
    normalizedName: text("normalized_name"),
    matchStatus: snapshotMemberMatchStatus("match_status")
      .notNull()
      .default("unresolved"),
    matchConfidence: numeric("match_confidence", {
      precision: 4,
      scale: 3,
    }),
    rawPayload: jsonb("raw_payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    sourceRow: integer("source_row"),
    createdAt: ct(),
  },
  (t) => [
    uniqueIndex("known_universe_members_identity_uidx")
      .on(t.snapshotId, sql`lower(${t.normalizedDomain})`, sql`lower(${t.normalizedName})`)
      .where(sql`${t.normalizedDomain} IS NOT NULL`),
    uniqueIndex("known_universe_members_name_uidx")
      .on(t.snapshotId, sql`lower(${t.normalizedName})`)
      .where(
        sql`${t.normalizedDomain} IS NULL AND ${t.normalizedName} IS NOT NULL`,
      ),
    index("known_universe_members_snapshot_idx").on(t.snapshotId),
    index("known_universe_members_company_idx").on(t.companyId),
    index("known_universe_members_matched_company_idx").on(t.matchedCompanyId),
    check(
      "known_universe_members_confidence_chk",
      sql`${t.matchConfidence} IS NULL OR ${t.matchConfidence} BETWEEN 0 AND 1`,
    ),
  ],
);
export const goldenExamples = pgTable(
  "golden_examples",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id, {
      onDelete: "set null",
    }),
    snapshotId: uuid("snapshot_id").references(() => knownUniverseSnapshots.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    domain: text("domain"),
    descriptionRaw: text("description_raw"),
    grataPayload: jsonb("grata_payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    workbookRow: integer("workbook_row"),
    proposedLabels: jsonb("proposed_labels")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    archetypeFit: labelScale("archetype_fit"),
    currentActionability: labelScale("current_actionability"),
    businessModelFit: labelScale("business_model_fit"),
    ownershipFit: labelScale("ownership_fit"),
    goldenExampleType: goldenExampleType("golden_example_type"),
    buildToPrintRisk: buildToPrintRisk("build_to_print_risk"),
    reviewNotes: text("review_notes"),
    reviewStatus: reviewStatus("review_status").notNull().default("unclassified"),
    reviewedBy: uuid("reviewed_by").references(() => users.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: ct(),
  },
  (t) => [
    uniqueIndex("golden_examples_name_domain_uidx").on(
      sql`lower(${t.name})`,
      sql`coalesce(lower(${t.domain}), '')`,
    ),
    index("golden_examples_company_idx").on(t.companyId),
    index("golden_examples_review_status_idx").on(t.reviewStatus),
  ],
);
export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    researchRunId: uuid("research_run_id").references(() => researchRuns.id, {
      onDelete: "set null",
    }),
    // Plain column by design: campaigns table arrives in a later migration.
    campaignId: uuid("campaign_id"),
    sourceDocumentId: uuid("source_document_id").references(
      () => sourceDocuments.id,
      { onDelete: "set null" },
    ),
    rawName: text("raw_name").notNull(),
    context: jsonb("context")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    url: text("url"),
    possibleDomain: text("possible_domain"),
    possibleLocation: text("possible_location"),
    possibleIdentifiers: jsonb("possible_identifiers")
      .$type<unknown[]>()
      .notNull()
      .default([]),
    possibleProducts: jsonb("possible_products")
      .$type<unknown[]>()
      .notNull()
      .default([]),
    extractionMethod: text("extraction_method"),
    extractionConfidence: numeric("extraction_confidence", {
      precision: 4,
      scale: 3,
    }),
    status: leadStatus("status").notNull().default("new"),
    resolvedCompanyId: uuid("resolved_company_id").references(
      () => companies.id,
      { onDelete: "set null" },
    ),
    createdAt: ct(),
    updatedAt: ut(),
  },
  (t) => [
    index("leads_status_idx").on(t.status, t.createdAt),
    index("leads_resolved_company_idx").on(t.resolvedCompanyId),
    index("leads_source_document_idx").on(t.sourceDocumentId),
    check(
      "leads_confidence_chk",
      sql`${t.extractionConfidence} IS NULL OR ${t.extractionConfidence} BETWEEN 0 AND 1`,
    ),
  ],
);
export const identityMatchCandidates = pgTable(
  "identity_match_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    signalType: text("signal_type").notNull(),
    features: jsonb("features")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
    explanation: text("explanation"),
    decision: matchDecision("decision").notNull().default("pending"),
    decidedBy: uuid("decided_by").references(() => users.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: ct(),
  },
  (t) => [
    uniqueIndex("identity_match_candidates_lead_company_uidx").on(
      t.leadId,
      t.companyId,
    ),
    index("identity_match_candidates_company_idx").on(t.companyId),
    check(
      "identity_match_candidates_confidence_chk",
      sql`${t.confidence} BETWEEN 0 AND 1`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Candidate discovery (migration 0002) — additive section
// ---------------------------------------------------------------------------

export const scoringPrograms = pgTable(
  "scoring_programs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    version: integer("version").notNull(),
    axis: programAxis("axis").notNull(),
    program: jsonb("program")
      .$type<Record<string, unknown>>()
      .notNull(),
    status: programStatus("status").notNull().default("challenger"),
    complexity: numeric("complexity", { precision: 5, scale: 3 }).default("0"),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: ct(),
  },
  (t) => [
    uniqueIndex("scoring_programs_name_version_uidx").on(t.name, t.version),
    check(
      "scoring_programs_complexity_chk",
      sql`${t.complexity} IS NULL OR ${t.complexity} >= 0`,
    ),
  ],
);

export const candidates = pgTable(
  "candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    status: candidateStatus("status").notNull().default("queued_research"),
    noveltyStatus: noveltyStatus("novelty_status")
      .notNull()
      .default("unable_to_assess"),
    noveltySnapshotIds: uuid("novelty_snapshot_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    rationale: jsonb("rationale")
      .$type<{
        whyInteresting: string[];
        risks: string[];
        unknowns: string[];
      }>()
      .notNull()
      .default({ whyInteresting: [], risks: [], unknowns: [] }),
    // Denormalized latest per-axis value; history lives in candidate_scores.
    currentScores: jsonb("current_scores")
      .$type<Partial<Record<string, number | null>>>()
      .notNull()
      .default({}),
    researchPriority: numeric("research_priority", {
      precision: 6,
      scale: 2,
    }),
    partnerReviewPriority: numeric("partner_review_priority", {
      precision: 6,
      scale: 2,
    }),
    createdAt: ct(),
    updatedAt: ut(),
  },
  (t) => [
    uniqueIndex("candidates_company_id_uidx").on(t.companyId),
    index("candidates_status_idx").on(t.status),
    index("candidates_novelty_status_idx").on(t.noveltyStatus),
    check(
      "candidates_research_priority_chk",
      sql`${t.researchPriority} IS NULL OR ${t.researchPriority} BETWEEN 0 AND 100`,
    ),
    check(
      "candidates_partner_review_priority_chk",
      sql`${t.partnerReviewPriority} IS NULL OR ${t.partnerReviewPriority} BETWEEN 0 AND 100`,
    ),
  ],
);

/** Append-only: enforced by the deny_candidate_scores_mutation trigger. */
export const candidateScores = pgTable(
  "candidate_scores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidates.id, { onDelete: "cascade" }),
    axis: scoreAxis("axis").notNull(),
    // null = un-scoreable (e.g. missing ownership evidence)
    value: numeric("value", { precision: 5, scale: 2 }),
    scoringProgramId: uuid("scoring_program_id").references(
      () => scoringPrograms.id,
      { onDelete: "set null" },
    ),
    featureSchemaVersion: text("feature_schema_version").notNull().default("v1"),
    details: jsonb("details")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    computedAt: timestamp("computed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("candidate_scores_candidate_idx").on(t.candidateId, t.computedAt),
    index("candidate_scores_program_idx").on(t.scoringProgramId),
    check(
      "candidate_scores_value_chk",
      sql`${t.value} IS NULL OR ${t.value} BETWEEN -1 AND 101`,
    ),
  ],
);

export const featureSnapshots = pgTable(
  "feature_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    schemaVersion: text("schema_version").notNull().default("v1"),
    features: jsonb("features")
      .$type<Record<string, unknown>>()
      .notNull(),
    contentSha256: char("content_sha256", { length: 64 }).notNull(),
    thesisVersion: text("thesis_version").notNull().default("thesis-v0"),
    createdAt: ct(),
  },
  (t) => [
    uniqueIndex("feature_snapshots_identity_uidx").on(
      t.companyId,
      t.schemaVersion,
      t.contentSha256,
    ),
    index("feature_snapshots_company_idx").on(t.companyId),
  ],
);

/** Append-only journal, enforced by the deny_experiment_runs_mutation trigger. */
export const experimentRuns = pgTable(
  "experiment_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: experimentKind("kind").notNull(),
    label: text("label").notNull(),
    primaryMetricName: text("primary_metric_name"),
    primaryMetricValue: numeric("primary_metric_value", {
      precision: 8,
      scale: 4,
    }),
    result: jsonb("result")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    keep: boolean("keep"),
    decision: text("decision"),
    lineageParentId: uuid("lineage_parent_id").references(
      (): AnyPgColumn => experimentRuns.id,
      { onDelete: "set null" },
    ),
    // Plain column by design: campaign linkage is intentionally unenforced.
    campaignId: uuid("campaign_id"),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: ct(),
  },
  (t) => [
    index("experiment_runs_kind_created_idx").on(t.kind, t.createdAt),
    index("experiment_runs_campaign_idx").on(t.campaignId),
    index("experiment_runs_lineage_parent_idx").on(t.lineageParentId),
  ],
);

export const feedback = pgTable(
  "feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channel: feedbackChannel("channel").notNull(),
    companyId: uuid("company_id").references(() => companies.id, {
      onDelete: "set null",
    }),
    candidateId: uuid("candidate_id").references(() => candidates.id, {
      onDelete: "set null",
    }),
    leadId: uuid("lead_id").references(() => leads.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    reason: text("reason"),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    notes: text("notes"),
    actor: uuid("actor")
      .notNull()
      .references(() => users.id),
    createdAt: ct(),
  },
  (t) => [
    index("feedback_channel_created_idx").on(t.channel, t.createdAt),
    index("feedback_candidate_idx").on(t.candidateId),
    index("feedback_company_idx").on(t.companyId),
    index("feedback_lead_idx").on(t.leadId),
    check("feedback_action_nonempty_chk", sql`btrim(${t.action}) <> ''`),
    check(
      "feedback_investment_action_chk",
      sql`${t.channel} <> 'investment' OR ${t.action} IN ('strong_fit','possible_fit','shortlist','hold','needs_more_research','reject','historical_ideal_unactionable')`,
    ),
    check(
      "feedback_identity_action_chk",
      sql`${t.channel} <> 'identity' OR ${t.action} IN ('same_company','different_company','duplicate','alias','subsidiary','parent','acquired_into','already_in_pipeline','already_known_outside_pipeline','incorrect_match','correct_match')`,
    ),
    check(
      "feedback_entity_chk",
      sql`${t.companyId} IS NOT NULL OR ${t.candidateId} IS NOT NULL OR ${t.leadId} IS NOT NULL`,
    ),
  ],
);

export const researchQuestions = pgTable(
  "research_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id").references(() => candidates.id, {
      onDelete: "set null",
    }),
    companyId: uuid("company_id").references(() => companies.id, {
      onDelete: "set null",
    }),
    question: text("question").notNull(),
    status: researchQuestionStatus("status").notNull().default("open"),
    answer: jsonb("answer").$type<Record<string, unknown>>(),
    priority: numeric("priority", { precision: 5, scale: 2 }),
    createdAt: ct(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    index("research_questions_candidate_idx").on(t.candidateId),
    index("research_questions_company_idx").on(t.companyId),
    index("research_questions_status_idx").on(t.status),
    check("research_questions_question_chk", sql`btrim(${t.question}) <> ''`),
    check(
      "research_questions_priority_chk",
      sql`${t.priority} IS NULL OR ${t.priority} BETWEEN 0 AND 100`,
    ),
    check(
      "research_questions_entity_chk",
      sql`${t.candidateId} IS NOT NULL OR ${t.companyId} IS NOT NULL`,
    ),
  ],
);

export const researchCampaigns = pgTable(
  "research_campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    objective: text("objective"),
    thesisVersion: text("thesis_version").notNull().default("thesis-v0"),
    policyVersion: text("policy_version").notNull().default("policy-v0"),
    seeds: jsonb("seeds")
      .$type<{
        sources?: string[];
        platforms?: string[];
        capabilities?: string[];
        geography?: string[];
      }>()
      .notNull()
      .default({}),
    excludedSources: jsonb("excluded_sources")
      .$type<string[]>()
      .notNull()
      .default([]),
    budgetUsd: numeric("budget_usd", { precision: 10, scale: 2 }),
    spendUsd: numeric("spend_usd", { precision: 10, scale: 2 })
      .notNull()
      .default("0"),
    concurrency: integer("concurrency").notNull().default(2),
    maxDepth: integer("max_depth").notNull().default(2),
    status: campaignStatus("status").notNull().default("draft"),
    creator: uuid("creator").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: ct(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    metrics: jsonb("metrics")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
  },
  (t) => [
    uniqueIndex("research_campaigns_name_uidx").on(t.name),
    check("research_campaigns_spend_chk", sql`${t.spendUsd} >= 0`),
    check(
      "research_campaigns_concurrency_chk",
      sql`${t.concurrency} BETWEEN 1 AND 16`,
    ),
    check("research_campaigns_max_depth_chk", sql`${t.maxDepth} >= 0`),
  ],
);

export const frontierItems = pgTable(
  "frontier_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => researchCampaigns.id, { onDelete: "cascade" }),
    itemType: frontierItemType("item_type").notNull(),
    normalizedValue: text("normalized_value").notNull(),
    parentItemId: uuid("parent_item_id").references(
      (): AnyPgColumn => frontierItems.id,
      { onDelete: "set null" },
    ),
    discoveryPath: text("discovery_path"),
    priority: numeric("priority", { precision: 6, scale: 2 })
      .notNull()
      .default("0"),
    estimatedValue: numeric("estimated_value", { precision: 6, scale: 2 }),
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 8, scale: 4 })
      .notNull()
      .default("0"),
    depth: integer("depth").notNull().default(0),
    status: frontierItemStatus("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    idempotencyKey: text("idempotency_key"),
    normalizedUrl: text("normalized_url"),
    contentSha256: char("content_sha256", { length: 64 }),
    failureReason: text("failure_reason"),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: ct(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("frontier_items_idempotency_key_uidx").on(t.idempotencyKey),
    index("frontier_items_campaign_status_idx").on(t.campaignId, t.status),
    index("frontier_items_status_next_attempt_idx").on(
      t.status,
      t.nextAttemptAt,
    ),
    index("frontier_items_parent_idx").on(t.parentItemId),
    check("frontier_items_depth_chk", sql`${t.depth} >= 0`),
    check("frontier_items_attempt_count_chk", sql`${t.attemptCount} >= 0`),
    check(
      "frontier_items_estimated_cost_chk",
      sql`${t.estimatedCostUsd} >= 0`,
    ),
  ],
);

export type SelectRow<T extends { $inferSelect: unknown }> = T["$inferSelect"];
export type InsertRow<T extends { $inferInsert: unknown }> = T["$inferInsert"];
export type User = SelectRow<typeof users>;
export type NewUser = InsertRow<typeof users>;
export type Company = SelectRow<typeof companies>;
export type NewCompany = InsertRow<typeof companies>;
export type Facility = SelectRow<typeof facilities>;
export type NewFacility = InsertRow<typeof facilities>;
export type Contact = SelectRow<typeof contacts>;
export type NewContact = InsertRow<typeof contacts>;
export type Part = SelectRow<typeof parts>;
export type NewPart = InsertRow<typeof parts>;
export type DataSource = SelectRow<typeof dataSources>;
export type NewDataSource = InsertRow<typeof dataSources>;
export type SourceDocument = SelectRow<typeof sourceDocuments>;
export type NewSourceDocument = InsertRow<typeof sourceDocuments>;
export type Evidence = SelectRow<typeof evidence>;
export type NewEvidence = InsertRow<typeof evidence>;
export type Observation = SelectRow<typeof observations>;
export type NewObservation = InsertRow<typeof observations>;
export type CanonicalFact = SelectRow<typeof canonicalFacts>;
export type NewCanonicalFact = InsertRow<typeof canonicalFacts>;
export type ResearchRun = SelectRow<typeof researchRuns>;
export type NewResearchRun = InsertRow<typeof researchRuns>;
export type ResearchProposal = SelectRow<typeof researchProposals>;
export type NewResearchProposal = InsertRow<typeof researchProposals>;
export type ProposalReview = SelectRow<typeof proposalReviews>;
export type NewProposalReview = InsertRow<typeof proposalReviews>;
export type AuditEvent = SelectRow<typeof auditEvents>;
export type NewAuditEvent = InsertRow<typeof auditEvents>;

export type KnownUniverseSnapshot = SelectRow<typeof knownUniverseSnapshots>;
export type NewKnownUniverseSnapshot = InsertRow<typeof knownUniverseSnapshots>;
export type KnownUniverseMember = SelectRow<typeof knownUniverseMembers>;
export type NewKnownUniverseMember = InsertRow<typeof knownUniverseMembers>;
export type GoldenExample = SelectRow<typeof goldenExamples>;
export type NewGoldenExample = InsertRow<typeof goldenExamples>;
export type Lead = SelectRow<typeof leads>;
export type NewLead = InsertRow<typeof leads>;
export type IdentityMatchCandidate = SelectRow<typeof identityMatchCandidates>;
export type NewIdentityMatchCandidate = InsertRow<
  typeof identityMatchCandidates
>;
export type ScoringProgram = SelectRow<typeof scoringPrograms>;
export type NewScoringProgram = InsertRow<typeof scoringPrograms>;
export type Candidate = SelectRow<typeof candidates>;
export type NewCandidate = InsertRow<typeof candidates>;
export type CandidateScore = SelectRow<typeof candidateScores>;
export type NewCandidateScore = InsertRow<typeof candidateScores>;
export type FeatureSnapshot = SelectRow<typeof featureSnapshots>;
export type NewFeatureSnapshot = InsertRow<typeof featureSnapshots>;
export type ExperimentRun = SelectRow<typeof experimentRuns>;
export type NewExperimentRun = InsertRow<typeof experimentRuns>;
export type Feedback = SelectRow<typeof feedback>;
export type NewFeedback = InsertRow<typeof feedback>;
export type ResearchQuestion = SelectRow<typeof researchQuestions>;
export type NewResearchQuestion = InsertRow<typeof researchQuestions>;
export type ResearchCampaign = SelectRow<typeof researchCampaigns>;
export type NewResearchCampaign = InsertRow<typeof researchCampaigns>;
export type FrontierItem = SelectRow<typeof frontierItems>;
export type NewFrontierItem = InsertRow<typeof frontierItems>;
