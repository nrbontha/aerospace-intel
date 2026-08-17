import { paginatedQuerySchema } from "@asi/contracts";
import { listResearchProposalRecords } from "@asi/database";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { jsonError } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { AuthorizationError } from "@/lib/rbac";

const proposalQuerySchema = paginatedQuerySchema.extend({
  status: z.enum(["pending", "all"]).default("pending"),
});

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

export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireUser();
    const parsed = proposalQuerySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    if (!parsed.success) {
      return jsonError(
        "validation_failed",
        "Invalid proposal list query",
        400,
        parsed.error.flatten(),
      );
    }

    const { status, page, pageSize } = parsed.data;
    const result = await listResearchProposalRecords({
      ...(status === "pending" ? { status } : {}),
      page,
      pageSize,
    });
    return NextResponse.json({
      data: result.records.map((record) => ({
        ...record,
        confidence: Number(record.confidence),
        createdAt: record.createdAt.toISOString(),
        updatedAt: record.updatedAt.toISOString(),
        reviewedAt: record.reviewedAt?.toISOString() ?? null,
      })),
      meta: {
        page: result.page,
        pageSize: result.pageSize,
        totalItems: result.total,
        totalPages: Math.ceil(result.total / result.pageSize),
      },
    });
  } catch (error) {
    return handleError(error);
  }
}
