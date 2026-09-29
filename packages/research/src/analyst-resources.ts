import { createHash } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";

import type { Database } from "@asi/database";

import {
  exaProviderRequestHash,
  exaFailureAccounting,
  executeAccountedExaContents,
  executeAccountedExaSearch,
  type ExaAccountingContext,
} from "./enrichment/exa-budget.js";
import { normalizeEvidencePageText } from "./enrichment/website.js";
import {
  ExaApiKeyMissingError,
  ExaSearchClient,
  ExaSearchError,
  type ExaContentsResult,
  type ExaProviderResult,
  type ExaSearchResult,
} from "./search/exa.js";
import {
  isRetryableSafeFetchError,
  safeFetchUrl,
  SafeFetchError,
  type SafeFetchResult,
} from "./safe-fetch.js";
import { collectCandidatePageLinks } from "./campaigns/candidate-research.js";

export const ANALYST_PUBLIC_PAGE_RETAINED_CHARS = 32_000;
export const ANALYST_PRIMARY_PAYLOAD_RETAINED_CHARS = 16_000;
export const ANALYST_PRIMARY_RECORD_LIMIT = 10;

export type AnalystResourceTool =
  | "exa_search"
  | "public_page"
  | "exa_contents"
  | "primary_records";

export interface AnalystResourceContext {
  readonly sourceSignalId: string;
  readonly analystStepId: string;
  readonly now?: Date;
}

export type AnalystResourceRequest =
  | {
      readonly tool: "exa_search";
      readonly query: string;
    }
  | {
      readonly tool: "public_page";
      readonly url: string;
    }
  | {
      readonly tool: "exa_contents";
      readonly urls: readonly string[];
    }
  | {
      readonly tool: "primary_records";
      readonly identity: AnalystPrimaryIdentity;
      /** Current signal is excluded so corroboration is independently attributable. */
      readonly excludeSignalId?: string | null;
    };

export interface AnalystPrimaryIdentity {
  readonly legalName: string;
  readonly uei?: string | null;
  readonly cage?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;
}

export interface AnalystSourceReference {
  readonly locator: string;
  readonly finalUrl: string | null;
  /** Hash of fetched bytes for public_page, extracted text for Exa contents. */
  readonly contentSha256: string | null;
  readonly retrievedAt: string | null;
  readonly representation:
    | "provider_extracted_snippet"
    | "provider_extracted_text"
    | "normalized_publisher_text"
    | "structured_primary_record"
    | "checked_failure";
  readonly replayCaveat: string;
}

export interface AnalystResourceFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly status: number | null;
}

interface AnalystObservationBase {
  readonly tool: AnalystResourceTool;
  readonly requestHash: string;
  readonly observedAt: string;
  readonly supportRole: "discovery_only" | "candidate_evidence" | "checked_only";
  readonly sourceReferences: readonly AnalystSourceReference[];
  readonly failure: AnalystResourceFailure | null;
  readonly accessLimit: string | null;
  readonly providerReceiptId: string | null;
  readonly providerCostUsd: string | null;
  readonly providerCostKnown: boolean;
}

export interface AnalystSearchObservation extends AnalystObservationBase {
  readonly tool: "exa_search";
  readonly outcome: "success" | "deferred" | "failed";
  readonly supportRole: "discovery_only";
  readonly results: readonly {
    readonly title: string;
    readonly url: string;
    readonly textSnippet: string;
    readonly score: number;
  }[];
}

export interface AnalystPublicPageObservation extends AnalystObservationBase {
  readonly tool: "public_page";
  readonly outcome: "success" | "access_limited" | "failed";
  readonly body: string | null;
  readonly contentType: SafeFetchResult["contentType"] | null;
  readonly originalByteLength: number | null;
  readonly retainedCharacters: number;
  readonly truncated: boolean;
  readonly redirects: SafeFetchResult["redirects"];
  readonly linkedUrls: readonly string[];
}

export interface AnalystContentsObservation extends AnalystObservationBase {
  readonly tool: "exa_contents";
  readonly outcome: "success" | "deferred" | "failed";
  readonly pages: readonly {
    readonly url: string;
    readonly title: string;
    readonly extractedText: string;
    readonly extractedTextSha256: string;
    readonly truncated: boolean;
  }[];
}

export interface AnalystPrimaryRecord {
  readonly signalId: string;
  readonly sourceKey:
    | "sam_entity"
    | "usaspending"
    | "faa_pma_database"
    | "faa_drs_pma"
    | "faa_drs_pma_search";
  readonly sourceLocator: string;
  readonly sourceFingerprint: string;
  readonly legalName: string;
  readonly domain: string | null;
  readonly uei: string | null;
  readonly cage: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly country: string | null;
  readonly awardCount: number | null;
  readonly payloadJson: string;
  readonly payloadTruncated: boolean;
  readonly issuer:
    | "Federal Aviation Administration"
    | "U.S. General Services Administration"
    | "USAspending.gov";
  readonly recordAccess: "reused_imported_record";
  readonly observedAt: string;
}

export interface AnalystPrimaryRecordObservation extends AnalystObservationBase {
  readonly tool: "primary_records";
  readonly outcome: "success" | "unresolved" | "failed";
  readonly matchBasis: "uei" | "cage" | "legal_name_and_location" | null;
  readonly ambiguous: boolean;
  readonly records: readonly AnalystPrimaryRecord[];
}

export type AnalystResourceObservation =
  | AnalystSearchObservation
  | AnalystPublicPageObservation
  | AnalystContentsObservation
  | AnalystPrimaryRecordObservation;

export interface AnalystExaClient {
  searchWithMetadata(query: string): Promise<ExaProviderResult<ExaSearchResult>>;
  fetchContentsWithMetadata(
    urls: readonly string[],
  ): Promise<ExaProviderResult<ExaContentsResult>>;
}

export type AnalystResourceExecutionMode = "free_only" | "bounded_paid";

export class AnalystPaidResourceDisabledError extends Error {
  readonly tool: "exa_search" | "exa_contents";

  constructor(tool: "exa_search" | "exa_contents") {
    super(`${tool} is disabled by the free-only analyst execution boundary`);
    this.name = "AnalystPaidResourceDisabledError";
    this.tool = tool;
  }
}

export interface AnalystResourceExecutorOptions {
  readonly db: Database;
  readonly executionMode?: AnalystResourceExecutionMode;
  /** Existing immutable provider-budget scope; executor never creates one. */
  readonly exaBudgetScopeId: string;
  readonly exaApiKey?: string;
  readonly exaClient?: AnalystExaClient;
  readonly fetchUrl?: typeof safeFetchUrl;
  readonly exaDailyCapUsd?: string;
}

export interface AnalystResourceExecutor {
  execute(
    context: AnalystResourceContext,
    request: AnalystResourceRequest,
  ): Promise<AnalystResourceObservation>;
}

export function createAnalystResourceExecutor(
  options: AnalystResourceExecutorOptions,
): AnalystResourceExecutor {
  const fetchUrl = options.fetchUrl ?? safeFetchUrl;
  let client: AnalystExaClient | null = options.exaClient ?? null;
  const paidClient = (): AnalystExaClient => {
    if (options.executionMode === "free_only") {
      throw new AnalystPaidResourceDisabledError("exa_search");
    }
    client ??= new ExaSearchClient({ apiKey: options.exaApiKey });
    return client;
  };
  return {
    async execute(context, request) {
      switch (request.tool) {
        case "exa_search":
          if (options.executionMode === "free_only") {
            throw new AnalystPaidResourceDisabledError(request.tool);
          }
          return executeSearch(options, paidClient(), context, request);
        case "public_page":
          return executePublicPage(fetchUrl, context, request);
        case "exa_contents":
          if (options.executionMode === "free_only") {
            throw new AnalystPaidResourceDisabledError(request.tool);
          }
          return executeContents(options, paidClient(), context, request);
        case "primary_records":
          return executePrimaryRecords(options.db, context, request);
      }
    },
  };
}

async function executeSearch(
  options: AnalystResourceExecutorOptions,
  client: AnalystExaClient,
  context: AnalystResourceContext,
  request: Extract<AnalystResourceRequest, { tool: "exa_search" }>,
): Promise<AnalystSearchObservation> {
  const requestHash = analystResourceRequestHash(request);
  const observedAt = (context.now ?? new Date()).toISOString();
  try {
    const accounted = await executeAccountedExaSearch(
      accountingContext(options, context),
      client,
      request.query,
    );
    if (accounted.outcome === "deferred") {
      return {
        tool: "exa_search",
        requestHash,
        observedAt,
        outcome: "deferred",
        supportRole: "discovery_only",
        results: [],
        sourceReferences: [],
        failure: null,
        accessLimit:
          accounted.retryAt === null
            ? accounted.reason
            : `${accounted.reason}; retry_at=${accounted.retryAt.toISOString()}`,
        providerReceiptId: accounted.receipt?.id ?? null,
        providerCostUsd: accounted.providerCostUsd ?? null,
        providerCostKnown: accounted.providerCostUsd != null,
      };
    }
    if (accounted.outcome === "ambiguous") {
      return {
        tool: "exa_search",
        requestHash,
        observedAt,
        outcome: "deferred",
        supportRole: "discovery_only",
        results: [],
        sourceReferences: [],
        failure: null,
        accessLimit: accounted.reason,
        providerReceiptId: accounted.receipt.id,
        providerCostUsd: accounted.receipt.actualCostUsd,
        providerCostKnown: accounted.receipt.actualCostUsd !== null,
      };
    }
    const results = accounted.results.map((result) => ({
      title: result.title,
      url: result.url,
      textSnippet: result.text,
      score: result.score,
    }));
    return {
      tool: "exa_search",
      requestHash,
      observedAt,
      outcome: "success",
      supportRole: "discovery_only",
      results,
      sourceReferences: results.map((result) => ({
        locator: result.url,
        finalUrl: result.url,
        contentSha256: sha256(result.textSnippet),
        retrievedAt: observedAt,
        representation: "provider_extracted_snippet",
        replayCaveat:
          "Discovery snippet supplied by Exa; it is not publisher bytes and cannot support a business fact until the page or a primary record is retrieved.",
      })),
      failure: null,
      accessLimit: null,
      providerReceiptId: accounted.receipt.id,
      providerCostUsd: accounted.providerCostUsd,
      providerCostKnown: accounted.providerCostUsd !== null,
    };
  } catch (error) {
    return failedSearchObservation(requestHash, observedAt, error);
  }
}

async function executeContents(
  options: AnalystResourceExecutorOptions,
  client: AnalystExaClient,
  context: AnalystResourceContext,
  request: Extract<AnalystResourceRequest, { tool: "exa_contents" }>,
): Promise<AnalystContentsObservation> {
  const requestHash = analystResourceRequestHash(request);
  const observedAt = (context.now ?? new Date()).toISOString();
  try {
    const accounted = await executeAccountedExaContents(
      accountingContext(options, context),
      client,
      request.urls,
    );
    if (accounted.outcome === "deferred") {
      return {
        tool: "exa_contents",
        requestHash,
        observedAt,
        outcome: "deferred",
        supportRole: "checked_only",
        pages: [],
        sourceReferences: [],
        failure: null,
        accessLimit:
          accounted.retryAt === null
            ? accounted.reason
            : `${accounted.reason}; retry_at=${accounted.retryAt.toISOString()}`,
        providerReceiptId: accounted.receipt?.id ?? null,
        providerCostUsd: accounted.providerCostUsd ?? null,
        providerCostKnown: accounted.providerCostUsd != null,
      };
    }
    if (accounted.outcome === "ambiguous") {
      return {
        tool: "exa_contents",
        requestHash,
        observedAt,
        outcome: "deferred",
        supportRole: "checked_only",
        pages: [],
        sourceReferences: [],
        failure: null,
        accessLimit: accounted.reason,
        providerReceiptId: accounted.receipt.id,
        providerCostUsd: accounted.receipt.actualCostUsd,
        providerCostKnown: accounted.receipt.actualCostUsd !== null,
      };
    }
    const pages = accounted.results.map((result) => {
      const extractedText = result.text.slice(0, ANALYST_PUBLIC_PAGE_RETAINED_CHARS);
      return {
        url: result.url,
        title: result.title,
        extractedText,
        extractedTextSha256: sha256(extractedText),
        truncated: result.text.length > extractedText.length,
      };
    });
    return {
      tool: "exa_contents",
      requestHash,
      observedAt,
      outcome: "success",
      supportRole: "candidate_evidence",
      pages,
      sourceReferences: pages.map((page) => ({
        locator: page.url,
        finalUrl: page.url,
        contentSha256: page.extractedTextSha256,
        retrievedAt: observedAt,
        representation: "provider_extracted_text",
        replayCaveat:
          "Text was extracted and normalized by Exa. The hash covers only retained extracted text, never publisher bytes; omitted URLs were not accessed by this observation.",
      })),
      failure: null,
      accessLimit:
        pages.length === 0 ? "provider_returned_no_retrievable_pages" : null,
      providerReceiptId: accounted.receipt.id,
      providerCostUsd: accounted.providerCostUsd,
      providerCostKnown: accounted.providerCostUsd !== null,
    };
  } catch (error) {
    return failedContentsObservation(requestHash, observedAt, error);
  }
}

async function executePublicPage(
  fetchUrl: typeof safeFetchUrl,
  context: AnalystResourceContext,
  request: Extract<AnalystResourceRequest, { tool: "public_page" }>,
): Promise<AnalystPublicPageObservation> {
  const requestHash = analystResourceRequestHash(request);
  const observedAt = (context.now ?? new Date()).toISOString();
  try {
    const fetched = await fetchUrl(request.url);
    const accessLimit = classifyAccessLimitedPage(fetched);
    if (accessLimit !== null) {
      return {
        tool: "public_page",
        requestHash,
        observedAt,
        outcome: "access_limited",
        supportRole: "checked_only",
        body: null,
        contentType: fetched.contentType,
        originalByteLength: fetched.byteLength,
        retainedCharacters: 0,
        truncated: false,
        redirects: fetched.redirects,
        linkedUrls: [],
        sourceReferences: [checkedReference(request.url, fetched.finalUrl, accessLimit)],
        failure: null,
        accessLimit,
        providerReceiptId: null,
        providerCostUsd: null,
        providerCostKnown: false,
      };
    }
    const normalized = normalizedPublisherResourceText(fetched);
    const body = normalized.slice(0, ANALYST_PUBLIC_PAGE_RETAINED_CHARS);
    return {
      tool: "public_page",
      requestHash,
      observedAt,
      outcome: "success",
      supportRole: "candidate_evidence",
      body,
      contentType: fetched.contentType,
      originalByteLength: fetched.byteLength,
      retainedCharacters: body.length,
      truncated: normalized.length > body.length,
      redirects: fetched.redirects,
      linkedUrls:
        fetched.contentType === "text/html"
          ? collectCandidatePageLinks(fetched.content, fetched.finalUrl, 8)
          : [],
      sourceReferences: [
        {
          locator: request.url,
          finalUrl: fetched.finalUrl,
          contentSha256: fetched.contentSha256,
          retrievedAt: fetched.retrievedAt,
          representation: "normalized_publisher_text",
          replayCaveat:
            "The hash covers the complete safe-fetched publisher response. The retained body is bounded normalized visible text plus bounded normalized JSON-LD, not original publisher bytes or markup.",
        },
      ],
      failure: null,
      accessLimit: null,
      providerReceiptId: null,
      providerCostUsd: null,
      providerCostKnown: false,
    };
  } catch (error) {
    const failure = resourceFailure(error);
    return {
      tool: "public_page",
      requestHash,
      observedAt,
      outcome: "failed",
      supportRole: "checked_only",
      body: null,
      contentType: null,
      originalByteLength: null,
      retainedCharacters: 0,
      truncated: false,
      redirects: [],
      linkedUrls: [],
      sourceReferences: [checkedReference(request.url, null, failure.code)],
      failure,
      accessLimit:
        error instanceof SafeFetchError &&
        (error.code === "blocked_destination" ||
          error.code === "unsupported_content_type" ||
          error.code === "content_too_large")
          ? error.code
          : null,
      providerReceiptId: null,
      providerCostUsd: null,
      providerCostKnown: false,
    };
  }
}

async function executePrimaryRecords(
  db: Database,
  context: AnalystResourceContext,
  request: Extract<AnalystResourceRequest, { tool: "primary_records" }>,
): Promise<AnalystPrimaryRecordObservation> {
  const requestHash = analystResourceRequestHash(request);
  const observedAt = (context.now ?? new Date()).toISOString();
  const identity = normalizePrimaryIdentity(request.identity);
  const match = primaryMatch(identity);
  if (match === null) {
    return {
      tool: "primary_records",
      requestHash,
      observedAt,
      outcome: "unresolved",
      supportRole: "checked_only",
      matchBasis: null,
      ambiguous: false,
      records: [],
      sourceReferences: [],
      failure: null,
      accessLimit:
        "Exact UEI/CAGE or exact legal name plus city and state is required; fuzzy name-only lookup is not permitted.",
      providerReceiptId: null,
      providerCostUsd: null,
      providerCostKnown: false,
    };
  }
  try {
    const rows = await db.execute<PrimaryRecordRow>(sql`
      SELECT id, source_key, source_locator, source_fingerprint, raw_name,
             raw_domain, uei, cage, city, state, country, award_count,
             source_payload
      FROM source_signals
      WHERE source_key IN (
        'sam_entity',
        'usaspending',
        'faa_pma_database',
        'faa_drs_pma',
        'faa_drs_pma_search'
      )
        AND (${request.excludeSignalId ?? context.sourceSignalId}::uuid IS NULL
             OR id <> ${request.excludeSignalId ?? context.sourceSignalId}::uuid)
        AND ${match.predicate}
      ORDER BY source_key, source_locator
      LIMIT ${ANALYST_PRIMARY_RECORD_LIMIT + 1}
    `);
    const queryTruncated = rows.rows.length > ANALYST_PRIMARY_RECORD_LIMIT;
    const records = rows.rows
      .slice(0, ANALYST_PRIMARY_RECORD_LIMIT)
      .map((row) => toPrimaryRecord(row, observedAt));
    const ambiguous = queryTruncated || primaryRecordsConflict(records);
    return {
      tool: "primary_records",
      requestHash,
      observedAt,
      outcome: records.length === 0 ? "unresolved" : "success",
      supportRole: records.length === 0 ? "checked_only" : "candidate_evidence",
      matchBasis: match.basis,
      ambiguous,
      records,
      sourceReferences: records.map((record) => ({
        locator: record.sourceLocator,
        finalUrl: null,
        contentSha256: sha256(record.payloadJson),
        retrievedAt: null,
        representation: "structured_primary_record",
        replayCaveat:
          `Reused imported ${record.issuer} record (${record.sourceFingerprint}) identified by its stable locator/fingerprint. payloadJson is a bounded serialization and may be truncated.`,
      })),
      failure: null,
      accessLimit: queryTruncated
        ? `more_than_${ANALYST_PRIMARY_RECORD_LIMIT}_exact_candidates`
        : null,
      providerReceiptId: null,
      providerCostUsd: null,
      providerCostKnown: false,
    };
  } catch (error) {
    return {
      tool: "primary_records",
      requestHash,
      observedAt,
      outcome: "failed",
      supportRole: "checked_only",
      matchBasis: match.basis,
      ambiguous: false,
      records: [],
      sourceReferences: [],
      failure: resourceFailure(error),
      accessLimit: "primary_record_store_unavailable",
      providerReceiptId: null,
      providerCostUsd: null,
      providerCostKnown: false,
    };
  }
}

interface PrimaryRecordRow extends Record<string, unknown> {
  readonly id: string;
  readonly source_key: AnalystPrimaryRecord["sourceKey"];
  readonly source_locator: string;
  readonly source_fingerprint: string;
  readonly raw_name: string;
  readonly raw_domain: string | null;
  readonly uei: string | null;
  readonly cage: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly country: string | null;
  readonly award_count: number | null;
  readonly source_payload: Record<string, unknown>;
}

function normalizePrimaryIdentity(identity: AnalystPrimaryIdentity): AnalystPrimaryIdentity {
  return {
    legalName: identity.legalName.replace(/\s+/gu, " ").trim(),
    uei: normalizedOptional(identity.uei),
    cage: normalizedOptional(identity.cage),
    city: normalizedOptional(identity.city),
    state: normalizedOptional(identity.state),
  };
}

function primaryMatch(
  identity: AnalystPrimaryIdentity,
): { readonly basis: Exclude<AnalystPrimaryRecordObservation["matchBasis"], null>; readonly predicate: SQL } | null {
  if (identity.uei !== null && identity.uei !== undefined) {
    return {
      basis: "uei",
      predicate: sql`upper(uei) = upper(${identity.uei})`,
    };
  }
  if (identity.cage !== null && identity.cage !== undefined) {
    return {
      basis: "cage",
      predicate: sql`upper(cage) = upper(${identity.cage})`,
    };
  }
  if (
    identity.legalName.length === 0 ||
    identity.city === null ||
    identity.city === undefined ||
    identity.state === null ||
    identity.state === undefined
  ) {
    return null;
  }
  return {
    basis: "legal_name_and_location",
    predicate: sql`lower(regexp_replace(trim(raw_name), '\\s+', ' ', 'g')) = lower(${identity.legalName})
      AND lower(trim(city)) = lower(${identity.city})
      AND upper(trim(state)) = upper(${identity.state})`,
  };
}

function toPrimaryRecord(
  row: PrimaryRecordRow,
  observedAt: string,
): AnalystPrimaryRecord {
  const complete = JSON.stringify(row.source_payload);
  const payloadJson = complete.slice(0, ANALYST_PRIMARY_PAYLOAD_RETAINED_CHARS);
  return {
    signalId: row.id,
    sourceKey: row.source_key,
    sourceLocator: row.source_locator,
    sourceFingerprint: row.source_fingerprint,
    legalName: row.raw_name,
    domain: row.raw_domain,
    uei: row.uei,
    cage: row.cage,
    city: row.city,
    state: row.state,
    country: row.country,
    awardCount: row.award_count,
    payloadJson,
    payloadTruncated: complete.length > payloadJson.length,
    issuer:
      row.source_key === "faa_pma_database" ||
      row.source_key === "faa_drs_pma" ||
      row.source_key === "faa_drs_pma_search"
        ? "Federal Aviation Administration"
        : row.source_key === "sam_entity"
          ? "U.S. General Services Administration"
          : "USAspending.gov",
    recordAccess: "reused_imported_record",
    observedAt,
  };
}

function accountingContext(
  options: AnalystResourceExecutorOptions,
  context: AnalystResourceContext,
): ExaAccountingContext {
  return {
    db: options.db,
    budgetScopeId: options.exaBudgetScopeId,
    sourceSignalId: context.sourceSignalId,
    analystStepId: context.analystStepId,
    ...(options.exaDailyCapUsd === undefined
      ? {}
      : { dailyCapUsd: options.exaDailyCapUsd }),
    ...(context.now === undefined ? {} : { now: context.now }),
  };
}

function failedSearchObservation(
  requestHash: string,
  observedAt: string,
  error: unknown,
): AnalystSearchObservation {
  const accounting = exaFailureAccounting(error);
  return {
    tool: "exa_search",
    requestHash,
    observedAt,
    outcome: "failed",
    supportRole: "discovery_only",
    results: [],
    sourceReferences: [],
    failure: resourceFailure(error),
    accessLimit:
      error instanceof ExaApiKeyMissingError ? "exa_api_key_unavailable" : null,
    providerReceiptId: accounting?.receipt.id ?? null,
    providerCostUsd:
      accounting?.providerCostUsd ??
      (error instanceof ExaSearchError ? error.providerCostUsd : null),
    providerCostKnown:
      (accounting?.providerCostUsd ??
        (error instanceof ExaSearchError ? error.providerCostUsd : null)) !== null,
  };
}

function failedContentsObservation(
  requestHash: string,
  observedAt: string,
  error: unknown,
): AnalystContentsObservation {
  const accounting = exaFailureAccounting(error);
  return {
    tool: "exa_contents",
    requestHash,
    observedAt,
    outcome: "failed",
    supportRole: "checked_only",
    pages: [],
    sourceReferences: [],
    failure: resourceFailure(error),
    accessLimit:
      error instanceof ExaApiKeyMissingError ? "exa_api_key_unavailable" : null,
    providerReceiptId: accounting?.receipt.id ?? null,
    providerCostUsd:
      accounting?.providerCostUsd ??
      (error instanceof ExaSearchError ? error.providerCostUsd : null),
    providerCostKnown:
      (accounting?.providerCostUsd ??
        (error instanceof ExaSearchError ? error.providerCostUsd : null)) !== null,
  };
}

function resourceFailure(error: unknown): AnalystResourceFailure {
  if (error instanceof ExaSearchError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.transient,
      status: error.status,
    };
  }
  if (error instanceof ExaApiKeyMissingError) {
    return {
      code: "configuration_error",
      message: error.message,
      retryable: false,
      status: null,
    };
  }
  if (error instanceof SafeFetchError) {
    return {
      code: error.code,
      message: error.message,
      retryable: isRetryableSafeFetchError(error),
      status: error.status,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: "resource_error",
    message: message.replaceAll("\u0000", "\\u0000").slice(0, 2_000),
    retryable: true,
    status: null,
  };
}

function normalizedPublisherResourceText(result: SafeFetchResult): string {
  const visible =
    result.contentType === "text/html"
      ? normalizeEvidencePageText(result.content)
      : result.content
          .replace(/\r\n?/gu, "\n")
          .replace(/[^\S\n]+/gu, " ")
          .replace(/ *\n */gu, "\n")
          .replace(/\n{3,}/gu, "\n\n")
          .trim();
  if (result.contentType !== "text/html") return visible;
  const jsonLd = normalizedJsonLd(result.content);
  return [
    jsonLd === ""
      ? null
      : "[bounded normalized JSON-LD; not verbatim]\n" +
        `<script type="application/ld+json">${jsonLd}</script>`,
    visible === "" ? null : "[normalized visible publisher text]\n" + visible,
  ]
    .filter((value): value is string => value !== null)
    .join("\n\n");
}

interface StructuredProjectionBudget {
  remainingNodes: number;
  remainingStringCharacters: number;
}

function normalizedJsonLd(html: string): string {
  const documents: unknown[] = [];
  const budget: StructuredProjectionBudget = {
    remainingNodes: 64,
    remainingStringCharacters: 5_000,
  };
  const scripts =
    /<script\b(?=[^>]*\btype\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json'|application\/ld\+json))[^>]*>([\s\S]*?)<\/script\s*>/giu;
  for (const match of html.matchAll(scripts)) {
    const body = match[1]?.replace(/^\s*<!--|-->\s*$/gu, "").trim();
    if (!body) continue;
    if (budget.remainingNodes <= 0) {
      documents.push("[additional JSON-LD documents omitted from bounded projection]");
      break;
    }
    try {
      documents.push(projectStructuredValue(JSON.parse(body), 0, budget));
    } catch {
      continue;
    }
  }
  return documents.length === 0 ? "" : JSON.stringify(documents);
}

function projectStructuredValue(
  value: unknown,
  depth: number,
  budget: StructuredProjectionBudget,
): unknown {
  if (depth > 5) return "[nested value omitted beyond projection depth]";
  if (budget.remainingNodes <= 0) {
    return "[value omitted after bounded projection node limit]";
  }
  budget.remainingNodes -= 1;
  if (typeof value === "string") {
    if (value.length > 1_000) {
      return `[complete ${String(value.length)}-character value omitted; field limit is 1000]`;
    }
    if (value.length > budget.remainingStringCharacters) {
      return `[complete ${String(value.length)}-character value omitted; projection string budget exhausted]`;
    }
    budget.remainingStringCharacters -= value.length;
    return value;
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const projected: unknown[] = [];
    for (const entry of value.slice(0, 20)) {
      if (budget.remainingNodes <= 0) {
        projected.push("[additional array values omitted after node limit]");
        break;
      }
      projected.push(projectStructuredValue(entry, depth + 1, budget));
    }
    if (value.length > 20) {
      projected.push(
        `[${String(value.length - 20)} additional array values omitted]`,
      );
    }
    return projected;
  }
  if (typeof value !== "object") return null;
  const projected: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      !/^(?:@.*|name|legalName|url|identifier|address|location|publisher|parentOrganization|sameAs|description|addressLocality|addressRegion|addressCountry|postalCode|streetAddress|propertyID|value)$/u.test(
        key,
      )
    ) {
      continue;
    }
    if (budget.remainingNodes <= 0) {
      projected["__projectionNotice"] =
        "additional identity fields omitted after node limit";
      break;
    }
    projected[key] = projectStructuredValue(entry, depth + 1, budget);
  }
  return projected;
}

function primaryRecordsConflict(
  records: readonly AnalystPrimaryRecord[],
): boolean {
  const distinct = (values: readonly (string | null)[]): number =>
    new Set(
      values
        .filter((value): value is string => value !== null)
        .map((value) =>
          value.replace(/\s+/gu, " ").trim().toLocaleUpperCase("en-US"),
        ),
    ).size;
  if (distinct(records.map((record) => record.legalName)) > 1) return true;
  if (distinct(records.map((record) => record.uei)) > 1) return true;
  if (distinct(records.map((record) => record.cage)) > 1) return true;
  if (distinct(records.map((record) => record.country)) > 1) return true;
  const locations = records.map((record) =>
    record.city === null || record.state === null
      ? null
      : `${record.city}\u0000${record.state}`,
  );
  return distinct(locations) > 1;
}

function classifyAccessLimitedPage(result: SafeFetchResult): string | null {
  const text = normalizedPublisherResourceText(result)
    .slice(0, 8_000)
    .replace(/\s+/gu, " ")
    .trim();
  if (
    /(?:complete (?:the )?captcha|captcha (?:challenge|verification|required)|verify (?:that )?you are human|access denied|request blocked|sign in to continue|authentication required)/iu.test(
      text,
    )
  ) {
    return "authentication_or_anti_bot_challenge";
  }
  if (
    text.length < 2_000 &&
    /(?:error\s+404|404\s+(?:error|page not found|not found)|page not found|does not exist|no longer available)/iu.test(text)
  ) {
    return "soft_404";
  }
  return null;
}

function checkedReference(
  locator: string,
  finalUrl: string | null,
  reason: string,
): AnalystSourceReference {
  return {
    locator,
    finalUrl,
    contentSha256: null,
    retrievedAt: null,
    representation: "checked_failure",
    replayCaveat: `No support-role body retained: ${reason}`,
  };
}

function normalizedOptional(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length === 0 ? null : normalized;
}

export function analystResourceRequestHash(
  request: AnalystResourceRequest,
): string {
  switch (request.tool) {
    case "exa_search":
      return exaProviderRequestHash("search", { query: request.query });
    case "exa_contents":
      return exaProviderRequestHash("contents", { urls: request.urls });
    case "public_page":
    case "primary_records":
      return sha256(JSON.stringify(request));
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
