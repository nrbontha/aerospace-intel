/**
 * Unit tests for the agent planner step (REDESIGN_PLAN §1.2 step 3):
 *   - valid LLM plan passes through validated
 *   - malformed output → exactly one repair retry → deterministic fallback
 *   - batch cap enforced (≤10 actions)
 *
 * No DB; global fetch is stubbed so the real OpenRouterClient exercises its
 * parse/repair pipeline against canned envelopes (benchmarks-style fake
 * gateway; ox-alpha ignores json_schema, validation happens client-side).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentType } from "@asi/database";

import {
  AGENT_ACTION_SCHEMAS,
  MAX_PLAN_ACTIONS,
  PLANNER_SCHEMA_NAME,
  buildPlannerPrompt,
  fallbackActions,
  planTick,
} from "../packages/research/src/campaigns/planner-step.js";
import { OpenRouterClient } from "../packages/research/src/openrouter.js";

const models = { fast: "m/fast", deep: "m/deep", fallback: "m/fb" };

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

/** Fake gateway: replays canned contents in order, repeating the last one. */
function gatewayWithContents(contents: string[]) {
  const fetchMock = vi.fn(async () => {
    const index = Math.min(fetchMock.mock.calls.length - 1, contents.length - 1);
    return jsonResponse(openRouterEnvelope(contents[index]!));
  });
  vi.stubGlobal("fetch", fetchMock);
  const client = new OpenRouterClient("test-key");
  return {
    client,
    requestBodies: () =>
      fetchMock.mock.calls.map(
        (call) => JSON.parse(String(call[1]!.body)) as {
          messages: Array<{ role: string; content: string }>;
          response_format?: { json_schema?: { name?: string } };
        },
      ),
  };
}

function makeAgent(agentType: AgentType) {
  return {
    key: `test-${agentType}`,
    agentType,
    goal: `mission for ${agentType}`,
    seedScope: {},
  } as const;
}

const recentTicks = [
  { outcome: "error", error: "fetch timeout" },
  { outcome: "executed", findings: { newLeads: 2 } },
] as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("planner-step action manifests", () => {
  it("covers every registered agent type", () => {
    expect(Object.keys(AGENT_ACTION_SCHEMAS).sort()).toEqual(
      [
        "discover_source",
        "enrich_candidate",
        "monitor_ownership",
        "refresh_stale",
        "golden_neighbor",
        "resolve_domain",
      ].sort(),
    );
  });

  it("rejects cross-type actions (enrich cannot propose queries)", () => {
    const result = AGENT_ACTION_SCHEMAS.enrich_candidate.safeParse({
      query: "jet engine parts",
    });
    expect(result.success).toBe(false);
  });
});

describe("planTick happy path", () => {
  it("passes a valid LLM plan through with provenance and cost", async () => {
    const planJson = JSON.stringify({
      reasoning: "expand usaspending frontier",
      actions: [
        { query: "jet engine parts" },
        { source: "sam" },
        { query: "precision machining" },
      ],
    });
    const { client, requestBodies } = gatewayWithContents([planJson]);

    const plan = await planTick(
      makeAgent("discover_source"),
      { frontierRemaining: 12 },
      recentTicks,
      { client, models },
    );

    expect(plan.origin).toBe("llm");
    expect(plan.truncated).toBeUndefined();
    expect(plan.reasoning).toBe("expand usaspending frontier");
    expect(plan.actions).toEqual([
      { query: "jet engine parts" },
      { source: "sam" },
      { query: "precision machining" },
    ]);
    // One gateway call, planner schema advertised, prompt carries context.
    const bodies = requestBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.response_format?.json_schema?.name).toBe(
      PLANNER_SCHEMA_NAME,
    );
    const userPrompt = bodies[0]!.messages[1]!.content;
    expect(userPrompt).toContain("mission for discover_source");
    expect(userPrompt).toContain('"frontierRemaining":12');
    expect(userPrompt).toContain("outcome=error");
    expect(userPrompt).toContain("findings=");
  });

  it("reports non-zero cost when the gateway charges", async () => {
    const envelope = (cost: number) => ({
      model: "stealth/ox-alpha",
      provider: "openrouter",
      choices: [
        {
          message: {
            content: JSON.stringify({ reasoning: "r", actions: [] }),
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost },
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(envelope(0.0021)), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new OpenRouterClient("test-key");

    const plan = await planTick(makeAgent("enrich_candidate"), {}, [], {
      client,
      models,
    });

    expect(plan.costUsd).toBeCloseTo(0.0021, 6);
  });
});

describe("planTick repair and fallback", () => {
  it("uses one repair retry then falls back without throwing", async () => {
    const { client, requestBodies } = gatewayWithContents([
      "Sorry, I cannot help with that.",
      '{"reasoning": "oops", "actions": [{"companyId": 42}]}',
    ]);

    const plan = await planTick(makeAgent("enrich_candidate"), {}, recentTicks, {
      client,
      models,
    });

    // Exactly two gateway calls; the second is the repair attempt.
    const bodies = requestBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.messages[1]!.content).toContain("REPAIR:");
    expect(bodies[1]!.messages[1]!.content).toContain("failed validation");
    // Deterministic fallback: no queued ids in state → empty batch.
    expect(plan.origin).toBe("fallback");
    expect(plan.actions).toEqual([]);
    expect(plan.agentType).toBe("enrich_candidate");
  });

  it("recovers when the repaired reply validates", async () => {
    const goodPlan = JSON.stringify({
      reasoning: "repaired plan",
      actions: [{ candidateId: "c-1" }, { candidateId: "c-2" }],
    });
    const { client, requestBodies } = gatewayWithContents([
      "```json\nnot even json\n```",
      goodPlan,
    ]);

    const plan = await planTick(makeAgent("monitor_ownership"), {}, [], {
      client,
      models,
    });

    expect(requestBodies()).toHaveLength(2);
    expect(plan.origin).toBe("llm_repaired");
    expect(plan.actions).toEqual([{ candidateId: "c-1" }, { candidateId: "c-2" }]);
  });

  it("falls back to state-slice defaults when both attempts fail", async () => {
    const { client } = gatewayWithContents(["nope", "still nope"]);

    const plan = await planTick(
      makeAgent("refresh_stale"),
      { staleEvidenceIds: ["e-1", "e-2", "e-3"] },
      [],
      { client, models },
    );

    expect(plan.origin).toBe("fallback");
    expect(plan.actions).toEqual([
      { evidenceId: "e-1" },
      { evidenceId: "e-2" },
      { evidenceId: "e-3" },
    ]);
  });

  it("rejects wrong-type LLM actions and falls back deterministically", async () => {
    // discover agent proposes enrich-style actions twice.
    const badPlan = JSON.stringify({
      reasoning: "confused",
      actions: [{ companyId: "c-9" }],
    });
    const { client } = gatewayWithContents([badPlan, badPlan]);

    const plan = await planTick(
      makeAgent("discover_source"),
      { knownSources: ["usaspending"] },
      [],
      { client, models },
    );

    expect(plan.origin).toBe("fallback");
    expect(plan.actions).toEqual([{ source: "usaspending" }]);
  });
});

describe("planTick batch cap", () => {
  it("slices oversized LLM batches to MAX_PLAN_ACTIONS and flags truncation", async () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ query: `q${i}` }));
    const { client } = gatewayWithContents([
      JSON.stringify({ reasoning: "greedy", actions: many }),
    ]);

    const plan = await planTick(makeAgent("discover_source"), {}, [], {
      client,
      models,
    });

    expect(MAX_PLAN_ACTIONS).toBe(10);
    expect(plan.actions).toHaveLength(10);
    expect(plan.truncated).toBe(true);
    expect(plan.actions.at(-1)).toEqual({ query: "q9" });
  });

  it("caps fallback batches when maxActions overrides below the cap", async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `c-${i}`);
    const { client } = gatewayWithContents(["bad", "worse"]);

    const plan = await planTick(
      makeAgent("enrich_candidate"),
      { queuedCompanyIds: ids },
      [],
      { client, models, maxActions: 3 },
    );

    expect(plan.origin).toBe("fallback");
    expect(plan.actions).toEqual([
      { companyId: "c-0" },
      { companyId: "c-1" },
      { companyId: "c-2" },
    ]);
  });
});
