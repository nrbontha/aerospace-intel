import {
  and,
  desc,
  eq,
  getTableColumns,
  ilike,
  inArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { getDatabase } from "./client.js";
import {
  deriveResearchRunState,
  type ResearchRunStatus,
} from "./provenance.js";
import { searchContains } from "./search.js";
import {
  auditEvents,
  canonicalFacts,
  companies,
  companyAliases,
  companyDomains,
  companyIdentifiers,
  companySourceLinks,
  dataSources,
  evidence,
  facilities,
  contacts,
  capabilities,
  certifications,
  companyCapabilities,
  facilityCapabilities,
  facilityQualifications,
  parts,
  platforms,
  modelUsage,
  observations,
  proposalReviews,
  researchProposals,
  researchRuns,
  sourceDocumentLinks,
  sourceDocuments,
} from "./schema.js";

export class RepositoryNotFoundError extends Error {
  constructor(
    readonly entityType: string,
    readonly entityId: string,
  ) {
    super(`${entityType} ${entityId} was not found`);
    this.name = "RepositoryNotFoundError";
  }
}
export class RepositoryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryConflictError";
  }
}
export interface PageInput {
  page?: number;
  pageSize?: number;
}
export interface PageResult<T> {
  records: T[];
  page: number;
  pageSize: number;
  total: number;
}
export function normalizePagination(input: PageInput) {
  const page =
    Number.isInteger(input.page) && (input.page ?? 0) > 0 ? input.page! : 1;
  const pageSize =
    Number.isInteger(input.pageSize) && (input.pageSize ?? 0) > 0
      ? Math.min(input.pageSize!, 100)
      : 25;
  return { page, pageSize, offset: (page - 1) * pageSize };
}
const n = (v: unknown) => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const text = (m: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) {
    const v = m[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
};

export interface CreateDataSourceInput {
  name: string;
  description?: string;
  homepageUrl?: string;
  access: typeof dataSources.$inferInsert.access;
  ingestionMethod: typeof dataSources.$inferInsert.ingestion;
  status?: string;
  metadata?: Record<string, unknown>;
}
export function mapDataSourceInput(
  input: CreateDataSourceInput,
): typeof dataSources.$inferInsert {
  const m = input.metadata ?? {};
  return {
    name: input.name.trim(),
    sourceType: text(m, "sourceType", "source_type") ?? "other",
    baseUrl: input.homepageUrl ?? null,
    access: input.access,
    ingestion: input.ingestionMethod,
    publisher: text(m, "publisher"),
    jurisdiction: text(m, "jurisdiction"),
    notes: input.description ?? null,
  };
}
export interface DataSourceRecord {
  id: string;
  name: string;
  description: string | null;
  homepageUrl: string | null;
  baseUrl: string | null;
  access: typeof dataSources.$inferSelect.access;
  ingestionMethod: typeof dataSources.$inferSelect.ingestion;
  ingestion: typeof dataSources.$inferSelect.ingestion;
  status: string;
  metadata: Record<string, unknown>;
  sourceType: string;
  publisher: string | null;
  jurisdiction: string | null;
  notes: string | null;
  reliabilityScore: string | null;
  freshnessScore: string | null;
  authorityScore: string | null;
  createdAt: Date;
  updatedAt: Date;
  linkedCompanyCount: number;
  linkedPartCount: number;
  documentCount: number;
  researchRunCount: number;
  proposalCount: number;
  pendingProposalCount: number;
  lastResearchRunStatus: ResearchRunStatus | null;
}
const qualifiedDataSourceId = sql.raw('"data_sources"."id"');
const qualifiedCompanyId = sql.raw('"companies"."id"');
const qualifiedResearchRunId = sql.raw('"research_runs"."id"');
function sourceSelect() {
  return {
    id: dataSources.id,
    name: dataSources.name,
    description: dataSources.notes,
    homepageUrl: dataSources.baseUrl,
    access: dataSources.access,
    ingestionMethod: dataSources.ingestion,
    status: sql<string>`coalesce((select after->>'status' from ${auditEvents} where entity_type='data_source' and entity_id=${qualifiedDataSourceId} order by created_at desc limit 1),'active')`,
    metadata: sql<
      Record<string, unknown>
    >`coalesce((select after->'metadata' from ${auditEvents} where entity_type='data_source' and entity_id=${qualifiedDataSourceId} order by created_at desc limit 1),'{}'::jsonb)`,
    sourceType: dataSources.sourceType,
    publisher: dataSources.publisher,
    jurisdiction: dataSources.jurisdiction,
    reliabilityScore: dataSources.reliabilityScore,
    freshnessScore: dataSources.freshnessScore,
    authorityScore: dataSources.authorityScore,
    createdAt: dataSources.createdAt,
    updatedAt: dataSources.updatedAt,
    linkedCompanyCount: sql<number>`(select count(*) from ${companySourceLinks} where data_source_id=${qualifiedDataSourceId})`,
    linkedPartCount: sql<number>`0`,
    documentCount: sql<number>`(select count(*) from ${sourceDocuments} where data_source_id=${qualifiedDataSourceId})`,
    researchRunCount: sql<number>`(select count(*) from ${researchRuns} where target_type='data_source' and target_id=${qualifiedDataSourceId})`,
    proposalCount: sql<number>`(select count(*) from ${researchProposals} p join ${researchRuns} r on r.id=p.research_run_id where r.target_type='data_source' and r.target_id=${qualifiedDataSourceId})`,
    pendingProposalCount: sql<number>`(select count(*) from ${researchProposals} p join ${researchRuns} r on r.id=p.research_run_id where r.target_type='data_source' and r.target_id=${qualifiedDataSourceId} and p.status='pending')`,
    lastResearchRunStatus: sql<ResearchRunStatus | null>`(select status from ${researchRuns} where target_type='data_source' and target_id=${qualifiedDataSourceId} order by created_at desc limit 1)`,
  };
}
function source(row: Record<string, unknown>): DataSourceRecord {
  return {
    ...(row as unknown as DataSourceRecord),
    baseUrl: (row.homepageUrl as string | null) ?? null,
    ingestion: row.ingestionMethod as DataSourceRecord["ingestion"],
    notes: (row.description as string | null) ?? null,
    linkedCompanyCount: n(row.linkedCompanyCount),
    linkedPartCount: n(row.linkedPartCount),
    documentCount: n(row.documentCount),
    researchRunCount: n(row.researchRunCount),
    proposalCount: n(row.proposalCount),
    pendingProposalCount: n(row.pendingProposalCount),
  };
}
export async function createDataSourceRecord(
  input: CreateDataSourceInput,
  actorUserId?: string | null,
) {
  const id = await getDatabase().transaction(async (tx) => {
    const [r] = await tx
      .insert(dataSources)
      .values(mapDataSourceInput(input))
      .returning({ id: dataSources.id });
    if (!r) throw new Error("Data source insert returned no row");
    await tx
      .insert(auditEvents)
      .values({
        actorUserId: actorUserId ?? null,
        action: "create",
        entityType: "data_source",
        entityId: r.id,
        after: {
          ...input,
          status: input.status ?? "active",
          metadata: input.metadata ?? {},
        },
        metadata: {},
      });
    return r.id;
  });
  const r = await getDataSourceRecord(id);
  if (!r) throw new RepositoryNotFoundError("data_source", id);
  return r;
}
export async function getDataSourceRecord(
  id: string,
): Promise<DataSourceRecord | null> {
  const [r] = await getDatabase()
    .select(sourceSelect())
    .from(dataSources)
    .where(eq(dataSources.id, id))
    .limit(1);
  return r ? source(r as unknown as Record<string, unknown>) : null;
}
export async function listDataSourceRecords(
  input: PageInput & {
    query?: string;
    access?: typeof dataSources.$inferSelect.access;
    ingestion?: typeof dataSources.$inferSelect.ingestion;
  },
): Promise<PageResult<DataSourceRecord>> {
  const { page, pageSize, offset } = normalizePagination(input);
  const f: SQL[] = [];
  const sourceQuery = searchContains(input.query);
  if (sourceQuery)
    f.push(
      or(
        ilike(dataSources.name, sourceQuery),
        ilike(dataSources.notes, sourceQuery),
      )!,
    );
  if (input.access) f.push(eq(dataSources.access, input.access));
  if (input.ingestion) f.push(eq(dataSources.ingestion, input.ingestion));
  const w = f.length ? and(...f) : undefined;
  const db = getDatabase();
  const [rows, c] = await Promise.all([
    db
      .select(sourceSelect())
      .from(dataSources)
      .where(w)
      .limit(pageSize)
      .offset(offset),
    db
      .select({ v: sql<number>`count(*)` })
      .from(dataSources)
      .where(w),
  ]);
  return {
    records: rows.map((r) => source(r as unknown as Record<string, unknown>)),
    page,
    pageSize,
    total: n(c[0]?.v),
  };
}

export type CompanyRecord = typeof companies.$inferSelect & {
  commonName: string | null;
  headquartersCountry: string | null;
  sourceCount: number;
  evidenceCount: number;
  observationCount: number;
  canonicalFactCount: number;
  completenessCount: number;
  pendingProposalCount: number;
};
function companySelect() {
  return {
    ...getTableColumns(companies),
    commonName: sql<
      string | null
    >`(select alias from ${companyAliases} where company_id=${qualifiedCompanyId} and is_primary limit 1)`,
    headquartersCountry: companies.headquartersCountryCode,
    sourceCount: sql<number>`(select count(*) from ${companySourceLinks} where company_id=${qualifiedCompanyId})`,
    evidenceCount: sql<number>`(select count(distinct e.id) from ${evidence} e join ${sourceDocuments} d on d.id=e.source_document_id join ${sourceDocumentLinks} l on l.source_document_id=d.id where l.company_id=${qualifiedCompanyId})`,
    observationCount: sql<number>`(select count(*) from ${observations} where subject_type='company' and subject_id=${qualifiedCompanyId})`,
    canonicalFactCount: sql<number>`(select count(*) from ${canonicalFacts} where subject_type='company' and subject_id=${qualifiedCompanyId})`,
    completenessCount: sql<number>`(select count(distinct field_key) from ${canonicalFacts} where subject_type='company' and subject_id=${qualifiedCompanyId})`,
    pendingProposalCount: sql<number>`(select count(*) from ${researchProposals} where subject_type='company' and subject_id=${qualifiedCompanyId} and status='pending')`,
  };
}
function company(r: Record<string, unknown>): CompanyRecord {
  return {
    ...(r as unknown as CompanyRecord),
    sourceCount: n(r.sourceCount),
    evidenceCount: n(r.evidenceCount),
    observationCount: n(r.observationCount),
    canonicalFactCount: n(r.canonicalFactCount),
    completenessCount: n(r.completenessCount),
    pendingProposalCount: n(r.pendingProposalCount),
  };
}
export async function listCompanyRecords(
  input: PageInput & {
    query?: string;
    status?: typeof companies.$inferSelect.status;
  },
): Promise<PageResult<CompanyRecord>> {
  const { page, pageSize, offset } = normalizePagination(input);
  const f: SQL[] = [];
  const companyQuery = searchContains(input.query);
  if (companyQuery)
    f.push(
      or(
        ilike(companies.legalName, companyQuery),
        ilike(companies.displayName, companyQuery),
        sql`exists (select 1 from ${companyAliases} where ${companyAliases.companyId} = ${qualifiedCompanyId} and ${companyAliases.alias} ilike ${companyQuery})`,
      )!,
    );
  if (input.status) f.push(eq(companies.status, input.status));
  const w = f.length ? and(...f) : undefined;
  const db = getDatabase();
  const [rows, c] = await Promise.all([
    db
      .select(companySelect())
      .from(companies)
      .where(w)
      .limit(pageSize)
      .offset(offset),
    db
      .select({ v: sql<number>`count(*)` })
      .from(companies)
      .where(w),
  ]);
  return {
    records: rows.map((r) => company(r as unknown as Record<string, unknown>)),
    page,
    pageSize,
    total: n(c[0]?.v),
  };
}
export async function getCompanyRecord(id: string) {
  const db = getDatabase();
  const [r] = await db
    .select(companySelect())
    .from(companies)
    .where(eq(companies.id, id))
    .limit(1);
  if (!r) return null;
  const [
    aliases,
    domains,
    identifiers,
    facilityRows,
    contactRows,
    capabilityRows,
    facilityCapabilityRows,
    qualificationLinks,
    certificationRows,
    observationRows,
    canonicalRows,
    linkedSources,
  ] = await Promise.all([
    db.select().from(companyAliases).where(eq(companyAliases.companyId, id)),
    db.select().from(companyDomains).where(eq(companyDomains.companyId, id)),
    db
      .select()
      .from(companyIdentifiers)
      .where(eq(companyIdentifiers.companyId, id)),
    db.select().from(facilities).where(eq(facilities.companyId, id)),
    db.select().from(contacts).where(eq(contacts.companyId, id)),
    db
      .select({
        id: companyCapabilities.id,
        capabilityId: capabilities.id,
        name: capabilities.name,
        code: capabilities.code,
        status: companyCapabilities.status,
        confidence: companyCapabilities.confidence,
        validFrom: companyCapabilities.validFrom,
        validTo: companyCapabilities.validTo,
      })
      .from(companyCapabilities)
      .innerJoin(capabilities, eq(capabilities.id, companyCapabilities.capabilityId))
      .where(eq(companyCapabilities.companyId, id)),
    db
      .select({ link: facilityCapabilities, facility: facilities })
      .from(facilityCapabilities)
      .innerJoin(facilities, eq(facilities.id, facilityCapabilities.facilityId))
      .where(eq(facilities.companyId, id)),
    db
      .select({ qualification: facilityQualifications, facility: facilities })
      .from(facilityQualifications)
      .innerJoin(
        facilities,
        eq(facilities.id, facilityQualifications.facilityId),
      )
      .where(eq(facilities.companyId, id)),
    db
      .select({
        certification: certifications,
        facilityName: facilities.name,
      })
      .from(certifications)
      .leftJoin(facilities, eq(facilities.id, certifications.facilityId))
      .where(
        or(
          eq(certifications.companyId, id),
          eq(facilities.companyId, id),
        ),
      ),
    db
      .select({
        observation: observations,
        evidenceRow: evidence,
        document: sourceDocuments,
        source: dataSources,
        canonicalId: canonicalFacts.id,
      })
      .from(observations)
      .innerJoin(evidence, eq(evidence.id, observations.evidenceId))
      .innerJoin(
        sourceDocuments,
        eq(sourceDocuments.id, evidence.sourceDocumentId),
      )
      .innerJoin(dataSources, eq(dataSources.id, sourceDocuments.dataSourceId))
      .leftJoin(
        canonicalFacts,
        eq(canonicalFacts.currentObservationId, observations.id),
      )
      .where(
        and(
          eq(observations.subjectType, "company"),
          eq(observations.subjectId, id),
        ),
      ),
    db
      .select()
      .from(canonicalFacts)
      .where(
        and(
          eq(canonicalFacts.subjectType, "company"),
          eq(canonicalFacts.subjectId, id),
        ),
      ),
    db
      .select({
        dataSourceId: dataSources.id,
        name: dataSources.name,
        description: dataSources.notes,
        homepageUrl: dataSources.baseUrl,
        access: dataSources.access,
        ingestionMethod: dataSources.ingestion,
        relationship: companySourceLinks.relationship,
        externalKey: companySourceLinks.externalKey,
      })
      .from(companySourceLinks)
      .innerJoin(
        dataSources,
        eq(dataSources.id, companySourceLinks.dataSourceId),
      )
      .where(eq(companySourceLinks.companyId, id)),
  ]);
  const base = company(r as unknown as Record<string, unknown>);
  const researchGaps: string[] = [];
  if (!domains.length) researchGaps.push("No verified domains are recorded");
  if (!linkedSources.length)
    researchGaps.push("No data sources are explicitly linked");
  if (!observationRows.length)
    researchGaps.push("No evidence-backed observations are recorded");
  if (!canonicalRows.length)
    researchGaps.push("No canonical facts have been accepted");
  if (!facilityRows.length) researchGaps.push("No facilities are recorded");
  if (!capabilityRows.length && !facilityCapabilityRows.length)
    researchGaps.push("No capabilities are recorded");
  if (!qualificationLinks.length)
    researchGaps.push("No qualification links are recorded");
  const canonicalObservationIds = canonicalRows.map(
    (row) => row.currentObservationId,
  );
  const acceptedProposalsForObservations =
    canonicalObservationIds.length === 0
      ? []
      : await db
          .select({
            id: researchProposals.id,
            observationId: researchProposals.observationId,
          })
          .from(researchProposals)
          .where(
            and(
              inArray(researchProposals.observationId, canonicalObservationIds),
              eq(researchProposals.status, "accepted"),
            ),
          );
  const acceptedProposalByObservation = new Map(
    acceptedProposalsForObservations.map((row) => [row.observationId, row.id]),
  );
  const acceptedProposalIds = [
    ...new Set(
      [
        ...canonicalRows.map((row) => row.acceptedProposalId),
        ...acceptedProposalsForObservations.map((row) => row.id),
      ].filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  const reviewRows =
    acceptedProposalIds.length === 0
      ? []
      : await db
          .select()
          .from(proposalReviews)
          .where(
            and(
              inArray(proposalReviews.proposalId, acceptedProposalIds),
              eq(proposalReviews.decision, "accepted"),
            ),
          )
          .orderBy(desc(proposalReviews.createdAt));
  const latestReviewByProposal = new Map<
    string,
    (typeof reviewRows)[number]
  >();
  for (const review of reviewRows) {
    if (!latestReviewByProposal.has(review.proposalId)) {
      latestReviewByProposal.set(review.proposalId, review);
    }
  }
  const canonicalByObservation = new Map(
    canonicalRows.map((row) => [row.currentObservationId, row] as const),
  );
  return {
    ...base,
    aliases,
    domains,
    identifiers,
    facilities: facilityRows,
    contacts: contactRows,
    capabilities: capabilityRows,
    facilityCapabilities: facilityCapabilityRows,
    qualificationLinks,
    certifications: certificationRows.map(({ certification, facilityName }) => ({
      ...certification,
      facilityName,
    })),
    platformLinks: qualificationLinks,
    observations: observationRows.map(
      ({ observation, evidenceRow, document, source, canonicalId }) => {
        const canonical = canonicalByObservation.get(observation.id);
        const acceptedProposalId =
          canonical?.acceptedProposalId ??
          acceptedProposalByObservation.get(observation.id) ??
          null;
        const review =
          acceptedProposalId === null
            ? undefined
            : latestReviewByProposal.get(acceptedProposalId);
        return {
          ...observation,
          evidenceQuote: evidenceRow.quote,
          evidenceLocator: evidenceRow.locator,
          evidencePageNumber: evidenceRow.pageNumber,
          documentId: document.id,
          documentTitle: document.title,
          documentCanonicalUrl: document.canonicalUrl,
          dataSourceId: source.id,
          dataSourceName: source.name,
          isCanonical: canonicalId !== null,
          ...(canonical === undefined
            ? {}
            : {
                canonicalFactId: canonical.id,
                ...(acceptedProposalId === null
                  ? {}
                  : { acceptedProposalId }),
              }),
          ...(review === undefined
            ? {}
            : {
                reviewEventId: review.id,
                reviewDecision: review.decision,
                ...(review.reason ? { reviewReason: review.reason } : {}),
                reviewedAt: review.createdAt,
              }),
        };
      },
    ),
    canonicalFacts: canonicalRows,
    linkedSources: linkedSources.map((x) => ({ ...x, status: "active" })),
    researchGaps,
  };
}

export async function createCompanyAliasRecord(input: {
  companyId: string;
  alias: string;
  aliasType: "name" | "trade" | "abbreviation" | "former";
  isPrimary?: boolean;
}) {
  const alias = input.alias.trim();
  const db = getDatabase();
  return db.transaction(async (tx) => {
    const [company] = await tx
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, input.companyId))
      .limit(1);
    if (!company) throw new RepositoryNotFoundError("company", input.companyId);
    const [duplicate] = await tx
      .select({ id: companyAliases.id })
      .from(companyAliases)
      .where(
        and(
          eq(companyAliases.companyId, input.companyId),
          sql`lower(${companyAliases.alias}) = ${alias.toLowerCase()}`,
        ),
      )
      .limit(1);
    if (duplicate)
      throw new RepositoryConflictError(
        "That alias already exists for this company",
      );
    if (input.isPrimary === true) {
      await tx
        .update(companyAliases)
        .set({ isPrimary: false })
        .where(eq(companyAliases.companyId, input.companyId));
    }
    const values: {
      companyId: string;
      alias: string;
      aliasType: typeof input.aliasType;
      isPrimary?: boolean;
    } = {
      companyId: input.companyId,
      alias,
      aliasType: input.aliasType,
    };
    if (input.isPrimary !== undefined) values.isPrimary = input.isPrimary;
    const [row] = await tx.insert(companyAliases).values(values).returning();
    return row;
  });
}

export interface CreateResearchRunInput {
  targetType:
    | "data_source"
    | "company"
    | "platform"
    | "part"
    | "facility"
    | "qualification"
    | "contact";
  targetId?: string | null;
  requestedByUserId?: string | null;
  objective: string;
  requestedModel?: string;
  maxAttempts?: number;
  maxCostUsd?: number;
  metadata?: Record<string, unknown>;
  promptVersion?: string;
}
export function mapResearchRunInput(
  input: CreateResearchRunInput,
): typeof researchRuns.$inferInsert {
  const payload: Record<string, unknown> = {
    maxAttempts: input.maxAttempts ?? 3,
    metadata: input.metadata ?? {},
  };
  if (input.requestedModel !== undefined) {
    payload.requestedModel = input.requestedModel;
  }
  if (input.maxCostUsd !== undefined) {
    payload.maxCostUsd = input.maxCostUsd;
  }
  return {
    targetType: input.targetType,
    targetId: input.targetId ?? null,
    requestedByUserId: input.requestedByUserId ?? null,
    objective: input.objective,
    promptVersion:
      input.promptVersion ??
      (input.targetType === "company"
        ? "company-research-v1"
        : input.targetType === "platform"
          ? "platform-research-v1"
          : input.targetType === "part"
            ? "part-research-v1"
            : input.targetType === "data_source"
              ? "source-research-v1"
              : "discover-research-v1"),
    input: payload,
  };
}
export type ResearchRunRecord = typeof researchRuns.$inferSelect & {
  dataSourceId: string | null;
  targetLabel: string | null;
  requestedModel: string | null;
  maxAttempts: number;
  maxCostUsd: number | null;
  metadata: Record<string, unknown>;
  progress: number;
  error?: Readonly<{ code: string | null; message: string | null }>;
  actualCostUsd: number;
  dailyActualCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  proposalCount: number;
  pendingProposalCount: number;
  acceptedProposalCount: number;
  rejectedProposalCount: number;
  documentCount: number;
};
function runSelect() {
  return {
    ...getTableColumns(researchRuns),
    targetLabel: sql<
      string | null
    >`case when ${researchRuns.targetType}='data_source' then (select name from ${dataSources} where id=${researchRuns.targetId}) when ${researchRuns.targetType}='company' then (select legal_name from ${companies} where id=${researchRuns.targetId}) when ${researchRuns.targetType}='platform' then (select name from ${platforms} where id=${researchRuns.targetId}) when ${researchRuns.targetType}='part' then (select coalesce(name, part_number) from ${parts} where id=${researchRuns.targetId}) when ${researchRuns.targetType}='facility' then (select name from ${facilities} where id=${researchRuns.targetId}) else null end`,
    actualCostUsd: sql<number>`coalesce((select sum(cost_usd) from ${modelUsage} where research_run_id=${qualifiedResearchRunId}),0)`,
    dailyActualCostUsd: sql<number>`coalesce((select sum(cost_usd) from ${modelUsage} where created_at>=date_trunc('day',now())),0)`,
    inputTokens: sql<number>`coalesce((select sum(input_tokens) from ${modelUsage} where research_run_id=${qualifiedResearchRunId}),0)`,
    outputTokens: sql<number>`coalesce((select sum(output_tokens) from ${modelUsage} where research_run_id=${qualifiedResearchRunId}),0)`,
    proposalCount: sql<number>`(select count(*) from ${researchProposals} where research_run_id=${qualifiedResearchRunId})`,
    pendingProposalCount: sql<number>`(select count(*) from ${researchProposals} where research_run_id=${qualifiedResearchRunId} and status='pending')`,
    acceptedProposalCount: sql<number>`(select count(*) from ${researchProposals} where research_run_id=${qualifiedResearchRunId} and status='accepted')`,
    rejectedProposalCount: sql<number>`(select count(*) from ${researchProposals} where research_run_id=${qualifiedResearchRunId} and status='rejected')`,
    documentCount: sql<number>`(select count(distinct d.id) from ${sourceDocuments} d where d.metadata->>'researchRunId'=${qualifiedResearchRunId}::text or exists (select 1 from research_tool_calls t where t.research_run_id=${qualifiedResearchRunId} and t.response->>'finalUrl'=d.canonical_url))`,
  };
}
function run(r: Record<string, unknown>): ResearchRunRecord {
  const i = obj(r.input);
  const error =
    r.errorCode === null && r.errorMessage === null
      ? {}
      : {
          error: {
            code: typeof r.errorCode === "string" ? r.errorCode : null,
            message: typeof r.errorMessage === "string" ? r.errorMessage : null,
          },
        };
  return {
    ...(r as unknown as ResearchRunRecord),
    dataSourceId:
      r.targetType === "data_source" ? (r.targetId as string | null) : null,
    targetLabel: typeof r.targetLabel === "string" ? r.targetLabel : null,
    requestedModel:
      typeof i.requestedModel === "string" ? i.requestedModel : null,
    maxAttempts: n(i.maxAttempts || 3),
    maxCostUsd: i.maxCostUsd === undefined ? null : n(i.maxCostUsd),
    metadata: obj(i.metadata),
    progress: n(r.progressPercent) / 100,
    ...error,
    actualCostUsd: n(r.actualCostUsd),
    dailyActualCostUsd: n(r.dailyActualCostUsd),
    inputTokens: n(r.inputTokens),
    outputTokens: n(r.outputTokens),
    proposalCount: n(r.proposalCount),
    pendingProposalCount: n(r.pendingProposalCount),
    acceptedProposalCount: n(r.acceptedProposalCount),
    rejectedProposalCount: n(r.rejectedProposalCount),
    documentCount: n(r.documentCount),
  };
}
export async function createResearchRunRecord(input: CreateResearchRunInput) {
  const db = getDatabase();
  if (input.targetId) {
    if (input.targetType === "data_source") {
      const [s] = await db
        .select({ id: dataSources.id })
        .from(dataSources)
        .where(eq(dataSources.id, input.targetId))
        .limit(1);
      if (!s) throw new RepositoryNotFoundError("data_source", input.targetId);
    } else if (input.targetType === "company") {
      const [c] = await db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, input.targetId))
        .limit(1);
      if (!c) throw new RepositoryNotFoundError("company", input.targetId);
    } else if (input.targetType === "platform") {
      const [row] = await db
        .select({ id: platforms.id })
        .from(platforms)
        .where(eq(platforms.id, input.targetId))
        .limit(1);
      if (!row) throw new RepositoryNotFoundError("platform", input.targetId);
    } else if (input.targetType === "part") {
      const [row] = await db
        .select({ id: parts.id })
        .from(parts)
        .where(eq(parts.id, input.targetId))
        .limit(1);
      if (!row) throw new RepositoryNotFoundError("part", input.targetId);
    } else if (input.targetType === "facility") {
      const [row] = await db
        .select({ id: facilities.id })
        .from(facilities)
        .where(eq(facilities.id, input.targetId))
        .limit(1);
      if (!row) throw new RepositoryNotFoundError("facility", input.targetId);
    }
  }
  const [r] = await db
    .insert(researchRuns)
    .values(mapResearchRunInput(input))
    .returning({ id: researchRuns.id });
  if (!r) throw new Error("Research run insert returned no row");
  const result = await getResearchRunRecord(r.id);
  if (!result) throw new RepositoryNotFoundError("research_run", r.id);
  return result;
}
export async function getResearchRunRecord(
  id: string,
): Promise<ResearchRunRecord | null> {
  const [r] = await getDatabase()
    .select(runSelect())
    .from(researchRuns)
    .where(eq(researchRuns.id, id))
    .limit(1);
  return r ? run(r as unknown as Record<string, unknown>) : null;
}
export async function listResearchRunRecords(
  input: PageInput & {
    status?: ResearchRunStatus;
    targetType?: typeof researchRuns.$inferSelect.targetType;
  },
): Promise<PageResult<ResearchRunRecord>> {
  const { page, pageSize, offset } = normalizePagination(input);
  const f: SQL[] = [];
  if (input.status) f.push(eq(researchRuns.status, input.status));
  if (input.targetType) f.push(eq(researchRuns.targetType, input.targetType));
  const w = f.length ? and(...f) : undefined;
  const db = getDatabase();
  const [rows, c] = await Promise.all([
    db
      .select(runSelect())
      .from(researchRuns)
      .where(w)
      .orderBy(desc(researchRuns.createdAt))
      .limit(pageSize)
      .offset(offset),
    db
      .select({ v: sql<number>`count(*)` })
      .from(researchRuns)
      .where(w),
  ]);
  return {
    records: rows.map((r) => run(r as unknown as Record<string, unknown>)),
    page,
    pageSize,
    total: n(c[0]?.v),
  };
}
export interface ResearchRunStateInput {
  status: ResearchRunStatus;
  expectedStatus: ResearchRunStatus;
  progressPercent?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  metadata?: Record<string, unknown>;
}
export function assertExpectedResearchRunStatus(
  current: ResearchRunStatus,
  expected: ResearchRunStatus,
) {
  if (current !== expected)
    throw new RepositoryConflictError(
      `Research run status conflict: expected ${expected}, found ${current}`,
    );
}
export function mergeResearchRunInput(
  input: Record<string, unknown>,
  metadata?: Record<string, unknown>,
) {
  if (!metadata) return input;
  const current = obj(input.metadata);
  const replay =
    metadata.replay === undefined
      ? current.replay
      : { ...obj(current.replay), ...obj(metadata.replay) };
  return {
    ...input,
    metadata: {
      ...current,
      ...metadata,
      ...(replay === undefined ? {} : { replay }),
    },
  };
}
export async function setResearchRunState(
  id: string,
  change: ResearchRunStateInput,
) {
  const db = getDatabase();
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(researchRuns)
      .where(eq(researchRuns.id, id))
      .limit(1);
    if (!current) throw new RepositoryNotFoundError("research_run", id);
    assertExpectedResearchRunStatus(current.status, change.expectedStatus);
    const next = deriveResearchRunState(
      {
        status: current.status,
        progressPercent:
          current.progressPercent === null ? null : n(current.progressPercent),
        startedAt: current.startedAt,
        completedAt: current.completedAt,
        errorCode: current.errorCode,
        errorMessage: current.errorMessage,
      },
      change,
    );
    const [u] = await tx
      .update(researchRuns)
      .set({
        status: next.status,
        progressPercent: String(next.progressPercent),
        startedAt: next.startedAt,
        completedAt: next.completedAt,
        errorCode: next.errorCode,
        errorMessage: next.errorMessage,
        input: mergeResearchRunInput(current.input, change.metadata),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(researchRuns.id, id),
          eq(researchRuns.status, change.expectedStatus),
        ),
      )
      .returning({ id: researchRuns.id });
    if (!u)
      throw new RepositoryConflictError(
        `Research run ${id} changed concurrently`,
      );
  });
  const r = await getResearchRunRecord(id);
  if (!r) throw new RepositoryNotFoundError("research_run", id);
  return r;
}

export type SourceDocumentListRecord = {
  id: string;
  dataSourceId: string;
  canonicalUrl: string | null;
  title: string | null;
  documentType: string | null;
  publishedOn: string | null;
  retrievedAt: Date;
  contentSha256: string | null;
  mimeType: string | null;
  byteLength: number | null;
  languageCode: string | null;
};

export async function listSourceDocumentRecords(
  dataSourceId: string,
): Promise<SourceDocumentListRecord[]> {
  return getDatabase()
    .select({
      id: sourceDocuments.id,
      dataSourceId: sourceDocuments.dataSourceId,
      canonicalUrl: sourceDocuments.canonicalUrl,
      title: sourceDocuments.title,
      documentType: sourceDocuments.documentType,
      publishedOn: sourceDocuments.publishedOn,
      retrievedAt: sourceDocuments.retrievedAt,
      contentSha256: sourceDocuments.contentSha256,
      mimeType: sourceDocuments.mimeType,
      byteLength: sourceDocuments.byteLength,
      languageCode: sourceDocuments.languageCode,
    })
    .from(sourceDocuments)
    .where(eq(sourceDocuments.dataSourceId, dataSourceId))
    .orderBy(desc(sourceDocuments.retrievedAt), desc(sourceDocuments.id));
}
