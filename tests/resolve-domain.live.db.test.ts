/**
 * LIVE DB-gated suite for the resolve_domain agent against REAL sites and
 * the REAL OpenRouter gateway (Wave B field validation).
 *
 *   ASI_LIVE_DOMAIN_TESTS=1 npx vitest run tests/resolve-domain.live.db.test.ts
 *
 * Runs over the local development database (.env.local) and proves the two
 * user-flagged cases, as durable (idempotent) state plus fresh resolution of
 * whatever sibling leads are still unresolved:
 *
 *   1. Yulista parent-brand dedupe: yulista.com serves FOUR sibling
 *      subsidiaries (AVIATION / CONTRACT SERVICES / SUPPORT SERVICES /
 *      AEROSPACE & DEFENSE); every sibling verification must attach to the
 *      ONE canonical company (company count for domain yulista.com === 1),
 *      never mint duplicates.
 *   2. York idempotent attach: yorkprecision.com is a FALSE POSITIVE
 *      (different company); York leads verify yorkpmh.com and merge onto the
 *      EXISTING company that owns it.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { and, asc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import {
  closeDatabase,
  companies,
  companyDomains,
  getDatabase,
  leads,
  resolveLeadDomain,
} from "@asi/database";

import { buildDomainResolutionDeps } from "../apps/worker/src/supervisor/handlers.js";

const LIVE_ENABLED = process.env.ASI_LIVE_DOMAIN_TESTS === "1";

/** The four user-flagged siblings that share the yulista.com parent site. */
const SIBLING_PATTERNS = [
  "YULISTA AVIATION%",
  "YULISTA CONTRACT%",
  "YULISTA SUPPORT%",
  "YULISTA AEROSPACE%",
];

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

function patternFilter(column: typeof leads.rawName) {
  return or(...SIBLING_PATTERNS.map((pattern) => ilike(column, pattern)));
}

describe.skipIf(!LIVE_ENABLED)("resolve_domain agent (LIVE)", () => {
  afterAll(async () => {
    await closeDatabase();
  });

  it("attaches all four Yulista siblings to ONE company via yulista.com", { timeout: 600_000 }, async () => {
    loadDatabaseUrl();
    const db = getDatabase();

    // Fresh resolution of whatever flagged sibling leads remain unresolved.
    const runtime = buildDomainResolutionDeps();
    expect(runtime, "OpenRouter must be configured for the live run").not.toBeNull();
    const openSiblings = await db
      .select({ id: leads.id, rawName: leads.rawName })
      .from(leads)
      .where(and(eq(leads.status, "unresolved_lead"), patternFilter(leads.rawName)))
      .orderBy(asc(leads.createdAt))
      .limit(8);
    // Oldest representative per distinct legal name keeps model calls bounded.
    const byName = new Map<string, string>();
    for (const row of openSiblings) {
      if (!byName.has(row.rawName)) byName.set(row.rawName, row.id);
    }
    for (const [name, leadId] of byName) {
      const result = await resolveLeadDomain(db, leadId, runtime!.deps, { maxCandidates: 3 });
      console.log(
        `[live] ${name}: ${result.outcome}${result.domain === undefined ? "" : ` -> ${result.domain}`}`,
      );
    }

    // THE dedupe proof: exactly ONE company owns the yulista.com domain.
    const owners = await db
      .select({ companyId: companyDomains.companyId })
      .from(companyDomains)
      .where(inArray(companyDomains.domain, ["yulista.com", "www.yulista.com"]));
    const distinctOwners = new Set(owners.map((row) => row.companyId));
    expect(distinctOwners.size, "yulista.com must have exactly ONE owning company").toBe(1);
    const canonical = [...distinctOwners][0]!;

    // Each of the four flagged siblings is represented by a resolved lead
    // attached to the canonical company (directly via yulista.com).
    for (const pattern of SIBLING_PATTERNS) {
      const rows = await db
        .select({ id: leads.id, domain: leads.possibleDomain, companyId: leads.resolvedCompanyId })
        .from(leads)
        .where(and(eq(leads.status, "resolved"), ilike(leads.rawName, pattern)));
      const attachedViaParent = rows.filter(
        (row) =>
          (row.domain === "yulista.com" || row.domain === "www.yulista.com") &&
          row.companyId === canonical,
      );
      expect(
        attachedViaParent.length,
        `${pattern} has a yulista.com-attached resolved lead`,
      ).toBeGreaterThanOrEqual(1);
    }

    // No sibling verification ever minted a second yulista.com company.
    const wrongCompany = await db
      .select({ id: leads.id })
      .from(leads)
      .where(
        and(
          eq(leads.status, "resolved"),
          eq(leads.possibleDomain, "yulista.com"),
          sql`${leads.resolvedCompanyId} <> ${canonical}`,
        ),
      );
    expect(wrongCompany).toHaveLength(0);
  });

  it("York leads merge onto the EXISTING yorkpmh.com company (no duplicate)", { timeout: 300_000 }, async () => {
    loadDatabaseUrl();
    const db = getDatabase();

    const owners = await db
      .select({ companyId: companyDomains.companyId })
      .from(companyDomains)
      .where(eq(companyDomains.domain, "yorkpmh.com"));
    expect(owners.length, "precondition: yorkpmh.com owned").toBeGreaterThanOrEqual(1);
    const distinctOwners = new Set(owners.map((row) => row.companyId));
    expect(distinctOwners.size, "yorkpmh.com must have exactly ONE owning company").toBe(1);
    const expectedCompanyId = [...distinctOwners][0]!;

    // Fresh resolution of any remaining resolvable York lead.
    const runtime = buildDomainResolutionDeps();
    expect(runtime).not.toBeNull();
    const [target] = await db
      .select({ id: leads.id })
      .from(leads)
      .where(
        and(
          ilike(leads.rawName, "YORK PRECISION%"),
          inArray(leads.status, ["unresolved_lead", "resolving"]),
        ),
      )
      .orderBy(asc(leads.createdAt))
      .limit(1);
    if (target !== undefined) {
      const result = await resolveLeadDomain(db, target.id, runtime!.deps, { maxCandidates: 3 });
      console.log(
        `[live] YORK PRECISION MACHINING: ${result.outcome}${result.domain === undefined ? "" : ` -> ${result.domain}`}`,
      );
      expect(result.outcome).toBe("domain_verified");
      expect(result.domain).toBe("yorkpmh.com");
      // Idempotent attach: SAME company, no minted duplicate.
      expect(result.companyId).toBe(expectedCompanyId);
    }

    // Every resolved York lead shares the ONE canonical company — the
    // yorkprecision.com false positive never created a duplicate.
    const resolvedYork = await db
      .select({ companyId: leads.resolvedCompanyId })
      .from(leads)
      .where(and(eq(leads.status, "resolved"), ilike(leads.rawName, "YORK PRECISION%")));
    expect(resolvedYork.length).toBeGreaterThanOrEqual(3);
    for (const row of resolvedYork) {
      expect(row.companyId).toBe(expectedCompanyId);
    }

    const companyCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(companies)
      .where(ilike(companies.displayName, "%York Precision%"));
    expect(companyCount[0]?.count).toBe(1);
  });
});
