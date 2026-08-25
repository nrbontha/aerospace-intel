import type { FaaPmaRecord } from "@asi/contracts";
import { and, count, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "../client.js";
import {
  companies,
  companyIdentifiers,
  companyDomains,
  evidence,
  facilities,
  facilityQualifications,
  observations,
  partAlternateIds,
  parts,
  platformVariants,
  platforms,
  researchProposals,
  sourceDocumentLinks,
  sourceDocuments,
  sourceSignals,
  users,
} from "../schema.js";
import {
  acceptSynthesisGroup,
  SynthesisConflictError,
  SynthesisStaleGroupError,
  synthesizeQualifiedSourceSignal,
} from "./index.js";
import { persistFaaPmaRecordsForCompany } from "./faa.js";
import {
  persistSamEntityForCompany,
  type SamEntityForSynthesis,
} from "./sam.js";

const DB_TESTS_ENABLED = process.env.ASI_DB_TESTS === "1";
const testKey = `synthesis-${Date.now()}-${Math.random().toString(16).slice(2)}`;

function samEntity(overrides: Partial<SamEntityForSynthesis> = {}): SamEntityForSynthesis {
  return {
    legalName: `${testKey} SAM Supplier`,
    uei: `${testKey}-UEI`.slice(-12).toUpperCase(),
    cageCode: `${testKey.slice(-5)}`.toUpperCase(),
    officialUrl: "https://unverified-sam-example.test/about",
    officialDomain: "unverified-sam-example.test",
    addressLine1: " 100   Flight Way ",
    addressLine2: null,
    city: " Wichita ",
    state: "ks",
    zip: "67209",
    country: "USA",
    registrationStatus: "ACTIVE",
    exclusionStatusFlag: false,
    primaryNaics: { code: "336413", description: "Aircraft parts", sbaSmallBusiness: true },
    naics: [{ code: "336413", description: "Aircraft parts", sbaSmallBusiness: true }],
    psc: [{ code: "1560", description: "Airframe components" }],
    entityTypeHints: ["Business or Organization"],
    businessTypeHints: ["Small Business"],
    ownershipHints: ["Privately Owned"],
    parentUei: "PARENTUEI123",
    sourceLocator: `sam://entity-information/v4/entities/${testKey}`,
    raw: {
      entityRegistration: {
        ueiSAM: `${testKey}-UEI`.slice(-12).toUpperCase(),
        legalBusinessName: `${testKey} SAM Supplier`,
      },
      key: testKey,
    },
    ...overrides,
  };
}

function faaRecord(
  suffix: string,
  overrides: Partial<FaaPmaRecord> = {},
): FaaPmaRecord {
  return {
    recordId: `${testKey}-${suffix}`,
    guidUrl: `https://drs.faa.gov/browse/excelExternalWindow/${encodeURIComponent(testKey)}-${suffix}`,
    status: "Active",
    subStatus: "Current",
    holderName: `${testKey} PMA Supplier`,
    holderNumber: `${testKey.slice(-8)}H`.toUpperCase(),
    fullAddress: "1450 Aviation Drive\nSt. George, UT 84790\nUnited States",
    pmaPartNumber: `PMA-${suffix}`,
    partName: `Valve ${suffix}`,
    replacementPartNumber: "OEM-SHARED-100",
    make: "No Exact Make",
    models: ["No Exact Model"],
    supplementNumber: `S-${suffix}`,
    supplementDate: "2025-01-02",
    approvalBasis: "Test and computation per 14 CFR 21.303",
    serviceOffice: "West Certification Branch",
    opr: "AIR-600",
    cfrReferences: ["14 CFR 21.303"],
    comments: null,
    renderedSourceText: `${testKey} rendered FAA PMA source ${suffix}`,
    ...overrides,
  };
}

async function createCompany(name: string): Promise<string> {
  const [company] = await getDatabase()
    .insert(companies)
    .values({ legalName: name, displayName: name })
    .returning({ id: companies.id });
  if (company === undefined) throw new Error("test company was not inserted");
  return company.id;
}

async function pendingObservationIds(sourceDocumentId: string): Promise<string[]> {
  const rows = await getDatabase()
    .select({ id: observations.id })
    .from(researchProposals)
    .innerJoin(observations, eq(observations.id, researchProposals.observationId))
    .innerJoin(evidence, eq(evidence.id, observations.evidenceId))
    .where(
      and(
        eq(evidence.sourceDocumentId, sourceDocumentId),
        eq(researchProposals.status, "pending"),
      ),
    );
  return rows.map(({ id }) => id).sort();
}

describe.skipIf(!DB_TESTS_ENABLED)("source synthesis persistence (DB)", () => {
  let reviewerId = "";

  beforeAll(async () => {
    const [reviewer] = await getDatabase()
      .insert(users)
      .values({
        email: `${testKey}@example.test`,
        displayName: "Synthesis Reviewer",
        passwordHash: "not-a-real-password-hash",
        role: "admin",
      })
      .returning({ id: users.id });
    if (reviewer === undefined) throw new Error("test reviewer was not inserted");
    reviewerId = reviewer.id;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("persists exact SAM identifiers and one normalized draft registered address without verifying its URL", async () => {
    const companyId = await createCompany(`${testKey} SAM Company`);
    const entity = samEntity();
    const first = await persistSamEntityForCompany(getDatabase(), companyId, entity);
    const replay = await persistSamEntityForCompany(getDatabase(), companyId, entity);

    expect(first.created.document).toBe(true);
    expect(replay.reused.document).toBe(true);
    const identifiers = await getDatabase()
      .select({ type: companyIdentifiers.type, value: companyIdentifiers.value })
      .from(companyIdentifiers)
      .where(eq(companyIdentifiers.companyId, companyId));
    expect(identifiers).toEqual(
      expect.arrayContaining([
        { type: "uei", value: entity.uei.trim().toUpperCase() },
        { type: "cage", value: entity.cageCode!.trim().toUpperCase() },
      ]),
    );
    const addressRows = await getDatabase()
      .select()
      .from(facilities)
      .where(eq(facilities.companyId, companyId));
    expect(addressRows).toHaveLength(1);
    expect(addressRows[0]).toMatchObject({
      addressLine1: "100 Flight Way",
      city: "Wichita",
      region: "KS",
      postalCode: "67209",
      countryCode: "US",
      status: "draft",
    });
    const [domainCount] = await getDatabase()
      .select({ value: count() })
      .from(companyDomains)
      .where(eq(companyDomains.companyId, companyId));
    expect(domainCount?.value).toBe(0);
    const observationCount = await getDatabase()
      .select({ value: count() })
      .from(observations)
      .innerJoin(evidence, eq(evidence.id, observations.evidenceId))
      .where(eq(evidence.sourceDocumentId, first.sourceDocumentId));
    expect(observationCount[0]?.value).toBe(first.created.observations);
  });

  it("commits quarantine evidence on an exact UEI conflict and never reassigns the identifier", async () => {
    const ownerCompanyId = await createCompany(`${testKey} UEI Owner`);
    const conflictingCompanyId = await createCompany(`${testKey} UEI Conflict`);
    const entity = samEntity({ uei: `${testKey}Q`.slice(-12).toUpperCase(), cageCode: null });
    await persistSamEntityForCompany(getDatabase(), ownerCompanyId, entity);
    const [signal] = await getDatabase()
      .insert(sourceSignals)
      .values({
        sourceKey: "sam_entity",
        sourceLocator: entity.sourceLocator,
        sourceFingerprint: `${testKey}-conflict-fingerprint`,
        rawName: entity.legalName,
        uei: entity.uei,
        sourcePayload: entity.raw,
        status: "qualified",
        companyId: conflictingCompanyId,
      })
      .returning({ id: sourceSignals.id });
    if (signal === undefined) throw new Error("test signal was not inserted");

    await expect(
      persistSamEntityForCompany(getDatabase(), conflictingCompanyId, entity, {
        sourceSignalId: signal.id,
      }),
    ).rejects.toBeInstanceOf(SynthesisConflictError);
    const [identifier] = await getDatabase()
      .select({ companyId: companyIdentifiers.companyId })
      .from(companyIdentifiers)
      .where(
        and(
          eq(companyIdentifiers.type, "uei"),
          eq(companyIdentifiers.value, entity.uei),
        ),
      );
    expect(identifier?.companyId).toBe(ownerCompanyId);
    const [quarantined] = await getDatabase()
      .select({ status: sourceSignals.status })
      .from(sourceSignals)
      .where(eq(sourceSignals.id, signal.id));
    expect(quarantined?.status).toBe("quarantined");
  });

  it("replays an idempotent FAA document graph and scopes a shared OEM replacement to each supplier part", async () => {
    const companyId = await createCompany(`${testKey} FAA Company`);
    const records = [faaRecord("A"), faaRecord("B")];
    const first = await persistFaaPmaRecordsForCompany(getDatabase(), companyId, records);
    const replay = await persistFaaPmaRecordsForCompany(getDatabase(), companyId, records);

    expect(first.createdCount).toBe(2);
    expect(replay.reusedCount).toBe(2);
    expect(replay.created.observations).toBe(0);
    const supplierParts = await getDatabase()
      .select({ id: parts.id })
      .from(parts)
      .where(eq(parts.manufacturerCompanyId, companyId));
    expect(supplierParts).toHaveLength(2);
    const replacementRows = await getDatabase()
      .select({ partId: partAlternateIds.partId })
      .from(partAlternateIds)
      .where(
        and(
          inArray(partAlternateIds.partId, supplierParts.map(({ id }) => id)),
          eq(partAlternateIds.identifierValue, "OEM-SHARED-100"),
        ),
      );
    expect(new Set(replacementRows.map(({ partId }) => partId)).size).toBe(2);

    const qualificationRows = await getDatabase()
      .select({ id: facilityQualifications.id })
      .from(facilityQualifications)
      .innerJoin(facilities, eq(facilities.id, facilityQualifications.facilityId))
      .where(eq(facilities.companyId, companyId));
    expect(qualificationRows).toHaveLength(2);
    for (const record of records) {
      const [document] = await getDatabase()
        .select({ id: sourceDocuments.id })
        .from(sourceDocuments)
        .where(eq(sourceDocuments.canonicalUrl, record.guidUrl));
      expect(document).toBeDefined();
      const links = await getDatabase()
        .select()
        .from(sourceDocumentLinks)
        .where(eq(sourceDocumentLinks.sourceDocumentId, document!.id));
      expect(links.some(({ companyId: linked }) => linked === companyId)).toBe(true);
      expect(links.some(({ facilityId }) => facilityId !== null)).toBe(true);
      expect(links.some(({ partId }) => partId !== null)).toBe(true);
      expect(links.some(({ facilityQualificationId }) => facilityQualificationId !== null)).toBe(true);
    }
  });

  it("does not attach an exact model variant when the exact make is mismatched", async () => {
    const supplierCompanyId = await createCompany(`${testKey} Variant Supplier`);
    const makerCompanyId = await createCompany(`${testKey} Exact Maker`);
    const [platform] = await getDatabase()
      .insert(platforms)
      .values({ name: "Exact Platform", manufacturerCompanyId: makerCompanyId })
      .returning({ id: platforms.id });
    if (platform === undefined) throw new Error("test platform was not inserted");
    await getDatabase().insert(platformVariants).values({
      platformId: platform.id,
      name: "Exact Model 100",
    });
    const result = await persistFaaPmaRecordsForCompany(getDatabase(), supplierCompanyId, [
      faaRecord("MISMATCH", {
        holderNumber: `${testKey}M`.slice(-9).toUpperCase(),
        make: "Different Maker",
        models: ["Exact Model 100"],
      }),
    ]);
    expect(result.gaps).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "platform" })]),
    );
    const [qualification] = await getDatabase()
      .select({
        platformId: facilityQualifications.platformId,
        variantId: facilityQualifications.platformVariantId,
      })
      .from(facilityQualifications)
      .innerJoin(facilities, eq(facilities.id, facilityQualifications.facilityId))
      .where(eq(facilities.companyId, supplierCompanyId));
    expect(qualification).toEqual({ platformId: null, variantId: null });
  });

  it("rejects stale grouped acceptance without partial activation, then atomically accepts and activates the complete graph", async () => {
    const companyId = await createCompany(`${testKey} Acceptance Company`);
    const record = faaRecord("ACCEPT", {
      holderNumber: `${testKey}A`.slice(-9).toUpperCase(),
    });
    const persisted = await persistFaaPmaRecordsForCompany(getDatabase(), companyId, [record]);
    expect(persisted.createdCount).toBe(1);
    const [document] = await getDatabase()
      .select({ id: sourceDocuments.id })
      .from(sourceDocuments)
      .where(eq(sourceDocuments.canonicalUrl, record.guidUrl));
    if (document === undefined) throw new Error("FAA test document was not inserted");
    const expected = await pendingObservationIds(document.id);
    expect(expected.length).toBeGreaterThan(5);

    await expect(
      acceptSynthesisGroup(getDatabase(), {
        companyId,
        sourceDocumentId: document.id,
        reviewerId,
        expectedObservationIds: expected.slice(1),
      }),
    ).rejects.toBeInstanceOf(SynthesisStaleGroupError);
    expect(await pendingObservationIds(document.id)).toEqual(expected);
    const [draftQualification] = await getDatabase()
      .select({ status: facilityQualifications.status })
      .from(facilityQualifications)
      .innerJoin(facilities, eq(facilities.id, facilityQualifications.facilityId))
      .where(eq(facilities.companyId, companyId));
    expect(draftQualification?.status).toBe("draft");

    const accepted = await acceptSynthesisGroup(getDatabase(), {
      companyId,
      sourceDocumentId: document.id,
      reviewerId,
      expectedObservationIds: expected,
    });
    expect(accepted.acceptedProposalCount).toBe(expected.length);
    expect(accepted.activated).toEqual({ facilities: 1, parts: 1, qualifications: 1 });
    expect(await pendingObservationIds(document.id)).toEqual([]);
    const links = await getDatabase()
      .select({
        facilityId: sourceDocumentLinks.facilityId,
        partId: sourceDocumentLinks.partId,
        qualificationId: sourceDocumentLinks.facilityQualificationId,
      })
      .from(sourceDocumentLinks)
      .where(eq(sourceDocumentLinks.sourceDocumentId, document.id));
    const [activeFacility] = await getDatabase()
      .select({ status: facilities.status })
      .from(facilities)
      .where(eq(facilities.id, links.find(({ facilityId }) => facilityId !== null)!.facilityId!));
    const [activePart] = await getDatabase()
      .select({ status: parts.lifecycleStatus })
      .from(parts)
      .where(eq(parts.id, links.find(({ partId }) => partId !== null)!.partId!));
    const [activeQualification] = await getDatabase()
      .select({ status: facilityQualifications.status })
      .from(facilityQualifications)
      .where(
        eq(
          facilityQualifications.id,
          links.find(({ qualificationId }) => qualificationId !== null)!.qualificationId!,
        ),
      );
    expect([activeFacility?.status, activePart?.status, activeQualification?.status]).toEqual([
      "active",
      "active",
      "active",
    ]);
  });

  it("routes only qualified resolved known source keys and no-ops unknown sources", async () => {
    const companyId = await createCompany(`${testKey} Signal Router Company`);
    const [unknown] = await getDatabase()
      .insert(sourceSignals)
      .values({
        sourceKey: "some_future_source",
        sourceLocator: `future://${testKey}`,
        sourceFingerprint: `${testKey}-future`,
        rawName: `${testKey} Future Company`,
        sourcePayload: {},
        status: "queued_qualification",
      })
      .returning({ id: sourceSignals.id });
    if (unknown === undefined) throw new Error("unknown test signal was not inserted");
    await expect(synthesizeQualifiedSourceSignal(getDatabase(), unknown.id)).resolves.toEqual({
      status: "noop",
      sourceKey: "some_future_source",
    });

    const routedUei = `${testKey}R`.slice(-12).toUpperCase();
    const entity = samEntity({
      uei: routedUei,
      cageCode: null,
      raw: {
        entityRegistration: {
          ueiSAM: routedUei,
          legalBusinessName: `${testKey} Routed SAM Company`,
        },
        key: `${testKey}-router`,
      },
    });
    const [known] = await getDatabase()
      .insert(sourceSignals)
      .values({
        sourceKey: "sam_entity",
        sourceLocator: entity.sourceLocator,
        sourceFingerprint: `${testKey}-known-router`,
        rawName: entity.legalName,
        uei: entity.uei,
        city: entity.city,
        state: entity.state,
        country: entity.country,
        sourcePayload: entity.raw,
        status: "qualified",
        companyId,
      })
      .returning({ id: sourceSignals.id });
    if (known === undefined) throw new Error("known test signal was not inserted");
    const synthesized = await synthesizeQualifiedSourceSignal(getDatabase(), known.id);
    expect(synthesized).toMatchObject({ status: "materialized", sourceKey: "sam_entity" });
  });
});
