import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import {
  bootstrapSignalReviewStates,
  claimSignalReviews,
  completeSignalResearch,
  failSignalReview,
  getDatabase,
  identityOverlapRatio,
  linkSourceSignalEvidence,
  normalizeCandidateDomain,
  type Database,
  type SignalReviewClaim,
  type SignalReviewExecutor,
} from "@asi/database";
import { getUsStateCode, normalizeState } from "../geography.js";
import type {
  AnalystPrimaryRecord,
  AnalystResourceObservation,
} from "../analyst-resources.js";

import {
  buildOfficialDomainQuery,
  ExaApiKeyMissingError,
  ExaSearchClient,
  ExaSearchError,
  isSuppressedDirectoryDomain,
  normalizeExaOfficialCandidate,
  type ExaSearchErrorCode,
  type OfficialDomainCandidate,
} from "../search/exa.js";
import {
  isRetryableSafeFetchError,
  safeFetchUrl,
  SafeFetchError,
  type SafeFetchErrorCode,
  type SafeFetchResult,
} from "../safe-fetch.js";
import { currentFaaReviewInputContract } from "../faa-ensemble/runner.js";
import type { WebsiteOffering } from "../scoring-axial/features.js";
import {
  exaBudgetScopeId,
  executeAccountedExaSearch,
  type ExaAccountingContext,
} from "./exa-budget.js";
import {
  classifySentence,
  researchAcquisitionHistory,
  type AcquisitionResearchOutcome,
  type AcquisitionStatus,
} from "./ownership.js";
import {
  classifyWebsiteEvidence,
  fetchWebsiteEvidence,
  normalizeEvidencePageText,
  splitScopedEvidenceStatements,
  WEBSITE_EXCERPTS_MAX_CHARS,
  type ScopedEvidenceStatement,
  type WebsiteFetchResult,
  type WebsiteFetchedPage,
} from "./website.js";

export const SIGNAL_RESEARCH_VERSION = "signal_research_v1" as const;
export const SIGNAL_EVIDENCE_TICK_CAP = 10;
const SIGNAL_RESEARCH_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1_000;
const TRANSIENT_RETRY_MS = 15 * 60 * 1_000;
const DEFERRED_RETRY_MS = 60 * 60 * 1_000;
const MAX_DOMAIN_CANDIDATES = 3;
const IDENTITY_PAGE_PATHS = ["/", "/about", "/contact"] as const;
const IDENTITY_PAGE_REQUEST_CAP = IDENTITY_PAGE_PATHS.length;
const HEADQUARTERS_VALUE_COLLATOR = new Intl.Collator("en-US", {
  sensitivity: "base",
});
const IDENTITY_MIN_TEXT_CHARS = 100;
const MAX_NAMED_PRODUCT_EVIDENCE_PER_PAGE = 6;
const EVIDENCE_QUOTE_MAX_CHARS = 500;
const LEGAL_SUFFIX_CANONICAL: Readonly<Record<string, string>> = {
  co: "company",
  company: "company",
  corp: "corporation",
  corporation: "corporation",
  inc: "incorporated",
  incorporated: "incorporated",
  limited: "limited",
  llc: "llc",
  llp: "llp",
  lp: "lp",
  ltd: "limited",
  pllc: "pllc",
};
const LEGAL_SUFFIX_PATTERNS: Readonly<Record<string, string>> = {
  company: "(?:co|company|c[^a-z0-9]+o)",
  corporation: "(?:corp|corporation)",
  incorporated: "(?:inc|incorporated|i[^a-z0-9]+n[^a-z0-9]+c)",
  limited: "(?:ltd|limited|l[^a-z0-9]+t[^a-z0-9]+d)",
  llc: "(?:llc|l[^a-z0-9]+l[^a-z0-9]+c)",
  llp: "(?:llp|l[^a-z0-9]+l[^a-z0-9]+p)",
  lp: "(?:lp|l[^a-z0-9]+p)",
  pllc: "(?:pllc|p[^a-z0-9]+l[^a-z0-9]+l[^a-z0-9]+c)",
};
const ANY_LEGAL_SUFFIX_PATTERN = `(?:${Object.values(
  LEGAL_SUFFIX_PATTERNS,
).join("|")})`;
const HTML_TEXT_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  copy: "©",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

export type SignalIdentityStatus = "verified" | "ambiguous" | "not_found";
export type CheckedSourceOutcome =
  "retrieved" | "unreachable" | "identity_mismatch" | "no_content";
export type SourcedEvidenceStage =
  "domain" | "website" | "ownership" | "size" | "hq";
export type SizeAssessment = "under_50m" | "over_50m" | "unknown";

export interface CheckedSourceReference {
  readonly url: string;
  readonly outcome: CheckedSourceOutcome;
  readonly contentSha256: string | null;
  readonly retrievedAt: string | null;
}

export interface SourcedEvidenceReference {
  readonly evidenceId: string;
  readonly role: "support" | "checked_only";
  readonly stage: SourcedEvidenceStage;
  readonly url: string;
  readonly title: string | null;
  readonly quote: string;
  readonly contentSha256: string;
  readonly retrievedAt: string;
  readonly sourceKind:
    | "official_site"
    | "publisher_site"
    | "news"
    | "registry";
  readonly firstParty: boolean;
}

export interface SizeIndicator {
  readonly kind: "revenue" | "employee_count" | "facility_scale";
  readonly excerpt: string;
  readonly evidenceId: string;
  readonly periodYear: number | null;
  readonly currentness: "latest_completed_period" | "undated_current";
}

export interface SourcedSignalResearchEvidence {
  readonly version: typeof SIGNAL_RESEARCH_VERSION;
  readonly signalId: string;
  readonly sourceContext: {
    readonly sourceKey: string;
    readonly sourceLocator: string;
    readonly sourceFingerprint: string;
    readonly rawName: string;
    readonly rawDomain: string | null;
    readonly uei: string | null;
    readonly cage: string | null;
    readonly city: string | null;
    readonly state: string | null;
    readonly country: string | null;
    readonly awardCount: number | null;
  };
  readonly identity: {
    readonly status: SignalIdentityStatus;
    readonly verifiedDomain: string | null;
    readonly legalName: string;
    readonly proofEvidenceIds: readonly string[];
  };
  readonly website: {
    readonly status: "supported" | "no_content" | "not_checked";
    readonly offering: WebsiteOffering;
    readonly excerpts: string;
    readonly productHints: readonly string[];
    readonly namedProductEvidenceIds: readonly string[];
  };
  readonly ownership: {
    readonly status: AcquisitionStatus | "independent";
    readonly owner: string | null;
    readonly year: number | null;
    readonly conflicting: boolean;
    readonly currentness:
      | "explicit_current_relation"
      | "explicit_current_independence"
      | "unknown";
    readonly supportEvidenceIds: readonly string[];
  };
  readonly size: {
    readonly status: "supported" | "unknown";
    readonly assessment: SizeAssessment;
    readonly conflicting: boolean;
    readonly indicators: readonly SizeIndicator[];
  };
  readonly headquarters: {
    readonly status: "supported" | "unknown" | "conflicting";
    readonly city: string | null;
    readonly state: string | null;
    readonly country: string | null;
    readonly supportEvidenceIds: readonly string[];
  };
  readonly missingFacts: readonly string[];
  readonly checkedSources: readonly CheckedSourceReference[];
  readonly evidenceRefs: readonly SourcedEvidenceReference[];
}

export interface SignalEvidenceSourceSignal {
  readonly id: string;
  readonly sourceKey: string;
  readonly sourceLocator: string;
  readonly sourceFingerprint: string;
  readonly rawName: string;
  readonly rawDomain: string | null;
  readonly uei: string | null;
  readonly cage: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly country: string | null;
  readonly awardCount: number | null;
  readonly sourcePayload: Record<string, unknown>;
  readonly createdAt: Date;
}

export interface SignalEvidenceInjectedDependencies {
  readonly searchClient?:
    | Pick<
        ExaSearchClient,
        "searchWithMetadata" | "fetchContentsWithMetadata"
      >
    | undefined;
  readonly fetchUrl?: typeof safeFetchUrl | undefined;
}

export interface ResearchSignalEvidenceOptions extends SignalEvidenceInjectedDependencies {
  readonly db: Database;
  readonly signal: SignalEvidenceSourceSignal;
  readonly apiKey: string;
  readonly exaBudgetScopeId?: string | undefined;
  readonly now?: Date | undefined;
}

export type ResearchSignalEvidenceResult =
  | {
      readonly outcome: "completed";
      readonly researchEvidence: SourcedSignalResearchEvidence;
      readonly costUsd: number;
      readonly researchDueAt: Date;
    }
  | {
      readonly outcome: "deferred" | "retryable_error";
      readonly reason: string;
      readonly errorCode: ExaSearchErrorCode | SafeFetchErrorCode | null;
      readonly retryAfterMs: number;
      readonly costUsd: number;
    };

export interface RunSignalEvidenceResearchOptions extends SignalEvidenceInjectedDependencies {
  readonly db?: Database | undefined;
  readonly apiKey?: string | undefined;
  readonly exaBudgetScopeId?: string | undefined;
  readonly limit?: number | undefined;
  readonly concurrency?: number | undefined;
  readonly leaseSeconds?: number | undefined;
  readonly now?: Date | undefined;
}

export interface SignalEvidenceResearchSummary {
  readonly claimed: number;
  readonly completed: number;
  readonly retryableFailures: number;
  readonly deferred: number;
  readonly ambiguous: number;
  readonly noFinding: number;
  readonly costUsd: number;
  readonly skipped: string | null;
}

interface ProcessedClaimOutcome {
  readonly kind: "completed" | "deferred" | "retryable_error";
  readonly identityStatus: SignalIdentityStatus | null;
  readonly costUsd: number;
}

export interface SignalIdentityAssessment {
  readonly status: Exclude<SignalIdentityStatus, "not_found">;
  readonly overlapRatio: number;
  readonly nameMatched: boolean;
  readonly corroboratedBy: "identifier" | "location" | null;
}

interface PendingEvidenceDocument {
  readonly stage: SourcedEvidenceStage;
  readonly url: string;
  readonly title: string | null;
  readonly quote: string;
  readonly contentSha256: string;
  readonly retrievedAt: string;
  readonly sourceKind:
    | "official_site"
    | "publisher_site"
    | "news"
    | "registry";
  readonly firstParty: boolean;
  readonly metadata: Record<string, unknown>;
}

interface VerifiedSite {
  readonly domain: string;
  readonly pages: readonly SafeFetchResult[];
  readonly assessment: SignalIdentityAssessment;
}

interface DomainResearchResult {
  readonly status: SignalIdentityStatus;
  readonly site: VerifiedSite | null;
  readonly checkedSources: readonly CheckedSourceReference[];
  readonly documents: readonly PendingEvidenceDocument[];
  readonly costUsd: number;
  readonly failure: ResearchSignalEvidenceResult | null;
}

interface PersistedDocument extends PendingEvidenceDocument {
  readonly evidenceId: string;
}

interface HeadquartersFact {
  readonly city: string | null;
  readonly state: string | null;
  readonly country: string | null;
}

export type WebsiteFactSource = Pick<WebsiteFetchResult, "outcome" | "pages">;

export interface WebsiteFacts {
  readonly ownershipStatus: AcquisitionStatus | "independent" | "unknown";
  readonly owner: string | null;
  readonly ownershipConflicting: boolean;
  readonly ownershipObservations: readonly {
    readonly status: AcquisitionStatus | "independent";
    readonly owner: string | null;
  }[];
  readonly ownershipDocuments: readonly PendingEvidenceDocument[];
  readonly sizeDocuments: readonly PendingEvidenceDocument[];
  readonly sizeAssessment: SizeAssessment;
  readonly sizeConflicting: boolean;
  readonly sizeObservations: readonly Exclude<SizeAssessment, "unknown">[];
  readonly headquartersDocuments: readonly PendingEvidenceDocument[];
  readonly headquartersStatus: "supported" | "unknown" | "conflicting";
  readonly headquarters: HeadquartersFact | null;
  readonly headquartersObservations: readonly HeadquartersFact[];
}

/**
 * Strict raw-signal identity gate. Name similarity alone never verifies a site:
 * fetched first-party pages must self-identify with the complete business name
 * in an attributable publisher statement, copyright, or same-site structured
 * publisher role; a terminal legal suffix may be omitted. The pages also need
 * an exact labeled identifier or non-conflicting location.
 */
export function assessSignalSiteIdentity(
  signal: Pick<
    SignalEvidenceSourceSignal,
    "rawName" | "uei" | "cage" | "city" | "state"
  >,
  pageTexts: readonly string[],
  pageUrls: readonly (string | null)[] = [],
): SignalIdentityAssessment {
  return assessSignalIdentityContent(signal, pageTexts, pageUrls, true);
}

function assessSignalIdentityContent(
  signal: Pick<
    SignalEvidenceSourceSignal,
    "rawName" | "uei" | "cage" | "city" | "state"
  >,
  pageTexts: readonly string[],
  pageUrls: readonly (string | null)[],
  enforceMinimumTextLength: boolean,
): SignalIdentityAssessment {
  const attributablePages = pageTexts.flatMap((content, index) => {
    const pageUrl = pageUrls[index] ?? null;
    return hasThirdPartyProfileContext(content, pageUrl, signal.rawName)
      ? []
      : [{ content, pageUrl, text: normalizePageText(content) }];
  });
  const text = attributablePages.map((page) => page.text).join("\n\n");
  const structuredPublisherMatched = attributablePages.some(
    ({ content, pageUrl }) =>
      pageUrl !== null &&
      structuredPublisherExcerpt(content, pageUrl, signal.rawName) !== null,
  );
  const textOverlapRatio = identityOverlapRatio(signal.rawName, text);
  const overlapRatio = structuredPublisherMatched ? 1 : textOverlapRatio;
  const plainPublisherMatched =
    attributablePlainPublisherExcerpt(
      plainTextPublisherExcerpt(text, signal.rawName),
    ) ||
    splitPageSentences(text).some((sentence) =>
      attributablePlainPublisherExcerpt(
        plainTextPublisherExcerpt(sentence, signal.rawName),
      ),
    );
  const nameMatched = plainPublisherMatched || structuredPublisherMatched;
  const attributableContents = attributablePages.map((page) => page.content);
  const attributableUrls = attributablePages.map((page) => page.pageUrl);
  const ueiAssessment = targetPublisherIdentifierAssessment(
    attributableContents,
    attributableUrls,
    signal.rawName,
    "UEI",
    signal.uei,
  );
  const cageAssessment = targetPublisherIdentifierAssessment(
    attributableContents,
    attributableUrls,
    signal.rawName,
    "CAGE",
    signal.cage,
  );
  const identifierMatched = ueiAssessment.matched || cageAssessment.matched;
  const identifierConflicting =
    ueiAssessment.conflicting || cageAssessment.conflicting;
  const locationMatched = hasExactSignalLocation(
    text,
    signal.city,
    signal.state,
  );
  const strongStructuredIdentity =
    structuredPublisherMatched && identifierMatched;
  const boilerplate =
    (enforceMinimumTextLength &&
      text.length < IDENTITY_MIN_TEXT_CHARS &&
      !strongStructuredIdentity) ||
    /domain (?:is )?for sale|parked domain|whois lookup|registrar information/iu.test(
      text,
    );
  const corroboratedBy = identifierMatched
    ? "identifier"
    : locationMatched
      ? "location"
      : null;
  return {
    status:
      nameMatched &&
      corroboratedBy !== null &&
      !identifierConflicting &&
      !boilerplate
        ? "verified"
        : "ambiguous",
    overlapRatio,
    nameMatched,
    corroboratedBy,
  };
}

function attributablePlainPublisherExcerpt(excerpt: string | null): boolean {
  return (
    excerpt !== null &&
    !/\b(?:subsidiary|portfolio\s+company|owned\s+by|parent\s+company)\b/iu.test(
      excerpt,
    )
  );
}

export async function researchSignalEvidence(
  options: ResearchSignalEvidenceOptions,
): Promise<ResearchSignalEvidenceResult> {
  const now = options.now ?? new Date();
  const domain = await researchOfficialSite(options);
  if (domain.failure !== null) {
    if (domain.documents.length > 0) {
      await persistEvidenceDocuments(
        options.db,
        options.signal.id,
        researchRevision(options.signal, domain.documents),
        domain.documents,
      );
    }
    return domain.failure;
  }

  const checkedSources = [...domain.checkedSources];
  const documents: PendingEvidenceDocument[] = [...domain.documents];
  let website: WebsiteFetchResult | null = null;
  let acquisition: AcquisitionResearchOutcome | null = null;
  let costUsd = domain.costUsd;

  if (domain.site !== null) {
    website = await fetchWebsiteEvidence(
      options.apiKey,
      domain.site.domain,
      options.signal.rawName,
      {
        client: options.searchClient,
        accounting: signalExaAccounting(options, now),
        sourcePages: domain.site.pages,
        fetchUrl: options.fetchUrl,
      },
    );
    costUsd += website.costUsd;
    for (const page of website.pages) {
      checkedSources.push({
        url: page.url,
        outcome: "retrieved",
        contentSha256: page.contentSha256,
        retrievedAt: page.retrievedAt,
      });
      documents.push(
        websitePageDocument(page, options.signal.rawName),
        ...websiteProductDocuments(page, options.signal.rawName),
      );
    }
    if (
      website.outcome === "configuration_error" ||
      website.outcome === "budget_limited" ||
      website.outcome === "retryable_error" ||
      website.outcome === "provider_error"
    ) {
      await persistEvidenceDocuments(
        options.db,
        options.signal.id,
        researchRevision(options.signal, documents),
        documents,
      );
      return operationalFailure(
        website.outcome,
        `website_${website.outcome}`,
        website.errorCode,
        costUsd,
      );
    }

    acquisition = await researchAcquisitionHistory(
      options.apiKey,
      options.signal.rawName,
      domain.site.domain,
      {
        client: options.searchClient,
        accounting: signalExaAccounting(options, now),
        fetchUrl: options.fetchUrl,
      },
    );
    costUsd += acquisition.finding.costUsd;
    checkedSources.push(...acquisition.checkedSources);
    if (
      acquisition.outcome === "configuration_error" ||
      acquisition.outcome === "budget_limited" ||
      acquisition.outcome === "retryable_error" ||
      acquisition.outcome === "provider_error"
    ) {
      await persistEvidenceDocuments(
        options.db,
        options.signal.id,
        researchRevision(options.signal, documents),
        documents,
      );
      return operationalFailure(
        acquisition.outcome,
        `ownership_${acquisition.outcome}`,
        acquisition.errorCode,
        costUsd,
      );
    }
    if (
      acquisition.outcome === "affirmative" &&
      acquisition.finding.sourceUrl !== null &&
      acquisition.finding.excerpt !== null &&
      acquisition.finding.sourceContentSha256 !== null &&
      acquisition.finding.sourceRetrievedAt !== null
    ) {
      documents.push({
        stage: "ownership",
        url: acquisition.finding.sourceUrl,
        title: `Ownership source for ${options.signal.rawName}`,
        quote: acquisition.finding.excerpt,
        contentSha256: acquisition.finding.sourceContentSha256,
        retrievedAt: acquisition.finding.sourceRetrievedAt,
        sourceKind: "news",
        firstParty: false,
        metadata: {
          status: acquisition.finding.status,
          owner: acquisition.finding.owner,
          year: acquisition.finding.year,
          identityConfirmedFromRetrievedSource: true,
        },
      });
    }
  }

  const websiteFacts = extractWebsiteFacts(website, options.signal.rawName);
  documents.push(
    ...websiteFacts.ownershipDocuments,
    ...websiteFacts.sizeDocuments,
    ...websiteFacts.headquartersDocuments,
  );
  const revision = researchRevision(options.signal, documents);
  const persisted = await persistEvidenceDocuments(
    options.db,
    options.signal.id,
    revision,
    documents,
  );
  const evidenceRefs = persisted.map(toEvidenceReference);
  const domainEvidenceIds = uniqueStrings(
    persisted
      .filter(
        (entry) =>
          entry.stage === "domain" &&
          domain.site !== null &&
          entry.metadata["identityOutcome"] === "verified",
      )
      .map((entry) => entry.evidenceId),
  );
  const namedProductEvidenceIds = uniqueStrings(
    persisted
      .filter(
        (entry) =>
          entry.stage === "website" &&
          entry.firstParty &&
          entry.metadata["namedProductEvidence"] === true,
      )
      .map((entry) => entry.evidenceId),
  );
  const ownershipEntries = persisted.filter(
    (entry) => entry.stage === "ownership",
  );
  const acquisitionFinding =
    acquisition?.outcome === "affirmative" ? acquisition.finding : null;
  const ownershipStatus =
    acquisitionFinding?.status ?? websiteFacts.ownershipStatus;
  const ownershipOwner =
    acquisitionFinding === null ? websiteFacts.owner : acquisitionFinding.owner;
  const sizeEntries = persisted.filter((entry) => entry.stage === "size");
  const hqEntries = persisted.filter((entry) => entry.stage === "hq");
  const sizeIndicators = sizeEntries.flatMap((entry) => {
    const indicator = sizeIndicatorFromDocument(entry);
    return indicator === null ? [] : [indicator];
  });
  const missingFacts: string[] = [];
  if (domain.site === null) missingFacts.push("verified_official_identity");
  if (namedProductEvidenceIds.length === 0) {
    missingFacts.push("first_party_named_product");
  }
  if (websiteFacts.ownershipConflicting || ownershipStatus === "unknown") {
    missingFacts.push("ownership");
  }
  if (websiteFacts.sizeAssessment === "unknown") {
    missingFacts.push("revenue_under_50m");
  }
  if (
    websiteFacts.headquartersStatus !== "supported" ||
    websiteFacts.headquarters?.country !== "US"
  ) {
    missingFacts.push("us_headquarters");
  }

  const researchEvidence: SourcedSignalResearchEvidence = {
    version: SIGNAL_RESEARCH_VERSION,
    signalId: options.signal.id,
    sourceContext: {
      sourceKey: options.signal.sourceKey,
      sourceLocator: options.signal.sourceLocator,
      sourceFingerprint: options.signal.sourceFingerprint,
      rawName: options.signal.rawName,
      rawDomain: options.signal.rawDomain,
      uei: options.signal.uei,
      cage: options.signal.cage,
      city: options.signal.city,
      state: options.signal.state,
      country: options.signal.country,
      awardCount: options.signal.awardCount,
    },
    identity: {
      status: domain.status,
      verifiedDomain: domain.site?.domain ?? null,
      legalName: options.signal.rawName,
      proofEvidenceIds: domainEvidenceIds,
    },
    website: {
      status:
        domain.site === null
          ? "not_checked"
          : website?.outcome === "success"
            ? "supported"
            : "no_content",
      offering: website?.websiteOffering ?? "unknown",
      excerpts: website?.excerpts ?? "",
      productHints: website?.productHints ?? [],
      namedProductEvidenceIds,
    },
    ownership: {
      status: websiteFacts.ownershipConflicting ? "unknown" : ownershipStatus,
      owner: websiteFacts.ownershipConflicting ? null : ownershipOwner,
      year:
        websiteFacts.ownershipConflicting ? null : (acquisitionFinding?.year ?? null),
      conflicting: websiteFacts.ownershipConflicting,
      currentness: websiteFacts.ownershipConflicting
        ? "unknown"
        : ownershipStatus === "independent"
          ? "explicit_current_independence"
          : ownershipStatus === "unknown"
            ? "unknown"
            : "explicit_current_relation",
      supportEvidenceIds: uniqueStrings(
        ownershipEntries.map((entry) => entry.evidenceId),
      ),
    },
    size: {
      status:
        websiteFacts.sizeAssessment === "unknown" ? "unknown" : "supported",
      assessment: websiteFacts.sizeAssessment,
      conflicting: websiteFacts.sizeConflicting,
      indicators: sizeIndicators,
    },
    headquarters: {
      status: websiteFacts.headquartersStatus,
      city: websiteFacts.headquarters?.city ?? null,
      state: websiteFacts.headquarters?.state ?? null,
      country: websiteFacts.headquarters?.country ?? null,
      supportEvidenceIds: uniqueStrings(
        hqEntries.map((entry) => entry.evidenceId),
      ),
    },
    missingFacts,
    checkedSources,
    evidenceRefs,
  };

  return {
    outcome: "completed",
    researchEvidence,
    costUsd,
    researchDueAt: new Date(now.getTime() + SIGNAL_RESEARCH_COOLDOWN_MS),
  };
}

export interface AdmitSignalResourceEvidenceOptions {
  /** Use the transaction supplied by publishSignalAnalystEvidence. */
  readonly db: SignalReviewExecutor;
  readonly signal: SignalEvidenceSourceSignal;
  readonly currentEvidence: SourcedSignalResearchEvidence;
  readonly observations: readonly AnalystResourceObservation[];
}

export interface SignalEvidenceAdmissionResult {
  readonly researchEvidence: SourcedSignalResearchEvidence;
  readonly admissionRevision: string;
  readonly admittedEvidenceIds: readonly string[];
  readonly checkedSources: readonly CheckedSourceReference[];
  readonly conflicts: readonly string[];
  readonly ambiguousPrimaryCandidates: readonly string[];
}

/**
 * Admit literal resource observations under the caller's current signal.
 * Search snippets, failed/access-limited resources and checked-only references
 * remain history only. Invoke this inside publishSignalAnalystEvidence's
 * callback; this function intentionally does not publish a case or Jev input.
 */
export async function admitSignalResourceEvidence(
  options: AdmitSignalResourceEvidenceOptions,
): Promise<SignalEvidenceAdmissionResult> {
  if (
    options.currentEvidence.signalId !== options.signal.id ||
    options.currentEvidence.sourceContext.sourceKey !==
      options.signal.sourceKey ||
    options.currentEvidence.sourceContext.sourceLocator !==
      options.signal.sourceLocator ||
    options.currentEvidence.sourceContext.sourceFingerprint !==
      options.signal.sourceFingerprint ||
    options.currentEvidence.sourceContext.rawName !== options.signal.rawName ||
    options.currentEvidence.sourceContext.rawDomain !== options.signal.rawDomain ||
    options.currentEvidence.sourceContext.uei !== options.signal.uei ||
    options.currentEvidence.sourceContext.cage !== options.signal.cage ||
    options.currentEvidence.sourceContext.city !== options.signal.city ||
    options.currentEvidence.sourceContext.state !== options.signal.state ||
    options.currentEvidence.sourceContext.country !== options.signal.country ||
    options.currentEvidence.sourceContext.awardCount !== options.signal.awardCount
  ) {
    throw new TypeError(
      "Current evidence does not match the current source-signal identity revision",
    );
  }
  const checkedSources = [
    ...options.currentEvidence.checkedSources,
    ...checkedSourcesFromObservations(options.observations),
  ];
  const pages = admittedPages(options.observations);
  const refreshedCurrentEvidence = supersedeRefreshedIdentityEvidence(
    options.currentEvidence,
    pages,
  );
  const primary = admittedPrimaryRecords(options.observations);
  const ambiguousPrimaryCandidates = primary.ambiguous
    ? primary.records.map((record) => record.sourceLocator)
    : [];
  const identityRejectedDomains = new Set(
    explicitlyConflictingPrimaryDomains(options.signal, pages, primary),
  );
  const retainedVerifiedDomain =
    refreshedCurrentEvidence.identity.verifiedDomain;
  if (
    retainedVerifiedDomain !== null &&
    primary.records.some(
      (record) =>
        exactLegalName(options.signal.rawName, record.legalName) &&
        (primary.ambiguous ||
          !primaryRecordCompatibleWithSignal(options.signal, record)),
    )
  ) {
    identityRejectedDomains.add(retainedVerifiedDomain);
  }
  const publisherConflictFilteredEvidence = invalidateRejectedPublisherEvidence(
    refreshedCurrentEvidence,
    identityRejectedDomains,
  );
  const retainedPrimary = retainedPrimaryIdentities(
    publisherConflictFilteredEvidence,
    options.signal,
    primary,
  );
  const retainedPrimaryEvidenceIds = new Set(
    retainedPrimary.map((candidate) => candidate.evidenceId),
  );
  const registryProofIds = new Set(
    publisherConflictFilteredEvidence.evidenceRefs
      .filter(
        (reference) =>
          reference.stage === "domain" &&
          reference.sourceKind === "registry" &&
          publisherConflictFilteredEvidence.identity.proofEvidenceIds.includes(
            reference.evidenceId,
          ),
      )
      .map((reference) => reference.evidenceId),
  );
  const conflictFilteredCurrentEvidence =
    registryProofIds.size === retainedPrimaryEvidenceIds.size
      ? publisherConflictFilteredEvidence
      : {
          ...publisherConflictFilteredEvidence,
          identity: {
            ...publisherConflictFilteredEvidence.identity,
            proofEvidenceIds:
              publisherConflictFilteredEvidence.identity.proofEvidenceIds.filter(
                (evidenceId) =>
                  !registryProofIds.has(evidenceId) ||
                  retainedPrimaryEvidenceIds.has(evidenceId),
              ),
          },
        };
  const identityPages = admittedIdentityProofPages(
    conflictFilteredCurrentEvidence,
    pages,
  );
  const identity = resolveAdmittedIdentity(
    options.signal,
    identityPages,
    primary,
    identityRejectedDomains,
    retainedPrimary,
  );
  const invalidatedRetainedDomains = new Set(identityRejectedDomains);
  const previousVerifiedDomain =
    conflictFilteredCurrentEvidence.identity.verifiedDomain;
  if (
    previousVerifiedDomain !== null &&
    (!identity.verified || identity.domain !== previousVerifiedDomain)
  ) {
    invalidatedRetainedDomains.add(previousVerifiedDomain);
  }
  const retainedCurrentEvidence = invalidateRejectedPublisherEvidence(
    conflictFilteredCurrentEvidence,
    invalidatedRetainedDomains,
  );
  const verifiedPages =
    identity.domain === null
      ? []
      : pages.filter(
          (page) => normalizeCandidateDomain(page.url) === identity.domain,
        );
  const documents: PendingEvidenceDocument[] = [];
  if (identity.verified && identity.domain !== null) {
    for (const proof of identity.proofQuotes) {
      const page = identityPages[proof.pageIndex];
      if (page === undefined) continue;
      documents.push(
        admittedIdentityDocument(
          page,
          proof.quote,
          options.signal.rawName,
          "verified",
          identity.corroboratedBy,
        ),
      );
    }
    for (const page of verifiedPages) {
      documents.push(
        websitePageDocument(page, options.signal.rawName),
        ...websiteProductDocuments(page, options.signal.rawName),
      );
    }
  } else {
    documents.push(
      ...admittedIdentityCandidateDocuments(
        options.signal,
        pages,
        identityPages,
        identityRejectedDomains,
      ),
    );
  }
  for (const support of identity.supportingPrimaryRecords) {
    const document = primaryIdentityDocument(
      support.record,
      support.identitySignal,
    );
    if (document !== null) documents.push(document);
  }
  const websiteFacts = extractWebsiteFacts(
    verifiedPages.length === 0
      ? null
      : { outcome: "success", pages: verifiedPages },
    options.signal.rawName,
  );
  const admittedFacts = mergeExternalOwnershipFacts(
    websiteFacts,
    extractExternalOwnershipFacts(
      pages.filter((page) => {
        const domain = normalizeCandidateDomain(page.url);
        const isVerifiedTarget =
          identity.domain !== null && domain === identity.domain;
        const isExplicitlyWrongTarget =
          domain !== null && identityRejectedDomains.has(domain);
        return !isVerifiedTarget && !isExplicitlyWrongTarget;
      }),
      options.signal.rawName,
    ),
  );
  documents.push(
    ...admittedFacts.ownershipDocuments,
    ...admittedFacts.sizeDocuments,
    ...admittedFacts.headquartersDocuments,
  );
  const admissionRevision = researchRevision(options.signal, documents);
  const persisted = await persistEvidenceDocuments(
    options.db,
    options.signal.id,
    admissionRevision,
    documents,
  );
  const evidenceRefs = dedupeEvidenceReferences([
    ...persisted.map(toEvidenceReference),
    ...retainedCurrentEvidence.evidenceRefs,
  ]);
  const conflicts: string[] = [];
  const ownership = mergeOwnership(
    revalidateRetainedOwnership(
      retainedCurrentEvidence,
      options.signal.rawName,
    ),
    admittedFacts,
    persisted,
    conflicts,
  );
  const size = mergeSize(
    retainedCurrentEvidence.size,
    admittedFacts,
    persisted,
    conflicts,
  );
  const headquarters = mergeHeadquarters(
    retainedCurrentEvidence.headquarters,
    admittedFacts,
    persisted,
    conflicts,
  );
  const identityEvidenceIds = persisted
    .filter(
      (document) =>
        document.stage === "domain" &&
        document.metadata["identityOutcome"] === "verified",
    )
    .map((document) => document.evidenceId);
  const namedProductEvidenceIds = persisted
    .filter(
      (document) =>
        document.stage === "website" &&
        document.firstParty &&
        document.metadata["namedProductEvidence"] === true,
    )
    .map((document) => document.evidenceId);
  const identityStatus = identity.verified
    ? "verified"
    : primary.ambiguous ||
        identityPages.length > 0 ||
        options.currentEvidence.identity.status === "verified"
      ? "ambiguous"
      : retainedCurrentEvidence.identity.status;
  const allNamedProducts = uniqueStrings([
    ...retainedCurrentEvidence.website.namedProductEvidenceIds,
    ...namedProductEvidenceIds,
  ]);
  const missingFacts: string[] = [];
  if (identityStatus !== "verified") {
    missingFacts.push("verified_official_identity");
  }
  if (allNamedProducts.length === 0) {
    missingFacts.push("first_party_named_product");
  }
  if (ownership.status === "unknown") missingFacts.push("ownership");
  if (size.assessment === "unknown") missingFacts.push("revenue_under_50m");
  if (
    headquarters.status !== "supported" ||
    headquarters.country !== "US"
  ) {
    missingFacts.push("us_headquarters");
  }
  const classifiedPages = classifyWebsiteEvidence(verifiedPages);
  const researchEvidence: SourcedSignalResearchEvidence = {
    ...retainedCurrentEvidence,
    identity: {
      ...retainedCurrentEvidence.identity,
      status: identityStatus,
      verifiedDomain: identity.verified ? identity.domain : null,
      proofEvidenceIds: identity.verified
        ? uniqueStrings([
            ...identity.retainedPrimaryEvidenceIds,
            ...identityEvidenceIds,
          ])
        : [],
    },
    website: {
      status:
        verifiedPages.length > 0
          ? "supported"
          : retainedCurrentEvidence.website.status,
      offering:
        retainedCurrentEvidence.website.offering === "unknown"
          ? classifiedPages.websiteOffering
          : retainedCurrentEvidence.website.offering,
      excerpts: boundSignalEvidenceText(
        [
          retainedCurrentEvidence.website.excerpts,
          ...verifiedPages.map((page) => page.excerpt),
        ]
          .filter((value) => value !== "")
          .join("\n"),
        WEBSITE_EXCERPTS_MAX_CHARS,
      ),
      productHints: uniqueStrings([
        ...retainedCurrentEvidence.website.productHints,
        ...classifiedPages.productHints,
      ]),
      namedProductEvidenceIds: allNamedProducts,
    },
    ownership,
    size,
    headquarters,
    missingFacts,
    checkedSources: dedupeCheckedSources(checkedSources),
    evidenceRefs,
  };
  return {
    researchEvidence,
    admissionRevision,
    admittedEvidenceIds: persisted.map((document) => document.evidenceId),
    checkedSources: researchEvidence.checkedSources,
    conflicts,
    ambiguousPrimaryCandidates,
  };
}

interface AdmittedPage extends WebsiteFetchedPage {
  readonly representation:
    | "normalized_publisher_text"
    | "provider_extracted_text";
}

interface AdmittedIdentityProofPage {
  readonly content: string;
  readonly finalUrl: string;
  readonly title: string | null;
  readonly contentSha256: string;
  readonly retrievedAt: string;
  readonly representation:
    | "normalized_publisher_text"
    | "provider_extracted_text"
    | null;
  readonly isRetainedProof: boolean;
}

interface AdmittedPrimarySet {
  readonly records: readonly AnalystPrimaryRecord[];
  readonly ambiguous: boolean;
}

interface RetainedPrimaryIdentity {
  readonly evidenceId: string;
  readonly identitySignal: Pick<
    SignalEvidenceSourceSignal,
    "rawName" | "uei" | "cage" | "city" | "state"
  >;
}

function admittedPages(
  observations: readonly AnalystResourceObservation[],
): AdmittedPage[] {
  const pages: AdmittedPage[] = [];
  for (const observation of observations) {
    if (
      observation.tool === "public_page" &&
      observation.outcome === "success" &&
      observation.body !== null
    ) {
      const reference = observation.sourceReferences[0];
      if (
        reference?.finalUrl === null ||
        reference?.finalUrl === undefined ||
        reference.contentSha256 === null ||
        reference.retrievedAt === null
      ) {
        continue;
      }
      const text = observation.body;
      pages.push({
        url: reference.finalUrl,
        title: "",
        text,
        textChars: text.length,
        excerpt: boundSignalEvidenceText(text, EVIDENCE_QUOTE_MAX_CHARS),
        contentSha256: reference.contentSha256,
        retrievedAt: reference.retrievedAt,
        representation: "normalized_publisher_text",
      });
    } else if (
      observation.tool === "exa_contents" &&
      observation.outcome === "success"
    ) {
      for (const page of observation.pages) {
        const reference = observation.sourceReferences.find(
          (candidate) => candidate.finalUrl === page.url,
        );
        if (
          reference?.retrievedAt === null ||
          reference?.retrievedAt === undefined
        ) {
          continue;
        }
        const text = normalizeEvidencePageText(page.extractedText);
        pages.push({
          url: page.url,
          title: page.title,
          text,
          textChars: text.length,
          excerpt: boundSignalEvidenceText(text, EVIDENCE_QUOTE_MAX_CHARS),
          contentSha256: page.extractedTextSha256,
          retrievedAt: reference.retrievedAt,
          representation: "provider_extracted_text",
        });
      }
    }
  }
  return dedupeAdmittedPages(pages);
}

function supersedeRefreshedIdentityEvidence(
  evidence: SourcedSignalResearchEvidence,
  pages: readonly AdmittedPage[],
): SourcedSignalResearchEvidence {
  if (pages.length === 0) return evidence;
  const refreshedUrls = new Set(pages.map((page) => page.url));
  const supersededEvidenceIds = new Set(
    evidence.evidenceRefs
      .filter(
        (reference) =>
          reference.stage === "domain" &&
          (reference.sourceKind === "official_site" ||
            reference.sourceKind === "publisher_site") &&
          refreshedUrls.has(reference.url),
      )
      .map((reference) => reference.evidenceId),
  );
  if (supersededEvidenceIds.size === 0) return evidence;
  return {
    ...evidence,
    identity: {
      ...evidence.identity,
      proofEvidenceIds: evidence.identity.proofEvidenceIds.filter(
        (evidenceId) => !supersededEvidenceIds.has(evidenceId),
      ),
    },
    evidenceRefs: evidence.evidenceRefs.filter(
      (reference) => !supersededEvidenceIds.has(reference.evidenceId),
    ),
  };
}

function admittedIdentityProofPages(
  current: SourcedSignalResearchEvidence,
  pages: readonly AdmittedPage[],
): AdmittedIdentityProofPage[] {
  const freshPageUrls = new Set<string>();
  const proofPages = pages.map((page) => {
    freshPageUrls.add(page.url);
    return admittedPageIdentityProofPage(page);
  });
  const retainedProofIds = new Set(current.identity.proofEvidenceIds);
  for (const reference of current.evidenceRefs) {
    if (
      reference.stage !== "domain" ||
      (reference.role !== "checked_only" &&
        !retainedProofIds.has(reference.evidenceId)) ||
      (reference.sourceKind !== "official_site" &&
        reference.sourceKind !== "publisher_site") ||
      reference.quote.trim() === "" ||
      reference.quote.length > EVIDENCE_QUOTE_MAX_CHARS ||
      normalizeCandidateDomain(reference.url) === null ||
      freshPageUrls.has(reference.url)
    ) {
      continue;
    }
    proofPages.push({
      content: reference.quote,
      finalUrl: reference.url,
      title: reference.title,
      contentSha256: reference.contentSha256,
      retrievedAt: reference.retrievedAt,
      representation: null,
      isRetainedProof: true,
    });
  }
  return proofPages;
}

function admittedPageIdentityProofPage(
  page: AdmittedPage,
): AdmittedIdentityProofPage {
  return {
    content: page.text,
    finalUrl: page.url,
    title: page.title || null,
    contentSha256: page.contentSha256,
    retrievedAt: page.retrievedAt,
    representation: page.representation,
    isRetainedProof: false,
  };
}

function admittedIdentityDocument(
  page: AdmittedIdentityProofPage,
  quote: string,
  companyName: string,
  identityOutcome: "verified" | "ambiguous",
  corroboratedBy: "identifier" | "location" | null,
): PendingEvidenceDocument {
  return {
    stage: "domain",
    url: page.finalUrl,
    title: page.title ?? `Official-site identity: ${companyName}`,
    quote,
    contentSha256: page.contentSha256,
    retrievedAt: page.retrievedAt,
    sourceKind:
      identityOutcome === "verified" ? "official_site" : "publisher_site",
    firstParty: identityOutcome === "verified",
    metadata: {
      identityOutcome,
      corroboratedBy,
      ...(page.representation === null
        ? {}
        : { representation: page.representation }),
    },
  };
}

function admittedIdentityCandidateDocuments(
  signal: SignalEvidenceSourceSignal,
  pages: readonly AdmittedPage[],
  proofPages: readonly AdmittedIdentityProofPage[],
  rejectedDomains: ReadonlySet<string>,
): PendingEvidenceDocument[] {
  const pagesByDomain = new Map<string, AdmittedIdentityProofPage[]>();
  for (const page of proofPages) {
    const domain = normalizeCandidateDomain(page.finalUrl);
    if (domain === null) continue;
    const grouped = pagesByDomain.get(domain) ?? [];
    grouped.push(page);
    pagesByDomain.set(domain, grouped);
  }
  const documents: PendingEvidenceDocument[] = [];
  for (const page of pages) {
    const domain = normalizeCandidateDomain(page.url);
    if (domain === null || rejectedDomains.has(domain)) continue;
    const grouped = pagesByDomain.get(domain) ?? [];
    const assessment = assessSignalSiteIdentity(
      signal,
      grouped.map((candidate) => candidate.content),
      grouped.map((candidate) => candidate.finalUrl),
    );
    const proofPage = admittedPageIdentityProofPage(page);
    for (const quote of signalIdentityPageQuotes(
      page.text,
      page.url,
      signal,
      assessment,
    )) {
      documents.push(
        admittedIdentityDocument(
          proofPage,
          quote,
          signal.rawName,
          "ambiguous",
          assessment.corroboratedBy,
        ),
      );
    }
  }
  return documents;
}

function admittedPrimaryRecords(
  observations: readonly AnalystResourceObservation[],
): AdmittedPrimarySet {
  const records: AnalystPrimaryRecord[] = [];
  let ambiguous = false;
  for (const observation of observations) {
    if (
      observation.tool !== "primary_records" ||
      observation.outcome !== "success"
    ) {
      continue;
    }
    ambiguous ||= observation.ambiguous;
    for (const record of observation.records) {
      if (
        !records.some(
          (existing) =>
            existing.sourceFingerprint === record.sourceFingerprint &&
            existing.sourceLocator === record.sourceLocator,
        )
      ) {
        records.push(record);
      }
    }
  }
  return {
    records,
    ambiguous: ambiguous || admittedPrimaryRecordsConflict(records),
  };
}

function retainedPrimaryIdentities(
  evidence: SourcedSignalResearchEvidence,
  signal: SignalEvidenceSourceSignal,
  primary: AdmittedPrimarySet,
): RetainedPrimaryIdentity[] {
  if (primary.ambiguous) return [];
  const proofEvidenceIds = new Set(evidence.identity.proofEvidenceIds);
  const retained: RetainedPrimaryIdentity[] = [];
  for (const reference of evidence.evidenceRefs) {
    if (
      reference.stage !== "domain" ||
      reference.role !== "support" ||
      reference.sourceKind !== "registry" ||
      !proofEvidenceIds.has(reference.evidenceId) ||
      reference.quote.trim() === "" ||
      reference.quote.length > EVIDENCE_QUOTE_MAX_CHARS
    ) {
      continue;
    }
    const legalName =
      /(?:^|;\s*)legal name:\s*([^;\n]+)/iu.exec(reference.quote)?.[1]?.trim() ??
      null;
    if (legalName === null || !exactLegalName(signal.rawName, legalName)) {
      continue;
    }
    const rawUei =
      /(?:^|;\s*)UEI:\s*([^;\s]+)/iu.exec(reference.quote)?.[1]?.trim() ??
      null;
    const rawCage =
      /(?:^|;\s*)CAGE:\s*([^;\s]+)/iu.exec(reference.quote)?.[1]?.trim() ??
      null;
    const location =
      /(?:^|;\s*)location:\s*([^,;\n]+),\s*([^;\n]+)/iu.exec(reference.quote);
    const uei =
      rawUei !== null &&
      normalizedValidPublishedIdentifier("UEI", rawUei) !== null
        ? rawUei
        : null;
    const cage =
      rawCage !== null &&
      normalizedValidPublishedIdentifier("CAGE", rawCage) !== null
        ? rawCage
        : null;
    const city = location?.[1]?.trim() || null;
    const state = location?.[2]?.trim() || null;
    if (
      uei === null &&
      cage === null &&
      (city === null || state === null)
    ) {
      continue;
    }
    const retainedValues = { uei, cage, city, state };
    if (
      !primaryRecordCompatibleWithSignal(signal, retainedValues) ||
      primary.records.some(
        (record) =>
          exactLegalName(signal.rawName, record.legalName) &&
          !primaryRecordCompatibleWithSignal(
            {
              uei: signal.uei ?? uei,
              cage: signal.cage ?? cage,
              city: signal.city ?? city,
              state: signal.state ?? state,
            },
            record,
          ),
      )
    ) {
      continue;
    }
    retained.push({
      evidenceId: reference.evidenceId,
      identitySignal: {
        rawName: signal.rawName,
        uei: signal.uei ?? uei,
        cage: signal.cage ?? cage,
        city: signal.city ?? city,
        state: signal.state ?? state,
      },
    });
  }
  return retained;
}

interface ResolvedAdmittedIdentity {
  readonly verified: boolean;
  readonly domain: string | null;
  readonly corroboratedBy: "identifier" | "location" | null;
  readonly identitySignal: Pick<
    SignalEvidenceSourceSignal,
    "rawName" | "uei" | "cage" | "city" | "state"
  >;
  readonly proofQuotes: readonly SignalIdentityPageQuote[];
  readonly retainedPrimaryEvidenceIds: readonly string[];
  readonly supportingPrimaryRecords: readonly {
    readonly record: AnalystPrimaryRecord;
    readonly identitySignal: Pick<
      SignalEvidenceSourceSignal,
      "rawName" | "uei" | "cage" | "city" | "state"
    >;
  }[];
}

function resolveAdmittedIdentity(
  signal: SignalEvidenceSourceSignal,
  pages: readonly AdmittedIdentityProofPage[],
  primary: AdmittedPrimarySet,
  rejectedDomains: ReadonlySet<string>,
  retainedPrimary: readonly RetainedPrimaryIdentity[],
): ResolvedAdmittedIdentity {
  const directMatches = verifiedDomainMatches(signal, pages).filter(
    (match) => !rejectedDomains.has(match.domain),
  );
  const directMatch =
    directMatches.length === 1
      ? directMatches[0]
      : directMatches.find((candidate) =>
          directMatches.every(
            (match) =>
              match.domain === candidate.domain ||
              match.domain.endsWith(`.${candidate.domain}`),
          ),
        );
  if (directMatch !== undefined) {
    return {
      verified: true,
      domain: directMatch.domain,
      corroboratedBy: directMatch.assessment.corroboratedBy,
      identitySignal: signal,
      supportingPrimaryRecords: [],
      proofQuotes: directMatch.proofQuotes,
      retainedPrimaryEvidenceIds: retainedPrimary.map(
        (candidate) => candidate.evidenceId,
      ),
    };
  }
  if (directMatches.length > 1) return unresolvedAdmittedIdentity(signal);
  const exactPrimary = primary.records.filter(
    (record) =>
      primaryRecordMatchesSignal(signal, record) &&
      primaryIdentityDocument(record, signal) !== null,
  );
  if (!primary.ambiguous && exactPrimary.length > 0) {
    const basis = exactPrimary.some(
      (record) =>
        exactIdentifier(signal.uei, record.uei) ||
        exactIdentifier(signal.cage, record.cage),
    )
      ? "identifier"
      : "location";
    return {
      verified: true,
      domain: null,
      corroboratedBy: basis,
      identitySignal: signal,
      proofQuotes: [],
      retainedPrimaryEvidenceIds: retainedPrimary.map(
        (candidate) => candidate.evidenceId,
      ),
      supportingPrimaryRecords: exactPrimary.map((record) => ({
        record,
        identitySignal: signal,
      })),
    };
  }
  const pagePrimaryMatches = primary.records.flatMap((record) => {
    if (
      !exactLegalName(signal.rawName, record.legalName) ||
      !primaryRecordCompatibleWithSignal(signal, record)
    ) {
      return [];
    }
    const identitySignal = {
      rawName: signal.rawName,
      uei: signal.uei ?? record.uei,
      cage: signal.cage ?? record.cage,
      city: signal.city ?? record.city,
      state: signal.state ?? record.state,
    };
    if (primaryIdentityDocument(record, identitySignal) === null) return [];
    return verifiedDomainMatches(identitySignal, pages).map((match) => ({
      record,
      identitySignal,
      ...match,
    }));
  });
  const matchedDomains = uniqueStrings(
    pagePrimaryMatches.map((match) => match.domain),
  );
  if (
    !primary.ambiguous &&
    matchedDomains.length === 1 &&
    pagePrimaryMatches.length > 0
  ) {
    const match = pagePrimaryMatches[0]!;
    return {
      verified: true,
      domain: match.domain,
      corroboratedBy: match.assessment.corroboratedBy,
      identitySignal: match.identitySignal,
      proofQuotes: match.proofQuotes,
      retainedPrimaryEvidenceIds: retainedPrimary.map(
        (candidate) => candidate.evidenceId,
      ),
      supportingPrimaryRecords: pagePrimaryMatches.map((candidate) => ({
        record: candidate.record,
        identitySignal: candidate.identitySignal,
      })),
    };
  }
  const retainedPagePrimaryMatches = retainedPrimary.flatMap((candidate) =>
    verifiedDomainMatches(candidate.identitySignal, pages).map((match) => ({
      ...candidate,
      ...match,
    })),
  );
  const retainedMatchedDomains = uniqueStrings(
    retainedPagePrimaryMatches.map((match) => match.domain),
  );
  if (
    retainedMatchedDomains.length === 1 &&
    retainedPagePrimaryMatches.length > 0
  ) {
    const match = retainedPagePrimaryMatches[0]!;
    return {
      verified: true,
      domain: match.domain,
      corroboratedBy: match.assessment.corroboratedBy,
      identitySignal: match.identitySignal,
      proofQuotes: match.proofQuotes,
      retainedPrimaryEvidenceIds: retainedPrimary.map(
        (candidate) => candidate.evidenceId,
      ),
      supportingPrimaryRecords: [],
    };
  }
  if (retainedMatchedDomains.length > 1) {
    return unresolvedAdmittedIdentity(signal);
  }
  if (retainedPrimary.length > 0) {
    const retained = retainedPrimary[0]!;
    return {
      verified: true,
      domain: null,
      corroboratedBy:
        retained.identitySignal.uei !== null ||
        retained.identitySignal.cage !== null
          ? "identifier"
          : "location",
      identitySignal: retained.identitySignal,
      proofQuotes: [],
      retainedPrimaryEvidenceIds: retainedPrimary.map(
        (candidate) => candidate.evidenceId,
      ),
      supportingPrimaryRecords: [],
    };
  }
  return unresolvedAdmittedIdentity(signal);
}

function unresolvedAdmittedIdentity(
  signal: SignalEvidenceSourceSignal,
): ResolvedAdmittedIdentity {
  return {
    verified: false,
    domain: null,
    corroboratedBy: null,
    identitySignal: signal,
    proofQuotes: [],
    retainedPrimaryEvidenceIds: [],
    supportingPrimaryRecords: [],
  };
}

function verifiedDomainMatches(
  signal: Pick<
    SignalEvidenceSourceSignal,
    "rawName" | "uei" | "cage" | "city" | "state"
  >,
  pages: readonly AdmittedIdentityProofPage[],
): readonly {
  readonly domain: string;
  readonly assessment: SignalIdentityAssessment;
  readonly proofQuotes: readonly SignalIdentityPageQuote[];
}[] {
  const groups = new Map<
    string,
    Array<{
      readonly page: AdmittedIdentityProofPage;
      readonly pageIndex: number;
    }>
  >();
  for (const [pageIndex, page] of pages.entries()) {
    const domain = normalizeCandidateDomain(page.finalUrl);
    if (domain === null) continue;
    const group = groups.get(domain) ?? [];
    group.push({ page, pageIndex });
    groups.set(domain, group);
  }
  const matches: Array<{
    readonly domain: string;
    readonly assessment: SignalIdentityAssessment;
    readonly proofQuotes: readonly SignalIdentityPageQuote[];
  }> = [];
  for (const [domain, entriesForAssessment] of groups) {
    const pagesForAssessment = entriesForAssessment.map((entry) => entry.page);
    const assessment = entriesForAssessment.some(
      (entry) => entry.page.isRetainedProof,
    )
      ? assessSignalIdentityContent(
          signal,
          pagesForAssessment.map((page) => page.content),
          pagesForAssessment.map((page) => page.finalUrl),
          false,
        )
      : assessSignalSiteIdentity(
          signal,
          pagesForAssessment.map((page) => page.content),
          pagesForAssessment.map((page) => page.finalUrl),
        );
    const proofQuotes = buildSignalIdentityProofQuotes(
      pagesForAssessment,
      signal,
      assessment,
    );
    if (proofQuotes.length === 0) continue;
    matches.push({
      domain,
      assessment,
      proofQuotes: proofQuotes.map((proof) => ({
        pageIndex: entriesForAssessment[proof.pageIndex]!.pageIndex,
        quote: proof.quote,
      })),
    });
  }
  return matches;
}

function explicitlyConflictingPrimaryDomains(
  signal: SignalEvidenceSourceSignal,
  pages: readonly AdmittedPage[],
  primary: AdmittedPrimarySet,
): ReadonlySet<string> {
  const rejected = new Set<string>();
  const pagesByDomain = new Map<string, AdmittedPage[]>();
  for (const page of pages) {
    const domain = normalizeCandidateDomain(page.url);
    if (domain === null) continue;
    const grouped = pagesByDomain.get(domain) ?? [];
    grouped.push(page);
    pagesByDomain.set(domain, grouped);
  }
  for (const [domain, grouped] of pagesByDomain) {
    const texts = grouped.map((page) => page.text);
    const urls = grouped.map((page) => page.url);
    const uei = targetPublisherIdentifierAssessment(
      texts,
      urls,
      signal.rawName,
      "UEI",
      signal.uei,
    );
    const cage = targetPublisherIdentifierAssessment(
      texts,
      urls,
      signal.rawName,
      "CAGE",
      signal.cage,
    );
    if (uei.conflicting || cage.conflicting) rejected.add(domain);
  }
  const observedIdentityPages = pages.map(admittedPageIdentityProofPage);
  for (const record of primary.records) {
    if (
      !exactLegalName(signal.rawName, record.legalName) ||
      (!primary.ambiguous &&
        primaryRecordCompatibleWithSignal(signal, record))
    ) {
      continue;
    }
    const recordIdentity = {
      rawName: signal.rawName,
      uei: record.uei,
      cage: record.cage,
      city: record.city,
      state: record.state,
    };
    for (const match of verifiedDomainMatches(
      recordIdentity,
      observedIdentityPages,
    )) {
      rejected.add(match.domain);
    }
  }
  return rejected;
}

function invalidateRejectedPublisherEvidence(
  evidence: SourcedSignalResearchEvidence,
  rejectedDomains: ReadonlySet<string>,
): SourcedSignalResearchEvidence {
  if (rejectedDomains.size === 0) return evidence;
  const rejectedEvidenceIds = new Set(
    evidence.evidenceRefs
      .filter((reference) => {
        const domain = normalizeCandidateDomain(reference.url);
        return domain !== null && rejectedDomains.has(domain);
      })
      .map((reference) => reference.evidenceId),
  );
  const retainIds = (ids: readonly string[]): string[] =>
    ids.filter((id) => !rejectedEvidenceIds.has(id));
  const identityDomain = evidence.identity.verifiedDomain;
  const identityInvalidated =
    identityDomain !== null && rejectedDomains.has(identityDomain);
  const proofEvidenceIds = retainIds(evidence.identity.proofEvidenceIds);
  const namedProductEvidenceIds = retainIds(
    evidence.website.namedProductEvidenceIds,
  );
  const hasRetainedWebsiteSupport = evidence.evidenceRefs.some(
    (reference) =>
      reference.stage === "website" &&
      reference.firstParty &&
      !rejectedEvidenceIds.has(reference.evidenceId),
  );
  const websiteInvalidated =
    identityInvalidated && !hasRetainedWebsiteSupport;
  const ownershipSupportIds = retainIds(evidence.ownership.supportEvidenceIds);
  const ownershipInvalidated =
    evidence.ownership.supportEvidenceIds.length > 0 &&
    ownershipSupportIds.length === 0;
  const rebuiltOwnership =
    evidence.ownership.supportEvidenceIds.length !== ownershipSupportIds.length
      ? rebuildRetainedOwnership(evidence, ownershipSupportIds)
      : null;
  const sizeIndicators = evidence.size.indicators.filter(
    (indicator) => !rejectedEvidenceIds.has(indicator.evidenceId),
  );
  const sizeInvalidated =
    evidence.size.indicators.length > 0 && sizeIndicators.length === 0;
  const headquartersSupportIds = retainIds(
    evidence.headquarters.supportEvidenceIds,
  );
  const headquartersInvalidated =
    evidence.headquarters.supportEvidenceIds.length > 0 &&
    headquartersSupportIds.length === 0;
  return {
    ...evidence,
    evidenceRefs: evidence.evidenceRefs.map((reference) =>
      rejectedEvidenceIds.has(reference.evidenceId) && reference.firstParty
        ? {
            ...reference,
            sourceKind: "publisher_site",
            firstParty: false,
          }
        : reference,
    ),
    identity: {
      ...evidence.identity,
      status: identityInvalidated ? "ambiguous" : evidence.identity.status,
      verifiedDomain: identityInvalidated
        ? null
        : evidence.identity.verifiedDomain,
      proofEvidenceIds,
    },
    website: websiteInvalidated
      ? {
          status: "not_checked",
          offering: "unknown",
          excerpts: "",
          productHints: [],
          namedProductEvidenceIds,
        }
      : { ...evidence.website, namedProductEvidenceIds },
    ownership:
      rebuiltOwnership ??
      (ownershipInvalidated ||
        evidence.ownership.supportEvidenceIds.length !==
          ownershipSupportIds.length
        ? {
            status: "unknown",
            owner: null,
            year: null,
            conflicting: false,
            currentness: "unknown",
            supportEvidenceIds: ownershipSupportIds,
          }
        : {
            ...evidence.ownership,
            supportEvidenceIds: ownershipSupportIds,
          }),
    size: sizeInvalidated
      ? {
          status: "unknown",
          assessment: "unknown",
          conflicting: false,
          indicators: sizeIndicators,
        }
      : { ...evidence.size, indicators: sizeIndicators },
    headquarters: headquartersInvalidated
      ? {
          status: "unknown",
          city: null,
          state: null,
          country: null,
          supportEvidenceIds: headquartersSupportIds,
        }
      : {
          ...evidence.headquarters,
          supportEvidenceIds: headquartersSupportIds,
        },
  };
}

function rebuildRetainedOwnership(
  evidence: SourcedSignalResearchEvidence,
  supportEvidenceIds: readonly string[],
): SourcedSignalResearchEvidence["ownership"] | null {
  const retained = new Set(supportEvidenceIds);
  const observations: Array<{
    readonly status: AcquisitionStatus | "independent";
    readonly owner: string | null;
  }> = [];
  for (const reference of evidence.evidenceRefs) {
    if (
      reference.stage !== "ownership" ||
      reference.role !== "support" ||
      !retained.has(reference.evidenceId)
    ) {
      continue;
    }
    if (
      isCurrentAffirmativeIndependence(
        reference.quote,
        evidence.sourceContext.rawName,
      )
    ) {
      observations.push({ status: "independent", owner: null });
      continue;
    }
    const vote = classifyOfficialSiteOwnership(
      reference.quote,
      evidence.sourceContext.rawName,
    );
    if (vote !== null) {
      observations.push({ status: vote.status, owner: vote.owner });
    }
  }
  if (observations.length === 0) return null;
  const first = observations[0]!;
  const conflicting = observations.some(
    (observation) =>
      observation.status !== first.status ||
      normalizedOwnershipOwner(observation.owner) !==
        normalizedOwnershipOwner(first.owner),
  );
  return conflicting
    ? {
        status: "unknown",
        owner: null,
        year: null,
        conflicting: true,
        currentness: "unknown",
        supportEvidenceIds,
      }
    : {
        status: first.status,
        owner: first.owner,
        year: null,
        conflicting: false,
        currentness:
          first.status === "independent"
            ? "explicit_current_independence"
            : "explicit_current_relation",
        supportEvidenceIds,
      };
}

function admittedPrimaryRecordsConflict(
  records: readonly AnalystPrimaryRecord[],
): boolean {
  for (let index = 0; index < records.length; index += 1) {
    for (let other = index + 1; other < records.length; other += 1) {
      const left = records[index]!;
      const right = records[other]!;
      if (!exactLegalName(left.legalName, right.legalName)) return true;
      if (
        conflictingOptionalIdentity(left.uei, right.uei) ||
        conflictingOptionalIdentity(left.cage, right.cage) ||
        conflictingOptionalIdentity(left.country, right.country)
      ) {
        return true;
      }
      if (
        left.city !== null &&
        left.state !== null &&
        right.city !== null &&
        right.state !== null &&
        (HEADQUARTERS_VALUE_COLLATOR.compare(left.city, right.city) !== 0 ||
          normalizeState(left.state) !== normalizeState(right.state))
      ) {
        return true;
      }
    }
  }
  return false;
}

function conflictingOptionalIdentity(
  left: string | null,
  right: string | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.trim().toLocaleUpperCase("en-US") !==
      right.trim().toLocaleUpperCase("en-US")
  );
}

function primaryRecordMatchesSignal(
  signal: SignalEvidenceSourceSignal,
  record: AnalystPrimaryRecord,
): boolean {
  if (
    !exactLegalName(signal.rawName, record.legalName) ||
    !primaryRecordCompatibleWithSignal(signal, record)
  ) {
    return false;
  }
  if (
    exactIdentifier(signal.uei, record.uei) ||
    exactIdentifier(signal.cage, record.cage)
  ) {
    return true;
  }
  return exactPrimaryLocation(signal, record);
}

function primaryRecordCompatibleWithSignal(
  signal: Pick<
    SignalEvidenceSourceSignal,
    "uei" | "cage" | "city" | "state"
  >,
  record: Pick<
    SignalEvidenceSourceSignal,
    "uei" | "cage" | "city" | "state"
  >,
): boolean {
  return (
    !conflictingOptionalIdentity(signal.uei, record.uei) &&
    !conflictingOptionalIdentity(signal.cage, record.cage) &&
    !conflictingPrimaryLocation(signal, record)
  );
}

function exactPrimaryLocation(
  signal: Pick<SignalEvidenceSourceSignal, "city" | "state">,
  record: Pick<SignalEvidenceSourceSignal, "city" | "state">,
): boolean {
  return (
    signal.city !== null &&
    signal.state !== null &&
    record.city !== null &&
    record.state !== null &&
    HEADQUARTERS_VALUE_COLLATOR.compare(signal.city, record.city) === 0 &&
    normalizeState(signal.state) === normalizeState(record.state)
  );
}

function conflictingPrimaryLocation(
  signal: Pick<SignalEvidenceSourceSignal, "city" | "state">,
  record: Pick<SignalEvidenceSourceSignal, "city" | "state">,
): boolean {
  const cityConflicts =
    signal.city !== null &&
    record.city !== null &&
    HEADQUARTERS_VALUE_COLLATOR.compare(signal.city, record.city) !== 0;
  const stateConflicts =
    signal.state !== null &&
    record.state !== null &&
    normalizeState(signal.state) !== normalizeState(record.state);
  return cityConflicts || stateConflicts;
}

function exactLegalName(left: string, right: string): boolean {
  const leftIdentity = parsedLegalIdentity(left);
  const rightIdentity = parsedLegalIdentity(right);
  if (leftIdentity === null || rightIdentity === null) return false;
  if (
    leftIdentity.rootTokens.join("\u0000") !==
    rightIdentity.rootTokens.join("\u0000")
  ) {
    return false;
  }
  return (
    leftIdentity.suffix === null ||
    rightIdentity.suffix === null ||
    leftIdentity.suffix === rightIdentity.suffix
  );
}

function exactIdentifier(
  left: string | null,
  right: string | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.trim().toLocaleUpperCase("en-US") ===
      right.trim().toLocaleUpperCase("en-US")
  );
}

function primaryIdentityDocument(
  record: AnalystPrimaryRecord,
  signal: Pick<
    SignalEvidenceSourceSignal,
    "rawName" | "uei" | "cage" | "city" | "state"
  >,
): PendingEvidenceDocument | null {
  const prefix =
    `${primaryIssuer(record.sourceKey)} primary record; ` +
    `legal name: ${record.legalName}`;
  const corroboration = [
    record.uei !== null &&
    (signal.uei === null || exactIdentifier(signal.uei, record.uei))
      ? `UEI: ${record.uei}`
      : null,
    record.cage !== null &&
    (signal.cage === null || exactIdentifier(signal.cage, record.cage))
      ? `CAGE: ${record.cage}`
      : null,
    record.city !== null &&
    record.state !== null &&
    (signal.city === null ||
      HEADQUARTERS_VALUE_COLLATOR.compare(signal.city, record.city) === 0) &&
    (signal.state === null ||
      normalizeState(signal.state) === normalizeState(record.state))
      ? `location: ${record.city}, ${record.state}`
      : null,
  ].filter((value): value is string => value !== null);
  if (corroboration.length === 0) return null;
  const quote = `${prefix}; ${corroboration.join("; ")}`;
  if (quote.length > EVIDENCE_QUOTE_MAX_CHARS) return null;
  return {
    stage: "domain",
    url: record.sourceLocator,
    title: `${primaryIssuer(record.sourceKey)} identity record: ${signal.rawName}`,
    quote,
    contentSha256: sha256Hex(record.payloadJson),
    retrievedAt: record.observedAt,
    sourceKind: "registry",
    firstParty: false,
    metadata: {
      identityOutcome: "verified",
      primarySourceKey: record.sourceKey,
      primarySourceFingerprint: record.sourceFingerprint,
      primarySourceLocator: record.sourceLocator,
      recordAccess: record.recordAccess,
      issuer: record.issuer,
      observationAccessedAt: record.observedAt,
      payloadTruncated: record.payloadTruncated,
      awardsAreNotRevenue: true,
    },
  };
}

function primaryIssuer(sourceKey: AnalystPrimaryRecord["sourceKey"]): string {
  switch (sourceKey) {
    case "faa_pma_database":
    case "faa_drs_pma":
    case "faa_drs_pma_search":
      return "Federal Aviation Administration";
    case "sam_entity":
      return "U.S. General Services Administration SAM.gov";
    case "usaspending":
      return "USAspending.gov";
  }
}

function checkedSourcesFromObservations(
  observations: readonly AnalystResourceObservation[],
): CheckedSourceReference[] {
  const checked: CheckedSourceReference[] = [];
  for (const observation of observations) {
    if (observation.tool === "exa_search") continue;
    for (const reference of observation.sourceReferences) {
      const support =
        observation.supportRole === "candidate_evidence" &&
        observation.failure === null &&
        observation.accessLimit === null;
      checked.push({
        url: reference.finalUrl ?? reference.locator,
        outcome: support
          ? "retrieved"
          : observation.failure === null
            ? "no_content"
            : "unreachable",
        contentSha256: support ? reference.contentSha256 : null,
        retrievedAt: support ? reference.retrievedAt : null,
      });
    }
  }
  return checked;
}

interface ExternalOwnershipFacts {
  readonly status: AcquisitionStatus | "independent" | "unknown";
  readonly owner: string | null;
  readonly conflicting: boolean;
  readonly observations: WebsiteFacts["ownershipObservations"];
  readonly documents: readonly PendingEvidenceDocument[];
}

function extractExternalOwnershipFacts(
  pages: readonly AdmittedPage[],
  companyName: string,
): ExternalOwnershipFacts {
  const observations: Array<{
    readonly status: AcquisitionStatus | "independent";
    readonly owner: string | null;
  }> = [];
  const documents: PendingEvidenceDocument[] = [];
  for (const page of pages) {
    for (const statement of splitScopedEvidenceStatements(page.text)) {
      if (statement.quoted) continue;
      const vote = classifySentence(statement.text, companyName);
      if (vote === null || !vote.currentRelation) continue;
      observations.push({ status: vote.status, owner: vote.owner });
      const quote = statement.text.replace(/\s+/gu, " ").trim();
      if (quote.length === 0 || quote.length > EVIDENCE_QUOTE_MAX_CHARS) {
        continue;
      }
      documents.push({
        stage: "ownership",
        url: page.url,
        title: page.title || `External ownership source: ${companyName}`,
        quote,
        contentSha256: page.contentSha256,
        retrievedAt: page.retrievedAt,
        sourceKind: "publisher_site",
        firstParty: false,
        metadata: {
          ownershipStatus: vote.status,
          owner: vote.owner,
          currentRelation: true,
          representation: page.representation,
        },
      });
    }
  }
  const conflicting =
    observations.length > 1 &&
    observations.some(
      (observation) =>
        observation.status !== observations[0]?.status ||
        normalizedOwnershipOwner(observation.owner) !==
          normalizedOwnershipOwner(observations[0]?.owner ?? null),
    );
  const supported = documents[0];
  return {
    status:
      conflicting || supported === undefined
        ? "unknown"
        : (supported.metadata["ownershipStatus"] as
            | AcquisitionStatus
            | "independent"),
    owner:
      conflicting || supported === undefined
        ? null
        : typeof supported.metadata["owner"] === "string"
          ? supported.metadata["owner"]
          : null,
    conflicting,
    observations,
    documents,
  };
}

function mergeExternalOwnershipFacts(
  facts: WebsiteFacts,
  external: ExternalOwnershipFacts,
): WebsiteFacts {
  const ownershipObservations = [
    ...facts.ownershipObservations,
    ...external.observations,
  ];
  const observationsConflict =
    ownershipObservations.length > 1 &&
    ownershipObservations.some(
      (observation) =>
        observation.status !== ownershipObservations[0]?.status ||
        normalizedOwnershipOwner(observation.owner) !==
          normalizedOwnershipOwner(ownershipObservations[0]?.owner ?? null),
    );
  const conflicting =
    facts.ownershipConflicting ||
    external.conflicting ||
    observationsConflict;
  const status =
    facts.ownershipStatus !== "unknown"
      ? facts.ownershipStatus
      : external.status;
  const owner =
    facts.ownershipStatus !== "unknown" ? facts.owner : external.owner;
  return {
    ...facts,
    ownershipStatus: conflicting ? "unknown" : status,
    owner: conflicting ? null : owner,
    ownershipConflicting: conflicting,
    ownershipObservations,
    ownershipDocuments: [
      ...facts.ownershipDocuments,
      ...external.documents,
    ],
  };
}

function revalidateRetainedOwnership(
  evidence: SourcedSignalResearchEvidence,
  companyName: string,
): SourcedSignalResearchEvidence["ownership"] {
  const current = evidence.ownership;
  if (current.status === "unknown" || current.conflicting) {
    return {
      ...current,
      status: "unknown",
      owner: null,
      year: null,
      conflicting: current.conflicting === true,
      currentness: "unknown",
    };
  }
  const supportIds = new Set(current.supportEvidenceIds);
  const valid = evidence.evidenceRefs.some((reference) => {
    if (
      reference.role !== "support" ||
      reference.stage !== "ownership" ||
      !supportIds.has(reference.evidenceId)
    ) {
      return false;
    }
    if (current.status === "independent") {
      return isCurrentAffirmativeIndependence(reference.quote, companyName);
    }
    const vote = classifyOfficialSiteOwnership(reference.quote, companyName);
    if (vote === null || vote.status !== current.status) return false;
    if (current.status === "dead") return true;
    return (
      normalizedOwnershipOwner(vote.owner) ===
      normalizedOwnershipOwner(current.owner)
    );
  });
  if (!valid) {
    return {
      status: "unknown",
      owner: null,
      year: null,
      conflicting: false,
      currentness: "unknown",
      supportEvidenceIds: current.supportEvidenceIds,
    };
  }
  return {
    ...current,
    conflicting: false,
    currentness:
      current.status === "independent"
        ? "explicit_current_independence"
        : "explicit_current_relation",
  };
}

function normalizedOwnershipOwner(owner: string | null): string | null {
  return owner === null
    ? null
    : owner.replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}

function mergeOwnership(
  current: SourcedSignalResearchEvidence["ownership"],
  facts: WebsiteFacts,
  persisted: readonly PersistedDocument[],
  conflicts: string[],
): SourcedSignalResearchEvidence["ownership"] {
  const ids = persisted
    .filter((document) => document.stage === "ownership")
    .map((document) => document.evidenceId);
  const contradictsCurrent =
    current.status !== "unknown" &&
    facts.ownershipObservations.some(
      (observation) =>
        observation.status !== current.status ||
        normalizedOwnershipOwner(observation.owner) !==
          normalizedOwnershipOwner(current.owner),
    );
  if (current.conflicting || facts.ownershipConflicting || contradictsCurrent) {
    conflicts.push("ownership");
    return {
      status: "unknown",
      owner: null,
      year: null,
      conflicting: true,
      currentness: "unknown",
      supportEvidenceIds: uniqueStrings([...current.supportEvidenceIds, ...ids]),
    };
  }
  if (facts.ownershipStatus === "unknown") {
    return {
      ...current,
      conflicting: false,
      supportEvidenceIds: uniqueStrings([...current.supportEvidenceIds, ...ids]),
    };
  }
  return {
    status: facts.ownershipStatus,
    owner: facts.owner,
    year: current.year,
    conflicting: false,
    currentness:
      facts.ownershipStatus === "independent"
        ? "explicit_current_independence"
        : "explicit_current_relation",
    supportEvidenceIds: uniqueStrings([...current.supportEvidenceIds, ...ids]),
  };
}

function mergeSize(
  current: SourcedSignalResearchEvidence["size"],
  facts: WebsiteFacts,
  persisted: readonly PersistedDocument[],
  conflicts: string[],
): SourcedSignalResearchEvidence["size"] {
  const additions = persisted
    .filter((document) => document.stage === "size")
    .flatMap((document) => {
      const indicator = sizeIndicatorFromDocument(document);
      return indicator === null ? [] : [indicator];
    });
  const contradictsCurrent =
    current.assessment !== "unknown" &&
    facts.sizeObservations.some(
      (assessment) => assessment !== current.assessment,
    );
  if (current.conflicting || facts.sizeConflicting || contradictsCurrent) {
    conflicts.push("revenue");
    return {
      status: additions.length > 0 ? "supported" : current.status,
      assessment: "unknown",
      conflicting: true,
      indicators: [...current.indicators, ...additions],
    };
  }
  if (facts.sizeAssessment === "unknown") {
    return {
      ...current,
      conflicting: false,
      indicators: [...current.indicators, ...additions],
    };
  }
  return {
    status: additions.length > 0 ? "supported" : current.status,
    assessment: facts.sizeAssessment,
    conflicting: false,
    indicators: [...current.indicators, ...additions],
  };
}

function mergeHeadquarters(
  current: SourcedSignalResearchEvidence["headquarters"],
  facts: WebsiteFacts,
  persisted: readonly PersistedDocument[],
  conflicts: string[],
): SourcedSignalResearchEvidence["headquarters"] {
  const ids = persisted
    .filter((document) => document.stage === "hq")
    .map((document) => document.evidenceId);
  if (current.status === "conflicting") {
    conflicts.push("headquarters");
    return {
      ...current,
      supportEvidenceIds: uniqueStrings([...current.supportEvidenceIds, ...ids]),
    };
  }
  const combinedObserved =
    current.status === "supported"
      ? reconcileHeadquartersFacts([
          {
            city: current.city,
            state: current.state,
            country: current.country,
          },
          ...facts.headquartersObservations,
        ])
      : reconcileHeadquartersFacts(facts.headquartersObservations);
  if (
    facts.headquartersStatus === "conflicting" ||
    combinedObserved.status === "conflicting"
  ) {
    conflicts.push("headquarters");
    return {
      status: "conflicting",
      city: null,
      state: null,
      country: null,
      supportEvidenceIds: uniqueStrings([...current.supportEvidenceIds, ...ids]),
    };
  }
  if (facts.headquartersStatus === "unknown") {
    return {
      ...current,
      supportEvidenceIds: uniqueStrings([...current.supportEvidenceIds, ...ids]),
    };
  }
  const candidate =
    current.status === "supported"
      ? combinedObserved.headquarters
      : facts.headquarters;
  if (candidate === null) {
    return {
      ...current,
      supportEvidenceIds: uniqueStrings([...current.supportEvidenceIds, ...ids]),
    };
  }
  return {
    status: "supported",
    city: candidate.city,
    state: candidate.state,
    country: candidate.country,
    supportEvidenceIds: uniqueStrings([...current.supportEvidenceIds, ...ids]),
  };
}

function dedupeEvidenceReferences(
  references: readonly SourcedEvidenceReference[],
): SourcedEvidenceReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = `${reference.evidenceId}\u0000${reference.stage}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeCheckedSources(
  references: readonly CheckedSourceReference[],
): CheckedSourceReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = `${reference.url}\u0000${reference.outcome}\u0000${reference.contentSha256 ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeAdmittedPages(pages: readonly AdmittedPage[]): AdmittedPage[] {
  const seen = new Set<string>();
  return pages.filter((page) => {
    const key = `${page.url}\u0000${page.contentSha256}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function runSignalEvidenceResearch(
  options: RunSignalEvidenceResearchOptions = {},
): Promise<SignalEvidenceResearchSummary> {
  const db = options.db ?? getDatabase();
  const apiKey = options.apiKey ?? process.env["EXA_API_KEY"] ?? "";
  const limit = Math.max(
    0,
    Math.min(
      options.limit ?? SIGNAL_EVIDENCE_TICK_CAP,
      SIGNAL_EVIDENCE_TICK_CAP,
    ),
  );
  if (limit === 0) return emptySummary("limit_zero");

  await bootstrapSignalReviewStates(db, { limit: limit * 3 });
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, limit));
  const leaseSeconds = options.leaseSeconds ?? 600;
  const outcomes: ProcessedClaimOutcome[] = [];
  while (outcomes.length < limit) {
    const waveLimit = Math.min(concurrency, limit - outcomes.length);
    const claims = await claimSignalReviews(db, {
      phase: "research",
      limit: waveLimit,
      leaseSeconds,
    });
    if (claims.length === 0) break;
    outcomes.push(
      ...(await mapWithConcurrency(claims, concurrency, async (claim) =>
        processClaim(db, claim, apiKey, options),
      )),
    );
  }
  if (outcomes.length === 0) return emptySummary("no_candidates");
  return outcomes.reduce<SignalEvidenceResearchSummary>(
    (summary, outcome) => ({
      claimed: summary.claimed + 1,
      completed: summary.completed + (outcome.kind === "completed" ? 1 : 0),
      retryableFailures:
        summary.retryableFailures +
        (outcome.kind === "retryable_error" ? 1 : 0),
      deferred: summary.deferred + (outcome.kind === "deferred" ? 1 : 0),
      ambiguous:
        summary.ambiguous + (outcome.identityStatus === "ambiguous" ? 1 : 0),
      noFinding:
        summary.noFinding + (outcome.identityStatus === "not_found" ? 1 : 0),
      costUsd: summary.costUsd + outcome.costUsd,
      skipped: null,
    }),
    emptySummary(null),
  );
}

function signalExaAccounting(
  options: ResearchSignalEvidenceOptions,
  now: Date | undefined,
): ExaAccountingContext {
  return {
    db: options.db,
    budgetScopeId: options.exaBudgetScopeId ?? exaBudgetScopeId(),
    sourceSignalId: options.signal.id,
    ...(now === undefined ? {} : { now }),
  };
}

async function researchOfficialSite(
  options: ResearchSignalEvidenceOptions,
): Promise<DomainResearchResult> {
  const candidates: OfficialDomainCandidate[] = [];
  const rawDomain = normalizeCandidateDomain(options.signal.rawDomain ?? "");
  if (rawDomain !== null && !isSuppressedDirectoryDomain(rawDomain)) {
    candidates.push({
      url:
        options.signal.rawDomain?.startsWith("http://") === true ||
        options.signal.rawDomain?.startsWith("https://") === true
          ? options.signal.rawDomain
          : `https://${rawDomain}/`,
      domain: rawDomain,
      title: `Source-supplied domain for ${options.signal.rawName}`,
      textSnippet: "",
      score: 1,
    });
  }

  let costUsd = 0;
  let discoveryFailure: ResearchSignalEvidenceResult | null = null;
  if (
    options.apiKey.trim().length > 0 ||
    options.searchClient !== undefined
  ) {
    const client =
      options.searchClient ?? new ExaSearchClient({ apiKey: options.apiKey });
    try {
      let discovered: readonly OfficialDomainCandidate[];
      const query = buildOfficialDomainQuery({
        legalName: options.signal.rawName,
        ...(options.signal.city === null ? {} : { city: options.signal.city }),
        ...(options.signal.state === null
          ? {}
          : { state: options.signal.state }),
        ...(options.signal.uei === null ? {} : { uei: options.signal.uei }),
        ...(options.signal.cage === null ? {} : { cage: options.signal.cage }),
      });
      const accounted = await executeAccountedExaSearch(
        signalExaAccounting(options, options.now),
        client,
        query,
      );
      if (accounted.outcome === "deferred") {
        const failure = operationalFailure(
          "budget_limited",
          accounted.reason === "provider_cooldown"
            ? "domain_provider_cooldown"
            : "domain_budget_limited",
          null,
          costUsd,
        );
        if (candidates.length === 0) return failedDomainResult(failure);
        discoveryFailure = failure;
        discovered = [];
      } else if (accounted.outcome === "ambiguous") {
        const failure = operationalFailure(
          "retryable_error",
          "domain_reservation_ambiguous",
          null,
          costUsd,
        );
        if (candidates.length === 0) return failedDomainResult(failure);
        discoveryFailure = failure;
        discovered = [];
      } else {
        discovered = accounted.results
          .map(normalizeExaOfficialCandidate)
          .filter(
            (candidate): candidate is OfficialDomainCandidate =>
              candidate !== null,
          );
        costUsd +=
          accounted.providerCostUsd === null
            ? 0
            : Number.parseFloat(accounted.providerCostUsd);
      }
      for (const candidate of discovered) {
        if (
          !candidates.some((existing) => existing.domain === candidate.domain)
        ) {
          candidates.push(candidate);
        }
      }
    } catch (error) {
      const kind =
        error instanceof ExaApiKeyMissingError
          ? "configuration_error"
          : error instanceof ExaSearchError && !error.transient
            ? "provider_error"
            : "retryable_error";
      const failure = operationalFailure(
        kind,
        `domain_${kind}`,
        error instanceof ExaSearchError ? error.code : null,
        costUsd,
      );
      if (candidates.length === 0) return failedDomainResult(failure);
      discoveryFailure = failure;
    }
  } else {
    const failure = operationalFailure(
      "configuration_error",
      "missing_exa_api_key",
      null,
      costUsd,
    );
    if (candidates.length === 0) return failedDomainResult(failure);
    discoveryFailure = failure;
  }

  const checkedSources: CheckedSourceReference[] = [];
  const documents: PendingEvidenceDocument[] = [];
  let sawIdentityMismatch = false;
  let transientError: SafeFetchErrorCode | null = null;
  const fetchUrl = options.fetchUrl ?? safeFetchUrl;

  for (const candidate of candidates.slice(0, MAX_DOMAIN_CANDIDATES)) {
    const origin = domainOrigin(candidate.url, candidate.domain);
    if (origin === null) continue;
    const pages: SafeFetchResult[] = [];
    const probeUrls = identityProbeUrls(candidate.url, origin);
    const queuedUrls = new Set(probeUrls);
    let nextProbeIndex = 0;
    let requestsAttempted = 0;
    while (
      nextProbeIndex < probeUrls.length &&
      requestsAttempted < IDENTITY_PAGE_REQUEST_CAP
    ) {
      const requestedUrl = probeUrls[nextProbeIndex];
      nextProbeIndex += 1;
      if (requestedUrl === undefined) break;
      requestsAttempted += 1;
      try {
        const fetched = await fetchUrl(requestedUrl);
        const finalDomain = normalizeCandidateDomain(fetched.finalUrl);
        if (
          finalDomain === null ||
          isSuppressedDirectoryDomain(finalDomain) ||
          (finalDomain !== candidate.domain &&
            !finalDomain.endsWith(`.${candidate.domain}`))
        ) {
          checkedSources.push({
            url: fetched.finalUrl,
            outcome: "identity_mismatch",
            contentSha256: fetched.contentSha256,
            retrievedAt: fetched.retrievedAt,
          });
          sawIdentityMismatch = true;
          continue;
        }
        pages.push(fetched);
        const discoveredUrls = extractIdentityPageLinks(
          fetched.content,
          fetched.finalUrl,
        ).filter((url) => {
          if (queuedUrls.has(url)) return false;
          queuedUrls.add(url);
          return true;
        });
        probeUrls.splice(nextProbeIndex, 0, ...discoveredUrls);
        const rawAssessment = assessSignalSiteIdentity(
          options.signal,
          pages.map((page) => page.content),
          pages.map((page) => page.finalUrl),
        );
        if (
          buildSignalIdentityProofQuotes(pages, options.signal, rawAssessment)
            .length > 0
        ) {
          break;
        }
      } catch (error) {
        const code =
          error instanceof SafeFetchError ? error.code : "network_error";
        if (isRetryableSafeFetchError(error)) {
          transientError ??= code;
        }
        checkedSources.push({
          url: requestedUrl,
          outcome: "unreachable",
          contentSha256: null,
          retrievedAt: null,
        });
      }
    }
    if (pages.length === 0) continue;
    const assessment = assessSignalSiteIdentity(
      options.signal,
      pages.map((page) => page.content),
      pages.map((page) => page.finalUrl),
    );
    const proofQuotes = buildSignalIdentityProofQuotes(
      pages,
      options.signal,
      assessment,
    );
    const durableVerified = proofQuotes.length > 0;
    const pageOutcome = durableVerified ? "retrieved" : "identity_mismatch";
    for (const page of pages) {
      checkedSources.push({
        url: page.finalUrl,
        outcome: pageOutcome,
        contentSha256: page.contentSha256,
        retrievedAt: page.retrievedAt,
      });
    }
    for (const proof of proofQuotes) {
      const page = pages[proof.pageIndex];
      if (page === undefined) continue;
      documents.push({
        stage: "domain",
        url: page.finalUrl,
        title: `Official-site identity: ${options.signal.rawName}`,
        quote: proof.quote,
        contentSha256: page.contentSha256,
        retrievedAt: page.retrievedAt,
        sourceKind: "official_site",
        firstParty: true,
        metadata: {
          identityOutcome: "verified",
          overlapRatio: assessment.overlapRatio,
          corroboratedBy: assessment.corroboratedBy,
        },
      });
    }
    if (durableVerified) {
      // Candidate redirects are constrained above to the candidate host or one
      // of its subdomains. Preserve the candidate's canonical domain rather
      // than promoting a serving subdomain (for example, web.example.com).
      const domain = candidate.domain;
      if (domain !== null) {
        return {
          status: "verified",
          site: { domain, pages, assessment },
          checkedSources,
          documents,
          costUsd,
          failure: null,
        };
      }
    }
    sawIdentityMismatch = true;
  }

  if (transientError !== null) {
    return {
      status: "not_found",
      site: null,
      checkedSources,
      documents,
      costUsd,
      failure: operationalFailure(
        "retryable_error",
        "official_site_unreachable",
        transientError,
        costUsd,
      ),
    };
  }
  if (discoveryFailure !== null) {
    return {
      status: sawIdentityMismatch ? "ambiguous" : "not_found",
      site: null,
      checkedSources,
      documents,
      costUsd,
      failure: discoveryFailure,
    };
  }
  return {
    status: sawIdentityMismatch ? "ambiguous" : "not_found",
    site: null,
    checkedSources,
    documents,
    costUsd,
    failure: null,
  };
}

export function extractWebsiteFacts(
  website: WebsiteFactSource | null,
  companyName: string,
): WebsiteFacts {
  if (website === null || website.outcome !== "success") {
    return {
      ownershipStatus: "unknown",
      owner: null,
      ownershipConflicting: false,
      ownershipObservations: [],
      ownershipDocuments: [],
      sizeDocuments: [],
      sizeAssessment: "unknown",
      sizeConflicting: false,
      sizeObservations: [],
      headquartersDocuments: [],
      headquartersStatus: "unknown",
      headquarters: null,
      headquartersObservations: [],
    };
  }
  const ownershipDocuments: PendingEvidenceDocument[] = [];
  const sizeDocuments: PendingEvidenceDocument[] = [];
  const headquartersDocuments: PendingEvidenceDocument[] = [];
  let ownershipStatus: AcquisitionStatus | "independent" | "unknown" =
    "unknown";
  let owner: string | null = null;
  const unsupportedOwnershipVotes: Array<{
    readonly status: AcquisitionStatus | "independent";
    readonly owner: string | null;
  }> = [];
  const supportedOwnershipVotes: Array<{
    readonly status: AcquisitionStatus | "independent";
    readonly owner: string | null;
  }> = [];
  const revenueAssessments: SizeAssessment[] = [];
  const supportedRevenueAssessments: SizeAssessment[] = [];
  const headquartersFacts: HeadquartersFact[] = [];
  const supportedHeadquartersFacts: HeadquartersFact[] = [];
  for (const page of website.pages) {
    const publisherIdentity = pagePublisherIdentity(page, companyName);
    const statements = splitPageStatements(page.text);
    for (const [index, statement] of statements.entries()) {
      const sentence = statement.text;
      if (
        statement.quoted ||
        hasInheritedThirdPartySpeaker(sentence, statements[index - 1])
      ) {
        continue;
      }
      const targetStatement = targetAttributedStatement(
        sentence,
        companyName,
        publisherIdentity,
      );
      if (targetStatement === null) continue;
      const canonicalStatement = canonicalizePublisherSubject(
        targetStatement,
        companyName,
        publisherIdentity,
      );
      if (isCurrentAffirmativeIndependence(canonicalStatement, companyName)) {
        const document = factDocument("ownership", page, sentence, {
          ownershipStatus: "independent",
          affirmativeIndependence: true,
        });
        if (document === null) {
          unsupportedOwnershipVotes.push({
            status: "independent",
            owner: null,
          });
        } else {
          if (ownershipStatus === "unknown") {
            ownershipStatus = "independent";
          }
          ownershipDocuments.push(document);
          supportedOwnershipVotes.push({
            status: "independent",
            owner: null,
          });
        }
      }
      const vote = classifyOfficialSiteOwnership(
        canonicalStatement,
        companyName,
      );
      if (vote !== null && vote.status !== "dead") {
        const document = factDocument("ownership", page, sentence, {
          ownershipStatus: vote.status,
          owner: vote.owner,
        });
        if (document === null) {
          unsupportedOwnershipVotes.push({
            status: vote.status,
            owner: vote.owner,
          });
        } else {
          ownershipStatus = vote.status;
          owner = vote.owner;
          ownershipDocuments.push(document);
          supportedOwnershipVotes.push({
            status: vote.status,
            owner: vote.owner,
          });
        }
      }
      const sizeKind = explicitSizeKind(canonicalStatement);
      const sizeCurrentness =
        sizeKind === null
          ? null
          : quantitativeStatementCurrentness(canonicalStatement, sizeKind);
      if (
        sizeKind !== null &&
        sizeCurrentness !== null &&
        hasTargetSizeBinding(canonicalStatement, companyName, sizeKind)
      ) {
        const document = factDocument("size", page, sentence, {
          sizeKind,
          periodYear: sizeCurrentness.periodYear,
          currentness: sizeCurrentness.currentness,
        });
        const assessment = classifyExplicitRevenueSize(canonicalStatement);
        if (assessment !== "unknown") revenueAssessments.push(assessment);
        if (document !== null) {
          sizeDocuments.push(document);
          if (assessment !== "unknown") {
            supportedRevenueAssessments.push(assessment);
          }
        }
      }
      if (
        isCurrentHeadquartersStatement(canonicalStatement) &&
        hasTargetHeadquartersBinding(canonicalStatement, companyName)
      ) {
        const extracted = extractHeadquarters(canonicalStatement);
        const document =
          extracted === null
            ? null
            : factDocument("hq", page, sentence, {
                explicitHeadquarters: true,
              });
        if (extracted !== null) {
          headquartersFacts.push(extracted);
          if (document !== null) {
            supportedHeadquartersFacts.push(extracted);
            headquartersDocuments.push(document);
          }
        }
      }
    }
  }
  const observedHeadquarters = reconcileHeadquartersFacts(headquartersFacts);
  const supportedHeadquarters = reconcileHeadquartersFacts(
    supportedHeadquartersFacts,
  );
  const headquartersResolution =
    observedHeadquarters.status === "conflicting"
      ? observedHeadquarters
      : supportedHeadquarters;
  const ownershipObservations = [
    ...supportedOwnershipVotes,
    ...unsupportedOwnershipVotes,
  ];
  const ownershipConflict =
    (supportedOwnershipVotes.length > 1 &&
      supportedOwnershipVotes.some(
        (vote) =>
          vote.status !== supportedOwnershipVotes[0]?.status ||
          vote.owner !== supportedOwnershipVotes[0]?.owner,
      )) ||
    (ownershipStatus !== "unknown" &&
      unsupportedOwnershipVotes.some(
        (vote) =>
          vote.status !== ownershipStatus ||
          (vote.status !== "independent" && vote.owner !== owner),
      ));
  if (ownershipConflict) {
    ownershipStatus = "unknown";
    owner = null;
  }
  const assessments = new Set(revenueAssessments);
  const soleAssessment =
    assessments.size === 1 ? (revenueAssessments[0] ?? "unknown") : "unknown";
  return {
    ownershipStatus,
    owner,
    ownershipConflicting: ownershipConflict,
    ownershipObservations,
    ownershipDocuments,
    sizeDocuments,
    sizeAssessment:
      soleAssessment !== "unknown" &&
      supportedRevenueAssessments.includes(soleAssessment)
        ? soleAssessment
        : "unknown",
    sizeConflicting: assessments.size > 1,
    sizeObservations: revenueAssessments.filter(
      (assessment): assessment is Exclude<SizeAssessment, "unknown"> =>
        assessment !== "unknown",
    ),
    headquartersStatus: headquartersResolution.status,
    headquartersDocuments,
    headquarters: headquartersResolution.headquarters,
    headquartersObservations: headquartersFacts,
  };
}

function websitePageDocument(
  page: WebsiteFetchedPage,
  companyName: string,
): PendingEvidenceDocument {
  const perPage = classifyWebsiteEvidence([{ url: page.url, text: page.text }]);
  return {
    stage: "website",
    url: page.url,
    title: page.title || `Official site: ${companyName}`,
    quote: perPage.excerpts || page.excerpt,
    contentSha256: page.contentSha256,
    retrievedAt: page.retrievedAt,
    sourceKind: "official_site",
    firstParty: true,
    metadata: {
      websiteOffering: perPage.websiteOffering,
      productHints: perPage.productHints,
      ownershipHints: perPage.ownershipHints,
      sizeHints: perPage.sizeHints,
      ...pageRepresentationMetadata(page),
    },
  };
}

function websiteProductDocuments(
  page: WebsiteFetchedPage,
  companyName: string,
): PendingEvidenceDocument[] {
  return extractFirstPartyNamedProductQuotes(
    [page.title, page.text].filter((value) => value.trim() !== "").join("\n"),
    companyName,
  ).flatMap((quote) => {
    const document = factDocument("website", page, quote, {
      namedProductEvidence: true,
      extractedFromFullPageText: true,
    });
    return document === null ? [] : [document];
  });
}

function factDocument(
  stage: SourcedEvidenceStage,
  page: WebsiteFetchedPage,
  quote: string,
  metadata: Record<string, unknown>,
): PendingEvidenceDocument | null {
  if (quote.length === 0 || quote.length > EVIDENCE_QUOTE_MAX_CHARS)
    return null;
  return {
    stage,
    url: page.url,
    title: page.title || null,
    quote,
    contentSha256: page.contentSha256,
    retrievedAt: page.retrievedAt,
    sourceKind: "official_site",
    firstParty: true,
    metadata: { ...metadata, ...pageRepresentationMetadata(page) },
  };
}

function pageRepresentationMetadata(
  page: WebsiteFetchedPage,
): Record<string, unknown> {
  const representation =
    "representation" in page ? (page as AdmittedPage).representation : undefined;
  return representation === undefined ? {} : { representation };
}

async function persistEvidenceDocuments(
  db: SignalReviewExecutor,
  signalId: string,
  revision: string,
  documents: readonly PendingEvidenceDocument[],
): Promise<PersistedDocument[]> {
  const persisted: PersistedDocument[] = [];
  for (const document of documents) {
    const sourceId = await resolveResearchSourceId(db, document);
    const documentId = await resolveResearchDocumentId(db, sourceId, document);
    const evidenceHash = sha256Hex(
      [document.contentSha256, document.stage, document.quote].join("\u0000"),
    );
    const existing = await db.execute<{ id: string }>(sql`
      SELECT id
      FROM evidence
      WHERE source_document_id = ${documentId}
        AND extraction_method = 'signal_evidence_v1'
        AND content_sha256 = ${evidenceHash}
      LIMIT 1
    `);
    let evidenceId = existing.rows[0]?.id;
    if (evidenceId === undefined) {
      const inserted = await db.execute<{ id: string }>(sql`
        INSERT INTO evidence
          (source_document_id, extraction_status, quote, locator,
           extraction_method, content_sha256, metadata)
        VALUES (
          ${documentId},
          'completed'::evidence_extraction_status,
          ${document.quote},
          ${document.url},
          'signal_evidence_v1',
          ${evidenceHash},
          ${JSON.stringify({
            ...document.metadata,
            stage: document.stage,
            firstParty: document.firstParty,
            sourceKind: document.sourceKind,
            retrievedAt: document.retrievedAt,
          })}::jsonb
        )
        RETURNING id
      `);
      evidenceId = inserted.rows[0]?.id;
    }
    if (evidenceId === undefined) {
      throw new Error(`Evidence insert returned no id for ${document.url}`);
    }
    await linkSourceSignalEvidence(db, {
      signalId,
      evidenceId,
      stage: document.stage === "hq" ? "website" : document.stage,
      researchRevision: revision,
    });
    persisted.push({ ...document, evidenceId });
  }
  return persisted;
}

async function resolveResearchSourceId(
  db: SignalReviewExecutor,
  document: PendingEvidenceDocument,
): Promise<string> {
  const primaryKey = document.metadata["primarySourceKey"];
  const representation = document.metadata["representation"];
  const source =
    document.sourceKind === "registry" && typeof primaryKey === "string"
      ? primaryKey === "faa_pma_database" ||
        primaryKey === "faa_drs_pma" ||
        primaryKey === "faa_drs_pma_search"
        ? {
            name: "FAA Dynamic Regulatory System PMA",
            type: "government_registry",
            publisher: "Federal Aviation Administration",
          }
        : primaryKey === "sam_entity"
          ? {
              name: "SAM.gov Entity Management API v4",
              type: "government_registry",
              publisher: "U.S. General Services Administration",
            }
          : {
              name: "USAspending",
              type: "government_registry",
              publisher: "USAspending.gov",
            }
      : representation === "provider_extracted_text"
        ? {
            name: "Exa extracted content",
            type: document.sourceKind === "news" ? "news" : "website",
            publisher: "Exa",
          }
        : {
            name:
              document.sourceKind === "news"
                ? "Publisher news page"
                : "Publisher website",
            type: document.sourceKind === "news" ? "news" : "website",
            publisher: "Publisher at source URL",
          };
  const found = await db.execute<{ id: string }>(sql`
    SELECT id FROM data_sources WHERE lower(name) = lower(${source.name}) LIMIT 1
  `);
  const existing = found.rows[0]?.id;
  if (existing !== undefined) return existing;
  const inserted = await db.execute<{ id: string }>(sql`
    INSERT INTO data_sources (name, source_type, publisher, access, ingestion)
    VALUES (${source.name}, ${source.type}, ${source.publisher}, 'public', 'manual')
    ON CONFLICT DO NOTHING
    RETURNING id
  `);
  const created = inserted.rows[0]?.id;
  if (created !== undefined) return created;
  const raced = await db.execute<{ id: string }>(sql`
    SELECT id FROM data_sources WHERE lower(name) = lower(${source.name}) LIMIT 1
  `);
  const racedId = raced.rows[0]?.id;
  if (racedId === undefined) {
    throw new Error(`Unable to resolve ${source.name} data source`);
  }
  return racedId;
}

async function resolveResearchDocumentId(
  db: SignalReviewExecutor,
  sourceId: string,
  document: PendingEvidenceDocument,
): Promise<string> {
  const byHash = await db.execute<{ id: string }>(sql`
    SELECT id FROM source_documents
    WHERE content_sha256 = ${document.contentSha256}
    LIMIT 1
  `);
  const hashed = byHash.rows[0]?.id;
  if (hashed !== undefined) return hashed;
  const upserted = await db.execute<{ id: string }>(sql`
    INSERT INTO source_documents
      (data_source_id, canonical_url, title, document_type,
       retrieved_at, content_sha256, metadata)
    VALUES (
      ${sourceId},
      ${document.url},
      ${document.title},
      ${document.sourceKind === "news" ? "news" : "web_page"},
      ${document.retrievedAt},
      ${document.contentSha256},
      ${JSON.stringify({
        sourceKind: document.sourceKind,
        firstParty: document.firstParty,
      })}::jsonb
    )
    ON CONFLICT (content_sha256) DO NOTHING
    RETURNING id
  `);
  const documentId = upserted.rows[0]?.id;
  if (documentId !== undefined) return documentId;
  const raced = await db.execute<{ id: string }>(sql`
    SELECT id FROM source_documents
    WHERE content_sha256 = ${document.contentSha256}
    LIMIT 1
  `);
  const racedId = raced.rows[0]?.id;
  if (racedId === undefined) {
    throw new Error(`Unable to resolve source document for ${document.url}`);
  }
  return racedId;
}

async function loadSignal(
  db: Database,
  signalId: string,
): Promise<SignalEvidenceSourceSignal | null> {
  const result = await db.execute<{
    id: string;
    source_key: string;
    source_locator: string;
    source_fingerprint: string;
    raw_name: string;
    raw_domain: string | null;
    uei: string | null;
    cage: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
    award_count: number | null;
    source_payload: Record<string, unknown>;
    created_at: Date;
  }>(sql`
    SELECT id, source_key, source_locator, source_fingerprint, raw_name,
           raw_domain, uei, cage, city, state, country, award_count,
           source_payload, created_at
    FROM source_signals
    WHERE id = ${signalId}
    LIMIT 1
  `);
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    sourceKey: row.source_key,
    sourceLocator: row.source_locator,
    sourceFingerprint: row.source_fingerprint,
    rawName: row.raw_name,
    rawDomain: row.raw_domain,
    uei: row.uei,
    cage: row.cage,
    city: row.city,
    state: row.state,
    country: row.country,
    awardCount: row.award_count,
    sourcePayload: row.source_payload,
    createdAt: row.created_at,
  };
}

async function processClaim(
  db: Database,
  claim: SignalReviewClaim,
  apiKey: string,
  options: RunSignalEvidenceResearchOptions,
): Promise<ProcessedClaimOutcome> {
  let costUsd = 0;
  try {
    const signal = await loadSignal(db, claim.signalId);
    if (signal === null) {
      await failSignalReview(db, claim, "source_signal_not_found", {
        deferred: false,
        retryAfterMs: TRANSIENT_RETRY_MS,
      });
      return { kind: "retryable_error", identityStatus: null, costUsd };
    }
    const result = await researchSignalEvidence({
      db,
      signal,
      apiKey,
      exaBudgetScopeId: options.exaBudgetScopeId,
      now: options.now,
      searchClient: options.searchClient,
      fetchUrl: options.fetchUrl,
    });
    costUsd = result.costUsd;
    if (result.outcome !== "completed") {
      await failSignalReview(db, claim, result.reason, {
        deferred: result.outcome === "deferred",
        retryAfterMs: result.retryAfterMs,
      });
      return { kind: result.outcome, identityStatus: null, costUsd };
    }
    const completed = await completeSignalResearch(db, claim, {
      researchEvidence: JSON.parse(
        JSON.stringify(result.researchEvidence),
      ) as Record<string, unknown>,
      outcome: {
        status: "completed",
        identityStatus: result.researchEvidence.identity.status,
        missingFacts: result.researchEvidence.missingFacts,
      },
      researchDueAt: result.researchDueAt,
      expectedReviewInputContract: currentFaaReviewInputContract(),
    });
    if (completed === null) {
      return { kind: "retryable_error", identityStatus: null, costUsd };
    }
    return {
      kind: "completed",
      identityStatus: result.researchEvidence.identity.status,
      costUsd,
    };
  } catch (error) {
    await failSignalReview(db, claim, researchFailureMessage(error), {
      deferred: false,
      retryAfterMs: TRANSIENT_RETRY_MS,
    });
    return { kind: "retryable_error", identityStatus: null, costUsd };
  }
}

function researchFailureMessage(error: unknown): string {
  // Database wrappers include query parameters; retain the underlying failure,
  // not source quotes that can themselves be invalid PostgreSQL text.
  const cause =
    error instanceof Error && error.cause instanceof Error
      ? error.cause
      : error;
  return (cause instanceof Error ? cause.message : String(cause))
    .replaceAll("\u0000", "\\u0000")
    .slice(0, 2_000);
}

function operationalFailure(
  outcome:
    | "configuration_error"
    | "budget_limited"
    | "retryable_error"
    | "provider_error",
  reason: string,
  errorCode: ExaSearchErrorCode | SafeFetchErrorCode | null,
  costUsd: number,
): ResearchSignalEvidenceResult {
  const deferred =
    outcome === "configuration_error" || outcome === "budget_limited";
  return {
    outcome: deferred ? "deferred" : "retryable_error",
    reason,
    errorCode,
    retryAfterMs: deferred ? DEFERRED_RETRY_MS : TRANSIENT_RETRY_MS,
    costUsd,
  };
}

function failedDomainResult(
  failure: ResearchSignalEvidenceResult,
): DomainResearchResult {
  return {
    status: "not_found",
    site: null,
    checkedSources: [],
    documents: [],
    costUsd: failure.costUsd,
    failure,
  };
}

function toEvidenceReference(
  document: PersistedDocument,
): SourcedEvidenceReference {
  return {
    evidenceId: document.evidenceId,
    role:
      document.stage === "domain" &&
      document.metadata["identityOutcome"] !== "verified"
        ? "checked_only"
        : "support",
    stage: document.stage,
    url: document.url,
    title: document.title,
    quote: document.quote,
    contentSha256: document.contentSha256,
    retrievedAt: document.retrievedAt,
    sourceKind: document.sourceKind,
    firstParty: document.firstParty,
  };
}

function researchRevision(
  signal: SignalEvidenceSourceSignal,
  documents: readonly PendingEvidenceDocument[],
): string {
  return sha256Hex(
    JSON.stringify({
      version: SIGNAL_RESEARCH_VERSION,
      signalFingerprint: signal.sourceFingerprint,
      sources: documents
        .map((document) => ({
          stage: document.stage,
          url: document.url,
          contentSha256: document.contentSha256,
          quote: document.quote,
        }))
        .sort((left, right) =>
          `${left.stage}:${left.url}:${left.quote}`.localeCompare(
            `${right.stage}:${right.url}:${right.quote}`,
          ),
        ),
    }),
  );
}


interface ParsedLegalIdentity {
  readonly rootTokens: readonly string[];
  readonly suffix: string | null;
}

function normalizedIdentityTokens(value: string): string[] {
  return (
    value
      .normalize("NFKC")
      .toLocaleLowerCase("en-US")
      .match(/[a-z0-9]+/gu) ?? []
  );
}

function parsedLegalIdentity(value: string): ParsedLegalIdentity | null {
  const tokens = normalizedIdentityTokens(value);
  if (tokens.join("").length < 4) return null;
  let suffix: string | null = null;
  let suffixLength = 0;
  const lastToken = tokens.at(-1);
  if (lastToken !== undefined) {
    suffix = LEGAL_SUFFIX_CANONICAL[lastToken] ?? null;
    if (suffix !== null) suffixLength = 1;
  }
  const punctuatedSuffixes: readonly (readonly [readonly string[], string])[] =
    [
      [["p", "l", "l", "c"], "pllc"],
      [["l", "l", "c"], "llc"],
      [["l", "l", "p"], "llp"],
      [["l", "p"], "lp"],
      [["i", "n", "c"], "incorporated"],
      [["l", "t", "d"], "limited"],
      [["c", "o"], "company"],
    ];
  if (suffix === null) {
    for (const [candidate, canonical] of punctuatedSuffixes) {
      if (
        tokens.length > candidate.length &&
        candidate.every(
          (token, index) =>
            tokens[tokens.length - candidate.length + index] === token,
        )
      ) {
        suffix = canonical;
        suffixLength = candidate.length;
        break;
      }
    }
  }
  const rootTokens =
    suffixLength === 0 ? tokens : tokens.slice(0, -suffixLength);
  if (rootTokens.join("").length < 4) return null;
  return { rootTokens, suffix };
}

function legalNamePattern(companyName: string): string | null {
  const parsed = parsedLegalIdentity(companyName);
  if (parsed === null) return null;
  const rootPattern = parsed.rootTokens.map(escapeRegExp).join("[^a-z0-9]+");
  if (parsed.suffix === null) return rootPattern;
  const suffixPattern = LEGAL_SUFFIX_PATTERNS[parsed.suffix];
  return suffixPattern === undefined
    ? null
    : `${rootPattern}[^a-z0-9]+${suffixPattern}`;
}

function legalPublisherNamePatterns(companyName: string): readonly string[] {
  const parsed = parsedLegalIdentity(companyName);
  if (parsed === null) return [];
  const fullPattern = legalNamePattern(companyName);
  if (fullPattern === null) return [];
  if (parsed.rootTokens.length < 2) return [fullPattern];
  const rootPattern = parsed.rootTokens.map(escapeRegExp).join("[^a-z0-9]+");
  if (parsed.suffix === null) {
    return [`${rootPattern}[^a-z0-9]+${ANY_LEGAL_SUFFIX_PATTERN}`, rootPattern];
  }
  return [fullPattern, rootPattern];
}

function publisherIdentityEquivalent(
  sourceName: string,
  companyName: string,
): boolean {
  const source = parsedLegalIdentity(sourceName);
  const target = parsedLegalIdentity(companyName);
  if (source === null || target === null) return false;
  if (
    source.rootTokens.length !== target.rootTokens.length ||
    source.rootTokens.some((token, index) => token !== target.rootTokens[index])
  ) {
    return false;
  }
  if (source.suffix === target.suffix) return true;
  return (
    source.rootTokens.length >= 2 &&
    (source.suffix === null || target.suffix === null)
  );
}

function containsExactLegalName(text: string, companyName: string): boolean {
  const pattern = legalNamePattern(companyName);
  return (
    pattern !== null &&
    new RegExp(`(?:^|[^a-z0-9])${pattern}(?![a-z0-9])`, "iu").test(text)
  );
}

function copyrightPrefixIsAttributable(prefix: string): boolean {
  const tokens = normalizedIdentityTokens(prefix);
  return tokens.every(
    (token) =>
      /^(?:\d{2}|\d{4})$/u.test(token) ||
      /^(?:all|by|c|copyright|reserved|rights)$/u.test(token),
  );
}

function copyrightSuffixIsAttributable(suffix: string): boolean {
  const trimmed = suffix.trim();
  if (trimmed === "" || /^[|]/u.test(trimmed)) return true;
  const withoutPunctuation = trimmed.replace(/^[\s,.:;—–-]+/u, "");
  if (withoutPunctuation === "") return true;
  const withoutPublisherAcronym = withoutPunctuation
    .replace(/^\([A-Z0-9]{2,10}\)[\s,.:;—–-]*/u, "")
    .trim();
  if (withoutPublisherAcronym === "") return true;
  return /^(?:all\s+rights\s+reserved\b|bottom\s+of\s+page\b|privacy(?:\s+policy)?\b|site\s+by\b|sitemap\b|terms(?:\s+of\s+(?:service|use))?\b|web(?:site)?\s+(?:created|designed|developed|hosted|powered)\b)/iu.test(
    withoutPublisherAcronym,
  );
}

function copyrightPublisherExcerpt(
  text: string,
  companyName: string,
  maxChars = Number.POSITIVE_INFINITY,
): string | null {
  const publisherPatterns = legalPublisherNamePatterns(companyName);
  if (publisherPatterns.length === 0) return null;
  const marker =
    /(?:copyright\s*(?:©|\(c\))|(?:©|\(c\))\s*copyright|copyright|©|\(c\))/iu;
  const publisher = new RegExp(
    `(?:^|[^a-z0-9])(${publisherPatterns.join("|")})(?![a-z0-9])`,
    "iu",
  );
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    // Normalized publisher text may wrap "All rights reserved" onto the next
    // line. Try the literal line first, then one bounded continuation.
    const statements = [
      line,
      lines[index + 1] === undefined ? line : `${line}\n${lines[index + 1]}`,
    ];
    for (const candidate of statements) {
      const markerMatch = marker.exec(candidate);
      if (markerMatch === null) continue;
      const statement = candidate.slice(markerMatch.index);
      const afterMarker = statement.slice(markerMatch[0].length);
      const publisherMatch = publisher.exec(afterMarker);
      const identity = publisherMatch?.[1];
      if (
        publisherMatch === null ||
        identity === undefined ||
        publisherMatch.index === undefined
      ) {
        continue;
      }
      const identityStart =
        publisherMatch.index + publisherMatch[0].indexOf(identity);
      if (
        !copyrightPrefixIsAttributable(afterMarker.slice(0, identityStart)) ||
        !copyrightSuffixIsAttributable(
          afterMarker.slice(identityStart + identity.length),
        )
      ) {
        continue;
      }
      const excerpt = statement.trim();
      if (excerpt.length <= maxChars) return excerpt;
    }
  }
  return null;
}

function sameSiteStructuredUrl(
  value: unknown,
  pageUrl: string,
  rootDocument: boolean,
): boolean {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    const page = new URL(pageUrl);
    const structured = new URL(value, page);
    if (
      (structured.protocol !== "http:" && structured.protocol !== "https:") ||
      structured.username !== "" ||
      structured.password !== ""
    ) {
      return false;
    }
    const structuredHost = structured.hostname
      .toLocaleLowerCase("en-US")
      .replace(/^www\./u, "");
    const pageHost = page.hostname
      .toLocaleLowerCase("en-US")
      .replace(/^www\./u, "");
    return (
      structuredHost === pageHost &&
      (!rootDocument || structured.pathname.replace(/\/+$/u, "") === "")
    );
  } catch {
    return false;
  }
}

interface StructuredPublisherIdentifier {
  readonly label: "UEI" | "CAGE";
  readonly value: string;
  readonly normalized: Record<string, unknown>;
}

function structuredTypeIncludes(
  node: Record<string, unknown>,
  expected: string,
): boolean {
  const rawTypes = node["@type"];
  const types =
    typeof rawTypes === "string"
      ? [rawTypes]
      : Array.isArray(rawTypes)
        ? rawTypes.filter((entry): entry is string => typeof entry === "string")
        : [];
  return types.some((type) => type.toLocaleLowerCase("en-US") === expected);
}

function structuredPublisherIdentifiersFromNode(
  node: Record<string, unknown>,
): {
  readonly identifiers: readonly StructuredPublisherIdentifier[];
  readonly normalizedIdentifier: unknown;
} {
  if (
    !["organization", "corporation", "localbusiness"].some((type) =>
      structuredTypeIncludes(node, type),
    )
  ) {
    return { identifiers: [], normalizedIdentifier: undefined };
  }
  const rawIdentifier = node["identifier"];
  const values = Array.isArray(rawIdentifier)
    ? rawIdentifier
    : rawIdentifier === undefined
      ? []
      : [rawIdentifier];
  const identifiers: StructuredPublisherIdentifier[] = [];
  for (const value of values) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    const property = value as Record<string, unknown>;
    if (!structuredTypeIncludes(property, "propertyvalue")) continue;
    const rawLabel = property["propertyID"];
    const rawValue = property["value"];
    if (typeof rawLabel !== "string" || typeof rawValue !== "string") continue;
    const label = rawLabel.trim().toLocaleUpperCase("en-US");
    if (label !== "UEI" && label !== "CAGE") continue;
    const identifierValue = rawValue.trim();
    if (normalizedValidPublishedIdentifier(label, identifierValue) === null) {
      continue;
    }
    identifiers.push({
      label,
      value: identifierValue,
      normalized: {
        "@type": property["@type"],
        propertyID: rawLabel,
        value: rawValue,
      },
    });
  }
  return {
    identifiers,
    normalizedIdentifier:
      identifiers.length === 0
        ? undefined
        : Array.isArray(rawIdentifier)
          ? identifiers.map((identifier) => identifier.normalized)
          : identifiers[0]!.normalized,
  };
}

interface StructuredPublisherMatch {
  readonly name: string;
  readonly role: "Organization.root" | "WebSite.name" | "WebSite.publisher";
  readonly locator: string;
  readonly normalizedDocument: Record<string, unknown>;
  readonly identifiers: readonly StructuredPublisherIdentifier[];
}

function structuredNodeLocator(node: Record<string, unknown>): string | null {
  for (const key of ["@id", "url"] as const) {
    const value = node[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

function structuredNodeFields(
  node: Record<string, unknown>,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const key of ["@type", "@id", "url", "name"] as const) {
    if (node[key] !== undefined) fields[key] = node[key];
  }
  const { normalizedIdentifier } =
    structuredPublisherIdentifiersFromNode(node);
  if (normalizedIdentifier !== undefined) {
    fields["identifier"] = normalizedIdentifier;
  }
  return fields;
}

function sameSiteStructuredRootField(
  node: Record<string, unknown>,
  pageUrl: string,
): { readonly key: "@id" | "url"; readonly value: string } | null {
  for (const key of ["url", "@id"] as const) {
    const value = node[key];
    if (
      typeof value === "string" &&
      sameSiteStructuredUrl(value, pageUrl, true)
    ) {
      return { key, value };
    }
  }
  return null;
}

function structuredPublisherMatch(
  document: unknown,
  pageUrl: string,
  companyName: string,
): StructuredPublisherMatch | null {
  const roots = Array.isArray(document) ? document : [document];
  const nodes: Record<string, unknown>[] = [];
  for (const root of roots) {
    if (typeof root !== "object" || root === null || Array.isArray(root)) {
      continue;
    }
    const rootNode = root as Record<string, unknown>;
    nodes.push(rootNode);
    const graph = rootNode["@graph"];
    if (Array.isArray(graph)) {
      for (const graphEntry of graph) {
        if (
          typeof graphEntry === "object" &&
          graphEntry !== null &&
          !Array.isArray(graphEntry)
        ) {
          nodes.push(graphEntry as Record<string, unknown>);
        }
      }
    }
  }
  const nodesById = new Map<string, Record<string, unknown>>();
  for (const node of nodes) {
    if (typeof node["@id"] === "string") nodesById.set(node["@id"], node);
  }
  const matchingName = (node: Record<string, unknown>): string | null => {
    const name = node["name"];
    return typeof name === "string" &&
      publisherIdentityEquivalent(name, companyName)
      ? name
      : null;
  };
  const publisherMatch = (
    value: unknown,
  ): {
    readonly locator: string;
    readonly name: string;
    readonly normalizedPublisher: unknown;
    readonly identifiers: readonly StructuredPublisherIdentifier[];
  } | null => {
    if (typeof value === "string") {
      const referenced = nodesById.get(value);
      if (referenced !== undefined) {
        const name = matchingName(referenced);
        return name === null
          ? null
          : {
              name,
              locator: structuredNodeLocator(referenced) ?? value,
              normalizedPublisher: structuredNodeFields(referenced),
              identifiers:
                structuredPublisherIdentifiersFromNode(referenced).identifiers,
            };
      }
      return publisherIdentityEquivalent(value, companyName)
        ? {
            name: value,
            locator: "WebSite.publisher",
            normalizedPublisher: value,
            identifiers: [],
          }
        : null;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    const publisherNode = value as Record<string, unknown>;
    const id = publisherNode["@id"];
    const referenced = typeof id === "string" ? nodesById.get(id) : undefined;
    const matchedNode = referenced ?? publisherNode;
    const name = matchingName(matchedNode);
    return name === null
      ? null
      : {
          name,
          locator: structuredNodeLocator(matchedNode) ?? "WebSite.publisher",
          normalizedPublisher: structuredNodeFields(matchedNode),
          identifiers:
            structuredPublisherIdentifiersFromNode(matchedNode).identifiers,
        };
  };

  for (const node of nodes) {
    const rawTypes = node["@type"];
    const types =
      typeof rawTypes === "string"
        ? [rawTypes]
        : Array.isArray(rawTypes)
          ? rawTypes.filter(
              (entry): entry is string => typeof entry === "string",
            )
          : [];
    const rootField = sameSiteStructuredRootField(node, pageUrl);
    if (types.some((type) => /^website$/iu.test(type)) && rootField !== null) {
      const normalizedWebsite = {
        "@type": rawTypes,
        [rootField.key]: rootField.value,
      };
      const explicitPublisher = publisherMatch(node["publisher"]);
      if (explicitPublisher !== null) {
        return {
          name: explicitPublisher.name,
          role: "WebSite.publisher",
          locator: explicitPublisher.locator,
          normalizedDocument: {
            ...normalizedWebsite,
            publisher: explicitPublisher.normalizedPublisher,
          },
          identifiers: explicitPublisher.identifiers,
        };
      }
      const ownName = matchingName(node);
      if (ownName !== null) {
        return {
          name: ownName,
          role: "WebSite.name",
          locator: rootField.value,
          normalizedDocument: {
            ...normalizedWebsite,
            name: ownName,
          },
          identifiers: [],
        };
      }
    }
  }
  for (const node of nodes) {
    const rawTypes = node["@type"];
    const types =
      typeof rawTypes === "string"
        ? [rawTypes]
        : Array.isArray(rawTypes)
          ? rawTypes.filter(
              (entry): entry is string => typeof entry === "string",
            )
          : [];
    if (
      !types.some((type) =>
        /^(?:corporation|localbusiness|organization)$/iu.test(type),
      )
    ) {
      continue;
    }
    // An unreferenced Organization is attributable only when it claims the
    // site's root URL, not a same-host customer/profile path.
    const name = matchingName(node);
    const rootField = sameSiteStructuredRootField(node, pageUrl);
    if (name !== null && rootField !== null) {
      return {
        name,
        role: "Organization.root",
        locator: rootField.value,
        normalizedDocument: structuredNodeFields(node),
        identifiers: structuredPublisherIdentifiersFromNode(node).identifiers,
      };
    }
  }
  return null;
}

function structuredPublisherMatches(
  content: string,
  pageUrl: string,
  companyName: string,
): readonly StructuredPublisherMatch[] {
  const publishers: StructuredPublisherMatch[] = [];
  const scripts =
    /<script\b(?=[^>]*\btype\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json'|application\/ld\+json))[^>]*>([\s\S]*?)<\/script\s*>/giu;
  for (const match of content.matchAll(scripts)) {
    const body = match[1]?.replace(/^\s*<!--|-->\s*$/gu, "").trim();
    if (body === undefined || body === "") continue;
    let document: unknown;
    try {
      document = JSON.parse(body);
    } catch {
      continue;
    }
    const publisher = structuredPublisherMatch(document, pageUrl, companyName);
    if (publisher !== null) publishers.push(publisher);
  }
  return publishers;
}

function structuredWebsitePublisherNames(
  content: string,
  pageUrl: string,
): readonly string[] {
  const names: string[] = [];
  const scripts =
    /<script\b(?=[^>]*\btype\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json'|application\/ld\+json))[^>]*>([\s\S]*?)<\/script\s*>/giu;
  for (const match of content.matchAll(scripts)) {
    const body = match[1]?.replace(/^\s*<!--|-->\s*$/gu, "").trim();
    if (body === undefined || body === "") continue;
    let document: unknown;
    try {
      document = JSON.parse(body);
    } catch {
      continue;
    }
    const roots = Array.isArray(document) ? document : [document];
    const nodes: Record<string, unknown>[] = [];
    for (const root of roots) {
      if (typeof root !== "object" || root === null || Array.isArray(root)) {
        continue;
      }
      const rootNode = root as Record<string, unknown>;
      nodes.push(rootNode);
      const graph = rootNode["@graph"];
      if (Array.isArray(graph)) {
        for (const entry of graph) {
          if (
            typeof entry === "object" &&
            entry !== null &&
            !Array.isArray(entry)
          ) {
            nodes.push(entry as Record<string, unknown>);
          }
        }
      }
    }
    const nodesById = new Map<string, Record<string, unknown>>();
    for (const node of nodes) {
      if (typeof node["@id"] === "string") {
        nodesById.set(node["@id"], node);
      }
    }
    for (const node of nodes) {
      if (
        !structuredTypeIncludes(node, "website") ||
        sameSiteStructuredRootField(node, pageUrl) === null
      ) {
        continue;
      }
      const rawPublisher = node["publisher"];
      const publisherObject =
        typeof rawPublisher === "object" &&
        rawPublisher !== null &&
        !Array.isArray(rawPublisher)
          ? (rawPublisher as Record<string, unknown>)
          : null;
      const rawPublisherReference = publisherObject?.["@id"];
      const publisherReference =
        typeof rawPublisherReference === "string"
          ? rawPublisherReference
          : null;
      const publisher =
        typeof rawPublisher === "string"
          ? (nodesById.get(rawPublisher) ?? rawPublisher)
          : publisherReference === null
            ? rawPublisher
            : (nodesById.get(publisherReference) ?? rawPublisher);
      if (typeof publisher === "string") {
        if (!/^https?:/iu.test(publisher)) names.push(publisher);
        continue;
      }
      if (
        typeof publisher === "object" &&
        publisher !== null &&
        !Array.isArray(publisher)
      ) {
        const publisherName = (publisher as Record<string, unknown>)["name"];
        if (typeof publisherName === "string") names.push(publisherName);
      }
    }
  }
  return uniqueStrings(names);
}

function hasProfileResourceUrl(pageUrl: string | null): boolean {
  if (pageUrl === null) return false;
  try {
    const path = new URL(pageUrl).pathname.toLocaleLowerCase("en-US");
    return (
      /\/(?:list\/member|directory\/(?:company|member)|profiles?\/(?:company|member))(?:\/|$)/u.test(
        path,
      ) ||
      /\/(?:[a-z]{2}\/)?company\/[^/]+\/[a-f0-9]{24,}\/?$/u.test(path) ||
      /\/c\/[^/]+-email-format\/?$/u.test(path) ||
      /\/company\/(?:\d+|[^/]+-\d+)\/?$/u.test(path) ||
      /\/documents?\/[^/]+-[a-z0-9]{10,}\/?$/u.test(path)
    );
  } catch {
    return false;
  }
}

function hasExternalLabeledPublisherUrl(
  text: string,
  pageUrl: string | null,
): boolean {
  if (pageUrl === null) return false;
  let pageHost: string;
  try {
    pageHost = new URL(pageUrl).hostname
      .toLocaleLowerCase("en-US")
      .replace(/^www\./u, "");
  } catch {
    return false;
  }
  // A standalone field label followed by a URL is profile metadata; a prose
  // mention of "website" or an unrelated navigation link is not. The newline
  // form allows at most two blank field-separator lines, never intervening text.
  const labeledUrl =
    /(?:^|\n)[^\S\n]*(?:company website|domain name|website)[^\S\n]*(?:(?:[|:][^\S\n]*)|(?:\n[^\S\n]*){1,3})((?:https?:\/\/|www\.)[^\s|<>"']+)/gimu;
  for (const match of text.matchAll(labeledUrl)) {
    const value = match[1]?.replace(/[),.;]+$/gu, "");
    if (value === undefined) continue;
    try {
      const candidate = new URL(
        /^www\./iu.test(value) ? `https://${value}` : value,
      );
      const candidateHost = candidate.hostname
        .toLocaleLowerCase("en-US")
        .replace(/^www\./u, "");
      if (candidateHost !== pageHost) return true;
    } catch {
      continue;
    }
  }
  return false;
}

function hasOtherCopyrightPublisher(
  text: string,
  companyName: string,
): boolean {
  for (const line of text.split("\n")) {
    if (!/(?:©|\(c\)|\bcopyright\b)/iu.test(line)) continue;
    const afterMarker = line
      .replace(/^.*?(?:©|\(c\)|\bcopyright\b)/iu, "")
      .replace(/^\s*(?:(?:©|\(c\)|copyright\b)\s*)+/iu, "")
      .replace(
        /^\s*(?:[-–—,.:;]\s*)?(?:19|20)\d{2}(?:\s*[-–—]\s*(?:19|20)?\d{2})?\s*[,.:;-]?\s*/u,
        "",
      );
    const owner = afterMarker
      .split(
        /\b(?:all\s+rights?\s+reserved|privacy\s+policy|terms\s+of\s+(?:service|use)|website\s+(?:created|designed|developed|hosted|powered))\b/iu,
      )[0]
      ?.split(/\s+[|•]\s+/u)[0]
      ?.replace(/^[\s,.:;—–-]+|[\s,.:;—–-]+$/gu, "")
      .trim();
    if (
      owner !== undefined &&
      parsedLegalIdentity(owner) !== null &&
      !publisherIdentityEquivalent(owner, companyName)
    ) {
      return true;
    }
  }
  return false;
}

function hasThirdPartyProfileContext(
  content: string,
  pageUrl: string | null,
  companyName: string,
): boolean {
  const profileResourceUrl = hasProfileResourceUrl(pageUrl);
  const text = normalizePageText(content);
  const externalHostSignals =
    /\b(?:this )?document was uploaded by (?:a |the )?user\b/iu.test(text) ||
    hasExternalLabeledPublisherUrl(text, pageUrl);
  const roleSignals = [
    /\bchamber of commerce\b/iu,
    /\b(?:business|company|manufacturer|member|supplier)\s+(?:directory|listing)\b/iu,
    /\bvisit (?:company )?website\b/iu,
    /\b(?:uploaded by|document was uploaded by|report (?:this )?document)\b/iu,
    /\bget (?:verified|authenticated) emails?\b/iu,
    /\b(?:company website|domain name)\b[\s|:]{0,40}(?:https?:\/\/|www\.)/iu,
    /\bthousands of companies,\s*people and products\b/iu,
    /\bpost your profile\b/iu,
  ].some((pattern) => pattern.test(text));
  const dataServiceSignals = [
    /\bour data\b/iu,
    /\bpricing\b/iu,
    /\bmarket intelligence\b/iu,
    /\bsupply chain analytics\b/iu,
    /\bbill of lading\b/iu,
    /\bimports?\b[^.!?\n]{0,80}\bexports?\b/iu,
    /\bbuyer-supplier discovery\b/iu,
  ].filter((pattern) => pattern.test(text)).length;
  const otherCopyrightPublisher = hasOtherCopyrightPublisher(text, companyName);
  const otherStructuredPublisher =
    pageUrl !== null &&
    structuredWebsitePublisherNames(content, pageUrl).some(
      (publisher) => !publisherIdentityEquivalent(publisher, companyName),
    );
  if (
    externalHostSignals ||
    (profileResourceUrl && otherStructuredPublisher) ||
    ((roleSignals || dataServiceSignals >= 2) &&
      (otherCopyrightPublisher || otherStructuredPublisher))
  ) {
    return true;
  }
  // Profile-shaped routes are ambiguous rather than inherently third-party.
  // Resolve them only with distinct host-role and copyright publisher signals.
  if (!profileResourceUrl) return false;
  return (
    pageUrl === null ||
    strongTargetHostPublisherExcerpt(content, pageUrl, companyName) === null
  );
}

function normalizedStructuredPublisherExcerpt(
  publisher: StructuredPublisherMatch,
  maxChars = Number.POSITIVE_INFINITY,
): string | null {
  const normalizedEvidence =
    `[normalized JSON-LD publisher evidence; not a verbatim quote; ` +
    `role=${publisher.role}; locator=${JSON.stringify(publisher.locator)}]` +
    `\n<script type="application/ld+json">` +
    `${JSON.stringify(publisher.normalizedDocument)}</script>`;
  return normalizedEvidence.length <= maxChars ? normalizedEvidence : null;
}

function structuredPublisherExcerpt(
  content: string,
  pageUrl: string,
  companyName: string,
  maxChars = Number.POSITIVE_INFINITY,
): string | null {
  for (const publisher of structuredPublisherMatches(
    content,
    pageUrl,
    companyName,
  )) {
    const excerpt = normalizedStructuredPublisherExcerpt(publisher, maxChars);
    if (excerpt !== null) return excerpt;
  }
  return null;
}

function strongTargetHostPublisherExcerpt(
  content: string,
  pageUrl: string,
  companyName: string,
  maxChars = Number.POSITIVE_INFINITY,
): string | null {
  const targetHostPublisher = structuredPublisherMatches(
    content,
    pageUrl,
    companyName,
  ).find((publisher) => publisher.role === "WebSite.publisher");
  if (targetHostPublisher === undefined) return null;
  const structured = normalizedStructuredPublisherExcerpt(targetHostPublisher);
  const copyright = copyrightPublisherExcerpt(
    normalizePageText(content),
    companyName,
  );
  if (structured === null || copyright === null) return null;
  return boundedPublisherContext([structured, copyright], maxChars);
}

function publisherOperationalSelfDescriptionExcerpt(
  text: string,
  maxStatements = 2,
): string | null {
  return (
    splitPageSentences(text)
      .slice(0, maxStatements)
      .find((statement) =>
        /^(?:(?:we|our\s+(?:company|business))\s+(?:design|develop|engineer|build|make|manufacture|produce|fabricate|assemble|repair|overhaul)\w*|we\s+are\s+(?:an?\s+)?(?:(?:full[-\s]+)?service\s+facility|aircraft\s+service\s+facility|designer|developer|manufacturer|producer|fabricator|machine shop)\b|our\s+products?\s+(?:is|are)\s+(?:designed|developed|engineered|built|made|manufactured|produced)\b|our\s+(?:(?:manufacturing|corporate)\s+)?(?:office|facility|plant|team)(?:\s+and\s+(?:(?:manufacturing|corporate)\s+)?(?:office|facility|plant|team))?\s+(?:is|are)\s+(?:located|based|headquartered)\b)/iu.test(
          statement,
        ),
      ) ?? null
  );
}

function boundedPublisherContext(
  parts: readonly (string | null)[],
  maxChars = Number.POSITIVE_INFINITY,
): string | null {
  const excerpt = [
    ...new Set(
      parts
        .filter((part): part is string => part !== null)
        .map((part) => part.trim())
        .filter((part) => part !== ""),
    ),
  ].join("\n");
  return excerpt !== "" && excerpt.length <= maxChars ? excerpt : null;
}

function plainTextPublisherExcerpt(
  text: string,
  companyName: string,
  maxChars = Number.POSITIVE_INFINITY,
): string | null {
  const copyright = copyrightPublisherExcerpt(text, companyName, maxChars);
  if (copyright !== null) return copyright;
  const pattern = legalNamePattern(companyName);
  if (pattern === null) return null;
  const publisherPattern = legalPublisherNamePatterns(companyName).join("|");
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    const candidate = line.trim().replace(/^welcome\s+to\s+/iu, "");
    if (!publisherIdentityEquivalent(candidate, companyName)) continue;
    const nearbyPublisherVoice = lines
      .slice(Math.max(0, index - 1), Math.min(lines.length, index + 4))
      .join("\n");
    const operational = publisherOperationalSelfDescriptionExcerpt(
      nearbyPublisherVoice,
      5,
    );
    if (operational !== null) {
      const excerpt = boundedPublisherContext([line, operational], maxChars);
      if (excerpt !== null) return excerpt;
    }
  }
  const directPublisher = new RegExp(
    `^(?:we\\s+are\\s+(?:${publisherPattern})(?=\\s*(?:[,.;:]|$))|at\\s+(?:${publisherPattern})\\s*,\\s*we\\b)`,
    "iu",
  );
  for (const statement of splitPageSentences(text)) {
    if (directPublisher.test(statement)) {
      const excerpt = boundedPublisherContext([statement], maxChars);
      if (excerpt !== null) return excerpt;
    }
  }
  const matches = text.matchAll(
    new RegExp(`(?:^|[^a-z0-9])(${pattern})(?![a-z0-9])`, "giu"),
  );

  for (const match of matches) {
    const identity = match[1];
    if (identity === undefined || match.index === undefined) continue;
    const identityStart = match.index + match[0].indexOf(identity);
    const identityEnd = identityStart + identity.length;
    const lineStart = text.lastIndexOf("\n", identityStart - 1) + 1;
    const nextLine = text.indexOf("\n", identityEnd);
    const lineEnd = nextLine === -1 ? text.length : nextLine;
    const line = text.slice(lineStart, lineEnd).trim();
    const localContext = text
      .slice(identityEnd, Math.min(text.length, identityEnd + 500))
      .replace(/^[\s,.:;—-]+/u, "");
    const operational =
      publisherOperationalSelfDescriptionExcerpt(localContext);
    if (
      publisherIdentityEquivalent(line, companyName) &&
      operational !== null
    ) {
      const excerpt = boundedPublisherContext([line, operational], maxChars);
      if (excerpt !== null) return excerpt;
    }

    const beforeIdentity = text.slice(lineStart, identityStart);
    const clauseBoundary = Math.max(
      beforeIdentity.lastIndexOf("."),
      beforeIdentity.lastIndexOf("!"),
      beforeIdentity.lastIndexOf("?"),
      beforeIdentity.lastIndexOf(";"),
    );
    const prefix = beforeIdentity.slice(clauseBoundary + 1).trim();
    const allowedPrefix =
      prefix === "" || /^(?:about|contact|welcome\s+to)$/iu.test(prefix);
    if (!allowedPrefix) continue;
    const statementStart = lineStart + clauseBoundary + 1;
    const publisherStatement =
      splitPageSentences(text.slice(statementStart, lineEnd))[0] ?? line;

    const suffix = text.slice(identityEnd, lineEnd);
    const directOperationalDescription =
      /^[\s,.:;()—-]*(?:[A-Z0-9]{2,10}\s*\)\s*)?(?:designs?|develops?|builds?|makes?|manufactures?|produces?|takes?\s+pride\s+in\s+(?:offering|providing))\b/iu.test(
        suffix,
      );
    const selfDescription =
      /^[\s,.:;()—-]*(?:[A-Z0-9]{2,10}\s*\)\s*)?(?:is|are|provides?|specializes?|serves?|offers?|has)\b/iu.test(
        suffix,
      ) &&
      !/\b(?:business|company|supplier)\s+director(?:y|ies)\b|\blisted\s+in\s+(?:our|the)\b/iu.test(
        suffix,
      );
    const directIntroduction = /^(?:welcome\s+to|about)$/iu.test(prefix);
    if (
      operational !== null &&
      (directOperationalDescription || selfDescription || directIntroduction)
    ) {
      const excerpt = boundedPublisherContext(
        [publisherStatement, operational],
        maxChars,
      );
      if (excerpt !== null) return excerpt;
    }
  }
  return null;
}

function hasLabeledIdentifier(
  text: string,
  label: "UEI" | "CAGE",
  rawValue: string | null,
): boolean {
  const expected =
    rawValue === null
      ? null
      : normalizedValidPublishedIdentifier(label, rawValue);
  return (
    expected !== null &&
    labeledIdentifierValues(text, label).some(
      (value) => normalizedPublishedIdentifier(value) === expected,
    )
  );
}

interface PublisherIdentifierAssessment {
  readonly matched: boolean;
  readonly conflicting: boolean;
}

function targetPublisherIdentifierAssessment(
  pageTexts: readonly string[],
  pageUrls: readonly (string | null)[],
  companyName: string,
  label: "UEI" | "CAGE",
  rawValue: string | null,
): PublisherIdentifierAssessment {
  const expected =
    rawValue === null
      ? null
      : normalizedValidPublishedIdentifier(label, rawValue);
  if (expected === null) {
    return { matched: false, conflicting: false };
  }
  let matched = false;
  let conflicting = false;
  const observe = (value: string): void => {
    if (normalizedPublishedIdentifier(value) === expected) {
      matched = true;
    } else {
      conflicting = true;
    }
  };
  for (const [index, content] of pageTexts.entries()) {
    const text = normalizePageText(content);
    const pageUrl = pageUrls[index] ?? null;
    const structuredPublishers =
      pageUrl === null
        ? []
        : structuredPublisherMatches(content, pageUrl, companyName);
    const targetPublisherEstablished =
      attributablePlainPublisherExcerpt(
        plainTextPublisherExcerpt(text, companyName),
      ) ||
      splitPageSentences(text).some((sentence) =>
        attributablePlainPublisherExcerpt(
          plainTextPublisherExcerpt(sentence, companyName),
        ),
      ) ||
      structuredPublishers.length > 0;
    if (!targetPublisherEstablished) continue;
    for (const publisher of structuredPublishers) {
      for (const identifier of publisher.identifiers) {
        if (identifier.label === label) observe(identifier.value);
      }
    }
    for (const sentence of splitPageSentences(text)) {
      if (!identifierStatementTargetsPublisher(sentence, companyName, label)) {
        continue;
      }
      for (const value of labeledIdentifierValues(sentence, label)) {
        observe(value);
      }
    }
  }
  return { matched, conflicting };
}

function identifierStatementTargetsPublisher(
  sentence: string,
  companyName: string,
  label: "UEI" | "CAGE",
): boolean {
  if (
    /\b(?:customer|client|parent(?:\s+company)?|partner|supplier|subsidiary|portfolio\s+company)\b/iu.test(
      sentence,
    )
  ) {
    return false;
  }
  const labelPattern = label === "CAGE" ? "CAGE" : "UEI";
  if (new RegExp(`^\\s*${labelPattern}\\b`, "iu").test(sentence)) return true;
  if (
    new RegExp(
      `\\b(?:our|we(?:\\s+use)?)\\b[^.!?]{0,80}\\b${labelPattern}\\b`,
      "iu",
    ).test(sentence)
  ) {
    return true;
  }
  const companyPattern = legalNamePattern(companyName);
  return (
    companyPattern !== null &&
    (new RegExp(
      `${companyPattern}[^.!?]{0,100}\\b${labelPattern}\\b`,
      "iu",
    ).test(sentence) ||
      new RegExp(
        `\\b${labelPattern}\\b[^.!?]{0,100}${companyPattern}`,
        "iu",
      ).test(sentence))
  );
}

const LABELED_IDENTIFIER_TOKEN =
  "(?:[A-Z0-9](?:[ -]+[A-Z0-9])+|[A-Z0-9-]+)";
const CAGE_LABELED_IDENTIFIER_PATTERN = new RegExp(
  `\\bCAGE(?:\\s+(code|number|no\\.?))?\\s*([:#-]?)\\s*(${LABELED_IDENTIFIER_TOKEN})(?![A-Z0-9-])`,
  "giu",
);
const UEI_LABELED_IDENTIFIER_PATTERN = new RegExp(
  `\\bUEI(?:\\s+(code|number|no\\.?))?\\s*([:#-]?)\\s*(${LABELED_IDENTIFIER_TOKEN})(?![A-Z0-9-])`,
  "giu",
);

function labeledIdentifierValues(
  sentence: string,
  label: "UEI" | "CAGE",
): readonly string[] {
  const pattern =
    label === "CAGE"
      ? CAGE_LABELED_IDENTIFIER_PATTERN
      : UEI_LABELED_IDENTIFIER_PATTERN;
  return [...sentence.matchAll(pattern)].flatMap((match) => {
    const qualifier = match[1];
    const delimiter = match[2];
    const value = match[3];
    if (
      value === undefined ||
      normalizedValidPublishedIdentifier(label, value) === null ||
      (qualifier === undefined && delimiter === "" && !/\d/u.test(value))
    ) {
      return [];
    }
    return [value];
  });
}

const CAGE_IDENTIFIER_PATTERN = /^[A-Z0-9]{5}$/u;
const UEI_IDENTIFIER_PATTERN = /^[A-Z0-9]{12}$/u;

function normalizedValidPublishedIdentifier(
  label: "UEI" | "CAGE",
  value: string,
): string | null {
  const normalized = normalizedPublishedIdentifier(value);
  const pattern =
    label === "CAGE" ? CAGE_IDENTIFIER_PATTERN : UEI_IDENTIFIER_PATTERN;
  return pattern.test(normalized) ? normalized : null;
}

function normalizedPublishedIdentifier(value: string): string {
  return value.replace(/[\s-]+/gu, "").toLocaleUpperCase("en-US");
}

function hasExactSignalLocation(
  text: string,
  rawCity: string | null,
  rawState: string | null,
): boolean {
  const city = rawCity?.trim() ?? "";
  const state = rawState?.trim() ?? "";
  const cityPattern =
    city === "" ? null : city.split(/\s+/u).map(escapeRegExp).join("[\\s.-]+");
  const normalizedState = state === "" ? "" : normalizeState(state);
  const stateNamePattern =
    normalizedState === ""
      ? null
      : normalizedState.split(/\s+/u).map(escapeRegExp).join("\\s+");
  const stateCode = state === "" ? null : getUsStateCode(state);
  const statePattern =
    stateNamePattern === null
      ? null
      : stateCode === null
        ? stateNamePattern
        : `(?:(?<stateName>${stateNamePattern})|(?<stateCode>${escapeRegExp(stateCode)}))`;
  let locationPattern: string | null = null;
  if (cityPattern !== null && statePattern !== null) {
    locationPattern = `(?:^|[^a-z0-9])${cityPattern}(?![a-z0-9])[\\s,.-]{0,12}${statePattern}(?![a-z0-9])`;
  } else if (cityPattern !== null) {
    locationPattern = `(?:^|[^a-z0-9])${cityPattern}(?![a-z0-9])`;
  } else if (statePattern !== null) {
    locationPattern = `(?:^|[^a-z0-9])${statePattern}(?![a-z0-9])`;
  }
  if (locationPattern === null) return false;

  for (const match of text.matchAll(new RegExp(locationPattern, "giu"))) {
    if (match.index === undefined) continue;
    if (cityPattern === null && statePattern !== null) {
      const matchedStateCode =
        match.groups?.["stateCode"] !== undefined ||
        (stateCode === null && state.length === 2);
      if (matchedStateCode) {
        const afterState = text.slice(
          match.index + match[0].length,
          match.index + match[0].length + 12,
        );
        if (/^\s+\d{5}(?:-\d{4})?\b/u.test(afterState)) return true;
        continue;
      }
    }
    const context = text.slice(
      Math.max(0, match.index - 120),
      Math.min(text.length, match.index + match[0].length + 120),
    );
    if (
      /\b(?:address|based|contact|facilit(?:y|ies)|headquarter(?:ed|s)?|located|location|mailing|manufacturing|office|plant)\b/iu.test(
        context,
      ) ||
      /\bwe\s+(?:are|operate)\b|\bour\s+(?:business|company|facility|office|plant|team)\b/iu.test(
        context,
      ) ||
      /\b\d{5}(?:-\d{4})?\b/u.test(context)
    ) {
      return true;
    }
  }
  return false;
}

function publisherIdentityExcerpt(
  text: string,
  companyName: string,
): string | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const candidates = [trimmed, ...trimmed.split(/\s+[|—–-]\s+/u)];
    if (
      candidates.some((candidate) =>
        publisherIdentityEquivalent(candidate.trim(), companyName),
      )
    ) {
      return trimmed.slice(0, 500);
    }
  }
  return copyrightPublisherExcerpt(text, companyName);
}

function pagePublisherIdentity(
  page: WebsiteFetchedPage,
  companyName: string,
): string | null {
  return publisherIdentityExcerpt(`${page.title}\n${page.text}`, companyName);
}

function attributableCompanyPatterns(
  companyName: string,
  publisherIdentity: string | null,
): readonly string[] {
  const fullPattern = legalNamePattern(companyName);
  if (fullPattern === null) return [];
  if (publisherIdentity === null) return [fullPattern];

  const parsed = parsedLegalIdentity(companyName);
  if (parsed === null) return [fullPattern];
  const patterns = [fullPattern];
  const rootPattern = parsed.rootTokens.map(escapeRegExp).join("[^a-z0-9]+");
  if (parsed.suffix !== null) patterns.push(rootPattern);

  const firstRootToken = parsed.rootTokens[0];
  const publisherFirstToken =
    firstRootToken === undefined
      ? undefined
      : new RegExp(
          `(?:^|[^a-z0-9])(${escapeRegExp(firstRootToken)})(?![a-z0-9])`,
          "iu",
        ).exec(publisherIdentity)?.[1];
  // Use the publisher's own casing, never an all-uppercase raw FAA name.
  const internallyCased =
    publisherFirstToken !== undefined &&
    /[a-z]/u.test(publisherFirstToken) &&
    /^[A-Z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*$/u.test(publisherFirstToken);
  const shortInitialism =
    publisherFirstToken !== undefined &&
    /^[A-Z0-9]{2,5}$/u.test(publisherFirstToken);
  if (
    parsed.rootTokens.length >= 2 &&
    publisherFirstToken !== undefined &&
    (internallyCased || shortInitialism)
  ) {
    patterns.push(escapeRegExp(publisherFirstToken));
  }
  return uniqueStrings(patterns);
}

function legalNameStartsClause(
  sentence: string,
  companyName: string,
  publisherIdentity: string | null = null,
): boolean {
  const patterns = attributableCompanyPatterns(companyName, publisherIdentity);
  if (patterns.length === 0) return false;
  return new RegExp(
    `^\\s*(?:(?:in|as of)\\s+\\d{4}\\s*,\\s*)?(?:${patterns.join("|")})(?=\\s*(?:[,;:]|['’]s\\b|(?:\\.\\s*)?(?:$|\\b(?:(?:currently|presently)\\s+)?(?:am|is|are|has|have|remains?|continues?\\s+to\\s+be|reports?|reported|employs?|operates?|generated|recorded|maintains?|headquartered|designs?|develops?|engineers?|builds?|makes?|manufactures?|produces?)\\b)))`,
    "iu",
  ).test(sentence);
}

function canonicalizePublisherSubject(
  sentence: string,
  companyName: string,
  publisherIdentity: string | null,
): string {
  if (publisherIdentity === null) return sentence;
  const patterns = attributableCompanyPatterns(companyName, publisherIdentity);
  if (patterns.length === 0) return sentence;
  const match = new RegExp(
    `^(\\s*(?:(?:in|as of)\\s+\\d{4}\\s*,\\s*)?)(?:${patterns.join("|")})(?=\\s*(?:[,;:]|['’]s\\b|(?:\\.\\s*)?(?:$|\\b)))`,
    "iu",
  ).exec(sentence);
  if (match === null || match[1] === undefined) return sentence;
  return `${match[1]}${companyName}${sentence.slice(match[0].length)}`;
}

function hasInheritedThirdPartySpeaker(
  sentence: string,
  preceding: ScopedEvidenceStatement | undefined,
): boolean {
  return (
    preceding !== undefined &&
    !preceding.quoted &&
    /\b(?:customers?|clients?|partners?|suppliers?)\b[^.!?]{0,100}\b(?:spotlight|story|testimonial|case study|says?|states?|reports?|quote)\b/iu.test(
      preceding.text,
    ) &&
    /^\s*(?:we|our)\b/iu.test(sentence)
  );
}

function targetAttributedStatement(
  sentence: string,
  companyName: string,
  publisherIdentity: string | null = null,
): string | null {
  const companyPatterns = attributableCompanyPatterns(
    companyName,
    publisherIdentity,
  );
  const companyPattern =
    companyPatterns.length === 0 ? null : `(?:${companyPatterns.join("|")})`;
  if (companyPattern !== null) {
    const companyPossessive = new RegExp(
      `^\\s*(?:(?:in|as of)\\s+\\d{4}\\s*,\\s*)?${companyPattern}\\s*['’]s\\s+([^\\s,;.!?]+(?:\\s+[^\\s,;.!?]+)?)`,
      "iu",
    ).exec(sentence);
    if (
      companyPossessive !== null &&
      !/^(?:(?:(?:annual|total)\s+)?(?:revenue|sales)|headquarters|home office|facility|plant|team|workforce)\b/iu.test(
        companyPossessive[1] ?? "",
      )
    ) {
      return null;
    }
  }

  const directTargetSubject =
    /^\s*we\b/iu.test(sentence) ||
    /^\s*our\s+(?:company|business|(?:annual\s+|total\s+)?revenue|annual sales|sales|headquarters|home office|facility|plant|team|workforce)\b/iu.test(
      sentence,
    ) ||
    legalNameStartsClause(sentence, companyName, publisherIdentity);
  if (!directTargetSubject) return null;

  // Commas and conjunctions inside the target's legal name cannot introduce
  // another speaker (for example, "Electronics International, Inc. remains").
  const companySubjectEnd =
    companyPattern === null
      ? 0
      : (new RegExp(
          `^\\s*(?:(?:in|as of)\\s+\\d{4}\\s*,\\s*)?${companyPattern}\\b`,
          "iu",
        ).exec(sentence)?.[0].length ?? 0);
  const predicateText = sentence.slice(companySubjectEnd);
  let end = sentence.length;
  const relativeSubjectShift = /(?:,\s*|\s+)(?:which|who|whose|that)\b/iu.exec(
    predicateText,
  );
  if (relativeSubjectShift?.index !== undefined) {
    const antecedent = sentence.slice(
      0,
      companySubjectEnd + relativeSubjectShift.index,
    );
    const targetSubject =
      companyPattern === null
        ? "(?:we|our\\s+(?:company|business))"
        : `(?:we|our\\s+(?:company|business)|${companyPattern})`;
    const introducesOtherEntity =
      new RegExp(
        `^\\s*(?:(?:in|as of)\\s+\\d{4}\\s*,\\s*)?${targetSubject}\\s+(?!am\\b|is\\b|are\\b|remain(?:s)?\\b|continue\\b|has\\s+been\\b|have\\s+been\\b|was\\b|were\\b)`,
        "iu",
      ).test(antecedent) ||
      /\b(?:to|for|with|from|by|serving|supporting|supplying)\s+(?:the\s+)?[A-Z][A-Za-z0-9&'’.-]*(?:\s+[A-Z][A-Za-z0-9&'’.-]*){0,4}\s*$/u.test(
        antecedent,
      );
    if (introducesOtherEntity) {
      end = Math.min(end, companySubjectEnd + relativeSubjectShift.index);
    }
  }
  const explicitSubjectShift =
    /(?:[,;]\s*|\s+\b(?:and|but|while)\s+)(?:(?:our|the)\s+(?:customer|client|supplier|partner|parent|portfolio company|subsidiary|division)\b[^,;.!?]{0,60}|(?:it|they|he|she)\b|[A-Z][A-Za-z0-9&'’.-]*(?:\s+[A-Z][A-Za-z0-9&'’.-]*){0,4})\s+(?:reports?|reported|has|have|is|are|was|were|remains?|headquartered)\b/u.exec(
      predicateText,
    );
  if (explicitSubjectShift?.index !== undefined) {
    end = Math.min(end, companySubjectEnd + explicitSubjectShift.index);
  }
  const scoped = sentence.slice(0, end).trim();
  return scoped === "" ? null : scoped;
}

function isCurrentAffirmativeIndependence(
  sentence: string,
  companyName: string,
): boolean {
  if (
    targetAttributedStatement(sentence, companyName) === null ||
    /\b(?:formerly|previously|once|no longer|not|used to|until)\b/iu.test(
      sentence,
    ) ||
    /\b(?:was|were)\s+(?:a\s+)?(?:family[- ]owned|independently owned)\b/iu.test(
      sentence,
    )
  ) {
    return false;
  }
  const legalPattern = legalNamePattern(companyName);
  const firstPersonTarget = "(?:we|our\\s+(?:company|business))";
  const targetBeforePredicate =
    legalPattern === null
      ? `${firstPersonTarget}\\s+`
      : `(?:${firstPersonTarget}\\s+|${legalPattern}(?:\\.\\s*|\\s+))`;
  const targetSubject =
    legalPattern === null
      ? firstPersonTarget
      : `(?:${firstPersonTarget}|${legalPattern})`;
  const independencePredicate =
    "(?:am|is|are|remain(?:s)?|continue(?:s)?\\s+to\\s+be|has\\s+been|have\\s+been)\\s+(?:a\\s+)?(?:family[- ]owned|independently owned)";
  return (
    new RegExp(
      `^\\s*(?:(?:in|as of)\\s+\\d{4}\\s*,\\s*)?${targetBeforePredicate}${independencePredicate}\\b`,
      "iu",
    ).test(sentence) ||
    new RegExp(
      `^\\s*${targetSubject}\\b[^.!?]{0,160}(?:,\\s*|\\band\\s+)${independencePredicate}\\b`,
      "iu",
    ).test(sentence)
  );
}

function classifyOfficialSiteOwnership(sentence: string, companyName: string) {
  const firstPerson = /^\s*(?:we|our company|our business)\b/iu.test(sentence);
  const attributedSentence = firstPerson
    ? sentence.replace(/^\s*(?:we|our company|our business)\b/iu, companyName)
    : sentence;
  const classified = classifySentence(attributedSentence, companyName);
  return classified?.currentRelation === true ? classified : null;
}

interface QuantitativeCurrentness {
  readonly periodYear: number | null;
  readonly currentness: "latest_completed_period" | "undated_current";
}

function quantitativeStatementCurrentness(
  sentence: string,
  kind: "revenue" | "employee_count" | "facility_scale",
): QuantitativeCurrentness | null {
  if (
    /\b(?:forecast|forecasted|projected|projection|target|guidance|pro forma|expects?|estimated|plans?|aims?|will|next year)\b/iu.test(
      sentence,
    ) ||
    /\b(?:formerly|previously|historically|once|at the time|used to|prior year|previous year)\b/iu.test(
      sentence,
    )
  ) {
    return null;
  }
  const yearMatch = /\b(19\d{2}|20\d{2})\b/u.exec(sentence);
  if (yearMatch?.[1] === undefined) {
    return /\b(?:last year|last quarter|fiscal[- ]year|for the year ended)\b/iu.test(
      sentence,
    )
      ? null
      : { periodYear: null, currentness: "undated_current" };
  }
  if (kind !== "revenue") return null;
  const latest =
    /\b(?:latest|most recent)(?:\s+(?:reported|completed|available))?\s+(?:annual|full[- ]year|fiscal[- ]year|yearly)\b/iu.test(
      sentence,
    ) ||
    /\b(?:latest|most recent)\s+(?:reported|completed)\b/iu.test(sentence);
  const year = Number.parseInt(yearMatch[1], 10);
  const currentYear = new Date().getUTCFullYear();
  if (!latest || year < currentYear - 2 || year > currentYear) return null;
  return { periodYear: year, currentness: "latest_completed_period" };
}

function isHistoricalQuantitativeStatement(sentence: string): boolean {
  const kind = explicitSizeKind(sentence);
  return (
    kind !== null && quantitativeStatementCurrentness(sentence, kind) === null
  );
}

function targetSubjectPattern(companyName: string): string {
  const legalPattern = legalNamePattern(companyName);
  return legalPattern === null
    ? "(?:we|our\\s+(?:company|business))"
    : `(?:we|our\\s+(?:company|business)|${legalPattern})`;
}

function hasTargetSizeBinding(
  sentence: string,
  companyName: string,
  sizeKind: "revenue" | "employee_count" | "facility_scale",
): boolean {
  if (sizeKind === "revenue") {
    return hasTargetRevenueBinding(sentence, companyName);
  }
  const quantitativeNoun =
    sizeKind === "employee_count"
      ? "\\d[\\d,]*\\s*(?:employees|associates|team members|staff|people)\\b"
      : "\\d[\\d,]*\\s*(?:square feet|sq\\.?\\s*ft\\.?|acres?)\\b";
  const ownedProperty =
    sizeKind === "employee_count"
      ? "(?:team|workforce|staff)"
      : "(?:facility|headquarters|home office|plant)";
  if (
    new RegExp(
      `^\\s*our\\s+${ownedProperty}\\b[^.!?]{0,100}\\b${quantitativeNoun}`,
      "iu",
    ).test(sentence)
  ) {
    return true;
  }
  const legalPattern = legalNamePattern(companyName);
  if (
    legalPattern !== null &&
    new RegExp(
      `^\\s*${legalPattern}\\s*['’]s\\s+${ownedProperty}\\b[^.!?]{0,100}\\b${quantitativeNoun}`,
      "iu",
    ).test(sentence)
  ) {
    return true;
  }

  const subject = targetSubjectPattern(companyName);
  const subjectMatch = new RegExp(
    `^\\s*(?:(?:in|as of)\\s+\\d{4}\\s*,\\s*)?${subject}\\b(?:\\.\\s*)?`,
    "iu",
  ).exec(sentence);
  if (subjectMatch === null) return false;
  const predicate = sentence.slice(subjectMatch[0].length);
  if (
    /\b(?:reports?|states?|notes?)\s+that\s+(?:its|our|the)\s+(?:customer|client|parent|partner|supplier|subsidiary|division)\b/iu.test(
      predicate,
    )
  ) {
    return false;
  }
  const targetUsesFirstPerson =
    /^\s*(?:(?:in|as of)\s+\d{4}\s*,\s*)?(?:we|our\s+(?:company|business))\b/iu.test(
      subjectMatch[0],
    );
  const ownedPossessive = targetUsesFirstPerson ? "our" : "its";
  if (sizeKind === "employee_count") {
    return (
      new RegExp(
        `^\\s*(?:(?:currently|presently)\\s+)?(?:employs?|has|have|maintains?)\\s+(?:(?:approximately|about|over|more\\s+than)\\s+)?${quantitativeNoun}`,
        "iu",
      ).test(predicate) ||
      new RegExp(
        `^[^.!?]{0,140}\\b${ownedPossessive}\\s+${ownedProperty}\\b[^.!?]{0,60}\\b${quantitativeNoun}`,
        "iu",
      ).test(predicate)
    );
  }
  return (
    new RegExp(
      `^\\s*(?:(?:currently|presently)\\s+)?(?:has|have|maintains?|operates?|owns?)\\b[^.!?]{0,100}\\b${quantitativeNoun}`,
      "iu",
    ).test(predicate) ||
    new RegExp(
      `^[^.!?]{0,140}\\b${ownedPossessive}\\s+${ownedProperty}\\b[^.!?]{0,100}\\b${quantitativeNoun}`,
      "iu",
    ).test(predicate)
  );
}

function hasTargetRevenueBinding(
  sentence: string,
  companyName: string,
): boolean {
  if (
    /^\s*our\s+(?:(?:company|business)['’]s\s+)?(?:(?:annual|total)\s+)?(?:revenue|annual sales|sales)\b/iu.test(
      sentence,
    )
  ) {
    return true;
  }
  const legalPattern = legalNamePattern(companyName);
  if (
    legalPattern !== null &&
    new RegExp(
      `^\\s*${legalPattern}\\s*['’]s\\s+(?:(?:annual|total)\\s+)?(?:revenue|annual sales|sales)\\b`,
      "iu",
    ).test(sentence)
  ) {
    return true;
  }

  const subject = targetSubjectPattern(companyName);
  const subjectMatch = new RegExp(
    `^\\s*(?:(?:in|as of)\\s+\\d{4}\\s*,\\s*)?${subject}\\b(?:\\.\\s*)?`,
    "iu",
  ).exec(sentence);
  if (subjectMatch === null) return false;

  const targetUsesFirstPerson =
    /^\s*(?:(?:in|as of)\s+\d{4}\s*,\s*)?(?:we|our\s+(?:company|business))\b/iu.test(
      subjectMatch[0],
    );
  const ownedPossessive = targetUsesFirstPerson ? "our" : "its";
  const revenueNoun =
    `(?:${ownedPossessive}\\s+)?` +
    "(?:(?:annual|total)\\s+revenue|revenue|annual sales|sales)";
  const amountInRevenue =
    `(?:approximately\\s+|about\\s+)?\\$\\s*[\\d,.]+\\s*` +
    `(?:m|million|b|billion)\\b\\s+(?:in|of)\\s+${revenueNoun}`;
  const revenueVerb =
    "(?:achiev(?:e|es|ed)|generat(?:e|es|ed)|has|have|post(?:s|ed)?|reach(?:es|ed)?|record(?:s|ed)?|report(?:s|ed)?)";
  const governedRevenuePredicate =
    `(?:currently\\s+|also\\s+)?${revenueVerb}\\s+` +
    `(?:${revenueNoun}|${amountInRevenue})`;
  const predicate = sentence.slice(subjectMatch[0].length).trimStart();
  if (new RegExp(`^${governedRevenuePredicate}\\b`, "iu").test(predicate)) {
    return true;
  }

  const coordinated = new RegExp(
    `(?:,\\s*)?\\band\\s+${governedRevenuePredicate}\\b`,
    "iu",
  ).exec(predicate);
  if (coordinated?.index === undefined) return false;
  const precedingMainClause = predicate.slice(0, coordinated.index).trim();
  if (
    !/^(?:(?:also|currently)\s+)?[a-z]+\b/iu.test(precedingMainClause) ||
    /\b(?:although|because|if|that|when|whereas|which|while|who|whose)\b/iu.test(
      precedingMainClause,
    ) ||
    /\b(?:our|the)\s+(?:customer|client|parent|partner|supplier|subsidiary|division)\b/iu.test(
      precedingMainClause,
    ) ||
    /\b(?:(?:he|it|she|they)\b|[A-Z][A-Za-z0-9&'’.-]*(?:\s+[A-Z][A-Za-z0-9&'’.-]*){0,4})\s+(?:achiev(?:e|es|ed)|am|are|generat(?:e|es|ed)|had|has|have|is|post(?:s|ed)?|reach(?:es|ed)?|record(?:s|ed)?|report(?:s|ed)?|was|were|[a-z]+(?:ed|s))\b/u.test(
      precedingMainClause,
    )
  ) {
    return false;
  }
  return true;
}

function hasTargetHeadquartersBinding(
  sentence: string,
  companyName: string,
): boolean {
  if (/^\s*our\s+(?:headquarters|home office)\b/iu.test(sentence)) {
    return true;
  }
  const legalPattern = legalNamePattern(companyName);
  if (
    legalPattern !== null &&
    new RegExp(
      `^\\s*${legalPattern}\\s*['’]s\\s+(?:headquarters|home office)\\b`,
      "iu",
    ).test(sentence)
  ) {
    return true;
  }
  const subject = targetSubjectPattern(companyName);
  const subjectMatch = new RegExp(
    `^\\s*(?:(?:in|as of)\\s+\\d{4}\\s*,\\s*)?${subject}\\b(?:\\.\\s*)?`,
    "iu",
  ).exec(sentence);
  if (subjectMatch === null) return false;

  const targetUsesFirstPerson =
    /^\s*(?:(?:in|as of)\s+\d{4}\s*,\s*)?(?:we|our\s+(?:company|business))\b/iu.test(
      subjectMatch[0],
    );
  const ownedPossessive = targetUsesFirstPerson ? "our" : "its";
  const predicate = sentence.slice(subjectMatch[0].length);
  if (
    /\b(?:reports?|states?|notes?)\s+that\s+(?:its|our|the)\s+(?:customer|client|parent|partner|supplier|subsidiary|division)\b/iu.test(
      predicate,
    )
  ) {
    return false;
  }
  const ownedHeadquarters =
    `\\b${ownedPossessive}\\s+` +
    `(?:(?:\\d[\\d,]*[-\\s]+square[-\\s]+foot|corporate|global|main|new|worldwide)\\s+)*` +
    "(?:headquarters|home office)\\b";
  const ownedHeadquartersMatch = new RegExp(ownedHeadquarters, "iu").exec(
    predicate,
  );
  if (ownedHeadquartersMatch?.index !== undefined) {
    const antecedent = predicate.slice(0, ownedHeadquartersMatch.index);
    if (
      /\b(?:for|to|with|from|by)\s+(?:its|our|the)\s+(?:customer|client|parent(?:\s+company)?|partner|supplier|subsidiary|division)\b[^.!?]{0,100}$/iu.test(
        antecedent,
      )
    ) {
      return false;
    }
  }
  return (
    new RegExp(
      `^\\s*(?:(?:currently|presently)\\s+)?(?:(?:am|is|are|'re)\\s+headquartered|,\\s*headquartered)\\b`,
      "iu",
    ).test(predicate) ||
    new RegExp(
      `^[^.!?]{0,180}(?:,\\s*|\\band\\s+)(?:am|is|are|'re)\\s+headquartered\\b`,
      "iu",
    ).test(predicate) ||
    ownedHeadquartersMatch !== null
  );
}

function isCurrentHeadquartersStatement(sentence: string): boolean {
  if (
    /\b(?:former(?:ly)?|previously|once|no longer|used to|until|relocated from|moved from)\b/iu.test(
      sentence,
    ) ||
    /\b(?:was|were)\s+headquartered\b/iu.test(sentence)
  ) {
    return false;
  }
  if (
    /\b(?:(?:am|is|are|'re)\s+headquartered|headquarters\s+(?:is|are)|home office\s+(?:is|is located|remains)|our\s+(?:headquarters|home office)\b|,\s*headquartered)\b/iu.test(
      sentence,
    )
  ) {
    return true;
  }
  return /\b(?:our|its)\s+(?:(?:\d[\d,]*[-\s]+square[-\s]+foot|corporate|global|main|new|worldwide)\s+)*(?:headquarters|home office)(?:\s+and\s+(?:(?:our|its|the)\s+)?(?:manufacturing\s+)?(?:facility|plant))?\s+(?:(?:is|are)\s+)?(?:located\s+)?(?:in|at)\b/iu.test(
    sentence,
  );
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&([a-z]+);/giu, (entity, rawName: string) => {
      const decoded = HTML_TEXT_ENTITIES[rawName.toLocaleLowerCase("en-US")];
      return decoded ?? entity;
    })
    .replace(
      /&#(?:x([0-9a-f]+)|([0-9]+));/giu,
      (entity, rawHex: string | undefined, rawDecimal: string | undefined) => {
        const codePoint = Number.parseInt(
          rawHex ?? rawDecimal ?? "",
          rawHex === undefined ? 10 : 16,
        );
        if (
          !Number.isFinite(codePoint) ||
          codePoint < 0 ||
          codePoint > 0x10ffff ||
          (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ) {
          return entity;
        }
        return String.fromCodePoint(codePoint);
      },
    );
}

function normalizePageText(content: string): string {
  return normalizeEvidencePageText(content);
}

interface SignalIdentityPageQuote {
  readonly pageIndex: number;
  readonly quote: string;
}

function signalIdentityPageQuotes(
  content: string,
  pageUrl: string,
  signal: Pick<
    SignalEvidenceSourceSignal,
    "rawName" | "uei" | "cage" | "city" | "state"
  >,
  assessment: SignalIdentityAssessment,
): string[] {
  if (hasThirdPartyProfileContext(content, pageUrl, signal.rawName)) return [];
  const text = normalizePageText(content);
  const sentences = splitPageSentences(text);
  const profileResourcePublisher = hasProfileResourceUrl(pageUrl)
    ? strongTargetHostPublisherExcerpt(
        content,
        pageUrl,
        signal.rawName,
        EVIDENCE_QUOTE_MAX_CHARS,
      )
    : undefined;
  if (profileResourcePublisher === null) return [];
  const publisher =
    profileResourcePublisher ??
    structuredPublisherExcerpt(
      content,
      pageUrl,
      signal.rawName,
      EVIDENCE_QUOTE_MAX_CHARS,
    ) ??
    plainTextPublisherExcerpt(text, signal.rawName, EVIDENCE_QUOTE_MAX_CHARS);
  const corroboration =
    assessment.corroboratedBy === "identifier"
      ? sentences.find(
          (sentence) =>
            (identifierStatementTargetsPublisher(
              sentence,
              signal.rawName,
              "UEI",
            ) &&
              hasLabeledIdentifier(sentence, "UEI", signal.uei)) ||
            (identifierStatementTargetsPublisher(
              sentence,
              signal.rawName,
              "CAGE",
            ) &&
              hasLabeledIdentifier(sentence, "CAGE", signal.cage)),
        )
      : assessment.corroboratedBy === "location"
        ? sentences.find((sentence) =>
            hasExactSignalLocation(sentence, signal.city, signal.state),
          )
        : undefined;
  const excerpts = [publisher, corroboration].filter(
    (excerpt, index, values): excerpt is string =>
      excerpt !== undefined &&
      excerpt !== null &&
      excerpt.trim() !== "" &&
      values.indexOf(excerpt) === index,
  );
  if (
    excerpts.length === 0 ||
    excerpts.some((excerpt) => excerpt.length > EVIDENCE_QUOTE_MAX_CHARS)
  ) {
    return [];
  }
  const combined = excerpts.join("\n");
  return combined.length <= EVIDENCE_QUOTE_MAX_CHARS ? [combined] : excerpts;
}

export function buildSignalIdentityQuote(
  content: string,
  pageUrl: string,
  signal: Pick<
    SignalEvidenceSourceSignal,
    "rawName" | "uei" | "cage" | "city" | "state"
  >,
  assessment: SignalIdentityAssessment,
): string {
  const quotes = signalIdentityPageQuotes(content, pageUrl, signal, assessment);
  return quotes.length === 1 ? (quotes[0] ?? "") : "";
}

function buildSignalIdentityProofQuotes(
  pages: readonly Pick<SafeFetchResult, "content" | "finalUrl">[],
  signal: Pick<
    SignalEvidenceSourceSignal,
    "rawName" | "uei" | "cage" | "city" | "state"
  >,
  assessment: SignalIdentityAssessment,
): SignalIdentityPageQuote[] {
  if (assessment.status !== "verified") return [];
  const proofQuotes = pages.flatMap((page, pageIndex) =>
    signalIdentityPageQuotes(
      page.content,
      page.finalUrl,
      signal,
      assessment,
    ).map((quote) => ({ pageIndex, quote })),
  );
  if (proofQuotes.length === 0) return [];
  const proofAssessment = assessSignalIdentityContent(
    signal,
    proofQuotes.map((proof) => proof.quote),
    proofQuotes.map((proof) => pages[proof.pageIndex]?.finalUrl ?? null),
    false,
  );
  return proofAssessment.status === "verified" &&
    proofAssessment.corroboratedBy === assessment.corroboratedBy
    ? proofQuotes
    : [];
}

function splitPageStatements(text: string): ScopedEvidenceStatement[] {
  return splitScopedEvidenceStatements(normalizePageText(text)).flatMap(
    (statement) =>
      statement.text.length < 10
        ? []
        : splitBoundedStatement(statement.text).map((text) => ({
            text,
            quoted: statement.quoted,
          })),
  );
}

function splitPageSentences(text: string): string[] {
  return splitPageStatements(text).map((statement) => statement.text);
}

function splitBoundedStatement(statement: string): string[] {
  const chunks: string[] = [];
  let remainder = statement;
  while (remainder.length > 1_000) {
    const breakAt = Math.max(remainder.lastIndexOf(" ", 1_000), 500);
    chunks.push(remainder.slice(0, breakAt).trim());
    remainder = remainder.slice(breakAt).trim();
  }
  if (remainder !== "") chunks.push(remainder);
  return chunks;
}

function firstPartyNamedProductQuotes(
  excerpt: string,
  companyName?: string,
  maxQuotes = Number.POSITIVE_INFINITY,
): string[] {
  const productNoun =
    "(?:actuators?|adapt(?:e|o)rs?|accelerometers?|amplifiers?|annunciators?|assembl(?:y|ies)|bearings?|cells?|controllers?|fasteners?|gaskets?|gauges?|indicators?|instruments?|meters?|monitors?|mounts?|pumps?|sensors?|switch(?:es)?|systems?|transducers?|transmitters?|valves?)";
  const explicitTrademarkMark = "(?:Â?[®™])";
  const optionalTrademarkMark = "(?:Â?[®™])?";
  const namedProduct =
    `(?:` +
    `(?:part\\s*(?:number|no\\.?|#)|p\\/?n|sku)\\s*[:#-]?\\s*[A-Z0-9][A-Z0-9._/-]*` +
    `|(?!(?:ISO|SAE|MIL|AS)-?\\d)[A-Z0-9]+-\\d+[A-Z0-9._/-]*\\s+(?:[A-Za-z][A-Za-z0-9-]*\\s+){0,4}${productNoun}` +
    `|[A-Za-z][A-Za-z0-9-]+${explicitTrademarkMark}(?:\\s+[A-Za-z][A-Za-z0-9-]+){0,2}\\s+${productNoun}` +
    `)`;
  const trademarkedProductName =
    `(?!(?:ISO|SAE|MIL|AS)-?\\d\\b)` +
    `[A-Z][A-Z0-9-]{1,}${optionalTrademarkMark}` +
    `(?:\\s+(?:[A-Z][A-Za-z0-9-]+${optionalTrademarkMark}|and|of)){0,4}`;
  const ownedManufacturingClaim = new RegExp(
    `\\bour\\s+(?:new\\s+)?${namedProduct}\\b[^.!?\\n]{0,120}\\b(?:is|are)\\s+(?:designed|developed|engineered|built|made|manufactured|produced)\\b`,
    "iu",
  );
  const manufacturingClaim = new RegExp(
    `\\bwe\\s+(?:design|develop|build|make|manufacture|produce)\\w*\\b(?:[^.!?\\n]{0,180}\\bour\\s+(?:new\\s+)?${namedProduct}\\b|[^.!?\\n]{0,180}\\b${namedProduct}\\b[^.!?\\n]{0,120}\\bour\\s+own\\s+design\\b)`,
    "iu",
  );
  const ownedProductDevelopmentClaim = new RegExp(
    `(?:\\bour\\b[^.!?\\n]{0,80}\\bproduct\\s+updates?\\b[^.!?\\n]{0,180}\\b(?:develop|introduc|redesign|updat)\\w*\\b[^.!?\\n]{0,180}\\bour\\s+(?:new\\s+)?${namedProduct}\\b|\\bwe\\s+(?:develop|introduc|redesign|updat)\\w*\\b[^.!?\\n]{0,120}\\bour\\s+(?:new\\s+)?${namedProduct}\\b)`,
    "iu",
  );
  const proprietaryProductLine = new RegExp(
    `(?:\\bour\\s+proprietary\\s+product\\s+line\\b|\\b(?:we|our\\s+(?:company|corporation)|the\\s+(?:company|corporation))\\s+(?:also\\s+)?(?:has|have|owns?|maintains?|manufactures?|produces?)\\b[^.!?\\n]{0,120}\\bproprietary\\s+product\\s+line\\b)[^.!?\\n]{0,140}\\b(?:registered\\s+)?trademark(?:ed)?(?:\\s+of)?\\s+(?:the\\s+)?${trademarkedProductName}`,
    "iu",
  );
  const firstPartyManufacturedProductLine = new RegExp(
    `(?:\\bour\\s+(?:first\\s+)?manufactured\\s+product\\s+line|\\bwe\\s+(?:acquired|created|developed|introduced|manufacture|own|produce)\\w*\\b[^.!?\\n]{0,100}\\bour\\s+(?:first\\s+)?manufactured\\s+product\\s+line)\\s*[:—–-]\\s*(?:the\\s+)?${namedProduct}\\b`,
    "iu",
  );

  const productStatements = splitPageStatements(excerpt);
  const exactIdentityStatement =
    companyName === undefined
      ? undefined
      : productStatements.find((statement) =>
          containsExactLegalName(statement.text, companyName),
        )?.text;
  const publisherIdentity =
    companyName === undefined
      ? null
      : (publisherIdentityExcerpt(excerpt, companyName) ??
        exactIdentityStatement ??
        null);
  const companySubjects =
    companyName === undefined
      ? []
      : attributableCompanyPatterns(companyName, publisherIdentity);
  const companySubjectPattern =
    companySubjects.length === 0 ? null : `(?:${companySubjects.join("|")})`;
  const manufacturedProductLine =
    companySubjectPattern === null
      ? null
      : new RegExp(
          `\\b${companySubjectPattern}\\s+(?:also\\s+)?(?:acquired|created|developed|introduced|manufactures?|owns?|produces?)\\b[^.!?\\n]{0,120}\\bits\\s+(?:first\\s+)?manufactured\\s+product\\s+line\\s*[:—–-]\\s*(?:the\\s+)?${namedProduct}\\b`,
          "iu",
        );

  const eligibleStatements = productStatements.flatMap((statement, index) => {
    const inheritedThirdPartySpeaker = hasInheritedThirdPartySpeaker(
      statement.text,
      productStatements[index - 1],
    );
    return statement.quoted ||
      inheritedThirdPartySpeaker ||
      hasUnclearOrThirdPartyProductSpeaker(statement.text)
      ? []
      : [{ ...statement, index }];
  });
  const quotes: string[] = [];
  for (const statement of eligibleStatements) {
    const sentence = statement.text;
    if (
      ownedManufacturingClaim.test(sentence) ||
      manufacturingClaim.test(sentence) ||
      ownedProductDevelopmentClaim.test(sentence) ||
      proprietaryProductLine.test(sentence) ||
      firstPartyManufacturedProductLine.test(sentence) ||
      manufacturedProductLine?.test(sentence) === true
    ) {
      if (
        sentence.length <= EVIDENCE_QUOTE_MAX_CHARS &&
        !quotes.includes(sentence)
      ) {
        quotes.push(sentence);
      }
      if (quotes.length >= maxQuotes) return quotes;
    }
  }
  const hasExplicitThirdPartyProductInventoryContext = productStatements.some(
    (statement) =>
      /\b(?:authorized\s+)?distribut(?:or|ion)\s+(?:of|for)\b|\bstocking\s+distributor\b|\bwe\s+(?:also\s+)?(?:carry|distribute|resell|stock)\b|\b(?:brands?|products?)\s+we\s+(?:carry|distribute|resell|stock)\b|\b(?:customer|partner|supplier)[-\s]+products?\b/iu.test(
        statement.text,
      ),
  );

  if (
    companyName !== undefined &&
    companySubjectPattern !== null &&
    !hasExplicitThirdPartyProductInventoryContext
  ) {
    const fullCompanyPattern =
      legalNamePattern(companyName) ?? companySubjectPattern;
    const manufacturerStatements = eligibleStatements.flatMap((statement) => {
      const canonical = canonicalizePublisherSubject(
        statement.text,
        companyName,
        publisherIdentity,
      );
      const targetSubject = `(?:we|our\\s+(?:company|business)|${fullCompanyPattern})`;
      if (
        !new RegExp(
          `^\\s*${targetSubject}\\s+(?:proudly\\s+|currently\\s+)?(?:design|develop|engineer|build|make|manufacture|produce)\\w*(?:\\s*,\\s*(?:and\\s+)?(?:design|develop|engineer|build|make|manufacture|produce|repair|test)\\w*)*\\b`,
          "iu",
        ).test(canonical)
      ) {
        return [];
      }
      const nouns = [
        ...canonical.matchAll(new RegExp(`\\b(${productNoun})\\b`, "giu")),
      ].flatMap((match) => {
        const raw = match[1]?.toLocaleLowerCase("en-US");
        if (raw === undefined) return [];
        if (raw === "assemblies") return ["assembly"];
        if (raw === "switches") return ["switch"];
        return [raw.endsWith("s") ? raw.slice(0, -1) : raw];
      });
      return nouns.length === 0 ? [] : [{ statement: statement.text, nouns }];
    });

    for (const namedStatement of eligibleStatements) {
      if (
        !new RegExp(`\\b${namedProduct}\\b`, "iu").test(namedStatement.text)
      ) {
        continue;
      }
      const namedNouns = [
        ...namedStatement.text.matchAll(
          new RegExp(`\\b(${productNoun})\\b`, "giu"),
        ),
      ].flatMap((match) => {
        const raw = match[1]?.toLocaleLowerCase("en-US");
        if (raw === undefined) return [];
        if (raw === "assemblies") return ["assembly"];
        if (raw === "switches") return ["switch"];
        return [raw.endsWith("s") ? raw.slice(0, -1) : raw];
      });
      const manufacturer = manufacturerStatements.find((candidate) =>
        candidate.nouns.some((noun) => namedNouns.includes(noun)),
      );
      if (manufacturer === undefined) continue;
      const quote = [
        publisherIdentity,
        manufacturer.statement,
        namedStatement.text === manufacturer.statement
          ? null
          : namedStatement.text,
      ]
        .filter((value): value is string => value !== null)
        .filter((value, index, values) => values.indexOf(value) === index)
        .join("\n");
      if (quote.length > EVIDENCE_QUOTE_MAX_CHARS) continue;
      if (!quotes.includes(quote)) quotes.push(quote);
      if (quotes.length >= maxQuotes) return quotes;
    }
  }
  return quotes;
}

export function extractFirstPartyNamedProductQuotes(
  excerpt: string,
  companyName?: string,
): string[] {
  return firstPartyNamedProductQuotes(
    excerpt,
    companyName,
    MAX_NAMED_PRODUCT_EVIDENCE_PER_PAGE,
  );
}

export function isFirstPartyNamedProductEvidence(
  excerpt: string,
  companyName?: string,
): boolean {
  return firstPartyNamedProductQuotes(excerpt, companyName, 1).length > 0;
}

function hasUnclearOrThirdPartyProductSpeaker(sentence: string): boolean {
  if (/^\s*(?:>|["“‘])/u.test(sentence)) return true;
  if (
    /\b(?:our|the)\s+(?:customers?|clients?|suppliers?|partners?)\b[^.!?]{0,120}(?:\b(?:says?|states?|reports?|explains?|notes?)\b|:)[^.!?]{0,40}["“‘]?\s*(?:we|our)\b/iu.test(
      sentence,
    )
  ) {
    return true;
  }
  return /(?:\baccording\s+to\s+[A-Z][^,:.!?]{0,60},|(?:^|[.;]\s*)[A-Z][A-Za-z0-9&'’.-]*(?:\s+[A-Z][A-Za-z0-9&'’.-]*){0,4}\s+(?:says?|states?|reports?|explains?|notes?)\s*:)\s*["“‘]?\s*(?:we|our)\b/u.test(
    sentence,
  );
}

interface AbsoluteRevenueAmount {
  readonly kind: "amount";
  readonly amount: number;
  readonly start: number;
  readonly end: number;
}

interface AbsoluteRevenueRange {
  readonly kind: "range";
  readonly lowerBound: number;
  readonly upperBound: number;
}

type AbsoluteRevenueExpression = AbsoluteRevenueAmount | AbsoluteRevenueRange;

function findAbsoluteRevenueExpression(
  sentence: string,
): AbsoluteRevenueExpression | null {
  const revenueTerms = [
    ...sentence.matchAll(
      /\b(?:(?:annual|total)\s+revenue|revenue|annual sales|sales of)\b/giu,
    ),
  ];
  const currentYear = new Date().getUTCFullYear();
  for (const revenueTerm of revenueTerms) {
    if (revenueTerm.index === undefined) continue;
    const preceding = sentence.slice(
      Math.max(0, revenueTerm.index - 64),
      revenueTerm.index,
    );
    if (
      /\b(?:aim(?:s|ed|ing)?(?:\s+for)?|anticipat(?:e|es|ed|ing)|budget(?:s|ed|ing)?|estimate(?:s|d)?|expect(?:s|ed|ing)?|forecast(?:s|ed|ing)?|plan(?:s|ned|ning)?(?:\s+for)?|project(?:s|ed|ing)?|target(?:s|ed|ing)?)\s*$/iu.test(
        preceding,
      ) ||
      /\b(?:future|prospective|projected|forecast|forecasted|targeted|expected)\s*$/iu.test(
        preceding,
      )
    ) {
      continue;
    }
    if (/\b(?:quarterly|monthly)\s*$/iu.test(preceding)) continue;

    const afterTerm = revenueTerm.index + revenueTerm[0].length;
    const boundary = sentence.slice(afterTerm).search(/[;!?]/u);
    const segmentEnd = boundary === -1 ? sentence.length : afterTerm + boundary;
    const segment = sentence.slice(revenueTerm.index, segmentEnd);
    const revenuePredicate = segment.slice(revenueTerm[0].length);
    let mentionsFutureYear = false;
    for (const match of revenuePredicate.matchAll(/\b(20\d{2})\b/gu)) {
      if (Number(match[1]) > currentYear) {
        mentionsFutureYear = true;
        break;
      }
    }
    if (
      /^\s*(?:(?:is|are|was|were)\s+)?(?:a\s+)?(?:budget|estimate|expectation|forecast|goal|projection|projected|target)\b/iu.test(
        revenuePredicate,
      ) ||
      /^\s*(?:is|are)\s+(?:expected|forecast|forecasted|projected|targeted)\b/iu.test(
        revenuePredicate,
      ) ||
      /^\s*(?:will|would)\b/iu.test(revenuePredicate) ||
      /\b(?:future|next\s+(?:fiscal\s+)?year)\b/iu.test(revenuePredicate) ||
      mentionsFutureYear
    ) {
      continue;
    }
    const rangePredicate =
      /\b(?:between|range[sd]?(?:\s+(?:between|from))?)\b/iu.test(segment);
    if (rangePredicate) {
      const sharedUnitRange =
        /\$\s*([\d,.]+)\s*(?:(m|million|b|billion)\b\s*)?(?:-|–|—|to|and)\s*\$?\s*([\d,.]+)\s*(m|million|b|billion)\b/iu.exec(
          segment,
        );
      if (sharedUnitRange !== null) {
        const first = moneyAmountInMillions(
          sharedUnitRange[1],
          sharedUnitRange[2] ?? sharedUnitRange[4],
        );
        const second = moneyAmountInMillions(
          sharedUnitRange[3],
          sharedUnitRange[4],
        );
        if (first !== null && second !== null) {
          return {
            kind: "range",
            lowerBound: Math.min(first, second),
            upperBound: Math.max(first, second),
          };
        }
      }
    }

    const amountMatches = [
      ...segment.matchAll(/\$\s*([\d,.]+)\s*(m|million|b|billion)\b/giu),
    ];
    for (const amountMatch of amountMatches) {
      if (amountMatch.index === undefined) continue;
      const amount = moneyAmountInMillions(amountMatch[1], amountMatch[2]);
      if (amount === null) continue;
      const bridge = segment.slice(revenueTerm[0].length, amountMatch.index);
      const growthToTotal =
        /\b(?:grew|increased|rose|climbed|jumped|advanced)\b[\s\S]*\bto\s*$/iu.test(
          bridge,
        );
      const deltaOnly =
        /\b(?:grew|increased|rose|climbed|jumped|advanced)\s+(?:by|from)\s*$|\b(?:growth|increase|gain|delta|margin|profit|investment)\s+(?:of|was|is)\s*$/iu.test(
          bridge,
        );
      const absoluteLink =
        /^[\s,:-]*$/u.test(bridge) ||
        /\b(?:am|is|are|was|were|of|at|equals?|total(?:s|ed)?|reached?|hit|stands?\s+at|amounted\s+to|reported|recorded|generated|approximately|about|less\s+than|under|below|fewer\s+than|up\s+to|at\s+most|more\s+than|over|above|greater\s+than|exceed(?:s|ed)?|at\s+least|minimum\s+of|maximum\s+of)\s*$/iu.test(
          bridge,
        );
      if (!growthToTotal && (deltaOnly || !absoluteLink)) continue;
      const start = revenueTerm.index + amountMatch.index;
      return {
        kind: "amount",
        amount,
        start,
        end: start + amountMatch[0].length,
      };
    }

    const beforeTerm = sentence.slice(
      Math.max(0, revenueTerm.index - 100),
      revenueTerm.index,
    );
    const precedingAmount =
      /\$\s*([\d,.]+)\s*(m|million|b|billion)\b\s+(?:in|of)\s*$/iu.exec(
        beforeTerm,
      );
    if (precedingAmount !== null && precedingAmount.index !== undefined) {
      const amount = moneyAmountInMillions(
        precedingAmount[1],
        precedingAmount[2],
      );
      if (amount !== null) {
        const start =
          Math.max(0, revenueTerm.index - 100) + precedingAmount.index;
        return {
          kind: "amount",
          amount,
          start,
          end: start + precedingAmount[0].trimEnd().length,
        };
      }
    }
  }
  return null;
}

function classifyRevenueAmount(
  sentence: string,
  expression: AbsoluteRevenueAmount,
): SizeAssessment {
  const comparison = sentence.slice(
    Math.max(0, expression.start - 45),
    expression.start,
  );
  const suffix = sentence.slice(
    expression.end,
    Math.min(sentence.length, expression.end + 45),
  );
  if (
    /^\s*(?:\+|plus\b)/iu.test(suffix) ||
    /^\s*(?:or\s+(?:more|greater|higher)|and\s+(?:above|up))\b/iu.test(suffix)
  ) {
    return expression.amount >= 50 ? "over_50m" : "unknown";
  }
  if (
    /^\s*(?:or\s+(?:less|fewer|lower)|and\s+(?:below|down))\b/iu.test(suffix)
  ) {
    return expression.amount < 50 ? "under_50m" : "unknown";
  }
  if (/\b(?:not|no)\s+less than\s*$/iu.test(comparison)) {
    return expression.amount >= 50 ? "over_50m" : "unknown";
  }
  if (/\b(?:less than|under|below|fewer than)\s*$/iu.test(comparison)) {
    return expression.amount <= 50 ? "under_50m" : "unknown";
  }
  if (
    /\b(?:up to|at most|(?:not|no) more than|does not exceed|maximum of)\s*$/iu.test(
      comparison,
    )
  ) {
    return expression.amount < 50 ? "under_50m" : "unknown";
  }
  if (
    /\b(?:more than|over|above|greater than|exceeds?|at least|minimum of)\s*$/iu.test(
      comparison,
    )
  ) {
    return expression.amount >= 50 ? "over_50m" : "unknown";
  }
  return expression.amount < 50 ? "under_50m" : "over_50m";
}

function explicitSizeKind(
  sentence: string,
): "revenue" | "employee_count" | "facility_scale" | null {
  if (findAbsoluteRevenueExpression(sentence) !== null) {
    return "revenue";
  }
  if (
    /\b\d[\d,]*\s*(?:employees|associates|team members|staff|people)\b/iu.test(
      sentence,
    )
  ) {
    return "employee_count";
  }
  if (
    /\b(?:\d[\d,]*\s*(?:square feet|sq\.?\s*ft\.?)|\d+\s*acre)\b/iu.test(
      sentence,
    )
  ) {
    return "facility_scale";
  }
  return null;
}
export function classifyExplicitRevenueSize(sentence: string): SizeAssessment {
  if (isHistoricalQuantitativeStatement(sentence)) return "unknown";
  const expression = findAbsoluteRevenueExpression(sentence);
  if (expression === null) return "unknown";
  if (expression.kind === "amount") {
    return classifyRevenueAmount(sentence, expression);
  }
  if (expression.upperBound < 50) return "under_50m";
  if (expression.lowerBound >= 50) return "over_50m";
  return "unknown";
}

function moneyAmountInMillions(
  rawAmount: string | undefined,
  rawUnit: string | undefined,
): number | null {
  if (rawAmount === undefined || rawUnit === undefined) return null;
  const amount = Number(rawAmount.replace(/,/gu, ""));
  if (!Number.isFinite(amount)) return null;
  return /^b/iu.test(rawUnit) ? amount * 1_000 : amount;
}

function revenueKind(
  excerpt: string,
): "revenue" | "employee_count" | "facility_scale" {
  return explicitSizeKind(excerpt) ?? "facility_scale";
}

function sizeIndicatorFromDocument(
  document: PersistedDocument,
): SizeIndicator | null {
  const rawCurrentness = document.metadata["currentness"];
  if (
    rawCurrentness !== "latest_completed_period" &&
    rawCurrentness !== "undated_current"
  ) {
    return null;
  }
  const rawPeriodYear = document.metadata["periodYear"];
  const periodYear =
    typeof rawPeriodYear === "number" && Number.isInteger(rawPeriodYear)
      ? rawPeriodYear
      : null;
  if (rawCurrentness === "latest_completed_period" && periodYear === null) {
    return null;
  }
  return {
    kind: revenueKind(document.quote),
    excerpt: document.quote,
    evidenceId: document.evidenceId,
    periodYear,
    currentness: rawCurrentness,
  };
}

function boundSignalEvidenceText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const prefix = trimmed.slice(0, maxChars);
  const boundary = Math.max(
    prefix.lastIndexOf("."),
    prefix.lastIndexOf("!"),
    prefix.lastIndexOf("?"),
    prefix.lastIndexOf("\n"),
  );
  return (boundary >= Math.floor(maxChars / 2)
    ? prefix.slice(0, boundary + 1)
    : prefix
  ).trim();
}

function extractHeadquarters(sentence: string): {
  readonly city: string | null;
  readonly state: string | null;
  readonly country: string | null;
} | null {
  const headquarters = /\b(?:headquarter(?:ed|s)?|home office)\b/iu.exec(
    sentence,
  );
  if (headquarters === null) return null;
  const governedPrefix = sentence
    .slice(headquarters.index + headquarters[0].length)
    .replace(
      /^\s*(?:and\s+(?:(?:its|our|the)\s+)?(?:manufacturing\s+)?(?:facility|plant))?\s*(?:is|are|'s)?\s*(?:located\s+)?(?:in|at)?\s*/iu,
      "",
    );
  const currentClause =
    governedPrefix.split(
      /\s+\b(?:but|while|(?:and\s+)?serv(?:e|es|ing)|(?:and\s+)?support(?:s|ing)?|and\s+(?:also\s+)?(?:am|are|employs?|has|have|is|maintains?|manufactures?|offers?|operates?|provides?))\b/iu,
    )[0] ?? "";
  const governed = currentClause
    .replace(
      /(?:,\s*|\s+)(?:(?:and|along with)\s+)?(?:with\s+)?(?:(?:its|our|the)\s+)?(?:(?:additional|domestic|global|international|regional|satellite|u\.?s\.?)\s+)*(?:branches?|facilit(?:y|ies)|locations?|offices?|operations?|plants?|sites?)\b[\s\S]*$/iu,
      "",
    )
    .replace(/;\s*[\s\S]*$/u, "")
    .replace(/[.,]\s*$/u, "")
    .trim();
  if (governed === "") return null;

  const explicitUsCountry =
    /\b(?:united states(?: of america)?|u\.s\.a?\.?|usa)\b/iu.test(governed);
  const countryOnly =
    explicitUsCountry &&
    /^(?:the\s+)?(?:united states(?: of america)?|u\.s\.a?\.?|usa)$/iu.test(
      governed,
    );
  if (countryOnly) return { city: null, state: null, country: "US" };

  const parts = governed
    .split(/\s*,\s*/u)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length === 0) return null;
  if (parts.some((part, index) => index < parts.length - 1 && /\band\b/iu.test(part))) {
    return null;
  }
  if (
    explicitUsCountry &&
    /^(?:the\s+)?(?:united states(?: of america)?|u\.s\.a?\.?|usa)$/iu.test(
      parts.at(-1) ?? "",
    )
  ) {
    parts.pop();
  }

  const rawStateCandidate = (parts.at(-1) ?? "").replace(
    /\s+\d{5}(?:-\d{4})?\s*$/u,
    "",
  );
  const stateCandidate = /^d\.?\s*c\.?$/iu.test(rawStateCandidate)
    ? "DC"
    : rawStateCandidate;
  const stateCode = getUsStateCode(stateCandidate);
  if (stateCode !== null) {
    return {
      city: parts.length > 1 ? (parts.at(-2) ?? null) : null,
      state: stateCode.toLocaleUpperCase("en-US"),
      country: "US",
    };
  }
  if (explicitUsCountry) {
    return {
      city: parts.at(-1) ?? null,
      state: null,
      country: "US",
    };
  }
  if (parts.length === 1) {
    return { city: parts[0] ?? null, state: null, country: null };
  }

  const firstPartIsStreetAddress =
    /^\d+\b/u.test(parts[0] ?? "") &&
    /\b(?:avenue|ave|boulevard|blvd|drive|dr|highway|hwy|lane|ln|parkway|pkwy|road|rd|route|street|st|way)\b/iu.test(
      parts[0] ?? "",
    );
  const cityIndex =
    parts.length === 2
      ? 0
      : parts.length === 3 && firstPartIsStreetAddress
        ? 1
        : parts.length - 3;
  return {
    city: parts[cityIndex] ?? null,
    state: null,
    country: parts.at(-1) ?? null,
  };
}
function reconcileHeadquartersFacts(facts: readonly HeadquartersFact[]): {
  readonly status: "supported" | "unknown" | "conflicting";
  readonly headquarters: HeadquartersFact | null;
} {
  if (facts.length === 0) {
    return { status: "unknown", headquarters: null };
  }
  let city: string | null = null;
  let state: string | null = null;
  let country: string | null = null;
  for (const fact of facts) {
    const cityConflicts =
      city !== null &&
      fact.city !== null &&
      HEADQUARTERS_VALUE_COLLATOR.compare(city, fact.city) !== 0;
    const stateConflicts =
      state !== null &&
      fact.state !== null &&
      HEADQUARTERS_VALUE_COLLATOR.compare(state, fact.state) !== 0;
    const countryConflicts =
      country !== null &&
      fact.country !== null &&
      HEADQUARTERS_VALUE_COLLATOR.compare(country, fact.country) !== 0;
    if (cityConflicts || stateConflicts || countryConflicts) {
      return { status: "conflicting", headquarters: null };
    }
    city ??= fact.city;
    state ??= fact.state;
    country ??= fact.country;
  }
  return {
    status: "supported",
    headquarters: { city, state, country },
  };
}

function identityProbeUrls(candidateUrl: string, origin: string): string[] {
  const urls: string[] = [];
  try {
    const candidate = new URL(candidateUrl);
    if (
      (candidate.protocol === "http:" || candidate.protocol === "https:") &&
      candidate.username === "" &&
      candidate.password === ""
    ) {
      candidate.hash = "";
      urls.push(candidate.href);
    }
  } catch {
    // The validated candidate domain still provides bounded fallback probes.
  }
  for (const path of IDENTITY_PAGE_PATHS) {
    const fallback = new URL(path, origin).href;
    if (!urls.includes(fallback)) urls.push(fallback);
  }
  return urls;
}

function extractIdentityPageLinks(
  content: string,
  fetchedUrl: string,
): string[] {
  let base: URL;
  try {
    base = new URL(fetchedUrl);
  } catch {
    return [];
  }
  const links: string[] = [];
  const anchors =
    /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))[^>]*>([\s\S]*?)<\/a\s*>/giu;
  for (const match of content.matchAll(anchors)) {
    const rawHref = match[1] ?? match[2] ?? match[3];
    if (rawHref === undefined || rawHref.trim() === "") continue;
    let url: URL;
    try {
      url = new URL(decodeHtmlEntities(rawHref), base);
    } catch {
      continue;
    }
    if (
      url.origin !== base.origin ||
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== ""
    ) {
      continue;
    }
    const linkText = normalizePageText(match[4] ?? "");
    const descriptor = `${url.pathname} ${url.search} ${linkText}`;
    if (
      !/(?:^|[/_\-\s])(?:about(?:[\s_-]+us)?|contact(?:[\s_-]+us)?|company|history|our[\s_-]+(?:company|story)|who[\s_-]+we[\s_-]+are)(?:$|[/_.?&=\-\s])/iu.test(
        descriptor,
      )
    ) {
      continue;
    }
    url.hash = "";
    if (!links.includes(url.href)) links.push(url.href);
  }
  return links;
}

function domainOrigin(urlValue: string, fallbackDomain: string): string | null {
  try {
    const withScheme = /^https?:\/\//iu.test(urlValue)
      ? urlValue
      : `https://${fallbackDomain}/`;
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function emptySummary(skipped: string | null): SignalEvidenceResearchSummary {
  return {
    claimed: 0,
    completed: 0,
    retryableFailures: 0,
    deferred: 0,
    ambiguous: 0,
    noFinding: 0,
    costUsd: 0,
    skipped,
  };
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        const value = values[index];
        if (value !== undefined) results[index] = await worker(value);
      }
    }),
  );
  return results;
}
