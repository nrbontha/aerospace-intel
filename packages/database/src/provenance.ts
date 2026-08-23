import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  link,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { getDatabase } from "./client.js";
import { normalizePagination, type PageInput, type PageResult } from "./repositories.js";
import { normalizeComparableHttpUrl, searchContains } from "./search.js";
import {
  auditEvents,
  companies,
  companyDomains,
  companySourceLinks,
  dataSources,
  entityMerges,
  evidence,
  modelUsage,
  observations,
  researchProposals,
  researchToolCalls,
  sourceDocumentLinks,
  sourceDocuments,
} from "./schema.js";

export const researchRunStatuses = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type ResearchRunStatus = (typeof researchRunStatuses)[number];
const transitions: Readonly<
  Record<ResearchRunStatus, readonly ResearchRunStatus[]>
> = {
  queued: ["running", "failed", "cancelled"],
  running: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};
export class IllegalResearchRunTransitionError extends Error {
  constructor(
    readonly currentStatus: ResearchRunStatus,
    readonly nextStatus: ResearchRunStatus,
  ) {
    super(`Illegal research run transition: ${currentStatus} -> ${nextStatus}`);
    this.name = "IllegalResearchRunTransitionError";
  }
}
export function canTransitionResearchRun(
  current: ResearchRunStatus,
  next: ResearchRunStatus,
): boolean {
  return current === next || transitions[current].includes(next);
}
export function assertResearchRunTransition(
  current: ResearchRunStatus,
  next: ResearchRunStatus,
): void {
  if (!canTransitionResearchRun(current, next))
    throw new IllegalResearchRunTransitionError(current, next);
}
export interface ResearchRunStateSnapshot {
  status: ResearchRunStatus;
  progressPercent: number | null;
  startedAt: Date | null;
  completedAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
}
export interface ResearchRunStateChange {
  status: ResearchRunStatus;
  progressPercent?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  now?: Date;
}
export function deriveResearchRunState(
  current: ResearchRunStateSnapshot,
  change: ResearchRunStateChange,
): ResearchRunStateSnapshot {
  assertResearchRunTransition(current.status, change.status);
  const now = change.now ?? new Date();
  const prior = current.progressPercent ?? 0;
  let progress = change.progressPercent ?? prior;
  if (!Number.isFinite(progress) || progress < 0 || progress > 100)
    throw new RangeError("Research run progress must be between 0 and 100");
  if (progress < prior)
    throw new RangeError("Research run progress cannot decrease");
  if (change.status === "succeeded") progress = 100;
  const terminal = ["succeeded", "failed", "cancelled"].includes(change.status);
  return {
    status: change.status,
    progressPercent: progress,
    startedAt: current.startedAt ?? (change.status === "running" ? now : null),
    completedAt: current.completedAt ?? (terminal ? now : null),
    errorCode:
      change.status === "failed"
        ? (change.errorCode ?? current.errorCode ?? "research_failed")
        : null,
    errorMessage:
      change.status === "failed"
        ? (change.errorMessage ?? current.errorMessage ?? "Research failed")
        : null,
  };
}
export function normalizeLegalName(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("en-US");
}
export function normalizeDomain(value: string): string | null {
  const input = value.trim();
  if (!input) return null;
  try {
    const url = new URL(input.includes("://") ? input : `https://${input}`);
    if (!url.protocol.match(/^https?:$/u)) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/u, "");
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return null;
  }
}
export type ObservationValueKind =
  | "text"
  | "number"
  | "boolean"
  | "date"
  | "money"
  | "range"
  | "entity_reference"
  | "structured";
export function inferObservationValueKind(
  value: unknown,
): ObservationValueKind {
  return typeof value === "string"
    ? "text"
    : typeof value === "number"
      ? "number"
      : typeof value === "boolean"
        ? "boolean"
        : "structured";
}
export function isEditedProposalValue(value: unknown): boolean {
  return value !== undefined;
}

interface Attempt {
  readonly attempt: number;
  readonly model: string;
  readonly provider: string | null;
  readonly status: string;
  readonly httpStatus: number | null;
  readonly promptSha256: string;
  readonly responseSha256: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
  readonly latencyMs: number;
  readonly errorCode: string | null;
}
interface CompletedResult {
  readonly status: "completed";
  readonly sourceDocuments: readonly [
    {
      readonly canonicalUrl: string;
      readonly title: string;
      readonly mimeType: string;
      readonly byteLength: number;
      readonly contentSha256: string;
      readonly retrievedAt: string;
      readonly metadata: Record<string, unknown>;
    },
  ];
  readonly companyCandidates: readonly {
    readonly legalName: string;
    readonly displayName: string;
    readonly website: string | null;
    readonly description: string;
    readonly evidenceExcerpt: string;
    readonly confidence: number;
    readonly observations: readonly {
      readonly fieldKey: string;
      readonly value: unknown;
      readonly evidenceExcerpt: string;
      readonly confidence: number;
    }[];
  }[];
  readonly sourceDescription: string | null;
  readonly publisher: string | null;
  readonly accessAssessment: {
    readonly status: string;
    readonly rationale: string;
  };
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
    };
    readonly model: {
      readonly route: string;
      readonly schemaName: string;
      readonly schemaSha256: string;
      readonly responseSha256: string;
      readonly provider: string;
      readonly attempts: readonly Attempt[];
    };
  };
}
export interface RecordSourceResearchArtifactsInput {
  readonly dataSourceId: string;
  readonly researchRunId: string;
  readonly result: CompletedResult;
}
export interface RecordedSourceResearchArtifacts {
  readonly sourceDocumentId: string;
  readonly companyIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly observationIds: readonly string[];
  readonly proposalIds: readonly string[];
  readonly modelUsageIds: readonly string[];
  readonly toolCallIds: readonly string[];
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function recordSourceResearchArtifacts(
  input: RecordSourceResearchArtifactsInput,
): Promise<RecordedSourceResearchArtifacts> {
  const outputSha256 = digest(canonicalJson(input.result));
  const document = input.result.sourceDocuments[0];
  return getDatabase().transaction(async (tx) => {
    const [duplicate] = await tx
      .select({ id: sourceDocuments.id })
      .from(sourceDocuments)
      .where(
        and(
          eq(sourceDocuments.dataSourceId, input.dataSourceId),
          sql`${sourceDocuments.metadata}->>'researchRunId' = ${input.researchRunId}`,
          sql`${sourceDocuments.metadata}->>'sourceOutputSha256' = ${outputSha256}`,
        ),
      )
      .limit(1);
    if (duplicate) {
      const rows = await tx
        .select({
          proposalId: researchProposals.id,
          observationId: observations.id,
          evidenceId: evidence.id,
          companyId: observations.subjectId,
        })
        .from(researchProposals)
        .innerJoin(
          observations,
          eq(observations.id, researchProposals.observationId),
        )
        .innerJoin(evidence, eq(evidence.id, observations.evidenceId))
        .where(
          and(
            eq(researchProposals.researchRunId, input.researchRunId),
            eq(evidence.sourceDocumentId, duplicate.id),
          ),
        );
      const models = await tx
        .select({ id: modelUsage.id })
        .from(modelUsage)
        .where(eq(modelUsage.researchRunId, input.researchRunId));
      const tools = await tx
        .select({ id: researchToolCalls.id })
        .from(researchToolCalls)
        .where(eq(researchToolCalls.researchRunId, input.researchRunId));
      return {
        sourceDocumentId: duplicate.id,
        companyIds: [...new Set(rows.map((r) => r.companyId))],
        evidenceIds: rows.map((r) => r.evidenceId),
        observationIds: rows.map((r) => r.observationId),
        proposalIds: rows.map((r) => r.proposalId),
        modelUsageIds: models.map((r) => r.id),
        toolCallIds: tools.map((r) => r.id),
      };
    }
    await tx
      .insert(researchToolCalls)
      .values({
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
        startedAt: new Date(
          Date.parse(document.retrievedAt) -
            input.result.telemetry.fetch.durationMs,
        ),
        completedAt: new Date(document.retrievedAt),
        durationMs: input.result.telemetry.fetch.durationMs,
      })
      .onConflictDoNothing();
    await tx
      .insert(modelUsage)
      .values(
        input.result.telemetry.model.attempts.map((attempt) => ({
          researchRunId: input.researchRunId,
          sequence: Math.max(0, attempt.attempt - 1),
          provider: attempt.provider ?? input.result.telemetry.model.provider,
          model: attempt.model,
          status:
            attempt.status === "succeeded"
              ? ("succeeded" as const)
              : ("failed" as const),
          promptSha256: attempt.promptSha256,
          responseSha256: attempt.responseSha256,
          request: {
            route: input.result.telemetry.model.route,
            schemaName: input.result.telemetry.model.schemaName,
            schemaSha256: input.result.telemetry.model.schemaSha256,
          },
          response: {
            aggregateResponseSha256:
              input.result.telemetry.model.responseSha256,
            telemetry: attempt,
          },
          inputTokens: attempt.inputTokens,
          outputTokens: attempt.outputTokens,
          costUsd: attempt.costUsd === null ? null : String(attempt.costUsd),
          latencyMs: attempt.latencyMs,
          error:
            attempt.errorCode === null ? null : { code: attempt.errorCode },
        })),
      )
      .onConflictDoNothing();
    const persistedModels = await tx
      .select({ id: modelUsage.id })
      .from(modelUsage)
      .where(eq(modelUsage.researchRunId, input.researchRunId));
    const [insertedDocument] = await tx
      .insert(sourceDocuments)
      .values({
        dataSourceId: input.dataSourceId,
        canonicalUrl: document.canonicalUrl,
        title: document.title,
        documentType: "web_page",
        retrievedAt: new Date(document.retrievedAt),
        contentSha256: document.contentSha256,
        mimeType: document.mimeType,
        byteLength: document.byteLength,
        metadata: {
          ...document.metadata,
          accessAssessment: input.result.accessAssessment,
          promptVersion: input.result.telemetry.promptVersion,
          researchRunId: input.researchRunId,
          sourceDescription: input.result.sourceDescription,
          sourceOutputSha256: outputSha256,
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
    const companyIds: string[] = [],
      evidenceIds: string[] = [],
      observationIds: string[] = [],
      proposalIds: string[] = [];
    for (const candidate of input.result.companyCandidates) {
      const legal = normalizeLegalName(candidate.legalName),
        domain = normalizeDomain(candidate.website ?? "");
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${domain ?? legal}, 0))`,
      );
      const [domainMatch] =
        domain === null
          ? []
          : await tx
              .select({ id: companies.id })
              .from(companyDomains)
              .innerJoin(companies, eq(companies.id, companyDomains.companyId))
              .where(sql`lower(${companyDomains.domain}) = ${domain}`)
              .limit(1);
      const [nameMatch] = await tx
        .select({ id: companies.id })
        .from(companies)
        .where(
          sql`lower(regexp_replace(btrim(${companies.legalName}), '\s+', ' ', 'g')) = ${legal}`,
        )
        .limit(1);
      const [created] =
        !domainMatch && !nameMatch
          ? await tx
              .insert(companies)
              .values({
                legalName: candidate.legalName.trim(),
                displayName: candidate.displayName.trim(),
                description: candidate.description,
                websiteUrl: candidate.website,
              })
              .returning({ id: companies.id })
          : [];
      const companyId = domainMatch?.id ?? nameMatch?.id ?? created?.id;
      if (!companyId)
        throw new Error("Unable to resolve exact company identity");
      companyIds.push(companyId);
      if (domain)
        await tx
          .insert(companyDomains)
          .values({ companyId, domain, isPrimary: true })
          .onConflictDoNothing();
      await tx
        .insert(companySourceLinks)
        .values({
          dataSourceId: input.dataSourceId,
          companyId,
          relationship: "mentions",
        })
        .onConflictDoNothing();
      await tx
        .insert(sourceDocumentLinks)
        .values({
          sourceDocumentId: storedDocument.id,
          companyId,
          relationship: "mentions",
        });
      for (const item of candidate.observations) {
        const [e] = await tx
          .insert(evidence)
          .values({
            sourceDocumentId: storedDocument.id,
            extractionStatus: "completed",
            quote: item.evidenceExcerpt,
            locator: document.canonicalUrl,
            extractionMethod: "source_research_model",
            contentSha256: digest(item.evidenceExcerpt),
            metadata: {
              candidateLegalName: candidate.legalName,
              researchRunId: input.researchRunId,
            },
          })
          .returning({ id: evidence.id });
        if (!e) throw new Error("Unable to persist evidence");
        evidenceIds.push(e.id);
        const [o] = await tx
          .insert(observations)
          .values({
            subjectType: "company",
            subjectId: companyId,
            fieldKey: item.fieldKey,
            valueKind: inferObservationValueKind(item.value),
            value: item.value,
            normalizedText:
              typeof item.value === "string"
                ? item.value.normalize("NFKC").trim().replace(/\s+/gu, " ")
                : null,
            confidence: String(item.confidence),
            evidenceId: e.id,
            reviewStatus: "pending",
            conflictStatus: "none",
          })
          .returning({ id: observations.id });
        if (!o) throw new Error("Unable to persist observation");
        observationIds.push(o.id);
        const [p] = await tx
          .insert(researchProposals)
          .values({
            researchRunId: input.researchRunId,
            observationId: o.id,
            subjectType: "company",
            subjectId: companyId,
            fieldKey: item.fieldKey,
            rationale: `Evidence-backed extraction with exact ${domain ? "domain" : "normalized legal-name"} identity.`,
            proposedByModelUsageId: persistedModels.at(-1)?.id,
          })
          .returning({ id: researchProposals.id });
        if (!p) throw new Error("Unable to persist proposal");
        proposalIds.push(p.id);
      }
    }
    const tools = await tx
      .select({ id: researchToolCalls.id })
      .from(researchToolCalls)
      .where(eq(researchToolCalls.researchRunId, input.researchRunId));
    return {
      sourceDocumentId: storedDocument.id,
      companyIds: [...new Set(companyIds)],
      evidenceIds,
      observationIds,
      proposalIds,
      modelUsageIds: persistedModels.map((r) => r.id),
      toolCallIds: tools.map((r) => r.id),
    };
  });
}


interface CompanyResearchCompletedResult {
  readonly status: "completed";
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
    /** finalUrl of the document the excerpt came from (homepage when absent). */
    readonly sourceUrl?: string;
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
    };
    readonly model: {
      readonly route: string;
      readonly schemaName: string;
      readonly schemaSha256: string;
      readonly responseSha256: string;
      readonly provider: string;
      readonly attempts: readonly Attempt[];
    };
  };
}

export interface RecordCompanyResearchArtifactsInput {
  readonly companyId: string;
  readonly researchRunId: string;
  readonly result: CompanyResearchCompletedResult;
}

export interface RecordedCompanyResearchArtifacts {
  readonly dataSourceId: string;
  readonly sourceDocumentId: string;
  readonly sourceDocumentIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly observationIds: readonly string[];
  readonly proposalIds: readonly string[];
  readonly modelUsageIds: readonly string[];
  readonly toolCallIds: readonly string[];
}

export async function recordCompanyResearchArtifacts(
  input: RecordCompanyResearchArtifactsInput,
): Promise<RecordedCompanyResearchArtifacts> {
  const outputSha256 = digest(canonicalJson(input.result));
  const document = input.result.sourceDocuments[0];
  if (document === undefined) {
    throw new Error("Unable to persist company research: no source documents");
  }
  return getDatabase().transaction(async (tx) => {
    const [company] = await tx
      .select({
        id: companies.id,
        legalName: companies.legalName,
      })
      .from(companies)
      .where(eq(companies.id, input.companyId))
      .for("update");
    if (!company) {
      throw new Error("Unable to persist company research: company missing");
    }

    const [duplicate] = await tx
      .select({
        id: sourceDocuments.id,
        dataSourceId: sourceDocuments.dataSourceId,
      })
      .from(sourceDocuments)
      .where(
        and(
          sql`${sourceDocuments.metadata}->>'researchRunId' = ${input.researchRunId}`,
          sql`${sourceDocuments.metadata}->>'sourceOutputSha256' = ${outputSha256}`,
        ),
      )
      .limit(1);
    if (duplicate) {
      const rows = await tx
        .select({
          proposalId: researchProposals.id,
          observationId: observations.id,
          evidenceId: evidence.id,
        })
        .from(researchProposals)
        .innerJoin(
          observations,
          eq(observations.id, researchProposals.observationId),
        )
        .innerJoin(evidence, eq(evidence.id, observations.evidenceId))
        .where(
          and(
            eq(researchProposals.researchRunId, input.researchRunId),
            sql`${evidence.metadata}->>'researchRunId' = ${input.researchRunId}`,
          ),
        );
      const duplicateDocumentIds = await tx
        .selectDistinct({ id: evidence.sourceDocumentId })
        .from(evidence)
        .where(sql`${evidence.metadata}->>'researchRunId' = ${input.researchRunId}`);
      const models = await tx
        .select({ id: modelUsage.id })
        .from(modelUsage)
        .where(eq(modelUsage.researchRunId, input.researchRunId));
      const tools = await tx
        .select({ id: researchToolCalls.id })
        .from(researchToolCalls)
        .where(eq(researchToolCalls.researchRunId, input.researchRunId));
      return {
        dataSourceId: duplicate.dataSourceId,
        sourceDocumentId: duplicate.id,
        sourceDocumentIds: duplicateDocumentIds
          .map((row) => row.id)
          .filter((id): id is string => id !== null),
        evidenceIds: rows.map((row) => row.evidenceId),
        observationIds: rows.map((row) => row.observationId),
        proposalIds: rows.map((row) => row.proposalId),
        modelUsageIds: models.map((row) => row.id),
        toolCallIds: tools.map((row) => row.id),
      };
    }

    const normalizedUrl = normalizeComparableHttpUrl(document.canonicalUrl);
    const [urlMatch] = await tx
      .select({ id: dataSources.id })
      .from(dataSources)
      .where(
        sql`regexp_replace(lower(trim(both from coalesce(${dataSources.baseUrl}, ''))), '/+$', '') = ${normalizedUrl}`,
      )
      .limit(1);
    const [linked] = await tx
      .select({ id: dataSources.id })
      .from(companySourceLinks)
      .innerJoin(
        dataSources,
        eq(dataSources.id, companySourceLinks.dataSourceId),
      )
      .where(eq(companySourceLinks.companyId, company.id))
      .limit(1);
    let dataSourceId = urlMatch?.id ?? linked?.id;
    if (dataSourceId === undefined) {
      const [created] = await tx
        .insert(dataSources)
        .values({
          name: `${company.legalName} website`,
          sourceType: "company_website",
          baseUrl: document.canonicalUrl,
          access: "public",
          ingestion: "web_fetch",
          publisher: company.legalName,
          notes: "Created by company research from a public website fetch.",
        })
        .onConflictDoNothing()
        .returning({ id: dataSources.id });
      dataSourceId =
        created?.id ??
        (
          await tx
            .select({ id: dataSources.id })
            .from(dataSources)
            .where(
              sql`lower(${dataSources.name}) = ${`${company.legalName} website`.toLowerCase()}`,
            )
            .limit(1)
        )[0]?.id;
    }
    if (dataSourceId === undefined) {
      throw new Error("Unable to persist company research source");
    }

    await tx
      .insert(companySourceLinks)
      .values({
        dataSourceId,
        companyId: company.id,
        relationship: "subject",
      })
      .onConflictDoNothing();

    await tx
      .insert(researchToolCalls)
      .values({
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
        startedAt: new Date(
          Date.parse(document.retrievedAt) -
            input.result.telemetry.fetch.durationMs,
        ),
        completedAt: new Date(document.retrievedAt),
        durationMs: input.result.telemetry.fetch.durationMs,
      })
      .onConflictDoNothing();
    await tx
      .insert(modelUsage)
      .values(
        input.result.telemetry.model.attempts.map((attempt) => ({
          researchRunId: input.researchRunId,
          sequence: Math.max(0, attempt.attempt - 1),
          provider: attempt.provider ?? input.result.telemetry.model.provider,
          model: attempt.model,
          status:
            attempt.status === "succeeded"
              ? ("succeeded" as const)
              : ("failed" as const),
          promptSha256: attempt.promptSha256,
          responseSha256: attempt.responseSha256,
          request: {
            route: input.result.telemetry.model.route,
            schemaName: input.result.telemetry.model.schemaName,
            schemaSha256: input.result.telemetry.model.schemaSha256,
          },
          response: {
            aggregateResponseSha256:
              input.result.telemetry.model.responseSha256,
            telemetry: attempt,
          },
          inputTokens: attempt.inputTokens,
          outputTokens: attempt.outputTokens,
          costUsd: attempt.costUsd === null ? null : String(attempt.costUsd),
          latencyMs: attempt.latencyMs,
          error:
            attempt.errorCode === null ? null : { code: attempt.errorCode },
        })),
      )
      .onConflictDoNothing();
    const persistedModels = await tx
      .select({ id: modelUsage.id })
      .from(modelUsage)
      .where(eq(modelUsage.researchRunId, input.researchRunId));
    // Persist EVERY fetched document (homepage + subpages) as its own
    // source_documents row so per-document evidence attribution is possible.
    const documentIdsByNormalizedUrl = new Map<string, string>();
    const storedDocumentIds: string[] = [];
    let homepageDocumentId: string | null = null;
    for (const [index, doc] of input.result.sourceDocuments.entries()) {
      // Dedupe on the content hash FIRST: replayed results (or results whose
      // whole-result digest drifted, e.g. fresh timestamps) must reuse the
      // existing row instead of inserting a duplicate.
      let stored =
        (
          await tx
            .select({ id: sourceDocuments.id })
            .from(sourceDocuments)
            .where(eq(sourceDocuments.contentSha256, doc.contentSha256))
            .limit(1)
        )[0] ??
        (
          await tx
            .insert(sourceDocuments)
            .values({
              dataSourceId,
              canonicalUrl: doc.canonicalUrl,
              title: doc.title,
              documentType: "web_page",
              retrievedAt: new Date(doc.retrievedAt),
              contentSha256: doc.contentSha256,
              mimeType: doc.mimeType,
              byteLength: doc.byteLength,
              metadata: {
                ...doc.metadata,
                promptVersion: input.result.telemetry.promptVersion,
                researchRunId: input.researchRunId,
                sourceOutputSha256: outputSha256,
                ...(index === 0 ? {} : { homepageCanonicalUrl: document.canonicalUrl }),
              },
            })
            .onConflictDoNothing()
            .returning({ id: sourceDocuments.id })
        )[0];
      stored ??= (
        await tx
          .select({ id: sourceDocuments.id })
          .from(sourceDocuments)
          .where(eq(sourceDocuments.contentSha256, doc.contentSha256))
          .limit(1)
      )[0];
      if (!stored) throw new Error("Unable to persist source document");

      await tx
        .insert(sourceDocumentLinks)
        .values({
          sourceDocumentId: stored.id,
          companyId: company.id,
          relationship: "subject",
        })
        .onConflictDoNothing();

      documentIdsByNormalizedUrl.set(normalizeComparableHttpUrl(doc.canonicalUrl), stored.id);
      storedDocumentIds.push(stored.id);
      if (index === 0) homepageDocumentId = stored.id;
    }
    if (homepageDocumentId === null) homepageDocumentId = storedDocumentIds[0] ?? null;
    if (homepageDocumentId === null) throw new Error("Unable to persist source document");
    const homepageLocator = document.canonicalUrl;

    const existing = await tx
      .select({
        fieldKey: observations.fieldKey,
        normalizedText: observations.normalizedText,
        value: observations.value,
      })
      .from(observations)
      .where(
        and(
          eq(observations.subjectType, "company"),
          eq(observations.subjectId, company.id),
        ),
      );
    const existingKeys = new Set(
      existing.map(
        (row) =>
          `${row.fieldKey}:${(row.normalizedText ?? JSON.stringify(row.value)).replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US")}`,
      ),
    );

    const evidenceIds: string[] = [];
    const observationIds: string[] = [];
    const proposalIds: string[] = [];
    for (const fact of input.result.facts) {
      const normalizedText =
        typeof fact.value === "string"
          ? fact.value.normalize("NFKC").trim().replace(/\s+/gu, " ")
          : null;
      const key = `${fact.fieldKey}:${(normalizedText ?? JSON.stringify(fact.value)).replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US")}`;
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);

      // Attribute the excerpt to the document it was verified against; fall
      // back to the homepage with an explicit locator note when the fact
      // predates per-document attribution (or its URL no longer resolves).
      const factDocId =
        (fact.sourceUrl === undefined
          ? undefined
          : documentIdsByNormalizedUrl.get(normalizeComparableHttpUrl(fact.sourceUrl))) ??
        homepageDocumentId;
      const fallbackAttribution = fact.sourceUrl === undefined ||
        !documentIdsByNormalizedUrl.has(normalizeComparableHttpUrl(fact.sourceUrl));
      const [evidenceRow] = await tx
        .insert(evidence)
        .values({
          sourceDocumentId: factDocId,
          extractionStatus: "completed",
          quote: fact.evidenceExcerpt,
          locator: fallbackAttribution ? `${homepageLocator} (homepage)` : fact.sourceUrl!,
          extractionMethod: "company_research_model",
          contentSha256: digest(fact.evidenceExcerpt),
          metadata: {
            companyId: company.id,
            researchRunId: input.researchRunId,
          },
        })
        .returning({ id: evidence.id });
      if (!evidenceRow) throw new Error("Unable to persist evidence");
      evidenceIds.push(evidenceRow.id);

      const [observation] = await tx
        .insert(observations)
        .values({
          subjectType: "company",
          subjectId: company.id,
          fieldKey: fact.fieldKey,
          valueKind: inferObservationValueKind(fact.value),
          value: fact.value,
          normalizedText,
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
          subjectType: "company",
          subjectId: company.id,
          fieldKey: fact.fieldKey,
          rationale:
            "Evidence-backed company research against an existing company identity.",
          proposedByModelUsageId: persistedModels.at(-1)?.id,
        })
        .returning({ id: researchProposals.id });
      if (!proposal) throw new Error("Unable to persist proposal");
      proposalIds.push(proposal.id);
    }

    const tools = await tx
      .select({ id: researchToolCalls.id })
      .from(researchToolCalls)
      .where(eq(researchToolCalls.researchRunId, input.researchRunId));
    return {
      dataSourceId,
      sourceDocumentId: homepageDocumentId,
      sourceDocumentIds: storedDocumentIds,
      evidenceIds,
      observationIds,
      proposalIds,
      modelUsageIds: persistedModels.map((row) => row.id),
      toolCallIds: tools.map((row) => row.id),
    };
  });
}

export interface StoredDocumentDescriptor {
  readonly storageKey: string;
  readonly contentSha256: string;
  readonly byteLength: number;
}
function storageRoot(): string {
  const value = process.env.STORAGE_PATH?.trim();
  if (!value) throw new Error("STORAGE_PATH is required");
  return path.resolve(value);
}
function safeKey(key: string): string {
  if (!key || key.includes("\0") || path.isAbsolute(key))
    throw new Error("Unsafe storage key");
  const value = path.normalize(key);
  if (value === "." || value === ".." || value.startsWith(`..${path.sep}`))
    throw new Error("Storage traversal rejected");
  return value;
}
async function storageTarget(key: string): Promise<string> {
  const root = storageRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const actualRoot = await realpath(root),
    target = path.resolve(actualRoot, safeKey(key));
  if (!target.startsWith(`${actualRoot}${path.sep}`))
    throw new Error("Storage traversal rejected");
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const parent = await realpath(path.dirname(target));
  if (parent !== actualRoot && !parent.startsWith(`${actualRoot}${path.sep}`))
    throw new Error("Storage symlink traversal rejected");
  return path.join(parent, path.basename(target));
}
export async function writeStoredDocument(
  storageKey: string,
  content: Uint8Array,
  expectedSha256?: string,
): Promise<StoredDocumentDescriptor> {
  const contentSha256 = digest(content);
  if (
    expectedSha256 &&
    contentSha256.toLowerCase() !== expectedSha256.toLowerCase()
  )
    throw new Error("Stored document digest mismatch");
  const target = await storageTarget(storageKey),
    temporary = `${target}.${randomUUID()}.tmp`;
  const handle = await open(
    temporary,
    fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_WRONLY |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, target);
  } catch (error) {
    if (!(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EEXIST"
    ))
      throw error;
    await readStoredDocument(storageKey, contentSha256);
  } finally {
    await rm(temporary, { force: true });
  }
  return { storageKey, contentSha256, byteLength: content.byteLength };
}
export async function readStoredDocument(
  storageKey: string,
  expectedSha256: string,
): Promise<Buffer> {
  if (!/^[a-f\d]{64}$/iu.test(expectedSha256))
    throw new Error("Invalid SHA-256 digest");
  const target = await storageTarget(storageKey),
    info = await stat(target);
  if (!info.isFile()) throw new Error("Stored document is not a file");
  const content = await readFile(target);
  if (digest(content).toLowerCase() !== expectedSha256.toLowerCase())
    throw new Error("Stored document digest verification failed");
  return content;
}

interface Snapshot {
  id: string;
  legalName: string;
  displayName: string;
  description: string | null;
  status: "active" | "inactive" | "acquired" | "defunct" | "unknown";
  headquartersCountryCode: string | null;
  websiteUrl: string | null;
  foundedYear: number | null;
}
export interface MergeCompanyRecordsInput {
  readonly sourceCompanyId: string;
  readonly targetCompanyId: string;
  readonly reason: string;
  readonly actorUserId?: string;
  readonly requestId?: string;
}
export async function mergeCompanyRecordsById(
  input: MergeCompanyRecordsInput,
): Promise<{ mergeId: string }> {
  if (input.sourceCompanyId === input.targetCompanyId)
    throw new Error("Company IDs must differ");
  return getDatabase().transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(companies)
      .where(
        sql`${companies.id} in (${input.sourceCompanyId}, ${input.targetCompanyId})`,
      )
      .for("update");
    const source = rows.find((r) => r.id === input.sourceCompanyId),
      target = rows.find((r) => r.id === input.targetCompanyId);
    if (!source || !target)
      throw new Error("Both exact company IDs must exist");
    const after = {
      description: target.description ?? source.description,
      headquartersCountryCode:
        target.headquartersCountryCode ?? source.headquartersCountryCode,
      websiteUrl: target.websiteUrl ?? source.websiteUrl,
      foundedYear: target.foundedYear ?? source.foundedYear,
    };
    const [updated] = await tx
      .update(companies)
      .set({ ...after, updatedAt: new Date() })
      .where(eq(companies.id, target.id))
      .returning();
    await tx
      .update(companies)
      .set({ status: "inactive", updatedAt: new Date() })
      .where(eq(companies.id, source.id));
    const [merge] = await tx
      .insert(entityMerges)
      .values({
        entityType: "company",
        sourceEntityId: source.id,
        targetEntityId: target.id,
        reason: input.reason,
        sourceSnapshot: source,
        targetSnapshotBefore: target,
        targetSnapshotAfter: updated ?? { ...target, ...after },
        mergedByUserId: input.actorUserId,
      })
      .returning({ id: entityMerges.id });
    if (!merge) throw new Error("Unable to record merge");
    await tx
      .insert(auditEvents)
      .values({
        actorUserId: input.actorUserId,
        action: "company.merge",
        entityType: "entity_merge",
        entityId: merge.id,
        requestId: input.requestId,
        before: { source, target },
        after,
        metadata: { reason: input.reason },
      });
    return { mergeId: merge.id };
  });
}
export async function revertCompanyMergeById(
  mergeId: string,
  input: {
    readonly actorUserId?: string;
    readonly reason: string;
    readonly requestId?: string;
  },
): Promise<void> {
  await getDatabase().transaction(async (tx) => {
    const [merge] = await tx
      .select()
      .from(entityMerges)
      .where(eq(entityMerges.id, mergeId))
      .for("update");
    if (!merge || merge.entityType !== "company" || merge.status !== "applied")
      throw new Error("Applied company merge not found");
    const source = merge.sourceSnapshot as Snapshot,
      target = merge.targetSnapshotBefore as Snapshot;
    const restore = async (value: Snapshot): Promise<void> => {
      await tx
        .update(companies)
        .set({
          legalName: value.legalName,
          displayName: value.displayName,
          description: value.description,
          status: value.status,
          headquartersCountryCode: value.headquartersCountryCode,
          websiteUrl: value.websiteUrl,
          foundedYear: value.foundedYear,
          updatedAt: new Date(),
        })
        .where(eq(companies.id, value.id));
    };
    await restore(source);
    await restore(target);
    await tx
      .update(entityMerges)
      .set({
        status: "reverted",
        revertedByUserId: input.actorUserId,
        revertedAt: new Date(),
      })
      .where(eq(entityMerges.id, merge.id));
    await tx
      .insert(auditEvents)
      .values({
        actorUserId: input.actorUserId,
        action: "company.merge_reverted",
        entityType: "entity_merge",
        entityId: merge.id,
        requestId: input.requestId,
        before: merge.targetSnapshotAfter,
        after: { source, target },
        metadata: { reason: input.reason },
      });
  });
}


export interface CompanyMergeListRecord {
  readonly id: string;
  readonly sourceEntityId: string;
  readonly targetEntityId: string;
  readonly sourceLegalName: string | null;
  readonly targetLegalName: string | null;
  readonly status: "applied" | "reverted";
  readonly reason: string;
  readonly mergedByUserId: string | null;
  readonly revertedByUserId: string | null;
  readonly mergedAt: Date;
  readonly revertedAt: Date | null;
}

const mergeSourceCompanies = alias(companies, "merge_source_companies");
const mergeTargetCompanies = alias(companies, "merge_target_companies");

export async function listCompanyMergeRecords(
  input: PageInput & {
    query?: string;
    companyId?: string;
    status?: "applied" | "reverted";
  },
): Promise<PageResult<CompanyMergeListRecord>> {
  const { page, pageSize, offset } = normalizePagination(input);
  const filters = [eq(entityMerges.entityType, "company")];
  if (input.companyId) {
    filters.push(
      or(
        eq(entityMerges.sourceEntityId, input.companyId),
        eq(entityMerges.targetEntityId, input.companyId),
      )!,
    );
  }
  if (input.status) {
    filters.push(eq(entityMerges.status, input.status));
  }
  const mergeQuery = searchContains(input.query);
  if (mergeQuery) {
    filters.push(
      or(
        ilike(mergeSourceCompanies.legalName, mergeQuery),
        ilike(mergeTargetCompanies.legalName, mergeQuery),
        ilike(entityMerges.reason, mergeQuery),
      )!,
    );
  }
  const where = and(...filters);
  const db = getDatabase();
  const [rows, total] = await Promise.all([
    db
      .select({
        id: entityMerges.id,
        sourceEntityId: entityMerges.sourceEntityId,
        targetEntityId: entityMerges.targetEntityId,
        sourceLegalName: mergeSourceCompanies.legalName,
        targetLegalName: mergeTargetCompanies.legalName,
        status: entityMerges.status,
        reason: entityMerges.reason,
        mergedByUserId: entityMerges.mergedByUserId,
        revertedByUserId: entityMerges.revertedByUserId,
        mergedAt: entityMerges.mergedAt,
        revertedAt: entityMerges.revertedAt,
      })
      .from(entityMerges)
      .leftJoin(
        mergeSourceCompanies,
        eq(mergeSourceCompanies.id, entityMerges.sourceEntityId),
      )
      .leftJoin(
        mergeTargetCompanies,
        eq(mergeTargetCompanies.id, entityMerges.targetEntityId),
      )
      .where(where)
      .orderBy(desc(entityMerges.mergedAt))
      .limit(pageSize)
      .offset(offset),
    db
      .select({ v: sql<number>`count(*)` })
      .from(entityMerges)
      .leftJoin(
        mergeSourceCompanies,
        eq(mergeSourceCompanies.id, entityMerges.sourceEntityId),
      )
      .leftJoin(
        mergeTargetCompanies,
        eq(mergeTargetCompanies.id, entityMerges.targetEntityId),
      )
      .where(where),
  ]);
  const totalCount = Number(total[0]?.v ?? 0);
  return {
    records: rows.map((row) => ({
      id: row.id,
      sourceEntityId: row.sourceEntityId,
      targetEntityId: row.targetEntityId,
      sourceLegalName: row.sourceLegalName,
      targetLegalName: row.targetLegalName,
      status: row.status,
      reason: row.reason,
      mergedByUserId: row.mergedByUserId,
      revertedByUserId: row.revertedByUserId,
      mergedAt: row.mergedAt,
      revertedAt: row.revertedAt,
    })),
    page,
    pageSize,
    total: Number.isFinite(totalCount) ? totalCount : 0,
  };
}
