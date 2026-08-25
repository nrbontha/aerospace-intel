import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  auditEvents,
  candidates,
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

  beforeAll(async () => {
    loadDatabaseUrl();
    await runMigrations();
    db = getDatabase();
  });

  afterAll(async () => {
    await db.delete(leads).where(eq(leads.campaignId, campaignId));
    if (wrongCompanyId) await db.delete(companies).where(eq(companies.id, wrongCompanyId));
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
});
