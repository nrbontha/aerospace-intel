/**
 * DB-gated integration suite for the REAL per-type TickHandlers
 * (REDESIGN_PLAN §1.3).
 *
 *   ASI_DB_TESTS=1 npx vitest run tests/tick-handlers.db.test.ts
 *
 * Boots a SCRATCH postgres:18 container, applies repo migrations, and drives
 * each handler end-to-end: planTick against a FAKE OpenRouter gateway
 * (canned envelopes via stubbed global fetch), executors against injected
 * fake fetchers / USAspending search clients. NO real network, NO real
 * model calls. Proves the plan→validate→execute contract per agent_type.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { asc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  candidates,
  closeDatabase,
  companies,
  dataSources,
  evidence,
  frontierItems,
  getDatabase,
  goldenExamples,
  leads,
  observations,
  ownershipObservations,
  recordCompanyResearchArtifacts,
  researchAgents,
  researchRuns,
  sourceDocumentLinks,
  sourceDocuments,
  sourceSignals,
  updateCandidateStatus,
  type AgentType,
 } from "@asi/database";
// The repo imports @asi/database (built dist) AND source paths for
// runMigrations; each module instance keeps its own pool — close both.
import { closeDatabase as closeSourceDatabase } from "../packages/database/src/client.js";

import { OpenRouterClient, rescoreCandidateAfterResearch } from "@asi/research";
import {
  createV1TickHandlerRegistry,
  type TickHandlerDeps,
} from "../apps/worker/src/supervisor/handlers.js";



const execFileAsync = promisify(execFile);
const DB_TESTS_ENABLED = process.env.ASI_DB_TESTS === "1";
const CONTAINER = "asi-handlers-scratch";
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
  if (process.env.DATABASE_URL) return;
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

function sha256Of(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Fake OpenRouter gateway (planner + extraction calls replay canned bodies).
// ---------------------------------------------------------------------------

function openRouterEnvelope(content: string): unknown {
  return {
    model: "stealth/ox-alpha",
    provider: "openrouter",
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0 },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Replays canned contents in order, repeating the last one. */
function gatewayWithContents(contents: string[]) {
  const fetchMock = vi.fn(async () => {
    const index = Math.min(fetchMock.mock.calls.length - 1, contents.length - 1);
    return jsonResponse(openRouterEnvelope(contents[index]!));
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    requestBodies: () =>
      fetchMock.mock.calls.map(
        (call) => JSON.parse(String(call[1]!.body)) as {
 messages: Array<{ role: string; content: string }>; response_format?: { json_schema?: { name?: string } } },
      ),
  };
}

function planEnvelope(actions: unknown): string {
  return JSON.stringify({ reasoning: "test plan", actions });
}

const fakeModels = { fast: "m/fast", deep: "m/deep", fallback: "m/fb" };

function fakeFetchResult(url: string, html: string): SafeFetchLike {
  return {
    requestedUrl: url,
    finalUrl: url,
    contentType: "text/html",
    content: html,
    byteLength: html.length,
    contentSha256: sha256Of(html),
    retrievedAt: new Date().toISOString(),
    durationMs: 12,
    redirects: [],
  };
}

interface SafeFetchLike {
  requestedUrl: string;
  finalUrl: string;
  contentType: "text/html" | "text/plain" | "application/json";
  content: string;
  byteLength: number;
  contentSha256: string;
  retrievedAt: string;
  durationMs: number;
  redirects: readonly never[];
}

type FetchDoc = NonNullable<TickHandlerDeps["fetchDocument"]>;

function depsWith(options: {
  fetchDocument?: FetchDoc;
  searchRecipients?: TickHandlerDeps["searchRecipients"];
}): Partial<TickHandlerDeps> {
  // Client comes from the stubbed global fetch (fake gateway); the key is
  // syntactically valid but never leaves the process.
  return {
    client: new OpenRouterClient("test-key-not-used"),
    models: fakeModels,
    ...(options.fetchDocument === undefined ? {} : { fetchDocument: options.fetchDocument }),
    ...(options.searchRecipients === undefined
      ? {}
      : { searchRecipients: options.searchRecipients }),
  };
}

function qualifiedSourceQualification(naics = "336413") {
  return {
    appliedFilters: {
      awardTypeCodes: ["A", "B", "C", "D"],
      naicsCodes: [naics],
      pscCodes: [],
      timePeriods: [{ startDate: "2025-01-01", endDate: "2025-12-31" }],
    },
    returnedNaics: [naics],
    returnedPsc: [],
    awardDescriptionExcerpt: "Manufacturing aircraft components",
    awardAgency: "Department of Defense",
    queryLocator: "https://api.usaspending.gov/api/v2/search/spending_by_award/",
  };
}

// ---------------------------------------------------------------------------
// Row factories + cleanup.
// ---------------------------------------------------------------------------

type AgentInsert = typeof researchAgents.$inferInsert;

let createdAgentIds: string[] = [];
let createdCompanyIds: string[] = [];
let createdGoldenIds: string[] = [];

async function insertAgent(
  overrides: Partial<AgentInsert> = {},
): Promise<typeof researchAgents.$inferSelect> {
  const [row] = await getDatabase()
    .insert(researchAgents)
    .values({
      key: overrides.key ?? `test-${Math.random().toString(36).slice(2)}`,
      name: overrides.name ?? "Test agent",
      agentType: overrides.agentType ?? "discover_source",
      goal: "prove the executor contract",
      cadenceSeconds: 900,
      status: "running",
      ...overrides,
    })
    .returning();
  createdAgentIds.push(row!.id);
  return row!;
}

async function insertCompany(
  overrides: Partial<typeof companies.$inferInsert> = {},
): Promise<string> {
  const [row] = await getDatabase()
    .insert(companies)
    .values({
      legalName: overrides.legalName ?? "Acme Components LLC",
      displayName: overrides.displayName ?? "Acme Components",
      websiteUrl: overrides.websiteUrl ?? null,
      headquartersCountryCode: overrides.headquartersCountryCode ?? null,
    })
    .returning({ id: companies.id });
  createdCompanyIds.push(row!.id);
  return row!.id;
}

async function insertCandidate(
  companyId: string,
  status: typeof candidates.$inferInsert.status = "queued_research",
): Promise<string> {
  const [row] = await getDatabase()
    .insert(candidates)
    .values({
      companyId,
      status,
      // Migration default is '{}'; downstream consumers expect full arrays.
      rationale: { whyInteresting: [], risks: [], unknowns: [] },
    })
    .returning({ id: candidates.id });
  return row!.id;
}

/** data_source → source_document → evidence chain for seed observations. */
async function insertEvidenceChain(input: {
  companyId?: string;
  canonicalUrl: string;
  contentSha256: string;
  quote: string | null;
}): Promise<{ evidenceId: string; sourceDocumentId: string }> {
  const db = getDatabase();
  let dataSourceId: string | undefined;
  if (input.companyId !== undefined) {
    const [created] = await db
      .insert(dataSources)
      .values({
        name: `seed ${input.companyId}`,
        sourceType: "company_website",
        baseUrl: input.canonicalUrl,
        access: "public",
        ingestion: "web_fetch",
      })
      .returning({ id: dataSources.id });
    dataSourceId = created!.id;
  } else {
    const [existing] = await db
      .select({ id: dataSources.id })
      .from(dataSources)
      .limit(1);
    dataSourceId = existing?.id;
    if (dataSourceId === undefined) {
      const [created] = await db
        .insert(dataSources)
        .values({
          name: "seed generic",
          sourceType: "agency_website",
          baseUrl: input.canonicalUrl,
          access: "public",
          ingestion: "web_fetch",
        })
        .returning({ id: dataSources.id });
      dataSourceId = created!.id;
    }
  }
  const [doc] = await db
    .insert(sourceDocuments)
    .values({
      dataSourceId,
      canonicalUrl: input.canonicalUrl,
      title: "seed document",
      mimeType: "text/html",
      contentSha256: input.contentSha256,
      metadata: {},
    })
    .returning({ id: sourceDocuments.id });
  const [ev] = await db
    .insert(evidence)
    .values({
      sourceDocumentId: doc!.id,
      quote: input.quote,
      extractionMethod: "seed",
      extractionStatus: "completed",
    })
    .returning({ id: evidence.id });
  if (input.companyId !== undefined) {
    await db
      .insert(sourceDocumentLinks)
      .values({ sourceDocumentId: doc!.id, companyId: input.companyId });
  }
  return { evidenceId: ev!.id, sourceDocumentId: doc!.id };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  const db = getDatabase();
  if (createdGoldenIds.length > 0) {
    await db.delete(goldenExamples).where(inArray(goldenExamples.id, createdGoldenIds));
    createdGoldenIds = [];
  }
  if (createdAgentIds.length > 0) {
    await db.delete(sourceSignals).where(inArray(sourceSignals.agentId, createdAgentIds));
  }
  if (createdAgentIds.length > 0) {
    // Agent-owned frontier rows have no other owner; drop them first or the
    // ON DELETE SET NULL would violate frontier_owner_check.
    await db
      .delete(frontierItems)
      .where(inArray(frontierItems.agentId, createdAgentIds));
    await db.delete(researchAgents).where(inArray(researchAgents.id, createdAgentIds));
    createdAgentIds = [];
  }
});

describe.skipIf(!DB_TESTS_ENABLED)("real tick handlers (DB)", () => {
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
      await docker(["rm", "-f", CONTAINER]).catch(() => undefined);
    }
  });

  it("registry covers every agent_type", () => {
    const registry = createV1TickHandlerRegistry({});
    const expected: AgentType[] = [
      "discover_source",
      "enrich_candidate",
      "monitor_ownership",
      "refresh_stale",
      "golden_neighbor",
      "resolve_domain",
      "qualify_award_lead",
    ];
    for (const type of expected) {
      expect(registry.get(type), type).toBeTypeOf("function");
    }
  });

  it("discover_source (usaspending): quarantines strict source observations and dedupes reruns", async () => {
    const recipients = [
      {
        rawName: "Alpha Machining LLC",
        uei: "UEIALPHA01",
        domain: "alphamachining.test",
        naics: ["336411"],
        awardCount: 4,
        totalAwardValueUsd: 1_234_567,
        sourceLocator: "usaspending://test/alpha",
        sourceQualification: qualifiedSourceQualification("336411"),
      },
      {
        rawName: "Bravo Gears Inc",
        domain: "bravogears.test",
        awardCount: 2,
        totalAwardValueUsd: 500_000,
        sourceLocator: "usaspending://test/bravo",
        sourceQualification: qualifiedSourceQualification(),
      },
    ];
    let searchCalls = 0;
    gatewayWithContents([planEnvelope([{ source: "usaspending" }])]);
    const agent = await insertAgent({
      key: "discover-usaspending-test",
      agentType: "discover_source",
    });
    const handler = createV1TickHandlerRegistry({
      ...depsWith({}),
      searchRecipients: async (query) => {
        searchCalls += 1;
        expect(query.naicsCodes).toContain("336411");
        return recipients;
      },
    });

    const first = await handler.get("discover_source")!({
      agent,
      signal: new AbortController().signal,
    });
    expect(first.outcome).toBe("executed");
    expect(first.findings).toMatchObject({ harvested: 2, duplicate: 0 });
    expect(searchCalls).toBe(1);
    const signals = await getDatabase()
      .select()
      .from(sourceSignals)
      .where(eq(sourceSignals.agentId, agent.id));
    expect(signals).toHaveLength(2);
    expect(signals.map((signal) => signal.status)).toEqual([
      "queued_qualification",
      "queued_qualification",
    ]);
    const leadRows = await getDatabase()
      .select()
      .from(leads)
      .where(eq(leads.campaignId, agent.id));
    expect(leadRows).toHaveLength(0);

    const second = await handler.get("discover_source")!({
      agent,
      signal: new AbortController().signal,
    });
    expect(second.findings).toMatchObject({ harvested: 0, duplicate: 2 });
  });

  it("discover_source caps harvested source signals at 25 and reports the remainder", async () => {
    const recipients = Array.from({ length: 30 }, (_, index) => ({
      rawName: `Capped Aerospace Manufacturer ${index}`,
      uei: `CAP${String(index).padStart(9, "0")}`,
      naics: ["336413"],
      awardCount: 1,
      totalAwardValueUsd: 1_000,
      sourceLocator: `usaspending://test/cap-${index}`,
      sourceQualification: qualifiedSourceQualification(),
    }));
    gatewayWithContents([planEnvelope([{ source: "usaspending" }])]);
    const agent = await insertAgent({
      key: "discover-usaspending-cap-test",
      agentType: "discover_source",
    });
    const handler = createV1TickHandlerRegistry(
      depsWith({ searchRecipients: async () => recipients }),
    );
    const result = await handler.get("discover_source")!({
      agent,
      signal: new AbortController().signal,
    });
    expect(result.findings).toMatchObject({
      harvested: 25,
      rejected: { outputCap: 5 },
    });
    const signals = await getDatabase()
      .select()
      .from(sourceSignals)
      .where(eq(sourceSignals.agentId, agent.id));
    expect(signals).toHaveLength(25);
  });

  it("qualify_award_lead creates only evidence-backed aerospace manufacturers", async () => {
    const qualifier = await insertAgent({
      key: "qualify-award-leads-test",
      agentType: "qualify_award_lead",
    });
    const rawSignals = [
      "Atlas Precision Components LLC",
      "Orbit Consulting LLC",
      "Health Device Manufacturing LLC",
      "Aircraft Parts Distributor LLC",
      "Identity Mismatch Manufacturing LLC",
    ];
    await getDatabase().insert(sourceSignals).values(
      rawSignals.map((rawName, index) => ({
        sourceKey: "usaspending",
        sourceLocator: `usaspending://qualification/${index}`,
        sourceFingerprint: `qualification-test-${index}`,
        agentId: qualifier.id,
        rawName,
        city: "Huntsville",
        state: "AL",
        uei: `QUALIFY${index}`,
        awardCount: 1,
        awardValue: "1000.00",
        freshestAward: new Date("2026-01-01T00:00:00.000Z"),
        sourcePayload: { award: index },
      })),
    );
    gatewayWithContents([planEnvelope([])]);
    const handler = createV1TickHandlerRegistry({
      ...depsWith({}),
      searchOfficialDomains: async (identity) => [
        {
          domain: `${identity.legalName.includes("Atlas") ? "atlas" : "other"}.test`,
          url: `https://${identity.legalName.includes("Atlas") ? "atlas" : "other"}.test/`,
          title: identity.legalName,
          textSnippet: "Official company website",
          score: 0.9,
        },
      ],
      domainProber: {
        fetchText: async (url) => ({
          ok: true,
          finalUrl: url,
          text: "Atlas Precision manufactures flight-control components for aerospace and defense programs.",
        }),
      },
      domainJudge: {
        proposeDomains: async () => [],
        judgeIdentity: async (legalName) => ({
          matches: !legalName.includes("Identity Mismatch"),
          confidence: 0.98,
          locationMatches: true,
          identifierMatches: "unknown",
          relationship: legalName.includes("Identity Mismatch") ? "mismatch" : "exact",
          reason: "location corroborated",
        }),
      },
      classifyAwardLead: async ({ legalName, pageUrl }) => ({
        manufacturer: legalName.includes("Atlas") || legalName.includes("Health"),
        aerospaceDefenseRelevance: legalName.includes("Atlas"),
        businessModel: legalName.includes("Distributor") ? "distributor" : "manufacturer",
        evidenceExcerpt:
          "manufactures flight-control components for aerospace and defense programs",
        evidenceUrl: pageUrl,
        confidence: 0.92,
      }),
    });
    const result = await handler.get("qualify_award_lead")!({
      agent: qualifier,
      signal: new AbortController().signal,
    });
    expect(result.findings).toMatchObject({
      selected: 5,
      statusTransitions: {
        "qualifying->qualified": 1,
        "qualifying->rejected": 4,
        "qualifying->quarantined": 0,
      },
    });
    const signals = await getDatabase()
      .select()
      .from(sourceSignals)
      .where(eq(sourceSignals.agentId, qualifier.id))
      .orderBy(asc(sourceSignals.rawName));
    const qualified = signals.filter((signal) => signal.status === "qualified");
    expect(qualified).toHaveLength(1);
    expect(qualified[0]).toMatchObject({
      rawName: "Atlas Precision Components LLC",
      leadId: expect.any(String),
      companyId: expect.any(String),
    });
    expect((qualified[0]!.qualification as Record<string, unknown>)["evidence"]).toMatchObject({
      classification: {
        evidenceExcerpt:
          "manufactures flight-control components for aerospace and defense programs",
      },
    });
    expect(signals.filter((signal) => signal.status === "rejected")).toHaveLength(4);
    const leadRows = await getDatabase()
      .select()
      .from(leads)
      .where(eq(leads.campaignId, qualifier.id));
    expect(leadRows).toHaveLength(1);
  });
  it("discover_source (sam variant) idles honestly without SAM_API_KEY", async () => {
    const previous = process.env.SAM_API_KEY;
    delete process.env.SAM_API_KEY;
    try {
      const agent = await insertAgent({ key: "discover-sam-test", agentType: "discover_source" });
      const handler = createV1TickHandlerRegistry(depsWith({}));
      const result = await handler.get("discover_source")!({
        agent,
        signal: new AbortController().signal,
      });
      expect(result.outcome).toBe("stuck");
      expect(result.findings).toMatchObject({ idle: true, idleReason: "missing_sam_api_key" });
      expect(result.actionsExecuted ?? 0).toBe(0);
    } finally {
      if (previous !== undefined) process.env.SAM_API_KEY = previous;
    }
  });

  it("enrich_candidate: plans, runs deep research inline through artifacts, rescores", async () => {
    const companyId = await insertCompany({
      websiteUrl: "https://acme-components.test/",
    });
    const candidateId = await insertCandidate(companyId, "queued_research");
    gatewayWithContents([
      planEnvelope([{ companyId }]),
      // Extraction contents would only be consumed by the REAL workflow; the
      // stubbed runResearch below replaces it for this unit-tier test.
      JSON.stringify({ facts: [] }),
    ]);
    const agent = await insertAgent({ key: "enrich-queue-test", agentType: "enrich_candidate" });

    // Stub executor: performs the REAL artifact persistence + rescore tail of
    // processCandidateResearch, minus network/model (faked at that seam).
    let ranResearchRunId: string | undefined;
    const runResearch: TickHandlerDeps["runResearch"] = async (request) => {
      ranResearchRunId = request.researchRunId;
      const db = getDatabase();
      const excerpt =
        "Acme Components manufactures precision actuation systems for aerospace primes.";
      const outcome = await recordCompanyResearchArtifacts({
        companyId,
        researchRunId: request.researchRunId,
        result: {
          status: "completed",
          sourceDocuments: [
            {
              canonicalUrl: "https://acme-components.test/",
              title: "Acme Components website",
              mimeType: "text/html",
              byteLength: 95,
              contentSha256: sha256Of("acme-homepage"),
              retrievedAt: new Date().toISOString(),
              metadata: { requestedUrl: "https://acme-components.test/" },
            },
          ],
          facts: [
            {
              fieldKey: "description",
              value: "Precision actuation systems manufacturer.",
              evidenceExcerpt: excerpt,
              confidence: 0.9,
              sourceUrl: "https://acme-components.test/",
            },
          ],
          telemetry: {
            promptVersion: "candidate-research.v1",
            fetch: {
              toolName: "fetch_url",
              requestedUrlSha256: sha256Of("https://acme-components.test/"),
              responseSha256: sha256Of("acme-homepage"),
              finalUrl: "https://acme-components.test/",
              byteLength: 95,
              durationMs: 5,
              redirectCount: 0,
            },
            model: {
              route: "fast",
              schemaName: "company_research_v1",
              schemaSha256: sha256Of("schema"),
              responseSha256: sha256Of("response"),
              provider: "test",
              attempts: [
                {
                  attempt: 1,
                  model: fakeModels.fast,
                  status: "succeeded",
                  promptSha256: sha256Of("prompt"),
                  latencyMs: 10,
                  inputTokens: 10,
                  outputTokens: 5,
                  totalTokens: 15,
                  costUsd: 0,
                },
              ],
            },
          },
        },
      });
      const rescored = await rescoreCandidateAfterResearch(db, candidateId);
      await updateCandidateStatus(db, { candidateId, status: "research_ready" });
      return {
        candidateId,
        observationsCreated: outcome.observationIds.length,
        evidenceCount: outcome.evidenceIds.length,
        proposalCount: outcome.proposalIds.length,
        fetchedUrls: ["https://acme-components.test/"],
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        costUsd: 0,
        scores: rescored.scores,
      };
    };

    const handler = createV1TickHandlerRegistry({
      ...depsWith({}),
      runResearch,
    });

    const result = await handler.get("enrich_candidate")!({
      agent,
      signal: new AbortController().signal,
    });

    expect(result.outcome).toBe("executed");
    expect(result.actionsExecuted).toBe(1);
    expect(ranResearchRunId).toBeDefined();
    expect(typeof result.costUsd).toBe("number");

    // A research run row was opened under the agent's identity.
    const [runRow] = await getDatabase()
      .select()
      .from(researchRuns)
      .where(eq(researchRuns.id, ranResearchRunId!));
    expect(runRow!.targetId).toBe(companyId);
    const runMetadata = (runRow!.input as Record<string, unknown>)["metadata"] as
      | Record<string, unknown>
      | undefined;
    expect(runMetadata?.["agentKey"]).toBe(agent.key);

    const enriched = (result.findings!["enriched"] as Array<Record<string, unknown>>)[0]!;
    expect(enriched["observationsCreated"]).toBeGreaterThan(0);
    expect(enriched["scores"]).toHaveProperty("confidence");

    // Evidence-backed observation landed through the artifact pipeline.
    const obsRows = await getDatabase().execute<{ n: number }>(sql`
      SELECT count(DISTINCT o.id)::int AS n FROM observations o
      JOIN evidence e ON e.id = o.evidence_id
      WHERE o.subject_type = 'company' AND o.subject_id = ${companyId}
    `);
    expect(Number(obsRows.rows[0]!.n)).toBeGreaterThanOrEqual(1);

    // Rescore appended axis rows and advanced the candidate to research_ready.
    const [candidateRow] = await getDatabase()
      .select({ status: candidates.status })
      .from(candidates)
      .where(eq(candidates.companyId, companyId));
    expect(candidateRow!.status).toBe("research_ready");
    const scoreCount = await getDatabase().execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM candidate_scores WHERE candidate_id = ${candidateId}
    `);
    expect(Number(scoreCount.rows[0]!.n)).toBeGreaterThan(0);
  });

  it("enrich_candidate skips planned companies outside the queued set", async () => {
    const ghostId = "00000000-0000-4000-8000-000000000001";
    gatewayWithContents([planEnvelope([{ companyId: ghostId }])]);
    const agent = await insertAgent({ key: "enrich-queue-invalid", agentType: "enrich_candidate" });
    const handler = createV1TickHandlerRegistry(depsWith({}));
    const result = await handler.get("enrich_candidate")!({
      agent,
      signal: new AbortController().signal,
    });
    expect(result.actionsExecuted ?? 0).toBe(0);
    expect(result.findings!["invalidActions"]).toBe(1);
  });

  it("monitor_ownership: refetches, extracts with evidence chain, flags conflicts", async () => {
    const companyId = await insertCompany({
      displayName: "Acme Aero Holdings",
      websiteUrl: "https://acme-aero.test/",
    });
    const candidateId = await insertCandidate(companyId, "partner_review");
    const seedChain = await insertEvidenceChain({
      companyId,
      canonicalUrl: "https://acme-aero.test/",
      contentSha256: sha256Of("seed-old"),
      quote: "family owned business",
    });
    await getDatabase().insert(ownershipObservations).values({
      companyId,
      type: "private",
      ownerName: "Acme founding family",
      confidence: "0.500",
      evidenceId: seedChain.evidenceId,
      observedAt: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000),
    });

    gatewayWithContents([
      planEnvelope([{ candidateId }]),
      JSON.stringify({
        observations: [
          {
            ownershipType: "subsidiary",
            ownerName: "Global Holdings plc",
            ownershipPercentLower: 100,
            ownershipPercentUpper: 100,
            evidenceExcerpt: "wholly owned subsidiary of Global Holdings plc",
            confidence: 0.85,
          },
        ],
      }),
    ]);
    const { fetchDocument } = stubFetcher({
      "https://acme-aero.test/":
        "<html><body><p>Acme Aero is a wholly owned subsidiary of Global Holdings plc.</p></body></html>",
    });
    const agent = await insertAgent({ key: "monitor-ownership-test", agentType: "monitor_ownership" });
    const handler = createV1TickHandlerRegistry(depsWith({ fetchDocument }));

    const result = await handler.get("monitor_ownership")!({
      agent,
      signal: new AbortController().signal,
    });

    expect(result.outcome).toBe("executed");
    expect(result.findings!["observationsWritten"]).toBe(1);
    const conflicts = result.findings!["conflicts"] as Array<Record<string, unknown>>;
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!["previous"]).toMatchObject({ type: "private" });
    expect(conflicts[0]!["observed"]).toMatchObject({
      type: "subsidiary",
      ownerName: "Global Holdings plc",
    });

    // New observation appended WITH its evidence chain; old row untouched.
    const ownershipRows = await getDatabase()
      .select()
      .from(ownershipObservations)
      .where(eq(ownershipObservations.companyId, companyId))
      .orderBy(ownershipObservations.observedAt);
    expect(ownershipRows).toHaveLength(2);
    const newest = ownershipRows.at(-1)!;
    expect(newest.type).toBe("subsidiary");
    expect(newest.ownerName).toBe("Global Holdings plc");
    const [evidenceRow] = await getDatabase()
      .select()
      .from(evidence)
      .where(eq(evidence.id, newest.evidenceId));
    expect(evidenceRow!.extractionMethod).toBe("ownership-monitor.v1");
    expect(evidenceRow!.quote).toContain("Global Holdings plc");

    // Conflict surfaced on the candidate too.
    const [candidateRow] = await getDatabase()
      .select({ rationale: candidates.rationale })
      .from(candidates)
      .where(eq(candidates.id, candidateId));
    expect(candidateRow!.rationale.risks.some((risk) => risk.includes("ownership conflict"))).toBe(true);
  });

  it("refresh_stale: refetches changed documents, appends fresh observations, skips unchanged", async () => {
    const companyId = await insertCompany({ websiteUrl: "https://refresh.test/" });
    const candidateId = await insertCandidate(companyId, "research_ready");
    const quote = "Founded in 1962 by the Acme family.";
    const seedChain = await insertEvidenceChain({
      companyId,
      canonicalUrl: "https://refresh.test/about",
      contentSha256: sha256Of("stale-content"),
      quote,
    });
    await getDatabase()
      .update(sourceDocuments)
      .set({
        retrievedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
      })
      .where(eq(sourceDocuments.id, seedChain.sourceDocumentId));
    const [originalObservation] = await getDatabase()
      .insert(observations)
      .values({
        subjectType: "company",
        subjectId: companyId,
        fieldKey: "description",
        valueKind: "text",
        value: "Founded in 1962",
        confidence: "0.700",
        evidenceId: seedChain.evidenceId,
        observedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
      })
      .returning({ id: observations.id });

    const freshHtml =
      "<html><body><p>About us. Founded in 1962 by the Acme family. Still machining.</p></body></html>";
    const { fetchDocument } = stubFetcher({ "https://refresh.test/about": freshHtml });
    const agent = await insertAgent({ key: "refresh-stale-test", agentType: "refresh_stale" });
    const handler = createV1TickHandlerRegistry(depsWith({ fetchDocument }));
    const signal = new AbortController().signal;

    const refreshed = await handler.get("refresh_stale")!({ agent, signal });
    expect(refreshed.outcome).toBe("executed");
    expect(refreshed.findings).toMatchObject({ refreshedDocuments: 1, unchangedSkipped: 0 });
    expect(refreshed.findings!["rescoredCandidates"]).toContain(candidateId);

    const childEvidence = await getDatabase()
      .select()
      .from(evidence)
      .where(
        sql`${evidence.metadata}->>'refreshedFromEvidenceId' = ${seedChain.evidenceId}`,
      );
    expect(childEvidence).toHaveLength(1);
    const freshObservations = await getDatabase()
      .select()
      .from(observations)
      .where(eq(observations.evidenceId, childEvidence[0]!.id));
    expect(freshObservations).toHaveLength(1);
    expect(freshObservations[0]!.value).toEqual(originalObservation ? "Founded in 1962" : null);

    const [docRow] = await getDatabase()
      .select()
      .from(sourceDocuments)
      .where(eq(sourceDocuments.id, seedChain.sourceDocumentId));
    expect(docRow!.contentSha256).toBe(sha256Of(freshHtml));

    // Re-stale the SAME document with an IDENTICAL hash: still 30d+ old,
    // but content-addressed comparison must skip it. BOTH evidence rows on
    // that document (the seed and its refresh child) are stale candidates.
    await getDatabase()
      .update(sourceDocuments)
      .set({
        retrievedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
        contentSha256: sha256Of(freshHtml),
      })
      .where(eq(sourceDocuments.id, seedChain.sourceDocumentId));
    const unchangedRun = await handler.get("refresh_stale")!({ agent, signal });
    expect(unchangedRun.findings).toMatchObject({ unchangedSkipped: 2, refreshedDocuments: 0 });
    void candidateId;
  }, 60_000);

  it("refresh_stale drops quotes that vanish from the fresh content", async () => {
    const companyId = await insertCompany({ websiteUrl: "https://vanish.test/" });
    const quote = "ISO 9001 certified since 1999.";
    const seedChain = await insertEvidenceChain({
      companyId,
      canonicalUrl: "https://vanish.test/certs",
      contentSha256: sha256Of("older-still"),
      quote,
    });
    await getDatabase()
      .update(sourceDocuments)
      .set({ retrievedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) })
      .where(eq(sourceDocuments.id, seedChain.sourceDocumentId));
    gatewayWithContents([planEnvelope([{ evidenceId: seedChain.evidenceId }])]);
    const { fetchDocument } = stubFetcher({
      "https://vanish.test/certs":
        "<html><body><p>Certifications page was redesigned; quote is gone.</p></body></html>",
    });
    const agent = await insertAgent({ key: "refresh-vanish-test", agentType: "refresh_stale" });
    const handler = createV1TickHandlerRegistry(depsWith({ fetchDocument }));
    const result = await handler.get("refresh_stale")!({
      agent,
      signal: new AbortController().signal,
    });
    expect(result.findings).toMatchObject({ droppedQuotes: 1, refreshedDocuments: 0 });
  });

  it("golden_neighbor: mines archetype seeds into quarantined source signals, never leads", async () => {
    const [golden] = await getDatabase()
      .insert(goldenExamples)
      .values({
        name: "Golden Drill Corp",
        reviewStatus: "reviewed",
        archetypeFit: "positive",
        grataPayload: { industryNaics: ["336413"], certifications: ["1560"] },
      })
      .returning({ id: goldenExamples.id });
    createdGoldenIds.push(golden!.id);

    const seenQueries: Array<{
      naicsCodes?: readonly string[];
      pscCodes?: readonly string[];
    }> = [];
    const agent = await insertAgent({ key: "golden-neighbor-test", agentType: "golden_neighbor" });
    const handler = createV1TickHandlerRegistry(
      depsWith({
        searchRecipients: async (query) => {
          seenQueries.push(query);
          return [
            {
              rawName: "Neighbor Fasteners Co",
              domain: "neighborfasteners.test",
              awardCount: 3,
              totalAwardValueUsd: 900_000,
              sourceLocator: "usaspending://test/neighbor",
              sourceQualification: qualifiedSourceQualification(),
            },
          ];
        },
      }),
    );

    const result = await handler.get("golden_neighbor")!({
      agent,
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe("executed");
    expect(result.findings).toMatchObject({
      source: "golden_neighbor_usaspending",
      examplesConsidered: 1,
      harvested: 1,
    });
    expect(seenQueries[0]?.naicsCodes).toContain("336413");
    const signals = await getDatabase()
      .select()
      .from(sourceSignals)
      .where(eq(sourceSignals.agentId, agent.id));
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      sourceKey: "golden_neighbor_usaspending",
      status: "queued_qualification",
    });
    expect((signals[0]!.sourcePayload as Record<string, unknown>)["goldenNeighborOrigin"]).toBe(
      true,
    );
    const leadRows = await getDatabase()
      .select()
      .from(leads)
      .where(eq(leads.campaignId, agent.id));
    expect(leadRows).toHaveLength(0);
  });

  it("golden_neighbor idles when no reviewed-positive examples exist", async () => {
    const agent = await insertAgent({ key: "golden-neighbor-empty", agentType: "golden_neighbor" });
    const handler = createV1TickHandlerRegistry(
      depsWith({
        searchRecipients: async () => [],
      }),
    );
    const result = await handler.get("golden_neighbor")!({
      agent,
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe("done");
    expect(result.findings).toMatchObject({
      idleReason: "no_reviewed_positive_golden_examples",
    });
  });
});

/** Stub the injected fetcher per URL; unknown URLs fail like dead subpages. */
function stubFetcher(pages: Record<string, string>): { fetchDocument: FetchDoc } {
  const fetchDocument: FetchDoc = async (url) => {
    const html = pages[url];
    if (html === undefined) throw new Error(`unmapped test url ${url}`);
    return fakeFetchResult(url, html);
  };
  return { fetchDocument };
}
