import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { getDatabase } from "./client.js";
import { inferObservationValueKind, normalizeLegalName } from "./provenance.js";
import {
  companies,
  companySourceLinks,
  dataSources,
  evidence,
  modelUsage,
  observations,
  researchProposals,
  researchToolCalls,
  sourceDocumentLinks,
  sourceDocuments,
} from "./schema.js";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}


function asModelTelemetry(value: unknown): {
  route: string;
  schemaName: string;
  provider: string;
  attempts: Array<{
    attempt: number;
    model: string;
    status: string;
    promptSha256: string;
    responseSha256: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
    latencyMs: number | null;
    errorCode: string | null;
    provider?: string;
  }>;
} | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.attempts)) return null;
  return {
    route: typeof record.route === "string" ? record.route : "fast",
    schemaName: typeof record.schemaName === "string" ? record.schemaName : "unknown",
    provider: typeof record.provider === "string" ? record.provider : "openrouter",
    attempts: record.attempts.map((item, index) => {
      const attempt = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
      return {
        attempt: typeof attempt.attempt === "number" ? attempt.attempt : index + 1,
        model: typeof attempt.model === "string" ? attempt.model : "unknown",
        status: typeof attempt.status === "string" ? attempt.status : "failed",
        promptSha256: typeof attempt.promptSha256 === "string" ? attempt.promptSha256 : "",
        responseSha256: typeof attempt.responseSha256 === "string" ? attempt.responseSha256 : null,
        inputTokens: typeof attempt.inputTokens === "number" ? attempt.inputTokens : null,
        outputTokens: typeof attempt.outputTokens === "number" ? attempt.outputTokens : null,
        costUsd: typeof attempt.costUsd === "number" ? attempt.costUsd : null,
        latencyMs: typeof attempt.latencyMs === "number" ? attempt.latencyMs : null,
        errorCode: typeof attempt.errorCode === "string" ? attempt.errorCode : null,
        ...(typeof attempt.provider === "string" ? { provider: attempt.provider } : {}),
      };
    }),
  };
}

export interface SubjectResearchArtifactInput {
  readonly subjectType: "platform" | "part" | "company";
  readonly subjectId: string;
  readonly researchRunId: string;
  readonly result: {
    readonly sourceDocuments: readonly {
      readonly canonicalUrl: string;
      readonly title: string;
      readonly mimeType: string;
      readonly byteLength: number;
      readonly contentSha256: string;
      readonly retrievedAt: string;
      readonly metadata: Record<string, unknown>;
    }[];
    readonly facts: readonly {
      readonly fieldKey: string;
      readonly value: unknown;
      readonly evidenceExcerpt: string;
      readonly confidence: number;
    }[];
    readonly telemetry: {
      readonly promptVersion: string;
      readonly fetch: {
        readonly toolName: string;
        readonly requestedUrlSha256: string;
        readonly responseSha256: string;
        readonly finalUrl: string;
        readonly byteLength: number;
        readonly durationMs: number;
        readonly redirectCount: number;
      } | null;
      readonly model: unknown;
    };
  };
}

export interface RecordedSubjectResearchArtifacts {
  readonly dataSourceId: string | null;
  readonly sourceDocumentId: string | null;
  readonly evidenceIds: readonly string[];
  readonly observationIds: readonly string[];
  readonly proposalIds: readonly string[];
  readonly modelUsageIds: readonly string[];
}

export async function recordSubjectResearchArtifacts(
  input: SubjectResearchArtifactInput,
): Promise<RecordedSubjectResearchArtifacts> {
  const document = input.result.sourceDocuments[0];
  if (document === undefined) {
    return {
      dataSourceId: null,
      sourceDocumentId: null,
      evidenceIds: [],
      observationIds: [],
      proposalIds: [],
      modelUsageIds: [],
    };
  }

  return getDatabase().transaction(async (tx) => {
    const normalizedUrl = document.canonicalUrl.toLowerCase();
    const [urlMatch] = await tx
      .select({ id: dataSources.id })
      .from(dataSources)
      .where(sql`lower(${dataSources.baseUrl}) = ${normalizedUrl}`)
      .limit(1);
    let dataSourceId = urlMatch?.id;
    if (dataSourceId === undefined) {
      const [created] = await tx
        .insert(dataSources)
        .values({
          name: `${input.subjectType} research source`,
          sourceType: "web_page",
          baseUrl: document.canonicalUrl,
          access: "public",
          ingestion: "web_fetch",
          notes: "Created by bounded subject research.",
        })
        .onConflictDoNothing()
        .returning({ id: dataSources.id });
      dataSourceId = created?.id;
    }
    if (dataSourceId === undefined) {
      const [fallback] = await tx
        .select({ id: dataSources.id })
        .from(dataSources)
        .where(sql`lower(${dataSources.baseUrl}) = ${normalizedUrl}`)
        .limit(1);
      dataSourceId = fallback?.id;
    }
    if (dataSourceId === undefined) {
      throw new Error("Unable to persist subject research source");
    }

    if (input.result.telemetry.fetch) {
      await tx.insert(researchToolCalls).values({
        researchRunId: input.researchRunId,
        sequence: 0,
        toolName: input.result.telemetry.fetch.toolName,
        status: "succeeded",
        request: {
          requestedUrlSha256: input.result.telemetry.fetch.requestedUrlSha256,
        },
        response: input.result.telemetry.fetch,
        requestSha256: input.result.telemetry.fetch.requestedUrlSha256,
        responseSha256: input.result.telemetry.fetch.responseSha256,
        startedAt: new Date(document.retrievedAt),
        completedAt: new Date(document.retrievedAt),
        durationMs: input.result.telemetry.fetch.durationMs,
      }).onConflictDoNothing();
    }

    const modelTelemetry = asModelTelemetry(input.result.telemetry.model);
    if (modelTelemetry) {
      await tx.insert(modelUsage).values(
        modelTelemetry.attempts.map((attempt) => ({
          researchRunId: input.researchRunId,
          sequence: Math.max(0, attempt.attempt - 1),
          provider: attempt.provider ?? modelTelemetry.provider,
          model: attempt.model,
          status: attempt.status === "succeeded" ? ("succeeded" as const) : ("failed" as const),
          promptSha256: attempt.promptSha256,
          responseSha256: attempt.responseSha256,
          request: {
            route: modelTelemetry.route,
            schemaName: modelTelemetry.schemaName,
          },
          response: { telemetry: attempt },
          inputTokens: attempt.inputTokens,
          outputTokens: attempt.outputTokens,
          costUsd: attempt.costUsd === null ? null : String(attempt.costUsd),
          latencyMs: attempt.latencyMs,
          error: attempt.errorCode === null ? null : { code: attempt.errorCode },
        })),
      ).onConflictDoNothing();
    }

    const persistedModels = await tx
      .select({ id: modelUsage.id })
      .from(modelUsage)
      .where(eq(modelUsage.researchRunId, input.researchRunId));

    const [insertedDocument] = await tx
      .insert(sourceDocuments)
      .values({
        dataSourceId,
        canonicalUrl: document.canonicalUrl,
        title: document.title,
        documentType: "web_page",
        retrievedAt: new Date(document.retrievedAt),
        contentSha256: document.contentSha256,
        mimeType: document.mimeType,
        byteLength: document.byteLength,
        metadata: {
          ...document.metadata,
          promptVersion: input.result.telemetry.promptVersion,
          researchRunId: input.researchRunId,
        },
      })
      .onConflictDoNothing()
      .returning({ id: sourceDocuments.id });
    const storedDocument =
      insertedDocument ??
      (
        await tx
          .select({ id: sourceDocuments.id })
          .from(sourceDocuments)
          .where(eq(sourceDocuments.contentSha256, document.contentSha256))
          .limit(1)
      )[0];
    if (!storedDocument) throw new Error("Unable to persist source document");

    const evidenceIds: string[] = [];
    const observationIds: string[] = [];
    const proposalIds: string[] = [];
    for (const fact of input.result.facts) {
      const [evidenceRow] = await tx
        .insert(evidence)
        .values({
          sourceDocumentId: storedDocument.id,
          extractionStatus: "completed",
          quote: fact.evidenceExcerpt,
          locator: document.canonicalUrl,
          extractionMethod: "subject_research_model",
          contentSha256: digest(fact.evidenceExcerpt),
          metadata: { researchRunId: input.researchRunId },
        })
        .returning({ id: evidence.id });
      if (!evidenceRow) throw new Error("Unable to persist evidence");
      evidenceIds.push(evidenceRow.id);
      const [observation] = await tx
        .insert(observations)
        .values({
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          fieldKey: fact.fieldKey,
          valueKind: inferObservationValueKind(fact.value),
          value: fact.value,
          normalizedText:
            typeof fact.value === "string"
              ? fact.value.normalize("NFKC").trim().replace(/\s+/gu, " ")
              : null,
          confidence: String(fact.confidence),
          evidenceId: evidenceRow.id,
          reviewStatus: "pending",
          conflictStatus: "none",
        })
        .returning({ id: observations.id });
      if (!observation) throw new Error("Unable to persist observation");
      observationIds.push(observation.id);
      const [proposal] = await tx
        .insert(researchProposals)
        .values({
          researchRunId: input.researchRunId,
          observationId: observation.id,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          fieldKey: fact.fieldKey,
          rationale: "Evidence-backed extraction from bounded subject research.",
          proposedByModelUsageId: persistedModels.at(-1)?.id,
        })
        .returning({ id: researchProposals.id });
      if (!proposal) throw new Error("Unable to persist proposal");
      proposalIds.push(proposal.id);
    }

    return {
      dataSourceId,
      sourceDocumentId: storedDocument.id,
      evidenceIds,
      observationIds,
      proposalIds,
      modelUsageIds: persistedModels.map((row) => row.id),
    };
  });
}

export async function recordDiscoverResearchArtifacts(input: {
  readonly researchRunId: string;
  readonly result: {
    readonly sourceDocuments: SubjectResearchArtifactInput["result"]["sourceDocuments"];
    readonly candidates: readonly {
      readonly legalName: string;
      readonly displayName: string;
      readonly website: string | null;
      readonly description: string;
      readonly evidenceExcerpt: string;
      readonly confidence: number;
    }[];
  };
}): Promise<RecordedSubjectResearchArtifacts> {
  const document = input.result.sourceDocuments[0];
  if (document === undefined || input.result.candidates.length === 0) {
    return {
      dataSourceId: null,
      sourceDocumentId: null,
      evidenceIds: [],
      observationIds: [],
      proposalIds: [],
      modelUsageIds: [],
    };
  }

  return getDatabase().transaction(async (tx) => {
    const [createdSource] = await tx
      .insert(dataSources)
      .values({
        name: "Discovery fetch",
        sourceType: "web_page",
        baseUrl: document.canonicalUrl,
        access: "public",
        ingestion: "web_fetch",
        notes: "Created by bounded discovery research.",
      })
      .onConflictDoNothing()
      .returning({ id: dataSources.id });
    const dataSourceId =
      createdSource?.id ??
      (
        await tx
          .select({ id: dataSources.id })
          .from(dataSources)
          .where(sql`lower(${dataSources.baseUrl}) = ${document.canonicalUrl.toLowerCase()}`)
          .limit(1)
      )[0]?.id;
    if (dataSourceId === undefined) {
      throw new Error("Unable to persist discovery source");
    }

    const [insertedDocument] = await tx
      .insert(sourceDocuments)
      .values({
        dataSourceId,
        canonicalUrl: document.canonicalUrl,
        title: document.title,
        documentType: "web_page",
        retrievedAt: new Date(document.retrievedAt),
        contentSha256: document.contentSha256,
        mimeType: document.mimeType,
        byteLength: document.byteLength,
        metadata: { researchRunId: input.researchRunId },
      })
      .onConflictDoNothing()
      .returning({ id: sourceDocuments.id });
    const storedDocument =
      insertedDocument ??
      (
        await tx
          .select({ id: sourceDocuments.id })
          .from(sourceDocuments)
          .where(eq(sourceDocuments.contentSha256, document.contentSha256))
          .limit(1)
      )[0];
    if (!storedDocument) throw new Error("Unable to persist discovery document");

    const evidenceIds: string[] = [];
    const observationIds: string[] = [];
    const proposalIds: string[] = [];
    for (const candidate of input.result.candidates) {
      const legal = normalizeLegalName(candidate.legalName);
      const [nameMatch] = await tx
        .select({ id: companies.id })
        .from(companies)
        .where(
          sql`lower(regexp_replace(btrim(${companies.legalName}), '\\s+', ' ', 'g')) = ${legal}`,
        )
        .limit(1);
      const [created] = nameMatch
        ? []
        : await tx
            .insert(companies)
            .values({
              legalName: candidate.legalName.trim(),
              displayName: candidate.displayName.trim(),
              description: candidate.description,
              websiteUrl: candidate.website,
            })
            .returning({ id: companies.id });
      const companyId = nameMatch?.id ?? created?.id;
      if (!companyId) throw new Error("Unable to resolve discovery company");
      await tx
        .insert(companySourceLinks)
        .values({
          dataSourceId,
          companyId,
          relationship: "mentions",
        })
        .onConflictDoNothing();
      await tx.insert(sourceDocumentLinks).values({
        sourceDocumentId: storedDocument.id,
        companyId,
        relationship: "mentions",
      });
      const [evidenceRow] = await tx
        .insert(evidence)
        .values({
          sourceDocumentId: storedDocument.id,
          extractionStatus: "completed",
          quote: candidate.evidenceExcerpt,
          locator: document.canonicalUrl,
          extractionMethod: "discover_research_model",
          contentSha256: digest(candidate.evidenceExcerpt),
          metadata: { researchRunId: input.researchRunId },
        })
        .returning({ id: evidence.id });
      if (!evidenceRow) throw new Error("Unable to persist discovery evidence");
      evidenceIds.push(evidenceRow.id);
      const [observation] = await tx
        .insert(observations)
        .values({
          subjectType: "company",
          subjectId: companyId,
          fieldKey: "description",
          valueKind: "text",
          value: candidate.description,
          normalizedText: candidate.description,
          confidence: String(candidate.confidence),
          evidenceId: evidenceRow.id,
          reviewStatus: "pending",
          conflictStatus: "none",
        })
        .returning({ id: observations.id });
      if (!observation) throw new Error("Unable to persist discovery observation");
      observationIds.push(observation.id);
      const [proposal] = await tx
        .insert(researchProposals)
        .values({
          researchRunId: input.researchRunId,
          observationId: observation.id,
          subjectType: "company",
          subjectId: companyId,
          fieldKey: "description",
          rationale: "Discovery candidate extracted from a fetched public document.",
        })
        .returning({ id: researchProposals.id });
      if (!proposal) throw new Error("Unable to persist discovery proposal");
      proposalIds.push(proposal.id);
    }

    return {
      dataSourceId,
      sourceDocumentId: storedDocument.id,
      evidenceIds,
      observationIds,
      proposalIds,
      modelUsageIds: [],
    };
  });
}
