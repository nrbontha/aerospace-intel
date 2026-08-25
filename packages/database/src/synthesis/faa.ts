import { createHash } from "node:crypto";

import type { FaaPmaRecord } from "@asi/contracts";
import { and, eq, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import type { Database } from "../client.js";
import { inferObservationValueKind } from "../provenance.js";
import {
  auditEvents,
  companies,
  companyIdentifiers,
  companySourceLinks,
  dataSources,
  evidence,
  facilities,
  facilityQualifications,
  observations,
  partAlternateIds,
  parts,
  platforms,
  platformVariants,
  researchProposals,
  researchRuns,
  sourceDocumentLinks,
  sourceDocuments,
  sourceSignals,
} from "../schema.js";
import type {
  SynthesisConflictDetail,
  SynthesisSourceContext,
} from "./sam.js";

export interface FaaPersistenceCountSet {
  readonly documents: number;
  readonly facilities: number;
  readonly parts: number;
  readonly qualifications: number;
  readonly observations: number;
}

export interface FaaSynthesisGap {
  readonly recordId: string;
  readonly field: "facility" | "part" | "platform";
  readonly reason: string;
  readonly make?: string | null;
  readonly models?: readonly string[];
}

export interface FaaPersistenceResult {
  /** Counted per FAA record/document, not per graph row. */
  readonly createdCount: number;
  readonly reusedCount: number;
  readonly created: FaaPersistenceCountSet;
  readonly reused: FaaPersistenceCountSet;
  readonly conflicts: readonly SynthesisConflictDetail[];
  readonly gaps: readonly FaaSynthesisGap[];
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type FaaMaterial = {
  readonly subjectType: string;
  readonly subjectId: string;
  readonly fieldKey: string;
  readonly value: unknown;
  readonly quote: string;
};
type GraphTarget = {
  readonly companyId?: string;
  readonly facilityId?: string;
  readonly partId?: string;
  readonly platformId?: string;
  readonly platformVariantId?: string;
  readonly facilityQualificationId?: string;
};
type RecordOutcome =
  | {
      readonly kind: "ok";
      readonly documentCreated: boolean;
      readonly facilityPresent: boolean;
      readonly facilityCreated: boolean;
      readonly partPresent: boolean;
      readonly partCreated: boolean;
      readonly qualificationPresent: boolean;
      readonly qualificationCreated: boolean;
      readonly observationsCreated: number;
      readonly observationsReused: number;
      readonly gaps: readonly FaaSynthesisGap[];
    }
  | { readonly kind: "conflict"; readonly conflict: SynthesisConflictDetail };

/** Materialize each FAA card independently so one bad record cannot roll back peers. */
export async function persistFaaPmaRecordsForCompany(
  db: Database,
  companyId: string,
  records: readonly FaaPmaRecord[],
  sourceContext: SynthesisSourceContext = {},
): Promise<FaaPersistenceResult> {
  const created = emptyCounts();
  const reused = emptyCounts();
  const conflicts: SynthesisConflictDetail[] = [];
  const gaps: FaaSynthesisGap[] = [];
  let createdCount = 0;
  let reusedCount = 0;

  for (const record of records) {
    const outcome = await persistFaaRecord(
      db,
      companyId,
      record,
      sourceContext,
    );
    if (outcome.kind === "conflict") {
      conflicts.push(outcome.conflict);
      continue;
    }
    gaps.push(...outcome.gaps);
    if (outcome.documentCreated) {
      created.documents += 1;
      createdCount += 1;
    } else {
      reused.documents += 1;
      reusedCount += 1;
    }
    if (outcome.facilityCreated) created.facilities += 1;
    else if (outcome.facilityPresent) reused.facilities += 1;
    if (outcome.partCreated) created.parts += 1;
    else if (outcome.partPresent) reused.parts += 1;
    if (outcome.qualificationCreated) created.qualifications += 1;
    else if (outcome.qualificationPresent) reused.qualifications += 1;
    created.observations += outcome.observationsCreated;
    reused.observations += outcome.observationsReused;
  }

  return { createdCount, reusedCount, created, reused, conflicts, gaps };
}

async function persistFaaRecord(
  db: Database,
  companyId: string,
  record: FaaPmaRecord,
  context: SynthesisSourceContext,
): Promise<RecordOutcome> {
  const holderNumber = normalizeIdentifier(record.holderNumber);
  const lockIdentity = holderNumber ?? normalizeIdentifier(record.recordId)!;
  const lockKey = `faa-pma-record:${lockIdentity}:${normalizeIdentifier(record.recordId)}`;
  return db.transaction<RecordOutcome>(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

    if (holderNumber !== null) {
      const conflict = await findIdentifierConflict(
        tx,
        companyId,
        holderNumber,
      );
      if (conflict !== null) {
        await recordIdentifierConflict(tx, conflict, context);
        return { kind: "conflict", conflict };
      }
      await tx
        .insert(companyIdentifiers)
        .values({ companyId, type: "faa_pma_holder", value: holderNumber })
        .onConflictDoNothing();
      const racedConflict = await findIdentifierConflict(
        tx,
        companyId,
        holderNumber,
      );
      if (racedConflict !== null) {
        await recordIdentifierConflict(tx, racedConflict, context);
        return { kind: "conflict", conflict: racedConflict };
      }
    }

    const dataSourceId = await upsertFaaDataSource(tx);
    const document = await upsertFaaDocument(
      tx,
      dataSourceId,
      record,
      context,
    );
    await tx
      .insert(companySourceLinks)
      .values({
        dataSourceId,
        companyId,
        relationship: "qualification_holder",
        externalKey: holderNumber ?? record.recordId,
      })
      .onConflictDoNothing();
    await linkDocument(tx, document.id, { companyId }, "qualification_holder");

    const recordGaps: FaaSynthesisGap[] = [];
    const facility = await upsertFaaFacility(tx, companyId, record);
    if (facility.gap !== null) recordGaps.push(facility.gap);
    if (facility.id !== null) {
      await linkDocument(tx, document.id, { facilityId: facility.id }, "qualifies_at");
    }
    const part = await upsertFaaPart(tx, companyId, record);
    if (part.id !== null) {
      await linkDocument(tx, document.id, { partId: part.id }, "approves_part");
    }

    if (facility.id === null) {
      recordGaps.push({
        recordId: record.recordId,
        field: "facility",
        reason: "FAA record has neither a holder address nor a holder name",
      });
    }
    if (part.id === null) {
      recordGaps.push({
        recordId: record.recordId,
        field: "part",
        reason: "FAA record has no PMA part number",
      });
    }
    let qualification: {
      id: string | null;
      created: boolean;
      platformId: string | null;
      platformVariantId: string | null;
    } = {
      id: null,
      created: false,
      platformId: null,
      platformVariantId: null,
    };
    if (facility.id !== null && part.id !== null) {
      const platformMatch = await resolveExactPlatform(tx, record);
      if (platformMatch.gap !== null) recordGaps.push(platformMatch.gap);
      qualification = await upsertQualification(
        tx,
        facility.id,
        part.id,
        record,
        platformMatch.platformId,
        platformMatch.platformVariantId,
      );
      await linkDocument(
        tx,
        document.id,
        { facilityQualificationId: qualification.id! },
        "approves_qualification",
      );
      if (qualification.platformId !== null) {
        await linkDocument(
          tx,
          document.id,
          { platformId: qualification.platformId },
          "applies_to",
        );
      }
      if (qualification.platformVariantId !== null) {
        await linkDocument(
          tx,
          document.id,
          { platformVariantId: qualification.platformVariantId },
          "applies_to_variant",
        );
      }
    }

    const researchRunId = await ensureFaaRun(
      tx,
      document.id,
      companyId,
      record.recordId,
    );
    const material = collectFaaMaterial(
      companyId,
      facility.id,
      facility.addressAccepted,
      part.id,
      qualification.id,
      record,
      recordGaps,
    );
    let observationsCreated = 0;
    let observationsReused = 0;
    for (const item of material) {
      const wasCreated = await ensureFaaProposal(
        tx,
        document.id,
        researchRunId,
        item,
        record.guidUrl,
      );
      if (wasCreated) observationsCreated += 1;
      else observationsReused += 1;
    }

    return {
      kind: "ok",
      documentCreated: document.created,
      facilityPresent: facility.id !== null,
      facilityCreated: facility.created,
      partPresent: part.id !== null,
      partCreated: part.created,
      qualificationPresent: qualification.id !== null,
      qualificationCreated: qualification.created,
      observationsCreated,
      observationsReused,
      gaps: recordGaps,
    };
  });
}

function collectFaaMaterial(
  companyId: string,
  facilityId: string | null,
  facilityAddressAccepted: boolean,
  partId: string | null,
  qualificationId: string | null,
  record: FaaPmaRecord,
  gaps: readonly FaaSynthesisGap[],
): FaaMaterial[] {
  const values: FaaMaterial[] = [];
  const append = (
    subjectType: string,
    subjectId: string,
    fieldKey: string,
    value: unknown,
  ): void => {
    values.push({
      subjectType,
      subjectId,
      fieldKey,
      value,
      quote: typeof value === "string" ? value : stableJson(value),
    });
  };
  if (record.holderNumber !== null) {
    append(
      "company",
      companyId,
      "identifier.faa_pma_holder",
      normalizeIdentifier(record.holderNumber),
    );
  }
  if (record.holderName !== null) {
    append("company", companyId, "faa.holder_name", record.holderName);
  }
  if (
    facilityId !== null &&
    facilityAddressAccepted &&
    record.fullAddress !== null
  ) {
    append(
      "facility",
      facilityId,
      "registered_address",
      parseFaaAddress(record.fullAddress),
    );
  }
  if (facilityId !== null) {
    for (const gap of gaps.filter(({ field }) => field === "facility")) {
      append("facility", facilityId, "faa.address_conflict", gap);
    }
  }
  if (partId !== null) {
    append("part", partId, "faa.pma_part_number", record.pmaPartNumber);
    if (record.partName !== null) append("part", partId, "name", record.partName);
    if (record.replacementPartNumber !== null) {
      append(
        "part",
        partId,
        "faa.replacement_part_number",
        record.replacementPartNumber,
      );
    }
  }
  if (qualificationId !== null) {
    const fields: readonly [string, unknown][] = [
      ["faa.record_id", record.recordId],
      ["faa.status", record.status],
      ["faa.sub_status", record.subStatus],
      ["faa.make", record.make],
      ["faa.models", record.models],
      ["faa.supplement_number", record.supplementNumber],
      ["faa.supplement_date", record.supplementDate],
      ["faa.approval_basis", record.approvalBasis],
      ["faa.service_office", record.serviceOffice],
      ["faa.opr", record.opr],
      ["faa.cfr_references", record.cfrReferences],
      ["faa.comments", record.comments],
    ];
    for (const [fieldKey, value] of fields) {
      if (value !== null) append("qualification", qualificationId, fieldKey, value);
    }
    for (const gap of gaps.filter(({ field }) => field === "platform")) {
      append(
        "qualification",
        qualificationId,
        "faa.platform_resolution_gap",
        gap,
      );
    }
  }
  return values;
}

async function findIdentifierConflict(
  tx: Tx,
  companyId: string,
  holderNumber: string,
): Promise<SynthesisConflictDetail | null> {
  const [existing] = await tx
    .select({ companyId: companyIdentifiers.companyId })
    .from(companyIdentifiers)
    .where(
      and(
        eq(companyIdentifiers.type, "faa_pma_holder"),
        sql`upper(btrim(${companyIdentifiers.value})) = ${holderNumber}`,
      ),
    )
    .limit(1);
  if (existing === undefined || existing.companyId === companyId) return null;
  return {
    identifierType: "faa_pma_holder",
    identifierValue: holderNumber,
    existingCompanyId: existing.companyId,
    requestedCompanyId: companyId,
  };
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

async function upsertFaaDataSource(tx: Tx): Promise<string> {
  const name = "FAA Dynamic Regulatory System PMA";
  const publisher = "Federal Aviation Administration";
  const [inserted] = await tx
    .insert(dataSources)
    .values({
      name,
      sourceType: "government_approval_registry",
      baseUrl: "https://drs.faa.gov/browse/PMA/doctypeDetails",
      access: "public",
      ingestion: "web_fetch",
      publisher,
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
    .where(and(sql`lower(${dataSources.name}) = lower(${name})`, eq(dataSources.publisher, publisher)))
    .limit(1);
  if (existing === undefined) throw new Error("Unable to upsert FAA DRS data source");
  return existing.id;
}

async function upsertFaaDocument(
  tx: Tx,
  dataSourceId: string,
  record: FaaPmaRecord,
  context: SynthesisSourceContext,
): Promise<{ readonly id: string; readonly created: boolean }> {
  const contentSha256 = sha256(record.renderedSourceText);
  const [existing] = await tx
    .select({ id: sourceDocuments.id })
    .from(sourceDocuments)
    .where(
      or(
        eq(sourceDocuments.contentSha256, contentSha256),
        and(
          eq(sourceDocuments.dataSourceId, dataSourceId),
          eq(sourceDocuments.canonicalUrl, record.guidUrl),
        ),
      ),
    )
    .limit(1);
  if (existing !== undefined) return { id: existing.id, created: false };
  const [inserted] = await tx
    .insert(sourceDocuments)
    .values({
      dataSourceId,
      canonicalUrl: record.guidUrl,
      title: `FAA PMA ${record.recordId}`,
      documentType: "faa_drs_pma_record",
      contentSha256,
      mimeType: "text/plain",
      byteLength: Buffer.byteLength(record.renderedSourceText, "utf8"),
      retrievedAt: parseDate(context.retrievedAt),
      metadata: {
        sourceKey: "faa_drs_pma",
        recordId: record.recordId,
        renderedTextSha256: contentSha256,
        ...context.metadata,
      },
    })
    .onConflictDoNothing()
    .returning({ id: sourceDocuments.id });
  if (inserted !== undefined) return { id: inserted.id, created: true };
  const [raced] = await tx
    .select({ id: sourceDocuments.id })
    .from(sourceDocuments)
    .where(
      or(
        eq(sourceDocuments.contentSha256, contentSha256),
        and(
          eq(sourceDocuments.dataSourceId, dataSourceId),
          eq(sourceDocuments.canonicalUrl, record.guidUrl),
        ),
      ),
    )
    .limit(1);
  if (raced === undefined) throw new Error("Unable to upsert FAA DRS document");
  return { id: raced.id, created: false };
}

export interface FaaAddress {
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly region: string | null;
  readonly postalCode: string | null;
  readonly countryCode: string;
}
type FaaFacilityResult = {
  readonly id: string | null;
  readonly created: boolean;
  readonly addressAccepted: boolean;
  readonly gap: FaaSynthesisGap | null;
};

async function upsertFaaFacility(
  tx: Tx,
  companyId: string,
  record: FaaPmaRecord,
): Promise<FaaFacilityResult> {
  const address = record.fullAddress === null ? null : parseFaaAddress(record.fullAddress);
  const holderName = normalizeText(record.holderName);
  if (address === null && holderName === null) {
    return { id: null, created: false, addressAccepted: false, gap: null };
  }


  const holderFacilities = holderName === null
    ? []
    : await tx
        .select({
          id: facilities.id,
          status: facilities.status,
          addressLine1: facilities.addressLine1,
          addressLine2: facilities.addressLine2,
          city: facilities.city,
          region: facilities.region,
          postalCode: facilities.postalCode,
          countryCode: facilities.countryCode,
        })
        .from(facilities)
        .where(
          and(
            eq(facilities.companyId, companyId),
            eq(facilities.facilityType, "faa_pma_holder"),
            sql`lower(btrim(${facilities.name})) = lower(${holderName})`,
          ),
        )
        .limit(2);
  const holderFacility = holderFacilities[0];
  if (holderFacility !== undefined) {
    if (address === null) {
      return {
        id: holderFacility.id,
        created: false,
        addressAccepted: false,
        gap: null,
      };
    }
    if (holderFacilities.length > 1) {
      return facilityAddressGap(
        holderFacility.id,
        record,
        "Multiple same-name FAA holder facilities prevent deterministic address enrichment",
      );
    }
    const compatibility = addressCompatibility(holderFacility, address);
    if (!compatibility.compatible) {
      return facilityAddressGap(
        holderFacility.id,
        record,
        "FAA holder address conflicts with an existing non-null facility address",
      );
    }
    if (!compatibility.missing) {
      return {
        id: holderFacility.id,
        created: false,
        addressAccepted: true,
        gap: null,
      };
    }
    const [addressOwner] = await tx
      .select({ id: facilities.id })
      .from(facilities)
      .where(
        and(
          eq(facilities.companyId, companyId),
          exactAddressCondition(address),
          sql`${facilities.id} <> ${holderFacility.id}`,
        ),
      )
      .limit(1);
    if (addressOwner !== undefined) {
      return facilityAddressGap(
        holderFacility.id,
        record,
        "FAA holder address already belongs to a different company facility",
      );
    }
    if (holderFacility.status !== "draft") {
      return facilityAddressGap(
        holderFacility.id,
        record,
        "Only a draft FAA holder facility may be enriched with missing address fields",
      );
    }
    const [hydrated] = await tx
      .update(facilities)
      .set({
        ...(holderFacility.addressLine1 === null
          ? { addressLine1: address.addressLine1 }
          : {}),
        ...(holderFacility.addressLine2 === null
          ? { addressLine2: address.addressLine2 }
          : {}),
        ...(holderFacility.city === null ? { city: address.city } : {}),
        ...(holderFacility.region === null ? { region: address.region } : {}),
        ...(holderFacility.postalCode === null
          ? { postalCode: address.postalCode }
          : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(facilities.id, holderFacility.id),
          eq(facilities.status, "draft"),
        ),
      )
      .returning({ id: facilities.id });
    if (hydrated === undefined) {
      return facilityAddressGap(
        holderFacility.id,
        record,
        "Draft FAA holder facility changed during address enrichment",
      );
    }
    return {
      id: hydrated.id,
      created: false,
      addressAccepted: true,
      gap: null,
    };
  }
  if (address !== null) {
    const [exactAddress] = await tx
      .select({ id: facilities.id })
      .from(facilities)
      .where(
        and(
          eq(facilities.companyId, companyId),
          exactAddressCondition(address),
        ),
      )
      .limit(1);
    if (exactAddress !== undefined) {
      return {
        id: exactAddress.id,
        created: false,
        addressAccepted: true,
        gap: null,
      };
    }
  }

  const [inserted] = await tx
    .insert(facilities)
    .values({
      companyId,
      name: holderName ?? "FAA PMA Holder Facility",
      facilityType: "faa_pma_holder",
      ...(address ?? { countryCode: "US" }),
      status: "draft",
    })
    .onConflictDoNothing()
    .returning({ id: facilities.id });
  if (inserted !== undefined) {
    return {
      id: inserted.id,
      created: true,
      addressAccepted: address !== null,
      gap: null,
    };
  }
  if (address !== null) {
    const [raced] = await tx
      .select({ id: facilities.id })
      .from(facilities)
      .where(and(eq(facilities.companyId, companyId), exactAddressCondition(address)))
      .limit(1);
    if (raced !== undefined) {
      return { id: raced.id, created: false, addressAccepted: true, gap: null };
    }
  }
  throw new Error("Unable to upsert FAA PMA facility");
}

function exactAddressCondition(address: FaaAddress) {
  return and(
    sql`lower(btrim(coalesce(${facilities.addressLine1}, ''))) = lower(${address.addressLine1 ?? ""})`,
    sql`lower(btrim(coalesce(${facilities.addressLine2}, ''))) = lower(${address.addressLine2 ?? ""})`,
    sql`lower(btrim(coalesce(${facilities.city}, ''))) = lower(${address.city ?? ""})`,
    sql`lower(btrim(coalesce(${facilities.region}, ''))) = lower(${address.region ?? ""})`,
    sql`lower(btrim(coalesce(${facilities.postalCode}, ''))) = lower(${address.postalCode ?? ""})`,
    eq(facilities.countryCode, address.countryCode),
  );
}

function addressCompatibility(
  existing: {
    readonly addressLine1: string | null;
    readonly addressLine2: string | null;
    readonly city: string | null;
    readonly region: string | null;
    readonly postalCode: string | null;
    readonly countryCode: string;
  },
  incoming: FaaAddress,
): { readonly compatible: boolean; readonly missing: boolean } {
  const pairs = [
    [existing.addressLine1, incoming.addressLine1],
    [existing.addressLine2, incoming.addressLine2],
    [existing.city, incoming.city],
    [existing.region, incoming.region],
    [existing.postalCode, incoming.postalCode],
    [existing.countryCode, incoming.countryCode],
  ] as const;
  return {
    compatible: pairs.every(
      ([current, next]) =>
        current === null ||
        next === null ||
        normalizeMatch(current) === normalizeMatch(next),
    ),
    missing: pairs.some(([current, next]) => current === null && next !== null),
  };
}

function facilityAddressGap(
  facilityId: string,
  record: FaaPmaRecord,
  reason: string,
): FaaFacilityResult {
  return {
    id: facilityId,
    created: false,
    addressAccepted: false,
    gap: {
      recordId: record.recordId,
      field: "facility",
      reason,
    },
  };
}

async function upsertFaaPart(
  tx: Tx,
  companyId: string,
  record: FaaPmaRecord,
): Promise<{ readonly id: string | null; readonly created: boolean }> {
  const pmaPartNumber = normalizeIdentifier(record.pmaPartNumber);
  if (pmaPartNumber === null) return { id: null, created: false };
  const [existing] = await tx
    .select({ id: parts.id })
    .from(parts)
    .where(
      and(
        eq(parts.manufacturerCompanyId, companyId),
        sql`upper(btrim(${parts.partNumber})) = ${pmaPartNumber}`,
      ),
    )
    .limit(1);
  let partId = existing?.id;
  let created = false;
  if (partId === undefined) {
    const [inserted] = await tx
      .insert(parts)
      .values({
        manufacturerCompanyId: companyId,
        partNumber: pmaPartNumber,
        name: normalizeText(record.partName),
        description: "FAA PMA replacement part (draft pending grouped review)",
        lifecycleStatus: "draft",
      })
      .onConflictDoNothing()
      .returning({ id: parts.id });
    partId = inserted?.id;
    created = partId !== undefined;
  }
  if (partId === undefined) {
    const [raced] = await tx
      .select({ id: parts.id })
      .from(parts)
      .where(
        and(
          eq(parts.manufacturerCompanyId, companyId),
          sql`upper(btrim(${parts.partNumber})) = ${pmaPartNumber}`,
        ),
      )
      .limit(1);
    partId = raced?.id;
  }
  if (partId === undefined) throw new Error("Unable to upsert FAA PMA part");

  const replacement = normalizeIdentifier(record.replacementPartNumber);
  if (replacement !== null) {
    await tx
      .insert(partAlternateIds)
      .values({
        partId,
        identifierType: "oem_replacement_part_number",
        identifierValue: replacement,
        authority: "FAA DRS PMA",
      })
      .onConflictDoNothing();
  }
  return { id: partId, created };
}

async function resolveExactPlatform(
  tx: Tx,
  record: FaaPmaRecord,
): Promise<{
  readonly platformId: string | null;
  readonly platformVariantId: string | null;
  readonly gap: FaaSynthesisGap | null;
}> {
  const make = normalizeMatch(record.make);
  const models = [...new Set(record.models.map(normalizeMatch).filter((value): value is string => value !== null))];
  if (make === null || models.length === 0) {
    return {
      platformId: null,
      platformVariantId: null,
      gap: {
        recordId: record.recordId,
        field: "platform",
        reason: "FAA make and model are both required for exact platform resolution",
        make: record.make,
        models: record.models,
      },
    };
  }

  const exactByModel: { platformId: string; variantId: string | null }[] = [];
  for (const model of models) {
    const variantRows = await tx
      .select({ platformId: platforms.id, variantId: platformVariants.id })
      .from(platformVariants)
      .innerJoin(platforms, eq(platforms.id, platformVariants.platformId))
      .leftJoin(companies, eq(companies.id, platforms.manufacturerCompanyId))
      .where(
        and(
          normalizedSqlEquals(platformVariants.name, model),
          or(
            normalizedSqlEquals(platforms.name, make),
            normalizedSqlEquals(companies.legalName, make),
            normalizedSqlEquals(companies.displayName, make),
          ),
        ),
      );
    const directRows = await tx
      .select({ platformId: platforms.id })
      .from(platforms)
      .leftJoin(companies, eq(companies.id, platforms.manufacturerCompanyId))
      .where(
        and(
          normalizedSqlEquals(platforms.name, model),
          or(
            normalizedSqlEquals(companies.legalName, make),
            normalizedSqlEquals(companies.displayName, make),
            normalizedSqlEquals(platforms.name, make),
          ),
        ),
      );
    const candidates = [
      ...variantRows,
      ...directRows.map(({ platformId }) => ({ platformId, variantId: null })),
    ];
    const unique = [
      ...new Map(
        candidates.map((candidate) => [
          `${candidate.platformId}:${candidate.variantId ?? ""}`,
          candidate,
        ]),
      ).values(),
    ];
    if (unique.length !== 1) {
      return unresolvedPlatformGap(record, `Expected one exact make/model match for ${model}; found ${unique.length}`);
    }
    exactByModel.push(unique[0]!);
  }
  const platformIds = [...new Set(exactByModel.map(({ platformId }) => platformId))];
  if (platformIds.length !== 1) {
    return unresolvedPlatformGap(record, "Exact model matches span more than one platform");
  }
  return {
    platformId: platformIds[0]!,
    platformVariantId: exactByModel.length === 1 ? exactByModel[0]!.variantId : null,
    gap: null,
  };
}

function unresolvedPlatformGap(
  record: FaaPmaRecord,
  reason: string,
): {
  readonly platformId: null;
  readonly platformVariantId: null;
  readonly gap: FaaSynthesisGap;
} {
  return {
    platformId: null,
    platformVariantId: null,
    gap: {
      recordId: record.recordId,
      field: "platform",
      reason,
      make: record.make,
      models: record.models,
    },
  };
}
function normalizedSqlEquals(column: AnyPgColumn, value: string) {
  return sql`lower(regexp_replace(btrim(coalesce(${column}, '')), '\\s+', ' ', 'g')) = ${value}`;
}

async function upsertQualification(
  tx: Tx,
  facilityId: string,
  partId: string,
  record: FaaPmaRecord,
  platformId: string | null,
  platformVariantId: string | null,
): Promise<{
  readonly id: string;
  readonly created: boolean;
  readonly platformId: string | null;
  readonly platformVariantId: string | null;
}> {
  const holder = normalizeIdentifier(record.holderNumber) ?? "NO-HOLDER";
  const supplement = normalizeIdentifier(record.supplementNumber) ?? "NO-SUPPLEMENT";
  const reference = `FAA-PMA:${holder}:${supplement}:${record.recordId.trim()}`;
  const [existing] = await tx
    .select({
      id: facilityQualifications.id,
      platformId: facilityQualifications.platformId,
      platformVariantId: facilityQualifications.platformVariantId,
    })
    .from(facilityQualifications)
    .where(
      and(
        eq(facilityQualifications.facilityId, facilityId),
        eq(facilityQualifications.qualificationReference, reference),
      ),
    )
    .limit(1);
  if (existing !== undefined) return { ...existing, created: false };
  const [inserted] = await tx
    .insert(facilityQualifications)
    .values({
      facilityId,
      partId,
      platformId,
      platformVariantId,
      qualificationReference: reference,
      scarcity: "not_assessed",
      confidence: "1",
      status: "draft",
      validFrom: record.supplementDate,
    })
    .onConflictDoNothing()
    .returning({
      id: facilityQualifications.id,
      platformId: facilityQualifications.platformId,
      platformVariantId: facilityQualifications.platformVariantId,
    });
  if (inserted !== undefined) return { ...inserted, created: true };
  const [raced] = await tx
    .select({
      id: facilityQualifications.id,
      platformId: facilityQualifications.platformId,
      platformVariantId: facilityQualifications.platformVariantId,
    })
    .from(facilityQualifications)
    .where(
      and(
        eq(facilityQualifications.facilityId, facilityId),
        eq(facilityQualifications.qualificationReference, reference),
      ),
    )
    .limit(1);
  if (raced === undefined) throw new Error("Unable to upsert FAA qualification");
  return { ...raced, created: false };
}

async function ensureFaaRun(
  tx: Tx,
  sourceDocumentId: string,
  companyId: string,
  recordId: string,
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
      objective: "Materialize qualified FAA DRS PMA source evidence",
      input: { sourceDocumentId, sourceKey: "faa_drs_pma", recordId },
      promptVersion: "deterministic-source-synthesis-v1",
      progressPercent: "100",
      startedAt: now,
      completedAt: now,
    })
    .returning({ id: researchRuns.id });
  if (inserted === undefined) throw new Error("Unable to create FAA synthesis run");
  return inserted.id;
}

async function ensureFaaProposal(
  tx: Tx,
  sourceDocumentId: string,
  researchRunId: string,
  material: FaaMaterial,
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
      extractionMethod: "faa_drs_rendered_text",
      contentSha256: sha256(quote),
      metadata: { synthesisKey, fieldKey: material.fieldKey },
    })
    .returning({ id: evidence.id });
  if (evidenceRow === undefined) throw new Error("Unable to append FAA evidence");
  const [observation] = await tx
    .insert(observations)
    .values({
      subjectType: material.subjectType,
      subjectId: material.subjectId,
      fieldKey: material.fieldKey,
      valueKind: inferObservationValueKind(material.value),
      value: material.value,
      normalizedText:
        typeof material.value === "string"
          ? normalizeText(material.value)
          : stableJson(material.value),
      confidence: "1",
      evidenceId: evidenceRow.id,
      reviewStatus: "pending",
      conflictStatus: "none",
    })
    .returning({ id: observations.id });
  if (observation === undefined) throw new Error("Unable to append FAA observation");
  await tx.insert(researchProposals).values({
    researchRunId,
    observationId: observation.id,
    subjectType: material.subjectType,
    subjectId: material.subjectId,
    fieldKey: material.fieldKey,
    status: "pending",
    rationale: "FAA primary-source materialization requires grouped analyst acceptance",
  });
  return true;
}

async function linkDocument(
  tx: Tx,
  sourceDocumentId: string,
  target: GraphTarget,
  relationship: string,
): Promise<void> {
  await tx
    .insert(sourceDocumentLinks)
    .values({ sourceDocumentId, relationship, ...target })
    .onConflictDoNothing();
}

/** Deterministic parser for both scraper pipe fields and legacy rendered lines. */
export function parseFaaAddress(fullAddress: string): FaaAddress {
  const normalized = fullAddress.normalize("NFKC").trim();
  const pipeFields = normalized
    .split(/\s*\|\s*/gu)
    .map((field) => field.trim().replace(/\s+/gu, " "));
  if (pipeFields.length === 5 && pipeFields.every(Boolean)) {
    return {
      addressLine1: normalizeText(pipeFields[0]),
      addressLine2: null,
      city: normalizeText(pipeFields[1]),
      region: normalizeIdentifier(pipeFields[2]),
      postalCode: normalizeIdentifier(pipeFields[3]),
      countryCode: countryCodeFromText(pipeFields[4]!),
    };
  }

  const lines = normalized
    .split(/\r?\n/gu)
    .map((line) => line.trim().replace(/\s+/gu, " "))
    .filter(Boolean);
  const countryLine = lines.at(-1) ?? "";
  const hasCountry = /^(?:united states(?: of america)?|usa|us)$/iu.test(countryLine);
  const body = hasCountry ? lines.slice(0, -1) : lines;
  const locality = body.at(-1) ?? null;
  const localityMatch = locality?.match(/^(.+?),\s*([A-Z]{2})\s+([A-Z0-9 -]+)$/u);
  const streetLines = localityMatch === null ? body : body.slice(0, -1);
  return {
    addressLine1: normalizeText(streetLines[0] ?? (localityMatch === null ? locality : null)),
    addressLine2: normalizeText(streetLines.slice(1).join(" ")),
    city: normalizeText(localityMatch?.[1]),
    region: normalizeIdentifier(localityMatch?.[2]),
    postalCode: normalizeIdentifier(localityMatch?.[3]),
    countryCode: hasCountry ? "US" : countryCodeFromText(countryLine),
  };
}

function countryCodeFromText(value: string): string {
  const normalized = normalizeIdentifier(value);
  if (
    normalized === "UNITED STATES" ||
    normalized === "UNITED STATES OF AMERICA" ||
    normalized === "USA"
  ) {
    return "US";
  }
  return normalized === null ? "US" : normalized.slice(0, 2);
}

function emptyCounts(): {
  documents: number;
  facilities: number;
  parts: number;
  qualifications: number;
  observations: number;
} {
  return { documents: 0, facilities: 0, parts: 0, qualifications: 0, observations: 0 };
}

function normalizeIdentifier(value: string | null | undefined): string | null {
  const normalized = value?.normalize("NFKC").trim().toLocaleUpperCase("en-US");
  return normalized === undefined || normalized === "" ? null : normalized;
}

function normalizeText(value: string | null | undefined): string | null {
  const normalized = value?.normalize("NFKC").trim().replace(/\s+/gu, " ");
  return normalized === undefined || normalized === "" ? null : normalized;
}

function normalizeMatch(value: string | null | undefined): string | null {
  return normalizeText(value)?.toLocaleLowerCase("en-US") ?? null;
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
