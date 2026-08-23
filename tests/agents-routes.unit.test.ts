/**
 * Unit tests for the agent control-plane role gates and request validation
 * (REDESIGN_PLAN §1.4). No database access: every DB touch fails loudly, so
 * these tests prove auth/validation happens BEFORE any persistence work.
 *
 *   npx vitest run tests/agents-routes.unit.test.ts
 *
 * Audit-write behavior is covered by the DB-gated suite
 * (tests/agents-routes.db.test.ts, ASI_DB_TESTS=1).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthorizationError } from "../apps/web/src/lib/rbac";

const requireRole = vi.fn();
const requireUser = vi.fn();

vi.mock("@/lib/auth", () => ({
  requireRole: (...args: unknown[]) => requireRole(...args),
  requireUser: (...args: unknown[]) => requireUser(...args),
  verifyCsrfRequest: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@asi/database", () => ({
  auditEvents: {},
  agentTicks: {},
  listAgents: vi.fn(),
  researchAgents: {},
}));

vi.mock("@asi/database/client", () => ({
  getDatabase: () => {
    throw new Error("DB access is not allowed in unit tests");
  },
}));

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";

const { POST: postAgents } = await import(
  "../apps/web/src/app/api/v1/agents/route.js"
);
const { PATCH: patchAgent } = await import(
  "../apps/web/src/app/api/v1/agents/[id]/route.js"
);
const { POST: pauseAgent } = await import(
  "../apps/web/src/app/api/v1/agents/[id]/pause/route.js"
);
const { POST: resumeAgent } = await import(
  "../apps/web/src/app/api/v1/agents/[id]/resume/route.js"
);
const { POST: killAgent } = await import(
  "../apps/web/src/app/api/v1/agents/[id]/kill/route.js"
);

function jsonRequest(
  url: string,
  method: string,
  body?: unknown,
): { request: Request; context: { params: Promise<{ id: string }> } } {
  const request = new Request(url, {
    method,
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }),
  });
  return { request, context: { params: Promise.resolve({ id: AGENT_ID }) } };
}

describe("agent control-plane role gates", () => {
  beforeEach(() => {
    requireRole.mockReset();
    requireUser.mockReset().mockResolvedValue({ id: ACTOR_ID });
  });

  it("rejects an unauthenticated registration with 401", async () => {
    requireRole.mockRejectedValue(
      new AuthorizationError(401, "UNAUTHORIZED", "Sign in required"),
    );
    const { request } = jsonRequest(
      "http://localhost/api/v1/agents",
      "POST",
      {},
    );
    const response = await postAgents(request);
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("unauthorized");
  });

  it("rejects analyst registration with 403 (admin only)", async () => {
    requireRole.mockRejectedValue(new AuthorizationError(403, "FORBIDDEN", ""));
    const { request } = jsonRequest("http://localhost/api/v1/agents", "POST", {
      key: "test-agent",
      name: "Test",
      agentType: "discover_source",
      goal: "goal",
    });
    const response = await postAgents(request);
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("forbidden");
  });

  it("rejects analyst PATCH with 403 (admin only)", async () => {
    requireRole.mockRejectedValue(new AuthorizationError(403, "FORBIDDEN", ""));
    const { request, context } = jsonRequest(
      `http://localhost/api/v1/agents/${AGENT_ID}`,
      "PATCH",
      { cadenceSeconds: 60 },
    );
    const response = await patchAgent(request, context);
    expect(response.status).toBe(403);
  });

  it.each([pauseAgent, resumeAgent])(
    "rejects viewer %p with 403 (analyst/admin)",
    async (handler: (request: Request, context: unknown) => Promise<Response>) => {
      requireRole.mockRejectedValue(new AuthorizationError(403, "FORBIDDEN", ""));
      const { request, context } = jsonRequest(
        `http://localhost/api/v1/agents/${AGENT_ID}/pause`,
        "POST",
      );
      const response = await handler(request, context);
      expect(response.status).toBe(403);
    },
  );

  it("rejects analyst kill with 403 (admin only)", async () => {
    requireRole.mockRejectedValue(new AuthorizationError(403, "FORBIDDEN", ""));
    const { request, context } = jsonRequest(
      `http://localhost/api/v1/agents/${AGENT_ID}/kill`,
      "POST",
      { reason: "because" },
    );
    const response = await killAgent(request, context);
    expect(response.status).toBe(403);
  });

  it("requires a non-empty reason for kill even for admins", async () => {
    requireRole.mockResolvedValue({ id: ACTOR_ID });
    for (const body of [undefined, {}, { reason: "" }, { reason: "   " }]) {
      const { request, context } = jsonRequest(
        `http://localhost/api/v1/agents/${AGENT_ID}/kill`,
        "POST",
        body,
      );
      const response = await killAgent(request, context);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("validation_failed");
    }
  });

  it("rejects malformed agent ids with 400 before any DB access", async () => {
    requireRole.mockResolvedValue({ id: ACTOR_ID });
    const request = new Request(
      `http://localhost/api/v1/agents/${AGENT_ID}/pause`,
      { method: "POST" },
    );
    const response = await pauseAgent(request, {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation_failed");
  });

  it("rejects PATCH that tries to change status directly", async () => {
    requireRole.mockResolvedValue({ id: ACTOR_ID });
    const { request, context } = jsonRequest(
      `http://localhost/api/v1/agents/${AGENT_ID}`,
      "PATCH",
      { status: "running" },
    );
    const response = await patchAgent(request, context);
    expect(response.status).toBe(400);
    const error = (await response.json()).error;
    expect(JSON.stringify(error)).toContain("/pause");
  });
});
