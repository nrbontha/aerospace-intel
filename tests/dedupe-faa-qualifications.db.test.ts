import { createHash } from "node:crypto";

import { count, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import {
  auditEvents,
  closeDatabase,
  companies,
  dataSources,
  entityMerges,
  evidence,
  facilities,
  facilityQualifications,
  getDatabase,
  parts,
  sourceDocumentLinks,
  sourceDocuments,
} from "../packages/database/src/index.js";
import { dedupeFaaQualifications } from "../scripts/dedupe-faa-qualifications.mts";

const DB_TESTS_ENABLED = process.env.ASI_DB_TESTS === "1";
const testKey = `faa-qualification-dedupe-${Date.now()}-${Math.random().toString(16).slice(2)}`;

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe.skipIf(!DB_TESTS_ENABLED)("FAA qualification dedupe script (DB)", () => {
  afterAll(async () => {
    await closeDatabase();
  });

  it("dry-runs then idempotently merges only matching draft versions while preserving every document, evidence row, and link", async () => {
    const db = getDatabase();
    const [company] = await db
      .insert(companies)
      .values({ legalName: testKey, displayName: testKey })
      .returning({ id: companies.id });
    if (company === undefined) throw new Error("dedupe test company insert failed");
    const [facility] = await db
      .insert(facilities)
      .values({
        companyId: company.id,
        name: `${testKey} facility`,
        facilityType: "faa_pma_holder",
        countryCode: "US",
        status: "draft",
      })
      .returning({ id: facilities.id });
    if (facility === undefined) throw new Error("dedupe test facility insert failed");
    const insertedParts = await db
      .insert(parts)
      .values([
        {
          manufacturerCompanyId: company.id,
          partNumber: "RAM-DEDUP-1",
          lifecycleStatus: "draft",
        },
        {
          manufacturerCompanyId: company.id,
          partNumber: "RAM-DEDUP-2",
          lifecycleStatus: "draft",
        },
      ])
      .returning({ id: parts.id, partNumber: parts.partNumber });
    const firstPart = insertedParts.find(({ partNumber }) => partNumber === "RAM-DEDUP-1");
    const secondPart = insertedParts.find(({ partNumber }) => partNumber === "RAM-DEDUP-2");
    if (firstPart === undefined || secondPart === undefined) {
      throw new Error("dedupe test parts insert failed");
    }

    const qualifications = await db
      .insert(facilityQualifications)
      .values([
        {
          facilityId: facility.id,
          partId: firstPart.id,
          qualificationReference: "FAA-PMA:PQ9000:S-10:TRANSIENT-GUID-A",
          status: "draft",
          validFrom: "2024-01-01",
        },
        {
          facilityId: facility.id,
          partId: firstPart.id,
          qualificationReference: "FAA-PMA:PQ9000:S-10:TRANSIENT-GUID-B",
          status: "draft",
          validFrom: "2024-01-02",
        },
        {
          facilityId: facility.id,
          partId: firstPart.id,
          qualificationReference: "FAA-PMA:PQ9000:S-10:TRANSIENT-GUID-ACTIVE",
          status: "active",
          validFrom: "2024-01-03",
        },
        {
          facilityId: facility.id,
          partId: firstPart.id,
          qualificationReference: "FAA-PMA:PQ9000:S-11:TRANSIENT-GUID-C",
          status: "draft",
          validFrom: "2024-01-04",
        },
        {
          facilityId: facility.id,
          partId: secondPart.id,
          qualificationReference: "FAA-PMA:PQ9000:S-10:TRANSIENT-GUID-D",
          status: "draft",
          validFrom: "2024-01-05",
        },
        {
          facilityId: facility.id,
          partId: firstPart.id,
          qualificationReference: "FAA-PMA:PQ9001:S-10:TRANSIENT-GUID-E",
          status: "draft",
          validFrom: "2024-01-06",
        },
      ])
      .returning({
        id: facilityQualifications.id,
        reference: facilityQualifications.qualificationReference,
      });
    const older = qualifications.find(({ reference }) => reference.endsWith("GUID-A"));
    const moreLinked = qualifications.find(({ reference }) => reference.endsWith("GUID-B"));
    if (older === undefined || moreLinked === undefined) {
      throw new Error("dedupe test qualification insert failed");
    }

    const [source] = await db
      .insert(dataSources)
      .values({
        name: testKey,
        sourceType: "test",
        publisher: testKey,
        ingestion: "import",
      })
      .returning({ id: dataSources.id });
    if (source === undefined) throw new Error("dedupe test source insert failed");
    const documents = await db
      .insert(sourceDocuments)
      .values(["one", "two", "three"].map((version) => ({
        dataSourceId: source.id,
        canonicalUrl: `https://example.test/${testKey}/${version}`,
        contentSha256: digest(`${testKey}-${version}`),
        documentType: "faa_drs_pma_record",
      })))
      .returning({ id: sourceDocuments.id });
    await db.insert(evidence).values(
      documents.map(({ id }, index) => ({
        sourceDocumentId: id,
        extractionStatus: "completed" as const,
        quote: `qualification evidence ${index}`,
        locator: `card-${index}`,
        extractionMethod: "test",
      })),
    );
    await db.insert(sourceDocumentLinks).values([
      {
        sourceDocumentId: documents[0]!.id,
        facilityQualificationId: older.id,
        relationship: "approves_qualification",
      },
      {
        sourceDocumentId: documents[1]!.id,
        facilityQualificationId: moreLinked.id,
        relationship: "approves_qualification",
      },
      {
        sourceDocumentId: documents[2]!.id,
        facilityQualificationId: moreLinked.id,
        relationship: "approves_qualification",
      },
    ]);

    const dryRun = await dedupeFaaQualifications(db, {
      companyId: company.id,
    });
    expect(dryRun.mode).toBe("dry-run");
    expect(dryRun.plans).toHaveLength(1);
    expect(dryRun.plans[0]).toMatchObject({
      stableReference: "FAA-PMA:PQ9000:S-10:RAM-DEDUP-1",
      survivor: { id: moreLinked.id, sourceLinkCount: 2 },
      duplicates: [{ id: older.id }],
    });
    const beforeApply = await db
      .select({ value: count() })
      .from(facilityQualifications)
      .where(eq(facilityQualifications.facilityId, facility.id));
    expect(beforeApply[0]?.value).toBe(6);

    const applied = await dedupeFaaQualifications(db, {
      companyId: company.id,
      apply: true,
    });
    expect(applied).toMatchObject({
      mode: "apply",
      mergedQualificationCount: 1,
      repointedSourceLinkCount: 1,
    });
    const remaining = await db
      .select({
        id: facilityQualifications.id,
        status: facilityQualifications.status,
        reference: facilityQualifications.qualificationReference,
        partId: facilityQualifications.partId,
      })
      .from(facilityQualifications)
      .where(eq(facilityQualifications.facilityId, facility.id));
    expect(remaining).toHaveLength(5);
    expect(remaining).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: moreLinked.id,
          status: "draft",
          reference: "FAA-PMA:PQ9000:S-10:RAM-DEDUP-1",
        }),
        expect.objectContaining({ status: "active" }),
        expect.objectContaining({ reference: expect.stringContaining(":S-11:") }),
        expect.objectContaining({ partId: secondPart.id }),
        expect.objectContaining({
          reference: expect.stringContaining("FAA-PMA:PQ9001:S-10:"),
        }),
      ]),
    );
    const preservedLinks = await db
      .select({
        documentId: sourceDocumentLinks.sourceDocumentId,
        qualificationId: sourceDocumentLinks.facilityQualificationId,
      })
      .from(sourceDocumentLinks)
      .where(inArray(sourceDocumentLinks.sourceDocumentId, documents.map(({ id }) => id)));
    expect(preservedLinks).toHaveLength(3);
    expect(
      preservedLinks.every(({ qualificationId }) => qualificationId === moreLinked.id),
    ).toBe(true);
    const [documentCount] = await db
      .select({ value: count() })
      .from(sourceDocuments)
      .where(inArray(sourceDocuments.id, documents.map(({ id }) => id)));
    const [evidenceCount] = await db
      .select({ value: count() })
      .from(evidence)
      .where(inArray(evidence.sourceDocumentId, documents.map(({ id }) => id)));
    expect({ documents: documentCount?.value, evidence: evidenceCount?.value }).toEqual({
      documents: 3,
      evidence: 3,
    });
    const [mergeCount] = await db
      .select({ value: count() })
      .from(entityMerges)
      .where(eq(entityMerges.targetEntityId, moreLinked.id));
    const [auditCount] = await db
      .select({ value: count() })
      .from(auditEvents)
      .where(eq(auditEvents.entityType, "entity_merge"));
    expect(mergeCount?.value).toBe(1);
    expect(auditCount?.value).toBeGreaterThanOrEqual(1);

    const replay = await dedupeFaaQualifications(db, {
      companyId: company.id,
      apply: true,
    });
    expect(replay).toMatchObject({
      mode: "apply",
      plans: [],
      mergedQualificationCount: 0,
      repointedSourceLinkCount: 0,
    });
  });
});
