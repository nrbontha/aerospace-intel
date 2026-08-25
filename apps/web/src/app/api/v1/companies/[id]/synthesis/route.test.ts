import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthorizationError } from "@/lib/rbac";

const mocks = vi.hoisted(() => {
  class StaleGroupError extends Error {
    readonly code = "SYNTHESIS_GROUP_STALE";
    constructor(
      readonly expectedObservationIds: readonly string[],
      readonly currentObservationIds: readonly string[],
    ) {
      super("Synthesis group changed since it was loaded; no proposals were accepted");
    }
  }
  class PreconditionError extends Error {
    readonly code = "SYNTHESIS_PRECONDITION_FAILED";
  }
  return {
    accept: vi.fn(),
    reject: vi.fn(),
    getTrail: vi.fn(),
    requireUser: vi.fn(),
    requireRole: vi.fn(),
    verifyCsrf: vi.fn(),
    database: {},
    StaleGroupError,
    PreconditionError,
  };
});

vi.mock("@asi/database", () => ({
  acceptSynthesisGroup: (...args: unknown[]) => mocks.accept(...args),
  rejectSynthesisGroup: (...args: unknown[]) => mocks.reject(...args),
  getCompanySynthesisTrail: (...args: unknown[]) => mocks.getTrail(...args),
  getDatabase: () => mocks.database,
  SynthesisStaleGroupError: mocks.StaleGroupError,
  SynthesisPreconditionError: mocks.PreconditionError,
}));

vi.mock("@/lib/auth", () => ({
  requireUser: (...args: unknown[]) => mocks.requireUser(...args),
  requireRole: (...args: unknown[]) => mocks.requireRole(...args),
  verifyCsrfRequest: (...args: unknown[]) => mocks.verifyCsrf(...args),
}));

import { GET, POST } from "./route.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const sourceDocumentId = "22222222-2222-4222-8222-222222222222";
const observationId = "33333333-3333-4333-8333-333333333333";
const context = { params: Promise.resolve({ id: companyId }) };

function post(action: "accept" | "reject"): Request {
  return new Request(`http://localhost/api/v1/companies/${companyId}/synthesis`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action,
      sourceDocumentId,
      expectedObservationIds: [observationId],
      ...(action === "reject" ? { reason: "Record does not identify this holder" } : {}),
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({ id: "viewer", role: "viewer" });
  mocks.requireRole.mockResolvedValue({ id: "analyst", role: "analyst" });
  mocks.verifyCsrf.mockResolvedValue(undefined);
  mocks.getTrail.mockResolvedValue({
    company: { id: companyId, name: "Acme" },
    identifiers: [],
    facilities: [],
    sourceRecords: [],
    qualifications: [],
    conflicts: [],
    gaps: [],
    confidence: { sourceCount: 0, primarySourceCount: 0, conflictCount: 0 },
  });
  mocks.accept.mockResolvedValue({ acceptedProposalCount: 1, observationIds: [observationId] });
  mocks.reject.mockResolvedValue({ rejectedProposalCount: 1, observationIds: [observationId] });
});

describe("company synthesis route", () => {
  it("allows a viewer to read the trail", async () => {
    const response = await GET(new Request("http://localhost") as never, context);

    expect(response.status).toBe(200);
    expect(mocks.requireUser).toHaveBeenCalledOnce();
    expect(mocks.getTrail).toHaveBeenCalledWith(companyId);
  });

  it("requires analyst or admin authorization before review", async () => {
    mocks.requireRole.mockRejectedValue(
      new AuthorizationError(403, "FORBIDDEN", "Insufficient role"),
    );

    const response = await POST(post("accept") as never, context);

    expect(response.status).toBe(403);
    expect(mocks.verifyCsrf).not.toHaveBeenCalled();
    expect(mocks.accept).not.toHaveBeenCalled();
  });

  it("accepts the complete expected source group after CSRF verification", async () => {
    const response = await POST(post("accept") as never, context);

    expect(response.status).toBe(200);
    expect(mocks.requireRole).toHaveBeenCalledWith("analyst", "admin");
    expect(mocks.verifyCsrf).toHaveBeenCalledOnce();
    expect(mocks.accept).toHaveBeenCalledWith(mocks.database, {
      companyId,
      sourceDocumentId,
      reviewerId: "analyst",
      expectedObservationIds: [observationId],
    });
    expect(mocks.reject).not.toHaveBeenCalled();
  });

  it("maps a stale accept compare to 409 with the current observation ids", async () => {
    const currentId = "44444444-4444-4444-8444-444444444444";
    mocks.accept.mockRejectedValue(
      new mocks.StaleGroupError([observationId], [currentId]),
    );

    const response = await POST(post("accept") as never, context);
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({
      error: {
        code: "conflict",
        details: {
          code: "SYNTHESIS_GROUP_STALE",
          expectedObservationIds: [observationId],
          currentObservationIds: [currentId],
        },
      },
    });
  });

  it("rejects the complete pending group with its reason", async () => {
    const response = await POST(post("reject") as never, context);

    expect(response.status).toBe(200);
    expect(mocks.reject).toHaveBeenCalledWith(mocks.database, {
      companyId,
      sourceDocumentId,
      reviewerId: "analyst",
      expectedObservationIds: [observationId],
      reason: "Record does not identify this holder",
    });
    expect(mocks.accept).not.toHaveBeenCalled();
  });
});
