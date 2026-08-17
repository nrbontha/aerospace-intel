import {
  getResearchProposalRecord,
  RepositoryConflictError,
  RepositoryNotFoundError,
  reviewResearchProposalRecord,
} from "@asi/database";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { jsonError, jsonSuccess } from "@/lib/api";
import { requireRole, requireUser, verifyCsrfRequest } from "@/lib/auth";
import { AuthorizationError } from "@/lib/rbac";

const reasonSchema = z.string().trim().min(1).max(10_000);
const reviewSchema = z.discriminatedUnion("decision", [
  z.strictObject({
    decision: z.literal("accept"),
    reason: reasonSchema.optional(),
  }),
  z.strictObject({
    decision: z.literal("reject"),
    reason: reasonSchema,
  }),
  z.strictObject({
    decision: z.literal("edit_and_accept"),
    reason: reasonSchema,
    editedValue: z.json(),
  }),
]);
const routeIdSchema = z.uuid();
type RouteContext = { params: Promise<{ id: string }> };

function handleError(error: unknown): Response {
  if (error instanceof AuthorizationError) {
    return jsonError(
      error.status === 401 ? "unauthorized" : "forbidden",
      error.message,
      error.status,
    );
  }
  if (error instanceof RepositoryNotFoundError) {
    return jsonError("not_found", "Proposal not found", 404);
  }
  if (error instanceof RepositoryConflictError) {
    return jsonError(
      "conflict",
      "Only a pending proposal can be reviewed",
      409,
    );
  }
  return jsonError("internal_error", "An internal error occurred", 500);
}


export async function GET(
  _request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  try {
    await requireUser();
    const id = routeIdSchema.safeParse((await context.params).id);
    if (!id.success) {
      return jsonError("validation_failed", "Invalid proposal id", 400);
    }
    const proposal = await getResearchProposalRecord(id.data);
    if (proposal === null) {
      return jsonError("not_found", "Proposal not found", 404);
    }
    return jsonSuccess({
      ...proposal,
      confidence: Number(proposal.confidence),
      createdAt: proposal.createdAt.toISOString(),
      updatedAt: proposal.updatedAt.toISOString(),
      reviewedAt: proposal.reviewedAt?.toISOString() ?? null,
    });
  } catch (error) {
    return handleError(error);
  }
}

export async function PATCH(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  try {
    const actor = await requireRole("analyst", "admin");
    await verifyCsrfRequest(request);

    const id = routeIdSchema.safeParse((await context.params).id);
    if (!id.success) {
      return jsonError("validation_failed", "Invalid proposal id", 400);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("bad_request", "Request body must be valid JSON", 400);
    }
    const parsed = reviewSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(
        "validation_failed",
        "Invalid proposal review",
        400,
        parsed.error.flatten(),
      );
    }
    if (
      parsed.data.decision === "edit_and_accept" &&
      JSON.stringify(parsed.data.editedValue).length > 50_000
    ) {
      return jsonError("validation_failed", "Edited value is too large", 400);
    }

    const requestId = request.headers.get("x-request-id");
    const result = await reviewResearchProposalRecord(id.data, {
      reviewerUserId: actor.id,
      decision: parsed.data.decision === "reject" ? "rejected" : "accepted",
      ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
      ...(parsed.data.decision === "edit_and_accept"
        ? { editedValue: parsed.data.editedValue }
        : {}),
      ...(requestId === null ? {} : { requestId }),
    });
    const proposal = result.replacementProposal ?? result.proposal;
    return jsonSuccess({
      ...proposal,
      confidence: Number(proposal.confidence),
      createdAt: proposal.createdAt.toISOString(),
      updatedAt: proposal.updatedAt.toISOString(),
      reviewedAt: proposal.reviewedAt?.toISOString() ?? null,
    });
  } catch (error) {
    return handleError(error);
  }
}
