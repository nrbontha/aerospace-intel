import { afterEach, describe, expect, it, vi } from "vitest";

const accountingMocks = vi.hoisted(() => ({
  readResearchProviderUsageReceipt: vi.fn(),
  reconcileResearchProviderUsage: vi.fn(),
  reserveResearchProviderUsage: vi.fn(),
  settleResearchProviderUsage: vi.fn(),
}));

vi.mock("@asi/database", () => accountingMocks);

import {
  executeAccountedOpenRouterRequest,
  openRouterKeyFingerprint,
  reconcileOpenRouterGenerationCost,
} from "../packages/research/src/openrouter-budget.js";

const KEY = "test-openrouter-key";
const KEY_FINGERPRINT = openRouterKeyFingerprint(KEY);
const RECEIPT_ID = "4d6174ba-9132-4ff8-8ef0-df276f43761e";

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    id: RECEIPT_ID,
    provider: "openrouter",
    estimatedCostUsd: "0.106",
    actualCostUsd: null,
    providerGenerationId: "gen-attributable",
    providerKeyFingerprint: KEY_FINGERPRINT,
    providerCostVerifiedAt: null,
    ...overrides,
  };
}

describe("OpenRouter receipt accounting", () => {
  const originalScope = process.env.OPENROUTER_BUDGET_SCOPE_ID;

  afterEach(() => {
    accountingMocks.readResearchProviderUsageReceipt.mockReset();
    accountingMocks.reconcileResearchProviderUsage.mockReset();
    accountingMocks.reserveResearchProviderUsage.mockReset();
    accountingMocks.settleResearchProviderUsage.mockReset();
    if (originalScope === undefined) {
      delete process.env.OPENROUTER_BUDGET_SCOPE_ID;
    } else {
      process.env.OPENROUTER_BUDGET_SCOPE_ID = originalScope;
    }
  });

  it("retains a known provider charge before later model-payload validation", async () => {
    process.env.OPENROUTER_BUDGET_SCOPE_ID = "test-scope";
    accountingMocks.reserveResearchProviderUsage.mockResolvedValue({
      outcome: "reserved",
      reused: false,
      reservation: receipt(),
    });
    accountingMocks.settleResearchProviderUsage.mockImplementation(
      async (_db, _id, input) => ({ ...receipt(), ...input }),
    );

    const result = await executeAccountedOpenRouterRequest(
      {
        context: {
          db: {} as never,
          sourceSignalId: "d04b6fe4-853f-48ed-9b70-3d269537ceef",
        },
        operation: "openrouter_muse_structured",
        requestBody: { model: "test/model" },
        prompt: "test",
        estimatedCostUsd: "0.106",
        providerKeyFingerprint: KEY_FINGERPRINT,
      },
      async () =>
        new Response(
          JSON.stringify({
            id: "gen-attributable",
            choices: [],
            usage: { cost: "0.001234567" },
          }),
          {
            status: 200,
            headers: { "x-generation-id": "gen-attributable" },
          },
        ),
      async (response) => response.text(),
    );

    expect(result.accounting.providerCostUsd).toBe("0.001234567");
    expect(accountingMocks.settleResearchProviderUsage).toHaveBeenCalledWith(
      expect.anything(),
      RECEIPT_ID,
      expect.objectContaining({
        actualCostUsd: "0.001234567",
        providerReceipt: {
          providerGenerationId: "gen-attributable",
          providerKeyFingerprint: KEY_FINGERPRINT,
          providerHttpStatus: 200,
        },
      }),
    );
  });

  it("persists header identity, status, and key fingerprint when body reading fails", async () => {
    process.env.OPENROUTER_BUDGET_SCOPE_ID = "test-scope";
    accountingMocks.reserveResearchProviderUsage.mockResolvedValue({
      outcome: "reserved",
      reused: false,
      reservation: receipt(),
    });
    accountingMocks.settleResearchProviderUsage.mockImplementation(
      async (_db, _id, input) => ({ ...receipt(), ...input }),
    );

    await expect(
      executeAccountedOpenRouterRequest(
        {
          context: {
            db: {} as never,
            sourceSignalId: "d04b6fe4-853f-48ed-9b70-3d269537ceef",
          },
          operation: "openrouter_muse_structured",
          requestBody: { model: "test/model" },
          prompt: "test",
          estimatedCostUsd: "0.106",
          providerKeyFingerprint: KEY_FINGERPRINT,
        },
        async () =>
          new Response(null, {
            status: 503,
            headers: { "x-generation-id": "gen-attributable" },
          }),
        async () => {
          throw new Error("body interrupted");
        },
      ),
    ).rejects.toThrow("body interrupted");

    expect(accountingMocks.settleResearchProviderUsage).toHaveBeenCalledWith(
      expect.anything(),
      RECEIPT_ID,
      expect.objectContaining({
        actualCostUsd: null,
        providerReceipt: {
          providerGenerationId: "gen-attributable",
          providerKeyFingerprint: KEY_FINGERPRINT,
          providerHttpStatus: 503,
        },
      }),
    );
  });

  it("holds a generation response with invalid total_cost instead of using usage", async () => {
    accountingMocks.readResearchProviderUsageReceipt.mockResolvedValue(
      receipt(),
    );

    const result = await reconcileOpenRouterGenerationCost({
      db: {} as never,
      reservationId: RECEIPT_ID,
      apiKey: KEY,
      fetch: async () =>
        new Response(
          JSON.stringify({
            data: {
              id: "gen-attributable",
              total_cost: "not-a-decimal",
              usage: "0.001",
            },
          }),
          { status: 200 },
        ),
    });

    expect(result).toMatchObject({
      outcome: "held",
      reason: "provider_cost_invalid",
      providerHttpStatus: 200,
    });
    expect(
      accountingMocks.reconcileResearchProviderUsage,
    ).not.toHaveBeenCalled();
  });

  it("holds a returned generation that conflicts with the persisted identity", async () => {
    accountingMocks.readResearchProviderUsageReceipt.mockResolvedValue(
      receipt(),
    );

    const result = await reconcileOpenRouterGenerationCost({
      db: {} as never,
      reservationId: RECEIPT_ID,
      apiKey: KEY,
      fetch: async () =>
        new Response(
          JSON.stringify({
            data: {
              id: "gen-different",
              total_cost: "0.001",
            },
          }),
          { status: 200 },
        ),
    });

    expect(result).toMatchObject({
      outcome: "held",
      reason: "provider_identity_conflict",
      providerHttpStatus: 200,
    });
    expect(
      accountingMocks.reconcileResearchProviderUsage,
    ).not.toHaveBeenCalled();
  });

  it("holds raw generation costs whose decimal tokens differ", async () => {
    accountingMocks.readResearchProviderUsageReceipt.mockResolvedValue(
      receipt(),
    );

    const result = await reconcileOpenRouterGenerationCost({
      db: {} as never,
      reservationId: RECEIPT_ID,
      apiKey: KEY,
      fetch: async () =>
        new Response(
          '{"data":{"id":"gen-attributable","total_cost":0.00100000000000000002,"usage":0.001}}',
          { status: 200 },
        ),
    });

    expect(result).toMatchObject({
      outcome: "held",
      reason: "provider_cost_conflict",
      providerHttpStatus: 200,
    });
    expect(
      accountingMocks.reconcileResearchProviderUsage,
    ).not.toHaveBeenCalled();
  });

  it("reconciles equivalent raw generation decimal forms", async () => {
    accountingMocks.readResearchProviderUsageReceipt.mockResolvedValue(
      receipt(),
    );
    accountingMocks.reconcileResearchProviderUsage.mockResolvedValue({
      outcome: "reconciled",
      receipt: receipt({ actualCostUsd: "0.001" }),
    });

    const result = await reconcileOpenRouterGenerationCost({
      db: {} as never,
      reservationId: RECEIPT_ID,
      apiKey: KEY,
      fetch: async () =>
        new Response(
          '{"data":{"id":"gen-attributable","total_cost":0.0010,"usage":0.001}}',
          { status: 200 },
        ),
    });

    expect(result).toMatchObject({
      outcome: "reconciled",
      providerHttpStatus: 200,
    });
    expect(accountingMocks.reconcileResearchProviderUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actualCostUsd: "0.001" }),
    );
  });

  it("holds high-precision exponent costs that differ", async () => {
    accountingMocks.readResearchProviderUsageReceipt.mockResolvedValue(
      receipt(),
    );

    const result = await reconcileOpenRouterGenerationCost({
      db: {} as never,
      reservationId: RECEIPT_ID,
      apiKey: KEY,
      fetch: async () =>
        new Response(
          '{"data":{"id":"gen-attributable","total_cost":1.00000000000000002e-3,"usage":0.001}}',
          { status: 200 },
        ),
    });

    expect(result).toMatchObject({
      outcome: "held",
      reason: "provider_cost_conflict",
      providerHttpStatus: 200,
    });
    expect(
      accountingMocks.reconcileResearchProviderUsage,
    ).not.toHaveBeenCalled();
  });

  it("reconciles matching exponent costs without rounding them", async () => {
    accountingMocks.readResearchProviderUsageReceipt.mockResolvedValue(
      receipt(),
    );
    accountingMocks.reconcileResearchProviderUsage.mockResolvedValue({
      outcome: "reconciled",
      receipt: receipt({ actualCostUsd: "0.00100000000000000002" }),
    });

    const result = await reconcileOpenRouterGenerationCost({
      db: {} as never,
      reservationId: RECEIPT_ID,
      apiKey: KEY,
      fetch: async () =>
        new Response(
          '{"data":{"id":"gen-attributable","total_cost":1.00000000000000002e-3,"usage":1.00000000000000002e-3}}',
          { status: 200 },
        ),
    });

    expect(result).toMatchObject({
      outcome: "reconciled",
      providerHttpStatus: 200,
    });
    expect(accountingMocks.reconcileResearchProviderUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actualCostUsd: "0.00100000000000000002",
      }),
    );
  });
});
