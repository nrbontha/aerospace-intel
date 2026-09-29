import { randomUUID } from "node:crypto";
import { z } from "zod";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Database, ResearchProviderUsageReceipt } from "@asi/database";
import {
  reserveResearchProviderUsage,
  settleResearchProviderUsage,
} from "@asi/database";

import {
  OpenRouterBudgetDeferredError,
  openRouterCostUsd,
  openRouterEnvelopeCostUsd,
} from "./openrouter-budget.js";
import { OpenRouterClient } from "./openrouter.js";
import { callJev } from "./faa-ensemble/jev.js";

vi.mock("@asi/database", () => ({
  reserveResearchProviderUsage: vi.fn(),
  settleResearchProviderUsage: vi.fn(),
}));

const reserve = vi.mocked(reserveResearchProviderUsage);
const settle = vi.mocked(settleResearchProviderUsage);
const originalScope = process.env.OPENROUTER_BUDGET_SCOPE_ID;

function receipt(): ResearchProviderUsageReceipt {
  return { id: randomUUID() } as ResearchProviderUsageReceipt;
}

afterEach(() => {
  if (originalScope === undefined) delete process.env.OPENROUTER_BUDGET_SCOPE_ID;
  else process.env.OPENROUTER_BUDGET_SCOPE_ID = originalScope;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("scoped OpenRouter transport", () => {
  it("rejects a structured call without source accounting before the network", async () => {
    process.env.OPENROUTER_BUDGET_SCOPE_ID = "funded-muse";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new OpenRouterClient("test-key");

    await expect(
      client.generateStructured({
        route: "fast",
        models: {
          fast: "meta/muse-spark-1.3-contributor",
          deep: "meta/muse-spark-1.3-contributor",
          fallback: "meta/muse-spark-1.3-contributor",
        },
        schemaName: "result",
        schema: z.object({ answer: z.string() }),
        systemPrompt: "Return JSON.",
        prompt: "Question",
        maxAttempts: 1,
        maxOutputTokens: 4_096,
      }),
    ).rejects.toBeInstanceOf(OpenRouterBudgetDeferredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("settles known envelope cost before reporting invalid structured output", async () => {
    process.env.OPENROUTER_BUDGET_SCOPE_ID = "funded-muse";
    const reserved = receipt();
    reserve.mockResolvedValue({
      outcome: "reserved",
      reused: false,
      reservation: reserved,
    });
    settle.mockResolvedValue(reserved);
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          model: "meta/muse-spark-1.3-contributor",
          choices: [{ message: { content: "not JSON" } }],
          usage: { cost: "0.00042" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new OpenRouterClient("test-key");
    const context = {
      db: {} as Database,
      sourceSignalId: randomUUID(),
    };

    await expect(
      client.generateStructured({
        route: "fast",
        models: {
          fast: "meta/muse-spark-1.3-contributor",
          deep: "meta/muse-spark-1.3-contributor",
          fallback: "meta/muse-spark-1.3-contributor",
        },
        schemaName: "result",
        schema: z.object({ answer: z.string() }),
        systemPrompt: "Return JSON.",
        prompt: "Question",
        maxAttempts: 1,
        maxOutputTokens: 4_096,
        accounting: context,
      }),
    ).rejects.toMatchObject({
      code: "invalid_structured_output",
      accounting: {
        providerCostUsd: "0.00042",
      },
    });
    expect(reserve.mock.invocationCallOrder[0]).toBeLessThan(
      fetchMock.mock.invocationCallOrder[0]!,
    );
  });

  it("pins funded Jev to one non-retried reviewed attempt before the network", async () => {
    process.env.OPENROUTER_BUDGET_SCOPE_ID = "funded-jev";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      callJev(
        "test-key",
        {},
        { disposition: { type: "choice" } },
        {
          model: "typesafe/jev-1.13",
          maxRetries: 1,
          accounting: {
            db: {} as Database,
            sourceSignalId: randomUUID(),
          },
        },
      ),
    ).rejects.toMatchObject({ code: "configuration_error" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps malformed provider cost unknown without rounding tiny finite values", () => {
    expect(openRouterEnvelopeCostUsd('{"usage":{"cost":"unknown"}}')).toBeNull();
    expect(openRouterEnvelopeCostUsd('{"usage":{"cost":"0.0100"}}')).toBe("0.01");
    expect(openRouterCostUsd(1e-21)).toBe("0.000000000000000000001");
  });
});
