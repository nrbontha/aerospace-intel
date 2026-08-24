import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import {
  agentTicks,
  candidates,
  companies,
  companySourceLinks,
  dataSources,
  evidence,
  frontierItems,
  getDatabase,
  goldenExamples,
  ingestLeadCandidates,
  mapResearchRunInput,
  observations,
  ownershipObservations,
  researchRuns,
  sourceDocuments,
  leads,
  resolveLeadDomain,
  type AgentType,
  type Database,
  type DomainJudge,
  type DomainProber,
  type IdentityJudgment,
  type LeadCandidateInput,
  type LeadDomainDeps,
  type ResearchAgent,
  type ResolutionLogger,
  type ResolutionResult,
} from "@asi/database";
import {
  AEROSPACE_NAICS,
  AIRCRAFT_COMPONENT_PSC,
  CANDIDATE_RESEARCH_PROMPT_VERSION,
  collectCandidatePageLinks,
  frontierIdempotencyKey,
  OpenRouterClient,
  planTick,
  rescoreCandidateAfterResearch,
  safeFetchUrl,
  SafeFetchError,
  UsaspendingDiscoveryStrategy,
  wrapUntrustedSourceJson,
  type AgentPlan,
  type CampaignView,
  type FrontierItemView,
  type FrontierProposal,
  type OpenRouterAttemptTelemetry,
  type OpenRouterModelRouting,
  type RecentTickSummary,
  type SafeFetchResult,
  type EnrichCandidateAction,
  type GoldenNeighborAction,
  type MonitorOwnershipAction,
  type RefreshStaleAction,
  type UsaspendingSearchClient,
} from "@asi/research";

import {
  processCandidateResearch,
  type CandidateResearchProcessResult,
} from "../handlers/candidate-research.js";
import type {
  TickContext,
  TickHandler,
  TickHandlerRegistry,
  TickOutcomeReported,
  TickResult,
} from "./types.js";

/**
 * Real per-type executors (REDESIGN_PLAN §1.2 step 3–4, §1.3). Every handler:
 *   1. reads its durable state slice from Postgres,
 *   2. calls planTick (LLM propose → zod-validate → deterministic fallback),
 *   3. executes validated actions through existing workflows only,
 *   4. reports { plan, actionsExecuted, findings, costUsd } — the supervisor
 *      persists them on the agent_ticks row via completeTick.
 *
 * Budget gates and wall-time bounds live in the supervisor; handlers honor
 * the passed AbortSignal and stay bounded per tick by construction.
 */

// ---------------------------------------------------------------------------
// Injectable dependencies (tests fake the gateway / fetchers / search client).
// ---------------------------------------------------------------------------

/** USAspending recipient shape (structural subset of research's LeadCandidate). */
export interface DiscoveredRecipient {
  readonly rawName: string;
  readonly uei?: string;
  readonly domain?: string;
  readonly cageCode?: string;
  readonly city?: string;
  readonly state?: string;
  readonly naics?: readonly string[];
  readonly awardCount: number;
  readonly totalAwardValueUsd: number;
  readonly freshestAwardDate?: string;
  readonly sourceLocator: string;
}

export interface TickHandlerDeps {
  /** OpenRouter gateway; defaults to one built from OPENROUTER_API_KEY. */
  readonly client?: OpenRouterClient;
  readonly models?: OpenRouterModelRouting;
  /** USAspending search override (tests); default is the real client. */
  readonly searchRecipients?: UsaspendingSearchClient["searchRecipients"];
  /** Document fetcher override (tests); default is safe-fetch. */
  readonly fetchDocument?: (
    url: string,
    signal?: AbortSignal,
  ) => Promise<SafeFetchResult>;
  /** Deep-research executor override (tests); see {@link RunResearch}. */
  readonly runResearch?: RunResearch;
  /**
   * Skip the recent-document reuse window and always fetch+extract
   * (tests / explicit refresh runs); default honors the 24h idempotency.
   */
  readonly researchForceRefresh?: boolean;
  /** Domain-prober override (tests); default probes with browser-like headers. */
  readonly domainProber?: DomainProber;
  /** Domain-judge override (tests); default is the OpenRouter prompt-contract judge. */
  readonly domainJudge?: DomainJudge;
  /**
   * Per-lead resolver override (tests); default is the real resolveLeadDomain
   * service call. Exists because the service deliberately degrades on
   * model/fetch failures — tests need a deterministic throw point to prove
   * per-lead error isolation.
   */
  readonly resolveLead?: (
    db: Database,
    leadId: string,
    resolutionDeps: LeadDomainDeps,
    options?: { readonly maxCandidates?: number },
  ) => Promise<ResolutionResult>;
}

/** safe-fetch takes an options bag; normalize the handler-side signature. */
function defaultFetchDocument(
  url: string,
  signal?: AbortSignal,
): Promise<SafeFetchResult> {
  return signal === undefined ? safeFetchUrl(url) : safeFetchUrl(url, { signal });
}

/** Deep-research job request (same shape the pg-boss payload carries). */
export interface ResearchRunRequest {
  readonly researchRunId: string;
  readonly companyId: string;
}

export interface ResearchRunDeps {
  readonly client: OpenRouterClient;
  readonly models: OpenRouterModelRouting;
  readonly signal?: AbortSignal;
}

/**
 * Deep-research executor override (tests fake the whole bounded workflow);
 * production runs the real inline candidate-research pipeline.
 */
type RunResearch = (
  request: ResearchRunRequest,
  deps: ResearchRunDeps,
) => Promise<CandidateResearchProcessResult>;

interface ResolvedModelDeps {
  readonly client: OpenRouterClient;
  readonly models: OpenRouterModelRouting;
}

function envModels(): OpenRouterModelRouting {
  return {
    fast: process.env.OPENROUTER_MODEL_FAST ?? "openai/gpt-4.1-mini",
    deep: process.env.OPENROUTER_MODEL_DEEP ?? "openai/gpt-4.1",
    fallback:
      process.env.OPENROUTER_MODEL_FALLBACK ?? "anthropic/claude-sonnet-4",
  };
}

/** Resolve model access lazily; null ⇒ the handler idles honestly. */
function resolveModelDeps(
  deps: Partial<TickHandlerDeps>,
): ResolvedModelDeps | null {
  try {
    const client =
      deps.client ?? new OpenRouterClient(process.env.OPENROUTER_API_KEY ?? "");
    return { client, models: deps.models ?? envModels() };
  } catch {
    return null;
  }
}

const AGENT_HANDLERS: Record<
  AgentType,
  (deps: Partial<TickHandlerDeps>) => TickHandler
> = {
  discover_source: createDiscoverSourceHandler,
  enrich_candidate: createEnrichCandidateHandler,
  monitor_ownership: createMonitorOwnershipHandler,
  refresh_stale: createRefreshStaleHandler,
  golden_neighbor: createGoldenNeighborHandler,
  resolve_domain: createResolveDomainHandler,
};

export function createV1TickHandlerRegistry(
  deps: Partial<TickHandlerDeps> = {},
): TickHandlerRegistry {
  const registry = Object.entries(AGENT_HANDLERS).map(
    ([type, factory]) =>
      [type as AgentType, factory(deps)] as const satisfies readonly [
        AgentType,
        TickHandler,
      ],
  );
  return new Map(registry);
}

// ---------------------------------------------------------------------------
// Shared plumbing.
// ---------------------------------------------------------------------------

const MAX_STATE_IDS = 20;
const STALE_EVIDENCE_DAYS = 30;
const MAX_DOCUMENT_CHARACTERS = 120_000;
/** USAspending politeness budget: one page-set per tick. */
const MAX_LEADS_PER_TICK = 50;

const OWNERSHIP_TYPES = [
  "private",
  "public",
  "subsidiary",
  "government",
  "joint_venture",
  "cooperative",
  "unknown",
] as const;

async function recentTickSummaries(
  db: Database,
  agentId: string,
): Promise<RecentTickSummary[]> {
  const rows = await db
    .select({
      outcome: agentTicks.outcome,
      error: agentTicks.error,
      findings: agentTicks.findings,
    })
    .from(agentTicks)
    .where(eq(agentTicks.agentId, agentId))
    .orderBy(desc(agentTicks.startedAt))
    .limit(5);
  return rows.map((row) => ({
    outcome: row.outcome as string,
    error: row.error,
    findings: row.findings ?? {},
  }));
}

/**
 * One planning step for a real executor: build the durable state slice with
 * `readState`, call planTick, and return the plan. Returns a TickResult
 * instead when state reading fails or the gateway is unusable — the caller
 * short-circuits on `"outcome" in result`.
 */
async function planAgentTick(
  deps: Partial<TickHandlerDeps>,
  context: TickContext,
  readState: (db: Database) => Promise<Record<string, unknown>>,
): Promise<{ shortCircuit: TickResult } | { plan: AgentPlan }> {
  const db = getDatabase();
  let stateSlice: Record<string, unknown>;
  try {
    stateSlice = await readState(db);
  } catch (error) {
    return {
      shortCircuit: {
        outcome: "stuck",
        findings: {
          error: `state_read_failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      },
    };
  }
  const model = resolveModelDeps(deps);
  if (model === null) {
    // Every model-backed executor needs a usable gateway; report honestly
    // instead of burning a tick on deterministic-fallback busywork.
    return {
      shortCircuit: {
        outcome: "stuck",
        plan: { reasoning: "OpenRouter gateway unavailable", actions: [] },
        findings: { idleReason: "openrouter_not_configured" },
      },
    };
  }
  const plan = await planTick(
    {
      key: context.agent.key,
      agentType: context.agent.agentType,
      goal: context.agent.goal,
      seedScope: context.agent.seedScope ?? {},
    },
    stateSlice,
    await recentTickSummaries(db, context.agent.id),
    { client: model.client, models: model.models, signal: context.signal },
  );
  return { plan };
}

function telemetryCostUsd(
  attempts: readonly OpenRouterAttemptTelemetry[],
): number {
  return attempts.reduce((total, attempt) => total + (attempt.costUsd ?? 0), 0);
}

/** Collapse whitespace + lowercase — excerpt containment comparisons. */
function normalizeText(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}

function normalizedContains(haystack: string, needle: string): boolean {
  const needleNorm = normalizeText(needle);
  if (needleNorm.length === 0) return false;
  return normalizeText(haystack).includes(needleNorm);
}

/**
 * Same rendering the extraction prompts see (html → text), so verbatim
 * excerpts validate against this text rather than raw HTML.
 */
function stripHtmlToText(content: string, contentType: string): string {
  if (!contentType.includes("html")) {
    return content.replace(/\s+/gu, " ").trim();
  }
  return content
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&#\d+;/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function hostOf(url: string | null | undefined): string | null {
  if (url === undefined || url === null || url.trim() === "") return null;
  try {
    return new URL(url).host.replace(/^www\./u, "") || null;
  } catch {
    return null;
  }
}

/** "336411, 3364" / ["1560"] → ["336411","3364"] — tolerant code splitting. */
function codeList(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(/[,\s;]+/u)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      typeof item === "string"
        ? codeList(item)
        : typeof item === "number"
          ? [String(item)]
          : [],
    );
  }
  if (typeof value === "number") return [String(value)];
  return [];
}

// ---------------------------------------------------------------------------
// discover_source (+ golden_neighbor shared USAspending expansion).
// ---------------------------------------------------------------------------

const DISCOVER_SOURCE_KEY_HINTS = ["usaspending", "sam"] as const;

function discoverSourceKey(agent: ResearchAgent): string {
  const seeded = (agent.seedScope?.["sources"] as unknown) ?? undefined;
  if (Array.isArray(seeded)) {
    const first = seeded.find(
      (item): item is string => typeof item === "string" && item.trim() !== "",
    );
    if (first !== undefined) return first.trim().toLowerCase();
  }
  for (const hint of DISCOVER_SOURCE_KEY_HINTS) {
    if (agent.key.toLowerCase().includes(hint)) return hint;
  }
  return "usaspending";
}

const SAM_API_KEY_ENV = "SAM_API_KEY";

interface DiscoveryExpansion {
  readonly queryRan: boolean;
  readonly proposals: readonly FrontierProposal[];
  readonly queryValue: string | null;
}

/**
 * Run exactly ONE bounded USAspending page-set: source-item expansion →
 * first query proposal → recipient search via UsaspendingDiscoveryStrategy.
 */
async function runUsaspendingExpansion(
  agent: ResearchAgent,
  deps: Partial<TickHandlerDeps>,
  seeds: { naics: readonly string[]; psc: readonly string[] },
): Promise<DiscoveryExpansion> {
  const strategy =
    deps.searchRecipients === undefined
      ? new UsaspendingDiscoveryStrategy()
      : new UsaspendingDiscoveryStrategy({
          client: { searchRecipients: deps.searchRecipients },
        });
  // The strategy never reads the campaign view; a minimal stub suffices.
  const campaignStub = {
    id: "",
    name: "",
    objective: null,
    thesisVersion: "",
    policyVersion: "",
    seeds: {},
    excludedSources: [],
    budgetUsd: null,
    spendUsd: 0,
    maxDepth: 2,
    policy: {},
  } as unknown as CampaignView;

  const sourceView: FrontierItemView = {
    id: `agent-source-${agent.id}`,
    campaignId: "",
    itemType: "source",
    normalizedValue: `usaspending:${agent.key}`,
    parentItemId: null,
    discoveryPath: null,
    depth: 0,
    payload: { source: "usaspending" },
  };
  const queryProposals = await strategy.proposeFrontierItems(campaignStub, sourceView);
  const queryProposal = queryProposals[0];
  if (queryProposal === undefined) {
    return { queryRan: false, proposals: [], queryValue: null };
  }

  const queryView: FrontierItemView = {
    ...sourceView,
    itemType: "query",
    normalizedValue: queryProposal.normalizedValue,
    depth: 1,
    payload: {
      ...(queryProposal.payload ?? {}),
      naics: [...seeds.naics],
      psc: [...seeds.psc],
    } as Record<string, unknown>,
  };
  const allProposals = await strategy.proposeFrontierItems(
    campaignStub,
    queryView,
  );
  // Agents execute exactly ONE bounded page-set per tick and record their
  // items as done. Self-continuation proposals (same type + value as the
  // query item) are the campaign runner's requeue signal — recording them
  // here would create dead items, so drop them.
  const proposals = allProposals
    .filter(
      (proposal) =>
        !(
          proposal.itemType === "query" &&
          proposal.normalizedValue === queryProposal.normalizedValue
        ),
    )
    .slice(0, MAX_LEADS_PER_TICK);
  return { queryRan: true, proposals, queryValue: queryProposal.normalizedValue };
}

/** Persist produced items under the agent's ownership (idempotent keys). */
async function recordAgentFrontierProposals(
  db: Database,
  agent: ResearchAgent,
  parentValue: string | null,
  proposals: readonly FrontierProposal[],
): Promise<number> {
  let inserted = 0;
  for (const proposal of proposals) {
    const rows = await db
      .insert(frontierItems)
      .values({
        agentId: agent.id,
        itemType: proposal.itemType,
        normalizedValue: proposal.normalizedValue,
        discoveryPath: [
          agent.key,
          ...(parentValue === null ? [] : [parentValue]),
        ].join(" > "),
        priority: String(proposal.priority ?? 0),
        estimatedCostUsd: String(proposal.estimatedCostUsd ?? 0),
        depth: parentValue === null ? 0 : 1,
        status: "done",
        completedAt: new Date(),
        idempotencyKey: frontierIdempotencyKey(
          `agent:${agent.id}`,
          proposal.itemType,
          proposal.normalizedValue,
        ),
        payload: proposal.payload ?? {},
      })
      .onConflictDoNothing({ target: frontierItems.idempotencyKey })
      .returning({ id: frontierItems.id });
    inserted += rows.length;
  }
  return inserted;
}

/**
 * Ingest produced company items as leads and tag their discovery origin.
 * leads.campaign_id is a plain column (no FK): agents reuse it as their own
 * ingestion namespace, so dedupe keys and re-ingestion behave identically.
 */
async function ingestDiscoveredLeads(
  db: Database,
  agent: ResearchAgent,
  proposals: readonly FrontierProposal[],
  origin: string,
): Promise<{
  created: number;
  resolvedExact: number;
  probableReview: number;
  unresolved: number;
  duplicateSkipped: number;
}> {
  const leadInputs: LeadCandidateInput[] = [];
  for (const proposal of proposals) {
    if (proposal.itemType !== "company") continue;
    const payload = (proposal.payload ?? {}) as Record<string, unknown>;
    leadInputs.push({
      rawName:
        typeof payload.rawName === "string" ? payload.rawName : proposal.normalizedValue,
      ...(typeof payload.domain === "string" ? { domain: payload.domain } : {}),
      ...(typeof payload.uei === "string" ? { uei: payload.uei } : {}),
      ...(typeof payload.cageCode === "string" ? { cageCode: payload.cageCode } : {}),
      ...(typeof payload.city === "string" ? { city: payload.city } : {}),
      ...(typeof payload.state === "string" ? { state: payload.state } : {}),
      ...(Array.isArray(payload.naics)
        ? {
            naics: payload.naics.filter(
              (code): code is string => typeof code === "string",
            ),
          }
        : {}),
      awardCount: typeof payload.awardCount === "number" ? payload.awardCount : 0,
      totalAwardValueUsd:
        typeof payload.totalAwardValueUsd === "number"
          ? payload.totalAwardValueUsd
          : 0,
      ...(typeof payload.freshestAwardDate === "string"
        ? { freshestAwardDate: payload.freshestAwardDate }
        : {}),
      sourceLocator:
        typeof payload.sourceLocator === "string"
          ? payload.sourceLocator
          : `${proposal.itemType}:${proposal.normalizedValue}`,
    });
  }
  const summary = await ingestLeadCandidates(agent.id, leadInputs);
  if (summary.created > 0) {
    await db.execute(sql`
      UPDATE leads SET context = context || ${JSON.stringify({ discoveryOrigin: origin })}::jsonb
      WHERE campaign_id = ${agent.id} AND context->>'discoveryOrigin' IS NULL
    `);
  }
  return summary;
}

function createDiscoverSourceHandler(deps: Partial<TickHandlerDeps>): TickHandler {
  return async (context): Promise<TickResult> => {
    const agent = context.agent;
    const sourceKey = discoverSourceKey(agent);

    // SAM variant idles honestly without credentials — never pretends to work.
    if (sourceKey === "sam" && !process.env[SAM_API_KEY_ENV]) {
      return {
        outcome: "stuck",
        plan: { reasoning: `source ${sourceKey} requires SAM_API_KEY`, actions: [] },
        findings: { idle: true, idleReason: "missing_sam_api_key", source: sourceKey },
      };
    }

    const planned = await planAgentTick(deps, context, async () => ({
      knownSources: [sourceKey],
      suggestedQueries: [],
    }));
    if ("shortCircuit" in planned) return planned.shortCircuit;
    const { plan } = planned;
    const planJson = { ...plan };

    if (sourceKey !== "usaspending") {
      return {
        outcome: "stuck",
        plan: planJson,
        findings: {
          idleReason: `unsupported_source:${sourceKey}`,
          supportedSources: ["usaspending"],
        },
      };
    }

    const db = getDatabase();
    const expansion = await runUsaspendingExpansion(agent, deps, {
      naics: [...AEROSPACE_NAICS].slice(0, 8),
      psc: [...AIRCRAFT_COMPONENT_PSC].slice(0, 10),
    });
    if (!expansion.queryRan) {
      return { outcome: "stuck", plan: planJson, findings: { idleReason: "no_query_expansion" } };
    }
    const frontierInserted = await recordAgentFrontierProposals(
      db,
      agent,
      expansion.queryValue,
      expansion.proposals,
    );
    const summary = await ingestDiscoveredLeads(db, agent, expansion.proposals, "usaspending");
    return {
      outcome: "executed",
      plan: planJson,
      actionsExecuted: 1,
      findings: {
        source: "usaspending",
        query: expansion.queryValue,
        frontierItemsCreated: frontierInserted,
        newLeads: summary.created,
        resolvedExact: summary.resolvedExact,
        probableReview: summary.probableReview,
        unresolved: summary.unresolved,
        duplicateSkipped: summary.duplicateSkipped,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// enrich_candidate.
// ---------------------------------------------------------------------------

function defaultRunResearch(
  request: ResearchRunRequest,
  deps: ResearchRunDeps,
  forceRefresh?: boolean,
): Promise<CandidateResearchProcessResult> {
  return processCandidateResearch(request, {
    client: deps.client,
    models: deps.models,
    ...(forceRefresh === undefined ? {} : { forceRefresh }),
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });
}

/** seed_scope.candidateFilters → SQL (allowlisted primitive equality only). */
function seedFilterCondition(agent: ResearchAgent): SQL | undefined {
  const filters = agent.seedScope?.["candidateFilters"];
  if (typeof filters !== "object" || filters === null || Array.isArray(filters)) {
    return undefined;
  }
  const entries = Object.entries(filters as Record<string, unknown>).filter(
    (entry): entry is [string, string | number | boolean] =>
      typeof entry[1] === "string" ||
      typeof entry[1] === "number" ||
      typeof entry[1] === "boolean",
  );
  const conditions: SQL[] = [];
  for (const [key, value] of entries) {
    if (key === "headquartersCountryCode") {
      conditions.push(
        sql`upper(${companies.headquartersCountryCode}) = ${String(value).toUpperCase()}`,
      );
    } else if (key === "noveltyStatus") {
      conditions.push(sql`${candidates.noveltyStatus}::text = ${String(value)}`);
    }
  }
  if (conditions.length === 0) return undefined;
  return sql.join(conditions, sql` AND `);
}

function createEnrichCandidateHandler(deps: Partial<TickHandlerDeps>): TickHandler {
  return async (context): Promise<TickResult> => {
    const model = resolveModelDeps(deps);
    if (model === null) {
      return { outcome: "stuck", findings: { idleReason: "openrouter_not_configured" } };
    }

    const planned = await planAgentTick(deps, context, async (db) => {
      const filter = seedFilterCondition(context.agent);
      const rows = await db
        .select({ companyId: companies.id })
        .from(candidates)
        .innerJoin(companies, eq(companies.id, candidates.companyId))
        .where(
          filter === undefined
            ? eq(candidates.status, "queued_research")
            : and(eq(candidates.status, "queued_research"), filter),
        )
        .orderBy(asc(candidates.createdAt))
        .limit(MAX_STATE_IDS);
      return { queuedCompanyIds: rows.map((row) => row.companyId) };
    });
    if ("shortCircuit" in planned) return planned.shortCircuit;
    const { plan } = planned;
    const planJson = { ...plan };
    if (plan.actions.length === 0) {
      return {
        outcome: "done",
        plan: planJson,
        findings: { note: "no queued_research candidates in scope" },
      };
    }

    const db = getDatabase();
    // Validate against the CURRENT queued set (the LLM proposes; we verify).
    const queuedRows = await db
      .select({
        candidateId: candidates.id,
        companyId: companies.id,
        websiteUrl: companies.websiteUrl,
        displayName: companies.displayName,
        primaryDomain: sql<string | null>`(
          SELECT cd.domain FROM company_domains cd
          WHERE cd.company_id = ${companies.id}
          ORDER BY cd.is_primary DESC, cd.id LIMIT 1
        )`,
      })
      .from(candidates)
      .innerJoin(companies, eq(companies.id, candidates.companyId))
      .where(eq(candidates.status, "queued_research"));
    const queuedByCompanyId = new Map<string, (typeof queuedRows)[number]>(
      queuedRows.map((row) => [row.companyId, row]),
    );

    // wall-time bound: one deep research per tick
    const executedActions = plan.actions.slice(0, 1) as EnrichCandidateAction[];
    const results: Array<Record<string, unknown>> = [];
    let invalidActions = 0;
    let costUsd = plan.costUsd;

    for (const action of executedActions) {
      const target = queuedByCompanyId.get(action.companyId);
      if (target === undefined) {
        invalidActions += 1;
        continue;
      }
      // Same run-row shape enqueueCandidateResearch writes, minus pg-boss:
      // the tick executes the job inline instead of queueing it.
      const [run] = await db
        .insert(researchRuns)
        .values(
          mapResearchRunInput({
            targetType: "company",
            targetId: target.companyId,
            objective: `Agent enrichment (${context.agent.key}) for ${target.displayName}.`,
            metadata: {
              kind: "company",
              candidateId: target.candidateId,
              domain: hostOf(target.websiteUrl) ?? target.primaryDomain ?? "unknown",
              agentId: context.agent.id,
              agentKey: context.agent.key,
            },
            maxAttempts: 2,
            promptVersion: CANDIDATE_RESEARCH_PROMPT_VERSION,
          }),
        )
        .returning({ id: researchRuns.id });
      if (run === undefined) throw new Error("research run insert returned no row");

      try {
        const result = await (deps.runResearch === undefined
          ? defaultRunResearch(
              { researchRunId: run.id, companyId: target.companyId },
              { client: model.client, models: model.models, signal: context.signal },
              deps.researchForceRefresh,
            )
          : deps.runResearch(
              { researchRunId: run.id, companyId: target.companyId },
              { client: model.client, models: model.models, signal: context.signal },
            ));
        costUsd += result.costUsd ?? 0;
        results.push({
          candidateId: result.candidateId,
          companyId: target.companyId,
          observationsCreated: result.observationsCreated,
          evidenceCount: result.evidenceCount,
          fetchedUrls: result.fetchedUrls,
          scores: result.scores,
          status: "research_ready",
        });
      } catch (error) {
        results.push({
          companyId: target.companyId,
          status: "failed",
          error:
            error instanceof Error
              ? `${error.message}\n${error.stack}`
              : String(error),
        });
      }
    }

    const succeeded = results.filter((result) => result["status"] === "research_ready");
    const failed = results.filter((result) => result["status"] === "failed");
    const outcome: TickOutcomeReported =
      succeeded.length > 0 || failed.length === 0 ? "executed" : "stuck";
    return {
      outcome,
      plan: planJson,
      actionsExecuted: succeeded.length,
      findings: {
        enriched: succeeded,
        failed,
        invalidActions,
        skippedActions: Math.max(0, plan.actions.length - executedActions.length),
      },
      costUsd,
    };
  };
}

// ---------------------------------------------------------------------------
// monitor_ownership.
// ---------------------------------------------------------------------------

const OWNERSHIP_EXTRACTION_SCHEMA_NAME = "ownership_monitor_v1";

const ownershipExtractionSchema = z.strictObject({
  observations: z
    .array(
      z.strictObject({
        ownershipType: z.enum(OWNERSHIP_TYPES),
        ownerName: z.string().trim().min(1).optional(),
        ownershipPercentLower: z.number().min(0).max(100).optional(),
        ownershipPercentUpper: z.number().min(0).max(100).optional(),
        evidenceExcerpt: z.string().min(1),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(3),
});

/**
 * Explicit JSON contract in the prompt (free-tier gateways ignore
 * response_format json_schema; same pattern as candidate research).
 */
const OWNERSHIP_SYSTEM_PROMPT = `You extract ownership facts about one named company from one untrusted source document.
Output contract — reply with exactly one raw JSON object, no markdown fences, no commentary:
{"observations":[{"ownershipType":"<one of private|public|subsidiary|government|joint_venture|cooperative|unknown>","ownerName":"<parent/owner legal name when subsidiary or government>","ownershipPercentLower":<0..100>,"ownershipPercentUpper":<0..100>,"evidenceExcerpt":"<verbatim excerpt from the document>","confidence":<0..1>}]}
Rules:
- Only report statements with a verbatim excerpt present in the document.
- Omit unknown fields rather than guessing; return {"observations":[]} when nothing is supported.`;

interface StaleOwnershipTarget {
  readonly candidateId: string;
  readonly companyId: string;
  readonly displayName: string;
  readonly fetchUrl: string | null;
}

async function selectStaleOwnershipTargets(
  db: Database,
): Promise<StaleOwnershipTarget[]> {
  const result = await db.execute<{
    candidate_id: string;
    company_id: string;
    display_name: string;
    fetch_url: string | null;
  }>(sql`
    SELECT c.id AS candidate_id, co.id AS company_id, co.display_name,
           COALESCE(co.website_url,
             'https://' || NULLIF((
               SELECT cd.domain FROM company_domains cd
               WHERE cd.company_id = co.id ORDER BY cd.is_primary DESC, cd.id LIMIT 1
             ), '')
           ) AS fetch_url
    FROM candidates c
    JOIN companies co ON co.id = c.company_id
    WHERE c.status IN ('partner_review', 'shortlist', 'watchlist')
      AND COALESCE(
        (SELECT max(oo.observed_at) FROM ownership_observations oo WHERE oo.company_id = co.id),
        to_timestamp(0)
      ) < now() - INTERVAL '90 days'
    ORDER BY (SELECT max(oo.observed_at) FROM ownership_observations oo WHERE oo.company_id = co.id) ASC NULLS FIRST
    LIMIT ${MAX_STATE_IDS}
  `);
  return result.rows.map((row) => ({
    candidateId: row.candidate_id,
    companyId: row.company_id,
    displayName: row.display_name,
    fetchUrl: row.fetch_url,
  }));
}

async function appendRationaleRisk(
  db: Database,
  candidateId: string,
  message: string,
): Promise<void> {
  const [row] = await db
    .select({ rationale: candidates.rationale })
    .from(candidates)
    .where(eq(candidates.id, candidateId))
    .limit(1);
  if (row === undefined) return;
  const risks = [
    ...row.rationale.risks.slice(-9),
    `${new Date().toISOString()} ${message}`.slice(0, 500),
  ];
  await db
    .update(candidates)
    .set({ rationale: { ...row.rationale, risks } })
    .where(eq(candidates.id, candidateId));
}

/** Find-or-create the website data source, then persist document + evidence. */
async function persistOwnershipEvidenceChain(
  db: Database,
  input: {
    agentKey: string;
    companyId: string;
    displayName: string;
    document: { url: string; text: string };
    fetch?: SafeFetchResult;
    excerpt: string;
    contentSha256: string;
  },
): Promise<string> {
  const [linked] = await db
    .select({ dataSourceId: dataSources.id })
    .from(companySourceLinks)
    .innerJoin(dataSources, eq(dataSources.id, companySourceLinks.dataSourceId))
    .where(eq(companySourceLinks.companyId, input.companyId))
    .limit(1);
  let dataSourceId = linked?.dataSourceId;
  if (dataSourceId === undefined) {
    const baseUrl = input.fetch?.finalUrl ?? input.document.url;
    const [created] = await db
      .insert(dataSources)
      .values({
        name: `${input.displayName} website`,
        sourceType: "company_website",
        baseUrl,
        access: "public",
        ingestion: "web_fetch",
        publisher: input.displayName,
        notes: `Created by ownership monitoring (${input.agentKey}).`,
      })
      .onConflictDoNothing()
      .returning({ id: dataSources.id });
    if (created !== undefined) {
      dataSourceId = created.id;
    } else {
      const [existing] = await db
        .select({ id: dataSources.id })
        .from(dataSources)
        .where(eq(dataSources.baseUrl, baseUrl))
        .limit(1);
      if (existing === undefined) throw new Error("unable to resolve data source");
      dataSourceId = existing.id;
    }
    await db
      .insert(companySourceLinks)
      .values({ dataSourceId, companyId: input.companyId, relationship: "mentions" })
      .onConflictDoNothing();
  }

  const canonicalUrl = input.fetch?.finalUrl ?? input.document.url;
  const retrievedAt = input.fetch ? new Date(input.fetch.retrievedAt) : new Date();
  const documentMetadata = {
    promptVersion: "ownership-monitor.v1",
    agentKey: input.agentKey,
    requestedUrl: input.fetch?.requestedUrl ?? canonicalUrl,
  };
  // Same URL refetched into a fresh hash: reuse/refresh the stored row —
  // the evidence quote below is verified against the FRESH page text.
  const [existingDoc] = await db
    .select({ id: sourceDocuments.id })
    .from(sourceDocuments)
    .where(
      and(eq(sourceDocuments.dataSourceId, dataSourceId), eq(sourceDocuments.canonicalUrl, canonicalUrl)),
    )
    .limit(1);
  let documentId: string;
  if (existingDoc !== undefined) {
    await db
      .update(sourceDocuments)
      .set({
        retrievedAt,
        contentSha256: input.contentSha256,
        byteLength: input.fetch?.byteLength ?? null,
        metadata: {
          ...(documentMetadata),
          refreshedByAgentKey: input.agentKey,
          refreshedAt: new Date().toISOString(),
        },
      })
      .where(eq(sourceDocuments.id, existingDoc.id));
    documentId = existingDoc.id;
  } else {
    try {
      const [created] = await db
        .insert(sourceDocuments)
        .values({
          dataSourceId,
          canonicalUrl,
          title: `${input.displayName} website (ownership monitor)`,
          documentType: "web_page",
          retrievedAt,
          contentSha256: input.contentSha256,
          mimeType: input.fetch?.contentType ?? "text/html",
          byteLength: input.fetch?.byteLength ?? null,
          metadata: documentMetadata,
        })
        .returning({ id: sourceDocuments.id });
      if (created === undefined) throw new Error("source document insert returned no row");
      documentId = created.id;
    } catch (error) {
      // Identical bytes already stored under a different data source: link
      // the fresh evidence to the existing document instead of duplicating.
      if ((error as { code?: string }).code !== "23505") throw error;
      const [byHash] = await db
        .select({ id: sourceDocuments.id })
        .from(sourceDocuments)
        .where(eq(sourceDocuments.contentSha256, input.contentSha256))
        .limit(1);
      if (byHash === undefined) throw error;
      documentId = byHash.id;
    }
  }

  const [evidenceRow] = await db
    .insert(evidence)
    .values({
      sourceDocumentId: documentId,
      extractionStatus: "completed",
      quote: input.excerpt,
      extractionMethod: "ownership-monitor.v1",
      contentSha256: input.contentSha256,
      metadata: { promptVersion: "ownership-monitor.v1", agentKey: input.agentKey },
    })
    .returning({ id: evidence.id });
  if (evidenceRow === undefined) throw new Error("unable to persist evidence");
  return evidenceRow.id;
}

async function monitorOneCompany(input: {
  agent: ResearchAgent;
  deps: Partial<TickHandlerDeps>;
  model: ResolvedModelDeps;
  signal: AbortSignal;
  target: StaleOwnershipTarget;
}): Promise<{
  written: Array<Record<string, unknown>>;
  conflicts: Array<Record<string, unknown>>;
  failures: Array<Record<string, unknown>>;
  costUsd: number;
}> {
  const { agent, deps, model, signal, target } = input;
  const db = getDatabase();
  const fetchDocument = deps.fetchDocument ?? defaultFetchDocument;
  const written: Array<Record<string, unknown>> = [];
  const conflicts: Array<Record<string, unknown>> = [];
  const failures: Array<Record<string, unknown>> = [];

  // ≤3 safe fetches: homepage first, then up to two about/products-style pages.
  const homepage = await fetchDocument(target.fetchUrl!, signal);
  const linkedUrls = collectCandidatePageLinks(homepage.content, homepage.finalUrl, 2);
  const documents: Array<{ url: string; text: string; fetch?: SafeFetchResult }> = [
    {
      url: homepage.finalUrl,
      text: stripHtmlToText(homepage.content, homepage.contentType).slice(
        0,
        MAX_DOCUMENT_CHARACTERS,
      ),
      fetch: homepage,
    },
  ];
  for (const url of linkedUrls.slice(0, 2)) {
    try {
      const page = await fetchDocument(url, signal);
      documents.push({
        url: page.finalUrl,
        text: stripHtmlToText(page.content, page.contentType).slice(
          0,
          MAX_DOCUMENT_CHARACTERS,
        ),
        fetch: page,
      });
    } catch {
      // Dead subpage must not fail the whole verification pass.
    }
  }

  const [prior] = await db
    .select({
      type: ownershipObservations.type,
      ownerName: ownershipObservations.ownerName,
    })
    .from(ownershipObservations)
    .where(eq(ownershipObservations.companyId, target.companyId))
    .orderBy(desc(ownershipObservations.observedAt))
    .limit(1);

  let costUsd = 0;
  for (const document of documents) {
    const untrustedData = JSON.stringify({
      company: { id: target.companyId, displayName: target.displayName },
      knownOwnership: prior ?? null,
      retrievedUrl: document.url,
      content: document.text,
    });
    const extraction = await model.client.generateStructured({
      route: "fast",
      models: model.models,
      schemaName: OWNERSHIP_EXTRACTION_SCHEMA_NAME,
      schema: ownershipExtractionSchema,
      systemPrompt: OWNERSHIP_SYSTEM_PROMPT,
      prompt: wrapUntrustedSourceJson(untrustedData),
      temperature: 0,
      maxOutputTokens: 2_000,
      maxAttempts: 2,
      signal,
    });
    costUsd += telemetryCostUsd(extraction.telemetry.attempts);

    for (const observation of extraction.data.observations) {
      if (!normalizedContains(document.text, observation.evidenceExcerpt)) {
        failures.push({
          candidateId: target.candidateId,
          reason: "excerpt_not_found_in_document",
        });
        continue;
      }
      try {
        const evidenceId = await persistOwnershipEvidenceChain(db, {
          agentKey: agent.key,
          companyId: target.companyId,
          displayName: target.displayName,
          document,
          ...(document.fetch === undefined ? {} : { fetch: document.fetch }),
          excerpt: observation.evidenceExcerpt,
          contentSha256: extraction.telemetry.responseSha256,
        });
        await db.insert(ownershipObservations).values({
          companyId: target.companyId,
          type: observation.ownershipType,
          ownerName: observation.ownerName ?? null,
          ownershipPercentLower:
            observation.ownershipPercentLower === undefined
              ? null
              : String(observation.ownershipPercentLower),
          ownershipPercentUpper:
            observation.ownershipPercentUpper === undefined
              ? null
              : String(observation.ownershipPercentUpper),
          confidence: String(observation.confidence),
          evidenceId,
          observedAt: new Date(),
        });

        // Flag conflicts; NEVER rewrite or delete prior observations.
        if (
          prior !== undefined &&
          (prior.type !== observation.ownershipType ||
            (prior.ownerName !== null &&
              observation.ownerName !== undefined &&
              normalizeText(prior.ownerName) !== normalizeText(observation.ownerName)))
        ) {
          conflicts.push({
            candidateId: target.candidateId,
            companyId: target.companyId,
            previous: { type: prior.type, ownerName: prior.ownerName },
            observed: {
              type: observation.ownershipType,
              ownerName: observation.ownerName ?? null,
            },
          });
          await appendRationaleRisk(
            db,
            target.candidateId,
            `ownership conflict flagged by ${agent.key}: ${prior.type}${prior.ownerName ? `/${prior.ownerName}` : ""} vs ${observation.ownershipType}${observation.ownerName ? `/${observation.ownerName}` : ""}`,
          );
        }

        written.push({
          candidateId: target.candidateId,
          companyId: target.companyId,
          ownershipType: observation.ownershipType,
          ownerName: observation.ownerName ?? null,
          evidenceId,
        });
        await rescoreCandidateAfterResearch(db, target.candidateId);
      } catch (error) {
        const cause = (error as { cause?: unknown })?.cause;
        failures.push({
          candidateId: target.candidateId,
          reason:
            error instanceof Error
              ? `${error.message}${cause === undefined ? "" : ` :: ${String(cause)}`}`
              : String(error),
        });
      }
    }
    if (written.length > 0) break; // one verified statement per company per tick
  }

  if (written.length === 0 && failures.length === 0) {
    failures.push({
      candidateId: target.candidateId,
      reason: "no_supported_observations",
    });
  }
  return { written, conflicts, failures, costUsd };
}

function createMonitorOwnershipHandler(
  deps: Partial<TickHandlerDeps>,
): TickHandler {
  return async (context): Promise<TickResult> => {
    const model = resolveModelDeps(deps);
    if (model === null) {
      return { outcome: "stuck", findings: { idleReason: "openrouter_not_configured" } };
    }

    const planned = await planAgentTick(deps, context, async (db) => {
      const stale = await selectStaleOwnershipTargets(db);
      return { staleCandidateIds: stale.map((target) => target.candidateId) };
    });
    if ("shortCircuit" in planned) return planned.shortCircuit;
    const { plan } = planned;
    const planJson = { ...plan };

    const db = getDatabase();
    const targets = await selectStaleOwnershipTargets(db);
    const byCandidateId = new Map(targets.map((target) => [target.candidateId, target] as const));
    const executedActions = plan.actions.slice(0, 2) as MonitorOwnershipAction[];

    let writtenCount = 0;
    const conflicts: Array<Record<string, unknown>> = [];
    const failures: Array<Record<string, unknown>> = [];
    let invalidActions = 0;
    let costUsd = plan.costUsd;

    for (const action of executedActions) {
      const target = byCandidateId.get(action.candidateId);
      if (target === undefined) {
        invalidActions += 1;
        continue;
      }
      if (target.fetchUrl === null) {
        failures.push({ candidateId: target.candidateId, reason: "missing_url" });
        continue;
      }
      try {
        const result = await monitorOneCompany({
          agent: context.agent,
          deps,
          model,
          signal: context.signal,
          target,
        });
        costUsd += result.costUsd;
        writtenCount += result.written.length;
        conflicts.push(...result.conflicts);
        failures.push(...result.failures);
      } catch (error) {
        failures.push({
          candidateId: target.candidateId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const outcome: TickOutcomeReported =
      writtenCount > 0 || failures.length === 0 ? "executed" : "stuck";
    return {
      outcome,
      plan: planJson,
      actionsExecuted: writtenCount,
      findings: {
        observationsWritten: writtenCount,
        conflicts,
        failures,
        invalidActions,
        skippedActions: Math.max(0, plan.actions.length - executedActions.length),
      },
      costUsd,
    };
  };
}

// ---------------------------------------------------------------------------
// refresh_stale.
// ---------------------------------------------------------------------------

class EvidenceNotFoundError extends Error {
  constructor(evidenceId: string) {
    super(`evidence ${evidenceId} not found`);
    this.name = "EvidenceNotFoundError";
  }
}

async function refreshStaleEvidence(
  db: Database,
  input: {
    agentKey: string;
    evidenceId: string;
    fetchDocument: (url: string, signal?: AbortSignal) => Promise<SafeFetchResult>;
    signal: AbortSignal;
    onRescore: (candidateId: string) => void;
  },
): Promise<"refreshed" | "unchanged" | "dropped"> {
  const [evidenceRow] = await db
    .select()
    .from(evidence)
    .where(eq(evidence.id, input.evidenceId))
    .limit(1);
  if (evidenceRow === undefined) throw new EvidenceNotFoundError(input.evidenceId);

  const [doc] = await db
    .select()
    .from(sourceDocuments)
    .where(eq(sourceDocuments.id, evidenceRow.sourceDocumentId))
    .limit(1);
  if (doc === undefined || doc.canonicalUrl === null) return "dropped";

  const ageMs = Date.now() - new Date(doc.retrievedAt).getTime();
  if (ageMs < STALE_EVIDENCE_DAYS * 24 * 60 * 60 * 1000) return "unchanged";

  const fresh = await input.fetchDocument(doc.canonicalUrl, input.signal);

  // Content-addressed skip: identical bytes ⇒ nothing to freshen.
  if (doc.contentSha256 !== null && doc.contentSha256 === fresh.contentSha256) {
    return "unchanged";
  }
  // Fresh bytes already stored under ANOTHER document: nothing new to learn.
  const [hashOwner] = await db
    .select({ id: sourceDocuments.id })
    .from(sourceDocuments)
    .where(
      and(eq(sourceDocuments.contentSha256, fresh.contentSha256), sql`${sourceDocuments.id} <> ${doc.id}`),
    )
    .limit(1);
  if (hashOwner !== undefined) return "unchanged";

  // Only carry observations whose supporting quote survives in the fresh text.
  const freshText = stripHtmlToText(fresh.content, fresh.contentType);
  if (evidenceRow.quote !== null && !normalizedContains(freshText, evidenceRow.quote)) {
    return "dropped";
  }

  const childObservations = await db
    .select()
    .from(observations)
    .where(eq(observations.evidenceId, evidenceRow.id));

  await db
    .update(sourceDocuments)
    .set({
      retrievedAt: new Date(fresh.retrievedAt),
      contentSha256: fresh.contentSha256,
      byteLength: fresh.byteLength,
      mimeType: fresh.contentType,
      metadata: {
        ...(doc.metadata ?? {}),
        refreshedByAgentKey: input.agentKey,
        previousContentSha256: doc.contentSha256,
        refreshedAt: fresh.retrievedAt,
      },
    })
    .where(eq(sourceDocuments.id, doc.id));

  const [newEvidence] = await db
    .insert(evidence)
    .values({
      sourceDocumentId: doc.id,
      extractionStatus: "completed",
      quote: evidenceRow.quote,
      locator: evidenceRow.locator,
      pageNumber: evidenceRow.pageNumber,
      startOffset: evidenceRow.startOffset,
      endOffset: evidenceRow.endOffset,
      extractionMethod: "refresh-stale.v1",
      contentSha256: fresh.contentSha256,
      metadata: { refreshedFromEvidenceId: evidenceRow.id, agentKey: input.agentKey },
    })
    .returning({ id: evidence.id });
  if (newEvidence === undefined) throw new Error("unable to persist refreshed evidence");

  for (const observation of childObservations) {
    await db.insert(observations).values({
      subjectType: observation.subjectType,
      subjectId: observation.subjectId,
      fieldKey: observation.fieldKey,
      valueKind: observation.valueKind,
      value: observation.value,
      normalizedText: observation.normalizedText,
      unit: observation.unit,
      validFrom: observation.validFrom,
      observedAt: new Date(),
      confidence: observation.confidence,
      evidenceId: newEvidence.id,
      reviewStatus: "pending",
      conflictStatus: "none",
    });
    if (observation.subjectType === "company") {
      const [candidate] = await db
        .select({ id: candidates.id })
        .from(candidates)
        .where(eq(candidates.companyId, observation.subjectId))
        .limit(1);
      if (candidate !== undefined) input.onRescore(candidate.id);
    }
  }
  return "refreshed";
}

function createRefreshStaleHandler(deps: Partial<TickHandlerDeps>): TickHandler {
  return async (context): Promise<TickResult> => {
    const planned = await planAgentTick(deps, context, async (db) => {
      const result = await db.execute<{ evidence_id: string }>(sql`
        SELECT e.id AS evidence_id
        FROM evidence e
        JOIN source_documents sd ON sd.id = e.source_document_id
        JOIN source_document_links sdl ON sdl.source_document_id = sd.id
        JOIN candidates c ON c.company_id = sdl.company_id
        WHERE sd.canonical_url LIKE 'http%'
          AND sd.retrieved_at < now() - INTERVAL '30 days'
          AND c.status NOT IN ('rejected', 'archived')
        GROUP BY e.id, sd.retrieved_at
        ORDER BY sd.retrieved_at ASC
        LIMIT ${MAX_STATE_IDS}
      `);
      return { staleEvidenceIds: result.rows.map((row) => row.evidence_id) };
    });
    if ("shortCircuit" in planned) return planned.shortCircuit;
    const { plan } = planned;
    const planJson = { ...plan };

    const db = getDatabase();
    const executedActions = plan.actions.slice(0, 2) as RefreshStaleAction[];
    const rescoredCandidateIds = new Set<string>();
    const errors: Array<Record<string, unknown>> = [];
    let refreshedDocuments = 0;
    let unchangedSkipped = 0;
    let droppedQuotes = 0;
    let invalidActions = 0;

    for (const action of executedActions) {
      try {
        const outcome = await refreshStaleEvidence(db, {
          agentKey: context.agent.key,
          evidenceId: action.evidenceId,
          fetchDocument: deps.fetchDocument ?? defaultFetchDocument,
          signal: context.signal,
          onRescore: (candidateId) => rescoredCandidateIds.add(candidateId),
        });
        if (outcome === "unchanged") unchangedSkipped += 1;
        else if (outcome === "refreshed") refreshedDocuments += 1;
        else droppedQuotes += 1;
      } catch (error) {
        if (error instanceof EvidenceNotFoundError) {
          invalidActions += 1;
        } else {
          errors.push({
            evidenceId: action.evidenceId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    for (const candidateId of rescoredCandidateIds) {
      await rescoreCandidateAfterResearch(db, candidateId);
    }

    const outcome: TickOutcomeReported =
      errors.length > 0 && refreshedDocuments === 0 ? "stuck" : "executed";
    return {
      outcome,
      plan: planJson,
      actionsExecuted: refreshedDocuments,
      findings: {
        refreshedDocuments,
        unchangedSkipped,
        droppedQuotes,
        invalidActions,
        rescoredCandidates: [...rescoredCandidateIds],
        errors,
        skippedActions: Math.max(0, plan.actions.length - executedActions.length),
      },
    };
  };
}

// ---------------------------------------------------------------------------
// golden_neighbor.
// ---------------------------------------------------------------------------

/** Pull NAICS/PSC-ish codes out of arbitrary JSON blobs. */
function collectNaicsPscSeeds(records: unknown[]): {
  naics: string[];
  psc: string[];
} {
  const naics = new Set<string>();
  const psc = new Set<string>();
  const visit = (value: unknown, keyHint: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, keyHint);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        visit(entry, `${keyHint} ${key.toLowerCase()}`);
      }
      return;
    }
    for (const token of codeList(value)) {
      if (/^\d{4,6}$/u.test(token)) naics.add(token);
      else if (/^[a-z]{2}\d{2}$/iu.test(token) || /^[0-9]{4}$/u.test(token)) psc.add(token.toUpperCase());
    }
  };
  for (const record of records) visit(record, "");
  return { naics: [...naics], psc: [...psc] };
}

async function selectPositiveReviewedGoldenExamples(
  db: Database,
): Promise<Array<{ grataPayload: Record<string, unknown> }>> {
  const rows = await db
    .select({ grataPayload: goldenExamples.grataPayload })
    .from(goldenExamples)
    .where(
      and(
        eq(goldenExamples.reviewStatus, "reviewed"),
        inArray(goldenExamples.archetypeFit, ["strong_positive", "positive"]),
      ),
    )
    .limit(50);
  return rows.map((row) => ({ grataPayload: row.grataPayload ?? {} }));
}

function archetypeFiltersFromExamples(
  examples: Array<{ grataPayload: Record<string, unknown> }>,
): Record<string, string> {
  const seeds = collectNaicsPscSeeds(examples.map((example) => example.grataPayload));
  const filters: Record<string, string> = {};
  if (seeds.naics.length > 0) filters["naics"] = seeds.naics.join(",");
  if (seeds.psc.length > 0) filters["psc"] = seeds.psc.join(",");
  return filters;
}

function createGoldenNeighborHandler(deps: Partial<TickHandlerDeps>): TickHandler {
  return async (context): Promise<TickResult> => {
    const planned = await planAgentTick(deps, context, async (db) => {
      const examples = await selectPositiveReviewedGoldenExamples(db);
      return { archetypeFilters: archetypeFiltersFromExamples(examples) };
    });
    if ("shortCircuit" in planned) return planned.shortCircuit;
    const { plan } = planned;
    const planJson = { ...plan };

    const db = getDatabase();
    const examples = await selectPositiveReviewedGoldenExamples(db);
    if (examples.length === 0) {
      return {
        outcome: "done",
        plan: planJson,
        findings: { idleReason: "no_reviewed_positive_golden_examples" },
      };
    }
    const neighborActions = plan.actions.slice(0, 1) as GoldenNeighborAction[];

    const exampleSeeds = collectNaicsPscSeeds(examples.map((example) => example.grataPayload));
    const actionSeeds = collectNaicsPscSeeds(
      neighborActions.map((action) => action.archetypeFilters),
    );
    const naics = [...new Set([...actionSeeds.naics, ...exampleSeeds.naics])].slice(0, 8);
    const psc = [...new Set([...actionSeeds.psc, ...exampleSeeds.psc])].slice(0, 10);

    const expansion = await runUsaspendingExpansion(context.agent, deps, {
      naics: naics.length > 0 ? naics : [...AEROSPACE_NAICS].slice(0, 8),
      psc: psc.length > 0 ? psc : [...AIRCRAFT_COMPONENT_PSC].slice(0, 10),
    });
    if (!expansion.queryRan) {
      return { outcome: "stuck", plan: planJson, findings: { idleReason: "no_query_expansion" } };
    }
    const frontierInserted = await recordAgentFrontierProposals(
      db,
      context.agent,
      expansion.queryValue,
      expansion.proposals.map((proposal) => ({
        ...proposal,
        payload: { ...(proposal.payload ?? {}), goldenNeighborOrigin: true },
      })),
    );
    const summary = await ingestDiscoveredLeads(
      db,
      context.agent,
      expansion.proposals,
      "golden-neighbor",
    );
    return {
      outcome: "executed",
      plan: planJson,
      actionsExecuted: 1,
      findings: {
        examplesConsidered: examples.length,
        archetypeNaics: naics,
        archetypePsc: psc,
        query: expansion.queryValue,
        frontierItemsCreated: frontierInserted,
        newLeads: summary.created,
        resolvedExact: summary.resolvedExact,
        probableReview: summary.probableReview,
        unresolved: summary.unresolved,
        duplicateSkipped: summary.duplicateSkipped,
        discoveryOrigin: "golden-neighbor",
      },
    };
  };
}

// ---------------------------------------------------------------------------
// resolve_domain.
// ---------------------------------------------------------------------------

/** Budget gates: ≤5 leads per tick, ≤3 candidate domains per lead, ≤2 model
 * calls per candidate (one + one fence-repair retry inside the judge). */
const MAX_DOMAIN_LEADS_PER_TICK = 5;
const MAX_DOMAIN_CANDIDATES_PER_LEAD = 3;

/**
 * WAF-protected sites (yulista.com returns 406 to non-browser user agents)
 * require browser-like request headers. Only the domain prober opts in; the
 * safe-fetch default is untouched for every other caller.
 */
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const BROWSER_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

/** Identity text is capped so model prompts and overlap math stay bounded. */
const MAX_IDENTITY_TEXT_CHARS = 2_000;
/** Hard cap on fetched HTML considered per page (safe-fetch allows 5 MiB). */
const MAX_HTML_BYTES = 256 * 1024;

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script/giu, " ")
    .replace(/<style[\s\S]*?<\/style/giu, " ")
    .replace(/<[^>]+>/gu, " ");
}

function collapse(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function matchAll(html: string, pattern: RegExp): string[] {
  const out: string[] = [];
  for (const match of html.matchAll(pattern)) {
    const text = collapse(decodeEntities(match[1] ?? ""));
    if (text.length > 0) out.push(text);
  }
  return out;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#0?39;/gu, "'")
    .replace(/&nbsp;/giu, " ");
}

/**
 * Homepage → identity text: title + meta description + h1/h2 first (~2000
 * chars); falls back to stripped body text for JS-shell pages whose markup
 * carries nothing else.
 */
export function homepageIdentityText(html: string): string {
  const parts = [
    ...matchAll(html, /<title[^>]*>([\s\S]*?)<\/title/giu),
    ...matchAll(
      html,
      /<meta[^>]+name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)["']/giu,
    ),
    ...matchAll(
      html,
      /<meta[^>]+content\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']description["']/giu,
    ),
    ...matchAll(html, /<h1[^>]*>([\s\S]*?)<\/h1/giu),
    ...matchAll(html, /<h2[^>]*>([\s\S]*?)<\/h2/giu),
  ];
  const focused = collapse(parts.join(" ")).slice(0, MAX_IDENTITY_TEXT_CHARS);
  if (focused.length >= 40) return focused;
  return collapse(stripTags(html)).slice(0, MAX_IDENTITY_TEXT_CHARS);
}

class SafeFetchDomainProber implements DomainProber {
  async fetchText(url: string) {
    try {
      // 10s ceiling here; safe-fetch itself aborts at 15s but the faster
      // deadline wins.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      let result;
      try {
        result = await safeFetchUrl(url, {
          signal: controller.signal,
          userAgent: BROWSER_USER_AGENT,
          accept: BROWSER_ACCEPT,
        });
      } finally {
        clearTimeout(timer);
      }
      return {
        ok: true as const,
        finalUrl: result.finalUrl,
        text: homepageIdentityText(result.content.slice(0, MAX_HTML_BYTES)),
      };
    } catch (error) {
      if (error instanceof SafeFetchError) return { ok: false as const, error: error.code };
      if (error instanceof Error && error.name === "AbortError") {
        return { ok: false as const, error: "timeout" };
      }
      return { ok: false as const, error: "network_error" };
    }
  }
}

// ---------------------------------------------------------------------------
// Judge/proposer: OpenRouter prompt-contract + one fence-repair retry (the
// gateway's structured-output enforcement is provider-dependent). Mirrors the
// resolve-domain route construction; cost accumulates for the tick report.
// ---------------------------------------------------------------------------

const proposedDomainsSchema = z.strictObject({
  domains: z.array(z.string().min(3)).max(5),
});

const identityJudgmentSchema = z.strictObject({
  matches: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(500),
});

const PROPOSE_SYSTEM_PROMPT =
  "You propose candidate website domains for an industrial company named by " +
  "the user. If the name starts with a brand word that likely belongs to a " +
  "larger parent organization (e.g. \"ACME Aviation, Inc.\" under ACME " +
  "Corp), ALWAYS list that parent brand's root domain FIRST — parent " +
  "companies often host their subsidiaries' web presence under one domain. " +
  "Otherwise, cover DIFFERENT compact styles: the full word-mark (all words " +
  "joined), an initialism/acronym (initials joined, optionally prefixed by " +
  "the company's first word, e.g. \"York Precision Machining Hydraulics\" → " +
  "ypmh.com or yorkpmh.com), and one other plausible variant. Reply with " +
  "exactly ONE raw JSON object (no prose, no markdown fences) of shape " +
  '{"domains":["example.com", ...]} containing at most 3 plausible domains, ' +
  "most likely first. Never invent subdomains or paths.";

const JUDGE_SYSTEM_PROMPT =
  "You decide whether a fetched webpage belongs to the company named by the " +
  "user. Reply with exactly ONE raw JSON object (no prose, no markdown " +
  'fences) of shape {"matches":boolean,"confidence":number,"reason":string} ' +
  "where confidence is between 0 and 1. Be conservative: only matches=true " +
  "when the page clearly represents that specific company.";

class CostTrackingOpenRouterDomainJudge implements DomainJudge {
  private spentUsd = 0;

  constructor(private readonly model: ResolvedModelDeps) {}

  totalCostUsd(): number {
    return this.spentUsd;
  }

  private async callModel<T>(
    schema: z.ZodType<T>,
    schemaName: string,
    systemPrompt: string,
    prompt: string,
  ): Promise<{ data: T; costUsd: number }> {
    const result = await this.model.client.generateStructured({
      route: "fast",
      models: this.model.models,
      schemaName,
      schema,
      systemPrompt,
      prompt,
      temperature: 0,
      maxOutputTokens: 512,
      maxAttempts: 1,
    });
    return { data: result.data, costUsd: result.telemetry.costUsd ?? 0 };
  }

  /** Exactly one repair retry — ≤2 model calls per logical call. */
  private async callWithRepair<T>(
    schema: z.ZodType<T>,
    schemaName: string,
    systemPrompt: string,
    prompt: string,
  ): Promise<T | null> {
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const fullPrompt =
        attempt === 0
          ? prompt
          : `${prompt}\n\nREPAIR: your previous reply failed validation (${lastError}). Reply again with exactly one raw JSON object matching the required shape.`;
      try {
        const result = await this.callModel(schema, schemaName, systemPrompt, fullPrompt);
        this.spentUsd += result.costUsd;
        return result.data;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    return null;
  }

  async proposeDomains(leadName: string, locationHint?: string | null): Promise<string[]> {
    const prompt =
      `Company name: ${leadName}` +
      (locationHint === null || locationHint === undefined || locationHint.length === 0
        ? ""
        : `\nLocation hint: ${locationHint}`) +
      "\nPropose its most likely official website domains.";
    const parsed = await this.callWithRepair(
      proposedDomainsSchema,
      "lead_domain_proposal_v1",
      PROPOSE_SYSTEM_PROMPT,
      prompt,
    );
    return parsed?.domains ?? [];
  }

  async judgeIdentity(leadName: string, pageText: string): Promise<IdentityJudgment> {
    const prompt =
      `Company name: ${leadName}\n\nWebpage text:\n"""\n${pageText}\n"""` +
      "\nDoes this page represent that specific company?";
    const parsed = await this.callWithRepair(
      identityJudgmentSchema,
      "lead_identity_judgment_v1",
      JUDGE_SYSTEM_PROMPT,
      prompt,
    );
    // Conservative anti-fabrication default: no usable judgment ⇒ no match.
    return parsed ?? { matches: false, confidence: 0, reason: "identity judge unavailable" };
  }
}

export interface DomainResolutionRuntime {
  readonly deps: LeadDomainDeps;
  /** The judge in use (cost-tracking unless a test override replaced it). */
  readonly judge: DomainJudge;
}

/** Production domain-resolution deps; null ⇒ the agent idles honestly. */
export function buildDomainResolutionDeps(
  deps: Partial<TickHandlerDeps> = {},
): DomainResolutionRuntime | null {
  const model = resolveModelDeps(deps);
  if (model === null) return null;
  const resolutionLogger: ResolutionLogger = {
    debug: (message, meta) => console.debug(`[resolve_domain] ${message}`, meta ?? ""),
    info: (message, meta) => console.info(`[resolve_domain] ${message}`, meta ?? ""),
    warn: (message, meta) => console.warn(`[resolve_domain] ${message}`, meta ?? ""),
  };
  const judge = deps.domainJudge ?? new CostTrackingOpenRouterDomainJudge(model);
  return {
    deps: {
      prober: deps.domainProber ?? new SafeFetchDomainProber(),
      judge,
      logger: resolutionLogger,
    },
    judge,
  };
}

/** Model-call spend for the runtime's judge (0 for non-costing test judges). */
export function judgeCostUsd(judge: DomainJudge): number {
  return judge instanceof CostTrackingOpenRouterDomainJudge ? judge.totalCostUsd() : 0;
}

/** Oldest-first unresolved leads still missing a possible domain. */
export async function selectDomainResolutionBatch(
  db: Database,
  limit: number = MAX_DOMAIN_LEADS_PER_TICK,
): Promise<Array<{ id: string; rawName: string; possibleLocation: string | null }>> {
  return db
    .select({
      id: leads.id,
      rawName: leads.rawName,
      possibleLocation: leads.possibleLocation,
    })
    .from(leads)
    .where(and(eq(leads.status, "unresolved_lead"), isNull(leads.possibleDomain)))
    .orderBy(asc(leads.createdAt))
    .limit(limit);
}

function createResolveDomainHandler(deps: Partial<TickHandlerDeps>): TickHandler {
  return async (): Promise<TickResult> => {
    const runtime = buildDomainResolutionDeps(deps);
    if (runtime === null) {
      return { outcome: "stuck", findings: { idleReason: "openrouter_not_configured" } };
    }

    const db = getDatabase();
    const batch = await selectDomainResolutionBatch(db);
    if (batch.length === 0) {
      return {
        outcome: "done",
        findings: { note: "no unresolved_lead leads without a possible_domain" },
      };
    }

    const verified: Array<{ leadId: string; domain: string; companyId: string }> = [];
    const errors: Array<{ leadId: string; error: string }> = [];
    let noDomain = 0;
    let mismatched = 0;
    for (const lead of batch) {
      // Per-lead isolation: one poisoned lead never fails the batch.
      try {
        const resolveOne = deps.resolveLead ?? resolveLeadDomain;
        const result: ResolutionResult = await resolveOne(db, lead.id, runtime.deps, {
          maxCandidates: MAX_DOMAIN_CANDIDATES_PER_LEAD,
        });
        if (
          result.outcome === "domain_verified" &&
          result.domain !== undefined &&
          result.companyId !== undefined
        ) {
          verified.push({ leadId: result.leadId, domain: result.domain, companyId: result.companyId });
        } else if (result.outcome === "no_domain_found") {
          noDomain += 1;
        } else if (result.outcome === "identity_mismatch") {
          mismatched += 1;
        }
        // already_resolved: raced with another resolver; counts as neither.
      } catch (error) {
        errors.push({
          leadId: lead.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const processed = verified.length + noDomain + mismatched;
    const outcome: TickOutcomeReported =
      processed > 0 || errors.length < batch.length ? "executed" : "stuck";
    return {
      outcome,
      actionsExecuted: processed,
      findings: { verified, noDomain, mismatched, errors },
      costUsd: judgeCostUsd(runtime.judge),
    };
  };
}
