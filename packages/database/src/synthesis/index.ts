import { faaPmaRecordSchema, type FaaPmaRecord } from "@asi/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "../client.js";
import {
  auditEvents,
  candidates,
  canonicalFacts,
  evidence,
  facilities,
  facilityQualifications,
  observations,
  parts,
  proposalReviews,
  researchProposals,
  sourceDocumentLinks,
  sourceSignals,
} from "../schema.js";
import {
  persistFaaPmaRecordsForCompany,
  type FaaPersistenceResult,
} from "./faa.js";
import {
  persistSamEntityForCompany,
  type SamEntityForSynthesis,
  type SamPersistenceResult,
} from "./sam.js";

export * from "./faa.js";
export * from "./sam.js";

export interface AcceptSynthesisGroupInput {
  readonly companyId: string;
  readonly sourceDocumentId: string;
  readonly reviewerId: string;
  readonly expectedObservationIds: readonly string[];
}

export interface AcceptSynthesisGroupResult {
  readonly acceptedProposalCount: number;
  readonly observationIds: readonly string[];
  readonly activated: {
    readonly facilities: number;
    readonly parts: number;
    readonly qualifications: number;
  };
  readonly candidateRescoreRequested: boolean;
}

export class SynthesisStaleGroupError extends Error {
  override readonly name = "SynthesisStaleGroupError";
  readonly code = "SYNTHESIS_GROUP_STALE";
  readonly statusCode = 409;

  constructor(
    readonly expectedObservationIds: readonly string[],
    readonly currentObservationIds: readonly string[],
  ) {
    super("Synthesis group changed since it was loaded; no proposals were accepted");
  }
}

export class SynthesisPreconditionError extends Error {
  override readonly name = "SynthesisPreconditionError";
  readonly code = "SYNTHESIS_PRECONDITION_FAILED";
  readonly statusCode = 409;
}

type AcceptedProposal = {
  readonly id: string;
  readonly observationId: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly fieldKey: string;
};

/**
 * Accept a document as one review unit. The expected-id compare, canonical fact
 * promotion, and graph activation share one lock and one transaction.
 */
export async function acceptSynthesisGroup(
  db: Database,
  input: AcceptSynthesisGroupInput,
): Promise<AcceptSynthesisGroupResult> {
  return db.transaction(async (tx) => {
    const lockKey = `synthesis-group:${input.companyId}:${input.sourceDocumentId}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

    const [companyLink] = await tx
      .select({ id: sourceDocumentLinks.id })
      .from(sourceDocumentLinks)
      .where(
        and(
          eq(sourceDocumentLinks.sourceDocumentId, input.sourceDocumentId),
          eq(sourceDocumentLinks.companyId, input.companyId),
        ),
      )
      .limit(1);
    if (companyLink === undefined) {
      throw new SynthesisPreconditionError(
        "Source document is not linked to the requested company",
      );
    }

    const pending = await tx
      .select({
        id: researchProposals.id,
        observationId: researchProposals.observationId,
        subjectType: researchProposals.subjectType,
        subjectId: researchProposals.subjectId,
        fieldKey: researchProposals.fieldKey,
      })
      .from(researchProposals)
      .innerJoin(
        observations,
        eq(observations.id, researchProposals.observationId),
      )
      .innerJoin(evidence, eq(evidence.id, observations.evidenceId))
      .where(
        and(
          eq(evidence.sourceDocumentId, input.sourceDocumentId),
          eq(researchProposals.status, "pending"),
        ),
      )
      .for("update");

    const expectedIds = [...input.expectedObservationIds].sort();
    const currentIds = pending.map(({ observationId }) => observationId).sort();
    if (!sameStringArray(expectedIds, currentIds)) {
      throw new SynthesisStaleGroupError(expectedIds, currentIds);
    }

    for (const proposal of pending) {
      await acceptProposal(tx, proposal, input.reviewerId);
    }

    const links = await tx
      .select({
        facilityId: sourceDocumentLinks.facilityId,
        partId: sourceDocumentLinks.partId,
        qualificationId: sourceDocumentLinks.facilityQualificationId,
      })
      .from(sourceDocumentLinks)
      .where(eq(sourceDocumentLinks.sourceDocumentId, input.sourceDocumentId));
    const facilityIds = uniqueIds(links.map(({ facilityId }) => facilityId));
    const partIds = uniqueIds(links.map(({ partId }) => partId));
    const qualificationIds = uniqueIds(
      links.map(({ qualificationId }) => qualificationId),
    );

    const activatedFacilities = facilityIds.length === 0
      ? []
      : await tx
          .update(facilities)
          .set({ status: "active", updatedAt: new Date() })
          .where(
            and(
              inArray(facilities.id, facilityIds),
              eq(facilities.status, "draft"),
            ),
          )
          .returning({ id: facilities.id });
    const activatedParts = partIds.length === 0
      ? []
      : await tx
          .update(parts)
          .set({ lifecycleStatus: "active", updatedAt: new Date() })
          .where(
            and(
              inArray(parts.id, partIds),
              eq(parts.lifecycleStatus, "draft"),
            ),
          )
          .returning({ id: parts.id });
    const activatedQualifications = qualificationIds.length === 0
      ? []
      : await tx
          .update(facilityQualifications)
          .set({ status: "active", updatedAt: new Date() })
          .where(
            and(
              inArray(facilityQualifications.id, qualificationIds),
              eq(facilityQualifications.status, "draft"),
            ),
          )
          .returning({ id: facilityQualifications.id });

    const [candidate] = await tx
      .select({ id: candidates.id })
      .from(candidates)
      .where(eq(candidates.companyId, input.companyId))
      .limit(1);
    if (candidate !== undefined) {
      await tx
        .update(candidates)
        .set({ updatedAt: new Date() })
        .where(eq(candidates.id, candidate.id));
      await tx.insert(auditEvents).values({
        actorUserId: input.reviewerId,
        action: "candidate.rescore_requested",
        entityType: "candidate",
        entityId: candidate.id,
        metadata: {
          reason: "synthesis_group_accepted",
          companyId: input.companyId,
          sourceDocumentId: input.sourceDocumentId,
        },
      });
    }
    await tx.insert(auditEvents).values({
      actorUserId: input.reviewerId,
      action: "synthesis.group_accept",
      entityType: "source_document",
      entityId: input.sourceDocumentId,
      before: { pendingObservationIds: currentIds },
      after: {
        acceptedObservationIds: currentIds,
        activatedFacilityIds: activatedFacilities.map(({ id }) => id),
        activatedPartIds: activatedParts.map(({ id }) => id),
        activatedQualificationIds: activatedQualifications.map(({ id }) => id),
      },
      metadata: {
        companyId: input.companyId,
        allOrNothing: true,
        candidateRescoreRequested: candidate !== undefined,
      },
    });

    return {
      acceptedProposalCount: pending.length,
      observationIds: currentIds,
      activated: {
        facilities: activatedFacilities.length,
        parts: activatedParts.length,
        qualifications: activatedQualifications.length,
      },
      candidateRescoreRequested: candidate !== undefined,
    };
  });
}

async function acceptProposal(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  proposal: AcceptedProposal,
  reviewerId: string,
): Promise<void> {
  const [current] = await tx
    .select()
    .from(canonicalFacts)
    .where(
      and(
        eq(canonicalFacts.subjectType, proposal.subjectType),
        eq(canonicalFacts.subjectId, proposal.subjectId),
        eq(canonicalFacts.fieldKey, proposal.fieldKey),
      ),
    )
    .for("update");
  const now = new Date();
  await tx
    .update(researchProposals)
    .set({ status: "accepted", updatedAt: now })
    .where(
      and(
        eq(researchProposals.id, proposal.id),
        eq(researchProposals.status, "pending"),
      ),
    );
  await tx.insert(proposalReviews).values({
    proposalId: proposal.id,
    reviewerUserId: reviewerId,
    decision: "accepted",
    reason: "Accepted as an atomic primary-source synthesis group",
  });
  if (current === undefined) {
    await tx.insert(canonicalFacts).values({
      subjectType: proposal.subjectType,
      subjectId: proposal.subjectId,
      fieldKey: proposal.fieldKey,
      currentObservationId: proposal.observationId,
      acceptedProposalId: proposal.id,
      updatedByUserId: reviewerId,
    });
  } else {
    await tx
      .update(canonicalFacts)
      .set({
        currentObservationId: proposal.observationId,
        acceptedProposalId: proposal.id,
        supersededObservationId: current.currentObservationId,
        effectiveFrom: now,
        updatedByUserId: reviewerId,
        updatedAt: now,
      })
      .where(eq(canonicalFacts.id, current.id));
  }
}

export type SynthesizeQualifiedSignalResult =
  | { readonly status: "noop"; readonly sourceKey: string }
  | {
      readonly status: "materialized";
      readonly sourceKey: "sam_entity";
      readonly result: SamPersistenceResult;
    }
  | {
      readonly status: "materialized";
      readonly sourceKey: "faa_drs_pma";
      readonly result: FaaPersistenceResult;
    };

/** Route only explicitly supported, qualified source signals into synthesis. */
export async function synthesizeQualifiedSourceSignal(
  db: Database,
  signalId: string,
): Promise<SynthesizeQualifiedSignalResult> {
  const [signal] = await db
    .select()
    .from(sourceSignals)
    .where(eq(sourceSignals.id, signalId))
    .limit(1);
  if (signal === undefined) {
    throw new SynthesisPreconditionError(`Source signal ${signalId} does not exist`);
  }
  if (signal.sourceKey !== "sam_entity" && signal.sourceKey !== "faa_drs_pma") {
    return { status: "noop", sourceKey: signal.sourceKey };
  }
  if (signal.status !== "qualified" || signal.companyId === null) {
    throw new SynthesisPreconditionError(
      "Synthesis requires a qualified source signal with a resolved company",
    );
  }

  const context = {
    sourceSignalId: signal.id,
    retrievedAt: signal.createdAt,
    metadata: { sourceFingerprint: signal.sourceFingerprint },
  };
  if (signal.sourceKey === "sam_entity") {
    const entity = samEntityFromSignal(signal);
    const result = await persistSamEntityForCompany(
      db,
      signal.companyId,
      entity,
      context,
    );
    return { status: "materialized", sourceKey: "sam_entity", result };
  }

  const records = faaRecordsFromPayload(signal.sourcePayload);
  const result = await persistFaaPmaRecordsForCompany(
    db,
    signal.companyId,
    records,
    context,
  );
  return { status: "materialized", sourceKey: "faa_drs_pma", result };
}

type SignalForSam = typeof sourceSignals.$inferSelect;

function samEntityFromSignal(signal: SignalForSam): SamEntityForSynthesis {
  const payload = signal.sourcePayload;
  const registration = asRecord(payload.entityRegistration);
  const core = asRecord(payload.coreData);
  const address = asRecord(core.physicalAddress);
  const information = asRecord(core.entityInformation);
  const assertions = asRecord(payload.assertions);
  const goods = asRecord(assertions.goodsAndServices);
  const uei = textValue(registration.ueiSAM) ?? signal.uei;
  if (uei === null) throw new SynthesisPreconditionError("SAM signal has no UEI");

  const naics = arrayValue(goods.naicsList)
    .map((value) => asRecord(value))
    .map((value) => ({
      code: textValue(value.naicsCode),
      description: textValue(value.naicsDescription),
      sbaSmallBusiness: booleanValue(value.sbaSmallBusiness),
    }))
    .filter(
      (value): value is { code: string; description: string | null; sbaSmallBusiness: boolean | null } =>
        value.code !== null,
    );
  const primaryRaw = goods.primaryNaics;
  const primaryRecord = asRecord(primaryRaw);
  const primaryCode =
    textValue(primaryRecord.naicsCode) ?? textValue(primaryRaw);
  const primaryNaics = primaryCode === null
    ? null
    : naics.find(({ code }) => code === primaryCode) ?? {
        code: primaryCode,
        description: textValue(primaryRecord.naicsDescription),
        sbaSmallBusiness: booleanValue(primaryRecord.sbaSmallBusiness),
      };
  const psc = arrayValue(goods.pscList)
    .map((value) => {
      if (typeof value === "string") return { code: value, description: null };
      const record = asRecord(value);
      return {
        code: textValue(record.pscCode),
        description:
          textValue(record.pscDescription) ?? textValue(record.pscName),
      };
    })
    .filter(
      (value): value is { code: string; description: string | null } =>
        value.code !== null,
    );

  return {
    legalName:
      textValue(registration.legalBusinessName) ?? signal.rawName,
    uei,
    cageCode: textValue(registration.cageCode) ?? signal.cage,
    officialUrl: textValue(information.entityURL),
    officialDomain: signal.rawDomain,
    addressLine1: textValue(address.addressLine1),
    addressLine2: textValue(address.addressLine2),
    city: textValue(address.city) ?? signal.city,
    state: textValue(address.stateOrProvinceCode) ?? signal.state,
    zip: joinZip(textValue(address.zipCode), textValue(address.zipCodePlus4)),
    country:
      textValue(address.countryCode) ?? textValue(address.country) ?? signal.country,
    registrationStatus: textValue(registration.registrationStatus),
    exclusionStatusFlag: booleanValue(registration.exclusionStatusFlag),
    primaryNaics,
    naics: primaryNaics === null
      ? naics
      : [primaryNaics, ...naics.filter(({ code }) => code !== primaryNaics.code)],
    psc,
    entityTypeHints: collectScalarHints(assertions.entityTypes),
    businessTypeHints: collectScalarHints(assertions.businessTypes),
    ownershipHints: collectScalarHints(assertions.ownershipAndControl),
    parentUei: findParentUei(payload),
    sourceLocator: signal.sourceLocator,
    raw: payload,
  };
}

function faaRecordsFromPayload(payload: Record<string, unknown>): FaaPmaRecord[] {
  const possible = Array.isArray(payload.records)
    ? payload.records
    : payload.record === undefined
      ? [payload]
      : [payload.record];
  const records: FaaPmaRecord[] = [];
  for (const value of possible) {
    const parsed = faaPmaRecordSchema.safeParse(value);
    if (!parsed.success) {
      throw new SynthesisPreconditionError(
        `FAA source signal payload is invalid: ${parsed.error.issues[0]?.message ?? "unknown contract error"}`,
      );
    }
    records.push(parsed.data);
  }
  if (records.length === 0) {
    throw new SynthesisPreconditionError("FAA source signal contains no PMA records");
  }
  return records;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function uniqueIds(values: readonly (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function textValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim();
  return normalized === "" ? null : normalized;
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : null;
  if (typeof value !== "string") return null;
  if (/^(?:true|yes|y|1)$/iu.test(value.trim())) return true;
  if (/^(?:false|no|n|0)$/iu.test(value.trim())) return false;
  return null;
}

function joinZip(zip: string | null, plusFour: string | null): string | null {
  if (zip === null) return null;
  return plusFour === null || zip.endsWith(`-${plusFour}`) ? zip : `${zip}-${plusFour}`;
}

function collectScalarHints(value: unknown): string[] {
  const hints: string[] = [];
  const visit = (nested: unknown): void => {
    if (typeof nested === "string") {
      const normalized = textValue(nested);
      if (normalized !== null) hints.push(normalized);
      return;
    }
    if (Array.isArray(nested)) {
      for (const item of nested) visit(item);
      return;
    }
    if (nested !== null && typeof nested === "object") {
      for (const [key, item] of Object.entries(nested as Record<string, unknown>)) {
        if (item === true) hints.push(key);
        else visit(item);
      }
    }
  };
  visit(value);
  return [...new Set(hints)];
}

function findParentUei(payload: Record<string, unknown>): string | null {
  const visit = (value: unknown, key = ""): string | null => {
    if (/parent.*uei|uei.*parent/iu.test(key)) {
      const identifier = textValue(value);
      if (identifier !== null) return identifier;
    }
    if (Array.isArray(value)) {
      for (const nested of value) {
        const found = visit(nested, key);
        if (found !== null) return found;
      }
    } else if (value !== null && typeof value === "object") {
      for (const [nestedKey, nested] of Object.entries(value as Record<string, unknown>)) {
        const found = visit(nested, nestedKey);
        if (found !== null) return found;
      }
    }
    return null;
  };
  return visit(payload);
}
