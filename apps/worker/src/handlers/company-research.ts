import {
  getCompanyRecord,
  getResearchRunRecord,
  recordCompanyResearchArtifacts,
  setResearchRunState,
  type ResearchRunRecord,
} from "@asi/database";
import {
  OpenRouterClientError,
  researchCompany,
  SafeFetchError,
  type CompanyResearchInput,
  type OpenRouterClient,
  type OpenRouterModelRouting,
  type CompanyResearchJobPayload,
} from "@asi/research";

import type {
  QueueLogger,
  ResearchJobHandler,
  ResearchJobContext,
} from "../queue.js";

const JOB_NAME = "research.company.v1" as const;

type CompanyPayload = CompanyResearchJobPayload;

export interface CompanyResearchHandlerOptions {
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

class CompanyResearchError extends Error {
  readonly code: SafeErrorCode;
  readonly retryable: boolean;

  constructor(code: SafeErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = "CompanyResearchError";
    this.code = code;
    this.retryable = retryable;
  }
}

function isTerminalStatus(status: ResearchRunRecord["status"]): boolean {
  return (
    status === "succeeded" || status === "failed" || status === "cancelled"
  );
}

function cancelledError(): CompanyResearchError {
  return new CompanyResearchError(
    "cancelled",
    "The research run was cancelled.",
    false,
  );
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw cancelledError();
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ABORT_ERR")
  );
}

function toSafeError(
  error: unknown,
  signal: AbortSignal,
): CompanyResearchError {
  if (signal.aborted || isAbortError(error)) {
    return cancelledError();
  }
  if (error instanceof CompanyResearchError) {
    return error;
  }
  if (error instanceof OpenRouterClientError) {
    if (error.code === "cancelled") return cancelledError();
    if (error.code === "timeout") {
      return new CompanyResearchError("tool_timeout", error.message, true);
    }
    return new CompanyResearchError(
      "model_failed",
      error.message,
      error.retryable,
    );
  }
  if (error instanceof SafeFetchError) {
    if (error.code === "cancelled") return cancelledError();
    if (error.code === "timeout") {
      return new CompanyResearchError("tool_timeout", error.message, true);
    }
    if (
      error.code === "blocked_destination" ||
      error.code === "invalid_url" ||
      error.code === "unsupported_content_type"
    ) {
      return new CompanyResearchError(
        "permission_denied",
        error.message,
        false,
      );
    }
    return new CompanyResearchError("tool_failed", error.message, true);
  }
  return new CompanyResearchError(
    "internal_error",
    "Company research failed unexpectedly.",
    true,
  );
}

function validateRun(payload: CompanyPayload, run: ResearchRunRecord): void {
  if (
    run.targetType !== "company" ||
    run.targetId !== payload.companyId ||
    (run.requestedByUserId !== null &&
      run.requestedByUserId !== payload.requestedByUserId)
  ) {
    throw new CompanyResearchError(
      "invalid_payload",
      "The queued job does not match its research run.",
      false,
    );
  }
}

function enforceBudget(
  run: ResearchRunRecord,
  options: CompanyResearchHandlerOptions,
): void {
  if (run.actualCostUsd >= options.maxCostPerRunUsd) {
    throw new CompanyResearchError(
      "budget_exhausted",
      "The research run cost limit has been reached.",
      false,
    );
  }
  if (run.dailyActualCostUsd >= options.maxCostPerDayUsd) {
    throw new CompanyResearchError(
      "budget_exhausted",
      "The daily research cost limit has been reached.",
      false,
    );
  }
}

function toCompanyInput(
  company: NonNullable<Awaited<ReturnType<typeof getCompanyRecord>>>,
): CompanyResearchInput {
  return {
    id: company.id,
    legalName: company.legalName,
    displayName: company.displayName,
    description: company.description,
    websiteUrl: company.websiteUrl,
    headquartersCountryCode: company.headquartersCountryCode,
    domains: company.domains.map((domain) => ({
      domain: domain.domain,
      isPrimary: domain.isPrimary,
    })),
    knownFacts: [
      ...company.observations.map((observation) => ({
        fieldKey: observation.fieldKey,
        value: observation.value,
        status: observation.isCanonical
          ? ("canonical" as const)
          : ("pending" as const),
      })),
    ],
    linkedSources: company.linkedSources.map((source) => ({
      dataSourceId: source.dataSourceId,
      name: source.name,
      homepageUrl: source.homepageUrl,
      access: source.access,
    })),
  };
}

async function recordTerminalFailure(
  payload: CompanyPayload,
  context: ResearchJobContext,
  error: CompanyResearchError,
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
          companyId: payload.companyId,
          error: {
            code: error.code,
            message: error.message,
          },
          jobId: context.jobId,
          jobName: JOB_NAME,
          retryable: error.retryable,
        },
      },
      status: "failed",
    });
  } catch {
    logger("error", "company_research.terminal_state_failed", {
      code: error.code,
      companyId: payload.companyId,
      jobId: context.jobId,
      researchRunId: payload.researchRunId,
    });
  }
}

export function createCompanyResearchHandler(
  options: CompanyResearchHandlerOptions,
): ResearchJobHandler<typeof JOB_NAME> {
  return async (payload, context): Promise<void> => {
    let claimedRun = false;
    try {
      throwIfCancelled(context.signal);

      const [run, company] = await Promise.all([
        getResearchRunRecord(payload.researchRunId),
        getCompanyRecord(payload.companyId),
      ]);

      if (run === null) {
        throw new CompanyResearchError(
          "not_found",
          "The research run was not found.",
          false,
        );
      }

      if (isTerminalStatus(run.status)) {
        options.logger("info", "company_research.already_terminal", {
          companyId: payload.companyId,
          jobId: context.jobId,
          researchRunId: payload.researchRunId,
          status: run.status,
        });
        return;
      }

      validateRun(payload, run);

      if (company === null) {
        throw new CompanyResearchError(
          "not_found",
          "The company was not found.",
          false,
        );
      }

      if (run.status === "running") {
        claimedRun = true;
      } else if (run.status !== "queued") {
        throw new CompanyResearchError(
          "invalid_payload",
          "The research run is not queued.",
          false,
        );
      } else {
        await setResearchRunState(payload.researchRunId, {
          expectedStatus: "queued",
          metadata: {
            replay: {
              companyId: payload.companyId,
              jobId: context.jobId,
              jobName: JOB_NAME,
              requestedByUserId: payload.requestedByUserId,
            },
          },
          progressPercent: 5,
          status: "running",
        });
        claimedRun = true;
      }

      throwIfCancelled(context.signal);
      enforceBudget(run, options);

      const result = await researchCompany({
        client: options.client,
        company: toCompanyInput(company),
        maxToolCalls: options.maxToolCalls,
        models: options.models,
        route: "fast",
        signal: context.signal,
      });
      throwIfCancelled(context.signal);

      if (result.status !== "completed") {
        throw new CompanyResearchError(
          result.reason === "restricted_metadata_only"
            ? "permission_denied"
            : "tool_failed",
          result.message,
          false,
        );
      }

      const artifacts = await recordCompanyResearchArtifacts({
        companyId: payload.companyId,
        researchRunId: payload.researchRunId,
        result,
      });

      await setResearchRunState(payload.researchRunId, {
        expectedStatus: "running",
        metadata: {
          replay: {
            artifactCounts: {
              evidence: artifacts.evidenceIds.length,
              observations: artifacts.observationIds.length,
              proposals: artifacts.proposalIds.length,
              sourceDocuments: artifacts.sourceDocumentIds.length,
            },
            dataSourceId: artifacts.dataSourceId,
            jobId: context.jobId,
            jobName: JOB_NAME,
            modelUsageIds: artifacts.modelUsageIds,
            sourceDocumentIds: artifacts.sourceDocumentIds,
          },
        },
        progressPercent: 100,
        status: "succeeded",
      });

      options.logger("info", "company_research.succeeded", {
        companyId: payload.companyId,
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
