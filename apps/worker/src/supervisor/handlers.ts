import { createHash } from "node:crypto";

import { and, asc, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import {
  agentTicks,
  agentFrontierProgress,
  claimNextAgentQuery,
  completeAgentQuery,
  continueAgentQuery,
  ensureAgentMonthlyQueries,
  failAgentQuery,
  candidates,
  claimQueuedSourceSignals,
  companies,
  companySourceLinks,
  companyIdentifiers,
  dataSources,
  evidence,
  getDatabase,
  goldenExamples,
  leadNameTokens,
  ingestLeadCandidates,
  mapResearchRunInput,
  observations,
  ownershipObservations,
  recordSourceSignalQualification,
  researchRuns,
  sourceSignals,
  sourceDocuments,
  upsertHarvestedSourceSignal,
  leads,
  resolveLeadDomain,
  synthesizeQualifiedSourceSignal,
  MIN_JUDGE_CONFIDENCE,
  type AgentType,
  type Database,
  type DomainJudge,
  type DomainProber,
  type IdentityJudgment,
  type LeadIdentityHints,
  type LeadDomainDeps,
  type ResearchAgent,
  type ResolutionLogger,
  type ResolutionResult,
  type SourceSignal,
} from "@asi/database";
import {
  AEROSPACE_NAICS,
  CANDIDATE_RESEARCH_PROMPT_VERSION,
  collectCandidatePageLinks,
  ExaCompanyListHarvester,
  FaaDrsBrowserClient,
  FAA_DRS_PUBLIC_PMA_URL,
  ExaSearchClient,
  OpenRouterClient,
  planTick,
  rescoreCandidateAfterResearch,
  safeFetchUrl,
  SafeFetchError,
  isSuppressedDirectoryDomain,
  searchOfficialDomainCandidates,
  UsaspendingDiscoveryStrategy,
  SamEntityClient,
  SamEntityHarvester,
  SamQuotaExceededError,
  type SamEntitySearchClient,
  UsaspendingClient,
  wrapUntrustedSourceJson,
  type AgentPlan,
  type CampaignView,
  type FrontierItemView,
  type FrontierProposal,
  type OfficialDomainCandidate,
  type ExaSearchResult,
  type OpenRouterAttemptTelemetry,
  type OpenRouterModelRouting,
  type RecentTickSummary,
  type SafeFetchResult,
  type EnrichCandidateAction,
  type SourceSignalProposal,
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

/** Source-agnostic company observation mined into the quarantine boundary. */
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

export type SourceSignalTargetDecision =
  | "yes_target"
  | "no_target"
  | "needs_more_research";

export interface PageGroundedClaim {
  readonly excerpt: string;
  readonly url: string;
}

export interface SourceSignalClassification {
  readonly manufacturer: boolean;
  readonly aerospaceDefenseRelevance: boolean;
  readonly businessModel: "manufacturer" | "distributor" | "service" | "btp" | "unknown";
  readonly headquartersCountry: string;
  readonly ownershipType:
    | "independent"
    | "founder_family"
    | "pe_owned"
    | "strategic_parent"
    | "public"
    | "unknown";
  readonly sizeFit: "likely_under_50m" | "likely_over_50m" | "unknown";
  readonly proprietarySignals: readonly string[];
  readonly manufacturerEvidence: PageGroundedClaim | null;
  readonly aerospaceDefenseEvidence: PageGroundedClaim | null;
  readonly targetDecision: SourceSignalTargetDecision;
  readonly reasons: readonly string[];
  readonly confidence: number;
}

export interface SourceSignalClassifierInput {
  readonly legalName: string;
  readonly pageText: string;
  readonly pageUrl: string;
}

export type SourceSignalClassifier = (
  input: SourceSignalClassifierInput,
) => Promise<SourceSignalClassification>;

export type OfficialDomainSearcher = (
  identity: {
    readonly legalName: string;
    readonly city?: string;
    readonly state?: string;
    readonly uei?: string;
    readonly cage?: string;
  },
) => Promise<readonly OfficialDomainCandidate[]>;

export interface IdentityPage {
  readonly finalUrl: string;
  readonly text: string;
  readonly identityLinks: readonly string[];
}

export type IdentityPageProbeResult =
  | ({ readonly ok: true } & IdentityPage)
  | { readonly ok: false; readonly error: string };

export interface IdentityPageProber {
  fetchIdentityPage(url: string): Promise<IdentityPageProbeResult>;
}

export interface TickHandlerDeps {
  /** OpenRouter gateway; defaults to one built from OPENROUTER_API_KEY. */
  readonly client?: OpenRouterClient;
  readonly models?: OpenRouterModelRouting;
  /** USAspending search override (tests); default is the real client. */
  /** Exa official-domain proposal override (tests). */
  readonly searchOfficialDomains?: OfficialDomainSearcher;
  /** Generic official-site source-signal classifier override (tests). */
  readonly classifySourceSignal?: SourceSignalClassifier;
  readonly searchRecipients?: UsaspendingSearchClient["searchRecipients"];
  readonly searchRecipientsPage?: UsaspendingSearchClient["searchRecipientsPage"];
  /** SAM v4 search override (tests); default is the credentialed public client. */
  readonly searchSamEntities?: SamEntitySearchClient["search"];
  /** FAA DRS guest-browser search override (tests). */
  readonly searchFaaPma?: FaaDrsBrowserClient["search"];
  /** Generic Exa query override for company-list and source-catalog discovery (tests). */
  readonly searchExa?: (query: string) => Promise<readonly ExaSearchResult[]>;
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
  /** Multi-page official-site identity probe override (tests). */
  readonly identityPageProber?: IdentityPageProber;
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
  /** Qualified-source synthesis override (tests); default is deterministic persistence. */
  readonly synthesizeSourceSignal?: typeof synthesizeQualifiedSourceSignal;
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
  qualify_award_lead: createQualifyAwardLeadHandler,
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
/** Safety circuit-breaker: discovery may queue at most 25 source signals/tick. */
const MAX_SOURCE_SIGNALS_PER_HARVEST_TICK = 25;
/** Consecutive query failures back off from 15 minutes to at most 24 hours. */
const AGENT_QUERY_BACKOFF_BASE_MS = 15 * 60_000;
const AGENT_QUERY_BACKOFF_MAX_MS = 24 * 60 * 60_000;

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

/** "336411, 336413" / ["1560"] → ["336411","336413"] — tolerant code splitting. */
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
// discover_source.
// ---------------------------------------------------------------------------

function canonicalDiscoverSource(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/-/gu, "_");
  return normalized === "source_catalog_scout" || normalized === "catalog_scout"
    ? "source_catalog"
    : normalized;
}

function discoverSourceKey(agent: ResearchAgent): string {
  const configuredMode = agent.config?.["mode"];
  if (typeof configuredMode === "string" && configuredMode.trim() !== "") {
    return canonicalDiscoverSource(configuredMode);
  }
  const seeded = (agent.seedScope?.["sources"] as unknown) ?? undefined;
  if (Array.isArray(seeded)) {
    const first = seeded.find(
      (item): item is string => typeof item === "string" && item.trim() !== "",
    );
    if (first !== undefined) return canonicalDiscoverSource(first);
  }
  if (agent.key.toLowerCase().includes("source-catalog")) return "source_catalog";
  if (agent.key.toLowerCase() === "faa-pma-targeted") return "faa_pma_targeted";
  if (agent.key.toLowerCase().includes("sam")) return "sam";
  return "usaspending";
}

const SAM_API_KEY_ENV = "SAM_API_KEY";
const FAA_DRS_BROWSER_ENABLED_ENV = "FAA_DRS_BROWSER_ENABLED";
const FAA_DRS_CHROMIUM_PATH_ENV = "FAA_DRS_CHROMIUM_PATH";
const FAA_DRS_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const STRICT_SAM_NAICS = ["336411", "336412", "336413", "336419", "334511"] as const;

interface DiscoveryExpansion {
  readonly queryValue: string;
  readonly month: string | null;
  readonly page: number;
  readonly cursor: { readonly sortValue: string; readonly uniqueId: number } | null;
  readonly fetched: number;
  readonly harvested: number;
  readonly duplicates: number;
  readonly rejected: {
    readonly invalidSignal: number;
    readonly strictSourceGate: {
      readonly missingStrictNaics: number;
      readonly missingAerospaceDefenseEvidence: number;
      readonly excludedServiceWithoutManufacturing: number;
    };
    readonly outputCap: number;
  };
  readonly continuation: boolean;
  readonly pendingMonths: number;
  readonly completedMonths: number;
}

/**
 * Advance exactly one durable USAspending monthly query. Initial source
 * expansion is persisted before any query runs; pagination subsequently
 * requeues that same row with an advanced resumePage/cursor payload.
 */
async function runUsaspendingExpansion(
  db: Database,
  agent: ResearchAgent,
  deps: Partial<TickHandlerDeps>,
  seeds: { naics: readonly string[]; psc?: readonly string[] },
): Promise<DiscoveryExpansion | null> {
  const client =
    deps.searchRecipients === undefined
      ? new UsaspendingClient({ maxPages: 1, pageSize: 25 })
      : {
          searchRecipients: deps.searchRecipients,
          ...(deps.searchRecipientsPage === undefined
            ? {}
            : { searchRecipientsPage: deps.searchRecipientsPage }),
        };
  const strategy = new UsaspendingDiscoveryStrategy({ client });
  // The strategy never reads campaign fields; agent-owned rows have no campaign.
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

  const before = await agentFrontierProgress(agent.id);
  if (before.total === 0) {
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
    const expanded = await strategy.proposeFrontierItems(campaignStub, sourceView);
    const monthlyQueries = expanded
      .filter(
        (proposal): proposal is FrontierProposal & { readonly itemType: "query" } =>
          proposal.itemType === "query",
      )
      // The strategy's inclusive trailing-365-day range has two partial edge
      // months. Agent traversal is the latest twelve calendar buckets.
      .slice(-12)
      .map((proposal) => ({
        ...proposal,
        payload: {
          ...(proposal.payload ?? {}),
          naics: [...seeds.naics],
          ...(seeds.psc === undefined ? {} : { psc: [...seeds.psc] }),
        },
      }));
    await ensureAgentMonthlyQueries(agent.id, monthlyQueries);
  }

  const claimed = await claimNextAgentQuery(agent.id);
  if (claimed === null) return null;
  const queryView: FrontierItemView = {
    id: claimed.id,
    campaignId: "",
    itemType: "query",
    normalizedValue: claimed.normalizedValue,
    parentItemId: claimed.parentItemId,
    discoveryPath: claimed.discoveryPath,
    depth: claimed.depth,
    payload: claimed.payload,
  };
  const page =
    typeof claimed.payload["resumePage"] === "number" &&
    Number.isInteger(claimed.payload["resumePage"])
      ? claimed.payload["resumePage"]
      : 1;
  const cursorSortValue = claimed.payload["cursorSortValue"];
  const cursorUniqueId = claimed.payload["cursorUniqueId"];
  const cursor =
    typeof cursorSortValue === "string" &&
    typeof cursorUniqueId === "number" &&
    Number.isInteger(cursorUniqueId)
      ? { sortValue: cursorSortValue, uniqueId: cursorUniqueId }
      : null;

  try {
    const allProposals = await strategy.proposeFrontierItems(campaignStub, queryView);
    const companyProposals = allProposals.filter(
      (proposal) => proposal.itemType === "company",
    );
    const continuation = allProposals.find(
      (proposal) =>
        proposal.itemType === "query" &&
        proposal.normalizedValue === claimed.normalizedValue,
    );
    // Production fetches at most 25 rows. An oversized injected client is
    // bounded explicitly and every excess proposal is reported as rejected.
    const harvestable = companyProposals.slice(0, MAX_SOURCE_SIGNALS_PER_HARVEST_TICK);
    const harvest = await harvestUsaspendingSourceSignals(db, agent, harvestable);

    const transitioned =
      continuation === undefined
        ? await completeAgentQuery(claimed.id)
        : await continueAgentQuery(claimed.id, continuation.payload ?? {});
    if (transitioned === null) {
      throw new Error(`USAspending query ${claimed.id} lost its in-progress claim`);
    }

    const progress = await agentFrontierProgress(agent.id);
    const strictRejected = strategy.qualificationFindings.rejected;
    const strictRejectedCount =
      strictRejected.missingStrictNaics +
      strictRejected.missingAerospaceDefenseEvidence +
      strictRejected.excludedServiceWithoutManufacturing;
    const timePeriod = claimed.payload["timePeriod"];
    const startDate =
      typeof timePeriod === "object" && timePeriod !== null && !Array.isArray(timePeriod)
        ? (timePeriod as Record<string, unknown>)["startDate"]
        : null;
    return {
      queryValue: claimed.normalizedValue,
      month:
        typeof startDate === "string"
          ? startDate.slice(0, 7)
          : (/:(\d{4}-\d{2})$/u.exec(claimed.normalizedValue)?.[1] ?? null),
      page,
      cursor,
      fetched:
        Math.max(strategy.qualificationFindings.qualified, companyProposals.length) +
        strictRejectedCount,
      harvested: harvest.harvested,
      duplicates: harvest.duplicate,
      rejected: {
        invalidSignal: harvest.rejected,
        strictSourceGate: strictRejected,
        outputCap: companyProposals.length - harvestable.length,
      },
      continuation: continuation !== undefined,
      pendingMonths: progress.pendingMonths,
      completedMonths: progress.completedMonths,
    };
  } catch (error) {
    const backoffMs = Math.min(
      AGENT_QUERY_BACKOFF_BASE_MS * 2 ** Math.max(0, claimed.attemptCount - 1),
      AGENT_QUERY_BACKOFF_MAX_MS,
    );
    await failAgentQuery(
      claimed.id,
      error instanceof Error ? error.message : String(error),
      backoffMs,
    );
    throw error;
  }
}


async function harvestUsaspendingSourceSignals(
  db: Database,
  agent: ResearchAgent,
  proposals: readonly FrontierProposal[],
): Promise<{ readonly harvested: number; readonly duplicate: number; readonly rejected: number }> {
  let harvested = 0;
  let duplicate = 0;
  let rejected = 0;
  for (const proposal of proposals) {
    const payload = proposal.payload ?? {};
    const rawName = typeof payload.rawName === "string" ? payload.rawName.trim() : "";
    const sourceLocator =
      typeof payload.sourceLocator === "string" ? payload.sourceLocator.trim() : "";
    if (proposal.itemType !== "company" || rawName === "" || sourceLocator === "") {
      rejected += 1;
      continue;
    }
    const awardCount = typeof payload.awardCount === "number" ? payload.awardCount : 0;
    const awardValue =
      typeof payload.totalAwardValueUsd === "number" ? payload.totalAwardValueUsd : 0;
    const result = await upsertHarvestedSourceSignal(db, {
      sourceKey: "usaspending",
      sourceLocator,
      agentId: agent.id,
      rawName,
      ...(typeof payload.domain === "string" ? { rawDomain: payload.domain } : {}),
      ...(typeof payload.uei === "string" ? { uei: payload.uei } : {}),
      ...(typeof payload.cageCode === "string" ? { cage: payload.cageCode } : {}),
      ...(typeof payload.city === "string" ? { city: payload.city } : {}),
      ...(typeof payload.state === "string" ? { state: payload.state } : {}),
      awardCount,
      awardValue,
      ...(typeof payload.freshestAwardDate === "string"
        ? { freshestAward: payload.freshestAwardDate }
        : {}),
      sourcePayload: payload,
    });
    if (result.duplicate) duplicate += 1;
    else harvested += 1;
  }
  return { harvested, duplicate, rejected };
}

async function persistSourceSignalProposals(
  db: Database,
  agentId: string,
  proposals: readonly SourceSignalProposal[],
): Promise<{ readonly harvested: number; readonly duplicates: number }> {
  let harvested = 0;
  let duplicates = 0;
  for (const proposal of proposals) {
    const rows = await db
      .insert(sourceSignals)
      .values({
        sourceKey: proposal.sourceKey,
        sourceLocator: proposal.sourceLocator,
        sourceFingerprint: proposal.sourceFingerprint,
        agentId,
        rawName: proposal.rawName,
        ...(proposal.rawDomain === undefined ? {} : { rawDomain: proposal.rawDomain }),
        ...(proposal.uei === undefined ? {} : { uei: proposal.uei }),
        ...(proposal.cage === undefined ? {} : { cage: proposal.cage }),
        ...(proposal.city === undefined ? {} : { city: proposal.city }),
        ...(proposal.state === undefined ? {} : { state: proposal.state }),
        ...(proposal.country === undefined ? {} : { country: proposal.country }),
        ...(proposal.awardCount === undefined ? {} : { awardCount: proposal.awardCount }),
        ...(proposal.awardValue === undefined
          ? {}
          : { awardValue: String(proposal.awardValue) }),
        ...(proposal.freshestAward === undefined
          ? {}
          : { freshestAward: new Date(proposal.freshestAward) }),
        sourcePayload: proposal.sourcePayload,
        status: "queued_qualification",
      })
      .onConflictDoNothing({ target: sourceSignals.sourceFingerprint })
      .returning({ id: sourceSignals.id });
    if (rows.length === 0) duplicates += 1;
    else harvested += 1;
  }
  return { harvested, duplicates };
}

async function harvestSamSourceSignals(
  db: Database,
  agent: ResearchAgent,
  deps: Partial<TickHandlerDeps>,
  signal: AbortSignal,
): Promise<{
  readonly fetched: number;
  readonly harvested: number;
  readonly duplicates: number;
  readonly rejected: number;
}> {
  const apiKey = process.env[SAM_API_KEY_ENV]?.trim();
  if (apiKey === undefined || apiKey === "") {
    throw new Error("SAM_API_KEY is required for SAM entity harvesting");
  }
  const client =
    deps.searchSamEntities === undefined
      ? new SamEntityClient({ apiKey })
      : { search: deps.searchSamEntities };
  const harvested = await new SamEntityHarvester(client).harvest(
    {
      naicsCodes: [...STRICT_SAM_NAICS],
      maxResults: MAX_SOURCE_SIGNALS_PER_HARVEST_TICK,
    },
    { limit: MAX_SOURCE_SIGNALS_PER_HARVEST_TICK, signal },
  );
  const persisted = await persistSourceSignalProposals(db, agent.id, harvested.signals);
  return {
    fetched: harvested.metrics.fetched,
    harvested: persisted.harvested,
    duplicates: persisted.duplicates + harvested.metrics.duplicateCandidates,
    rejected: harvested.metrics.rejected,
  };
}

interface FaaScrapeResult {
  readonly query: unknown;
  readonly records: readonly {
    readonly guidUrl: string;
    readonly holderName: string | null;
  }[];
  readonly source: unknown;
}

interface FaaCacheEntry {
  readonly cachedAt: number;
  readonly result: FaaScrapeResult;
}

interface FaaTargetCandidate {
  readonly candidateId: string;
  readonly companyId: string;
  readonly legalName: string;
  readonly displayName: string;
}

async function selectFaaTargetCandidate(db: Database): Promise<FaaTargetCandidate | null> {
  const rows = await db
    .select({
      candidateId: candidates.id,
      companyId: companies.id,
      legalName: companies.legalName,
      displayName: companies.displayName,
    })
    .from(candidates)
    .innerJoin(companies, eq(companies.id, candidates.companyId))
    .where(
      and(
        eq(companies.status, "active"),
        sql`${candidates.status}::text NOT IN ('rejected', 'archived')`,
        sql`NOT EXISTS (
          SELECT 1 FROM ${companyIdentifiers}
          WHERE ${companyIdentifiers.companyId} = ${companies.id}
            AND ${companyIdentifiers.type} = 'faa_pma_holder'
        )`,
        sql`NOT EXISTS (
          SELECT 1 FROM ${sourceSignals}
          WHERE ${sourceSignals.sourceKey} IN ('faa_drs_pma_search', 'faa_drs_pma')
            AND ${sourceSignals.createdAt} >= now() - interval '30 days'
            AND (
              ${sourceSignals.companyId} = ${companies.id}
              OR ${sourceSignals.sourcePayload}->'knownCompanyHint'->>'companyId' = ${companies.id}::text
            )
        )`,
      ),
    )
    .orderBy(
      sql`CASE COALESCE(
        ${candidates.tierOverride}::text,
        CASE ${candidates.status}::text
          WHEN 'partner_review' THEN 'high_interest'
          WHEN 'shortlist' THEN 'high_interest'
          WHEN 'research_ready' THEN 'evaluate'
          WHEN 'queued_research' THEN 'needs_research'
          WHEN 'in_research' THEN 'researching'
          WHEN 'watchlist' THEN 'watchlist'
          WHEN 'hold' THEN 'watchlist'
          ELSE 'low_interest'
        END
      )
        WHEN 'high_interest' THEN 0
        WHEN 'evaluate' THEN 1
        WHEN 'needs_research' THEN 2
        ELSE 3
      END`,
      desc(candidates.updatedAt),
    )
    .limit(1);
  return rows[0] ?? null;
}

function faaRecordFingerprint(recordUrl: string): string {
  return createHash("sha256")
    .update(`faa_drs_pma\u0000${recordUrl}`, "utf8")
    .digest("hex");
}

async function upsertFaaSearchCheckpoint(
  db: Database,
  agentId: string,
  candidate: FaaTargetCandidate,
  result: FaaScrapeResult,
  cacheHit: boolean,
  checkedAt: Date,
): Promise<"qualified" | "rejected"> {
  const hasRecords = result.records.length > 0;
  const status = hasRecords ? "qualified" : "rejected";
  const checkedAtIso = checkedAt.toISOString();
  const knownCompanyHint = {
    candidateId: candidate.candidateId,
    companyId: candidate.companyId,
    legalName: candidate.legalName,
    displayName: candidate.displayName,
  };
  const sourcePayload = {
    query: result.query,
    checkedAt: checkedAtIso,
    recordCount: result.records.length,
    cache: {
      hit: cacheHit,
      ttlMs: FAA_DRS_CACHE_TTL_MS,
    },
    source: result.source,
    knownCompanyHint,
  };
  const qualification = {
    decision: hasRecords ? "qualified" : "no_target",
    reason: hasRecords ? "search_complete" : "no_current_pma_records",
    checkedAt: checkedAtIso,
  };
  const sourceFingerprint = createHash("sha256")
    .update(
      `faa_drs_pma_search\u0000${candidate.companyId}\u0000${checkedAtIso.slice(0, 10)}`,
      "utf8",
    )
    .digest("hex");
  await db
    .insert(sourceSignals)
    .values({
      sourceKey: "faa_drs_pma_search",
      sourceLocator:
        `${FAA_DRS_PUBLIC_PMA_URL}?holderName=${encodeURIComponent(candidate.legalName)}`,
      sourceFingerprint,
      agentId,
      rawName: candidate.legalName,
      companyId: candidate.companyId,
      sourcePayload,
      status,
      qualification,
      ...(hasRecords
        ? { qualifiedAt: checkedAt }
        : { rejectedAt: checkedAt }),
    })
    .onConflictDoUpdate({
      target: sourceSignals.sourceFingerprint,
      set: {
        companyId: candidate.companyId,
        sourcePayload,
        status,
        qualification,
        qualifiedAt: hasRecords ? checkedAt : null,
        rejectedAt: hasRecords ? null : checkedAt,
        updatedAt: checkedAt,
      },
    });
  return status;
}

function faaBrowserEnabled(): boolean {
  const normalized = process.env[FAA_DRS_BROWSER_ENABLED_ENV]?.trim().toLowerCase();
  return normalized === "true" || normalized === "1";
}

async function harvestTargetedFaaSignals(
  db: Database,
  agent: ResearchAgent,
  deps: Partial<TickHandlerDeps>,
  cache: Map<string, FaaCacheEntry>,
): Promise<
  | { readonly candidate: null }
  | {
      readonly candidate: FaaTargetCandidate;
      readonly fetched: number;
      readonly harvested: number;
      readonly duplicates: number;
      readonly cacheHit: boolean;
      readonly checkpointStatus: "qualified" | "rejected";
    }
> {
  const candidate = await selectFaaTargetCandidate(db);
  if (candidate === null) return { candidate: null };

  const cacheKey = candidate.legalName.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  const now = Date.now();
  const cached = cache.get(cacheKey);
  const cacheHit = cached !== undefined && now - cached.cachedAt < FAA_DRS_CACHE_TTL_MS;
  const chromiumPath = process.env[FAA_DRS_CHROMIUM_PATH_ENV]?.trim();
  const result =
    cacheHit
      ? cached.result
      : await (
          deps.searchFaaPma ??
          ((query) =>
            new FaaDrsBrowserClient(
              chromiumPath === undefined || chromiumPath === ""
                ? {}
                : { chromiumPath },
            ).search(query))
        )({
          holderName: candidate.legalName,
          maxRecords: MAX_SOURCE_SIGNALS_PER_HARVEST_TICK,
        });
  if (!cacheHit) cache.set(cacheKey, { cachedAt: now, result });
  const checkpointStatus = await upsertFaaSearchCheckpoint(
    db,
    agent.id,
    candidate,
    result,
    cacheHit,
    new Date(now),
  );

  const knownCompanyHint = {
    candidateId: candidate.candidateId,
    companyId: candidate.companyId,
    legalName: candidate.legalName,
    displayName: candidate.displayName,
  };
  const proposals: SourceSignalProposal[] = result.records.map((record) => ({
    sourceKey: "faa_drs_pma",
    sourceLocator: record.guidUrl,
    sourceFingerprint: faaRecordFingerprint(record.guidUrl),
    rawName: record.holderName ?? candidate.legalName,
    sourcePayload: {
      record,
      query: result.query,
      source: result.source,
      knownCompanyHint,
    },
  }));
  const persisted = await persistSourceSignalProposals(db, agent.id, proposals);
  return {
    candidate,
    fetched: result.records.length,
    harvested: persisted.harvested,
    duplicates: persisted.duplicates,
    checkpointStatus,
    cacheHit,
  };
}

interface SourceCatalogQuery {
  readonly query: string;
  readonly sourceType: string;
  readonly jurisdiction: string;
}

const SOURCE_CATALOG_QUERIES: readonly SourceCatalogQuery[] = [
  {
    query: "official FAA PMA holder directory parts manufacturer approval",
    sourceType: "regulatory_approval_directory",
    jurisdiction: "United States",
  },
  {
    query: "official AS9100 certified supplier directory OASIS aerospace",
    sourceType: "certification_directory",
    jurisdiction: "International",
  },
  {
    query: "official Nadcap accredited special process supplier list",
    sourceType: "accreditation_directory",
    jurisdiction: "International",
  },
  {
    query: "official DLA qualified products manufacturers list QPL QML",
    sourceType: "government_qualified_list",
    jurisdiction: "United States",
  },
  {
    query: "official aerospace OEM approved supplier processor list",
    sourceType: "oem_approved_supplier_list",
    jurisdiction: "International",
  },
  {
    query: "official aerospace association member supplier directory",
    sourceType: "association_member_directory",
    jurisdiction: "International",
  },
] as const;

function exaSearchClient(
  deps: Partial<TickHandlerDeps>,
): Pick<ExaSearchClient, "search"> {
  return deps.searchExa === undefined
    ? new ExaSearchClient({ apiKey: process.env.EXA_API_KEY })
    : { search: deps.searchExa };
}

async function scoutSourceCatalog(
  db: Database,
  searchClient: Pick<ExaSearchClient, "search">,
  signal: AbortSignal,
): Promise<{ readonly cataloged: number; readonly duplicates: number; readonly rejected: number }> {
  let cataloged = 0;
  let duplicates = 0;
  let rejected = 0;
  for (const catalogQuery of SOURCE_CATALOG_QUERIES) {
    signal.throwIfAborted();
    const results = (await searchClient.search(catalogQuery.query)).slice(0, 5);
    for (const result of results) {
      let url: URL;
      try {
        url = new URL(result.url);
      } catch {
        rejected += 1;
        continue;
      }
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.username !== "" ||
        url.password !== ""
      ) {
        rejected += 1;
        continue;
      }
      const publisher = url.hostname.replace(/^www\./u, "").toLowerCase();
      const name = result.title.trim();
      if (name === "") {
        rejected += 1;
        continue;
      }
      const rows = await db
        .insert(dataSources)
        .values({
          name,
          sourceType: catalogQuery.sourceType,
          baseUrl: url.href,
          access: "restricted_metadata_only",
          ingestion: "manual",
          publisher,
          jurisdiction: catalogQuery.jurisdiction,
          notes: JSON.stringify({
            catalogScout: true,
            query: catalogQuery.query,
            snippet: result.text,
            score: result.score,
            policy: {
              access: "unknown",
              ingestion: "manual_review_only",
              modelUse: "unknown_not_authorized",
            },
          }),
        })
        .onConflictDoNothing()
        .returning({ id: dataSources.id });
      if (rows.length === 0) duplicates += 1;
      else cataloged += 1;
    }
  }
  return { cataloged, duplicates, rejected };
}

function createDiscoverSourceHandler(deps: Partial<TickHandlerDeps>): TickHandler {
  const faaCache = new Map<string, FaaCacheEntry>();
  return async (context): Promise<TickResult> => {
    const agent = context.agent;
    const sourceKey = discoverSourceKey(agent);

    // SAM variant idles honestly without credentials — never pretends to work.
    if (sourceKey === "sam" && !process.env[SAM_API_KEY_ENV]?.trim()) {
      return {
        outcome: "stuck",
        plan: { reasoning: `source ${sourceKey} requires SAM_API_KEY`, actions: [] },
        findings: { idle: true, idleReason: "missing_sam_api_key", source: sourceKey },
      };
    }
    if (sourceKey === "faa_pma_targeted" && !faaBrowserEnabled()) {
      return {
        outcome: "stuck",
        plan: { reasoning: "FAA DRS browser access is disabled", actions: [] },
        findings: {
          idle: true,
          idleReason: "faa_drs_browser_disabled",
          source: "faa_drs_pma",
        },
      };
    }

    const planned = await planAgentTick(deps, context, async () => ({
      knownSources: [sourceKey],
      suggestedQueries: [],
    }));
    if ("shortCircuit" in planned) return planned.shortCircuit;
    const { plan } = planned;
    const planJson = { ...plan };

    const db = getDatabase();
    if (sourceKey === "sam") {
      try {
        const harvest = await harvestSamSourceSignals(db, agent, deps, context.signal);
        return {
          outcome: "executed",
          plan: planJson,
          actionsExecuted: 1,
          findings: {
            source: "sam_entity",
            naics: [...STRICT_SAM_NAICS],
            fetched: harvest.fetched,
            harvested: harvest.harvested,
            duplicates: harvest.duplicates,
            rejected: harvest.rejected,
          },
        };
      } catch (error) {
        if (!(error instanceof SamQuotaExceededError)) throw error;
        return {
          outcome: "budget_exhausted",
          plan: planJson,
          actionsExecuted: 0,
          findings: {
            idle: true,
            idleReason: "sam_daily_quota_exhausted",
            source: "sam_entity",
            resetAt: error.resetAt.toISOString(),
          },
          nextTickAt: error.resetAt,
        };
      }
    }
    if (sourceKey === "faa_pma_targeted") {
      const harvest = await harvestTargetedFaaSignals(db, agent, deps, faaCache);
      if (harvest.candidate === null) {
        return {
          outcome: "done",
          plan: planJson,
          findings: {
            source: "faa_drs_pma",
            note: "no active candidate without an FAA PMA holder identifier",
          },
        };
      }
      return {
        outcome: "executed",
        plan: planJson,
        actionsExecuted: 1,
        findings: {
          source: "faa_drs_pma",
          candidateId: harvest.candidate.candidateId,
          companyId: harvest.candidate.companyId,
          holderName: harvest.candidate.legalName,
          fetched: harvest.fetched,
          harvested: harvest.harvested,
          duplicates: harvest.duplicates,
          checkpointStatus: harvest.checkpointStatus,
          cacheHit: harvest.cacheHit,
        },
      };
    }
    if (sourceKey === "source_catalog") {
      if (deps.searchExa === undefined && !process.env.EXA_API_KEY?.trim()) {
        return {
          outcome: "stuck",
          plan: planJson,
          findings: { idle: true, idleReason: "missing_exa_api_key", source: sourceKey },
        };
      }
      const catalog = await scoutSourceCatalog(db, exaSearchClient(deps), context.signal);
      return {
        outcome: "executed",
        plan: planJson,
        actionsExecuted: SOURCE_CATALOG_QUERIES.length,
        findings: {
          source: "source_catalog",
          queries: SOURCE_CATALOG_QUERIES.length,
          cataloged: catalog.cataloged,
          duplicates: catalog.duplicates,
          rejected: catalog.rejected,
        },
      };
    }

    if (sourceKey !== "usaspending") {
      return {
        outcome: "stuck",
        plan: planJson,
        findings: {
          idleReason: `unsupported_source:${sourceKey}`,
          supportedSources: [
            "usaspending",
            "sam",
            "faa_pma_targeted",
            "source_catalog",
          ],
        },
      };
    }
    const expansion = await runUsaspendingExpansion(db, agent, deps, {
      naics: [...AEROSPACE_NAICS],
    });
    if (expansion === null) {
      const progress = await agentFrontierProgress(agent.id);
      return {
        outcome: "stuck",
        plan: planJson,
        findings: {
          idleReason: progress.pendingMonths === 0 ? "frontier_exhausted" : "frontier_backoff",
          source: "usaspending",
          pendingMonths: progress.pendingMonths,
          completedMonths: progress.completedMonths,
        },
      };
    }
    return {
      outcome: "executed",
      plan: planJson,
      actionsExecuted: 1,
      findings: {
        source: "usaspending",
        query: expansion.queryValue,
        month: expansion.month,
        page: expansion.page,
        cursor: expansion.cursor,
        fetched: expansion.fetched,
        harvested: expansion.harvested,
        duplicates: expansion.duplicates,
        rejected: expansion.rejected,
        pendingMonths: expansion.pendingMonths,
        completedMonths: expansion.completedMonths,
        continuation: expansion.continuation,
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

interface GoldenNeighborExample {
  readonly descriptionRaw: string | null;
  readonly grataPayload: Record<string, unknown>;
}

const GOLDEN_NAICS_CATEGORIES: Readonly<Record<string, string>> = {
  "332710": "precision machine shop aerospace components",
  "336411": "aircraft manufacturing",
  "336412": "aircraft engine and engine parts manufacturing",
  "336413": "aircraft parts and auxiliary equipment manufacturing",
  "336414": "guided missile and space vehicle manufacturing",
  "336415": "guided missile and space vehicle propulsion manufacturing",
  "336419": "space and guided missile components manufacturing",
};

async function selectPositiveGoldenExamples(
  db: Database,
): Promise<GoldenNeighborExample[]> {
  const rows = await db
    .select({
      descriptionRaw: goldenExamples.descriptionRaw,
      grataPayload: goldenExamples.grataPayload,
    })
    .from(goldenExamples)
    .leftJoin(candidates, eq(goldenExamples.companyId, candidates.companyId))
    .where(
      and(
        inArray(goldenExamples.reviewStatus, ["proposed", "reviewed"]),
        or(
          inArray(goldenExamples.archetypeFit, ["strong_positive", "positive"]),
          inArray(goldenExamples.currentActionability, ["strong_positive", "positive"]),
          inArray(goldenExamples.goldenExampleType, [
            "strong_positive",
            "positive_with_caveat",
          ]),
          eq(candidates.tierOverride, "high_interest"),
        ),
      ),
    )
    .limit(50);
  return rows.map((row) => ({
    descriptionRaw: row.descriptionRaw,
    grataPayload: row.grataPayload ?? {},
  }));
}

function goldenNeighborQueryTemplates(
  examples: readonly GoldenNeighborExample[],
): string[] {
  const keywords = new Map<string, string>();
  const addKeyword = (raw: string): void => {
    for (const fragment of raw.split(/[,;|•\n]/u)) {
      const keyword = fragment.replace(/\s+/gu, " ").trim();
      const key = keyword.toLowerCase();
      if (
        keyword.length >= 3 &&
        keyword.length <= 60 &&
        !/^https?:/iu.test(keyword) &&
        !/^\d+$/u.test(keyword) &&
        !keywords.has(key)
      ) {
        keywords.set(key, keyword);
      }
    }
  };
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, path);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        visit(entry, `${path} ${key.toLowerCase()}`);
      }
      return;
    }
    if (typeof value !== "string" && typeof value !== "number") return;
    if (/naics/u.test(path)) {
      for (const code of codeList(value)) {
        const category = GOLDEN_NAICS_CATEGORIES[code];
        if (category !== undefined) addKeyword(category);
      }
    }
    if (
      typeof value === "string" &&
      /(product|capabil|categor|industry|specialt|process|platform|part|component|certif|description)/iu.test(
        path,
      )
    ) {
      addKeyword(value);
    }
  };

  for (const example of examples) {
    if (example.descriptionRaw !== null) visit(example.descriptionRaw, "description");
    visit(example.grataPayload, "payload");
  }
  if (keywords.size === 0) {
    addKeyword("qualified aerospace component manufacturer");
    addKeyword("precision aerospace manufacturing capability");
    addKeyword("proprietary aircraft parts supplier");
  }
  return [...keywords.values()]
    .slice(0, 3)
    .map((keyword) => `"${keyword}" supplier manufacturer`.slice(0, 80));
}

async function persistGoldenNeighborSignals(
  db: Database,
  agent: ResearchAgent,
  proposals: readonly SourceSignalProposal[],
): Promise<{ readonly harvested: number; readonly duplicate: number }> {
  let harvested = 0;
  let duplicate = 0;
  for (const proposal of proposals.slice(0, MAX_SOURCE_SIGNALS_PER_HARVEST_TICK)) {
    const result = await upsertHarvestedSourceSignal(db, {
      sourceKey: "exa_golden_neighbor",
      sourceLocator: proposal.sourceLocator,
      agentId: agent.id,
      rawName: proposal.rawName,
      ...(proposal.rawDomain === undefined ? {} : { rawDomain: proposal.rawDomain }),
      ...(proposal.country === undefined ? {} : { country: proposal.country }),
      awardCount: 0,
      awardValue: 0,
      sourcePayload: {
        ...proposal.sourcePayload,
        goldenNeighborOrigin: true,
      },
    });
    if (result.duplicate) duplicate += 1;
    else harvested += 1;
  }
  return { harvested, duplicate };
}

function createGoldenNeighborHandler(deps: Partial<TickHandlerDeps>): TickHandler {
  return async (context): Promise<TickResult> => {
    const planned = await planAgentTick(deps, context, async (db) => {
      const examples = await selectPositiveGoldenExamples(db);
      return {
        examplesConsidered: examples.length,
        queryTemplates: goldenNeighborQueryTemplates(examples),
      };
    });
    if ("shortCircuit" in planned) return planned.shortCircuit;
    const planJson = { ...planned.plan };

    const db = getDatabase();
    const examples = await selectPositiveGoldenExamples(db);
    if (examples.length === 0) {
      return {
        outcome: "done",
        plan: planJson,
        findings: { idleReason: "no_positive_golden_examples" },
      };
    }
    if (deps.searchExa === undefined && !process.env.EXA_API_KEY?.trim()) {
      return {
        outcome: "stuck",
        plan: planJson,
        findings: { idle: true, idleReason: "missing_exa_api_key" },
      };
    }

    const queryTemplates = goldenNeighborQueryTemplates(examples).slice(0, 3);
    const harvest = await new ExaCompanyListHarvester(exaSearchClient(deps)).harvest(
      { queryTemplates },
      { limit: MAX_SOURCE_SIGNALS_PER_HARVEST_TICK, signal: context.signal },
    );
    const persistence = await persistGoldenNeighborSignals(
      db,
      context.agent,
      harvest.signals,
    );
    return {
      outcome: "executed",
      plan: planJson,
      actionsExecuted: queryTemplates.length,
      findings: {
        source: "exa_golden_neighbor",
        examplesConsidered: examples.length,
        queries: queryTemplates,
        harvested: persistence.harvested,
        duplicate: persistence.duplicate + harvest.metrics.duplicateCandidates,
        rejected: harvest.metrics.rejected,
        fetched: harvest.metrics.fetched,
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

const MAX_IDENTITY_PAGE_TEXT_CHARS = 4_000;

function identityPageText(html: string): string {
  const headings = [
    ...matchAll(html, /<title[^>]*>([\s\S]*?)<\/title/giu),
    ...matchAll(
      html,
      /<meta[^>]+name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)["']/giu,
    ),
    ...matchAll(html, /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/giu),
    ...matchAll(html, /<footer[^>]*>([\s\S]*?)<\/footer>/giu),
  ];
  return collapse(`${headings.join(" ")} ${stripTags(html)}`).slice(
    0,
    MAX_IDENTITY_PAGE_TEXT_CHARS,
  );
}

function identityLinksFrom(html: string, baseUrl: string): string[] {
  const baseHost = hostOf(baseUrl);
  if (baseHost === null) return [];
  const candidates: Array<{ url: string; priority: number }> = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/giu)) {
    const href = /\bhref\s*=\s*["']([^"']+)["']/iu.exec(match[1] ?? "")?.[1];
    if (href === undefined) continue;
    const label = collapse(stripTags(match[2] ?? ""));
    const relevance = `${href} ${label}`.toLocaleLowerCase("en-US");
    if (!/(about|contact|who[\s_-]*we[\s_-]*are)/u.test(relevance)) continue;
    let resolved: URL;
    try {
      resolved = new URL(decodeEntities(href), baseUrl);
    } catch {
      continue;
    }
    if (
      (resolved.protocol !== "https:" && resolved.protocol !== "http:") ||
      hostOf(resolved.toString()) !== baseHost
    ) {
      continue;
    }
    resolved.hash = "";
    const priority = /about|who[\s_-]*we[\s_-]*are/u.test(relevance) ? 0 : 1;
    candidates.push({ url: resolved.toString(), priority });
  }
  candidates.sort((left, right) => left.priority - right.priority);
  return [...new Set(candidates.map((candidate) => candidate.url))].slice(0, 2);
}

class SafeFetchDomainProber implements DomainProber, IdentityPageProber {
  async fetchText(url: string) {
    const page = await this.fetchIdentityPage(url);
    return page.ok
      ? { ok: true as const, finalUrl: page.finalUrl, text: homepageIdentityText(page.text) }
      : page;
  }

  async fetchIdentityPage(url: string): Promise<IdentityPageProbeResult> {
    try {
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
      const html = result.content.slice(0, MAX_HTML_BYTES);
      return {
        ok: true,
        finalUrl: result.finalUrl,
        text: identityPageText(html),
        identityLinks: identityLinksFrom(html, result.finalUrl),
      };
    } catch (error) {
      if (error instanceof SafeFetchError) return { ok: false, error: error.code };
      if (error instanceof Error && error.name === "AbortError") {
        return { ok: false, error: "timeout" };
      }
      return { ok: false, error: "network_error" };
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
  locationMatches: z.union([z.boolean(), z.literal("unknown")]),
  identifierMatches: z.union([z.boolean(), z.literal("unknown")]),
  relationship: z.enum(["exact", "parent_brand", "mismatch"]),
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
  "You decide whether a fetched webpage belongs to the named company using " +
  "the supplied location and identifiers as identity evidence. Reply with " +
  "exactly ONE raw JSON object (no prose, no markdown fences) of shape " +
  '{"matches":boolean,"confidence":number,"locationMatches":boolean|"unknown",' +
  '"identifierMatches":boolean|"unknown","relationship":"exact"|"parent_brand"|"mismatch",' +
  '"reason":string} where confidence is between 0 and 1. Be conservative: reject ' +
  "homonyms when the site location or industry conflicts with the named lead. " +
  "Use exact only when the page identifies the named legal company itself. " +
  "Use parent_brand when the page is a shared parent/corporate brand or portfolio " +
  "site for the named company; it does not mean that subsidiary independently owns the domain. " +
  "Yulista.com is a shared parent-brand site for Yulista Aviation, Contract Services, " +
  "Support Services, and Aerospace & Defense: those leads MUST be matches=true with " +
  "parent_brand, never exact.";

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

  async judgeIdentity(
    leadName: string,
    pageText: string,
    identityHints?: LeadIdentityHints,
  ): Promise<IdentityJudgment> {
    const prompt =
      `Company name: ${leadName}` +
      `\nCity/state: ${identityHints?.location ?? "unknown"}` +
      `\nUEI: ${identityHints?.uei ?? "unknown"}` +
      `\nCAGE: ${identityHints?.cage ?? "unknown"}` +
      `\n\nWebpage text:\n"""\n${pageText}\n"""` +
      "\nDoes this page represent that specific company?";
    const parsed = await this.callWithRepair(
      identityJudgmentSchema,
      "lead_identity_judgment_v2",
      JUDGE_SYSTEM_PROMPT,
      prompt,
    );
    // Conservative anti-fabrication default: no usable judgment ⇒ no match.
    return (
      parsed ?? {
        matches: false,
        confidence: 0,
        locationMatches: "unknown",
        identifierMatches: "unknown",
        relationship: "mismatch",
        reason: "identity judge unavailable",
      }
    );
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

// ---------------------------------------------------------------------------
// Generic source-signal qualification (legacy DB agent_type: qualify_award_lead).
// ---------------------------------------------------------------------------

const MAX_SOURCE_SIGNALS_PER_TICK = 5;
const MAX_EXA_PROPOSALS_PER_SIGNAL = 5;
const MAX_CLASSIFICATION_TEXT_CHARS = 12_000;

const pageGroundedClaimSchema = z.strictObject({
  excerpt: z.string().trim().min(1).max(2_000),
  url: z.string().url().max(2_000),
});
const sourceSignalClassificationSchema = z
  .strictObject({
    manufacturer: z.boolean(),
    aerospaceDefenseRelevance: z.boolean(),
    businessModel: z.enum(["manufacturer", "distributor", "service", "btp", "unknown"]),
    headquartersCountry: z.string().trim().min(1).max(100),
    ownershipType: z.enum([
      "independent",
      "founder_family",
      "pe_owned",
      "strategic_parent",
      "public",
      "unknown",
    ]),
    sizeFit: z.enum(["likely_under_50m", "likely_over_50m", "unknown"]),
    proprietarySignals: z.array(z.string().trim().min(1).max(500)).max(20),
    manufacturerEvidence: pageGroundedClaimSchema.nullable(),
    aerospaceDefenseEvidence: pageGroundedClaimSchema.nullable(),
    targetDecision: z.enum(["yes_target", "no_target", "needs_more_research"]),
    reasons: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
    confidence: z.number().min(0).max(1),
  })
  .superRefine((value, context) => {
    if (value.manufacturer && value.manufacturerEvidence === null) {
      context.addIssue({
        code: "custom",
        path: ["manufacturerEvidence"],
        message: "manufacturer=true requires page-grounded evidence",
      });
    }
    if (value.aerospaceDefenseRelevance && value.aerospaceDefenseEvidence === null) {
      context.addIssue({
        code: "custom",
        path: ["aerospaceDefenseEvidence"],
        message: "aerospaceDefenseRelevance=true requires page-grounded evidence",
      });
    }
  });

const SOURCE_SIGNAL_CLASSIFIER_PROMPT =
  "You classify a company after Exa discovery and verified first-party website identity. " +
  "The original discovery source is only a weak signal; use only the supplied official-site pages. " +
  "manufacturer=true only when a page says the company makes, manufactures, machines, fabricates, " +
  "assembles, or builds physical products. aerospaceDefenseRelevance=true only for explicit aerospace, " +
  "aviation, space, defense, military, or named-program evidence. For each true claim, copy an exact " +
  "excerpt and its [Source URL]; otherwise return null evidence. Determine headquartersCountry, " +
  "ownershipType (independent|founder_family|pe_owned|strategic_parent|public|unknown), sizeFit " +
  "(likely_under_50m|likely_over_50m|unknown), and proprietarySignals. Unknown ownership or size " +
  "is uncertainty, never positive evidence. Propose targetDecision yes_target only for a verified US " +
  "aerospace/defense physical-product manufacturer that is not a distributor/service business, has no " +
  "known PE/strategic/public owner, and is not clearly over $50m. Use needs_more_research only when the " +
  "company is a real US aerospace/defense manufacturer but ownership or size remains unknown; all " +
  "other failures are no_target. Reply with exactly one raw JSON object and no markdown.";

function createSourceSignalClassifier(model: ResolvedModelDeps): {
  readonly classify: SourceSignalClassifier;
  readonly costUsd: () => number;
} {
  let costUsd = 0;
  return {
    classify: async (input) => {
      const result = await model.client.generateStructured({
        route: "fast",
        models: model.models,
        schemaName: "source_signal_target_classification_v2",
        schema: sourceSignalClassificationSchema,
        systemPrompt: SOURCE_SIGNAL_CLASSIFIER_PROMPT,
        prompt:
          `Company legal name: ${input.legalName}` +
          `\nPrimary verified page URL: ${input.pageUrl}` +
          `\n\nVerified official-site pages:\n"""\n${input.pageText.slice(0, MAX_CLASSIFICATION_TEXT_CHARS)}\n"""`,
        temperature: 0,
        maxOutputTokens: 1_024,
        maxAttempts: 1,
      });
      costUsd += result.telemetry.costUsd ?? 0;
      return result.data;
    },
    costUsd: () => costUsd,
  };
}

function officialDomainSearcher(): OfficialDomainSearcher {
  const client = new ExaSearchClient({ apiKey: process.env.EXA_API_KEY });
  return (identity) => searchOfficialDomainCandidates(identity, client);
}

function sourceSignalIdentityHints(signal: {
  readonly city: string | null;
  readonly state: string | null;
  readonly uei: string | null;
  readonly cage: string | null;
}): LeadIdentityHints {
  const location = [signal.city, signal.state].filter((value): value is string => value !== null);
  return {
    location: location.length === 0 ? null : location.join(", "),
    uei: signal.uei,
    cage: signal.cage,
  };
}

export const OFFICIAL_SITE_NAME_OVERLAP_THRESHOLD = 0.6;

export interface OfficialSiteAuthenticity {
  readonly origin: string;
  readonly passed: boolean;
  readonly method:
    | "legal_name_token_overlap"
    | "identifier_and_location"
    | "none"
    | "blocked_domain"
    | "invalid_url"
    | "unreachable";
  readonly corroborationUrl: string | null;
}

interface OfficialSiteIdentity {
  readonly legalName: string;
  readonly city: string | null;
  readonly state: string | null;
  readonly uei: string | null;
  readonly cage: string | null;
}

function containsExactIdentityValue(text: string, value: string): boolean {
  const haystack = text.normalize("NFKC").toLocaleLowerCase("en-US");
  const needle = value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  if (needle.length === 0) return false;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return false;
    const before = index === 0 ? "" : haystack[index - 1] ?? "";
    const afterIndex = index + needle.length;
    const after = afterIndex === haystack.length ? "" : haystack[afterIndex] ?? "";
    if (!/[a-z0-9]/u.test(before) && !/[a-z0-9]/u.test(after)) return true;
    from = index + 1;
  }
  return false;
}

function pageMatchesLocation(identity: OfficialSiteIdentity, text: string): boolean {
  if (identity.city !== null) return containsExactIdentityValue(text, identity.city);
  return identity.state !== null && containsExactIdentityValue(text, identity.state);
}

function legalNameTokenOverlapRatio(legalName: string, pageText: string): number {
  const legalTokens = leadNameTokens(legalName);
  if (legalTokens.length === 0) return 0;
  const pageTokens = new Set(
    pageText
      .normalize("NFKC")
      .toLocaleLowerCase("en-US")
      .split(/[^a-z0-9]+/u)
      .filter((token) => token.length > 0),
  );
  let matched = 0;
  for (const token of legalTokens) {
    if (pageTokens.has(token)) matched += 1;
  }
  return matched / legalTokens.length;
}

export function evaluateOfficialSiteAuthenticity(
  identity: OfficialSiteIdentity,
  origin: string,
  pages: readonly IdentityPage[],
): OfficialSiteAuthenticity {
  for (const page of pages) {
    if (
      legalNameTokenOverlapRatio(identity.legalName, page.text) >=
      OFFICIAL_SITE_NAME_OVERLAP_THRESHOLD
    ) {
      return {
        origin,
        passed: true,
        method: "legal_name_token_overlap",
        corroborationUrl: page.finalUrl,
      };
    }
  }

  const identifierPage = pages.find((page) =>
    [identity.uei, identity.cage].some(
      (identifier) =>
        identifier !== null && containsExactIdentityValue(page.text, identifier),
    ),
  );
  const locationPage = pages.find((page) => pageMatchesLocation(identity, page.text));
  if (identifierPage !== undefined && locationPage !== undefined) {
    return {
      origin,
      passed: true,
      method: "identifier_and_location",
      corroborationUrl: identifierPage.finalUrl,
    };
  }
  return {
    origin,
    passed: false,
    method: "none",
    corroborationUrl: null,
  };
}

function identityJudgmentAccepts(judgment: IdentityJudgment): boolean {
  return (
    judgment.matches &&
    judgment.confidence >= MIN_JUDGE_CONFIDENCE &&
    (judgment.relationship === "exact" || judgment.relationship === "parent_brand")
  );
}

function isPageGroundedClaim(
  claim: PageGroundedClaim | null,
  pageText: string,
  fetchedUrls: readonly string[],
): boolean {
  return (
    claim !== null &&
    normalizedContains(pageText, claim.excerpt) &&
    fetchedUrls.includes(claim.url)
  );
}

export interface DeterministicSourceSignalDecision {
  readonly targetDecision: SourceSignalTargetDecision;
  readonly reasons: readonly string[];
}

async function recordTargetDecision(
  db: Database,
  signalId: string,
  input: {
    readonly status: "qualified" | "rejected";
    readonly modelProposal: SourceSignalClassification | null;
    readonly deterministicDecision: DeterministicSourceSignalDecision;
    readonly evidence: Record<string, unknown>;
    readonly leadId?: string;
    readonly companyId?: string;
  },
): Promise<void> {
  await recordSourceSignalQualification(db, signalId, {
    decision: input.status,
    reason: input.deterministicDecision.targetDecision,
    evidence: {
      ...input.evidence,
      modelProposal: input.modelProposal,
      deterministicDecision: input.deterministicDecision,
    },
    ...(input.leadId === undefined ? {} : { leadId: input.leadId }),
    ...(input.companyId === undefined ? {} : { companyId: input.companyId }),
  });
  // Keep the proposal/override directly addressable while retaining the full
  // decision envelope produced by the canonical qualification recorder.
  await db
    .update(sourceSignals)
    .set({
      qualification: sql`${sourceSignals.qualification} || ${JSON.stringify({
        modelProposal: input.modelProposal,
        deterministicDecision: input.deterministicDecision,
      })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(sourceSignals.id, signalId));
}

export type QualifiedSourceSynthesisState = "materialized" | "waiting" | "noop";

export async function synthesizeQualifiedSignalIfReady(
  db: Database,
  signalId: string,
  deps: Pick<TickHandlerDeps, "synthesizeSourceSignal"> = {},
): Promise<QualifiedSourceSynthesisState> {
  const [signal] = await db
    .select({
      sourceKey: sourceSignals.sourceKey,
      status: sourceSignals.status,
      companyId: sourceSignals.companyId,
    })
    .from(sourceSignals)
    .where(eq(sourceSignals.id, signalId))
    .limit(1);
  if (
    signal === undefined ||
    (signal.sourceKey !== "sam_entity" && signal.sourceKey !== "faa_drs_pma") ||
    signal.status !== "qualified"
  ) {
    return "noop";
  }
  if (signal.companyId === null) return "waiting";
  await (deps.synthesizeSourceSignal ?? synthesizeQualifiedSourceSignal)(db, signalId);
  return "materialized";
}

/** The model proposes; this policy function owns the terminal target decision. */
export function deterministicSourceSignalDecision(
  classification: SourceSignalClassification,
  pageText: string,
  fetchedUrls: readonly string[],
): DeterministicSourceSignalDecision {
  const noTargetReasons: string[] = [];
  if (!classification.manufacturer) noTargetReasons.push("manufacturer_not_verified");
  else if (!isPageGroundedClaim(classification.manufacturerEvidence, pageText, fetchedUrls)) {
    noTargetReasons.push("manufacturer_evidence_not_page_grounded");
  }
  if (!classification.aerospaceDefenseRelevance) {
    noTargetReasons.push("aerospace_defense_not_verified");
  } else if (
    !isPageGroundedClaim(classification.aerospaceDefenseEvidence, pageText, fetchedUrls)
  ) {
    noTargetReasons.push("aerospace_defense_evidence_not_page_grounded");
  }
  if (classification.confidence < 0.75) {
    noTargetReasons.push("classification_confidence_below_threshold");
  }

  const country = normalizeText(classification.headquartersCountry).replace(/[.,]/gu, "");
  const headquartersIsUs =
    country === "us" ||
    country === "usa" ||
    country === "united states" ||
    country === "united states of america";
  if (!headquartersIsUs) {
    noTargetReasons.push(
      country === "unknown" || country === "unclear"
        ? "headquarters_not_verified_us"
        : "non_us_headquarters",
    );
  }
  if (
    classification.businessModel === "distributor" ||
    classification.businessModel === "service"
  ) {
    noTargetReasons.push(`ineligible_business_model:${classification.businessModel}`);
  }
  if (
    classification.ownershipType === "pe_owned" ||
    classification.ownershipType === "strategic_parent" ||
    classification.ownershipType === "public"
  ) {
    noTargetReasons.push(`ineligible_ownership:${classification.ownershipType}`);
  }
  if (classification.sizeFit === "likely_over_50m") {
    noTargetReasons.push("likely_over_50m");
  }
  if (noTargetReasons.length > 0) {
    return { targetDecision: "no_target", reasons: noTargetReasons };
  }

  const researchReasons: string[] = [];
  if (classification.ownershipType === "unknown") {
    researchReasons.push("ownership_requires_research");
  }
  if (classification.sizeFit === "unknown") {
    researchReasons.push("size_requires_research");
  }
  return researchReasons.length > 0
    ? { targetDecision: "needs_more_research", reasons: researchReasons }
    : {
        targetDecision: "yes_target",
        reasons: ["verified_us_aerospace_physical_product_manufacturer"],
      };
}

async function linkedLeadForSourceSignal(
  db: Database,
  qualifierAgentId: string,
  rawName: string,
  domain: string,
): Promise<{ readonly id: string; readonly companyId: string | null } | null> {
  const rows = await db
    .select({ id: leads.id, companyId: leads.resolvedCompanyId })
    .from(leads)
    .where(
      and(
        eq(leads.campaignId, qualifierAgentId),
        eq(leads.rawName, rawName),
        eq(leads.possibleDomain, domain),
      ),
    )
    .orderBy(desc(leads.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

async function routeQualifiedCandidate(
  db: Database,
  companyId: string,
  signal: SourceSignal,
  decision: DeterministicSourceSignalDecision,
): Promise<void> {
  const rationale = {
    whyInteresting: [
      "Verified from first-party pages as a US aerospace/defense physical-product manufacturer.",
      `Qualified from ${signal.sourceKey}: ${signal.sourceLocator}`,
    ],
    risks: [
      "Initial source-signal qualification only; enrichment confidence does not yet support evaluate tier.",
    ],
    unknowns:
      decision.targetDecision === "needs_more_research"
        ? [
            "Ownership: independent/founder-family versus PE, strategic, or public control",
            "Size fit: evidence that revenue is likely under $50m",
            "Qualifications and customer concentration",
          ]
        : ["Exact revenue and employee count", "Qualifications", "Customer concentration"],
  };
  await db
    .insert(candidates)
    .values({ companyId, status: "queued_research", rationale })
    .onConflictDoNothing({ target: candidates.companyId });
  // Never regress an already enriched candidate. Newly created and existing
  // queued candidates remain engine-owned needs_research until enrichment.
  await db
    .update(candidates)
    .set({ rationale, updatedAt: new Date() })
    .where(
      and(
        eq(candidates.companyId, companyId),
        eq(candidates.status, "queued_research"),
      ),
    );
}

async function qualifySourceSignal(input: {
  readonly db: Database;
  readonly qualifierAgent: ResearchAgent;
  readonly signal: SourceSignal;
  readonly searchDomains: OfficialDomainSearcher;
  readonly pageProber: IdentityPageProber;
  readonly judge: DomainJudge;
  readonly classifier: SourceSignalClassifier;
}): Promise<SourceSignalTargetDecision> {
  const proposals = await input.searchDomains({
    legalName: input.signal.rawName,
    ...(input.signal.city === null ? {} : { city: input.signal.city }),
    ...(input.signal.state === null ? {} : { state: input.signal.state }),
    ...(input.signal.uei === null ? {} : { uei: input.signal.uei }),
    ...(input.signal.cage === null ? {} : { cage: input.signal.cage }),
  });
  const attempts: Array<Record<string, unknown>> = [];
  for (const proposal of proposals.slice(0, MAX_EXA_PROPOSALS_PER_SIGNAL)) {
    let candidateUrl: URL;
    try {
      candidateUrl = new URL(proposal.url);
    } catch {
      attempts.push({
        domain: proposal.domain,
        outcome: "invalid_url",
        officiality: {
          origin: proposal.url,
          passed: false,
          method: "invalid_url",
          corroborationUrl: null,
        } satisfies OfficialSiteAuthenticity,
      });
      continue;
    }
    const origin = `${candidateUrl.origin}/`;
    if (
      !["http:", "https:"].includes(candidateUrl.protocol) ||
      candidateUrl.username !== "" ||
      candidateUrl.password !== ""
    ) {
      attempts.push({
        domain: proposal.domain,
        outcome: "invalid_url",
        officiality: {
          origin,
          passed: false,
          method: "invalid_url",
          corroborationUrl: null,
        } satisfies OfficialSiteAuthenticity,
      });
      continue;
    }
    if (isSuppressedDirectoryDomain(candidateUrl.hostname)) {
      attempts.push({
        domain: proposal.domain,
        outcome: "blocked_domain",
        officiality: {
          origin,
          passed: false,
          method: "blocked_domain",
          corroborationUrl: null,
        } satisfies OfficialSiteAuthenticity,
      });
      continue;
    }

    // Exa result paths are weak third-party proposals. Always authenticate the
    // root origin before fetching or using the proposed deep page.
    const homepage = await input.pageProber.fetchIdentityPage(origin);
    if (!homepage.ok) {
      attempts.push({
        domain: proposal.domain,
        outcome: "unreachable",
        reason: homepage.error,
        officiality: {
          origin,
          passed: false,
          method: "unreachable",
          corroborationUrl: null,
        } satisfies OfficialSiteAuthenticity,
      });
      continue;
    }
    const homepageHost = hostOf(homepage.finalUrl);
    if (
      homepageHost === null ||
      isSuppressedDirectoryDomain(new URL(homepage.finalUrl).hostname)
    ) {
      attempts.push({
        domain: proposal.domain,
        outcome: "blocked_domain_redirect",
        officiality: {
          origin,
          passed: false,
          method: "blocked_domain",
          corroborationUrl: null,
        } satisfies OfficialSiteAuthenticity,
      });
      continue;
    }
    const authenticityPages: IdentityPage[] = [homepage];
    const identityLinks = homepage.identityLinks
      .filter((link) => hostOf(link) === homepageHost)
      .slice(0, 2);
    for (const link of identityLinks) {
      const page = await input.pageProber.fetchIdentityPage(link);
      if (page.ok && hostOf(page.finalUrl) === homepageHost) authenticityPages.push(page);
    }
    const officiality = evaluateOfficialSiteAuthenticity(
      {
        legalName: input.signal.rawName,
        city: input.signal.city,
        state: input.signal.state,
        uei: input.signal.uei,
        cage: input.signal.cage,
      },
      origin,
      authenticityPages,
    );
    if (!officiality.passed) {
      attempts.push({
        domain: proposal.domain,
        urls: authenticityPages.map((page) => page.finalUrl),
        outcome: "officiality_failed",
        officiality,
      });
      continue;
    }

    const pages = [...authenticityPages];
    candidateUrl.hash = "";
    if (
      candidateUrl.href !== origin &&
      hostOf(candidateUrl.href) === homepageHost &&
      !pages.some((page) => page.finalUrl === candidateUrl.href)
    ) {
      const deepPage = await input.pageProber.fetchIdentityPage(candidateUrl.href);
      if (deepPage.ok && hostOf(deepPage.finalUrl) === homepageHost) pages.push(deepPage);
    }
    const pageText = pages
      .map((page) => `[Source URL: ${page.finalUrl}]\n${page.text}`)
      .join("\n\n");
    const identityUrls = pages.map((page) => page.finalUrl);
    const judgment = await input.judge.judgeIdentity(
      input.signal.rawName,
      pageText,
      sourceSignalIdentityHints(input.signal),
    );
    if (!identityJudgmentAccepts(judgment)) {
      attempts.push({
        domain: proposal.domain,
        urls: identityUrls,
        outcome: "identity_mismatch",
        officiality,
        identity: judgment,
      });
      continue;
    }

    const corroborationUrl = officiality.corroborationUrl;
    const modelProposal = await input.classifier({
      legalName: input.signal.rawName,
      pageText,
      pageUrl: corroborationUrl ?? homepage.finalUrl,
    });
    const deterministicDecision = deterministicSourceSignalDecision(
      modelProposal,
      pageText,
      identityUrls,
    );
    const evidence = {
      proposal: {
        domain: proposal.domain,
        url: proposal.url,
        title: proposal.title,
        snippet: proposal.textSnippet,
      },
      officiality,
      identity: judgment,
      identityUrls,
      corroborationUrl,
      attempts,
    };
    if (deterministicDecision.targetDecision === "no_target") {
      await recordTargetDecision(input.db, input.signal.id, {
        status: "rejected",
        modelProposal,
        deterministicDecision,
        evidence,
      });
      return "no_target";
    }

    await ingestLeadCandidates(input.qualifierAgent.id, [
      {
        rawName: input.signal.rawName,
        domain: proposal.domain,
        ...(input.signal.uei === null ? {} : { uei: input.signal.uei }),
        ...(input.signal.cage === null ? {} : { cageCode: input.signal.cage }),
        ...(input.signal.city === null ? {} : { city: input.signal.city }),
        ...(input.signal.state === null ? {} : { state: input.signal.state }),
        awardCount: input.signal.awardCount ?? 0,
        totalAwardValueUsd: Number(input.signal.awardValue ?? 0),
        ...(input.signal.freshestAward === null
          ? {}
          : { freshestAwardDate: input.signal.freshestAward.toISOString() }),
        sourceLocator: input.signal.sourceLocator,
      },
    ]);
    const lead = await linkedLeadForSourceSignal(
      input.db,
      input.qualifierAgent.id,
      input.signal.rawName,
      proposal.domain,
    );
    if (lead === null) {
      throw new Error("qualified source-signal ingestion returned no lead");
    }
    await input.db
      .update(leads)
      .set({
        context: sql`${leads.context} || ${JSON.stringify({
          sourceSignalQualification: {
            sourceSignalId: input.signal.id,
            sourceKey: input.signal.sourceKey,
            modelProposal,
            deterministicDecision,
            candidateRouting: {
              status: "queued_research",
              effectiveTier: "needs_research",
              evaluateRequiresEnrichmentConfidence: true,
            },
          },
        })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(leads.id, lead.id));
    if (lead.companyId !== null) {
      await routeQualifiedCandidate(
        input.db,
        lead.companyId,
        input.signal,
        deterministicDecision,
      );
    }
    await recordTargetDecision(input.db, input.signal.id, {
      status: "qualified",
      modelProposal,
      deterministicDecision,
      evidence,
      leadId: lead.id,
      ...(lead.companyId === null ? {} : { companyId: lead.companyId }),
    });
    return deterministicDecision.targetDecision;
  }

  const deterministicDecision: DeterministicSourceSignalDecision = {
    targetDecision: "no_target",
    reasons: ["official_identity_not_verified"],
  };
  await recordTargetDecision(input.db, input.signal.id, {
    status: "rejected",
    modelProposal: null,
    deterministicDecision,
    evidence: { attempts },
  });
  return "no_target";
}

function createQualifyAwardLeadHandler(deps: Partial<TickHandlerDeps>): TickHandler {
  return async (context): Promise<TickResult> => {
    const planned = await planAgentTick(deps, context, async (db) => ({
      sourceSignalIds: (
        await db
          .select({ id: sourceSignals.id })
          .from(sourceSignals)
          .where(eq(sourceSignals.status, "queued_qualification"))
          .orderBy(asc(sourceSignals.createdAt))
          .limit(MAX_SOURCE_SIGNALS_PER_TICK)
      ).map((signal) => signal.id),
    }));
    if ("shortCircuit" in planned) return planned.shortCircuit;
    if (deps.searchOfficialDomains === undefined && !process.env.EXA_API_KEY) {
      return {
        outcome: "stuck",
        plan: { ...planned.plan },
        findings: { idle: true, idleReason: "missing_exa_api_key" },
      };
    }
    const needsModel = deps.classifySourceSignal === undefined || deps.domainJudge === undefined;
    const model = needsModel ? resolveModelDeps(deps) : null;
    if (needsModel && model === null) {
      return {
        outcome: "stuck",
        plan: { ...planned.plan },
        findings: { idle: true, idleReason: "missing_model_dependencies" },
      };
    }
    const runtime =
      deps.domainProber !== undefined && deps.domainJudge !== undefined
        ? { prober: deps.domainProber, judge: deps.domainJudge }
        : buildDomainResolutionDeps(deps)?.deps;
    if (runtime === undefined) {
      return {
        outcome: "stuck",
        plan: { ...planned.plan },
        findings: { idle: true, idleReason: "missing_identity_dependencies" },
      };
    }
    const pageProber: IdentityPageProber =
      deps.identityPageProber ??
      (deps.domainProber === undefined
        ? new SafeFetchDomainProber()
        : {
            fetchIdentityPage: async (url) => {
              const probe = await runtime.prober.fetchText(url);
              return probe.ok
                ? {
                    ok: true as const,
                    finalUrl: probe.finalUrl,
                    text: probe.text,
                    identityLinks: [],
                  }
                : probe;
            },
          });
    const defaultClassifier =
      deps.classifySourceSignal === undefined && model !== null
        ? createSourceSignalClassifier(model)
        : null;
    const classifier = deps.classifySourceSignal ?? defaultClassifier?.classify;
    if (classifier === undefined) {
      return {
        outcome: "stuck",
        plan: { ...planned.plan },
        findings: { idle: true, idleReason: "missing_classifier" },
      };
    }
    const db = getDatabase();
    const signals = await claimQueuedSourceSignals(db, MAX_SOURCE_SIGNALS_PER_TICK);
    let yesTarget = 0;
    let needsMoreResearch = 0;
    let noTarget = 0;
    let quarantined = 0;
    let synthesisMaterialized = 0;
    let synthesisWaiting = 0;
    const synthesisErrors: Array<{ signalId: string; error: string }> = [];
    for (const signal of signals) {
      try {
        const result = await qualifySourceSignal({
          db,
          qualifierAgent: context.agent,
          signal,
          searchDomains: deps.searchOfficialDomains ?? officialDomainSearcher(),
          pageProber,
          judge: runtime.judge,
          classifier,
        });
        if (result === "yes_target") yesTarget += 1;
        else if (result === "needs_more_research") needsMoreResearch += 1;
        else noTarget += 1;
        if (result !== "no_target") {
          try {
            const synthesis = await synthesizeQualifiedSignalIfReady(db, signal.id, deps);
            if (synthesis === "materialized") synthesisMaterialized += 1;
            else if (synthesis === "waiting") synthesisWaiting += 1;
          } catch (error) {
            synthesisErrors.push({
              signalId: signal.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } catch (error) {
        quarantined += 1;
        await recordSourceSignalQualification(db, signal.id, {
          decision: "quarantined",
          reason: "qualification_error",
          evidence: { error: error instanceof Error ? error.message : String(error) },
        });
      }
    }
    return {
      outcome: "executed",
      plan: { ...planned.plan },
      actionsExecuted: signals.length,
      findings: {
        selected: signals.length,
        statusTransitions: {
          "qualifying->qualified": yesTarget + needsMoreResearch,
          "qualifying->rejected": noTarget,
          "qualifying->quarantined": quarantined,
        },
        targetDecisions: {
          yes_target: yesTarget,
          needs_more_research: needsMoreResearch,
          no_target: noTarget,
        },
        synthesis: {
          materialized: synthesisMaterialized,
          waitingForCompany: synthesisWaiting,
          errors: synthesisErrors,
        },
      },
      costUsd: judgeCostUsd(runtime.judge) + (defaultClassifier?.costUsd() ?? 0),
    };
  };
}

/**
 * Prefer source-qualified domain signals, then oldest unresolved leads. A
 * possible domain still goes through the full homepage identity gate.
 */
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
    .where(eq(leads.status, "unresolved_lead"))
    .orderBy(
      desc(sql`case when ${leads.possibleDomain} is not null then 1 else 0 end`),
      asc(leads.createdAt),
    )
    .limit(limit);
}

interface ResolvedLeadSynthesis {
  readonly leadId: string;
  readonly attached: number;
  readonly materialized: number;
  readonly errors: readonly { signalId: string; error: string }[];
}

async function synthesizeResolvedLeadSignals(
  db: Database,
  leadId: string,
  companyId: string,
  deps: Pick<TickHandlerDeps, "synthesizeSourceSignal">,
): Promise<ResolvedLeadSynthesis> {
  const attached = await db
    .update(sourceSignals)
    .set({ companyId, updatedAt: new Date() })
    .where(
      and(
        eq(sourceSignals.leadId, leadId),
        eq(sourceSignals.status, "qualified"),
        inArray(sourceSignals.sourceKey, ["sam_entity", "faa_drs_pma"]),
        sql`${sourceSignals.companyId} IS NULL`,
      ),
    )
    .returning({ id: sourceSignals.id });
  const ready = await db
    .select({ id: sourceSignals.id })
    .from(sourceSignals)
    .where(
      and(
        eq(sourceSignals.leadId, leadId),
        eq(sourceSignals.companyId, companyId),
        eq(sourceSignals.status, "qualified"),
        inArray(sourceSignals.sourceKey, ["sam_entity", "faa_drs_pma"]),
      ),
    );
  let materialized = 0;
  const errors: Array<{ signalId: string; error: string }> = [];
  for (const signal of ready) {
    try {
      if (
        (await synthesizeQualifiedSignalIfReady(db, signal.id, deps)) ===
        "materialized"
      ) {
        materialized += 1;
      }
    } catch (error) {
      errors.push({
        signalId: signal.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { leadId, attached: attached.length, materialized, errors };
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
    const sourceSynthesis: ResolvedLeadSynthesis[] = [];
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
          sourceSynthesis.push(
            await synthesizeResolvedLeadSignals(
              db,
              result.leadId,
              result.companyId,
              deps,
            ),
          );
        } else if (
          result.outcome === "already_resolved" &&
          result.companyId !== undefined
        ) {
          sourceSynthesis.push(
            await synthesizeResolvedLeadSignals(
              db,
              result.leadId,
              result.companyId,
              deps,
            ),
          );
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
      findings: { verified, noDomain, mismatched, errors, sourceSynthesis },
      costUsd: judgeCostUsd(runtime.judge),
    };
  };
}
