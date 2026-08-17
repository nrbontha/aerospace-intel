import {
  RepositoryConflictError,
  RepositoryNotFoundError,
  listResearchProposalRecords,
  reviewResearchProposalRecord,
} from "@asi/database";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { jsonError, jsonSuccess } from "@/lib/api";
import { requireRole, verifyCsrfRequest } from "@/lib/auth";
import { AuthorizationError } from "@/lib/rbac";

const bulkReviewSchema = z.strictObject({
  proposalIds: z
    .array(z.uuid())
    .min(1)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "Proposal ids must be unique",
    }),
  reason: z.string().trim().min(1).max(10_000).optional(),
});
const restrictedBulkField =
  /(ownership|owner|parent_company|revenue|financial|income|sales|turnover|identity|legal_name|company_name|name|alias|duns|cage|uei|lei|registration|tax_id|qualification|qualified|certification|approval|sole_?source|source_?scarcity|supplier_?status)/i;

function restrictionFor(proposal: {
  subjectType: string;
  fieldKey: string;
  conflictStatus: string;
}): string | null {
  if (proposal.conflictStatus.toLowerCase() !== "none") {
    return "Conflicting evidence requires individual review";
  }
  const classification =
    `${proposal.subjectType}.${proposal.fieldKey}`.replaceAll("-", "_");
  if (restrictedBulkField.test(classification)) {
    return "Sensitive field requires individual review";
  }
  return null;
}

function handleError(error: unknown): Response {
  if (error instanceof AuthorizationError) {
    return jsonError(
      error.status === 401 ? "unauthorized" : "forbidden",
      error.message,
      error.status,
    );
  }
  return jsonError("internal_error", "An internal error occurred", 500);
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const actor = await requireRole("analyst", "admin");
    await verifyCsrfRequest(request);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("bad_request", "Request body must be valid JSON", 400);
    }
    const parsed = bulkReviewSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(
        "validation_failed",
        "Invalid bulk proposal review",
        400,
        parsed.error.flatten(),
      );
    }

    const requestId = request.headers.get("x-request-id");
    const pending = await listResearchProposalRecords({
      status: "pending",
      page: 1,
      pageSize: 100,
    });
    const pendingById = new Map(
      pending.records.map((proposal) => [proposal.id, proposal]),
    );
    const accepted = [];
    const skipped: Array<{ id: string; reason: string }> = [];

    for (const id of parsed.data.proposalIds) {
      const proposal = pendingById.get(id);
      if (proposal === undefined) {
        skipped.push({
          id,
          reason: "Proposal was not found or is already final",
        });
        continue;
      }
      const restriction = restrictionFor(proposal);
      if (restriction !== null) {
        skipped.push({ id, reason: restriction });
        continue;
      }

      try {
        const result = await reviewResearchProposalRecord(id, {
          reviewerUserId: actor.id,
          decision: "accepted",
          ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
          ...(requestId === null ? {} : { requestId }),
        });
        accepted.push({
          ...result.proposal,
          confidence: Number(result.proposal.confidence),
          createdAt: result.proposal.createdAt.toISOString(),
          updatedAt: result.proposal.updatedAt.toISOString(),
          reviewedAt: result.proposal.reviewedAt?.toISOString() ?? null,
        });
      } catch (error) {
        if (
          error instanceof RepositoryConflictError ||
          error instanceof RepositoryNotFoundError
        ) {
          skipped.push({ id, reason: "Proposal is no longer pending" });
          continue;
        }
        throw error;
      }
    }

    return jsonSuccess({ accepted, skipped });
  } catch (error) {
    return handleError(error);
  }
}
