import { eq, ilike, or, sql } from "drizzle-orm";

import { searchContains } from "./search.js";

import { getDatabase } from "./client.js";
import {
  canonicalFacts,
  companies,
  companyDomains,
  dataSources,
  evidence,
  facilities,
  facilityQualifications,
  imports,
  observations,
  parts,
  platforms,
  capabilities,
  certifications,
  contracts,
  researchRuns,
  sourceDocuments,
  subsystems,
} from "./schema.js";

const qualifiedCompanyId = sql.raw('"companies"."id"');
const qualifiedDataSourceId = sql.raw('"data_sources"."id"');

const n = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const parseNullableScore = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export interface SourceScoreInputRecord {
  readonly subjectId: string;
  readonly access: "public" | "authorized" | "restricted_metadata_only";
  readonly hasPublisher: boolean;
  readonly documentCount: number;
  readonly evidenceCount: number;
  readonly acceptedObservationCount: number;
  readonly rejectedObservationCount: number;
  readonly latestRetrievedAt: Date | null;
  readonly persistedReliability: number | null;
  readonly persistedFreshness: number | null;
  readonly persistedAuthority: number | null;
}

export interface SupplierScoreInputRecord {
  readonly subjectId: string;
  readonly hasLegalName: boolean;
  readonly hasWebsite: boolean;
  readonly hasCountry: boolean;
  readonly hasDomain: boolean;
  readonly observationCount: number;
  readonly canonicalFactCount: number;
  readonly evidenceCount: number;
  readonly qualificationCount: number;
  readonly qualificationsWithPlatform: number;
  readonly qualificationsWithCustomer: number;
  readonly latestObservationAt: Date | null;
  readonly hasCompletedResearch: boolean;
}

export async function getSourceScoreInputs(
  id: string,
): Promise<SourceScoreInputRecord | null> {
  const db = getDatabase();
  const [row] = await db
    .select({
      id: dataSources.id,
      access: dataSources.access,
      publisher: dataSources.publisher,
      reliabilityScore: dataSources.reliabilityScore,
      freshnessScore: dataSources.freshnessScore,
      authorityScore: dataSources.authorityScore,
      documentCount: sql<number>`(select count(*) from ${sourceDocuments} where data_source_id = ${qualifiedDataSourceId})`,
      evidenceCount: sql<number>`(select count(*) from ${evidence} e join ${sourceDocuments} d on d.id = e.source_document_id where d.data_source_id = ${qualifiedDataSourceId})`,
      acceptedObservationCount: sql<number>`(select count(*) from ${observations} o join ${evidence} e on e.id = o.evidence_id join ${sourceDocuments} d on d.id = e.source_document_id where d.data_source_id = ${qualifiedDataSourceId} and o.review_status = 'accepted')`,
      rejectedObservationCount: sql<number>`(select count(*) from ${observations} o join ${evidence} e on e.id = o.evidence_id join ${sourceDocuments} d on d.id = e.source_document_id where d.data_source_id = ${qualifiedDataSourceId} and o.review_status = 'rejected')`,
      latestRetrievedAt: sql<Date | null>`(select max(retrieved_at) from ${sourceDocuments} where data_source_id = ${qualifiedDataSourceId})`,
    })
    .from(dataSources)
    .where(eq(dataSources.id, id))
    .limit(1);
  if (!row) return null;
  return {
    subjectId: row.id,
    access: row.access,
    hasPublisher: typeof row.publisher === "string" && row.publisher.trim() !== "",
    documentCount: n(row.documentCount),
    evidenceCount: n(row.evidenceCount),
    acceptedObservationCount: n(row.acceptedObservationCount),
    rejectedObservationCount: n(row.rejectedObservationCount),
    latestRetrievedAt: row.latestRetrievedAt,
    persistedReliability: parseNullableScore(row.reliabilityScore),
    persistedFreshness: parseNullableScore(row.freshnessScore),
    persistedAuthority: parseNullableScore(row.authorityScore),
  };
}

export async function getSupplierScoreInputs(
  id: string,
): Promise<SupplierScoreInputRecord | null> {
  const db = getDatabase();
  const [row] = await db
    .select({
      id: companies.id,
      legalName: companies.legalName,
      websiteUrl: companies.websiteUrl,
      headquartersCountryCode: companies.headquartersCountryCode,
      domainCount: sql<number>`(select count(*) from ${companyDomains} where company_id = ${qualifiedCompanyId})`,
      observationCount: sql<number>`(select count(*) from ${observations} where subject_type = 'company' and subject_id = ${qualifiedCompanyId})`,
      canonicalFactCount: sql<number>`(select count(*) from ${canonicalFacts} where subject_type = 'company' and subject_id = ${qualifiedCompanyId})`,
      evidenceCount: sql<number>`(select count(distinct o.evidence_id) from ${observations} o where o.subject_type = 'company' and o.subject_id = ${qualifiedCompanyId})`,
      qualificationCount: sql<number>`(select count(*) from ${facilityQualifications} q join ${facilities} f on f.id = q.facility_id where f.company_id = ${qualifiedCompanyId})`,
      qualificationsWithPlatform: sql<number>`(select count(*) from ${facilityQualifications} q join ${facilities} f on f.id = q.facility_id where f.company_id = ${qualifiedCompanyId} and q.platform_id is not null)`,
      qualificationsWithCustomer: sql<number>`(select count(*) from ${facilityQualifications} q join ${facilities} f on f.id = q.facility_id where f.company_id = ${qualifiedCompanyId} and q.customer_company_id is not null)`,
      latestObservationAt: sql<Date | null>`(select max(created_at) from ${observations} where subject_type = 'company' and subject_id = ${qualifiedCompanyId})`,
      completedResearchCount: sql<number>`(select count(*) from ${researchRuns} where target_type = 'company' and target_id = ${qualifiedCompanyId} and status = 'succeeded')`,
    })
    .from(companies)
    .where(eq(companies.id, id))
    .limit(1);
  if (!row) return null;
  return {
    subjectId: row.id,
    hasLegalName: row.legalName.trim() !== "",
    hasWebsite: typeof row.websiteUrl === "string" && row.websiteUrl.trim() !== "",
    hasCountry:
      typeof row.headquartersCountryCode === "string" &&
      row.headquartersCountryCode.trim() !== "",
    hasDomain: n(row.domainCount) > 0,
    observationCount: n(row.observationCount),
    canonicalFactCount: n(row.canonicalFactCount),
    evidenceCount: n(row.evidenceCount),
    qualificationCount: n(row.qualificationCount),
    qualificationsWithPlatform: n(row.qualificationsWithPlatform),
    qualificationsWithCustomer: n(row.qualificationsWithCustomer),
    latestObservationAt: row.latestObservationAt,
    hasCompletedResearch: n(row.completedResearchCount) > 0,
  };
}

export async function getCatalogCoverageCounts(): Promise<{
  facilityCount: number;
  platformCount: number;
  partCount: number;
  qualificationCount: number;
  importCount: number;
  capabilityCount: number;
  certificationCount: number;
  subsystemCount: number;
  customerCount: number;
}> {
  const db = getDatabase();
  const [
    facility,
    platform,
    part,
    qualification,
    importCount,
    capability,
    certification,
    subsystem,
    customer,
  ] = await Promise.all([
    db.select({ value: sql<number>`count(*)` }).from(facilities),
    db.select({ value: sql<number>`count(*)` }).from(platforms),
    db.select({ value: sql<number>`count(*)` }).from(parts),
    db.select({ value: sql<number>`count(*)` }).from(facilityQualifications),
    db.select({ value: sql<number>`count(*)` }).from(imports),
    db.select({ value: sql<number>`count(*)` }).from(capabilities),
    db.select({ value: sql<number>`count(*)` }).from(certifications),
    db.select({ value: sql<number>`count(*)` }).from(subsystems),
    db
      .select({ value: sql<number>`count(*)` })
      .from(companies)
      .where(
        sql`(
          exists (select 1 from ${facilityQualifications} where ${facilityQualifications.customerCompanyId} = ${sql.raw('"companies"."id"')})
          or exists (select 1 from ${contracts} where ${contracts.customerCompanyId} = ${sql.raw('"companies"."id"')})
        )`,
      ),
  ]);
  return {
    facilityCount: n(facility[0]?.value),
    platformCount: n(platform[0]?.value),
    partCount: n(part[0]?.value),
    qualificationCount: n(qualification[0]?.value),
    importCount: n(importCount[0]?.value),
    capabilityCount: n(capability[0]?.value),
    certificationCount: n(certification[0]?.value),
    subsystemCount: n(subsystem[0]?.value),
    customerCount: n(customer[0]?.value),
  };
}

export async function findLocalDiscoveries(input: {
  readonly seedTerms: readonly string[];
  readonly targetTypes: readonly string[];
  readonly limit?: number;
}): Promise<
  readonly {
    readonly type: string;
    readonly id: string;
    readonly label: string;
    readonly matchedOn: string;
  }[]
> {
  const terms = input.seedTerms
    .filter((term) => term.trim().length > 0 && !/^https?:\/\//iu.test(term))
    .map((term) => searchContains(term))
    .filter((term): term is string => term !== undefined)
    .slice(0, 20);
  if (terms.length === 0) return [];

  const limit = input.limit ?? 25;
  const db = getDatabase();
  const matches: Array<{
    type: string;
    id: string;
    label: string;
    matchedOn: string;
  }> = [];

  if (input.targetTypes.includes("company")) {
    const filters = terms.flatMap((term) => [
      ilike(companies.legalName, term),
      ilike(companies.displayName, term),
    ]);
    const rows = await db
      .select({
        id: companies.id,
        displayName: companies.displayName,
      })
      .from(companies)
      .where(or(...filters))
      .limit(limit);
    for (const row of rows) {
      matches.push({
        type: "company",
        id: row.id,
        label: row.displayName,
        matchedOn: "name",
      });
    }
  }

  if (input.targetTypes.includes("data_source")) {
    const filters = terms.map((term) => ilike(dataSources.name, term));
    const rows = await db
      .select({ id: dataSources.id, name: dataSources.name })
      .from(dataSources)
      .where(or(...filters))
      .limit(limit);
    for (const row of rows) {
      matches.push({
        type: "data_source",
        id: row.id,
        label: row.name,
        matchedOn: "name",
      });
    }
  }

  if (input.targetTypes.includes("platform")) {
    const filters = terms.map((term) => ilike(platforms.name, term));
    const rows = await db
      .select({ id: platforms.id, name: platforms.name })
      .from(platforms)
      .where(or(...filters))
      .limit(limit);
    for (const row of rows) {
      matches.push({
        type: "platform",
        id: row.id,
        label: row.name,
        matchedOn: "name",
      });
    }
  }

  if (input.targetTypes.includes("part")) {
    const filters = terms.flatMap((term) => [
      ilike(parts.partNumber, term),
      ilike(parts.name, term),
    ]);
    const rows = await db
      .select({ id: parts.id, partNumber: parts.partNumber, name: parts.name })
      .from(parts)
      .where(or(...filters))
      .limit(limit);
    for (const row of rows) {
      matches.push({
        type: "part",
        id: row.id,
        label: row.name ?? row.partNumber,
        matchedOn: "part_number",
      });
    }
  }

  return matches.slice(0, limit);
}
