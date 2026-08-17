import {
  getCompanyRecord,
  getDataSourceRecord,
  getPartRecord,
  getPlatformRecord,
  listResearchRunRecords,
  recordCompanyResearchArtifacts,
  recordSourceResearchArtifacts,
  recordSubjectResearchArtifacts,
  setResearchRunState,
} from "@asi/database";
import {
  researchCompany,
  researchSource,
  researchSubject,
  type OpenRouterClient,
  type OpenRouterModelRouting,
  type RefreshResearchJobPayload,
} from "@asi/research";

import type { QueueLogger, ResearchJobHandler } from "../queue.js";
import {
  claimResearchRun,
  failResearchRun,
  ResearchJobError,
  toSafeError,
} from "./runtime.js";

const JOB_NAME = "research.refresh.v1" as const;

export function createRefreshResearchHandler(options: {
  client: OpenRouterClient;
  logger: QueueLogger;
  maxToolCalls: number;
  models: OpenRouterModelRouting;
}): ResearchJobHandler<typeof JOB_NAME> {
  return async (payload: RefreshResearchJobPayload, context) => {
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

      const staleBefore = payload.staleBefore;
      if (staleBefore !== undefined) {
        const previous = await listResearchRunRecords({
          page: 1,
          pageSize: 5,
          targetType: payload.target.type,
        });
        const cutoff = Date.parse(staleBefore);
        const fresh = previous.records.find(
          (item) =>
            item.targetId === payload.target.id &&
            item.status === "succeeded" &&
            item.id !== payload.researchRunId &&
            item.updatedAt.getTime() >= cutoff,
        );
        if (fresh) {
          await setResearchRunState(payload.researchRunId, {
            expectedStatus: "running",
            metadata: {
              replay: {
                jobId: context.jobId,
                jobName: JOB_NAME,
                skipped: "not_stale",
                sourceRunId: fresh.id,
              },
            },
            progressPercent: 100,
            status: "succeeded",
          });
          return;
        }
      }

      if (payload.target.type === "company") {
        const company = await getCompanyRecord(payload.target.id);
        if (company === null) {
          throw new ResearchJobError("not_found", "The company was not found.", false);
        }
        const result = await researchCompany({
          client: options.client,
          company: {
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
            knownFacts: company.observations.map((observation) => ({
              fieldKey: observation.fieldKey,
              value: observation.value,
              status: observation.isCanonical ? "canonical" : "pending",
            })),
            linkedSources: company.linkedSources.map((source) => ({
              dataSourceId: source.dataSourceId,
              name: source.name,
              homepageUrl: source.homepageUrl,
              access: source.access,
            })),
          },
          maxToolCalls: options.maxToolCalls,
          models: options.models,
          route: "fast",
          signal: context.signal,
        });
        if (result.status !== "completed") {
          throw new ResearchJobError("tool_failed", result.message, false);
        }
        await recordCompanyResearchArtifacts({
          companyId: company.id,
          researchRunId: payload.researchRunId,
          result,
        });
      } else if (payload.target.type === "data_source") {
        const source = await getDataSourceRecord(payload.target.id);
        if (source === null) {
          throw new ResearchJobError("not_found", "The data source was not found.", false);
        }
        const result = await researchSource({
          client: options.client,
          maxToolCalls: options.maxToolCalls,
          models: options.models,
          route: "fast",
          signal: context.signal,
          source: {
            id: source.id,
            name: source.name,
            sourceType: source.sourceType,
            baseUrl: source.homepageUrl,
            access: source.access,
            ingestion: source.ingestionMethod,
            publisher: source.publisher,
            notes: source.description,
          },
        });
        if (result.status !== "completed") {
          throw new ResearchJobError("tool_failed", result.message, false);
        }
        await recordSourceResearchArtifacts({
          dataSourceId: source.id,
          researchRunId: payload.researchRunId,
          result,
        });
      } else if (payload.target.type === "platform" || payload.target.type === "part") {
        const record =
          payload.target.type === "platform"
            ? await getPlatformRecord(payload.target.id)
            : await getPartRecord(payload.target.id);
        if (record === null) {
          throw new ResearchJobError(
            "not_found",
            `The ${payload.target.type} was not found.`,
            false,
          );
        }
        const manufacturerId = record.manufacturerCompanyId;
        const manufacturer =
          manufacturerId === null ? null : await getCompanyRecord(manufacturerId);
        const subjectName =
          "partNumber" in record ? (record.name ?? record.partNumber) : record.name;
        const result = await researchSubject({
          client: options.client,
          maxToolCalls: options.maxToolCalls,
          models: options.models,
          route: "fast",
          signal: context.signal,
          subject: {
            id: record.id,
            subjectType: payload.target.type,
            name: subjectName,
            description: record.description,
            fetchUrl: manufacturer?.websiteUrl ?? null,
            knownFacts: [],
          },
        });
        await recordSubjectResearchArtifacts({
          researchRunId: payload.researchRunId,
          result,
          subjectId: record.id,
          subjectType: payload.target.type,
        });
      } else {
        throw new ResearchJobError(
          "invalid_payload",
          "Refresh does not support this target type.",
          false,
        );
      }

      await setResearchRunState(payload.researchRunId, {
        expectedStatus: "running",
        metadata: {
          replay: {
            jobId: context.jobId,
            jobName: JOB_NAME,
            target: payload.target,
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
