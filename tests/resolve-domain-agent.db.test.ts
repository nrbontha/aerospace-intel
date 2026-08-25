/**
 * DB-gated integration suite for the resolve_domain agent type (Wave B).
 *
 *   ASI_DB_TESTS=1 npx vitest run tests/resolve-domain-agent.db.test.ts
 *
 * Boots a SCRATCH postgres:18 container, applies repo migrations, and proves:
 *   - the registry covers resolve_domain,
 *   - the seeder plants the resolve-domains agent within a ≤100% budget,
 *   - batch selection is oldest-first and skips leads that already have a
 *     possible_domain or a non-unresolved status,
 *   - the handler verifies + attaches through the REAL resolveLeadDomain
 *     commit path (fake prober/judge, NO network),
 *   - one failing lead never fails the rest of the batch (error isolation).
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  closeDatabase,
  companies,
  companyDomains,
  getDatabase,
  leads,
  researchAgents,
  resolveLeadDomain,
  type DomainJudge,
  type DomainProber,
  type IdentityJudgment,
  type ResearchAgent,
} from "@asi/database";
import { DEFAULT_AGENT_SEEDS, ensureDefaultAgents } from "../apps/worker/src/supervisor/seed.js";
// Repo imports @asi/database (built dist) AND source paths for runMigrations;
// each module instance keeps its own pool — close both.
import { closeDatabase as closeSourceDatabase } from "../packages/database/src/client.js";

import { OpenRouterClient } from "@asi/research";
import {
  createV1TickHandlerRegistry,
  selectDomainResolutionBatch,
  type TickHandlerDeps,
} from "../apps/worker/src/supervisor/handlers.js";

const execFileAsync = promisify(execFile);
const DB_TESTS_ENABLED = process.env.ASI_DB_TESTS === "1";
const CONTAINER = "asi-resolve-domain-scratch";
const IMAGE = "postgres:18-alpine";

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, {
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

async function waitForPostgres(): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await docker([
        "exec", CONTAINER, "psql", "-U", "asi", "-d", "asi_app", "-c", "SELECT 1",
      ]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`scratch postgres did not become ready (${CONTAINER})`);
}

function loadDatabaseUrl(): void {
  if (process.env.DATABASE_URL !== undefined && process.env.DATABASE_URL !== "") return;
  for (const candidate of [".env.local", ".env"]) {
    const full = path.join(process.cwd(), candidate);
    if (!existsSync(full)) continue;
    for (const line of readFileSync(full, "utf8").split("\n")) {
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

/** Maps URL host → identity text; anything unlisted is DNS-dead. */
function fakeProber(pages: Record<string, string>): DomainProber {
  return {
    async fetchText(url) {
      const host = new URL(url).hostname.replace(/^www\./u, "");
      const text = pages[host];
      if (text === undefined) return { ok: false as const, error: "dns_failed" };
      return { ok: true as const, finalUrl: url, text };
    },
  };
}

function fakeJudge(options: {
  proposals?: string[];
  judgment?: IdentityJudgment;
}): DomainJudge {
  return {
    async proposeDomains() {
      return options.proposals ?? [];
    },
    async judgeIdentity() {
      return (
        options.judgment ?? {
          matches: false,
          confidence: 0.95,
          locationMatches: "unknown",
          identifierMatches: "unknown",
          relationship: "mismatch",
          reason: "no",
        }
      );
    },
  };
}

function depsWith(overrides: Partial<TickHandlerDeps>): Partial<TickHandlerDeps> {
  // Syntactically valid key; the overridden judge/prober never touch it.
  return {
    client: new OpenRouterClient("test-key-not-used"),
    models: { fast: "m/fast", deep: "m/deep", fallback: "m/fb" },
    ...overrides,
  };
}

let createdLeadIds: string[] = [];
let createdCompanyIds: string[] = [];

async function insertLead(overrides: {
  rawName: string;
  createdAt?: Date;
  status?: "unresolved_lead" | "resolved" | "discarded";
  possibleDomain?: string;
}): Promise<string> {
  const [row] = await getDatabase()
    .insert(leads)
    .values({
      rawName: overrides.rawName,
      status: overrides.status ?? "unresolved_lead",
      ...(overrides.possibleDomain === undefined
        ? {}
        : { possibleDomain: overrides.possibleDomain }),
      ...(overrides.createdAt === undefined ? {} : { createdAt: overrides.createdAt }),
      context: {},
    })
    .returning({ id: leads.id });
  createdLeadIds.push(row!.id);
  return row!.id;
}

interface ResolveDomainFindings {
  verified: Array<{ leadId: string; domain: string; companyId: string }>;
  noDomain: number;
  mismatched: number;
  errors: Array<{ leadId: string; error: string }>;
  note?: string;
}

function handlerFor(deps: Partial<TickHandlerDeps>): () => Promise<{
  outcome?: string;
  findings?: ResolveDomainFindings;
}> {
  const registry = createV1TickHandlerRegistry(depsWith(deps));
  const handler = registry.get("resolve_domain");
  if (handler === undefined) throw new Error("resolve_domain handler missing");
  const agent = { key: "resolve-domains-test" } as unknown as ResearchAgent;
  return async () => {
    const result = await handler({ agent, signal: new AbortController().signal });
    return { outcome: result.outcome, findings: result.findings as ResolveDomainFindings };
  };
}

describe.skipIf(!DB_TESTS_ENABLED)("resolve_domain agent (DB)", () => {
  beforeAll(async () => {
    await docker(["rm", "-f", CONTAINER]).catch(() => undefined);
    await docker([
      "run", "-d", "--name", CONTAINER,
      "-e", "POSTGRES_USER=asi", "-e", "POSTGRES_PASSWORD=test", "-e", "POSTGRES_DB=asi_app",
      "-p", "127.0.0.1::5432", IMAGE, "-c", "fsync=off",
    ]);
    const portMapping = await docker(["port", CONTAINER, "5432"]);
    const assigned = /(?:127\.0\.0\.1|0\.0\.0\.0):(\d+)/.exec(portMapping);
    if (assigned?.[1] === undefined) {
      throw new Error(`could not parse docker port mapping: ${portMapping}`);
    }
    process.env.DATABASE_URL = `postgres://asi:test@127.0.0.1:${assigned[1]}/asi_app`;
    loadDatabaseUrl();
    await waitForPostgres();
    const { runMigrations } = await import("../packages/database/src/migrate.js");
    await runMigrations();
  }, 180_000);

  afterAll(async () => {
    try {
      await Promise.allSettled([closeDatabase(), closeSourceDatabase()]);
    } finally {
      // Graceful stop first: hard-removing a live postgres aborts pooled
      // sockets and surfaces as unhandled pg 'error' events.
      await docker(["stop", "-t", "3", CONTAINER]).catch(() => undefined);
      await docker(["rm", "-f", CONTAINER]).catch(() => undefined);
    }
  });

  afterEach(async () => {
    const db = getDatabase();
    if (createdLeadIds.length > 0) {
      await db.delete(leads).where(inArray(leads.id, createdLeadIds));
      createdLeadIds = [];
    }
    if (createdCompanyIds.length > 0) {
      await db.delete(companies).where(inArray(companies.id, createdCompanyIds));
      createdCompanyIds = [];
    }
  });

  it("migration 0004 + registry cover resolve_domain", () => {
    const registry = createV1TickHandlerRegistry({});
    expect(registry.get("resolve_domain")).toBeTypeOf("function");
  });

  it("seeder plants the active portfolio, totals budget shares at 100%, and preserves pauses", async () => {
    const split = Object.fromEntries(
      DEFAULT_AGENT_SEEDS.map((seed) => [seed.key, Number.parseFloat(seed.budgetSharePct)]),
    );
    const total = Object.values(split).reduce((sum, share) => sum + share, 0);
    expect(total).toBe(100);
    expect(split).toMatchObject({
      "discover-usaspending": 10,
      "discover-sam": 0,
      "enrich-queue": 20,
      "monitor-ownership": 8,
      "refresh-stale": 5,
      "golden-neighbor": 10,
      "resolve-domains": 12,
      "qualify-award-leads": 25,
      "source-catalog-scout": 10,
    });

    const seededCount = await ensureDefaultAgents(getDatabase());
    expect(seededCount).toBe(DEFAULT_AGENT_SEEDS.length);
    const rows = await getDatabase().select().from(researchAgents);
    const defaultRows = rows.filter((agent) => agent.key in split);
    expect(defaultRows.filter((agent) => agent.status === "paused").map((agent) => agent.key)).toEqual([
      "discover-sam",
    ]);
    const sourceCatalog = rows.find((agent) => agent.key === "source-catalog-scout");
    expect(sourceCatalog).toMatchObject({
      name: "Source Catalog Scout",
      agentType: "discover_source",
      cadenceSeconds: 86400,
      budgetSharePct: "10.00",
      status: "running",
    });
    const resolver = rows.find((agent) => agent.key === "resolve-domains");
    expect(resolver).toMatchObject({
      cadenceSeconds: 600,
      budgetSharePct: "12.00",
      status: "running",
    });

    await getDatabase()
      .update(researchAgents)
      .set({ status: "paused" })
      .where(eq(researchAgents.key, "resolve-domains"));
    await ensureDefaultAgents(getDatabase());
    const [pausedResolver] = await getDatabase()
      .select({ status: researchAgents.status })
      .from(researchAgents)
      .where(eq(researchAgents.key, "resolve-domains"))
      .limit(1);
    expect(pausedResolver?.status).toBe("paused");
  });

  it("selects a newer qualified possible_domain before older unresolved legacy leads", async () => {
    const olderLegacy = await insertLead({
      rawName: "Legacy Zitec, Inc",
      createdAt: new Date(Date.now() - 120_000),
    });
    const qualifiedNewer = await insertLead({
      rawName: "Qualified Zitec, Inc",
      createdAt: new Date(Date.now() - 60_000),
      possibleDomain: "zitecusa.com",
    });
    const otherUnresolved = await insertLead({ rawName: "Bravo Middle LLC" });
    await insertLead({ rawName: "Delta Resolved LLC", status: "resolved" });

    const batch = await selectDomainResolutionBatch(getDatabase(), 10);
    const ids = batch.map((row) => row.id);
    const qualifiedIndex = ids.indexOf(qualifiedNewer);
    expect(qualifiedIndex).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(olderLegacy)).toBeGreaterThan(qualifiedIndex);
    expect(ids.indexOf(otherUnresolved)).toBeGreaterThan(qualifiedIndex);
    expect(batch.some((row) => row.rawName.includes("Delta"))).toBe(false);
  });

  it("handler verifies a lead through the real commit path", async () => {
    const run = handlerFor({
      domainProber: fakeProber({
        "acmetooling.com": "ACME Tooling LLC — precision aerospace tooling, Ohio.",
      }),
      domainJudge: fakeJudge({
        proposals: ["acmetooling.com"],
        judgment: {
          matches: true,
          confidence: 0.95,
          locationMatches: "unknown",
          identifierMatches: "unknown",
          relationship: "exact",
          reason: "name overlap corroborates the official site",
        },
      }),
    });

    await insertLead({ rawName: "ACME TOOLING LLC" });
    const result = await run();

    expect(result.outcome).toBe("executed");
    const findings = result.findings!;
    expect(findings.verified).toHaveLength(1);
    expect(findings.verified[0]?.domain).toBe("acmetooling.com");
    expect(findings.noDomain).toBe(0);
    expect(findings.mismatched).toBe(0);
    expect(findings.errors).toHaveLength(0);

    const verified = findings.verified[0]!;
    const [leadRow] = await getDatabase().select().from(leads).where(eq(leads.id, verified.leadId));
    expect(leadRow?.status).toBe("resolved");
    expect(leadRow?.possibleDomain).toBe("acmetooling.com");
    expect(leadRow?.resolvedCompanyId).toBe(verified.companyId);

    const [domainRow] = await getDatabase()
      .select()
      .from(companyDomains)
      .where(eq(companyDomains.domain, "acmetooling.com"));
    expect(domainRow?.companyId).toBe(verified.companyId);
  });

  it("one failing lead never fails the rest of the batch", async () => {
    let poisonedLeadId = "";
    const run = handlerFor({
      domainProber: fakeProber({
        "bravogears.com": "Bravo Gears Inc — gears and gearbox assemblies.",
      }),
      domainJudge: fakeJudge({
        judgment: {
          matches: true,
          confidence: 0.9,
          locationMatches: "unknown",
          identifierMatches: "unknown",
          relationship: "exact",
          reason: "identity clear",
        },
      }),
      // Deterministic throw point for the poisoned lead only (the service
      // deliberately swallows model/fetch failures, so isolation needs a
      // seam that can actually fail).
      resolveLead: (db, leadId, resolutionDeps, options) =>
        leadId === poisonedLeadId
          ? Promise.reject(new Error("gateway exploded"))
          : resolveLeadDomain(db, leadId, resolutionDeps, options),
    });

    await insertLead({
      rawName: "POISONED INDUSTRIES LLC",
      createdAt: new Date(Date.now() - 30_000),
    }).then((id) => {
      poisonedLeadId = id;
    });
    const healthy = await insertLead({ rawName: "BRAVO GEARS INC" });

    const result = await run();

    expect(result.outcome).toBe("executed");
    const findings = result.findings!;
    expect(findings.errors).toHaveLength(1);
    expect(findings.errors[0]?.error).toContain("gateway exploded");
    expect(findings.verified.map((entry) => entry.leadId)).toEqual([healthy]);
  });

  it("handler reports done when nothing is selectable", async () => {
    // Prior tests cleaned up their leads, so no unresolved_lead without a
    // possible_domain remains.
    const result = await handlerFor({})();
    expect(result.outcome).toBe("done");
    expect(result.findings?.note).toBeDefined();
  });
});
