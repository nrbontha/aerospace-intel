import {
  getResearchRunRecord,
  setResearchRunState,
  type ResearchRunRecord,
} from "@asi/database";
import { OpenRouterClientError, SafeFetchError } from "@asi/research";

import type { QueueLogger } from "../queue.js";

export type SafeErrorCode =
  | "budget_exhausted"
  | "cancelled"
  | "internal_error"
  | "invalid_payload"
  | "model_failed"
  | "not_found"
  | "permission_denied"
  | "tool_failed"
  | "tool_timeout";

export class ResearchJobError extends Error {
  readonly code: SafeErrorCode;
  readonly retryable: boolean;

  constructor(code: SafeErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = "ResearchJobError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function isTerminalStatus(status: ResearchRunRecord["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

export function toSafeError(error: unknown, signal: AbortSignal): ResearchJobError {
  if (signal.aborted) {
    return new ResearchJobError("cancelled", "The research run was cancelled.", false);
  }
  if (error instanceof ResearchJobError) return error;
  if (error instanceof OpenRouterClientError) {
    if (error.code === "timeout") {
      return new ResearchJobError("tool_timeout", error.message, true);
    }
    return new ResearchJobError("model_failed", error.message, error.retryable);
  }
  if (error instanceof SafeFetchError) {
    if (error.code === "timeout") {
      return new ResearchJobError("tool_timeout", error.message, true);
    }
    if (
      error.code === "blocked_destination" ||
      error.code === "invalid_url" ||
      error.code === "unsupported_content_type"
    ) {
      return new ResearchJobError("permission_denied", error.message, false);
    }
    return new ResearchJobError("tool_failed", error.message, true);
  }
  return new ResearchJobError(
    "internal_error",
    "Research failed unexpectedly.",
    true,
  );
}

export async function claimResearchRun(input: {
  readonly researchRunId: string;
  readonly jobId: string;
  readonly jobName: string;
  readonly logger: QueueLogger;
}): Promise<ResearchRunRecord | null> {
  const run = await getResearchRunRecord(input.researchRunId);
  if (run === null) {
    throw new ResearchJobError("not_found", "The research run was not found.", false);
  }
  if (isTerminalStatus(run.status)) {
    input.logger("info", "research.already_terminal", {
      jobId: input.jobId,
      jobName: input.jobName,
      researchRunId: input.researchRunId,
      status: run.status,
    });
    return null;
  }
  if (run.status === "running") return run;
  if (run.status !== "queued") {
    throw new ResearchJobError(
      "invalid_payload",
      "The research run is not queued.",
      false,
    );
  }
  await setResearchRunState(input.researchRunId, {
    expectedStatus: "queued",
    metadata: {
      replay: {
        jobId: input.jobId,
        jobName: input.jobName,
      },
    },
    progressPercent: 5,
    status: "running",
  });
  return run;
}

export async function failResearchRun(input: {
  readonly researchRunId: string;
  readonly jobId: string;
  readonly jobName: string;
  readonly claimed: boolean;
  readonly error: ResearchJobError;
  readonly logger: QueueLogger;
}): Promise<void> {
  try {
    await setResearchRunState(input.researchRunId, {
      errorCode: input.error.code,
      errorMessage: input.error.message,
      expectedStatus: input.claimed ? "running" : "queued",
      metadata: {
        replay: {
          error: { code: input.error.code, message: input.error.message },
          jobId: input.jobId,
          jobName: input.jobName,
          retryable: input.error.retryable,
        },
      },
      status: "failed",
    });
  } catch {
    input.logger("error", "research.terminal_state_failed", {
      jobId: input.jobId,
      jobName: input.jobName,
      researchRunId: input.researchRunId,
    });
  }
}
