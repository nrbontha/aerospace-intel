/**
 * Planner step (REDESIGN_PLAN §1.2 step 3).
 *
 * Turns an agent's goal + a compact durable-state slice + recent tick
 * outcomes into the next batch of proposed actions. The LLM proposes;
 * deterministic code verifies: every proposal is validated against the
 * agent type's action manifest (Zod). One repair retry, then a
 * deterministic fallback built from type defaults — a tick never
 * hard-fails on planner output.
 *
 * Output shape is signature-compatible with the supervisor's TickResult
 * `plan` field (Record<string, unknown> via completeTick/startTick), so
 * handlers persist it on the agent_ticks row unchanged.
 *
 * Fallback state-slice contract (well-known keys, all optional):
 *   discover_source    knownSources?: string[], suggestedQueries?: string[]
 *   enrich_candidate   queuedCompanyIds?: string[]
 *   monitor_ownership  staleCandidateIds?: string[]
 *   refresh_stale      staleEvidenceIds?: string[]
 *   golden_neighbor    archetypeFilters?: Record<string, string|number|boolean>
 */
import type { AgentType, ResearchAgent } from "@asi/database";
import { z } from "zod";

import type {
  OpenRouterClient,
  OpenRouterModelRoute,
  OpenRouterModelRouting,
} from "../openrouter.js";

export const PLANNER_SCHEMA_NAME = "agent_plan_v1";

/** Hard ceiling on any proposed batch; LLM output beyond this is sliced. */
export const MAX_PLAN_ACTIONS = 10;

/** Last N recent ticks rendered into the prompt. */
const MAX_RECENT_TICKS = 5;

/** Serialized size bound for each JSON block in the prompt. */
const MAX_PROMPT_JSON_CHARS = 6_000;

/** Neutral discovery query when neither state nor seedScope offers work. */
const DEFAULT_DISCOVERY_QUERY = "aerospace manufacturing suppliers";

const nonEmptyString = z.string().min(1);

// ---------------------------------------------------------------------------
// Action manifests — one Zod schema per agent_type.
// ---------------------------------------------------------------------------

/** discover_source: query strings or source-key expansions. */
export const discoverActionSchema = z.union([
  z.strictObject({ query: nonEmptyString }),
  z.strictObject({ source: nonEmptyString }),
]);

/** enrich_candidate: one company to deep-research. */
export const enrichActionSchema = z.strictObject({
  companyId: nonEmptyString,
});

/** monitor_ownership: one candidate to re-verify. */
export const monitorActionSchema = z.strictObject({
  candidateId: nonEmptyString,
});

/** refresh_stale: one stale evidence document to re-fetch. */
export const refreshActionSchema = z.strictObject({
  evidenceId: nonEmptyString,
});

/** golden_neighbor: same-platform / same-qualification peer filters. */
export const neighborActionSchema = z.strictObject({
  archetypeFilters: z.record(
    z.string(),
    z.union([nonEmptyString, z.number().finite(), z.boolean()]),
  ),
});

/** resolve_domain: one lead whose official website should be found. */
export const resolveDomainActionSchema = z.strictObject({
  leadId: nonEmptyString,
});

/**
 * agent_type → action manifest. Adding a new agent type means adding its
 * enum value in @asi/database and an entry here.
 */
export const AGENT_ACTION_SCHEMAS = {
  discover_source: discoverActionSchema,
  enrich_candidate: enrichActionSchema,
  monitor_ownership: monitorActionSchema,
  refresh_stale: refreshActionSchema,
  golden_neighbor: neighborActionSchema,
  resolve_domain: resolveDomainActionSchema,
} as const satisfies Record<AgentType, z.ZodType>;

/** The action manifest for one agent type. */
export function actionManifest(
  agentType: AgentType,
): z.ZodType<PlannedAction> {
  return AGENT_ACTION_SCHEMAS[agentType] as z.ZodType<PlannedAction>;
}

export type DiscoverSourceAction = z.infer<typeof discoverActionSchema>;
export type EnrichCandidateAction = z.infer<typeof enrichActionSchema>;
export type MonitorOwnershipAction = z.infer<typeof monitorActionSchema>;
export type RefreshStaleAction = z.infer<typeof refreshActionSchema>;
export type GoldenNeighborAction = z.infer<typeof neighborActionSchema>;
export type ResolveDomainAction = z.infer<typeof resolveDomainActionSchema>;

export type PlannedAction =
  | DiscoverSourceAction
  | EnrichCandidateAction
  | MonitorOwnershipAction
  | RefreshStaleAction
  | GoldenNeighborAction
  | ResolveDomainAction;

/** Plan envelope the LLM must return for a given action manifest. */
export function planEnvelopeSchema<A extends z.ZodType>(actionSchema: A) {
  return z.strictObject({
    reasoning: z.string().max(4_000),
    actions: z.array(actionSchema),
  });
}

type PlanEnvelope = { reasoning: string; actions: PlannedAction[] };

// ---------------------------------------------------------------------------
// Public input/output shapes.
// ---------------------------------------------------------------------------

/** Structural subset of the registry row the planner needs. */
export type PlannerAgentInput = Pick<
  ResearchAgent,
  "key" | "agentType" | "goal" | "seedScope"
>;

/** Compact summary of one prior tick, injected by the caller. */
export interface RecentTickSummary {
  readonly outcome: string;
  readonly error?: string | null;
  readonly findings?: Record<string, unknown>;
}

export interface PlanTickOptions {
  /** Injected OpenRouter gateway; fake it in tests. */
  readonly client: OpenRouterClient;
  readonly models: OpenRouterModelRouting;
  /** Batch cap; defaults to and never exceeds MAX_PLAN_ACTIONS. */
  readonly maxActions?: number;
  readonly route?: OpenRouterModelRoute;
  readonly signal?: AbortSignal;
}

export interface AgentPlan {
  readonly agentType: AgentType;
  readonly reasoning: string;
  readonly actions: PlannedAction[];
  /**
   * llm: first attempt validated · llm_repaired: second attempt after one
   * validation failure · fallback: deterministic type defaults.
   */
  readonly origin: "llm" | "llm_repaired" | "fallback";
  /** Present when the proposal exceeded the cap and was sliced. */
  readonly truncated?: boolean;
  /** Gateway-reported spend across planner calls this tick. */
  readonly costUsd: number;
}

// ---------------------------------------------------------------------------
// Prompt construction.
// ---------------------------------------------------------------------------

export const PLANNER_SYSTEM_PROMPT =
  "You are the planning module of an autonomous research agent. Given the " +
  "agent's mission, a compact snapshot of its durable state, and recent tick " +
  "outcomes, propose the next small batch of concrete actions. Prefer actions " +
  "that make progress on the mission and avoid repeating recently failed " +
  "work. Only propose action shapes allowed for your agent type.";

function boundedJson(value: unknown, limit = MAX_PROMPT_JSON_CHARS): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? "null";
  } catch {
    text = '"[unserializable]"';
  }
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…[truncated ${text.length - limit} chars]`;
}

const ACTION_HINTS: Record<AgentType, string> = {
  discover_source: '{"query": "<search terms>"} or {"source": "<source key>"}',
  enrich_candidate: '{"companyId": "<company id>"}',
  monitor_ownership: '{"candidateId": "<candidate id>"}',
  refresh_stale: '{"evidenceId": "<evidence document id>"}',
  golden_neighbor:
    '{"archetypeFilters": {"<axis>": <string|number|boolean>, ...}}',
  resolve_domain: '{"leadId": "<lead id>"}',
};

/** Human-readable rendering of recent ticks for the prompt. */
function renderRecentTicks(recentTicks: readonly RecentTickSummary[]): string {
  const lines: string[] = [];
  for (const tick of recentTicks.slice(-MAX_RECENT_TICKS)) {
    const parts = [`outcome=${tick.outcome}`];
    if (tick.error) parts.push(`error=${JSON.stringify(tick.error)}`);
    if (
      tick.findings !== undefined &&
      Object.keys(tick.findings).length > 0
    ) {
      parts.push(`findings=${boundedJson(tick.findings, 500)}`);
    }
    lines.push(`- ${parts.join(" ")}`);
  }
  return lines.length === 0 ? "- (no prior ticks)" : lines.join("\n");
}

export function buildPlannerPrompt(input: {
  readonly agent: PlannerAgentInput;
  readonly stateSlice: Record<string, unknown>;
  readonly recentTicks: readonly RecentTickSummary[];
  readonly maxActions: number;
}): string {
  return [
    `Agent: ${input.agent.key} (${input.agent.agentType})`,
    `Mission: ${input.agent.goal}`,
    `Seed scope: ${boundedJson(input.agent.seedScope ?? {})}`,
    `Durable state: ${boundedJson(input.stateSlice)}`,
    "Recent tick outcomes:",
    renderRecentTicks(input.recentTicks),
    `Allowed action shapes for ${input.agent.agentType}: ${
      ACTION_HINTS[input.agent.agentType]
    }`,
    `Propose between 0 and ${input.maxActions} actions.`,
    'Reply with exactly one JSON object: {"reasoning": "...", "actions": [...]}',
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Deterministic fallback.
// ---------------------------------------------------------------------------

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
}

function primitiveFilters(value: unknown): Record<string, string | number | boolean> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const filters: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof entry === "string" ||
      typeof entry === "boolean" ||
      typeof entry === "number"
    ) {
      filters[key] = entry;
    }
    if (Object.keys(filters).length >= 8) break;
  }
  return filters;
}

/**
 * Type-default proposal used when the LLM path is unusable. Derived only
 * from the registry row's seed scope and the caller-provided state slice —
 * no I/O, fully deterministic. An empty batch is valid: the executor's
 * reflection records nothing to do.
 */
export function fallbackActions(
  agent: PlannerAgentInput,
  stateSlice: Record<string, unknown>,
  maxActions: number,
): PlannedAction[] {
  switch (agent.agentType) {
    case "discover_source": {
      const sources = stringList(stateSlice["knownSources"]);
      const seedSources = stringList(agent.seedScope?.sources);
      const queries = stringList(stateSlice["suggestedQueries"]);
      const actions: PlannedAction[] = [];
      for (const source of [...sources, ...seedSources]) {
        actions.push({ source });
      }
      for (const query of queries) {
        actions.push({ query });
      }
      if (actions.length === 0) {
        actions.push({ query: DEFAULT_DISCOVERY_QUERY });
      }
      return actions.slice(0, maxActions);
    }
    case "enrich_candidate":
      return stringList(stateSlice["queuedCompanyIds"])
        .slice(0, maxActions)
        .map((companyId) => ({ companyId }));
    case "monitor_ownership":
      return stringList(stateSlice["staleCandidateIds"])
        .slice(0, maxActions)
        .map((candidateId) => ({ candidateId }));
    case "refresh_stale":
      return stringList(stateSlice["staleEvidenceIds"])
        .slice(0, maxActions)
        .map((evidenceId) => ({ evidenceId }));
    case "golden_neighbor": {
      const filters =
        primitiveFilters(stateSlice["archetypeFilters"]) ??
        primitiveFilters(agent.seedScope?.candidateFilters) ??
        {};
      return [{ archetypeFilters: filters }];
    }
    case "resolve_domain":
      return stringList(stateSlice["pendingLeadIds"])
        .slice(0, maxActions)
        .map((leadId) => ({ leadId }));
  }
}

// ---------------------------------------------------------------------------
// planTick.
// ---------------------------------------------------------------------------

/**
 * One planning step: goal + state + recent outcomes → validated action
 * batch. Never throws on model misbehavior; worst case returns the
 * deterministic fallback with origin "fallback".
 */
export async function planTick(
  agent: PlannerAgentInput,
  stateSlice: Record<string, unknown>,
  recentTicks: readonly RecentTickSummary[],
  options: PlanTickOptions,
): Promise<AgentPlan> {
  const envelope = planEnvelopeSchema(AGENT_ACTION_SCHEMAS[agent.agentType]);
  const maxActions = Math.min(
    Math.max(1, Math.trunc(options.maxActions ?? MAX_PLAN_ACTIONS)),
    MAX_PLAN_ACTIONS,
  );
  const basePrompt = buildPlannerPrompt({
    agent,
    stateSlice,
    recentTicks,
    maxActions,
  });

  let lastError = "";
  let costUsd = 0;

  // First attempt + exactly one repair retry. Each call uses
  // maxAttempts: 1 so retry policy stays owned here.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prompt =
      attempt === 0
        ? basePrompt
        : `${basePrompt}\n\nREPAIR: your previous reply failed validation (${lastError}). Reply again with exactly one raw JSON object matching the required shape.`;
    try {
      const result = await options.client.generateStructured({
        route: options.route ?? "fast",
        models: options.models,
        schemaName: PLANNER_SCHEMA_NAME,
        schema: envelope,
        systemPrompt: PLANNER_SYSTEM_PROMPT,
        prompt,
        temperature: 0,
        maxOutputTokens: 2_048,
        maxAttempts: 1,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      costUsd += result.telemetry.costUsd ?? 0;
      const data = result.data as PlanEnvelope;
      const actions = data.actions.slice(0, maxActions);
      return {
        agentType: agent.agentType,
        reasoning: data.reasoning,
        actions,
        origin: attempt === 0 ? "llm" : "llm_repaired",
        ...(data.actions.length > actions.length ? { truncated: true } : {}),
        costUsd,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    agentType: agent.agentType,
    reasoning: `Deterministic fallback: planner output unusable (${lastError})`,
    actions: fallbackActions(agent, stateSlice, maxActions),
    origin: "fallback",
    costUsd,
  };
}
