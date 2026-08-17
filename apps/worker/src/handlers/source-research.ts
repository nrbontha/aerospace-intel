import {
  getDataSourceRecord,
  getResearchRunRecord,
  recordSourceResearchArtifacts,
  setResearchRunState,
  type ResearchRunRecord,
} from "@asi/database";
import {
  OpenRouterClientError,
  researchSource,
  type OpenRouterClient,
  type OpenRouterModelRouting,
  type SourceResearchJobPayload,
} from "@asi/research";

import type {
  QueueLogger,
  ResearchJobHandler,
  ResearchJobContext,
} from "../queue.js";

const JOB_NAME = "research.source.v1" as const;

type SourcePayload = SourceResearchJobPayload;
export interface SourceResearchHandlerOptions {
  client: OpenRouterClient;
  logger: QueueLogger;
  maxCostPerDayUsd: number;
  maxCostPerRunUsd: number;
  maxToolCalls: number;
  models: OpenRouterModelRouting;
}

type SafeErrorCode =
  | "budget_exhausted"
  | "cancelled"
  | "internal_error"
  | "invalid_payload"
  | "model_failed"
  | "not_found"
  | "permission_denied"
  | "tool_failed"
  | "tool_timeout";

class SourceResearchError extends Error {
  readonly code: SafeErrorCode;
  readonly retryable: boolean;

  constructor(code: SafeErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = "SourceResearchError";
    this.code = code;
    this.retryable = retryable;
  }
}

function cancelledError(): SourceResearchError {
  return new SourceResearchError(
    "cancelled",
    "Source research was cancelled.",
    false,
  );
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw cancelledError();
  }
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }

  return (
    typeof error === "object" &&
    error !== null &&
    (("name" in error && error.name === "AbortError") ||
      ("code" in error && error.code === "ABORT_ERR"))
  );
}

function toSafeError(error: unknown, signal: AbortSignal): SourceResearchError {
  if (signal.aborted || isAbortError(error)) {
    return cancelledError();
  }

  if (error instanceof SourceResearchError) {
    return error;
  }

  if (error instanceof OpenRouterClientError) {
    if (error.code === "cancelled") return cancelledError();
    return new SourceResearchError(
      "model_failed",
      error.message,
      error.retryable,
    );
  }

  return new SourceResearchError(
    "internal_error",
    "Source research failed unexpectedly.",
    true,
  );
}

function validateRun(payload: SourcePayload, run: ResearchRunRecord): void {
  if (
    run.targetType !== "data_source" ||
    run.targetId !== payload.dataSourceId ||
    (run.requestedByUserId !== null &&
      run.requestedByUserId !== payload.requestedByUserId)
  ) {
    throw new SourceResearchError(
      "invalid_payload",
      "The queued job does not match its research run.",
      false,
    );
  }

  if (run.status === "cancelled") {
    throw cancelledError();
  }

  if (run.status !== "queued") {
    throw new SourceResearchError(
      "invalid_payload",
      "The research run is not queued.",
      false,
    );
  }
}

function enforceBudget(
  run: ResearchRunRecord,
  options: SourceResearchHandlerOptions,
): void {
  if (run.actualCostUsd >= options.maxCostPerRunUsd) {
    throw new SourceResearchError(
      "budget_exhausted",
      "The research run cost limit has been reached.",
      false,
    );
  }

  if (run.dailyActualCostUsd >= options.maxCostPerDayUsd) {
    throw new SourceResearchError(
      "budget_exhausted",
      "The daily research cost limit has been reached.",
      false,
    );
  }
}

async function recordTerminalFailure(
  payload: SourcePayload,
  context: ResearchJobContext,
  error: SourceResearchError,
  claimedRun: boolean,
  logger: QueueLogger,
): Promise<void> {
  try {
    await setResearchRunState(payload.researchRunId, {
      errorCode: error.code,
      errorMessage: error.message,
      expectedStatus: claimedRun ? "running" : "queued",
      metadata: {
        replay: {
          error: {
            code: error.code,
            message: error.message,
          },
          jobId: context.jobId,
          jobName: JOB_NAME,
          retryable: error.retryable,
        },
      },
      status: error.code === "cancelled" ? "cancelled" : "failed",
    });
  } catch {
    logger("error", "source_research.terminal_state_failed", {
      code: error.code,
      dataSourceId: payload.dataSourceId,
      jobId: context.jobId,
      researchRunId: payload.researchRunId,
    });
  }
}

export function createSourceResearchHandler(
  options: SourceResearchHandlerOptions,
): ResearchJobHandler<typeof JOB_NAME> {
  return async (payload, context): Promise<void> => {
    let claimedRun = false;
    try {
      throwIfCancelled(context.signal);

      const [run, source] = await Promise.all([
        getResearchRunRecord(payload.researchRunId),
        getDataSourceRecord(payload.dataSourceId),
      ]);

      if (run === null) {
        throw new SourceResearchError(
          "not_found",
          "The research run was not found.",
          false,
        );
      }
      if (source === null) {
        throw new SourceResearchError(
          "not_found",
          "The data source was not found.",
          false,
        );
      }

      validateRun(payload, run);
      if (source.access === "restricted_metadata_only") {
        throw new SourceResearchError(
          "permission_denied",
          "Restricted metadata-only sources cannot be fetched or researched.",
          false,
        );
      }

      await setResearchRunState(payload.researchRunId, {
        expectedStatus: "queued",
        metadata: {
          replay: {
            dataSourceId: payload.dataSourceId,
            jobId: context.jobId,
            jobName: JOB_NAME,
            requestedByUserId: payload.requestedByUserId,
          },
        },
        progressPercent: 5,
        status: "running",
      });
      claimedRun = true;

      throwIfCancelled(context.signal);
      enforceBudget(run, options);

      const result = await researchSource({
        client: options.client,
        maxToolCalls: options.maxToolCalls,
        models: options.models,
        route: "fast",
        signal: context.signal,
        source,
      });
      throwIfCancelled(context.signal);

      if (result.status !== "completed") {
        throw new SourceResearchError(
          "tool_failed",
          "The source could not be fetched and no research artifacts were created.",
          true,
        );
      }

      const artifacts = await recordSourceResearchArtifacts({
        dataSourceId: payload.dataSourceId,
        researchRunId: payload.researchRunId,
        result,
      });

      await setResearchRunState(payload.researchRunId, {
        expectedStatus: "running",
        metadata: {
          replay: {
            artifactCounts: {
              companies: artifacts.companyIds.length,
              evidence: artifacts.evidenceIds.length,
              observations: artifacts.observationIds.length,
              proposals: artifacts.proposalIds.length,
              sourceDocuments: 1,
            },
            jobId: context.jobId,
            jobName: JOB_NAME,
            modelUsageIds: artifacts.modelUsageIds,
            sourceDocumentId: artifacts.sourceDocumentId,
          },
        },
        progressPercent: 100,
        status: "succeeded",
      });

      options.logger("info", "source_research.succeeded", {
        companyCount: artifacts.companyIds.length,
        dataSourceId: payload.dataSourceId,
        evidenceCount: artifacts.evidenceIds.length,
        jobId: context.jobId,
        observationCount: artifacts.observationIds.length,
        proposalCount: artifacts.proposalIds.length,
        researchRunId: payload.researchRunId,
      });
    } catch (error) {
      const safeError = toSafeError(error, context.signal);
      await recordTerminalFailure(
        payload,
        context,
        safeError,
        claimedRun,
        options.logger,
      );
      throw safeError;
    }
  };
}
