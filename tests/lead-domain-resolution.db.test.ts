/**
 * DB-gated integration suite for lead domain resolution + discard.
 *
 *   ASI_DB_TESTS=1 npx vitest run tests/lead-domain-resolution.db.test.ts
 *
 * Requires the docker compose database with migrations. No network, no
 * OpenRouter: the DomainProber/DomainJudge are fakes injected into
 * resolveLeadDomain, including a synthetic homepage whose title carries the
 * company name so the deterministic text-overlap path verifies identity.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  discardLead,
  type Database,
  type LeadDomainDeps,
  LeadNotFoundError,
  LeadNotResolvableError,
  leads,
  type DomainAttempt,
  type DomainJudge,
  type DomainProber,
  type IdentityJudgment,
  resolveLeadDomain,
  ingestLeadCandidates,
  auditEvents,
  candidates,
  companies,
  closeDatabase,
  companyDomains,
  getDatabase,
  users,
} from "@asi/database";

import { runMigrations } from "../packages/database/src/migrate.js";
const DB_TESTS_ENABLED = process.env.ASI_DB_TESTS === "1";

function loadDatabaseUrl(): void {
  if (process.env.DATABASE_URL !== undefined && process.env.DATABASE_URL !== "") return;
  for (const candidate of [path.join(process.cwd(), ".env.local"), path.join(process.cwd(), ".env")]) {
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

// ---------------------------------------------------------------------------
// Fakes.
// ---------------------------------------------------------------------------

/** Maps URL host → served HTML; anything unlisted is DNS-dead. */
function fakeProber(pages: Record<string, string>): DomainProber {
  return {
    async fetchText(url) {
      const host = new URL(url).hostname.replace(/^www\./u, "");
      const html = pages[host];
      if (html === undefined) return { ok: false as const, error: "dns_failed" };
      return { ok: true as const, finalUrl: url, text: html };
    },
  };
}

function fakeJudge(
  proposals: string[] | Error,
  judgment: (leadName: string, pageText: string) => IdentityJudgment = () => ({
    matches: true,
    confidence: 0.9,
    locationMatches: "unknown",
    identifierMatches: "unknown",
    relationship: "exact",
    reason: "page clearly names this company",
  }),
): DomainJudge {
  return {
    async proposeDomains() {
      if (proposals instanceof Error) throw proposals;
      return proposals;
    },
    async judgeIdentity(leadName, pageText) {
      return judgment(leadName, pageText);
    },
  };
}

const noopLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
};

async function seedLead(
  db: Database,
  rawName: string,
  identity: {
    location?: string;
    identifiers?: unknown[];
    domain?: string;
    qualification?: unknown;
  } = {},
): Promise<string> {
  const [row] = await db
    .insert(leads)
    .values({
      campaignId: campaignId,
      rawName,
      status: "unresolved_lead",
      possibleDomain: identity.domain ?? null,
      possibleLocation: identity.location ?? null,
      possibleIdentifiers: identity.identifiers ?? [],
      context: {
        sourceLocator: `usaspending://spending_by_award?recipient_name=${encodeURIComponent(rawName)}`,
        awardCount: 3,
        ...(identity.qualification === undefined
          ? {}
          : { sourceQualification: identity.qualification }),
      },
    })
    .returning({ id: leads.id });
  if (row === undefined) throw new Error("lead insert failed");
  return row.id;
}

const campaignId = randomUUID();

describe.skipIf(!DB_TESTS_ENABLED)("lead domain resolution (DB)", () => {
  const companyIds: string[] = [];
  let db: Database;
  let actorId = "";
  let createdTestUserId: string | null = null;

  beforeAll(async () => {
    loadDatabaseUrl();
    await runMigrations();
    db = getDatabase();
    // audit_events.actor_user_id has an FK — use a real user as the analyst.
    const existing = await db.select({ id: users.id }).from(users).limit(1);
    if (existing[0] !== undefined) {
      actorId = existing[0].id;
    } else {
      const [created] = await db
        .insert(users)
        .values({
          email: `domain-resolution-tests-${randomUUID()}@example.test`,
          displayName: "Domain Resolution Tests",
          passwordHash: "test-only",
        })
        .returning({ id: users.id });
      createdTestUserId = created!.id;
      actorId = created!.id;
    }
  });
  afterAll(async () => {
    // audit_events is append-only (deny_immutable_record_change): resolved/
    // discarded audit rows are intentionally left behind, matching how the
    // other DB suites treat them.
    await db.delete(leads).where(eq(leads.campaignId, campaignId));
    if (companyIds.length > 0) {
      await db.delete(candidates).where(inArray(candidates.companyId, companyIds));
      await db.delete(companies).where(inArray(companies.id, companyIds));
    }
    if (createdTestUserId !== null) {
      await db.delete(users).where(eq(users.id, createdTestUserId));
    }
    await closeDatabase();
  });

  it("verifies a matching homepage end-to-end", async () => {
    const leadId = await seedLead(db, "Acme Aero Tooling LLC");
    // Unique domain per run: a crashed earlier run must not pin assertions
    // onto a leftover company row.
    const domain = `acme-aero-tooling-${randomUUID().slice(0, 8)}.com`;
    const deps: LeadDomainDeps = {
      prober: fakeProber({
        [domain]:
          "<html><head><title>Acme Aero Tooling LLC — Precision Tooling</title>" +
          '<meta name="description" content="Precision aerospace tooling"></head>' +
          "<body><h1>Acme Aero Tooling</h1><p>Welcome</p></body></html>",
      }),
      judge: fakeJudge([domain]),
      logger: noopLogger,
    };

    const result = await resolveLeadDomain(db, leadId, deps);
    expect(result.outcome).toBe("domain_verified");
    expect(result.domain).toBe(domain);

    const lead = (await db.select().from(leads).where(eq(leads.id, leadId)).limit(1))[0]!;
    expect(lead.status).toBe("resolved");
    expect(lead.possibleDomain).toBe(domain);
    expect(lead.resolvedCompanyId).toBe(result.companyId);

    const verification = lead.context["domainVerification"] as Record<string, unknown>;
    expect(verification["method"]).toBe("homepage-identity");
    expect(verification["url"]).toBe(`https://${domain}`);
    expect((verification["attempts"] as DomainAttempt[])[0]?.outcome).toBe("verified");

    // Company + primary verified domain.
    const company = (
      await db.select().from(companies).where(eq(companies.id, result.companyId!)).limit(1)
    )[0]!;
    companyIds.push(company.id);
    expect(company.displayName).toBe("Acme Aero Tooling LLC");
    expect(company.websiteUrl).toBe(`https://${domain}`);
    const domainRow = (
      await db.select().from(companyDomains).where(eq(companyDomains.domain, domain))
    )[0]!;
    expect(domainRow.isPrimary).toBe(true);
    expect(domainRow.verifiedAt).not.toBeNull();

    // Investment-free candidate shell.
    const candidate = (
      await db.select().from(candidates).where(eq(candidates.companyId, company.id)).limit(1)
    )[0]!;
    expect(result.candidateId).toBe(candidate.id);
    expect(candidate.status).toBe("queued_research");
    expect(candidate.rationale["unknowns"]).toEqual(["domain-verified, pending research"]);

    // System audit event with attempts summary.
    const audit = (
      await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, "lead.domain_resolved"))
    ).filter((row) => row.entityId === leadId)[0]!;
    expect(audit.actorUserId).toBeNull();
    expect(audit.metadata["domain"]).toBe(domain);
    expect(Array.isArray(audit.metadata["attempts"])).toBe(true);

    // Second call without force reports the existing resolution.
    const again = await resolveLeadDomain(db, leadId, deps);
    expect(again.outcome).toBe("already_resolved");
    expect(again.companyId).toBe(company.id);
  });

  it("verifies a qualified zitecusa.com signal before any domain proposal", async () => {
    const qualification = { queryVersion: "strict-v2", awardCount: 4, verified: true };
    const leadId = await seedLead(db, "ZITEC, INC", {
      domain: "zitecusa.com",
      location: "Niceville, FL",
      identifiers: [{ type: "cage", value: "1R9V9" }],
      qualification,
    });
    expect(
      (await db.select().from(leads).where(eq(leads.id, leadId)).limit(1))[0]?.possibleDomain,
    ).toBe("zitecusa.com");
    let proposalCalls = 0;
    const result = await resolveLeadDomain(db, leadId, {
      prober: fakeProber({
        "zitecusa.com": "ZITEC, INC Niceville, FL defense manufacturing CAGE 1R9V9.",
      }),
      judge: {
        async proposeDomains() {
          proposalCalls += 1;
          return ["zitecinc.com"];
        },
        async judgeIdentity() {
          return {
            matches: true,
            confidence: 0.99,
            locationMatches: true,
            identifierMatches: true,
            relationship: "exact",
            reason: "CAGE and Niceville location match",
          };
        },
      },
      logger: noopLogger,
    });
    expect(result.attempts[0]?.domain).toBe("zitecusa.com");
    expect(result).toMatchObject({ outcome: "domain_verified", domain: "zitecusa.com" });
    expect(proposalCalls).toBe(0);
    expect(result.attempts[0]).toMatchObject({
      source: "qualified_signal",
      qualificationEvidence: qualification,
    });
    companyIds.push(result.companyId!);
  });

  it("uses the proposer when no qualified possible_domain exists", async () => {
    const leadId = await seedLead(db, "Proposer Gearworks LLC");
    let proposalCalls = 0;
    const result = await resolveLeadDomain(db, leadId, {
      prober: fakeProber({
        "proposergearworks.com": "Proposer Gearworks LLC precision gears.",
      }),
      judge: {
        async proposeDomains() {
          proposalCalls += 1;
          return ["proposergearworks.com"];
        },
        async judgeIdentity() {
          return {
            matches: true,
            confidence: 0.9,
            locationMatches: "unknown",
            identifierMatches: "unknown",
            relationship: "exact",
            reason: "name matches",
          };
        },
      },
      logger: noopLogger,
    });
    expect(result.outcome).toBe("domain_verified");
    expect(proposalCalls).toBe(1);
    companyIds.push(result.companyId!);
  });

  it("re-verifies an already-resolved lead only under force", async () => {
    const leadId = await seedLead(db, "Bravo Machining Group Inc");
    const deps: LeadDomainDeps = {
      prober: fakeProber({
        "bravomachining.com":
          "<html><head><title>Bravo Machining Group Inc</title></head><body></body></html>",
      }),
      judge: fakeJudge(["bravomachining.com"]),
      logger: noopLogger,
    };

    const first = await resolveLeadDomain(db, leadId, deps);
    expect(first.outcome).toBe("domain_verified");
    companyIds.push(first.companyId!);

    const forced = await resolveLeadDomain(db, leadId, deps, { force: true });
    expect(forced.outcome).toBe("domain_verified");
    expect(forced.companyId).toBe(first.companyId);

    // Still exactly one candidate shell for the company (idempotent upsert).
    const shells = await db.select().from(candidates).where(eq(candidates.companyId, first.companyId!));
    expect(shells).toHaveLength(1);
  });

  it("leaves the lead unresolved with journaled attempts on mismatch", async () => {
    const leadId = await seedLead(db, "Charlie Hydraulics Co");
    const deps: LeadDomainDeps = {
      prober: fakeProber({
        "charliehydraulics.com":
          "<html><head><title>Buy cheap sneakers online</title><h2>Discount outlet</h2></head><body></body></html>",
      }),
      judge: fakeJudge(
        ["charliehydraulics.com"],
        () => ({
          matches: false,
          confidence: 0.85,
          locationMatches: "unknown",
          identifierMatches: "unknown",
          relationship: "mismatch",
          reason: "unrelated retailer",
        }),
      ),
      logger: noopLogger,
    };

    const result = await resolveLeadDomain(db, leadId, deps);
    expect(result.outcome).toBe("identity_mismatch");

    const lead = (await db.select().from(leads).where(eq(leads.id, leadId)).limit(1))[0]!;
    expect(lead.status).toBe("unresolved_lead");
    expect(lead.possibleDomain).toBeNull();
    const journal = (lead.context["domainVerification"] as Record<string, unknown>)[
      "attempts"
    ] as DomainAttempt[];
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({
      domain: "charliehydraulics.com",
      source: "llm",
      outcome: "identity_mismatch",
    });
  });

  it("falls back to deterministic domains when the proposer fails", async () => {
    const leadId = await seedLead(db, "Delta Gears LLC");
    const probedUrls: string[] = [];
    const deps: LeadDomainDeps = {
      prober: {
        async fetchText(url) {
          probedUrls.push(url);
          return { ok: false as const, error: "dns_failed" };
        },
      },
      judge: fakeJudge(new Error("model unavailable")),
      logger: noopLogger,
    };

    const result = await resolveLeadDomain(db, leadId, deps);
    expect(result.outcome).toBe("no_domain_found");
    expect(probedUrls).toEqual([
      "https://deltagears.com",
      "https://deltagears.net",
    ]);
    expect(result.attempts.every((attempt) => attempt.source === "fallback")).toBe(true);
    expect(result.attempts.every((attempt) => attempt.outcome === "unreachable")).toBe(true);

    const lead = (await db.select().from(leads).where(eq(leads.id, leadId)).limit(1))[0]!;
    expect(lead.status).toBe("unresolved_lead");
    const journal = (lead.context["domainVerification"] as Record<string, unknown>)[
      "attempts"
    ] as DomainAttempt[];
    expect(journal.map((attempt) => attempt.domain)).toEqual(["deltagears.com", "deltagears.net"]);
  });

  it("rejects garbage proposals but keeps model-sourced usable ones", async () => {
    const leadId = await seedLead(db, "Echo Fasteners Inc");
    const deps: LeadDomainDeps = {
      prober: fakeProber({
        "echofasteners.com":
          "<html><head><title>Echo Fasteners Inc — Industrial Fasteners</title></head><body></body></html>",
      }),
      judge: fakeJudge(["!!! not a domain !!!", "", "ECHOFASTENERS.COM"]),
      logger: noopLogger,
    };

    const result = await resolveLeadDomain(db, leadId, deps);
    expect(result.outcome).toBe("domain_verified");
    expect(result.domain).toBe("echofasteners.com");
    expect(result.attempts[0]?.source).toBe("llm");
    companyIds.push(result.companyId!);
  });

  it("attaches to the existing owner instead of duplicating a known domain", async () => {
    // Reuse-or-create: earlier crashed runs may have left this domain behind.
    const seededDomain = (
      await db
        .select({ companyId: companyDomains.companyId })
        .from(companyDomains)
        .where(eq(companyDomains.domain, "foobarstamping.com"))
        .limit(1)
    )[0];
    let existingId: string;
    if (seededDomain !== undefined) {
      existingId = seededDomain.companyId;
    } else {
      const [existing] = await db
        .insert(companies)
        .values({ legalName: "Foobar Stamping", displayName: "Foobar Stamping" })
        .returning({ id: companies.id });
      existingId = existing!.id;
      await db.insert(companyDomains).values({
        companyId: existing!.id,
        domain: "foobarstamping.com",
        isPrimary: true,
      });
    }
    if (!companyIds.includes(existingId)) companyIds.push(existingId);

    const leadId = await seedLead(db, "FOOBAR STAMPING CO");
    const deps: LeadDomainDeps = {
      prober: fakeProber({
        "foobarstamping.com": "<html><head><title>Foobar Stamping Co</title></head><body></body></html>",
      }),
      judge: fakeJudge(["foobarstamping.com"]),
      logger: noopLogger,
    };

    const result = await resolveLeadDomain(db, leadId, deps);
    expect(result.companyId).toBe(existingId);
  });

  it("rejects a ZITEC homonym despite full name overlap when its location conflicts", async () => {
    const leadId = await seedLead(db, "ZITEC, INC", {
      location: "Niceville, FL",
      identifiers: [{ type: "cage", value: "1R9V9" }],
    });
    const result = await resolveLeadDomain(db, leadId, {
      prober: fakeProber({
        "zitec.com":
          "ZITEC software development and digital transformation, Bucharest Romania, IT consulting.",
      }),
      judge: fakeJudge(["zitec.com"], () => ({
        matches: true,
        confidence: 0.99,
        locationMatches: false,
        identifierMatches: "unknown",
        relationship: "exact",
        reason: "Romanian software company conflicts with Niceville defense manufacturer",
      })),
      logger: noopLogger,
    });
    expect(result.outcome).toBe("identity_mismatch");
    expect(result.attempts[0]).toMatchObject({
      outcome: "identity_mismatch",
      locationMatches: false,
    });
  });

  it("verifies the US defense ZITEC site when location and CAGE match", async () => {
    const leadId = await seedLead(db, "ZITEC, INC", {
      location: "Niceville, FL",
      identifiers: [{ type: "cage", value: "1R9V9" }],
    });
    const result = await resolveLeadDomain(db, leadId, {
      prober: fakeProber({
        "zitecusa.com":
          "ZITEC, INC Niceville, FL defense manufacturer CAGE 1R9V9 aerospace components.",
      }),
      judge: fakeJudge(["zitecusa.com"], () => ({
        matches: true,
        confidence: 0.99,
        locationMatches: true,
        identifierMatches: true,
        relationship: "exact",
        reason: "Niceville location and CAGE 1R9V9 match the defense manufacturer",
      })),
      logger: noopLogger,
    });
    expect(result.outcome).toBe("domain_verified");
    expect(result.domain).toBe("zitecusa.com");
    companyIds.push(result.companyId!);
  });

  it("deduplicates four Yulista siblings onto one parent-brand domain owner", async () => {
    const names = [
      "YULISTA AVIATION, INC",
      "YULISTA CONTRACT SERVICES, LLC",
      "YULISTA SUPPORT SERVICES, LLC",
      "YULISTA AEROSPACE & DEFENSE, LLC",
    ];
    const deps: LeadDomainDeps = {
      prober: fakeProber({
        "yulista.com": "Yulista is a Calista company serving aviation, logistics, and defense.",
      }),
      judge: fakeJudge(["yulista.com"], () => ({
        matches: true,
        confidence: 0.95,
        locationMatches: true,
        identifierMatches: "unknown",
        relationship: "parent_brand",
        reason: "Yulista is the shared parent brand for the named subsidiary",
      })),
      logger: noopLogger,
    };
    const results = [];
    for (const name of names) {
      const leadId = await seedLead(db, name, { location: "Huntsville, AL" });
      results.push(await resolveLeadDomain(db, leadId, deps));
    }
    const companyIdsForSiblings = new Set(results.map((result) => result.companyId));
    expect(companyIdsForSiblings.size).toBe(1);
    companyIds.push(results[0]!.companyId!);
    for (const result of results) {
      expect(result.outcome).toBe("domain_verified");
      const lead = (await db.select().from(leads).where(eq(leads.id, result.leadId)).limit(1))[0]!;
      expect((lead.context["domainVerification"] as Record<string, unknown>)["relationship"]).toBe(
        "parent_brand",
      );
    }
  });

  it("serializes simultaneous verified resolutions onto one canonical company", async () => {
    const domain = `concurrent-parent-${randomUUID().slice(0, 8)}.com`;
    const leadIds = await Promise.all([
      seedLead(db, "Concurrent Parent Aviation LLC", {
        location: "Huntsville, AL",
        domain,
      }),
      seedLead(db, "Concurrent Parent Support LLC", {
        location: "Huntsville, AL",
        domain,
      }),
    ]);
    const deps: LeadDomainDeps = {
      prober: fakeProber({ [domain]: "Concurrent Parent serves aerospace and defense." }),
      judge: fakeJudge([], () => ({
        matches: true,
        confidence: 0.97,
        locationMatches: true,
        identifierMatches: "unknown",
        relationship: "parent_brand",
        reason: "the verified site is the shared parent brand",
      })),
      logger: noopLogger,
    };

    const results = await Promise.all(
      leadIds.map((leadId) => resolveLeadDomain(db, leadId, deps)),
    );
    expect(new Set(results.map((result) => result.companyId)).size).toBe(1);
    const companyId = results[0]!.companyId!;
    companyIds.push(companyId);
    const relations = await db.execute<{ company_id: string }>(sql`
      SELECT company_id FROM company_domains WHERE lower(domain) = ${domain}
    `);
    expect(relations.rows).toEqual([{ company_id: companyId }]);
  });

  it("serializes ingestion against resolution and normalizes www/case/trailing dots", async () => {
    const domain = `ingest-resolver-race-${randomUUID().slice(0, 8)}.com`;
    const resolverLeadId = await seedLead(db, "Shared Brand Foundry LLC", {
      location: "Birmingham, AL",
      domain: `https://WWW.${domain.toUpperCase()}./about`,
    });
    const deps: LeadDomainDeps = {
      prober: fakeProber({ [domain]: "Shared Brand Foundry is based in Birmingham, Alabama." }),
      judge: fakeJudge([], () => ({
        matches: true,
        confidence: 0.98,
        locationMatches: true,
        identifierMatches: "unknown",
        relationship: "parent_brand",
        reason: "the verified site is the shared parent brand",
      })),
      logger: noopLogger,
    };

    await Promise.all([
      resolveLeadDomain(db, resolverLeadId, deps),
      ingestLeadCandidates(campaignId, [
        {
          rawName: "Shared Brand Castings LLC",
          domain: `WWW.${domain.toUpperCase()}.`,
          city: "Birmingham",
          state: "AL",
          awardCount: 2,
          totalAwardValueUsd: 1000,
          sourceLocator: `test://domain-race/${domain}`,
        },
      ]),
    ]);

    const attached = await db.execute<{
      id: string;
      resolved_company_id: string;
      possible_domain: string;
    }>(sql`
      SELECT id, resolved_company_id, possible_domain
      FROM leads
      WHERE campaign_id = ${campaignId}
        AND raw_name IN ('Shared Brand Foundry LLC', 'Shared Brand Castings LLC')
      ORDER BY raw_name
    `);
    expect(attached.rows).toHaveLength(2);
    expect(new Set(attached.rows.map((lead) => lead.resolved_company_id)).size).toBe(1);
    expect(new Set(attached.rows.map((lead) => lead.possible_domain))).toEqual(new Set([domain]));
    const companyId = attached.rows[0]!.resolved_company_id;
    companyIds.push(companyId);
    const relations = await db.execute<{ company_id: string; domain: string }>(sql`
      SELECT company_id, domain FROM company_domains
      WHERE lower(regexp_replace(rtrim(domain, '.'), '^www\\.', '', 'i')) = ${domain}
    `);
    expect(relations.rows).toEqual([{ company_id: companyId, domain }]);
  });

  it("discards a lead with reason + audit, idempotently", async () => {
    const leadId = await seedLead(db, "Ghost Widgets LLC");
    const analystId = actorId;

    const first = await discardLead(db, leadId, analystId, "duplicate of another lead");
    expect(first.alreadyDiscarded).toBe(false);
    const second = await discardLead(db, leadId, analystId, "duplicate of another lead");
    expect(second.alreadyDiscarded).toBe(true);

    const lead = (await db.select().from(leads).where(eq(leads.id, leadId)).limit(1))[0]!;
    expect(lead.status).toBe("discarded");
    const discarded = lead.context["discarded"] as Record<string, unknown>;
    expect(discarded["reason"]).toBe("duplicate of another lead");
    expect(typeof discarded["at"]).toBe("string");

    const audit = (
      await db.select().from(auditEvents).where(eq(auditEvents.entityId, leadId))
    ).find((row) => row.action === "lead.discarded");
    expect(audit?.actorUserId).toBe(actorId);
  });

  it("throws typed errors for missing and non-resolvable leads", async () => {
    await expect(
      resolveLeadDomain(db, randomUUID(), {
        prober: fakeProber({}),
        logger: noopLogger,
      }),
    ).rejects.toBeInstanceOf(LeadNotFoundError);

    const leadId = await seedLead(db, "Discarded First Corp");
    await discardLead(db, leadId, actorId, "not wanted here");
    await expect(
      resolveLeadDomain(
        db,
        leadId,
        { prober: fakeProber({}), judge: fakeJudge([]), logger: noopLogger },
        { force: true },
      ),
    ).rejects.toBeInstanceOf(LeadNotResolvableError);
  });
});

