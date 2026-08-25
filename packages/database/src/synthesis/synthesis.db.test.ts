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
  researchQuestions,
  sourceDocumentLinks,
  sourceDocuments,
  sourceSignals,
  users,
} from "../schema.js";
import {
  acceptSynthesisGroup,
  getCompanySynthesisTrail,
  rejectSynthesisGroup,
  SynthesisConflictError,
  SynthesisStaleGroupError,
  synthesizeQualifiedSourceSignal,
} from "./index.js";
import {
  parseFaaAddress,
  persistFaaPmaRecordsForCompany,
} from "./faa.js";
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
  it("reuses one stable qualification across transient DRS GUID versions while separating part and supplement identities", async () => {
    const companyId = await createCompany(`${testKey} FAA Version Company`);
    const holderNumber = `VG${testKey.slice(-7)}`.toUpperCase();
    const firstVersion = faaRecord("VERSION-1", {
      holderNumber,
      pmaPartNumber: "RAM-101-1",
      supplementNumber: "S-42",
      renderedSourceText: `${testKey} FAA version one`,
    });
    const secondVersion = {
      ...firstVersion,
      recordId: `${testKey}-TRANSIENT-GUID-2`,
      guidUrl: `https://drs.faa.gov/browse/excelExternalWindow/${encodeURIComponent(testKey)}-version-2`,
      renderedSourceText: `${testKey} FAA version two`,
    };
    const differentSupplement = {
      ...firstVersion,
      recordId: `${testKey}-TRANSIENT-GUID-3`,
      guidUrl: `https://drs.faa.gov/browse/excelExternalWindow/${encodeURIComponent(testKey)}-version-3`,
      supplementNumber: "S-43",
      supplementDate: "2025-02-03",
      renderedSourceText: `${testKey} FAA version three`,
    };
    const differentPart = {
      ...firstVersion,
      recordId: `${testKey}-TRANSIENT-GUID-4`,
      guidUrl: `https://drs.faa.gov/browse/excelExternalWindow/${encodeURIComponent(testKey)}-version-4`,
      pmaPartNumber: "RAM-101-2",
      renderedSourceText: `${testKey} FAA version four`,
    };

    await persistFaaPmaRecordsForCompany(getDatabase(), companyId, [
      firstVersion,
      secondVersion,
      differentSupplement,
      differentPart,
    ]);
    const qualifications = await getDatabase()
      .select({
        id: facilityQualifications.id,
        reference: facilityQualifications.qualificationReference,
      })
      .from(facilityQualifications)
      .innerJoin(
        facilities,
        eq(facilities.id, facilityQualifications.facilityId),
      )
      .where(eq(facilities.companyId, companyId));
    expect(qualifications).toHaveLength(3);
    const stable = qualifications.find(
      ({ reference }) =>
        reference === `FAA-PMA:${holderNumber}:S-42:RAM-101-1`,
    );
    expect(stable).toBeDefined();
    const versionDocuments = await getDatabase()
      .select({ id: sourceDocuments.id })
      .from(sourceDocuments)
      .where(
        inArray(sourceDocuments.canonicalUrl, [
          firstVersion.guidUrl,
          secondVersion.guidUrl,
        ]),
      );
    expect(versionDocuments).toHaveLength(2);
    const versionLinks = await getDatabase()
      .select({
        documentId: sourceDocumentLinks.sourceDocumentId,
        qualificationId: sourceDocumentLinks.facilityQualificationId,
      })
      .from(sourceDocumentLinks)
      .where(
        and(
          inArray(
            sourceDocumentLinks.sourceDocumentId,
            versionDocuments.map(({ id }) => id),
          ),
          eq(sourceDocumentLinks.facilityQualificationId, stable!.id),
        ),
      );
    expect(new Set(versionLinks.map(({ documentId }) => documentId)).size).toBe(
      2,
    );
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
  it("rejects every pending proposal for one document without a partial review", async () => {
    const companyId = await createCompany(`${testKey} Rejection Company`);
    const entity = samEntity({
      uei: `${testKey}J`.slice(-12).toUpperCase(),
      cageCode: null,
      sourceLocator: `sam://entity-information/v4/entities/${testKey}-reject`,
      raw: {
        entityRegistration: {
          ueiSAM: `${testKey}J`.slice(-12).toUpperCase(),
          legalBusinessName: `${testKey} Rejection Company`,
        },
        key: `${testKey}-reject`,
      },
    });
    const persisted = await persistSamEntityForCompany(
      getDatabase(),
      companyId,
      entity,
    );
    const expected = await pendingObservationIds(persisted.sourceDocumentId);

    await expect(
      rejectSynthesisGroup(getDatabase(), {
        companyId,
        sourceDocumentId: persisted.sourceDocumentId,
        reviewerId,
        expectedObservationIds: expected.slice(1),
        reason: "Stale browser state",
      }),
    ).rejects.toBeInstanceOf(SynthesisStaleGroupError);
    expect(await pendingObservationIds(persisted.sourceDocumentId)).toEqual(
      expected,
    );

    const rejected = await rejectSynthesisGroup(getDatabase(), {
      companyId,
      sourceDocumentId: persisted.sourceDocumentId,
      reviewerId,
      expectedObservationIds: expected,
      reason: "Entity record belongs to a different review scope",
    });
    expect(rejected).toEqual({
      rejectedProposalCount: expected.length,
      observationIds: expected,
    });
    const proposalStatuses = await getDatabase()
      .select({ status: researchProposals.status })
      .from(researchProposals)
      .innerJoin(
        observations,
        eq(observations.id, researchProposals.observationId),
      )
      .innerJoin(evidence, eq(evidence.id, observations.evidenceId))
      .where(eq(evidence.sourceDocumentId, persisted.sourceDocumentId));
    expect(proposalStatuses).toHaveLength(expected.length);
    expect(
      proposalStatuses.every(({ status }) => status === "rejected"),
    ).toBe(true);
  });

  it("parses the scraper's exact RAM pipe address", () => {
    expect(
      parseFaaAddress(
        "1450 Aviation Drive | St. George | UT | 84790 | United States",
      ),
    ).toEqual({
      addressLine1: "1450 Aviation Drive",
      addressLine2: null,
      city: "St. George",
      region: "UT",
      postalCode: "84790",
      countryCode: "US",
    });
  });

  it("hydrates one blank draft FAA facility on replay and refuses a conflicting complete address", async () => {
    const companyId = await createCompany(`${testKey} Hydration Company`);
    const initial = faaRecord("HYDRATE", {
      holderName: `${testKey} Hydration Holder`,
      holderNumber: `HY${testKey.slice(-7)}`.toUpperCase(),
      fullAddress: null,
      renderedSourceText: `${testKey} stable hydrated FAA source`,
    });
    const first = await persistFaaPmaRecordsForCompany(
      getDatabase(),
      companyId,
      [initial],
    );
    expect(first.created.facilities).toBe(1);
    const [blank] = await getDatabase()
      .select({
        id: facilities.id,
        addressLine1: facilities.addressLine1,
        status: facilities.status,
      })
      .from(facilities)
      .where(eq(facilities.companyId, companyId));
    expect(blank).toMatchObject({ addressLine1: null, status: "draft" });

    const hydrated = {
      ...initial,
      fullAddress:
        "1450 Aviation Drive | St. George | UT | 84790 | United States",
    };
    const hydration = await persistFaaPmaRecordsForCompany(
      getDatabase(),
      companyId,
      [hydrated],
    );
    expect(hydration.reused.facilities).toBe(1);
    expect(hydration.gaps.filter(({ field }) => field === "facility")).toEqual(
      [],
    );
    const hydratedFacilities = await getDatabase()
      .select({
        id: facilities.id,
        addressLine1: facilities.addressLine1,
        city: facilities.city,
        region: facilities.region,
        postalCode: facilities.postalCode,
        countryCode: facilities.countryCode,
      })
      .from(facilities)
      .where(eq(facilities.companyId, companyId));
    expect(hydratedFacilities).toEqual([
      {
        id: blank!.id,
        addressLine1: "1450 Aviation Drive",
        city: "St. George",
        region: "UT",
        postalCode: "84790",
        countryCode: "US",
      },
    ]);
    const [document] = await getDatabase()
      .select({ id: sourceDocuments.id })
      .from(sourceDocuments)
      .where(eq(sourceDocuments.canonicalUrl, initial.guidUrl));
    if (document === undefined) throw new Error("hydration document is missing");
    const addressEvidence = await getDatabase()
      .select({ id: observations.id })
      .from(observations)
      .innerJoin(evidence, eq(evidence.id, observations.evidenceId))
      .where(
        and(
          eq(evidence.sourceDocumentId, document.id),
          eq(observations.subjectId, blank!.id),
          eq(observations.fieldKey, "registered_address"),
        ),
      );
    expect(addressEvidence).toHaveLength(1);

    const conflicting = {
      ...hydrated,
      fullAddress:
        "999 Conflict Road | Phoenix | AZ | 85001 | United States",
    };
    const conflict = await persistFaaPmaRecordsForCompany(
      getDatabase(),
      companyId,
      [conflicting],
    );
    expect(conflict.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recordId: initial.recordId,
          field: "facility",
          reason: expect.stringContaining("conflicts"),
        }),
      ]),
    );
    const afterConflict = await getDatabase()
      .select({
        id: facilities.id,
        addressLine1: facilities.addressLine1,
        city: facilities.city,
        region: facilities.region,
        postalCode: facilities.postalCode,
      })
      .from(facilities)
      .where(eq(facilities.companyId, companyId));
    expect(afterConflict).toEqual([
      {
        id: blank!.id,
        addressLine1: "1450 Aviation Drive",
        city: "St. George",
        region: "UT",
        postalCode: "84790",
      },
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
  it("reads SAM and FAA source groups, evidence states, qualification graph, conflicts, and gaps in one trail", async () => {
    const companyId = await createCompany(`${testKey} Trail Company`);
    const entity = samEntity({
      uei: `${testKey}T`.slice(-12).toUpperCase(),
      cageCode: `${testKey}Z`.slice(-5).toUpperCase(),
      sourceLocator: `sam://entity-information/v4/entities/${testKey}-trail`,
      raw: {
        entityRegistration: {
          ueiSAM: `${testKey}T`.slice(-12).toUpperCase(),
          legalBusinessName: `${testKey} Trail Company`,
        },
        key: `${testKey}-trail`,
      },
    });
    await persistSamEntityForCompany(getDatabase(), companyId, entity);
    const faa = faaRecord("TRAIL", {
      holderNumber: `${testKey}T`.slice(-9).toUpperCase(),
      make: "Unresolved Trail Make",
      models: ["Unresolved Trail Model"],
    });
    await persistFaaPmaRecordsForCompany(getDatabase(), companyId, [faa]);
    await getDatabase().insert(researchQuestions).values({
      companyId,
      question: "Confirm the current beneficial owner",
      priority: "90",
    });
    const [legalNameEvidence] = await getDatabase()
      .select({ evidenceId: observations.evidenceId })
      .from(observations)
      .where(
        and(
          eq(observations.subjectType, "company"),
          eq(observations.subjectId, companyId),
          eq(observations.fieldKey, "legal_name"),
        ),
      )
      .limit(1);
    if (legalNameEvidence === undefined) {
      throw new Error("test legal-name evidence was not inserted");
    }
    await getDatabase().insert(observations).values({
      subjectType: "company",
      subjectId: companyId,
      fieldKey: "legal_name",
      valueKind: "text",
      value: `${testKey} Conflicting Legal Name`,
      normalizedText: `${testKey} Conflicting Legal Name`,
      confidence: "1",
      evidenceId: legalNameEvidence.evidenceId,
      conflictStatus: "confirmed",
    });

    const draftTrail = await getCompanySynthesisTrail(companyId);
    expect(draftTrail).not.toBeNull();
    expect(draftTrail?.sourceRecords.map(({ sourceKey }) => sourceKey)).toEqual(
      expect.arrayContaining(["sam_entity", "faa_drs_pma"]),
    );
    expect(draftTrail?.identifiers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "UEI",
          value: entity.uei,
          status: "pending",
          officialUrl: expect.any(String),
        }),
      ]),
    );
    expect(draftTrail?.qualifications).toEqual([
      expect.objectContaining({
        holderNumber: faa.holderNumber,
        materializationStatus: "draft",
        part: expect.objectContaining({
          number: faa.pmaPartNumber,
          replacementFor: faa.replacementPartNumber,
        }),
        make: faa.make,
        models: faa.models,
        approvalBasis: faa.approvalBasis,
      }),
    ]);
    expect(draftTrail?.conflicts).toEqual([
      expect.objectContaining({ field: "Legal Name" }),
    ]);
    expect(draftTrail?.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          question: "Confirm the current beneficial owner",
          priority: "high",
        }),
        expect.objectContaining({
          question: expect.stringContaining("Resolve the exact platform"),
        }),
      ]),
    );

    const faaSource = draftTrail!.sourceRecords.find(
      ({ sourceKey }) => sourceKey === "faa_drs_pma",
    )!;
    await acceptSynthesisGroup(getDatabase(), {
      companyId,
      sourceDocumentId: faaSource.id,
      reviewerId,
      expectedObservationIds: faaSource.expectedObservationIds,
    });
    const activeTrail = await getCompanySynthesisTrail(companyId);
    expect(activeTrail?.qualifications[0]?.materializationStatus).toBe("active");
    expect(activeTrail?.sourceRecords.find(({ id }) => id === faaSource.id)?.status).toBe(
      "accepted",
    );
    expect(activeTrail?.confidence).toMatchObject({
      sourceCount: 2,
      primarySourceCount: 2,
      conflictCount: 1,
    });
  });

});
