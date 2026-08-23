/**
 * Unit tests for the candidate status route transition policy (Inv-B2):
 * `queued_research` is now an accepted manual target ("Needs More
 * Research"); other research-lifecycle statuses remain engine-routed.
 *
 *   npx vitest run tests/candidate-status-route.unit.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const updateCandidateStatus = vi.fn();
const requireRole = vi.fn();

vi.mock("@asi/database", () => ({
  getDatabase: () => ({}),
  updateCandidateStatus: (...args: unknown[]) => updateCandidateStatus(...args),
}));
vi.mock("@/lib/auth", () => ({
  requireRole: (...args: unknown[]) => requireRole(...args),
  verifyCsrfRequest: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rbac", () => ({
  AuthorizationError: class AuthorizationError extends Error {
    status: number;
    constructor(message: string, status = 403) {
      super(message);
      this.status = status;
    }
  },
}));

const { PATCH } = await import(
  "../apps/web/src/app/api/v1/candidates/[id]/status/route.js"
);

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";

function patchRequest(status: unknown): {
  request: Request;
  context: { params: Promise<{ id: string }> };
} {
  const request = new Request(
    `http://localhost/api/v1/candidates/${CANDIDATE_ID}/status`,
    {
      method: "PATCH",
      body: JSON.stringify({ status }),
      headers: { "content-type": "application/json" },
    },
  );
  return { request, context: { params: Promise.resolve({ id: CANDIDATE_ID }) } };
}

describe("candidate status route (manual transitions)", () => {
  beforeEach(() => {
    updateCandidateStatus.mockReset();
    requireRole.mockReset().mockResolvedValue({ id: ACTOR_ID });
    updateCandidateStatus.mockResolvedValue({ id: CANDIDATE_ID, status: "queued_research" });
  });

  it("accepts queued_research as a manual target (Needs More Research)", async () => {
    const { request, context } = patchRequest("queued_research");
    const response = await PATCH(request, context);
    expect(response.status).toBe(200);
    expect(updateCandidateStatus).toHaveBeenCalledWith(
      expect.anything(),
      { candidateId: CANDIDATE_ID, status: "queued_research", actor: ACTOR_ID },
    );
    const body = await response.json();
    expect(body.data.status).toBe("queued_research");
  });

  it("still accepts the four bookkeeping targets", async () => {
    updateCandidateStatus.mockResolvedValue({ id: CANDIDATE_ID, status: "shortlist" });
    const { request, context } = patchRequest("shortlist");
    const response = await PATCH(request, context);
    expect(response.status).toBe(200);
    expect(updateCandidateStatus).toHaveBeenCalledWith(
      expect.anything(),
      { candidateId: CANDIDATE_ID, status: "shortlist", actor: ACTOR_ID },
    );
  });

  it("rejects engine-routed statuses like in_research", async () => {
    const { request, context } = patchRequest("in_research");
    const response = await PATCH(request, context);
    expect(response.status).toBe(400);
    expect(updateCandidateStatus).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body.error.code).toBe("validation_failed");
  });

  it("rejects watchlist with a pointer at the allowed set", async () => {
    const { request, context } = patchRequest("watchlist");
    const response = await PATCH(request, context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(JSON.stringify(body.error)).toContain("queued_research");
  });

  it("rejects invalid statuses", async () => {
    const { request, context } = patchRequest("bogus_status");
    const response = await PATCH(request, context);
    expect(response.status).toBe(400);
    expect(updateCandidateStatus).not.toHaveBeenCalled();
  });
});
