import {
  getCompanyRecord,
  getPartRecord,
  recordSubjectResearchArtifacts,
  setResearchRunState,
} from "@asi/database";
import {
  researchSubject,
  type OpenRouterClient,
  type OpenRouterModelRouting,
  type PartResearchJobPayload,
} from "@asi/research";

import type { QueueLogger, ResearchJobHandler } from "../queue.js";
import {
  claimResearchRun,
  failResearchRun,
  ResearchJobError,
  toSafeError,
} from "./runtime.js";

const JOB_NAME = "research.part.v1" as const;

export function createPartResearchHandler(options: {
  client: OpenRouterClient;
  logger: QueueLogger;
  maxToolCalls: number;
  models: OpenRouterModelRouting;
}): ResearchJobHandler<typeof JOB_NAME> {
  return async (payload: PartResearchJobPayload, context) => {
    let claimed = false;
    try {
      const run = await claimResearchRun({
        jobId: context.jobId,
        jobName: JOB_NAME,
        logger: options.logger,
        researchRunId: payload.researchRunId,
      });
      if (run === null) return;
      claimed = true;
      if (run.targetType !== "part" || run.targetId !== payload.partId) {
        throw new ResearchJobError(
          "invalid_payload",
          "The queued job does not match its research run.",
          false,
        );
      }
      const part = await getPartRecord(payload.partId);
      if (part === null) {
        throw new ResearchJobError("not_found", "The part was not found.", false);
      }
      const manufacturer =
        part.manufacturerCompanyId === null
          ? null
          : await getCompanyRecord(part.manufacturerCompanyId);
      const result = await researchSubject({
        client: options.client,
        maxToolCalls: options.maxToolCalls,
        models: options.models,
        route: "fast",
        signal: context.signal,
        subject: {
          id: part.id,
          subjectType: "part",
          name: part.name ?? part.partNumber,
          description: part.description,
          fetchUrl: manufacturer?.websiteUrl ?? null,
          knownFacts: [],
        },
      });
      const artifacts = await recordSubjectResearchArtifacts({
        researchRunId: payload.researchRunId,
        result,
        subjectId: part.id,
        subjectType: "part",
      });
      await setResearchRunState(payload.researchRunId, {
        expectedStatus: "running",
        metadata: {
          replay: {
            artifactCounts: {
              observations: artifacts.observationIds.length,
              proposals: artifacts.proposalIds.length,
            },
            jobId: context.jobId,
            jobName: JOB_NAME,
            localOnly: result.localOnly,
          },
        },
        progressPercent: 100,
        status: "succeeded",
      });
    } catch (error) {
      const safeError = toSafeError(error, context.signal);
      await failResearchRun({
        claimed,
        error: safeError,
        jobId: context.jobId,
        jobName: JOB_NAME,
        logger: options.logger,
        researchRunId: payload.researchRunId,
      });
      throw safeError;
    }
  };
}
