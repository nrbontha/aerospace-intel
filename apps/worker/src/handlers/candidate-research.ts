import { and, eq, gt, sql } from "drizzle-orm";

import {
  getCompanyRecord,
  getCandidateByCompanyId,
  getDatabase,
  getResearchRunRecord,
  recordCompanyResearchArtifacts,
  setResearchRunState,
  sourceDocumentLinks,
  sourceDocuments,
  updateCandidateStatus,
} from "@asi/database";
import {
  failResearchRun,
  isTerminalStatus,
  ResearchJobError,
  toSafeError,
} from "./runtime.js";
import {
  noteCandidateResearchFailure,
  rescoreCandidateAfterResearch,
  runCandidateResearchWorkflow,
  type CandidateResearchOutcome,
} from "@asi/research";

import type {
  QueueLogger,
  ResearchJobHandler,
  ResearchJobContext,
} from "../queue.js";
import type {
  CandidateResearchJobPayload,
  OpenRouterClient,
  OpenRouterModelRouting,
} from "@asi/research";
import type { CompanyResearchInput } from "@asi/research";

const JOB_NAME = "candidate-research.v1" as const;
const MAX_ATTEMPTS = 2;
/** Hard stop: abort before enqueueing model work when today's spend exceeds this. */
const DAILY_COST_ABORT_USD = 0.8;

export interface CandidateResearchHandlerOptions {
  client: OpenRouterClient;
  logger: QueueLogger;
  models: OpenRouterModelRouting;
}

export interface ProcessCandidateResearchDeps {
  client: OpenRouterClient;
  /** Skip the recent-document reuse window and always fetch+extract. */
  forceRefresh?: boolean | undefined;
  logger?: QueueLogger | undefined;
  models: OpenRouterModelRouting;
  signal?: AbortSignal | undefined;
}
export interface CandidateResearchProcessResult {
  candidateId: string;
  observationsCreated: number;
  evidenceCount: number;
  proposalCount: number;
  fetchedUrls: readonly string[];
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  scores: {
    fit: number | null;
    novelty: number | null;
    confidence: number;
    actionability: number | null;
  };
}

function log(
  logger: QueueLogger | undefined,
  level: "error" | "info" | "warn",
  event: string,
  fields: Readonly<Record<string, unknown>>,
): void {
  logger?.(level, event, fields);
}

async function dailyModelSpendUsd(): Promise<number> {
  const result = await getDatabase().execute<{ total: string | null }>(sql`
    SELECT coalesce(sum(cost_usd), 0)::text AS total
    FROM model_usage
    WHERE created_at >= date_trunc('day', now())
  `);
  return Number(result.rows[0]?.total ?? "0");
}

const REUSE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Content-addressed dedupe: a candidate-research source document linked to
 * this company within the reuse window means a rerun must NOT ingest another
 * copy (site HTML mutates between fetches, so raw sha256 alone cannot catch
 * it — the window + company link is the idempotency key).
 */
async function findReusableRecentDocument(
  companyId: string,
): Promise<string | undefined> {
  const rows = await getDatabase()
    .select({ id: sourceDocuments.id })
    .from(sourceDocuments)
    .innerJoin(
      sourceDocumentLinks,
      eq(sourceDocumentLinks.sourceDocumentId, sourceDocuments.id),
    )
    .where(
      and(
        eq(sourceDocumentLinks.companyId, companyId),
        sql`${sourceDocuments.metadata}->>'promptVersion' = 'candidate-research.v1'`,
        gt(sourceDocuments.retrievedAt, new Date(Date.now() - REUSE_WINDOW_MS)),
      ),
    )
    .limit(1);
  return rows[0]?.id;
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

/**
 * Inline-processible candidate research job (tests and the deep-research
 * runner call this directly without a pg-boss worker).
 *
 * Flow: claim run → in_research → ≤3 fetch_url workflow → evidence-backed
 * extraction artifacts → canonical rescore → research_ready. Any failure
 * after MAX_ATTEMPTS returns the candidate to queued_research with an error
 * note appended to rationale.unknowns.
 */
export async function processCandidateResearch(
  payload: Pick<CandidateResearchJobPayload, "researchRunId" | "companyId">,
  deps: ProcessCandidateResearchDeps,
): Promise<CandidateResearchProcessResult> {
  const logger = deps.logger;
  const run = await getResearchRunRecord(payload.researchRunId);
  if (run === null) {
    throw new ResearchJobError("not_found", "The research run was not found.", false);
  }
  if (isTerminalStatus(run.status)) {
    return {
      candidateId: "",
      observationsCreated: 0,
      evidenceCount: 0,
      proposalCount: 0,
      fetchedUrls: [],
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      costUsd: null,
      scores: { fit: null, novelty: null, confidence: 0, actionability: null },
    };
  }
  await setResearchRunState(payload.researchRunId, {
    expectedStatus: "queued",
    progressPercent: 10,
    status: "running",
  });

  const company = await getCompanyRecord(payload.companyId);
  if (company === null) {
    throw new ResearchJobError("not_found", "The company was not found.", false);
  }
  const candidate = await getCandidateByCompanyId(getDatabase(), payload.companyId);
  if (candidate === null) {
    throw new ResearchJobError(
      "not_found",
      `No candidate exists for company ${payload.companyId}.`,
      false,
    );
  }

  if ((await dailyModelSpendUsd()) > DAILY_COST_ABORT_USD) {
    throw new ResearchJobError(
      "budget_exhausted",
      `Daily model usage exceeds $${DAILY_COST_ABORT_USD.toFixed(2)}; candidate research aborted.`,
      false,
    );
  }

  // Idempotent rerun: a fresh candidate-research document for this company
  // already exists — skip fetch/model entirely (no duplicate source documents)
  // and just refresh scores + status.
  if (deps.forceRefresh !== true) {
    const reusedDocumentId = await findReusableRecentDocument(payload.companyId);
    if (reusedDocumentId !== undefined) {
    const rescored = await rescoreCandidateAfterResearch(
      getDatabase(),
      candidate.id,
    );
    await setResearchRunState(payload.researchRunId, {
      expectedStatus: "running",
      metadata: {
        replay: { reusedSourceDocumentId: reusedDocumentId },
      },
      progressPercent: 100,
      status: "succeeded",
    });
    await updateCandidateStatus(getDatabase(), {
      candidateId: candidate.id,
      status: "research_ready",
    });
    log(logger, "info", "candidate_research.reused_recent_document", {
      candidateId: candidate.id,
      companyId: payload.companyId,
      researchRunId: payload.researchRunId,
      reusedSourceDocumentId: reusedDocumentId,
    });
    return {
      candidateId: candidate.id,
      observationsCreated: 0,
      evidenceCount: 0,
      proposalCount: 0,
      fetchedUrls: [],
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      costUsd: null,
      scores: rescored.scores,
    };
  }
    }

  await updateCandidateStatus(getDatabase(), {
    candidateId: candidate.id,
    status: "in_research",
  });

  const companyInput = toCompanyInput(company);
  let outcome: CandidateResearchOutcome | undefined;
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      outcome = await runCandidateResearchWorkflow({
        client: deps.client,
        models: deps.models,
        company: companyInput,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      });
      break;
    } catch (error) {
      lastError = error;
      log(logger, "warn", "candidate_research.attempt_failed", {
        attempt,
        companyId: payload.companyId,
        error: error instanceof Error ? error.message : String(error),
        maxAttempts: MAX_ATTEMPTS,
        researchRunId: payload.researchRunId,
      });
    }
  }

  if (outcome === undefined) {
    const message =
      lastError instanceof Error ? lastError.message : String(lastError);
    await noteCandidateResearchFailure(getDatabase(), candidate.id, message);
    await updateCandidateStatus(getDatabase(), {
      candidateId: candidate.id,
      status: "queued_research",
    });
    throw new ResearchJobError("model_failed", message, true);
  }

  const artifacts = await recordCompanyResearchArtifacts({
    companyId: payload.companyId,
    researchRunId: payload.researchRunId,
    result: {
      status: "completed",
      sourceDocuments: [...outcome.sourceDocuments],
      facts: [...outcome.facts],
      telemetry: {
        promptVersion: "candidate-research.v1",
        fetch: outcome.fetchTelemetry,
        model: {
          route: outcome.modelRoute,
          schemaName: outcome.schemaName,
          schemaSha256: outcome.schemaSha256,
          responseSha256: outcome.responseSha256,
          provider: outcome.provider,
          attempts: outcome.modelAttempts,
        },
      },
    },
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
        fetchedUrls: outcome.fetchedUrls,
        modelUsageIds: artifacts.modelUsageIds,
        sourceDocumentIds: artifacts.sourceDocumentIds,
      },
    },
    progressPercent: 100,
    status: "succeeded",
  });

  const rescored = await rescoreCandidateAfterResearch(
    getDatabase(),
    candidate.id,
  );
  await updateCandidateStatus(getDatabase(), {
    candidateId: candidate.id,
    status: "research_ready",
  });

  log(logger, "info", "candidate_research.succeeded", {
    candidateId: candidate.id,
    companyId: payload.companyId,
    evidenceCount: artifacts.evidenceIds.length,
    observationCount: artifacts.observationIds.length,
    researchRunId: payload.researchRunId,
    scores: rescored.scores,
  });

  return {
    candidateId: candidate.id,
    observationsCreated: artifacts.observationIds.length,
    evidenceCount: artifacts.evidenceIds.length,
    proposalCount: artifacts.proposalIds.length,
    fetchedUrls: outcome.fetchedUrls,
    inputTokens: outcome.inputTokens,
    outputTokens: outcome.outputTokens,
    totalTokens: outcome.totalTokens,
    costUsd: outcome.costUsd,
    scores: rescored.scores,
  };
}

export function createCandidateResearchHandler(
  options: CandidateResearchHandlerOptions,
): ResearchJobHandler<typeof JOB_NAME> {
  return async (
    payload: CandidateResearchJobPayload,
    context: ResearchJobContext,
  ): Promise<void> => {
    try {
      await processCandidateResearch(payload, {
        client: options.client,
        logger: options.logger,
        models: options.models,
        signal: context.signal,
      });
    } catch (error) {
      const safeError = toSafeError(error, context.signal);
      const claimed = await getResearchRunRecord(payload.researchRunId);
      await failResearchRun({
        claimed: claimed?.status === "running",
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
