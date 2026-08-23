import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";

import {
  candidates,
  getCandidateById,
  activeSnapshotMatchVerdicts,
  loadCanonicalCompanyState,
  buildFeatureRecordInput,
  ensureFeatureSnapshot,
  appendScoreRows,
  upsertCandidate,
  mapResearchRunInput,
  researchRuns,
  type Database,
} from "@asi/database";

import { htmlToText } from "../benchmarks/schema.js";
import {
  companyResearchExtractionSchema,
  companyResearchFieldKeyValues,
  resolveFetchUrl,
  type CompanyResearchFact,
  type CompanyResearchFieldKey,
  type CompanyResearchInput,
} from "../company-workflow.js";
import type { CandidateResearchJobPayload } from "../jobs.js";
import type {
  OpenRouterAttemptTelemetry,
  OpenRouterClient,
  OpenRouterModelRouting,
} from "../openrouter.js";
import { safeFetchUrl, type SafeFetchResult } from "../safe-fetch.js";
import { wrapUntrustedSourceJson } from "../untrusted-source.js";
import {
  computeConfidence,
  computeNovelty,
  evaluateProgram,
  extractFeatureVector,
  FEATURE_SCHEMA_VERSION,
  getChampionProgramOrFallback,
  partnerReviewPriority,
  researchPriority,
  routeCandidate,
  type FeatureVector,
  type NoveltyStatus,
  type ProgramEvaluation,
} from "../scoring-axial/index.js";

export const CANDIDATE_RESEARCH_JOB_NAME = "candidate-research.v1";
export const CANDIDATE_RESEARCH_PROMPT_VERSION = "candidate-research.v1";

const MAX_TOTAL_FETCHES = 3;
const MAX_LINKED_DOCUMENTS = MAX_TOTAL_FETCHES - 1;
const MAX_PROMPT_CHARACTERS = 120_000;
const IDEMPOTENCY_WINDOW_SECONDS = 24 * 60 * 60;


/**
 * Explicit JSON contract in the prompt: some free-tier gateways ignore
 * response_format json_schema, so the instructions themselves must carry the
 * output shape (the client adds a generic contract line too).
 */
const EXTRACTION_SYSTEM_PROMPT = `You extract conservative, reviewable facts about one named company from one untrusted source document.
Output contract — reply with exactly one raw JSON object, no markdown fences, no commentary:
{"facts":[{"fieldKey":"<one of description|website_url|headquarters_location|headquarters_country|capability|facility_name|facility_location|customer_name>","value":"<concise value>","evidenceExcerpt":"<verbatim excerpt from the document>","confidence":<0..1>}]}
Rules:
- Only report facts with a verbatim excerpt present in the document.
- Skip facts already listed as known unless the document supplies a clearly different value.
- Omit rather than guess. Return {"facts":[]} when nothing new is supported.`;

// ---------------------------------------------------------------------------
// Enqueue producer (same pg-boss wrapper pattern as apps/web research-queue)
// ---------------------------------------------------------------------------

export interface EnqueueCandidateResearchInput {
  readonly candidateId: string;
  readonly companyId: string;
  readonly domain: string;
}

export interface EnqueueCandidateResearchResult {
  readonly researchRunId: string;
  readonly jobId: string | null;
  readonly duplicate: boolean;
}

function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required to enqueue candidate research");
  }
  return databaseUrl;
}

function researchQueueName(): string {
  return process.env.RESEARCH_QUEUE_NAME ?? "research-jobs";
}

/** Insert a queued company-kind research run and enqueue the worker job. */
export async function enqueueCandidateResearch(
  db: Database,
  input: EnqueueCandidateResearchInput,
): Promise<EnqueueCandidateResearchResult> {
  const [run] = await db
    .insert(researchRuns)
    .values(
      mapResearchRunInput({
        targetType: "company",
        targetId: input.companyId,
        objective: `Deep candidate research for ${input.domain}.`,
        metadata: {
          kind: "company",
          candidateId: input.candidateId,
          domain: input.domain,
        },
        maxAttempts: 2,
        promptVersion: CANDIDATE_RESEARCH_PROMPT_VERSION,
      }),
    )
    .returning({ id: researchRuns.id });
  if (run === undefined) {
    throw new Error("candidate research run insert returned no row");
  }

  const payload: CandidateResearchJobPayload = {
    name: CANDIDATE_RESEARCH_JOB_NAME,
    researchRunId: run.id,
    companyId: input.companyId,
    domain: input.domain,
  };

  const boss = new PgBoss({
    application_name: "asi-candidate-research",
    connectionString: requireDatabaseUrl(),
  });
  boss.on("error", () => undefined);
  await boss.start();
  let jobId: string | null;
  try {
    await boss.createQueue(researchQueueName());
    jobId = await boss.send(researchQueueName(), payload, {
      singletonKey: `${CANDIDATE_RESEARCH_JOB_NAME}:${run.id}`,
      singletonSeconds: IDEMPOTENCY_WINDOW_SECONDS,
    });
  } finally {
    await boss
      .stop({ close: true, graceful: true, timeout: 10_000 })
      .catch(() => undefined);
  }

  return { researchRunId: run.id, jobId, duplicate: jobId === null };
}

// ---------------------------------------------------------------------------
// Workflow: bounded multi-page fetch + evidence-backed model extraction
// ---------------------------------------------------------------------------

const LINK_PATTERN =
  /about|products?|services|capabilities|company|contact|our-?story|who-we-are/iu;

/** Same-host about/products-style links parsed from raw homepage HTML anchors. */
export function collectCandidatePageLinks(
  html: string,
  baseUrl: string,
  limit: number = MAX_LINKED_DOCUMENTS,
): string[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*(["'])([\s\S]*?)\1/giu)) {
    const href = match[2]?.trim();
    if (href === undefined || href.length === 0 || href.startsWith("#")) continue;
    if (!LINK_PATTERN.test(href)) continue;
    let resolved: URL;
    try {
      resolved = new URL(href, base);
    } catch {
      continue;
    }
    if (resolved.hostname !== base.hostname) continue;
    if (!/^https?:$/u.test(resolved.protocol)) continue;
    resolved.hash = "";
    const url = resolved.toString();
    if (!found.includes(url) && url !== base.toString()) found.push(url);
    if (found.length >= limit) break;
  }
  return found;
}

const allowedFieldKeys = new Set<string>(companyResearchFieldKeyValues);
const fieldKeyAliases: Record<string, CompanyResearchFieldKey> = {
  website: "website_url",
  websiteurl: "website_url",
  headquarters: "headquarters_location",
  headquartersaddress: "headquarters_location",
  headquarterslocation: "headquarters_location",
  headquarterscountry: "headquarters_country",
  capabilities: "capability",
  marketsserved: "capability",
  productspecialization: "capability",
  process: "capability",
  facility: "facility_name",
  facilityname: "facility_name",
  operationslocations: "facility_location",
  facilitylocation: "facility_location",
  location: "facility_location",
  locations: "facility_location",
  customer: "customer_name",
  customername: "customer_name",
};

function canonicalFieldKey(value: string): CompanyResearchFieldKey | null {
  const normalized = value.trim().replace(/[\s-]+/gu, "_").toLowerCase();
  if (allowedFieldKeys.has(normalized)) return normalized as CompanyResearchFieldKey;
  return (
    fieldKeyAliases[normalized.replaceAll("_", "")] ??
    fieldKeyAliases[normalized] ??
    null
  );
}

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}

function containsExcerpt(documentText: string, excerpt: string): boolean {
  return normalizeText(documentText).includes(normalizeText(excerpt));
}

interface ResearchDocument {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly text: string;
  readonly fetch: SafeFetchResult;
}

export interface CandidateResearchOutcome {
  readonly status: "completed";
  /** Facts aggregated across all fetched documents, deduped against known state. */
  readonly facts: CompanyResearchFact[];
  readonly skippedFactCount: number;
  /** Every fetched document (homepage first), persisted for provenance. */
  readonly sourceDocuments: readonly {
    readonly canonicalUrl: string;
    readonly title: string;
    readonly mimeType: string;
    readonly byteLength: number;
    readonly contentSha256: string;
    readonly retrievedAt: string;
    readonly metadata: Record<string, unknown>;
  }[];
  readonly fetchTelemetry: {
    readonly toolName: "fetch_url";
    readonly requestedUrlSha256: string;
    readonly responseSha256: string;
    readonly finalUrl: string;
    readonly byteLength: number;
    readonly durationMs: number;
    readonly redirectCount: number;
  };
  readonly modelAttempts: readonly OpenRouterAttemptTelemetry[];
  readonly modelRoute: "fast" | "deep";
  readonly schemaName: string;
  readonly schemaSha256: string;
  readonly responseSha256: string;
  readonly provider: string;
  readonly fetchedUrls: readonly string[];
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
}

function sha256Of(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function toDocument(fetch: SafeFetchResult): ResearchDocument {
  return {
    requestedUrl: fetch.requestedUrl,
    finalUrl: fetch.finalUrl,
    text: htmlToText(fetch.content, fetch.contentType).slice(
      0,
      MAX_PROMPT_CHARACTERS,
    ),
    fetch,
  };
}

async function fetchDocument(url: string, signal?: AbortSignal): Promise<ResearchDocument> {
  return toDocument(await safeFetchUrl(url, signal === undefined ? {} : { signal }));
}

export interface RunCandidateResearchOptions {
  readonly client: OpenRouterClient;
  readonly models: OpenRouterModelRouting;
  readonly company: CompanyResearchInput;
  readonly signal?: AbortSignal;
}

/**
 * Bounded deep-research workflow: homepage fetch plus up to two same-host
 * about/products pages parsed from homepage anchors (≤3 fetch_url calls
 * total), one structured extraction per document, conservative aggregation.
 */
export async function runCandidateResearchWorkflow(
  options: RunCandidateResearchOptions,
): Promise<CandidateResearchOutcome> {
  const homepageUrl = resolveFetchUrl(options.company);
  if (homepageUrl === null) {
    throw new Error("missing_url: company has no public website or linked web source");
  }
  const signal = options.signal;
  const documents: ResearchDocument[] = [await fetchDocument(homepageUrl, signal)];
  const linkedUrls = collectCandidatePageLinks(
    documents[0]!.fetch.content,
    documents[0]!.finalUrl,
    MAX_LINKED_DOCUMENTS,
  ).slice(0, MAX_TOTAL_FETCHES - documents.length);
  for (const url of linkedUrls) {
    try {
      documents.push(await fetchDocument(url, signal));
    } catch {
      // A dead subpage must not fail the whole run; the homepage still counts.
    }
  }

  const known = new Set(
    options.company.knownFacts.map(
      (fact) => `${fact.fieldKey}:${normalizeText(String(fact.value))}`,
    ),
  );
  const facts: CompanyResearchFact[] = [];
  const seen = new Set<string>();
  let skippedFactCount = 0;
  const attempts: OpenRouterAttemptTelemetry[] = [];

  let first: ExtractionCall | undefined;
  for (const document of documents) {
    const extraction = await callExtraction(options, document);
    attempts.push(...extraction.telemetry.attempts);
    first ??= extraction;
    for (const fact of extraction.data.facts) {
      const fieldKey = canonicalFieldKey(fact.fieldKey);
      if (fieldKey === null || !containsExcerpt(document.text, fact.evidenceExcerpt)) {
        skippedFactCount += 1;
        continue;
      }
      const key = `${fieldKey}:${normalizeText(fact.value)}`;
      if (known.has(key) || seen.has(key)) {
        skippedFactCount += 1;
        continue;
      }
      facts.push({
        fieldKey,
        value: fieldKey === "website_url" ? fact.value.trim() : fact.value,
        evidenceExcerpt: fact.evidenceExcerpt,
        confidence: fact.confidence,
        sourceUrl: document.finalUrl,
      });
    }
  }

  const homepage = documents[0]!;
  const tokens = (
    key: "inputTokens" | "outputTokens" | "totalTokens" | "costUsd",
  ): number | null => {
    const values = attempts
      .map((attempt) => attempt[key])
      .filter((value): value is number => value !== null);
    return values.length === 0
      ? null
      : values.reduce((total, value) => total + value, 0);
  };

  return {
    status: "completed",
    facts,
    skippedFactCount,
    sourceDocuments: documents.map((document, index) => ({
      canonicalUrl: document.fetch.finalUrl,
      title:
        index === 0
          ? `${options.company.displayName} website`
          : document.fetch.finalUrl,
      mimeType: document.fetch.contentType,
      byteLength: document.fetch.byteLength,
      contentSha256: document.fetch.contentSha256,
      retrievedAt: document.fetch.retrievedAt,
      metadata: {
        requestedUrl: document.fetch.requestedUrl,
        redirects: document.fetch.redirects,
        ...(index === 0
          ? { additionalFetchedUrls: documents.slice(1).map((doc) => doc.finalUrl) }
          : {}),
      },
    })),
    fetchTelemetry: {
      toolName: "fetch_url",
      requestedUrlSha256: sha256Of(homepage.fetch.requestedUrl),
      responseSha256: homepage.fetch.contentSha256,
      finalUrl: homepage.fetch.finalUrl,
      byteLength: homepage.fetch.byteLength,
      durationMs: homepage.fetch.durationMs,
      redirectCount: homepage.fetch.redirects.length,
    },
    modelAttempts: attempts,
    modelRoute: first!.telemetry.route,
    schemaName: first!.telemetry.schemaName,
    schemaSha256: first!.telemetry.schemaSha256,
    responseSha256: first!.telemetry.responseSha256,
    provider: first!.telemetry.provider,
    fetchedUrls: documents.map((document) => document.finalUrl),
    inputTokens: tokens("inputTokens"),
    outputTokens: tokens("outputTokens"),
    totalTokens: tokens("totalTokens"),
    costUsd: tokens("costUsd"),
  };
}

interface ExtractionCall {
  readonly data: { readonly facts: readonly { fieldKey: string; value: string; evidenceExcerpt: string; confidence: number }[] };
  readonly telemetry: {
    readonly route: "fast" | "deep";
    readonly schemaName: string;
    readonly schemaSha256: string;
    readonly responseSha256: string;
    readonly provider: string;
    readonly attempts: readonly OpenRouterAttemptTelemetry[];
  };
}

async function callExtraction(
  options: RunCandidateResearchOptions,
  document: ResearchDocument,
): Promise<ExtractionCall> {
  const untrustedData = JSON.stringify({
    company: {
      id: options.company.id,
      legalName: options.company.legalName,
      displayName: options.company.displayName,
      websiteUrl: options.company.websiteUrl,
    },
    knownFacts: options.company.knownFacts,
    retrievedUrl: document.finalUrl,
    content: document.text,
  });
  return options.client.generateStructured({
    route: "fast",
    models: options.models,
    schemaName: "company_research_v1",
    schema: companyResearchExtractionSchema,
    systemPrompt: EXTRACTION_SYSTEM_PROMPT,
    prompt: wrapUntrustedSourceJson(untrustedData),
    maxOutputTokens: 6_000,
    maxAttempts: 3,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

// ---------------------------------------------------------------------------
// Rescore: canonical state → features → programs → appended score rows
// ---------------------------------------------------------------------------

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function sha256OfFeatures(features: FeatureVector): string {
  return createHash("sha256").update(stableStringify(features)).digest("hex");
}

function roundToScorePrecision(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100) / 100;
}

/** Fraction of scoring-relevant slots that are explicitly unknown. */
function unknownFraction(fv: FeatureVector): number {
  const slots: Array<boolean | string | null> = [
    fv.size.revenueBand,
    fv.size.employeesBand,
    fv.ownership.ownershipType,
    fv.businessModel.distributesProducts,
    fv.businessModel.pureService,
    fv.businessModel.buildToPrintShare,
    fv.aftermarket,
    ...Object.values(fv.qualifications),
    fv.evidence.freshestObservationDaysOld === null ? "unknown" : true,
  ];
  const unknownCount = slots.filter((slot) => slot === "unknown").length;
  return unknownCount / slots.length;
}

export interface CandidateRescoreResult {
  readonly candidateId: string;
  readonly scores: {
    readonly fit: number | null;
    readonly novelty: number | null;
    readonly confidence: number;
    readonly actionability: number | null;
  };
  readonly noveltyStatus: NoveltyStatus;
  readonly fitEvaluation: ProgramEvaluation;
  readonly actionabilityEvaluation: ProgramEvaluation;
}

/**
 * Recompute all four axes from canonical state and APPEND score rows using
 * the champion scoring programs persisted via scoring_programs. Mirrors the
 * rescore path of apps/web/src/lib/candidate-scoring.ts on the shared
 * storage/pure helpers only (history-preserving, always appends).
 */
export async function rescoreCandidateAfterResearch(
  db: Database,
  candidateId: string,
): Promise<CandidateRescoreResult> {
  const candidate = await getCandidateById(db, candidateId);
  if (candidate === null) {
    throw new Error(`candidate ${candidateId} not found`);
  }
  const companyId = candidate.companyId;
  const state = await loadCanonicalCompanyState(db, companyId);
  const verdicts = await activeSnapshotMatchVerdicts(db, {
    companyId,
    domain: state.domains[0]?.domain ?? null,
    displayName: state.company.displayName,
  });
  const featureVector = extractFeatureVector(buildFeatureRecordInput(state));
  const contentSha256 = sha256OfFeatures(featureVector);

  // Resolve the LIVE champions (Lab promotions) with shipped-default fallback.
  const [fitChampion, actionabilityChampion] = await Promise.all([
    getChampionProgramOrFallback(db, "fit"),
    getChampionProgramOrFallback(db, "actionability"),
  ]);
  const fitEvaluation = evaluateProgram(fitChampion.program, featureVector);
  const actionabilityEvaluation = evaluateProgram(
    actionabilityChampion.program,
    featureVector,
  );
  const novelty = computeNovelty(featureVector, {
    matchStatusesBySnapshot: verdicts.map((verdict) => verdict.status),
  });
  const confidence = computeConfidence({
    sourceCount: state.evidenceCounts.sourceCount,
    primarySourceCount: state.evidenceCounts.primarySourceCount,
    conflictCount: state.evidenceCounts.conflictCount,
    freshestObservationDaysOld: state.evidenceCounts.freshestObservationDaysOld,
    identityResolved: featureVector.evidence.identityResolved,
  });

  const expectedFit = (fitEvaluation.score ?? 0) / 100;
  const uncertainty = 1 - confidence / 100;
  const cost =
    state.evidenceCounts.freshestObservationDaysOld === null
      ? 1
      : Math.min(1, state.evidenceCounts.freshestObservationDaysOld / 730);
  const rp = researchPriority({
    expectedFit,
    expectedNovelty: (novelty.score ?? 0) / 100,
    uncertainty,
    informationGain: unknownFraction(featureVector),
    sourceDiversity: Math.min(1, state.evidenceCounts.sourceCount / 3),
    cost,
  });
  const prp = partnerReviewPriority({
    fit: (fitEvaluation.score ?? 0) / 100,
    novelty: (novelty.score ?? 0) / 100,
    actionability: (actionabilityEvaluation.score ?? 0) / 100,
    confidence: confidence / 100,
    archetypeDiversity: Math.min(1, featureVector.platforms.length / 4),
  });
  const decision = routeCandidate({
    fit: fitEvaluation.score,
    noveltyStatus: novelty.status,
    confidence,
    actionability: actionabilityEvaluation.score,
  });
  const routedStatusByQueue = {
    research: "queued_research",
    partner: "partner_review",
    watchlist: "watchlist",
  } as const;

  const scores = {
    fit: roundToScorePrecision(fitEvaluation.score),
    novelty: roundToScorePrecision(novelty.score),
    confidence,
    actionability: roundToScorePrecision(actionabilityEvaluation.score),
  };

  await db.transaction(async (tx) => {
    await ensureFeatureSnapshot(tx, {
      companyId,
      schemaVersion: FEATURE_SCHEMA_VERSION,
      contentSha256,
      features: featureVector as unknown as Record<string, unknown>,
    });
    await upsertCandidate(tx, {
      companyId,
      routedStatus: routedStatusByQueue[decision.queue],
      noveltyStatus: novelty.status,
      noveltySnapshotIds: verdicts.map((verdict) => verdict.snapshotId),
      rationale: candidate.rationale,
      currentScores: scores,
      researchPriority: rp,
      partnerReviewPriority: prp,
    });
    // History-preserving append — mirrors rescoreCandidate's forceAppend.
    await appendScoreRows(tx, candidateId, [
      {
        axis: "fit",
        value: scores.fit,
        scoringProgramId: fitChampion.scoringProgramId,
        featureSchemaVersion: FEATURE_SCHEMA_VERSION,
        details: {
          contributions: fitEvaluation.contributions,
          missingHandled: fitEvaluation.missingHandled,
          ...(fitEvaluation.veto === undefined ? {} : { veto: fitEvaluation.veto }),
        },
      },
      {
        axis: "actionability",
        value: scores.actionability,
        scoringProgramId: actionabilityChampion.scoringProgramId,
        featureSchemaVersion: FEATURE_SCHEMA_VERSION,
        details: {
          contributions: actionabilityEvaluation.contributions,
          missingHandled: actionabilityEvaluation.missingHandled,
          ...(actionabilityEvaluation.veto === undefined
            ? {}
            : { veto: actionabilityEvaluation.veto }),
        },
      },
      {
        axis: "novelty",
        value: scores.novelty,
        scoringProgramId: null,
        featureSchemaVersion: FEATURE_SCHEMA_VERSION,
        details: { status: novelty.status, matchVerdicts: verdicts },
      },
      {
        axis: "confidence",
        value: scores.confidence,
        scoringProgramId: null,
        featureSchemaVersion: FEATURE_SCHEMA_VERSION,
        details: { inputs: state.evidenceCounts },
      },
    ]);
  });

  return {
    candidateId,
    scores,
    noveltyStatus: novelty.status,
    fitEvaluation,
    actionabilityEvaluation,
  };
}

// ---------------------------------------------------------------------------
// Failure bookkeeping
// ---------------------------------------------------------------------------

/** Append an error note to candidate.rationale.unknowns (bounded history). */
export async function noteCandidateResearchFailure(
  db: Database,
  candidateId: string,
  message: string,
): Promise<void> {
  const [row] = await db
    .select({ rationale: candidates.rationale })
    .from(candidates)
    .where(eq(candidates.id, candidateId))
    .limit(1);
  if (row === undefined) return;
  const rationale = row.rationale ?? { whyInteresting: [], risks: [], unknowns: [] };
  const unknowns = [
    ...rationale.unknowns.slice(-9),
    `${new Date().toISOString()} candidate-research failed: ${message}`.slice(0, 500),
  ];
  await db
    .update(candidates)
    .set({ rationale: { ...rationale, unknowns } })
    .where(eq(candidates.id, candidateId));
}
