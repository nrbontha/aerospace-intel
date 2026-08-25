import { createHash } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import type { Database } from "../client.js";
import { inferObservationValueKind } from "../provenance.js";
import {
  auditEvents,
  companyIdentifiers,
  companySourceLinks,
  dataSources,
  evidence,
  facilities,
  observations,
  researchProposals,
  researchRuns,
  sourceDocumentLinks,
  sourceDocuments,
  sourceSignals,
} from "../schema.js";

export interface SamNaicsValue {
  readonly code: string;
  readonly description: string | null;
  readonly sbaSmallBusiness: boolean | null;
}

export interface SamPscValue {
  readonly code: string;
  readonly description: string | null;
}

/** Provider-normalized SAM Entity Management v4 record. */
export interface SamEntityForSynthesis {
  readonly legalName: string;
  readonly uei: string;
  readonly cageCode: string | null;
  readonly officialUrl: string | null;
  readonly officialDomain?: string | null;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly zip: string | null;
  readonly country: string | null;
  readonly registrationStatus: string | null;
  readonly exclusionStatusFlag: boolean | null;
  readonly primaryNaics: SamNaicsValue | null;
  readonly naics: readonly SamNaicsValue[];
  readonly psc: readonly SamPscValue[];
  readonly entityTypeHints: readonly string[];
  readonly businessTypeHints: readonly string[];
  readonly ownershipHints: readonly string[];
  readonly parentUei: string | null;
  readonly sourceLocator: string;
  readonly raw: Record<string, unknown>;
}

export interface SynthesisSourceContext {
  readonly sourceSignalId?: string;
  readonly canonicalUrl?: string;
  readonly retrievedAt?: Date | string;
  readonly actorUserId?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface SamPersistenceResult {
  readonly sourceDocumentId: string;
  readonly facilityId: string | null;
  readonly created: {
    readonly document: boolean;
    readonly facility: boolean;
    readonly observations: number;
  };
  readonly reused: {
    readonly document: boolean;
    readonly facility: boolean;
    readonly observations: number;
  };
}

export interface SynthesisConflictDetail {
  readonly identifierType: "uei" | "cage" | "faa_pma_holder";
  readonly identifierValue: string;
  readonly existingCompanyId: string;
  readonly requestedCompanyId: string;
}

export class SynthesisConflictError extends Error {
  override readonly name = "SynthesisConflictError";
  readonly code = "SYNTHESIS_IDENTIFIER_CONFLICT";
  readonly statusCode = 409;

  constructor(readonly conflict: SynthesisConflictDetail) {
    super(
      `${conflict.identifierType.toUpperCase()} ${conflict.identifierValue} already belongs to company ${conflict.existingCompanyId}`,
    );
  }
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type MaterialObservation = {
  readonly subjectType: string;
  readonly subjectId: string;
  readonly fieldKey: string;
  readonly value: unknown;
  readonly quote: string;
  readonly confidence?: number;
};

type TransactionOutcome =
  | { readonly kind: "ok"; readonly result: SamPersistenceResult }
  | { readonly kind: "conflict"; readonly conflict: SynthesisConflictDetail };

/**
 * Materialize a SAM entity as a reviewable source graph. Identity assignment is
 * guarded by the strongest exact identifier and never transfers an identifier.
 */
export async function persistSamEntityForCompany(
  db: Database,
  companyId: string,
  entity: SamEntityForSynthesis,
  sourceContext: SynthesisSourceContext = {},
): Promise<SamPersistenceResult> {
  const uei = normalizeIdentifier(entity.uei);
  if (uei === null) throw new Error("SAM entity UEI is required");
  const cage = normalizeIdentifier(entity.cageCode);
  const lockKey = `company-identifier:uei:${uei}`;

  const outcome = await db.transaction<TransactionOutcome>(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

    for (const identifier of [
      { type: "uei" as const, value: uei },
      ...(cage === null ? [] : [{ type: "cage" as const, value: cage }]),
    ]) {
      const conflict = await findIdentifierConflict(
        tx,
        companyId,
        identifier.type,
        identifier.value,
      );
      if (conflict !== null) {
        await recordIdentifierConflict(tx, conflict, sourceContext);
        return { kind: "conflict", conflict };
      }
    }

    for (const identifier of [
      { type: "uei" as const, value: uei },
      ...(cage === null ? [] : [{ type: "cage" as const, value: cage }]),
    ]) {
      const racedConflict = await ensureCompanyIdentifier(
        tx,
        companyId,
        identifier.type,
        identifier.value,
      );
      if (racedConflict !== null) {
        await recordIdentifierConflict(tx, racedConflict, sourceContext);
        return { kind: "conflict", conflict: racedConflict };
      }
    }

    const dataSourceId = await upsertSamDataSource(tx);
    const locator = sourceContext.canonicalUrl ?? entity.sourceLocator;
    const contentSha256 = sha256(stableJson(entity.raw));
    const document = await upsertSourceDocument(tx, {
      dataSourceId,
      canonicalUrl: locator,
      contentSha256,
      ...(sourceContext.retrievedAt === undefined
        ? {}
        : { retrievedAt: sourceContext.retrievedAt }),
      metadata: {
        sourceKey: "sam_entity",
        uei,
        sourceLocator: entity.sourceLocator,
        ...sourceContext.metadata,
      },
    });

    await tx
      .insert(companySourceLinks)
      .values({
        dataSourceId,
        companyId,
        relationship: "identifies",
        externalKey: uei,
      })
      .onConflictDoNothing();
    await linkDocument(tx, document.id, { companyId }, "identifies");

    const facility = await upsertRegisteredFacility(tx, companyId, entity);
    if (facility.id !== null) {
      await linkDocument(
        tx,
        document.id,
        { facilityId: facility.id },
        "registered_address",
      );
    }

    const researchRunId = await ensureSynthesisRun(
      tx,
      document.id,
      companyId,
      "sam_entity",
    );
    const claims: MaterialObservation[] = [
      claim("company", companyId, "legal_name", entity.legalName),
      claim("company", companyId, "identifier.uei", uei),
      ...(cage === null
        ? []
        : [claim("company", companyId, "identifier.cage", cage)]),
      ...(entity.officialUrl === null
        ? []
        : [
            claim(
              "company",
              companyId,
              "entity_url_unverified",
              entity.officialUrl,
            ),
          ]),
      ...(facility.id === null
        ? []
        : [
            {
              subjectType: "facility",
              subjectId: facility.id,
              fieldKey: "registered_address",
              value: facility.address,
              quote: formatValue(facility.address),
              confidence: 1,
            },
          ]),
      ...(entity.registrationStatus === null
        ? []
        : [
            claim(
              "company",
              companyId,
              "sam.registration_status",
              entity.registrationStatus,
            ),
          ]),
      ...(entity.exclusionStatusFlag === null
        ? []
        : [
            claim(
              "company",
              companyId,
              "sam.exclusion_status",
              entity.exclusionStatusFlag,
            ),
          ]),
      ...(entity.primaryNaics === null
        ? []
        : [
            claim(
              "company",
              companyId,
              "sam.primary_naics",
              entity.primaryNaics,
            ),
          ]),
      claim("company", companyId, "sam.naics", entity.naics),
      claim("company", companyId, "sam.psc", entity.psc),
      claim("company", companyId, "sam.entity_types", entity.entityTypeHints),
      claim("company", companyId, "sam.business_types", entity.businessTypeHints),
      claim("company", companyId, "sam.ownership_types", entity.ownershipHints),
      ...(entity.parentUei === null
        ? []
        : [
            claim(
              "company",
              companyId,
              "sam.parent_uei",
              normalizeIdentifier(entity.parentUei) ?? entity.parentUei,
            ),
          ]),
    ];

    let createdObservations = 0;
    let reusedObservations = 0;
    for (const material of claims) {
      const created = await ensurePendingProposal(
        tx,
        document.id,
        researchRunId,
        material,
        entity.sourceLocator,
      );
      if (created) createdObservations += 1;
      else reusedObservations += 1;
    }

    return {
      kind: "ok",
      result: {
        sourceDocumentId: document.id,
        facilityId: facility.id,
        created: {
          document: document.created,
          facility: facility.created,
          observations: createdObservations,
        },
        reused: {
          document: !document.created,
          facility: facility.id !== null && !facility.created,
          observations: reusedObservations,
        },
      },
    };
  });

  if (outcome.kind === "conflict") throw new SynthesisConflictError(outcome.conflict);
  return outcome.result;
}

function claim(
  subjectType: string,
  subjectId: string,
  fieldKey: string,
  value: unknown,
): MaterialObservation {
  return {
    subjectType,
    subjectId,
    fieldKey,
    value,
    quote: formatValue(value),
    confidence: 1,
  };
}

async function findIdentifierConflict(
  tx: Tx,
  companyId: string,
  type: "uei" | "cage" | "faa_pma_holder",
  value: string,
): Promise<SynthesisConflictDetail | null> {
  const [existing] = await tx
    .select({ companyId: companyIdentifiers.companyId })
    .from(companyIdentifiers)
    .where(
      and(
        eq(companyIdentifiers.type, type),
        sql`upper(btrim(${companyIdentifiers.value})) = ${value}`,
      ),
    )
    .limit(1);
  if (existing === undefined || existing.companyId === companyId) return null;
  return {
    identifierType: type,
    identifierValue: value,
    existingCompanyId: existing.companyId,
    requestedCompanyId: companyId,
  };
}

async function ensureCompanyIdentifier(
  tx: Tx,
  companyId: string,
  type: "uei" | "cage" | "faa_pma_holder",
  value: string,
): Promise<SynthesisConflictDetail | null> {
  await tx
    .insert(companyIdentifiers)
    .values({ companyId, type, value })
    .onConflictDoNothing();
  return findIdentifierConflict(tx, companyId, type, value);
}

async function recordIdentifierConflict(
  tx: Tx,
  conflict: SynthesisConflictDetail,
  context: SynthesisSourceContext,
): Promise<void> {
  const now = new Date();
  if (context.sourceSignalId !== undefined) {
    await tx
      .update(sourceSignals)
      .set({
        status: "quarantined",
        qualification: sql`${sourceSignals.qualification} || ${JSON.stringify({
          synthesisConflict: conflict,
          quarantinedAt: now.toISOString(),
        })}::jsonb`,
        updatedAt: now,
      })
      .where(eq(sourceSignals.id, context.sourceSignalId));
  }
  await tx.insert(auditEvents).values({
    actorUserId: context.actorUserId,
    action: "synthesis.identifier_conflict",
    entityType: "company",
    entityId: conflict.requestedCompanyId,
    after: conflict,
    metadata: {
      sourceSignalId: context.sourceSignalId ?? null,
      quarantined: context.sourceSignalId !== undefined,
    },
  });
}

async function upsertSamDataSource(tx: Tx): Promise<string> {
  const [inserted] = await tx
    .insert(dataSources)
    .values({
      name: "SAM.gov Entity Management API v4",
      sourceType: "government_registry",
      baseUrl: "https://api.sam.gov/entity-information/v4/entities",
      access: "public",
      ingestion: "api",
      publisher: "U.S. General Services Administration",
      jurisdiction: "US",
      reliabilityScore: "100",
      authorityScore: "100",
    })
    .onConflictDoNothing()
    .returning({ id: dataSources.id });
  if (inserted !== undefined) return inserted.id;
  const [existing] = await tx
    .select({ id: dataSources.id })
    .from(dataSources)
    .where(
      and(
        sql`lower(${dataSources.name}) = lower(${"SAM.gov Entity Management API v4"})`,
        eq(dataSources.publisher, "U.S. General Services Administration"),
      ),
    )
    .limit(1);
  if (existing === undefined) throw new Error("Unable to upsert SAM data source");
  return existing.id;
}

async function upsertSourceDocument(
  tx: Tx,
  input: {
    dataSourceId: string;
    canonicalUrl: string;
    contentSha256: string;
    retrievedAt?: Date | string;
    metadata: Record<string, unknown>;
  },
): Promise<{ readonly id: string; readonly created: boolean }> {
  const [existing] = await tx
    .select({ id: sourceDocuments.id })
    .from(sourceDocuments)
    .where(
      sql`${sourceDocuments.contentSha256} = ${input.contentSha256} OR (${sourceDocuments.dataSourceId} = ${input.dataSourceId} AND ${sourceDocuments.canonicalUrl} = ${input.canonicalUrl})`,
    )
    .limit(1);
  if (existing !== undefined) return { id: existing.id, created: false };
  const retrievedAt = parseDate(input.retrievedAt);
  const [inserted] = await tx
    .insert(sourceDocuments)
    .values({
      dataSourceId: input.dataSourceId,
      canonicalUrl: input.canonicalUrl,
      title: `SAM Entity ${String(input.metadata.uei)}`,
      documentType: "sam_entity_v4",
      contentSha256: input.contentSha256,
      mimeType: "application/json",
      retrievedAt,
      metadata: input.metadata,
    })
    .onConflictDoNothing()
    .returning({ id: sourceDocuments.id });
  if (inserted !== undefined) return { id: inserted.id, created: true };
  const [raced] = await tx
    .select({ id: sourceDocuments.id })
    .from(sourceDocuments)
    .where(
      sql`${sourceDocuments.contentSha256} = ${input.contentSha256} OR (${sourceDocuments.dataSourceId} = ${input.dataSourceId} AND ${sourceDocuments.canonicalUrl} = ${input.canonicalUrl})`,
    )
    .limit(1);
  if (raced === undefined) throw new Error("Unable to upsert SAM source document");
  return { id: raced.id, created: false };
}

async function upsertRegisteredFacility(
  tx: Tx,
  companyId: string,
  entity: SamEntityForSynthesis,
): Promise<{
  readonly id: string | null;
  readonly created: boolean;
  readonly address: Record<string, string | null>;
}> {
  const address = {
    addressLine1: normalizeText(entity.addressLine1),
    addressLine2: normalizeText(entity.addressLine2),
    city: normalizeText(entity.city),
    region: normalizeIdentifier(entity.state),
    postalCode: normalizePostalCode(entity.zip),
    countryCode: normalizeCountryCode(entity.country),
  };
  if (address.addressLine1 === null && address.city === null) {
    return { id: null, created: false, address };
  }
  const [existing] = await tx
    .select({ id: facilities.id })
    .from(facilities)
    .where(
      and(
        eq(facilities.companyId, companyId),
        sql`lower(btrim(coalesce(${facilities.addressLine1}, ''))) = lower(${address.addressLine1 ?? ""})`,
        sql`lower(btrim(coalesce(${facilities.addressLine2}, ''))) = lower(${address.addressLine2 ?? ""})`,
        sql`lower(btrim(coalesce(${facilities.city}, ''))) = lower(${address.city ?? ""})`,
        sql`lower(btrim(coalesce(${facilities.region}, ''))) = lower(${address.region ?? ""})`,
        sql`lower(btrim(coalesce(${facilities.postalCode}, ''))) = lower(${address.postalCode ?? ""})`,
        sql`upper(btrim(${facilities.countryCode})) = ${address.countryCode}`,
      ),
    )
    .limit(1);
  if (existing !== undefined) return { id: existing.id, created: false, address };
  const [inserted] = await tx
    .insert(facilities)
    .values({
      companyId,
      name: `${entity.legalName.trim()} Registered Address`,
      facilityType: "registered_address",
      ...address,
      countryCode: address.countryCode,
      status: "draft",
    })
    .onConflictDoNothing()
    .returning({ id: facilities.id });
  if (inserted !== undefined) return { id: inserted.id, created: true, address };
  const [raced] = await tx
    .select({ id: facilities.id })
    .from(facilities)
    .where(
      and(
        eq(facilities.companyId, companyId),
        sql`lower(btrim(coalesce(${facilities.addressLine1}, ''))) = lower(${address.addressLine1 ?? ""})`,
        sql`lower(btrim(coalesce(${facilities.city}, ''))) = lower(${address.city ?? ""})`,
        sql`lower(btrim(coalesce(${facilities.region}, ''))) = lower(${address.region ?? ""})`,
        sql`lower(btrim(coalesce(${facilities.postalCode}, ''))) = lower(${address.postalCode ?? ""})`,
        sql`upper(btrim(${facilities.countryCode})) = ${address.countryCode}`,
      ),
    )
    .limit(1);
  if (raced === undefined) throw new Error("Unable to upsert registered facility");
  return { id: raced.id, created: false, address };
}

async function ensureSynthesisRun(
  tx: Tx,
  sourceDocumentId: string,
  companyId: string,
  sourceKey: string,
): Promise<string> {
  const [existing] = await tx
    .select({ id: researchRuns.id })
    .from(researchRuns)
    .where(sql`${researchRuns.input}->>'sourceDocumentId' = ${sourceDocumentId}`)
    .limit(1);
  if (existing !== undefined) return existing.id;
  const now = new Date();
  const [inserted] = await tx
    .insert(researchRuns)
    .values({
      targetType: "company",
      targetId: companyId,
      status: "succeeded",
      objective: `Materialize qualified ${sourceKey} source evidence`,
      input: { sourceDocumentId, sourceKey },
      promptVersion: "deterministic-source-synthesis-v1",
      startedAt: now,
      completedAt: now,
      progressPercent: "100",
    })
    .returning({ id: researchRuns.id });
  if (inserted === undefined) throw new Error("Unable to create synthesis run");
  return inserted.id;
}

async function ensurePendingProposal(
  tx: Tx,
  sourceDocumentId: string,
  researchRunId: string,
  material: MaterialObservation,
  locator: string,
): Promise<boolean> {
  const synthesisKey = `${material.subjectType}:${material.subjectId}:${material.fieldKey}`;
  const [existing] = await tx
    .select({ id: observations.id })
    .from(observations)
    .innerJoin(evidence, eq(evidence.id, observations.evidenceId))
    .where(
      and(
        eq(evidence.sourceDocumentId, sourceDocumentId),
        sql`${evidence.metadata}->>'synthesisKey' = ${synthesisKey}`,
      ),
    )
    .limit(1);
  if (existing !== undefined) return false;

  const quote = material.quote.slice(0, 100_000);
  const [evidenceRow] = await tx
    .insert(evidence)
    .values({
      sourceDocumentId,
      extractionStatus: "completed",
      quote,
      locator,
      extractionMethod: "deterministic_source_adapter",
      contentSha256: sha256(quote),
      metadata: { synthesisKey, fieldKey: material.fieldKey },
    })
    .returning({ id: evidence.id });
  if (evidenceRow === undefined) throw new Error("Unable to append synthesis evidence");
  const [observation] = await tx
    .insert(observations)
    .values({
      subjectType: material.subjectType,
      subjectId: material.subjectId,
      fieldKey: material.fieldKey,
      valueKind: inferObservationValueKind(material.value),
      value: material.value,
      normalizedText: normalizedObservationText(material.value),
      confidence: String(material.confidence ?? 1),
      evidenceId: evidenceRow.id,
      reviewStatus: "pending",
      conflictStatus: "none",
    })
    .returning({ id: observations.id });
  if (observation === undefined) throw new Error("Unable to append synthesis observation");
  await tx.insert(researchProposals).values({
    researchRunId,
    observationId: observation.id,
    subjectType: material.subjectType,
    subjectId: material.subjectId,
    fieldKey: material.fieldKey,
    status: "pending",
    rationale: "Primary-source materialization requires grouped analyst acceptance",
  });
  return true;
}

async function linkDocument(
  tx: Tx,
  sourceDocumentId: string,
  target: { companyId?: string; facilityId?: string },
  relationship: string,
): Promise<void> {
  await tx
    .insert(sourceDocumentLinks)
    .values({ sourceDocumentId, relationship, ...target })
    .onConflictDoNothing();
}

function normalizeIdentifier(value: string | null | undefined): string | null {
  const normalized = value?.normalize("NFKC").trim().toLocaleUpperCase("en-US");
  return normalized === undefined || normalized === "" ? null : normalized;
}

function normalizeText(value: string | null | undefined): string | null {
  const normalized = value?.normalize("NFKC").trim().replace(/\s+/gu, " ");
  return normalized === undefined || normalized === "" ? null : normalized;
}

function normalizePostalCode(value: string | null | undefined): string | null {
  return normalizeText(value)?.toLocaleUpperCase("en-US") ?? null;
}

function normalizeCountryCode(value: string | null | undefined): string {
  const normalized = normalizeIdentifier(value);
  if (normalized === null) return "US";
  if (normalized === "USA" || normalized === "UNITED STATES") return "US";
  return normalized.slice(0, 2);
}

function normalizedObservationText(value: unknown): string | null {
  if (typeof value === "string") return normalizeText(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return stableJson(value);
}

function formatValue(value: unknown): string {
  return typeof value === "string" ? value : stableJson(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortJson(nested)]),
    );
  }
  return value;
}

function parseDate(value: Date | string | undefined): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}
