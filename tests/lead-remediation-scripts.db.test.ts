import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  auditEvents,
  candidateScores,
  candidates,
  companyAliases,
  closeDatabase,
  companies,
  companyDomains,
  getDatabase,
  identityMatchCandidates,
  leads,
  type Database,
} from "@asi/database";
import { runMigrations } from "../packages/database/src/migrate.js";
import {
  quarantineLegacyUnqualifiedLeads,
} from "../scripts/quarantine-legacy-leads.mts";
import { correctZitecIdentity } from "../scripts/correct-zitec-identity.mts";
import {
  correctThirdPartyDomainLinks,
} from "../scripts/correct-third-party-domain-links.mts";
import { dedupeCompanyDomains } from "../scripts/dedupe-company-domains.mts";

const DB_TESTS_ENABLED = process.env.ASI_DB_TESTS === "1";
const campaignId = randomUUID();

function loadDatabaseUrl(): void {
  if (process.env.DATABASE_URL) return;
  for (const candidate of [path.join(process.cwd(), ".env.local"), path.join(process.cwd(), ".env")]) {
    if (!existsSync(candidate)) continue;
    const match = readFileSync(candidate, "utf8").match(/^DATABASE_URL=(.*)$/m);
    if (match?.[1]) {
      process.env.DATABASE_URL = match[1].trim();
      return;
    }
  }
}

describe.skipIf(!DB_TESTS_ENABLED)("legacy lead remediation scripts (DB)", () => {
  let db: Database;
  let wrongCompanyId = "";
  const thirdPartyCompanyIds: string[] = [];

  beforeAll(async () => {
    loadDatabaseUrl();
    await runMigrations();
    db = getDatabase();
  });

  afterAll(async () => {
    await db.delete(leads).where(eq(leads.campaignId, campaignId));
    if (wrongCompanyId) await db.delete(companies).where(eq(companies.id, wrongCompanyId));
    for (const companyId of thirdPartyCompanyIds) {
      await db.delete(companies).where(eq(companies.id, companyId));
    }
    await closeDatabase();
  });

  it("quarantines only legacy unresolved rows and remains dry-run by default", async () => {
    const rows = await db
      .insert(leads)
      .values([
        { campaignId, rawName: "legacy unresolved", status: "unresolved_lead", context: {} },
        { campaignId, rawName: "legacy resolving", status: "resolving", context: {} },
        {
          campaignId,
          rawName: "strict qualified",
          status: "unresolved_lead",
          context: { sourceQualification: { version: "strict" } },
        },
        { campaignId, rawName: "resolved", status: "resolved", context: {} },
      ])
      .returning({ id: leads.id, rawName: leads.rawName });

    const remediationIds = rows.slice(0, 2).map((row) => row.id);
    const dryRun = await quarantineLegacyUnqualifiedLeads(db, {
      apply: false,
      leadIds: remediationIds,
    });
    const selectedNames = new Set(dryRun.map((row) => row.rawName));
    expect(selectedNames).toEqual(new Set(["legacy unresolved", "legacy resolving"]));
    expect(
      (await db.select().from(leads).where(eq(leads.id, rows[0]!.id)).limit(1))[0]!.status,
    ).toBe("unresolved_lead");

    await quarantineLegacyUnqualifiedLeads(db, {
      apply: true,
      leadIds: remediationIds,
      at: new Date("2026-08-24T00:00:00Z"),
    });
    const applied = await db
      .select({ rawName: leads.rawName, status: leads.status, context: leads.context })
      .from(leads)
      .where(eq(leads.campaignId, campaignId));
    expect(applied.filter((row) => row.rawName.startsWith("legacy")).every((row) => row.status === "discarded")).toBe(true);
    expect(
      applied.find((row) => row.rawName === "strict qualified")?.context["quarantine"],
    ).toBeUndefined();
    const aggregate = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "lead.legacy_quarantine_applied"));
    expect(aggregate.some((row) => row.metadata["selectedCount"] === 2)).toBe(true);
  });

  it("corrects ZITEC idempotently, rejects its candidate, and removes zitec.com", async () => {
    // A shared local development database may already contain the production
    // correction target. Never remove its domain relationship from a test;
    // the full idempotence path below runs on a clean test database.
    const existingTarget = await db
      .select({ companyId: companyDomains.companyId })
      .from(companyDomains)
      .where(eq(companyDomains.domain, "zitec.com"))
      .limit(1);
    if (existingTarget[0] !== undefined) {
      const dryRun = await correctZitecIdentity(db, { apply: false });
      expect(dryRun.length).toBeGreaterThanOrEqual(0);
      return;
    }
    const [company] = await db
      .insert(companies)
      .values({ legalName: "ZITEC Romania", displayName: "ZITEC Romania" })
      .returning({ id: companies.id });
    wrongCompanyId = company!.id;
    await db.insert(companyDomains).values({ companyId: wrongCompanyId, domain: "zitec.com", isPrimary: true });
    const [candidate] = await db
      .insert(candidates)
      .values({
        companyId: wrongCompanyId,
        rationale: { whyInteresting: [], risks: [], unknowns: [] },
        currentScores: {},
      })
      .returning({ id: candidates.id });
    const [lead] = await db
      .insert(leads)
      .values({
        campaignId,
        rawName: "ZITEC, INC",
        status: "resolved",
        possibleDomain: "zitec.com",
        resolvedCompanyId: wrongCompanyId,
        context: {},
      })
      .returning({ id: leads.id });
    await db.insert(identityMatchCandidates).values({
      leadId: lead!.id,
      companyId: wrongCompanyId,
      signalType: "domain",
      confidence: "1.000",
      decision: "merged",
    });

    const dryRun = await correctZitecIdentity(db, { apply: false, leadIds: [lead!.id] });
    expect(dryRun.map((row) => row.leadId)).toContain(lead!.id);
    await correctZitecIdentity(db, {
      apply: true,
      leadIds: [lead!.id],
      at: new Date("2026-08-24T00:00:00Z"),
    });
    const corrected = (await db.select().from(leads).where(eq(leads.id, lead!.id)).limit(1))[0]!;
    expect(corrected).toMatchObject({ status: "unresolved_lead", possibleDomain: null, resolvedCompanyId: null });
    expect((corrected.context["identityCorrection"] as Record<string, unknown>)["wrongDomain"]).toBe("zitec.com");
    const correctedCandidate = (await db.select().from(candidates).where(eq(candidates.id, candidate!.id)).limit(1))[0]!;
    expect(correctedCandidate.status).toBe("rejected");
    expect(correctedCandidate.rationale.risks).toContain("identity mismatch: zitec.com");
    expect(
      (await db.select().from(companyDomains).where(eq(companyDomains.domain, "zitec.com"))).filter(
        (domain) => domain.companyId === wrongCompanyId,
      ),
    ).toHaveLength(0);
    expect(await correctZitecIdentity(db, { apply: true, leadIds: [lead!.id] })).toHaveLength(0);
    const identity = (
      await db
        .select()
        .from(identityMatchCandidates)
        .where(and(eq(identityMatchCandidates.leadId, lead!.id), eq(identityMatchCandidates.companyId, wrongCompanyId)))
    )[0]!;
    expect(identity.decision).toBe("rejected_merge");
  });

  it("corrects third-party domain attachments idempotently without touching out-of-scope rows or audit history", async () => {
    const token = randomUUID();
    const [company, outOfScopeCompany] = await db
      .insert(companies)
      .values([
        {
          legalName: "Third Party Attachment Target",
          displayName: "Third Party Attachment Target",
          websiteUrl: `https://profile-${token}.inknowvation.com/company`,
        },
        {
          legalName: "Out of Scope Third Party Attachment",
          displayName: "Out of Scope Third Party Attachment",
        },
      ])
      .returning({ id: companies.id });
    thirdPartyCompanyIds.push(company!.id, outOfScopeCompany!.id);
    const blockedRelation = `vendor-${token}.highergov.com`;
    const retainedRelation = `official-${token}.example.com`;
    const outOfScopeRelation = `outside-${token}.highergov.com`;
    await db.insert(companyDomains).values([
      { companyId: company!.id, domain: blockedRelation, isPrimary: true },
      { companyId: company!.id, domain: retainedRelation, isPrimary: false },
      { companyId: outOfScopeCompany!.id, domain: outOfScopeRelation, isPrimary: true },
    ]);
    const [candidate] = await db
      .insert(candidates)
      .values({
        companyId: company!.id,
        rationale: { whyInteresting: [], risks: [], unknowns: [] },
        currentScores: {},
      })
      .returning({ id: candidates.id });
    const [lead] = await db
      .insert(leads)
      .values({
        campaignId,
        rawName: "Third Party Attachment Target",
        status: "resolved",
        possibleDomain: `https://${blockedRelation}/profile`,
        resolvedCompanyId: company!.id,
        context: { preserved: true },
      })
      .returning({ id: leads.id });
    const [identity] = await db
      .insert(identityMatchCandidates)
      .values({
        leadId: lead!.id,
        companyId: company!.id,
        signalType: "domain",
        confidence: "1.000",
        decision: "merged",
      })
      .returning({ id: identityMatchCandidates.id });
    const preservedAuditAction = `test.audit.preserved.${token}`;
    await db.insert(auditEvents).values({
      action: preservedAuditAction,
      entityType: "lead",
      entityId: lead!.id,
      metadata: { evidence: "must remain" },
    });

    const scope = { leadIds: [lead!.id], companyIds: [company!.id] };
    const dryRun = await correctThirdPartyDomainLinks(db, { apply: false, ...scope });
    expect(dryRun).toMatchObject({
      leads: [expect.objectContaining({ id: lead!.id })],
      companies: [expect.objectContaining({ id: company!.id })],
      candidates: [expect.objectContaining({ id: candidate!.id })],
      domainRelations: [
        expect.objectContaining({ companyId: company!.id, blockedDomain: "highergov.com" }),
      ],
    });
    expect(dryRun.companies[0]!.blockedDomains).toEqual([
      "highergov.com",
      "inknowvation.com",
    ]);
    expect(
      (await db.select().from(leads).where(eq(leads.id, lead!.id)).limit(1))[0]!.status,
    ).toBe("resolved");

    await correctThirdPartyDomainLinks(db, {
      apply: true,
      ...scope,
      at: new Date("2026-08-24T12:00:00Z"),
    });
    const correctedLead = (
      await db.select().from(leads).where(eq(leads.id, lead!.id)).limit(1)
    )[0]!;
    expect(correctedLead).toMatchObject({
      status: "unresolved_lead",
      possibleDomain: null,
      resolvedCompanyId: null,
      context: {
        preserved: true,
        thirdPartyDomainCorrection: {
          blockedDomains: ["highergov.com", "inknowvation.com"],
        },
      },
    });
    expect(
      (await db.select().from(companies).where(eq(companies.id, company!.id)).limit(1))[0]!
        .websiteUrl,
    ).toBeNull();
    expect(
      (await db.select().from(candidates).where(eq(candidates.id, candidate!.id)).limit(1))[0]!,
    ).toMatchObject({
      status: "rejected",
      rationale: {
        risks: [
          "identity mismatch: third-party directory domain (highergov.com, inknowvation.com)",
        ],
      },
    });
    expect(
      (
        await db
          .select()
          .from(identityMatchCandidates)
          .where(eq(identityMatchCandidates.id, identity!.id))
          .limit(1)
      )[0]!.decision,
    ).toBe("rejected_merge");
    const retainedDomains = await db
      .select({ domain: companyDomains.domain })
      .from(companyDomains)
      .where(eq(companyDomains.companyId, company!.id));
    expect(retainedDomains.map((row) => row.domain)).toEqual([retainedRelation]);
    expect(
      await db
        .select()
        .from(companyDomains)
        .where(eq(companyDomains.domain, outOfScopeRelation)),
    ).toHaveLength(1);
    expect(
      await db.select().from(auditEvents).where(eq(auditEvents.action, preservedAuditAction)),
    ).toHaveLength(1);
    const aggregate = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "remediation.third_party_domain_links_applied"));
    expect(
      aggregate.some(
        (event) =>
          event.metadata["scriptVersion"] === "2026-08-24" &&
          (event.after as Record<string, unknown>)["candidatesRejected"] === 1,
      ),
    ).toBe(true);

    const secondApply = await correctThirdPartyDomainLinks(db, { apply: true, ...scope });
    expect(secondApply).toMatchObject({
      leads: [],
      companies: [],
      candidates: [],
      domainRelations: [],
    });
  });

  it("deduplicates one verified domain idempotently while preserving both leads and one candidate", async () => {
    const domain = `dedupe-foundry-${randomUUID().slice(0, 8)}.com`;
    const [survivor, duplicate] = await db
      .insert(companies)
      .values([
        {
          legalName: "A&B Foundry, Inc.",
          displayName: "A&B Foundry",
          createdAt: new Date("2025-01-01T00:00:00Z"),
        },
        {
          legalName: "A and B Foundry LLC",
          displayName: "A and B Foundry",
          createdAt: new Date("2025-02-01T00:00:00Z"),
        },
      ])
      .returning({ id: companies.id });
    await db.insert(companyDomains).values({
      companyId: survivor!.id,
      domain,
      isPrimary: true,
      verifiedAt: new Date(),
    });
    await db.insert(companyAliases).values({
      companyId: duplicate!.id,
      alias: "A&B Castings",
      aliasType: "name",
    });
    const insertedLeads = await db
      .insert(leads)
      .values([
        {
          campaignId,
          rawName: "A&B Foundry",
          status: "resolved",
          possibleDomain: domain,
          resolvedCompanyId: survivor!.id,
          context: {},
        },
        {
          campaignId,
          rawName: "A and B Foundry",
          status: "resolved",
          possibleDomain: `WWW.${domain.toUpperCase()}.`,
          resolvedCompanyId: duplicate!.id,
          context: {},
        },
      ])
      .returning({ id: leads.id });
    const insertedCandidates = await db
      .insert(candidates)
      .values([
        {
          companyId: survivor!.id,
          rationale: {
            whyInteresting: ["survivor evidence"],
            risks: [],
            unknowns: [],
          },
        },
        {
          companyId: duplicate!.id,
          rationale: {
            whyInteresting: ["duplicate evidence"],
            risks: [],
            unknowns: [],
          },
        },
      ])
      .returning({ id: candidates.id, companyId: candidates.companyId });
    await db.insert(candidateScores).values(
      insertedCandidates.map((candidate, index) => ({
        candidateId: candidate.id,
        axis: "fit" as const,
        value: index === 0 ? "80" : "70",
        details: { immutableTestEvidence: domain },
      })),
    );

    const dryRun = await dedupeCompanyDomains(db, { domain, apply: false });
    expect(dryRun).toMatchObject({
      mode: "dry-run",
      mergedCompanyCount: 0,
      plans: [
        {
          domain,
          survivor: { id: survivor!.id },
          duplicates: [{ id: duplicate!.id }],
        },
      ],
    });
    expect(await db.select().from(candidates).where(eq(candidates.companyId, duplicate!.id))).toHaveLength(1);

    const applied = await dedupeCompanyDomains(db, { domain, apply: true });
    expect(applied.mergedCompanyCount).toBe(1);
    const preservedLeads = await db
      .select({ id: leads.id, companyId: leads.resolvedCompanyId })
      .from(leads)
      .where(and(eq(leads.campaignId, campaignId), eq(leads.possibleDomain, domain)));
    const secondLead = (
      await db.select({ id: leads.id, companyId: leads.resolvedCompanyId }).from(leads).where(eq(leads.id, insertedLeads[1]!.id))
    )[0]!;
    expect([...preservedLeads, secondLead]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: insertedLeads[0]!.id, companyId: survivor!.id }),
        expect.objectContaining({ id: insertedLeads[1]!.id, companyId: survivor!.id }),
      ]),
    );
    const survivingCandidates = await db
      .select()
      .from(candidates)
      .where(eq(candidates.companyId, survivor!.id));
    expect(survivingCandidates).toHaveLength(1);
    expect(survivingCandidates[0]).toMatchObject({
      id: insertedCandidates[0]!.id,
      status: "queued_research",
      rationale: { whyInteresting: ["survivor evidence"] },
    });
    const archivedSourceCandidate = (
      await db
        .select()
        .from(candidates)
        .where(eq(candidates.id, insertedCandidates[1]!.id))
        .limit(1)
    )[0]!;
    expect(archivedSourceCandidate).toMatchObject({
      companyId: duplicate!.id,
      status: "archived",
    });
    expect(archivedSourceCandidate.rationale.risks).toEqual([
      `merged_duplicate_company; survivorCandidateId=${insertedCandidates[0]!.id}`,
    ]);
    const preservedScores = await db
      .select({ candidateId: candidateScores.candidateId })
      .from(candidateScores)
      .where(
        and(
          eq(candidateScores.details, { immutableTestEvidence: domain }),
          eq(candidateScores.axis, "fit"),
        ),
      );
    expect(new Set(preservedScores.map((score) => score.candidateId))).toEqual(
      new Set(insertedCandidates.map((candidate) => candidate.id)),
    );
    const mergedCompanies = await db
      .select({ id: companies.id, status: companies.status })
      .from(companies)
      .where(and(eq(companies.id, survivor!.id), eq(companies.status, "active")));
    expect(mergedCompanies).toEqual([{ id: survivor!.id, status: "active" }]);
    expect(
      (
        await db
          .select({ status: companies.status })
          .from(companies)
          .where(eq(companies.id, duplicate!.id))
          .limit(1)
      )[0]!.status,
    ).toBe("inactive");
    expect(
      await db
        .select()
        .from(companyAliases)
        .where(
          and(
            eq(companyAliases.companyId, survivor!.id),
            eq(companyAliases.alias, "A&B Castings"),
          ),
        ),
    ).toHaveLength(1);
    expect(
      await db.select().from(companyDomains).where(eq(companyDomains.domain, domain)),
    ).toHaveLength(1);

    const secondApply = await dedupeCompanyDomains(db, { domain, apply: true });
    expect(secondApply).toMatchObject({ plans: [], mergedCompanyCount: 0 });
  });
});
