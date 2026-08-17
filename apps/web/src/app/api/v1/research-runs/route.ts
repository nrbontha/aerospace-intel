import { allowsResearchDocumentWrites, getServerEnv } from "@asi/config";
import {
  researchDiscoverCreateSchema,
  researchRefreshCreateSchema,
  researchRunCreateSchema,
  researchRunListQuerySchema,
} from "@asi/contracts";
import {
  createResearchRunRecord,
  listResearchRunRecords,
  RepositoryConflictError,
  RepositoryNotFoundError,
  setResearchRunState,
} from "@asi/database";
import { NextResponse, type NextRequest } from "next/server";

import { jsonError, jsonSuccess } from "@/lib/api";
import { requireRole, requireUser, verifyCsrfRequest } from "@/lib/auth";
import { AuthorizationError } from "@/lib/rbac";
import {
  enqueueCompanyResearchJob,
  enqueueDiscoverResearchJob,
  enqueuePartResearchJob,
  enqueuePlatformResearchJob,
  enqueueRefreshResearchJob,
  enqueueSourceResearchJob,
  ResearchQueueDisabledError,
} from "@/lib/research-queue";

function handleRouteError(error: unknown): Response {
  if (error instanceof AuthorizationError) {
    return jsonError(
      error.status === 401 ? "unauthorized" : "forbidden",
      error.message,
      error.status,
    );
  }
  if (error instanceof RepositoryNotFoundError) {
    return jsonError(
      "not_found",
      `${error.entityType.replaceAll("_", " ")} not found`,
      404,
    );
  }
  if (error instanceof RepositoryConflictError) {
    return jsonError("conflict", error.message, 409);
  }
  return jsonError("internal_error", "An internal error occurred", 500);
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireUser();

    const query = researchRunListQuerySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    if (!query.success) {
      return jsonError(
        "validation_failed",
        "Invalid research run query",
        400,
        query.error.flatten(),
      );
    }

    const result = await listResearchRunRecords({
      page: query.data.page,
      pageSize: query.data.pageSize,
      ...(query.data.status === undefined ? {} : { status: query.data.status }),
      ...(query.data.targetType === undefined
        ? {}
        : { targetType: query.data.targetType }),
    });
    return NextResponse.json({
      data: result.records,
      meta: {
        page: result.page,
        pageSize: result.pageSize,
        totalItems: result.total,
        totalPages: Math.ceil(result.total / result.pageSize),
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const actor = await requireRole("analyst", "admin");
    await verifyCsrfRequest(request);

    if (!allowsResearchDocumentWrites(getServerEnv())) {
      return jsonError(
        "conflict",
        "Research is disabled until shared document storage is configured",
        409,
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("bad_request", "Request body must be valid JSON", 400);
    }

    const discoverInput = researchDiscoverCreateSchema.safeParse(body);
    const refreshInput = researchRefreshCreateSchema.safeParse(body);
    const input = researchRunCreateSchema.safeParse(body);
    if (!discoverInput.success && !refreshInput.success && !input.success) {
      return jsonError(
        "validation_failed",
        "Invalid research run",
        400,
        input.error.flatten(),
      );
    }

    if (discoverInput.success) {
      const run = await createResearchRunRecord({
        targetType: discoverInput.data.targetTypes[0] ?? "company",
        requestedByUserId: actor.id,
        objective: discoverInput.data.objective,
        ...(discoverInput.data.requestedModel === undefined
          ? {}
          : { requestedModel: discoverInput.data.requestedModel }),
        maxAttempts: discoverInput.data.maxAttempts,
        ...(discoverInput.data.maxCostUsd === undefined
          ? {}
          : { maxCostUsd: discoverInput.data.maxCostUsd }),
        metadata: {
          ...discoverInput.data.metadata,
          kind: "discover",
          targetTypes: discoverInput.data.targetTypes,
          ...(discoverInput.data.seedTerms === undefined
            ? {}
            : { seedTerms: discoverInput.data.seedTerms }),
        },
        promptVersion: "discover-research-v1",
      });
      try {
        await enqueueDiscoverResearchJob({
          name: "research.discover.v1",
          researchRunId: run.id,
          requestedByUserId: actor.id,
          objective: discoverInput.data.objective,
          targetTypes: discoverInput.data.targetTypes,
          ...(discoverInput.data.seedTerms === undefined
            ? {}
            : { seedTerms: discoverInput.data.seedTerms }),
        });
      } catch (error) {
        await setResearchRunState(run.id, {
          status: "failed",
          expectedStatus: "queued",
          errorCode:
            error instanceof ResearchQueueDisabledError
              ? "shared_storage_required"
              : "queue_enqueue_failed",
          errorMessage:
            error instanceof ResearchQueueDisabledError
              ? "Research is disabled until shared document storage is configured"
              : "Research could not be queued",
        });
        if (error instanceof ResearchQueueDisabledError) {
          return jsonError(
            "conflict",
            "Research is disabled until shared document storage is configured",
            409,
          );
        }
        return jsonError("internal_error", "Research could not be queued", 503);
      }
      return jsonSuccess(run, { status: 202 });
    }


    if (refreshInput.success) {
      if (
        refreshInput.data.target.type !== "company" &&
        refreshInput.data.target.type !== "data_source" &&
        refreshInput.data.target.type !== "platform" &&
        refreshInput.data.target.type !== "part"
      ) {
        return jsonError(
          "validation_failed",
          "Refresh supports company, source, platform, or part targets",
          400,
        );
      }
      const run = await createResearchRunRecord({
        targetType: refreshInput.data.target.type,
        targetId: refreshInput.data.target.id,
        requestedByUserId: actor.id,
        objective: `Refresh reviewed evidence for ${refreshInput.data.target.type} ${refreshInput.data.target.id}.`,
        ...(refreshInput.data.requestedModel === undefined
          ? {}
          : { requestedModel: refreshInput.data.requestedModel }),
        maxAttempts: refreshInput.data.maxAttempts,
        ...(refreshInput.data.maxCostUsd === undefined
          ? {}
          : { maxCostUsd: refreshInput.data.maxCostUsd }),
        metadata: {
          ...refreshInput.data.metadata,
          kind: "refresh",
          ...(refreshInput.data.staleBefore === undefined
            ? {}
            : { staleBefore: refreshInput.data.staleBefore }),
        },
        promptVersion: "refresh-research-v1",
      });
      try {
        await enqueueRefreshResearchJob({
          name: "research.refresh.v1",
          researchRunId: run.id,
          requestedByUserId: actor.id,
          target: refreshInput.data.target,
          ...(refreshInput.data.staleBefore === undefined
            ? {}
            : { staleBefore: refreshInput.data.staleBefore }),
        });
      } catch (error) {
        await setResearchRunState(run.id, {
          status: "failed",
          expectedStatus: "queued",
          errorCode:
            error instanceof ResearchQueueDisabledError
              ? "shared_storage_required"
              : "queue_enqueue_failed",
          errorMessage:
            error instanceof ResearchQueueDisabledError
              ? "Research is disabled until shared document storage is configured"
              : "Research could not be queued",
        });
        if (error instanceof ResearchQueueDisabledError) {
          return jsonError(
            "conflict",
            "Research is disabled until shared document storage is configured",
            409,
          );
        }
        return jsonError("internal_error", "Research could not be queued", 503);
      }
      return jsonSuccess(run, { status: 202 });
    }

    if (!input.success) {
      return jsonError(
        "validation_failed",
        "Invalid research run",
        400,
        input.error.flatten(),
      );
    }

    const [target] = input.data.targets;
    if (
      input.data.targets.length !== 1 ||
      target === undefined ||
      (target.type !== "data_source" &&
        target.type !== "company" &&
        target.type !== "platform" &&
        target.type !== "part")
    ) {
      return jsonError(
        "validation_failed",
        "Research requires exactly one supported target",
        400,
        {
          fieldErrors: {
            targets: ["Expected exactly one company, source, platform, or part target"],
          },
        },
      );
    }

    const run = await createResearchRunRecord({
      targetType: target.type,
      targetId: target.id,
      requestedByUserId: actor.id,
      objective: target.objective,
      ...(input.data.requestedModel === undefined
        ? {}
        : { requestedModel: input.data.requestedModel }),
      maxAttempts: input.data.maxAttempts,
      ...(input.data.maxCostUsd === undefined
        ? {}
        : { maxCostUsd: input.data.maxCostUsd }),
      metadata: input.data.metadata,
    });

    try {
      if (target.type === "company") {
        await enqueueCompanyResearchJob({
          name: "research.company.v1",
          researchRunId: run.id,
          requestedByUserId: actor.id,
          companyId: target.id,
        });
      } else if (target.type === "platform") {
        await enqueuePlatformResearchJob({
          name: "research.platform.v1",
          researchRunId: run.id,
          requestedByUserId: actor.id,
          platformId: target.id,
        });
      } else if (target.type === "part") {
        await enqueuePartResearchJob({
          name: "research.part.v1",
          researchRunId: run.id,
          requestedByUserId: actor.id,
          partId: target.id,
        });
      } else {
        await enqueueSourceResearchJob({
          name: "research.source.v1",
          researchRunId: run.id,
          requestedByUserId: actor.id,
          dataSourceId: target.id,
        });
      }
    } catch (error) {
      await setResearchRunState(run.id, {
        status: "failed",
        expectedStatus: "queued",
        errorCode:
          error instanceof ResearchQueueDisabledError
            ? "shared_storage_required"
            : "queue_enqueue_failed",
        errorMessage:
          error instanceof ResearchQueueDisabledError
            ? "Research is disabled until shared document storage is configured"
            : "Research could not be queued",
      });
      if (error instanceof ResearchQueueDisabledError) {
        return jsonError(
          "conflict",
          "Research is disabled until shared document storage is configured",
          409,
        );
      }
      return jsonError("internal_error", "Research could not be queued", 503);
    }

    return jsonSuccess(run, { status: 202 });
  } catch (error) {
    return handleRouteError(error);
  }
}
