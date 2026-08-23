/**
 * DB-gated integration suite for the lead pipeline:
 * strategy → frontier → ingestLeadCandidates → identity resolution → review.
 *
 *   ASI_DB_TESTS=1 npx vitest run tests/leads.db.test.ts
 *
 * Requires the docker compose database with migrations. No network, no
 * OpenRouter calls: the USAspending client is replaced by a fake injected
 * into UsaspendingDiscoveryStrategy, and lead candidates are synthetic.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  applyIdentityMatchDecision,
  closeDatabase,
  companies,
  companyDomains,
  frontierItems,
  getDatabase,
  IdentityMatchAlreadyDecidedError,
  ingestCampaignLeadsFromFrontier,
  ingestLeadCandidates,
  leads,
  researchCampaigns,
} from "@asi/database";
import {
  applyLifecycleAction,
  createCampaign,
  processDueItems,
  UsaspendingDiscoveryStrategy,
  type LeadCandidate,
} from "@asi/research";
import { runMigrations } from "../packages/database/src/migrate.js";

const DB_TESTS_ENABLED = process.env.ASI_DB_TESTS === "1";
const repoPath = (suffix: string) => path.join(process.cwd(), suffix);

function loadDatabaseUrl(): void {
  if (process.env.DATABASE_URL !== undefined && process.env.DATABASE_URL !== "") return;
  for (const candidate of [repoPath(".env.local"), repoPath(".env")]) {
    if (!existsSync(candidate)) continue;
    for (const line of readFileSync(candidate, "utf8").split("\n")) {
      const match = /^DATABASE_URL=(.*)$/.exec(line.trim());
      if (match?.[1] !== undefined) {
        process.env.DATABASE_URL = match[1].trim();
        return;
      }
    }
  }
}

function candidate(
  overrides: Partial<LeadCandidate> & Pick<LeadCandidate, "rawName">,
): LeadCandidate {
  return {
    awardCount: 2,
    totalAwardValueUsd: 50_000,
    source: "usaspending",
    sourceLocator: `usaspending://spending_by_award?recipient_name=${encodeURIComponent(overrides.rawName)}`,
    ...overrides,
  };
}

async function loadLeads(campaignId: string) {
  return getDatabase()
    .select()
    .from(leads)
    .where(eq(leads.campaignId, campaignId))
    .orderBy(leads.createdAt);
}

describe.skipIf(!DB_TESTS_ENABLED)("lead pipeline (DB)", () => {
  const createdCampaignIds: string[] = [];
  let exactDomainCompanyId: string;

  beforeAll(async () => {
    loadDatabaseUrl();
    await runMigrations();
    const db = getDatabase();

    // Known-universe seed #1: company resolvable by exact domain.

    // Known-universe seed #1: company resolvable by exact domain.
    const existingSeed = await db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.displayName, "Existing Aero Parts Inc"))
      .limit(1);
    if (existingSeed[0] !== undefined) {
      exactDomainCompanyId = existingSeed[0].id;
    } else {
      const [exactCompany] = await db
        .insert(companies)
        .values({
          legalName: "Existing Aero Parts Inc",
          displayName: "Existing Aero Parts Inc",
          headquartersCountryCode: "US",
        })
        .returning({ id: companies.id });
      await db.insert(companyDomains).values({
        companyId: exactCompany!.id,
        domain: "existing-aero-parts.test",
        isPrimary: true,
      });
      exactDomainCompanyId = exactCompany!.id;
    }

    // Known-universe seed #2: same legal name as an incoming fuzzy lead —
    // pg_trgm similarity 1.0 → probable, pending review.
    const existingProbable = await db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.displayName, "Probable Gears LLC"))
      .limit(1);
    if (existingProbable[0] === undefined) {
      await db.insert(companies).values({
        legalName: "Probable Gears LLC",
        displayName: "Probable Gears LLC",
        headquartersCountryCode: "US",
      });
    }
  });

  afterAll(async () => {
    await closeDatabase();
  });

  afterEach(async () => {
    for (const id of createdCampaignIds.splice(0)) {
      await getDatabase()
        .delete(researchCampaigns)
        .where(eq(researchCampaigns.id, id));
    }
  });

  it("ingests five synthetic candidates into the right resolution buckets", async () => {
    const summary = await ingestLeadCandidates(randomUUID(), [
      // 1. exact domain hit against the seeded company.
      candidate({ rawName: "Existing Aero Parts Inc", domain: "existing-aero-parts.test" }),
      // 2. trigram name match → probable, requires review.
      candidate({ rawName: "Probable Gears LLC" }),
      // 3. brand-new recipient with a real domain → canonical company created.
      candidate({ rawName: `New Domain Foundry ${randomUUID().slice(0, 8)}`, domain: "new-domain-foundry.test" }),
      // 4./5. no domain and no signals → unresolved_lead.
      candidate({ rawName: "No Signal Casting Co", city: "Wichita", state: "KS" }),
      candidate({ rawName: "Another Unknown Shop" }),
    ]);

    expect(summary).toEqual({
      created: 5,
      resolvedExact: 2,
      probableReview: 1,
      unresolved: 2,
      duplicateSkipped: 0,
    });
  });

  it("assigns statuses, merged/pending match rows and provenance", async () => {
    const campaignId = randomUUID();
    // Unique per run: a rerun must not trigram-collide with the company a
    // previous invocation auto-created for this same case.
    const newName = `New Domain Foundry ${randomUUID().slice(0, 8)}`;
    try {
      await ingestLeadCandidates(campaignId, [
        candidate({ rawName: "Existing Aero Parts Inc", domain: "existing-aero-parts.test" }),
        candidate({ rawName: "Probable Gears LLC" }),
        candidate({ rawName: newName, domain: `new-foundry-${campaignId.slice(0, 8)}.test` }),
        candidate({ rawName: "No Signal Casting Co" }),
        candidate({ rawName: "Another Unknown Shop" }),
      ]);
      const rows = await loadLeads(campaignId);
      expect(rows).toHaveLength(5);
      const byName = new Map(rows.map((row) => [row.rawName, row]));

      const exact = byName.get("Existing Aero Parts Inc")!;
      expect(exact.status).toBe("resolved");
      expect(exact.resolvedCompanyId).toBe(exactDomainCompanyId);
      const exactMatches = await getDatabase().execute<{ decision: string }>(sql`
        SELECT decision FROM identity_match_candidates WHERE lead_id = ${exact.id}
      `);
      expect(exactMatches.rows).toHaveLength(1);
      expect(exactMatches.rows[0]!.decision).toBe("merged");

      const probable = byName.get("Probable Gears LLC")!;
      expect(probable.status).toBe("resolving");
      expect(probable.resolvedCompanyId).toBeNull();

      const created = byName.get(newName)!;
      expect(created.status).toBe("resolved");
      expect(created.resolvedCompanyId).not.toBeNull();
      expect(created.context["provenance"]).toMatchObject({
        canonicalCompanyCreated: true,
      });
      // Auto-promoted onto the scored-candidate pipeline.
      const candidateRows = await getDatabase().execute<{ c: number }>(
        sql`SELECT count(*)::int AS c FROM candidates WHERE company_id = ${created.resolvedCompanyId!}`,
      );
      expect(candidateRows.rows[0]?.c).toBe(1);

      expect(byName.get("No Signal Casting Co")!.status).toBe("unresolved_lead");
      expect(byName.get("Another Unknown Shop")!.status).toBe("unresolved_lead");
    } finally {
      await getDatabase().delete(leads).where(eq(leads.campaignId, campaignId));
    }
  });

  it("is idempotent: a second run skips everything as duplicates", async () => {
    const campaignId = randomUUID();
    const batch = [
      candidate({ rawName: "Existing Aero Parts Inc", domain: "existing-aero-parts.test" }),
      candidate({ rawName: "Probable Gears LLC" }),
      candidate({ rawName: "No Signal Casting Co" }),
    ];
    try {
      const first = await ingestLeadCandidates(campaignId, batch);
      expect(first.created).toBe(3);
      const second = await ingestLeadCandidates(campaignId, batch);
      expect(second).toEqual({
        created: 0,
        resolvedExact: 0,
        probableReview: 0,
        unresolved: 0,
        duplicateSkipped: 3,
      });
      expect(await loadLeads(campaignId)).toHaveLength(3);
    } finally {
      await getDatabase().delete(leads).where(eq(leads.campaignId, campaignId));
    }
  });

  it("review flow: merges a probable match and updates its lead", async () => {
    const campaignId = randomUUID();
    try {
      await ingestLeadCandidates(campaignId, [
        candidate({ rawName: "Probable Gears LLC" }),
      ]);
      const [probableLead] = await loadLeads(campaignId);
      const pending = await getDatabase().execute<{ id: string; company_id: string }>(sql`
        SELECT id, company_id FROM identity_match_candidates WHERE lead_id = ${probableLead!.id}
      `);
      const matchId = pending.rows[0]!.id;
      const expectedCompanyId = pending.rows[0]!.company_id;

      const result = await applyIdentityMatchDecision(matchId, {
        decision: "merged",
        decidedBy: null,
        note: "Confirmed via state registry.",
      });
      expect(result.decision).toBe("merged");

      const [updated] = await getDatabase()
        .select()
        .from(leads)
        .where(eq(leads.id, probableLead!.id));
      expect(updated!.status).toBe("resolved");
      expect(updated!.resolvedCompanyId).toBe(expectedCompanyId);

      // Second decision on the same row is rejected.
      await expect(
        applyIdentityMatchDecision(matchId, { decision: "rejected_merge", decidedBy: null }),
      ).rejects.toBeInstanceOf(IdentityMatchAlreadyDecidedError);
    } finally {
      await getDatabase().delete(leads).where(eq(leads.campaignId, campaignId));
    }
  });

  it("strategy → frontier → ingest happy path through processDueItems", async () => {
    const recipients: LeadCandidate[] = [
      candidate({
        rawName: "Existing Aero Parts Inc",
        uei: "EXACTUEI00001",
        domain: "existing-aero-parts.test",
      }),
      candidate({ rawName: "Fresh Federal Machining", uei: "FRESHUEI000001" }),
    ];
    const strategy = new UsaspendingDiscoveryStrategy({
      client: { searchRecipients: () => Promise.resolve(recipients) },
    });

    const created = await createCampaign({
      name: `vitest-leads-${randomUUID().slice(0, 8)}`,
      budgetUsd: 100,
      maxDepth: 1,
      concurrency: 4,
    });
    const campaignId = created.id;

    // Seed one due query item BEFORE starting (start requires ≥1 item).
    await getDatabase().insert(frontierItems).values({
      campaignId,
      itemType: "query",
      normalizedValue: "usaspending:aerospace-components-default",
      depth: 0,
      status: "pending",
      payload: {
        source: "usaspending",
        naics: ["336413"],
        timePeriod: { startDate: "2025-01-01", endDate: "2025-12-31" },
      },
    });
    await applyLifecycleAction(campaignId, "start");

    const slice = await processDueItems(campaignId, {
      strategy,
      now: () => new Date(),
      dailySpendUsd: 0,
    });
    expect(slice.childrenInserted).toBe(2);

    const summary = await ingestCampaignLeadsFromFrontier(campaignId);
    // Exact-domain lead resolves to the seeded company; the fresh one has
    // no domain so it stays unresolved pending company creation.
    expect(summary).toEqual({
      created: 2,
      resolvedExact: 1,
      probableReview: 0,
      unresolved: 1,
      duplicateSkipped: 0,
    });
    const rows = await loadLeads(campaignId);
    const exact = rows.find((row) => row.rawName === "Existing Aero Parts Inc");
    expect(exact?.status).toBe("resolved");
    expect(exact?.resolvedCompanyId).toBe(exactDomainCompanyId);
  });
});
