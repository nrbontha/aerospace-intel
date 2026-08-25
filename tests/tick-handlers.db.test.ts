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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_QUERY_STALE_CLAIM_MS,
  agentFrontierProgress,
  candidates,
  closeDatabase,
  companies,
  companyDomains,
  companyIdentifiers,
  dataSources,
  evidence,
  frontierItems,
  claimNextAgentQuery,
  getDatabase,
  goldenExamples,
  ensureAgentMonthlyQueries,
  failAgentQuery,
  leads,
  identityMatchCandidates,
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

import {
  OpenRouterClient,
  rescoreCandidateAfterResearch,
  SamQuotaExceededError,
} from "@asi/research";
import {
  createV1TickHandlerRegistry,
  synthesizeQualifiedSignalIfReady,
  type SourceSignalClassification,
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
  searchRecipientsPage?: TickHandlerDeps["searchRecipientsPage"];
  searchExa?: TickHandlerDeps["searchExa"];
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
    ...(options.searchRecipientsPage === undefined
      ? {}
      : { searchRecipientsPage: options.searchRecipientsPage }),
    ...(options.searchExa === undefined ? {} : { searchExa: options.searchExa }),
  };
}

function qualifiedSourceQualification(naics = "336413") {
  return {
    evidenceStrength: "returned_strict_naics",
    appliedFilters: {
      awardTypeCodes: ["A", "B", "C", "D"],
      naicsCodes: [naics],
      pscCodes: [],
      timePeriods: [{ startDate: "2025-01-01", endDate: "2025-12-31" }],
      placeOfPerformanceLocations: [],
      keywords: [],
    },
    returnedNaics: [naics],
    returnedPsc: null,
    awardDescriptionExcerpt: "Manufacturing aircraft components",
    awardAgency: "Department of Defense",
    awardLocation: null,
    queryLocator: "https://api.usaspending.gov/api/v2/search/spending_by_award/",
  };
}

function sourceSignalClassification(
  pageUrl: string,
  overrides: Partial<SourceSignalClassification> = {},
): SourceSignalClassification {
  const excerpt = "manufactures flight-control components for aerospace and defense programs";
  return {
    manufacturer: true,
    aerospaceDefenseRelevance: true,
    businessModel: "manufacturer",
    headquartersCountry: "United States",
    ownershipType: "independent",
    sizeFit: "likely_under_50m",
    proprietarySignals: ["Flight-control component manufacturing"],
    manufacturerEvidence: { excerpt, url: pageUrl },
    aerospaceDefenseEvidence: { excerpt, url: pageUrl },
    targetDecision: "yes_target",
    reasons: ["Official-site evidence supports target fit"],
    confidence: 0.92,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Row factories + cleanup.
// ---------------------------------------------------------------------------

type AgentInsert = typeof researchAgents.$inferInsert;

let createdAgentIds: string[] = [];
let createdGoldenIds: string[] = [];
let createdCatalogPublishers: string[] = [];
let runTag = "uninitialized";

beforeEach(() => {
  runTag = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
});

async function insertAgent(
  overrides: Partial<AgentInsert> = {},
): Promise<typeof researchAgents.$inferSelect> {
  const [row] = await getDatabase()
    .insert(researchAgents)
    .values({
      ...overrides,
      key: overrides.key ?? `test-${runTag}`,
      name: overrides.name ?? "Test agent",
      agentType: overrides.agentType ?? "discover_source",
      goal: overrides.goal ?? "prove the executor contract",
      cadenceSeconds: overrides.cadenceSeconds ?? 900,
      status: overrides.status ?? "running",
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
      legalName: overrides.legalName ?? `Acme Components LLC ${runTag}`,
      displayName: overrides.displayName ?? `Acme Components ${runTag}`,
      websiteUrl: overrides.websiteUrl ?? null,
      headquartersCountryCode: overrides.headquartersCountryCode ?? null,
    })
    .returning({ id: companies.id });
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
  vi.unstubAllEnvs();
  const db = getDatabase();
  if (createdCatalogPublishers.length > 0) {
    await db
      .delete(dataSources)
      .where(inArray(dataSources.publisher, createdCatalogPublishers));
    createdCatalogPublishers = [];
  }
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
  // Companies and their append-only/cascading research chains intentionally
  // survive until the dedicated scratch database is torn down after the suite.
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

  it("discover_source (SAM): applies the strict active-US harvest and writes signals only", async () => {
    vi.stubEnv("SAM_API_KEY", "test-sam-key");
    gatewayWithContents([planEnvelope([{ source: "sam" }])]);
    const agent = await insertAgent({
      key: "discover-sam-handler-test",
      agentType: "discover_source",
    });
    const searchSamEntities: NonNullable<TickHandlerDeps["searchSamEntities"]> = vi.fn(
      async (query) => {
      expect(query).toMatchObject({
        naicsCodes: ["336411", "336412", "336413", "336419", "334511"],
        maxResults: 25,
      });
      return {
        totalRecords: 2,
        entities: [
          {
            legalName: "Strict SAM Aerospace LLC",
            uei: "STRICTSAM001",
            cageCode: "1SAM1",
            officialUrl: "https://strict-sam.test/",
            officialDomain: "strict-sam.test",
            addressLine1: "1 Flight Way",
            addressLine2: null,
            city: "Wichita",
            state: "KS",
            zip: "67202",
            country: "US",
            registrationStatus: "Active",
            exclusionStatusFlag: false,
            primaryNaics: {
              code: "336413",
              description: "Aircraft parts",
              sbaSmallBusiness: true,
            },
            naics: [
              {
                code: "336413",
                description: "Aircraft parts",
                sbaSmallBusiness: true,
              },
            ],
            psc: [],
            entityTypeHints: [],
            businessTypeHints: [],
            ownershipHints: [],
            matchedNaicsCodes: ["336413"],
            parentUei: null,
            sourceLocator: "sam://entity-information/v4/entities/STRICTSAM001",
            raw: {
              entityRegistration: {
                ueiSAM: "STRICTSAM001",
                cageCode: "1SAM1",
                legalBusinessName: "Strict SAM Aerospace LLC",
                registrationStatus: "Active",
              },
              coreData: {
                physicalAddress: {
                  city: "Wichita",
                  stateOrProvinceCode: "KS",
                  countryCode: "US",
                },
              },
              assertions: {
                goodsAndServices: {
                  primaryNaics: "336413",
                  naicsList: [{ naicsCode: "336413" }],
                },
              },
              publicExtension: { preserved: true },
            },
          },
          {
            legalName: "Inactive SAM Aerospace LLC",
            uei: "INACTIVESAM1",
            cageCode: null,
            officialUrl: null,
            officialDomain: null,
            addressLine1: null,
            addressLine2: null,
            city: null,
            state: null,
            zip: null,
            country: "US",
            registrationStatus: "Inactive",
            exclusionStatusFlag: false,
            primaryNaics: null,
            naics: [],
            psc: [],
            entityTypeHints: [],
            businessTypeHints: [],
            ownershipHints: [],
            matchedNaicsCodes: ["336413"],
            parentUei: null,
            sourceLocator: "sam://entity-information/v4/entities/INACTIVESAM1",
            raw: {
              entityRegistration: {
                ueiSAM: "INACTIVESAM1",
                legalBusinessName: "Inactive SAM Aerospace LLC",
                registrationStatus: "Inactive",
              },
            },
          },
        ],
      };
      },
    );
    const handler = createV1TickHandlerRegistry({
      ...depsWith({}),
      searchSamEntities,
    }).get("discover_source")!;

    const result = await handler({
      agent,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      outcome: "executed",
      findings: {
        source: "sam_entity",
        fetched: 2,
        harvested: 1,
        rejected: 1,
      },
    });
    const signals = await getDatabase()
      .select()
      .from(sourceSignals)
      .where(eq(sourceSignals.agentId, agent.id));
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      sourceKey: "sam_entity",
      rawName: "Strict SAM Aerospace LLC",
      status: "queued_qualification",
      sourcePayload: {
        matchedNaicsCodes: ["336413"],
        rawEntity: {
          publicExtension: { preserved: true },
        },
      },
    });
    expect(
      await getDatabase().select().from(leads).where(eq(leads.campaignId, agent.id)),
    ).toHaveLength(0);
  });

  it("discover_source (SAM): parks at the daily quota reset without writing signals", async () => {
    vi.stubEnv("SAM_API_KEY", "test-sam-key");
    gatewayWithContents([planEnvelope([{ source: "sam" }])]);
    const agent = await insertAgent({
      key: "discover-sam-quota-handler-test",
      agentType: "discover_source",
    });
    const resetAt = new Date("2026-08-26T00:00:00.000Z");
    const searchSamEntities: NonNullable<TickHandlerDeps["searchSamEntities"]> = vi.fn(
      async () => {
        throw new SamQuotaExceededError(resetAt, 429);
      },
    );
    const handler = createV1TickHandlerRegistry({
      ...depsWith({}),
      searchSamEntities,
    }).get("discover_source")!;

    const result = await handler({
      agent,
      signal: new AbortController().signal,
    });

    expect(searchSamEntities).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      outcome: "budget_exhausted",
      actionsExecuted: 0,
      findings: {
        idle: true,
        idleReason: "sam_daily_quota_exhausted",
        source: "sam_entity",
        resetAt: resetAt.toISOString(),
      },
      nextTickAt: resetAt,
    });
    expect(
      await getDatabase().select().from(sourceSignals).where(eq(sourceSignals.agentId, agent.id)),
    ).toHaveLength(0);
  });

  it("discover_source (FAA targeted): stays stuck while browser access is disabled", async () => {
    vi.stubEnv("FAA_DRS_BROWSER_ENABLED", "false");
    const agent = await insertAgent({
      key: "faa-pma-targeted",
      agentType: "discover_source",
    });
    const searchFaaPma: NonNullable<TickHandlerDeps["searchFaaPma"]> = vi.fn(
      async () => {
        throw new Error("disabled FAA search must not execute");
      },
    );
    const result = await createV1TickHandlerRegistry({ searchFaaPma })
      .get("discover_source")!({
        agent,
        signal: new AbortController().signal,
      });
    expect(result).toMatchObject({
      outcome: "stuck",
      findings: {
        idle: true,
        idleReason: "faa_drs_browser_disabled",
      },
    });
    expect(searchFaaPma).not.toHaveBeenCalled();
  });

  it("discover_source (FAA targeted): records a completed search plus PMA signals and advances", async () => {
    vi.stubEnv("FAA_DRS_BROWSER_ENABLED", "true");
    gatewayWithContents([planEnvelope([{ source: "faa_pma_targeted" }])]);
    const excludedCompanyId = await insertCompany({
      legalName: "Already Identified Aerospace LLC",
      displayName: "Already Identified Aerospace",
      headquartersCountryCode: "US",
    });
    await insertCandidate(excludedCompanyId, "shortlist");
    await getDatabase().insert(companyIdentifiers).values({
      companyId: excludedCompanyId,
      type: "faa_pma_holder",
      value: "PQ-EXISTING",
    });
    const companyId = await insertCompany({
      legalName: "Priority PMA Aerospace LLC",
      displayName: "Priority PMA Aerospace",
      headquartersCountryCode: "US",
    });
    const candidateId = await insertCandidate(companyId, "partner_review");
    const agent = await insertAgent({
      key: "faa-pma-targeted",
      agentType: "discover_source",
    });
    const guidUrl =
      "https://drs.faa.gov/browse/excelExternalWindow/DRSDOCID123456789";
    const searchFaaPma: NonNullable<TickHandlerDeps["searchFaaPma"]> = vi.fn(
      async () => ({
      query: { holderName: "Priority PMA Aerospace LLC", maxRecords: 25 },
      records: [
        {
          recordId: "PMA0001",
          guidUrl,
          status: "Active",
          subStatus: null,
          holderName: "Priority PMA Aerospace LLC",
          holderNumber: "PQ0001CE",
          fullAddress: "1 Flight Way, Wichita, KS 67202",
          pmaPartNumber: "PMA-100",
          partName: "Flight Control Bracket",
          replacementPartNumber: null,
          make: "Aircraft Co",
          models: ["A-1"],
          supplementNumber: null,
          supplementDate: null,
          approvalBasis: "Test and computation",
          serviceOffice: null,
          opr: null,
          cfrReferences: ["14 CFR 21.303"],
          comments: null,
          renderedSourceText: "PMA Holder Name Priority PMA Aerospace LLC",
        },
      ],
      source: {
        publicUrl: "https://drs.faa.gov/browse/PMA/doctypeDetails" as const,
        scrapedAt: "2026-08-25T12:00:00.000Z",
        retrievalMethod: "guest_browser_dom" as const,
      },
      }),
    );
    const handler = createV1TickHandlerRegistry({
      ...depsWith({}),
      searchFaaPma,
    }).get("discover_source")!;
    const first = await handler({
      agent,
      signal: new AbortController().signal,
    });
    const second = await handler({
      agent,
      signal: new AbortController().signal,
    });
    expect(searchFaaPma).toHaveBeenCalledTimes(1);
    expect(searchFaaPma).toHaveBeenCalledWith({
      holderName: "Priority PMA Aerospace LLC",
      maxRecords: 25,
    });
    expect(first).toMatchObject({
      outcome: "executed",
      findings: {
        candidateId,
        companyId,
        fetched: 1,
        harvested: 1,
        checkpointStatus: "qualified",
        cacheHit: false,
      },
    });
    expect(second).toMatchObject({
      outcome: "done",
      findings: {
        note: "no active candidate without an FAA PMA holder identifier",
      },
    });
    const signals = await getDatabase()
      .select()
      .from(sourceSignals)
      .where(eq(sourceSignals.agentId, agent.id));
    expect(signals).toHaveLength(2);
    const recordSignal = signals.find((signal) => signal.sourceKey === "faa_drs_pma");
    const checkpoint = signals.find(
      (signal) => signal.sourceKey === "faa_drs_pma_search",
    );
    expect(recordSignal).toMatchObject({
      sourceKey: "faa_drs_pma",
      sourceLocator: guidUrl,
      rawName: "Priority PMA Aerospace LLC",
      companyId: null,
      status: "queued_qualification",
      sourcePayload: {
        record: { recordId: "PMA0001", guidUrl },
        knownCompanyHint: { candidateId, companyId },
      },
    });
    expect(checkpoint).toMatchObject({
      companyId,
      status: "qualified",
      qualification: {
        decision: "qualified",
        reason: "search_complete",
      },
      sourcePayload: {
        recordCount: 1,
        cache: { hit: false, ttlMs: 86_400_000 },
        knownCompanyHint: { candidateId, companyId },
      },
    });
    expect(
      await getDatabase().select().from(leads).where(eq(leads.campaignId, agent.id)),
    ).toHaveLength(0);
  });

  it("discover_source (FAA targeted): checkpoints zero results and skips the company next tick", async () => {
    vi.stubEnv("FAA_DRS_BROWSER_ENABLED", "true");
    gatewayWithContents([planEnvelope([{ source: "faa_pma_targeted" }])]);
    const companyId = await insertCompany({
      legalName: "No Current PMA Foundry LLC",
      displayName: "No Current PMA Foundry",
      headquartersCountryCode: "US",
    });
    const candidateId = await insertCandidate(companyId, "partner_review");
    const agent = await insertAgent({
      key: "faa-pma-targeted",
      agentType: "discover_source",
    });
    const searchFaaPma: NonNullable<TickHandlerDeps["searchFaaPma"]> = vi.fn(
      async (queryInput) => {
        if (
          typeof queryInput !== "object" ||
          queryInput === null ||
          !("holderName" in queryInput) ||
          typeof queryInput.holderName !== "string" ||
          !("maxRecords" in queryInput) ||
          typeof queryInput.maxRecords !== "number"
        ) {
          throw new Error("FAA holder query was not supplied");
        }
        const query = {
          holderName: queryInput.holderName,
          maxRecords: queryInput.maxRecords,
        };
        return {
          query,
          records: [],
          source: {
            publicUrl: "https://drs.faa.gov/browse/PMA/doctypeDetails" as const,
            scrapedAt: "2026-08-25T13:00:00.000Z",
            retrievalMethod: "guest_browser_dom" as const,
          },
        };
      },
    );
    const handler = createV1TickHandlerRegistry({
      ...depsWith({}),
      searchFaaPma,
    }).get("discover_source")!;

    const first = await handler({
      agent,
      signal: new AbortController().signal,
    });
    const second = await handler({
      agent,
      signal: new AbortController().signal,
    });
    expect(first).toMatchObject({
      outcome: "executed",
      findings: {
        companyId,
        fetched: 0,
        harvested: 0,
        checkpointStatus: "rejected",
      },
    });
    expect(second.findings).not.toMatchObject({ companyId });
    const targetQueries = vi
      .mocked(searchFaaPma)
      .mock.calls.filter(([query]) => {
        return (
          typeof query === "object" &&
          query !== null &&
          "holderName" in query &&
          query.holderName === "No Current PMA Foundry LLC"
        );
      });
    expect(targetQueries).toHaveLength(1);
    const checkpoints = (
      await getDatabase()
        .select()
        .from(sourceSignals)
        .where(eq(sourceSignals.agentId, agent.id))
    ).filter((signal) => signal.companyId === companyId);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      sourceKey: "faa_drs_pma_search",
      companyId,
      status: "rejected",
      qualification: {
        decision: "no_target",
        reason: "no_current_pma_records",
      },
      sourcePayload: {
        query: { holderName: "No Current PMA Foundry LLC", maxRecords: 25 },
        recordCount: 0,
        cache: { hit: false, ttlMs: 86_400_000 },
        knownCompanyHint: { candidateId, companyId },
        source: { retrievalMethod: "guest_browser_dom" },
      },
    });
    expect(checkpoints[0]?.sourcePayload["checkedAt"]).toEqual(expect.any(String));
    expect(
      await getDatabase().select().from(leads).where(eq(leads.campaignId, agent.id)),
    ).toHaveLength(0);
  });

  it("discover_source (FAA targeted): rechecks a company after its checkpoint is 31 days old", async () => {
    vi.stubEnv("FAA_DRS_BROWSER_ENABLED", "true");
    gatewayWithContents([planEnvelope([{ source: "faa_pma_targeted" }])]);
    const companyId = await insertCompany({
      legalName: "Stale PMA Check Aerospace LLC",
      displayName: "Stale PMA Check Aerospace",
      headquartersCountryCode: "US",
    });
    const candidateId = await insertCandidate(companyId, "partner_review");
    const agent = await insertAgent({
      key: "faa-pma-targeted",
      agentType: "discover_source",
    });
    const oldCheckedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000);
    await getDatabase().insert(sourceSignals).values({
      sourceKey: "faa_drs_pma_search",
      sourceLocator:
        "https://drs.faa.gov/browse/PMA/doctypeDetails?holderName=Stale",
      sourceFingerprint: "faa-stale-checkpoint-test",
      agentId: agent.id,
      rawName: "Stale PMA Check Aerospace LLC",
      companyId,
      sourcePayload: {
        checkedAt: oldCheckedAt.toISOString(),
        recordCount: 0,
        knownCompanyHint: { candidateId, companyId },
      },
      status: "rejected",
      qualification: {
        decision: "no_target",
        reason: "no_current_pma_records",
      },
      createdAt: oldCheckedAt,
      updatedAt: oldCheckedAt,
      rejectedAt: oldCheckedAt,
    });
    const searchFaaPma: NonNullable<TickHandlerDeps["searchFaaPma"]> = vi.fn(
      async () => ({
        query: { holderName: "Stale PMA Check Aerospace LLC", maxRecords: 25 },
        records: [],
        source: {
          publicUrl: "https://drs.faa.gov/browse/PMA/doctypeDetails" as const,
          scrapedAt: "2026-08-25T14:00:00.000Z",
          retrievalMethod: "guest_browser_dom" as const,
        },
      }),
    );
    const result = await createV1TickHandlerRegistry({
      ...depsWith({}),
      searchFaaPma,
    }).get("discover_source")!({
      agent,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      outcome: "executed",
      findings: {
        companyId,
        fetched: 0,
        checkpointStatus: "rejected",
      },
    });
    expect(searchFaaPma).toHaveBeenCalledWith({
      holderName: "Stale PMA Check Aerospace LLC",
      maxRecords: 25,
    });
    const checkpoints = await getDatabase()
      .select()
      .from(sourceSignals)
      .where(eq(sourceSignals.agentId, agent.id));
    expect(checkpoints).toHaveLength(2);
    expect(
      checkpoints.filter(
        (checkpoint) => checkpoint.createdAt.getTime() > oldCheckedAt.getTime(),
      ),
    ).toHaveLength(1);
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
    const searchedMonths: string[] = [];
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
        searchedMonths.push(query.timePeriod.startDate.slice(0, 7));
        return recipients;
      },
    });

    const first = await handler.get("discover_source")!({
      agent,
      signal: new AbortController().signal,
    });
    expect(first.outcome).toBe("executed");
    expect(first.findings).toMatchObject({
      harvested: 2,
      duplicates: 0,
      fetched: 2,
      pendingMonths: 11,
      completedMonths: 1,
      continuation: false,
    });
    expect(searchCalls).toBe(1);
    const initialQueries = await getDatabase()
      .select()
      .from(frontierItems)
      .where(eq(frontierItems.agentId, agent.id));
    expect(initialQueries).toHaveLength(12);
    expect(initialQueries.filter((item) => item.status === "done")).toHaveLength(1);
    expect(initialQueries.filter((item) => item.status === "pending")).toHaveLength(11);
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
    expect(second.findings).toMatchObject({
      harvested: 0,
      duplicates: 2,
      pendingMonths: 10,
      completedMonths: 2,
    });
    expect(searchCalls).toBe(2);
    expect(searchedMonths[1]).not.toBe(searchedMonths[0]);
  });

  it("discover_source saves all 25 fetched rows without output truncation", async () => {
    const recipients = Array.from({ length: 25 }, (_, index) => ({
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
      fetched: 25,
      harvested: 25,
      duplicates: 0,
      rejected: { outputCap: 0 },
    });
    const signals = await getDatabase()
      .select()
      .from(sourceSignals)
      .where(eq(sourceSignals.agentId, agent.id));
    expect(signals).toHaveLength(25);
  });
  it("walks a continuation before advancing to the next monthly window", async () => {
    gatewayWithContents([
      planEnvelope([{ source: "usaspending" }]),
      planEnvelope([{ source: "usaspending" }]),
      planEnvelope([{ source: "usaspending" }]),
    ]);
    const agent = await insertAgent({
      key: "discover-usaspending-pagination-test",
      agentType: "discover_source",
    });
    const pageCalls: Array<{
      readonly month: string;
      readonly startPage: number | undefined;
      readonly cursor: { readonly sortValue: string; readonly uniqueId: number } | null | undefined;
    }> = [];
    const handler = createV1TickHandlerRegistry(
      depsWith({
        searchRecipients: async () => [],
        searchRecipientsPage: async (query) => {
          pageCalls.push({
            month: query.timePeriod.startDate.slice(0, 7),
            startPage: query.startPage,
            cursor: query.cursor,
          });
          const call = pageCalls.length;
          return {
            leads: [
              {
                rawName: `Paged Aerospace Manufacturer ${call}`,
                uei: `PAGE${String(call).padStart(8, "0")}`,
                naics: ["336413"],
                awardCount: 1,
                totalAwardValueUsd: 10_000,
                source: "usaspending" as const,
                sourceLocator: `usaspending://test/page-${call}`,
                sourceQualification: qualifiedSourceQualification(),
              },
            ],
            nextPage: call === 1 ? 2 : null,
            cursor: call === 1 ? { sortValue: "anchor-1", uniqueId: 101 } : null,
            qualificationFindings: {
              qualified: 1,
              rejected: {
                missingStrictNaics: 0,
                missingAerospaceDefenseEvidence: 0,
                excludedServiceWithoutManufacturing: 0,
              },
            },
          };
        },
      }),
    );

    const first = await handler.get("discover_source")!({
      agent,
      signal: new AbortController().signal,
    });
    expect(first.findings).toMatchObject({
      page: 1,
      continuation: true,
      pendingMonths: 12,
      completedMonths: 0,
    });
    const afterFirst = await getDatabase()
      .select()
      .from(frontierItems)
      .where(eq(frontierItems.agentId, agent.id));
    expect(afterFirst).toHaveLength(12);
    const continued = afterFirst.find((item) => item.payload["resumePage"] === 2);
    expect(continued).toMatchObject({
      status: "pending",
      payload: {
        resumePage: 2,
        cursorSortValue: "anchor-1",
        cursorUniqueId: 101,
      },
    });

    const second = await handler.get("discover_source")!({
      agent,
      signal: new AbortController().signal,
    });
    expect(second.findings).toMatchObject({
      page: 2,
      cursor: { sortValue: "anchor-1", uniqueId: 101 },
      continuation: false,
      pendingMonths: 11,
      completedMonths: 1,
    });
    expect(pageCalls[1]).toMatchObject({
      month: pageCalls[0]!.month,
      startPage: 2,
      cursor: { sortValue: "anchor-1", uniqueId: 101 },
    });

    const third = await handler.get("discover_source")!({
      agent,
      signal: new AbortController().signal,
    });
    expect(third.findings).toMatchObject({ page: 1, continuation: false });
    expect(pageCalls[2]!.month).not.toBe(pageCalls[0]!.month);
    expect(pageCalls[2]!.startPage).toBe(1);
  });

  it("reclaims a stale cursor after restart without duplicating a source signal", async () => {
    gatewayWithContents([
      planEnvelope([{ source: "usaspending" }]),
      planEnvelope([{ source: "usaspending" }]),
    ]);
    const agent = await insertAgent({
      key: "discover-usaspending-restart-test",
      agentType: "discover_source",
    });
    const startPages: number[] = [];
    const handler = createV1TickHandlerRegistry(
      depsWith({
        searchRecipients: async () => [],
        searchRecipientsPage: async (query) => {
          const startPage = query.startPage ?? 1;
          startPages.push(startPage);
          return {
            leads: [
              {
                rawName: "Restart Safe Aerospace LLC",
                uei: "RESTART00001",
                naics: ["336413"],
                awardCount: 1,
                totalAwardValueUsd: 5_000,
                source: "usaspending" as const,
                sourceLocator: "usaspending://test/restart-safe",
                sourceQualification: qualifiedSourceQualification(),
              },
            ],
            nextPage: startPage === 1 ? 2 : null,
            cursor:
              startPage === 1 ? { sortValue: "restart-anchor", uniqueId: 202 } : null,
            qualificationFindings: {
              qualified: 1,
              rejected: {
                missingStrictNaics: 0,
                missingAerospaceDefenseEvidence: 0,
                excludedServiceWithoutManufacturing: 0,
              },
            },
          };
        },
      }),
    );

    await handler.get("discover_source")!({
      agent,
      signal: new AbortController().signal,
    });
    const crashedClaim = await claimNextAgentQuery(agent.id);
    expect(crashedClaim?.payload).toMatchObject({
      resumePage: 2,
      cursorSortValue: "restart-anchor",
      cursorUniqueId: 202,
    });
    await getDatabase()
      .update(frontierItems)
      .set({
        lastAttemptAt: new Date(Date.now() - AGENT_QUERY_STALE_CLAIM_MS - 1_000),
      })
      .where(eq(frontierItems.id, crashedClaim!.id));

    const restarted = await handler.get("discover_source")!({
      agent,
      signal: new AbortController().signal,
    });
    expect(restarted.findings).toMatchObject({
      page: 2,
      duplicates: 1,
      continuation: false,
    });
    expect(startPages).toEqual([1, 2]);
    const signals = await getDatabase()
      .select()
      .from(sourceSignals)
      .where(eq(sourceSignals.agentId, agent.id));
    expect(signals).toHaveLength(1);
  });

  it("lets concurrent supervisors claim distinct monthly rows", async () => {
    const agent = await insertAgent({
      key: "discover-usaspending-concurrent-test",
      agentType: "discover_source",
    });
    await ensureAgentMonthlyQueries(agent.id, [
      {
        itemType: "query",
        normalizedValue: "usaspending:aerospace-components-default:2026-01",
        payload: {
          source: "usaspending",
          naics: ["336413"],
          timePeriod: { startDate: "2026-01-01", endDate: "2026-01-31" },
        },
      },
      {
        itemType: "query",
        normalizedValue: "usaspending:aerospace-components-default:2026-02",
        payload: {
          source: "usaspending",
          naics: ["336413"],
          timePeriod: { startDate: "2026-02-01", endDate: "2026-02-28" },
        },
      },
    ]);

    const [first, second] = await Promise.all([
      claimNextAgentQuery(agent.id),
      claimNextAgentQuery(agent.id),
    ]);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.id).not.toBe(second!.id);
    expect(first!.status).toBe("in_progress");
    expect(second!.status).toBe("in_progress");
  });

  it("retains the cursor across exponential error backoff and eventually fails", async () => {
    gatewayWithContents([
      planEnvelope([{ source: "usaspending" }]),
      planEnvelope([{ source: "usaspending" }]),
    ]);
    const agent = await insertAgent({
      key: "discover-usaspending-error-test",
      agentType: "discover_source",
    });
    await ensureAgentMonthlyQueries(agent.id, [
      {
        itemType: "query",
        normalizedValue: "usaspending:aerospace-components-default:2026-03",
        payload: {
          source: "usaspending",
          naics: ["336413"],
          timePeriod: { startDate: "2026-03-01", endDate: "2026-03-31" },
          resumePage: 7,
          cursorSortValue: "error-anchor",
          cursorUniqueId: 303,
        },
      },
    ]);
    const handler = createV1TickHandlerRegistry(
      depsWith({
        searchRecipients: async () => [],
        searchRecipientsPage: async () => {
          throw new Error("simulated USAspending outage");
        },
      }),
    );

    const firstStarted = Date.now();
    await expect(
      handler.get("discover_source")!({
        agent,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("simulated USAspending outage");
    const [afterFirst] = await getDatabase()
      .select()
      .from(frontierItems)
      .where(eq(frontierItems.agentId, agent.id));
    expect(afterFirst).toMatchObject({
      status: "pending",
      attemptCount: 1,
      failureReason: "simulated USAspending outage",
      payload: {
        resumePage: 7,
        cursorSortValue: "error-anchor",
        cursorUniqueId: 303,
      },
    });
    expect(afterFirst!.nextAttemptAt!.getTime() - firstStarted).toBeGreaterThanOrEqual(
      15 * 60_000,
    );

    await getDatabase()
      .update(frontierItems)
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(frontierItems.id, afterFirst!.id));
    const secondStarted = Date.now();
    await expect(
      handler.get("discover_source")!({
        agent,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("simulated USAspending outage");
    const [afterSecond] = await getDatabase()
      .select()
      .from(frontierItems)
      .where(eq(frontierItems.id, afterFirst!.id));
    expect(afterSecond).toMatchObject({
      status: "pending",
      attemptCount: 2,
      payload: {
        resumePage: 7,
        cursorSortValue: "error-anchor",
        cursorUniqueId: 303,
      },
    });
    expect(afterSecond!.nextAttemptAt!.getTime() - secondStarted).toBeGreaterThanOrEqual(
      30 * 60_000,
    );

    await getDatabase()
      .update(frontierItems)
      .set({ status: "in_progress", attemptCount: 5 })
      .where(eq(frontierItems.id, afterSecond!.id));
    const failed = await failAgentQuery(
      afterSecond!.id,
      "simulated USAspending outage",
      60_000,
    );
    expect(failed).toMatchObject({
      status: "failed",
      payload: {
        resumePage: 7,
        cursorSortValue: "error-anchor",
        cursorUniqueId: 303,
      },
    });
    const progress = await agentFrontierProgress(agent.id);
    expect(progress).toMatchObject({
      total: 1,
      pendingMonths: 0,
      completedMonths: 0,
      failed: 1,
      currentMonth: null,
      currentPage: null,
    });
  });


  it("qualify_award_lead applies the generic deterministic gate to all source keys", async () => {
    const qualifier = await insertAgent({
      key: "qualify-award-leads-test",
      agentType: "qualify_award_lead",
    });
    const rawSignals = [
      "Atlas Precision Components LLC",
      "Orbit Consulting LLC",
      "RAM Aerospace Inc",
      "Aircraft Parts Distributor LLC",
      "Identity Mismatch Manufacturing LLC",
    ];
    await getDatabase().insert(sourceSignals).values(
      rawSignals.map((rawName, index) => ({
        sourceKey:
          index === 0
            ? "sam_entity"
            : index === 2 || index === 4
              ? "faa_drs_pma"
              : "usaspending",
        sourceLocator:
          index === 0
            ? "sam://entity-information/v4/entities/QUALIFY0?naics=336413"
            : index === 2 || index === 4
              ? `https://drs.faa.gov/browse/PMA/doctypeDetails/${index === 2 ? "RAM-PQ00076WB" : "MISMATCH-PQ99999"}`
              : `usaspending://qualification/${index}`,
        sourceFingerprint: `qualification-test-${index}`,
        agentId: qualifier.id,
        rawName,
        ...(index === 0 ? { rawDomain: "sam-supplied.test" } : {}),
        city: "Huntsville",
        state: "AL",
        uei: `QUALIFY${index}`,
        awardCount: 1,
        awardValue: "1000.00",
        freshestAward: new Date("2026-01-01T00:00:00.000Z"),
        sourcePayload:
          index === 2 || index === 4
            ? {
                record: {
                  status: "Current",
                  holderName: rawName,
                  holderNumber: index === 2 ? "PQ00076WB" : "PQ99999ZZ",
                  fullAddress: `${rawName}, Huntsville, AL 35801`,
                  pmaPartNumber: index === 2 ? "RAM-305-17" : "MISMATCH-1",
                  partName: "Engine actuator bracket",
                  make: "Pratt & Whitney Canada",
                  models: ["PW305A", "PW305B"],
                  approvalBasis: "Test and computation",
                  renderedSourceText:
                    index === 2
                      ? "Status: Current. Holder: RAM Aerospace Inc. Holder number: PQ00076WB. PMA part RAM-305-17, Engine actuator bracket. Make: Pratt & Whitney Canada. Models: PW305A, PW305B. Approval basis: Test and computation."
                      : "Status: Current. Holder: Identity Mismatch Manufacturing LLC. Holder number: PQ99999ZZ. PMA part MISMATCH-1. Make: Pratt & Whitney Canada. Model: PW305A.",
                },
              }
            : index === 0
              ? {
                  matchedNaicsCodes: ["336413"],
                  rawEntity: { ueiSAM: "QUALIFY0", registrationStatus: "Active" },
                }
              : { award: index },
      })),
    );
    gatewayWithContents([planEnvelope([])]);
    const synthesizeSourceSignal: NonNullable<
      TickHandlerDeps["synthesizeSourceSignal"]
    > = vi.fn(async (_db, signalId) => ({
      status: "noop",
      sourceKey: signalId,
    }));
    const handler = createV1TickHandlerRegistry({
      ...depsWith({}),
      synthesizeSourceSignal,
      searchOfficialDomains: async (identity) => {
        const domain = `${identity.legalName.split(/\s+/u)[0]!.toLowerCase()}.test`;
        return [
          {
            domain,
            url: `https://${domain}/`,
            title: identity.legalName,
            textSnippet: "Official company website",
            score: 0.9,
          },
        ];
      },
      domainProber: {
        fetchText: async (url) => {
          const hostToken = new URL(url).hostname.split(".")[0]!;
          const companyName =
            rawSignals.find((name) => name.toLowerCase().startsWith(hostToken)) ?? "Other Company";
          return {
            ok: true,
            finalUrl: url,
            text: `${companyName} in Huntsville manufactures flight-control components for aerospace and defense programs.`,
          };
        },
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
      classifySourceSignal: async ({ legalName, pageUrl }) => {
        const manufacturer = legalName.includes("Atlas");
        const aerospaceDefenseRelevance = legalName.includes("Atlas");
        const needsMoreResearch = legalName.includes("RAM");
        return sourceSignalClassification(pageUrl, {
          manufacturer,
          aerospaceDefenseRelevance,
          ownershipType: needsMoreResearch ? "unknown" : "independent",
          sizeFit: needsMoreResearch ? "unknown" : "likely_under_50m",
          businessModel: legalName.includes("Distributor") ? "distributor" : "manufacturer",
          manufacturerEvidence: manufacturer
            ? {
                excerpt:
                  "manufactures flight-control components for aerospace and defense programs",
                url: pageUrl,
              }
            : null,
          aerospaceDefenseEvidence: aerospaceDefenseRelevance
            ? {
                excerpt:
                  "manufactures flight-control components for aerospace and defense programs",
                url: pageUrl,
              }
            : null,
        });
      },
    });
    const result = await handler.get("qualify_award_lead")!({
      agent: qualifier,
      signal: new AbortController().signal,
    });
    expect(result.findings).toMatchObject({
      selected: 5,
      statusTransitions: {
        "qualifying->qualified": 2,
        "qualifying->rejected": 3,
        "qualifying->quarantined": 0,
      },
      targetDecisions: {
        yes_target: 1,
        needs_more_research: 1,
        no_target: 3,
      },
    });
    const signals = await getDatabase()
      .select()
      .from(sourceSignals)
      .where(eq(sourceSignals.agentId, qualifier.id))
      .orderBy(asc(sourceSignals.rawName));
    const qualified = signals.filter((signal) => signal.status === "qualified");
    expect(qualified).toHaveLength(2);
    expect(qualified).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rawName: "Atlas Precision Components LLC",
          leadId: expect.any(String),
          companyId: expect.any(String),
        }),
        expect.objectContaining({
          rawName: "RAM Aerospace Inc",
          leadId: expect.any(String),
          companyId: expect.any(String),
        }),
      ]),
    );
    expect(synthesizeSourceSignal).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(synthesizeSourceSignal).mock.calls.map((call) => call[1]).sort(),
    ).toEqual(qualified.map((signal) => signal.id).sort());
    const atlas = qualified.find((signal) => signal.rawName.startsWith("Atlas"))!;
    const ram = qualified.find((signal) => signal.rawName.startsWith("RAM"))!;
    expect((atlas.qualification as Record<string, unknown>)["evidence"]).toMatchObject({
      modelProposal: {
        manufacturerEvidence: {
          excerpt:
            "manufactures flight-control components for aerospace and defense programs",
        },
      },
      deterministicDecision: { targetDecision: "yes_target" },
    });
    expect((ram.qualification as Record<string, unknown>)["evidence"]).toMatchObject({
      policyClassification: {
        manufacturer: true,
        aerospaceDefenseRelevance: true,
        ownershipType: "unknown",
        sizeFit: "unknown",
        proprietarySignals: expect.arrayContaining([
          "FAA PMA",
          "FAA PMA holder PQ00076WB",
          "FAA PMA part RAM-305-17",
        ]),
        manufacturerEvidence: {
          url: "https://drs.faa.gov/browse/PMA/doctypeDetails/RAM-PQ00076WB",
          excerpt: expect.stringContaining("PMA part RAM-305-17"),
        },
      },
      deterministicDecision: {
        targetDecision: "needs_more_research",
        reasons: ["ownership_requires_research", "size_requires_research"],
      },
      sourceContributions: {
        authoritativeOverride: {
          sourceKey: "faa_drs_pma",
          holderNumber: "PQ00076WB",
          ownershipProven: false,
          sizeProven: false,
        },
      },
    });
    expect(ram.qualification).toMatchObject({
      modelProposal: {
        manufacturer: false,
        aerospaceDefenseRelevance: false,
      },
      deterministicDecision: {
        targetDecision: "needs_more_research",
      },
      sourceContributions: {
        officialIdentity: { passed: true },
        authoritativeOverride: {
          sourceKey: "faa_drs_pma",
          url: "https://drs.faa.gov/browse/PMA/doctypeDetails/RAM-PQ00076WB",
        },
      },
    });
    const identityMismatch = signals.find((signal) =>
      signal.rawName.startsWith("Identity Mismatch"),
    )!;
    expect(identityMismatch).toMatchObject({
      sourceKey: "faa_drs_pma",
      status: "rejected",
      leadId: null,
    });
    expect(identityMismatch.qualification).toMatchObject({
      modelProposal: null,
      deterministicDecision: {
        targetDecision: "no_target",
        reasons: ["official_identity_not_verified"],
      },
    });
    expect(signals.filter((signal) => signal.status === "rejected")).toHaveLength(3);
    const leadRows = await getDatabase()
      .select()
      .from(leads)
      .where(eq(leads.campaignId, qualifier.id));
    expect(leadRows).toHaveLength(2);
    const verifiedOfficialDomains = await getDatabase()
      .select({
        companyId: companyDomains.companyId,
        domain: companyDomains.domain,
        isPrimary: companyDomains.isPrimary,
        verifiedAt: companyDomains.verifiedAt,
      })
      .from(companyDomains)
      .where(
        inArray(
          companyDomains.companyId,
          qualified.map((signal) => signal.companyId!),
        ),
      );
    expect(verifiedOfficialDomains).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          domain: "atlas.test",
          isPrimary: true,
          verifiedAt: expect.any(Date),
        }),
        expect.objectContaining({
          domain: "ram.test",
          isPrimary: true,
          verifiedAt: expect.any(Date),
        }),
      ]),
    );
    const unverifiedSourceDomains = await getDatabase()
      .select()
      .from(companyDomains)
      .where(
        inArray(companyDomains.domain, [
          "sam-supplied.test",
          "orbit.test",
          "aircraft.test",
          "identity.test",
        ]),
      );
    expect(unverifiedSourceDomains).toHaveLength(0);
    const routedCandidates = await getDatabase()
      .select({
        companyId: candidates.companyId,
        status: candidates.status,
        rationale: candidates.rationale,
        tierOverride: candidates.tierOverride,
        tierSource: candidates.tierSource,
      })
      .from(candidates)
      .where(
        inArray(
          candidates.companyId,
          qualified.map((signal) => signal.companyId!),
        ),
      );
    expect(routedCandidates).toHaveLength(2);
    expect(routedCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "queued_research",
          tierOverride: null,
          tierSource: "engine",
        }),
      ]),
    );
    const ramCandidate = routedCandidates.find(
      (candidate) => candidate.companyId === ram.companyId,
    )!;
    expect(ramCandidate.rationale.unknowns).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Ownership"),
        expect.stringContaining("Size fit"),
      ]),
    );
  });

  it("qualify_award_lead exact-links FAA and SAM identifiers before domain identity work", async () => {
    const qualifier = await insertAgent({
      key: "qualify-exact-source-identifiers-test",
      agentType: "qualify_award_lead",
    });
    const faaCompanyId = await insertCompany({
      legalName: "RAM Aerospace Inc",
      displayName: "RAM Aerospace",
    });
    const samCompanyId = await insertCompany({
      legalName: "Exact SAM Aerospace LLC",
      displayName: "Exact SAM Aerospace",
    });
    const conflictingUeiCompanyId = await insertCompany({
      legalName: "Conflicting UEI Company LLC",
      displayName: "Conflicting UEI Company",
    });
    const conflictingCageCompanyId = await insertCompany({
      legalName: "Conflicting CAGE Company LLC",
      displayName: "Conflicting CAGE Company",
    });
    await getDatabase().insert(companyIdentifiers).values([
      {
        companyId: faaCompanyId,
        type: "faa_pma_holder",
        value: "PQ00076WB",
      },
      { companyId: samCompanyId, type: "uei", value: "SAMEXACT001" },
      { companyId: samCompanyId, type: "cage", value: "7SAM7" },
      {
        companyId: conflictingUeiCompanyId,
        type: "uei",
        value: "CONFLICTUEI1",
      },
      {
        companyId: conflictingCageCompanyId,
        type: "cage",
        value: "9BAD9",
      },
    ]);
    const insertedSignals = await getDatabase()
      .insert(sourceSignals)
      .values([
        {
          sourceKey: "faa_drs_pma",
          sourceLocator:
            "https://drs.faa.gov/browse/excelExternalWindow/DRSDOCIDRAMREPEAT",
          sourceFingerprint: "qualify-exact-faa-repeat",
          agentId: qualifier.id,
          rawName: "RAM Aerospace",
          sourcePayload: {
            record: { holderNumber: " pq00076wb " },
          },
        },
        {
          sourceKey: "sam_entity",
          sourceLocator:
            "sam://entity-information/v4/entities/SAMEXACT001?naics=336413",
          sourceFingerprint: "qualify-exact-sam",
          agentId: qualifier.id,
          rawName: "Exact SAM Aerospace LLC",
          uei: "samexact001",
          cage: "7sam7",
          sourcePayload: {},
        },
        {
          sourceKey: "sam_entity",
          sourceLocator:
            "sam://entity-information/v4/entities/CONFLICTUEI1?naics=336413",
          sourceFingerprint: "qualify-conflicting-sam",
          agentId: qualifier.id,
          rawName: "Conflicting Identifier Aerospace LLC",
          uei: "CONFLICTUEI1",
          cage: "9BAD9",
          sourcePayload: {},
        },
      ])
      .returning({ id: sourceSignals.id, sourceKey: sourceSignals.sourceKey });
    const searchOfficialDomains = vi.fn(async () => []);
    const fetchText = vi.fn(async () => ({
      ok: false as const,
      error: "must_not_probe",
    }));
    const judgeIdentity = vi.fn(async () => ({
      matches: false,
      confidence: 0,
      locationMatches: "unknown" as const,
      identifierMatches: "unknown" as const,
      relationship: "mismatch" as const,
      reason: "must not judge",
    }));
    const classifySourceSignal = vi.fn(async ({ pageUrl }: { pageUrl: string }) =>
      sourceSignalClassification(pageUrl),
    );
    const synthesizeSourceSignal: NonNullable<
      TickHandlerDeps["synthesizeSourceSignal"]
    > = vi.fn(async (_db, signalId) => ({
      status: "noop",
      sourceKey: signalId,
    }));
    gatewayWithContents([planEnvelope([])]);
    const result = await createV1TickHandlerRegistry({
      ...depsWith({}),
      searchOfficialDomains,
      domainProber: { fetchText },
      domainJudge: {
        proposeDomains: async () => [],
        judgeIdentity,
      },
      classifySourceSignal,
      synthesizeSourceSignal,
    }).get("qualify_award_lead")!({
      agent: qualifier,
      signal: new AbortController().signal,
    });

    expect(result.findings).toMatchObject({
      selected: 3,
      statusTransitions: {
        "qualifying->qualified": 2,
        "qualifying->quarantined": 1,
      },
      identifierResolution: { attached: 2, conflicts: 1 },
      synthesis: { materialized: 2, waitingForCompany: 0, errors: [] },
    });
    expect(searchOfficialDomains).not.toHaveBeenCalled();
    expect(fetchText).not.toHaveBeenCalled();
    expect(judgeIdentity).not.toHaveBeenCalled();
    expect(classifySourceSignal).not.toHaveBeenCalled();
    expect(synthesizeSourceSignal).toHaveBeenCalledTimes(2);
    const signals = await getDatabase()
      .select()
      .from(sourceSignals)
      .where(eq(sourceSignals.agentId, qualifier.id));
    const faaSignal = signals.find((signal) => signal.sourceKey === "faa_drs_pma")!;
    const samSignal = signals.find(
      (signal) => signal.sourceKey === "sam_entity" && signal.uei === "samexact001",
    )!;
    const conflict = signals.find((signal) => signal.uei === "CONFLICTUEI1")!;
    expect(faaSignal).toMatchObject({
      status: "qualified",
      companyId: faaCompanyId,
      leadId: expect.any(String),
      qualification: { reason: "exact_company_identifier" },
    });
    expect(samSignal).toMatchObject({
      status: "qualified",
      companyId: samCompanyId,
      leadId: expect.any(String),
      qualification: { reason: "exact_company_identifier" },
    });
    expect(conflict).toMatchObject({
      status: "quarantined",
      companyId: null,
      leadId: null,
      qualification: { reason: "confirmed_identity_conflict" },
    });
    const resolvedLeads = await getDatabase()
      .select()
      .from(leads)
      .where(eq(leads.campaignId, qualifier.id));
    expect(resolvedLeads).toHaveLength(2);
    expect(resolvedLeads.every((lead) => lead.status === "resolved")).toBe(true);
    expect(resolvedLeads.map((lead) => lead.resolvedCompanyId).sort()).toEqual(
      [faaCompanyId, samCompanyId].sort(),
    );
    expect(
      vi.mocked(synthesizeSourceSignal).mock.calls.map((call) => call[1]).sort(),
    ).toEqual(
      insertedSignals
        .filter((signal) => signal.sourceKey !== "sam_entity" || signal.id === samSignal.id)
        .map((signal) => signal.id)
        .sort(),
    );
  });

  it("reuses one resolved lead and identity match across SAM and repeated FAA records", async () => {
    const qualifier = await insertAgent({
      key: "qualify-idempotent-identifier-reuse-test",
      agentType: "qualify_award_lead",
    });
    const companyId = await insertCompany({
      legalName: "RAM Aerospace Inc",
      displayName: "RAM Aerospace",
    });
    await getDatabase().insert(companyIdentifiers).values([
      { companyId, type: "uei", value: "RAMSAMUEI01" },
      { companyId, type: "cage", value: "3RAM3" },
      { companyId, type: "faa_pma_holder", value: "PQ00999XY" },
    ]);
    await getDatabase().insert(companyDomains).values({
      companyId,
      domain: "ramaerospace.com",
      isPrimary: true,
      verifiedAt: new Date(),
    });
    const [staleLead] = await getDatabase()
      .insert(leads)
      .values({
        campaignId: qualifier.id,
        rawName: "RAM Aerospace",
        possibleDomain: "ram.space",
        status: "resolved",
        resolvedCompanyId: companyId,
        context: {},
      })
      .returning({ id: leads.id });
    await getDatabase().insert(identityMatchCandidates).values({
      leadId: staleLead!.id,
      companyId,
      signalType: "domain",
      features: { matchedValue: "ram.space" },
      confidence: "1.000",
      explanation: "Existing exact match",
      decision: "merged",
      decidedAt: new Date(),
    });
    const startedAt = Date.now() - 10_000;
    const insertedSignals = await getDatabase()
      .insert(sourceSignals)
      .values([
        {
          sourceKey: "sam_entity",
          sourceLocator:
            "sam://entity-information/v4/entities/RAMSAMUEI01?naics=336413",
          sourceFingerprint: "qualify-reuse-sam-first",
          agentId: qualifier.id,
          rawName: "RAM Aerospace Inc",
          uei: "RAMSAMUEI01",
          cage: "3RAM3",
          sourcePayload: {},
          createdAt: new Date(startedAt),
        },
        {
          sourceKey: "faa_drs_pma",
          sourceLocator:
            "https://drs.faa.gov/browse/excelExternalWindow/DRSDOCIDRAMONE",
          sourceFingerprint: "qualify-reuse-faa-one",
          agentId: qualifier.id,
          rawName: "RAM Aerospace",
          sourcePayload: { record: { holderNumber: "PQ00999XY" } },
          createdAt: new Date(startedAt + 1_000),
        },
        {
          sourceKey: "faa_drs_pma",
          sourceLocator:
            "https://drs.faa.gov/browse/excelExternalWindow/DRSDOCIDRAMTWO",
          sourceFingerprint: "qualify-reuse-faa-two",
          agentId: qualifier.id,
          rawName: "RAM Aerospace, Inc.",
          sourcePayload: { record: { holderNumber: "PQ00999XY" } },
          createdAt: new Date(startedAt + 2_000),
        },
      ])
      .returning({ id: sourceSignals.id });
    const searchOfficialDomains = vi.fn(async () => []);
    const synthesizeSourceSignal: NonNullable<
      TickHandlerDeps["synthesizeSourceSignal"]
    > = vi.fn(async (_db, signalId) => ({
      status: "noop",
      sourceKey: signalId,
    }));
    gatewayWithContents([planEnvelope([])]);
    const result = await createV1TickHandlerRegistry({
      ...depsWith({}),
      searchOfficialDomains,
      domainProber: {
        fetchText: async () => ({
          ok: false as const,
          error: "must_not_probe",
        }),
      },
      domainJudge: {
        proposeDomains: async () => [],
        judgeIdentity: async () => ({
          matches: false,
          confidence: 0,
          locationMatches: "unknown",
          identifierMatches: "unknown",
          relationship: "mismatch",
          reason: "must not judge",
        }),
      },
      classifySourceSignal: async ({ pageUrl }) =>
        sourceSignalClassification(pageUrl),
      synthesizeSourceSignal,
    }).get("qualify_award_lead")!({
      agent: qualifier,
      signal: new AbortController().signal,
    });

    expect(result.findings).toMatchObject({
      statusTransitions: {
        "qualifying->qualified": 3,
        "qualifying->quarantined": 0,
      },
      identifierResolution: { attached: 3, conflicts: 0 },
      synthesis: { materialized: 3, errors: [] },
    });
    expect(searchOfficialDomains).not.toHaveBeenCalled();
    const signals = await getDatabase()
      .select()
      .from(sourceSignals)
      .where(eq(sourceSignals.agentId, qualifier.id));
    expect(signals).toHaveLength(3);
    expect(
      signals.every(
        (signal) =>
          signal.status === "qualified" &&
          signal.companyId === companyId &&
          signal.leadId === staleLead!.id,
      ),
    ).toBe(true);
    expect(synthesizeSourceSignal).toHaveBeenCalledTimes(3);
    expect(
      vi.mocked(synthesizeSourceSignal).mock.calls.map((call) => call[1]).sort(),
    ).toEqual(insertedSignals.map((signal) => signal.id).sort());
    const matches = await getDatabase()
      .select()
      .from(identityMatchCandidates)
      .where(eq(identityMatchCandidates.leadId, staleLead!.id));
    expect(matches).toHaveLength(1);
    const [correctedLead] = await getDatabase()
      .select()
      .from(leads)
      .where(eq(leads.id, staleLead!.id));
    expect(correctedLead).toMatchObject({
      status: "resolved",
      resolvedCompanyId: companyId,
      possibleDomain: "ramaerospace.com",
      url: "https://ramaerospace.com",
    });
    await getDatabase().delete(leads).where(eq(leads.id, staleLead!.id));
  });

  it("leaves a qualified supported source waiting until a company is resolved", async () => {
    const qualifier = await insertAgent({
      key: "qualify-source-synthesis-wait-test",
      agentType: "qualify_award_lead",
    });
    const [signal] = await getDatabase()
      .insert(sourceSignals)
      .values({
        sourceKey: "sam_entity",
        sourceLocator: "sam://entity-information/v4/entities/WAITINGSAM01",
        sourceFingerprint: "qualification-synthesis-waiting",
        agentId: qualifier.id,
        rawName: "Waiting SAM Aerospace LLC",
        sourcePayload: {},
        status: "qualified",
        companyId: null,
      })
      .returning({ id: sourceSignals.id });
    const synthesizeSourceSignal: NonNullable<
      TickHandlerDeps["synthesizeSourceSignal"]
    > = vi.fn(async () => ({ status: "noop", sourceKey: "sam_entity" }));

    await expect(
      synthesizeQualifiedSignalIfReady(getDatabase(), signal!.id, {
        synthesizeSourceSignal,
      }),
    ).resolves.toBe("waiting");
    expect(synthesizeSourceSignal).not.toHaveBeenCalled();
    const [waiting] = await getDatabase()
      .select({ status: sourceSignals.status, companyId: sourceSignals.companyId })
      .from(sourceSignals)
      .where(eq(sourceSignals.id, signal!.id));
    expect(waiting).toEqual({ status: "qualified", companyId: null });
  });
  it("qualify_award_lead corroborates identity across two first-party pages only", async () => {
    const qualifier = await insertAgent({
      key: "qualify-award-multipage-test",
      agentType: "qualify_award_lead",
    });
    await getDatabase().insert(sourceSignals).values([
      {
        sourceKey: "usaspending",
        sourceLocator: "usaspending://qualification/zitec",
        sourceFingerprint: "qualification-zitec-multipage",
        agentId: qualifier.id,
        rawName: "Zitec USA LLC",
        city: "Niceville",
        state: "FL",
        cage: "ZITEC",
        awardCount: 1,
        awardValue: "1000.00",
        sourcePayload: {},
      },
      {
        sourceKey: "usaspending",
        sourceLocator: "usaspending://qualification/wrong-city",
        sourceFingerprint: "qualification-wrong-city",
        agentId: qualifier.id,
        rawName: "Wrong City Aerospace LLC",
        city: "Niceville",
        state: "FL",
        cage: "WRONG",
        awardCount: 1,
        awardValue: "1000.00",
        sourcePayload: {},
      },
    ]);
    const calls: string[] = [];
    gatewayWithContents([planEnvelope([])]);
    const handler = createV1TickHandlerRegistry({
      ...depsWith({}),
      searchOfficialDomains: async (identity) => [
        {
          domain: identity.legalName.startsWith("Zitec") ? "zitecusa.test" : "wrong-city.test",
          url: identity.legalName.startsWith("Zitec")
            ? "https://zitecusa.test/"
            : "https://wrong-city.test/",
          title: identity.legalName,
          textSnippet: "Official company website",
          score: 0.9,
        },
      ],
      identityPageProber: {
        fetchIdentityPage: async (url) => {
          calls.push(url);
          if (url === "https://zitecusa.test/") {
            return {
              ok: true,
              finalUrl: url,
              text: "Aerospace manufacturing programs.",
              identityLinks: [
                "https://zitecusa.test/about",
                "https://zitecusa.test/contact",
                "https://untrusted.example/about",
              ],
            };
          }
          if (url === "https://zitecusa.test/about") {
            return {
              ok: true,
              finalUrl: url,
              text:
                "The company manufactures aerospace components in Niceville, Florida. CAGE ZITEC.",
              identityLinks: [],
            };
          }
          if (url === "https://zitecusa.test/contact") {
            return {
              ok: true,
              finalUrl: url,
              text: "Contact information.",
              identityLinks: [],
            };
          }
          return {
            ok: true,
            finalUrl: url,
            text: "Wrong City Aerospace operates in Atlanta, Georgia.",
            identityLinks: [],
          };
        },
      },
      domainJudge: {
        proposeDomains: async () => [],
        judgeIdentity: async (legalName) => ({
          matches: !legalName.startsWith("Wrong City"),
          confidence: 0.98,
          locationMatches: !legalName.startsWith("Wrong City"),
          identifierMatches: !legalName.startsWith("Wrong City"),
          relationship: legalName.startsWith("Wrong City") ? "mismatch" : "exact",
          reason: "official pages identify the business",
        }),
      },
      classifySourceSignal: async ({ pageUrl }) => {
        const excerpt = "manufactures aerospace components in Niceville, Florida";
        return sourceSignalClassification(pageUrl, {
          manufacturerEvidence: { excerpt, url: pageUrl },
          aerospaceDefenseEvidence: { excerpt, url: pageUrl },
          confidence: 0.9,
        });
      },
    });
    const result = await handler.get("qualify_award_lead")!({
      agent: qualifier,
      signal: new AbortController().signal,
    });
    expect(result.findings).toMatchObject({
      statusTransitions: {
        "qualifying->qualified": 1,
        "qualifying->rejected": 1,
      },
    });
    expect(calls.filter((url) => url.startsWith("https://zitecusa.test/"))).toHaveLength(3);
    expect(calls).not.toContain("https://untrusted.example/about");
    const signals = await getDatabase()
      .select()
      .from(sourceSignals)
      .where(eq(sourceSignals.agentId, qualifier.id));
    const qualified = signals.find((signal) => signal.rawName === "Zitec USA LLC");
    const rejected = signals.find((signal) => signal.rawName === "Wrong City Aerospace LLC");
    expect(qualified?.status).toBe("qualified");
    expect(rejected?.status).toBe("rejected");
    expect((qualified?.qualification as Record<string, unknown>)["evidence"]).toMatchObject({
      identityUrls: [
        "https://zitecusa.test/",
        "https://zitecusa.test/about",
        "https://zitecusa.test/contact",
      ],
      corroborationUrl: "https://zitecusa.test/about",
      officiality: {
        origin: "https://zitecusa.test/",
        passed: true,
        method: "identifier_and_location",
        corroborationUrl: "https://zitecusa.test/about",
      },
    });
  });
  it("authenticates the root before deep evidence and suppresses blocked proposals before fetch", async () => {
    const qualifier = await insertAgent({
      key: "qualify-award-officiality-gate-test",
      agentType: "qualify_award_lead",
    });
    const names = [
      "Official Deep Aerospace LLC",
      "HigherGov Profile Target LLC",
      "Inknowvation Profile Target LLC",
      "Profiled Systems LLC",
    ];
    await getDatabase().insert(sourceSignals).values(
      names.map((rawName, index) => ({
        sourceKey: "exa_web_catalog",
        sourceLocator: `exa://officiality/${index}`,
        sourceFingerprint: `officiality-gate-${index}`,
        agentId: qualifier.id,
        rawName,
        awardCount: 1,
        awardValue: "1000.00",
        sourcePayload: {},
      })),
    );
    const calls: string[] = [];
    gatewayWithContents([planEnvelope([])]);
    const handler = createV1TickHandlerRegistry({
      ...depsWith({}),
      searchOfficialDomains: async (identity) => {
        const url = identity.legalName.startsWith("Official")
          ? "https://official-deep.test/capabilities"
          : identity.legalName.startsWith("HigherGov")
            ? "https://highergov.com/company/profile-target"
            : identity.legalName.startsWith("Inknowvation")
              ? "https://inknowvation.com/sbir/companies/profile-target"
              : "https://directory.test/profile/profiled-systems";
        return [
          {
            domain: new URL(url).hostname,
            url,
            title: identity.legalName,
            textSnippet: "Exa proposal",
            score: 0.9,
          },
        ];
      },
      identityPageProber: {
        fetchIdentityPage: async (url) => {
          calls.push(url);
          if (url === "https://official-deep.test/") {
            return {
              ok: true,
              finalUrl: url,
              text: "Contact | © Official Deep Aerospace LLC",
              identityLinks: [],
            };
          }
          if (url === "https://official-deep.test/capabilities") {
            return {
              ok: true,
              finalUrl: url,
              text: "We manufacture flight-control components for aerospace programs.",
              identityLinks: [],
            };
          }
          return {
            ok: true,
            finalUrl: url,
            text: "HigherGov government contracting intelligence and third-party vendor profiles.",
            identityLinks: [],
          };
        },
      },
      domainJudge: {
        proposeDomains: async () => [],
        judgeIdentity: async () => ({
          matches: true,
          confidence: 0.98,
          locationMatches: "unknown",
          identifierMatches: "unknown",
          relationship: "exact",
          reason: "root footer identifies the legal company",
        }),
      },
      classifySourceSignal: async () =>
        sourceSignalClassification("https://official-deep.test/capabilities", {
          manufacturerEvidence: {
            excerpt: "manufacture flight-control components for aerospace programs",
            url: "https://official-deep.test/capabilities",
          },
          aerospaceDefenseEvidence: {
            excerpt: "manufacture flight-control components for aerospace programs",
            url: "https://official-deep.test/capabilities",
          },
          confidence: 0.9,
        }),
    });
    const result = await handler.get("qualify_award_lead")!({
      agent: qualifier,
      signal: new AbortController().signal,
    });
    expect(result.findings).toMatchObject({
      statusTransitions: {
        "qualifying->qualified": 1,
        "qualifying->rejected": 3,
      },
    });
    expect(calls).toContain("https://official-deep.test/");
    expect(calls).toContain("https://official-deep.test/capabilities");
    expect(calls.indexOf("https://official-deep.test/")).toBeLessThan(
      calls.indexOf("https://official-deep.test/capabilities"),
    );
    expect(calls).toContain("https://directory.test/");
    expect(calls).not.toContain("https://directory.test/profile/profiled-systems");
    expect(calls.some((url) => url.includes("highergov.com"))).toBe(false);
    expect(calls.some((url) => url.includes("inknowvation.com"))).toBe(false);
    const rows = await getDatabase()
      .select({ rawName: sourceSignals.rawName, status: sourceSignals.status })
      .from(sourceSignals)
      .where(eq(sourceSignals.agentId, qualifier.id));
    expect(rows.find((row) => row.rawName.startsWith("Official"))?.status).toBe("qualified");
    expect(rows.filter((row) => !row.rawName.startsWith("Official")).every((row) => row.status === "rejected")).toBe(true);
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

  it("golden_neighbor: harvests bounded Exa company-list signals with provenance, never leads", async () => {
    gatewayWithContents([planEnvelope([{ archetypeFilters: {} }])]);
    const [golden] = await getDatabase()
      .insert(goldenExamples)
      .values({
        name: "Golden Drill Corp",
        reviewStatus: "proposed",
        archetypeFit: "positive",
        descriptionRaw: "Precision machining and landing gear component manufacturing",
        grataPayload: {
          industryNaics: ["336413"],
          products: ["landing gear components"],
          capabilities: ["five-axis machining"],
          category: "aircraft parts",
        },
      })
      .returning({ id: goldenExamples.id });
    createdGoldenIds.push(golden!.id);

    const seenQueries: string[] = [];
    const agent = await insertAgent({ key: "golden-neighbor-test", agentType: "golden_neighbor" });
    const handler = createV1TickHandlerRegistry(
      depsWith({
        searchExa: async (query) => {
          const queryIndex = seenQueries.length;
          seenQueries.push(query);
          return Array.from({ length: 10 }, (_, resultIndex) => {
            const index = queryIndex * 10 + resultIndex;
            return {
              title: `Neighbor Fasteners Co ${index}`,
              url: `https://neighbor-${index}.test/aerospace`,
              text: `Precision fasteners for aircraft landing gear result ${index}`,
              score: 0.91,
            };
          });
        },
      }),
    );

    const result = await handler.get("golden_neighbor")!({
      agent,
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe("executed");
    expect(result.findings).toMatchObject({
      source: "exa_golden_neighbor",
      examplesConsidered: 1,
      harvested: 25,
      fetched: 25,
    });
    expect(seenQueries).toHaveLength(3);
    expect(seenQueries.join(" ")).toContain("landing gear");
    const signals = await getDatabase()
      .select()
      .from(sourceSignals)
      .where(eq(sourceSignals.agentId, agent.id));
    expect(signals).toHaveLength(25);
    const firstSignal = signals.find((signal) => signal.rawDomain === "neighbor-0.test");
    expect(firstSignal).toMatchObject({
      sourceKey: "exa_golden_neighbor",
      rawDomain: "neighbor-0.test",
      status: "queued_qualification",
    });
    expect(firstSignal!.sourcePayload).toMatchObject({
      goldenNeighborOrigin: true,
      query: expect.stringContaining("landing gear"),
      snippet: "Precision fasteners for aircraft landing gear result 0",
      score: 0.91,
    });
    const leadRows = await getDatabase()
      .select()
      .from(leads)
      .where(eq(leads.campaignId, agent.id));
    expect(leadRows).toHaveLength(0);
  });

  it("golden_neighbor idles when no positive proposed or reviewed examples exist", async () => {
    gatewayWithContents([planEnvelope([{ archetypeFilters: {} }])]);
    const agent = await insertAgent({ key: "golden-neighbor-empty", agentType: "golden_neighbor" });
    const handler = createV1TickHandlerRegistry(depsWith({ searchExa: async () => [] }));
    const result = await handler.get("golden_neighbor")!({
      agent,
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe("done");
    expect(result.findings).toMatchObject({
      idleReason: "no_positive_golden_examples",
    });
  });

  it("source catalog scout stores authoritative Exa results only in data_sources", async () => {
    gatewayWithContents([planEnvelope([{ source: "source_catalog" }])]);
    let searchCalls = 0;
    const catalogPublisher = `catalog-${Math.random().toString(36).slice(2)}.test`;
    createdCatalogPublishers.push(catalogPublisher);
    const agent = await insertAgent({
      key: "source-catalog-scout-test",
      agentType: "discover_source",
    });
    const handler = createV1TickHandlerRegistry(
      depsWith({
        searchExa: async (query) => {
          const index = searchCalls % 6;
          searchCalls += 1;
          return [
            {
              title: `Authoritative Aerospace Directory ${index}`,
              url: `https://${catalogPublisher}/directory/${index}`,
              text: `Official directory result for ${query}`,
              score: 0.8 + index / 100,
            },
          ];
        },
      }),
    );

    const first = await handler.get("discover_source")!({
      agent,
      signal: new AbortController().signal,
    });
    expect(first.outcome).toBe("executed");
    expect(first.findings).toMatchObject({
      source: "source_catalog",
      queries: 6,
      cataloged: 6,
      duplicates: 0,
    });
    const catalogRows = await getDatabase()
      .select()
      .from(dataSources)
      .where(eq(dataSources.publisher, catalogPublisher))
      .orderBy(asc(dataSources.name));
    expect(catalogRows).toHaveLength(6);
    expect(catalogRows[0]).toMatchObject({
      access: "restricted_metadata_only",
      ingestion: "manual",
      publisher: catalogPublisher,
    });
    expect(JSON.parse(catalogRows[0]!.notes!)).toMatchObject({
      catalogScout: true,
      policy: {
        access: "unknown",
        ingestion: "manual_review_only",
        modelUse: "unknown_not_authorized",
      },
    });
    expect(
      await getDatabase()
        .select()
        .from(sourceSignals)
        .where(eq(sourceSignals.agentId, agent.id)),
    ).toHaveLength(0);
    expect(
      await getDatabase().select().from(leads).where(eq(leads.campaignId, agent.id)),
    ).toHaveLength(0);
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
