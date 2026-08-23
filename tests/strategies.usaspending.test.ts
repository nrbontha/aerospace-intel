/**
 * Fixture-driven unit suite for the USAspending discovery strategy.
 * No network: the real UsaspendingClient runs with an injected fetchImpl
 * that serves the committed fixtures and a no-op sleep clock.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  USASPENDING_DEFAULT_QUERY_VALUE,
  UsaspendingClient,
  UsaspendingDiscoveryStrategy,
  type FrontierItemView,
} from "@asi/research";

import type { CampaignView } from "../packages/research/src/campaigns/types.js";

async function fetchFixture(name: string): Promise<string> {
  return readFile(
    path.join(process.cwd(), "packages/research/src/sources/fixtures", name),
    "utf8",
  );
}
/** Serves fixture pages; pages beyond the fixtures are empty. */
function makeFixtureFetch() {
  const calls: string[] = [];
  const impl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { page?: number };
    const page = body.page ?? 1;
    calls.push(`page-${page}`);
    const file =
      page === 1
        ? "usaspending-page1.json"
        : page === 2
          ? "usaspending-page2.json"
          : null;
    const payload = file === null ? { results: [] } : JSON.parse(await fetchFixture(file));
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { impl, calls };
}

function makeStrategy(maxPages = 2): {
  strategy: UsaspendingDiscoveryStrategy;
  calls: string[];
} {
  const { impl, calls } = makeFixtureFetch();
  const client = new UsaspendingClient({
    maxPages,
    pageSize: 2,
    requestDelayMs: 0,
    maxRetries: 0,
    fetchImpl: impl,
    sleep: () => Promise.resolve(),
  });
  return {
    strategy: new UsaspendingDiscoveryStrategy({ client }),
    calls,
  };
}

const campaign: CampaignView = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "test",
  objective: null,
  thesisVersion: "v1",
  policyVersion: "v1",
  seeds: { sources: ["usaspending"], platforms: [], capabilities: [], geography: [] },
  excludedSources: [],
  budgetUsd: null,
  spendUsd: 0,
  maxDepth: 3,
  policy: {
    version: "v1",
    enabledSources: ["usaspending"],
    sourcePriorities: {},
    maxDepth: 3,
    maxDocumentsPerCandidate: 5,
    stoppingRules: { stopWhenBudgetExhausted: true },
  },
};

function queryItem(overrides: Partial<FrontierItemView> = {}): FrontierItemView {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    campaignId: campaign.id,
    itemType: "query",
    normalizedValue: "usaspending:aerospace-components-default",
    parentItemId: null,
    discoveryPath: null,
    depth: 1,
    payload: {
      naics: ["336413"],
      psc: ["1560"],
      timePeriod: { startDate: "2025-01-01", endDate: "2025-12-31" },
    },
    ...overrides,
  };
}

describe("UsaspendingDiscoveryStrategy", () => {
  it("expands a usaspending query item into one company proposal per recipient", async () => {
    const { strategy, calls } = makeStrategy();
    const proposals = await strategy.proposeFrontierItems(campaign, queryItem());

    // Fixtures aggregate to 4 distinct recipients across both pages.
    expect(proposals).toHaveLength(4);
    // maxPages=2 bounds pagination at the second fixture page.
    expect(calls).toEqual(["page-1", "page-2"]);
    for (const proposal of proposals) {
      expect(proposal.itemType).toBe("company");
      expect(proposal.estimatedCostUsd).toBe(0);
      expect(proposal.normalizedValue.length).toBeGreaterThan(0);
    }

    const aero = proposals.find((p) => p.normalizedValue === "uei:AAA111111111");
    expect(aero).toBeDefined();
    expect(aero?.payload?.["rawName"]).toBe("Aero Structures Manufacturing Inc");
    expect(aero?.payload?.["awardCount"]).toBe(3);
    expect(Number(aero?.payload?.["totalAwardValueUsd"])).toBeCloseTo(220_500);
    expect(aero?.payload?.["freshestAwardDate"]).toBe("2025-02-20");
    expect(String(aero?.payload?.["sourceLocator"])).toContain("usaspending://");

    // Recipient without UEI falls back to a stable name identity.
    const byName = proposals.find((p) =>
      p.normalizedValue.startsWith("name:"),
    );
    expect(byName).toBeDefined();
  });

  it("is deterministic and idempotent across repeated invocations", async () => {
    const first = await makeStrategy().strategy.proposeFrontierItems(
      campaign,
      queryItem(),
    );
    const second = await makeStrategy().strategy.proposeFrontierItems(
      campaign,
      queryItem(),
    );
    expect(first.map((p) => [p.itemType, p.normalizedValue])).toEqual(
      second.map((p) => [p.itemType, p.normalizedValue]),
    );
    expect(JSON.stringify(first)).toEqual(JSON.stringify(second));
  });

  it("expands a usaspending source item into exactly one default query item", async () => {
    const { strategy } = makeStrategy();
    const proposals = await strategy.proposeFrontierItems(campaign, {
      ...queryItem(),
      itemType: "source",
      normalizedValue: "usaspending",
      payload: {},
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.itemType).toBe("query");
    expect(proposals[0]?.normalizedValue).toBe(USASPENDING_DEFAULT_QUERY_VALUE);
    expect(proposals[0]?.estimatedCostUsd).toBe(0);
    expect(Array.isArray(proposals[0]?.payload?.["naics"])).toBe(true);
    expect(Array.isArray(proposals[0]?.payload?.["psc"])).toBe(true);

    // Re-expansion proposes the same identity — deduped by the runner key.
    const again = await strategy.proposeFrontierItems(campaign, {
      ...queryItem(),
      itemType: "source",
      normalizedValue: "usaspending",
      payload: {},
    });
    expect(again[0]?.normalizedValue).toBe(proposals[0]?.normalizedValue);
  });

  it("ignores items it does not own", async () => {
    const { strategy } = makeStrategy();
    expect(
      await strategy.proposeFrontierItems(campaign, {
        ...queryItem(),
        itemType: "source",
        normalizedValue: "sam_gov",
        payload: {},
      }),
    ).toEqual([]);
    expect(
      await strategy.proposeFrontierItems(campaign, {
        ...queryItem(),
        payload: {},
      }),
    ).toEqual([]);
    expect(
      await strategy.proposeFrontierItems(campaign, {
        ...queryItem(),
        itemType: "company",
        normalizedValue: "some company",
      }),
    ).toEqual([]);
  });
});

/**
 * Live smoke test — opt-in only, bounded to ONE API request:
 *   ASI_LIVE_SOURCES=1 npx vitest run tests/strategies.usaspending.test.ts
 */
describe.skipIf(process.env.ASI_LIVE_SOURCES !== "1")(
  "UsaspendingDiscoveryStrategy (live)",
  () => {
    it("fetches real recipients with a single bounded page", async () => {
      const client = new UsaspendingClient({
        maxPages: 1,
        pageSize: 25,
        requestDelayMs: 0,
        maxRetries: 0,
      });
      const strategy = new UsaspendingDiscoveryStrategy({ client });
      const proposals = await strategy.proposeFrontierItems(campaign, {
        ...queryItem(),
        payload: { naics: ["336413"], timePeriod: undefined },
      });
      expect(proposals.length).toBeGreaterThan(0);
      for (const proposal of proposals) {
        expect(proposal.itemType).toBe("company");
        expect(proposal.payload?.["sourceLocator"]).toMatch(/^usaspending:\/\//);
      }
    });
  },
);
