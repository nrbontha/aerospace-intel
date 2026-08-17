import {
  findLocalDiscoveries,
  recordDiscoverResearchArtifacts,
  setResearchRunState,
} from "@asi/database";
import {
  researchDiscover,
  type DiscoverResearchJobPayload,
  type OpenRouterClient,
  type OpenRouterModelRouting,
} from "@asi/research";

import type { QueueLogger, ResearchJobHandler } from "../queue.js";
import {
  claimResearchRun,
  failResearchRun,
  toSafeError,
} from "./runtime.js";

const JOB_NAME = "research.discover.v1" as const;

export function createDiscoverResearchHandler(options: {
  client: OpenRouterClient;
  logger: QueueLogger;
  maxToolCalls: number;
  models: OpenRouterModelRouting;
}): ResearchJobHandler<typeof JOB_NAME> {
  return async (payload: DiscoverResearchJobPayload, context) => {
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
      const seedTerms = payload.seedTerms ?? [];
      const localMatches = await findLocalDiscoveries({
        seedTerms: [...seedTerms, payload.objective],
        targetTypes: payload.targetTypes,
      });
      const result = await researchDiscover({
        client: options.client,
        localMatches,
        maxToolCalls: options.maxToolCalls,
        models: options.models,
        objective: payload.objective,
        route: "fast",
        seedTerms,
        signal: context.signal,
      });
      const artifacts = await recordDiscoverResearchArtifacts({
        researchRunId: payload.researchRunId,
        result,
      });
      await setResearchRunState(payload.researchRunId, {
        expectedStatus: "running",
        metadata: {
          replay: {
            fetchedUrls: result.fetchedUrls,
            jobId: context.jobId,
            jobName: JOB_NAME,
            localMatchCount: result.localMatches.length,
            proposalCount: artifacts.proposalIds.length,
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
