import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET, getSourceSignalOverview } from "./route.js";
const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  agentFrontierProgress: vi.fn(),
  listAgents: vi.fn(),
  requireUser: vi.fn(),
  getFindsTodayByAgentId: vi.fn(),
  getGlobalSpendTodayUsd: vi.fn(),
  getLastFind: vi.fn(),
  getOpenProposalCount: vi.fn(),
}));

vi.mock("@asi/database", () => ({
  agentFrontierProgress: (...args: unknown[]) =>
    mocks.agentFrontierProgress(...args),
  listAgents: (...args: unknown[]) => mocks.listAgents(...args),
}));

vi.mock("@asi/database/client", () => ({
  getDatabase: () => ({ execute: mocks.execute }),
}));

vi.mock("@/lib/auth", () => ({
  requireUser: (...args: unknown[]) => mocks.requireUser(...args),
}));

vi.mock("@/app/api/v1/agents/shared", () => ({
  dailyBudgetCapUsd: () => 1,
  getFindsTodayByAgentId: (...args: unknown[]) => mocks.getFindsTodayByAgentId(...args),
  getGlobalSpendTodayUsd: (...args: unknown[]) => mocks.getGlobalSpendTodayUsd(...args),
  getLastFind: (...args: unknown[]) => mocks.getLastFind(...args),
  getOpenProposalCount: (...args: unknown[]) => mocks.getOpenProposalCount(...args),
  handleAgentRouteError: (error: unknown) => {
    throw error;
  },
  iso: (value: Date | string | null) => (value === null ? null : new Date(value).toISOString()),
}));


beforeEach(() => {
  mocks.execute.mockReset();
  mocks.agentFrontierProgress.mockReset().mockResolvedValue({
    total: 0,
    pending: 0,
    inProgress: 0,
    completed: 0,
    failed: 0,
    pendingMonths: [],
    completedMonths: [],
    currentMonth: null,
    currentPage: null,
    currentCursor: null,
    lastAttemptAt: null,
  });
  mocks.listAgents.mockReset().mockResolvedValue([]);
  mocks.requireUser.mockReset().mockResolvedValue({ id: "user" });
  mocks.getFindsTodayByAgentId.mockReset().mockResolvedValue(new Map());
  mocks.getGlobalSpendTodayUsd.mockReset().mockResolvedValue(0);
  mocks.getLastFind.mockReset().mockResolvedValue(null);
  mocks.getOpenProposalCount.mockReset().mockResolvedValue(0);
});

describe("source-signal overview aggregate", () => {
  it("is zero-safe when source_signals has no rows", async () => {
    mocks.execute.mockResolvedValue({ rows: [] });

    await expect(getSourceSignalOverview(new Date("2026-08-24T12:00:00.000Z"))).resolves.toEqual({
      queuedQualification: 0,
      qualifying: 0,
      qualifiedToday: 0,
      rejectedToday: 0,
      quarantined: 0,
      latestQualification: null,
    });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it("returns source signal status counts and latest qualification", async () => {
    mocks.execute.mockResolvedValue({
      rows: [
        {
          queued_qualification: "7",
          qualifying: 2,
          qualified_today: "3",
          rejected_today: "4",
          quarantined: "5",
          latest_qualification: "2026-08-24T11:30:00.000Z",
        },
      ],
    });

    await expect(getSourceSignalOverview()).resolves.toEqual({
      queuedQualification: 7,
      qualifying: 2,
      qualifiedToday: 3,
      rejectedToday: 4,
      quarantined: 5,
      latestQualification: "2026-08-24T11:30:00.000Z",
    });
  });

  it("serves the aggregate with the research overview", async () => {
    mocks.execute.mockResolvedValue({
      rows: [
        {
          queued_qualification: 1,
          qualifying: 0,
          qualified_today: 2,
          rejected_today: 3,
          quarantined: 4,
          latest_qualification: null,
        },
      ],
    });

    const response = await GET(new Request("http://localhost/api/v1/agents/overview") as never);

    await expect(response.json()).resolves.toMatchObject({
      data: {
        sourceSignals: {
          queuedQualification: 1,
          qualifiedToday: 2,
          rejectedToday: 3,
          quarantined: 4,
          latestQualification: null,
        },
        usaSpendingCrawl: {
          totalWindows: 0,
          pendingWindows: 0,
          inProgressWindows: 0,
          completedWindows: 0,
          failedWindows: 0,
          currentMonth: null,
          currentPage: null,
          lastAttemptAt: null,
        },
      },
    });
    expect(mocks.agentFrontierProgress).not.toHaveBeenCalled();
  });
});

describe("USAspending crawl overview", () => {
  it("serves active month and page progress from the agent-owned frontier", async () => {
    mocks.execute.mockResolvedValue({ rows: [] });
    mocks.listAgents.mockResolvedValue([
      {
        agent: {
          id: "11111111-1111-4111-8111-111111111111",
          key: "discover-usaspending",
          status: "running",
        },
      },
    ]);
    mocks.agentFrontierProgress.mockResolvedValue({
      total: 12,
      pending: 7,
      inProgress: 1,
      completed: 4,
      failed: 0,
      currentMonth: "2026-04",
      currentPage: 3,
      lastAttemptAt: "2026-08-24T11:45:00.000Z",
    });

    const response = await GET(
      new Request("http://localhost/api/v1/agents/overview") as never,
    );

    await expect(response.json()).resolves.toMatchObject({
      data: {
        usaSpendingCrawl: {
          totalWindows: 12,
          pendingWindows: 7,
          inProgressWindows: 1,
          completedWindows: 4,
          failedWindows: 0,
          currentMonth: "2026-04",
          currentPage: 3,
          lastAttemptAt: "2026-08-24T11:45:00.000Z",
        },
      },
    });
    expect(mocks.agentFrontierProgress).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
    );
  });
  it("serves failed windows without losing the next pending cursor", async () => {
    mocks.execute.mockResolvedValue({ rows: [] });
    mocks.listAgents.mockResolvedValue([
      {
        agent: {
          id: "11111111-1111-4111-8111-111111111111",
          key: "discover-usaspending",
          status: "running",
        },
      },
    ]);
    mocks.agentFrontierProgress.mockResolvedValue({
      total: 12,
      pending: 2,
      inProgress: 0,
      completed: 9,
      failed: 1,
      currentMonth: "2026-11",
      currentPage: 1,
      lastAttemptAt: "2026-08-24T12:00:00.000Z",
    });

    const response = await GET(
      new Request("http://localhost/api/v1/agents/overview") as never,
    );

    await expect(response.json()).resolves.toMatchObject({
      data: {
        usaSpendingCrawl: {
          totalWindows: 12,
          pendingWindows: 2,
          inProgressWindows: 0,
          completedWindows: 9,
          failedWindows: 1,
          currentMonth: "2026-11",
          currentPage: 1,
          lastAttemptAt: "2026-08-24T12:00:00.000Z",
        },
      },
    });
  });
});
