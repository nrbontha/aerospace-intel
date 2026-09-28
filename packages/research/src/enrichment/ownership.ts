import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import { getDatabase, type Database } from "@asi/database/client";
import { normalizeUnifiedName } from "@asi/database";

import {
  ExaApiKeyMissingError,
  ExaSearchClient,
  ExaSearchError,
  type ExaSearchErrorCode,
  type ExaSearchResult,
} from "../search/exa.js";
import {
  isRetryableSafeFetchError,
  safeFetchUrl,
  SafeFetchError,
  type SafeFetchResult,
} from "../safe-fetch.js";
import {
  canSpendExa,
  EXA_SEARCH_COST_USD,
  recordExaSpendUsd,
} from "./exa-budget.js";
import { resolveDocumentId, resolveExaSourceId } from "./exa-persist.js";
import {
  normalizeEvidencePageText,
  splitEvidenceSentences,
} from "./website.js";

/**
 * Acquisition/ownership discovery with retrieved-source confirmation.
 *
 * Exa snippets only identify pages to inspect. An affirmative acquired, PE,
 * public-parent or dead finding requires a successful safe fetch whose actual
 * content names the target and contains the quoted ownership statement.
 * Search, retrieval and classification are side-effect free; the legacy
 * scheduler explicitly persists only confirmed findings after classification.
 *
 * Provider, budget and configuration failures remain distinct from a completed
 * search with no evidence. Conflicting statuses or named owners resolve to
 * unknown, and absence of acquisition evidence never implies independence.
 */

export type AcquisitionStatus =
  "acquired" | "pe_owned" | "public_parent" | "dead" | "unknown";

export interface AcquisitionHistoryResult {
  readonly status: AcquisitionStatus;
  readonly owner: string | null;
  readonly year: number | null;
  readonly excerpt: string | null;
  readonly sourceUrl: string | null;
  readonly sourceContentSha256: string | null;
  readonly sourceRetrievedAt: string | null;
  readonly costUsd: number;
}

export type AcquisitionResearchOutcomeKind =
  | "affirmative"
  | "no_evidence"
  | "retryable_error"
  | "provider_error"
  | "budget_limited"
  | "configuration_error";

export interface AcquisitionCheckedSource {
  readonly url: string;
  readonly outcome: "retrieved" | "unreachable" | "identity_mismatch";
  readonly contentSha256: string | null;
  readonly retrievedAt: string | null;
}

export interface AcquisitionResearchOutcome {
  readonly outcome: AcquisitionResearchOutcomeKind;
  readonly finding: AcquisitionHistoryResult;
  readonly checkedSources: readonly AcquisitionCheckedSource[];
  readonly errorCode: ExaSearchErrorCode | SafeFetchError["code"] | null;
}

export interface ResearchAcquisitionHistoryOptions {
  readonly client?: Pick<ExaSearchClient, "search"> | undefined;
  readonly fetchUrl?: typeof safeFetchUrl | undefined;
}

/** Scheduler cap: at most this many ownership checks per tick. */
export const OWNERSHIP_CHECK_TICK_CAP = 10;

const EXCERPT_MAX_CHARS = 500;
const OWNER_MAX_CHARS = 120;
const MAX_SNIPPETS = 3;

const LEGAL_SUFFIX_RE =
  /\s+(llc|inc|corp|corporation|incorporated|co|company|ltd|limited|lp|llp|pllc|plc|gmbh|pa|pc)\.?$/i;

const ACQUIRE_RE = /acquir|acquisit/i;
const PE_SIGNAL_RE =
  /private[\s-]?equity|portfolio company|buyout|backed by|investment firm|venture capital/i;
const PUBLIC_SIGNAL_RE =
  /nasdaq|nyse|publicly[\s-]?traded|public company|stock exchange|\bticker\b|s&p 500/i;
const DEAD_SIGNAL_RE =
  /ceased (all )?operations|shut\s?down|went out of business|\bdefunct\b|was dissolved|liquidat(?:ed|ion)|wound down|closed (its doors|permanently)|no longer operates|out of business/i;
const YEAR_RE = /\b(19[89]\d|20[0-2]\d)\b/;

const OWNER_PHRASE = "([A-Z][\\w'’&.,-]*(?:\\s+(?:[A-Z][\\w'’&.,-]*|&)){0,5})";
const PASSIVE_ACQUIRED_BY_OWNER_PATTERNS: readonly RegExp[] = [
  new RegExp(`acquired\\s+by\\s+${OWNER_PHRASE}`, "i"),
];
const ACTIVE_ACQUISITION_OWNER_PATTERNS: readonly RegExp[] = [
  new RegExp(`acquisition\\b[^.;]{0,120}?\\bby\\s+${OWNER_PHRASE}`, "i"),
  new RegExp(`${OWNER_PHRASE}\\s+(?:has|have)\\s+acquired\\b`, "i"),
  new RegExp(`${OWNER_PHRASE}\\s+acquired\\b`, "i"),
  new RegExp(`${OWNER_PHRASE}\\s+acquires\\b`, "i"),
  new RegExp(
    `${OWNER_PHRASE}\\s+(?:has\\s+|have\\s+)?(?:complet(?:e|es|ed)(?:\\s+its)?\\s+|announc(?:e|es|ed)(?:\\s+its)?\\s+|clos(?:e|es|ed)(?:\\s+its)?\\s+)?(?:the\\s+)?acquisition\\b`,
    "i",
  ),
];
const RELATIONSHIP_OWNER_PATTERNS: readonly RegExp[] = [
  new RegExp(`(?:subsidiary|division|unit)\\s+of\\s+${OWNER_PHRASE}`, "i"),
  new RegExp(`(?:wholly[-\\s]?\\s*)?owned\\s+by\\s+${OWNER_PHRASE}`, "i"),
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanCompanyName(name: string): string {
  return name
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(LEGAL_SUFFIX_RE, "")
    .trim();
}

function identityTokens(name: string): string[] {
  return cleanCompanyName(name)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
}

function companyMentionPattern(companyName: string): string | null {
  const tokens = cleanCompanyName(companyName).match(/[a-z0-9]+/gu);
  if (tokens === null || tokens.join("").length < 4) return null;
  return `${tokens.map(escapeRegExp).join("[^a-z0-9]+")}(?:[^a-z0-9]+(?:llc|inc|corp|corporation|incorporated|co|company|ltd|limited|lp|llp|pllc|plc|gmbh|pa|pc)\\.?)?`;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Identity gate: the snippet (title + text) must mention this company, or
 * the result URL must belong to its domain. Word-boundary matching so short
 * tokens (e.g. "ami") cannot match inside unrelated words.
 */
function passesIdentityGate(
  snippet: string,
  companyName: string,
  domain: string | undefined,
  url: string,
): boolean {
  const hay = snippet.toLowerCase();
  const cleaned = cleanCompanyName(companyName);
  if (cleaned.length >= 4) {
    const full = new RegExp(`\\b${escapeRegExp(cleaned)}\\b`);
    if (full.test(hay)) return true;
  }
  const tokens = identityTokens(companyName);
  if (
    tokens.length > 0 &&
    tokens.every((token) =>
      new RegExp(`\\b${escapeRegExp(token)}\\b`).test(hay),
    )
  ) {
    return true;
  }
  if (domain !== undefined) {
    const host = hostOf(url);
    const normalizedDomain = domain.toLowerCase().replace(/^www\./, "");
    if (
      host !== null &&
      (host === normalizedDomain || host.endsWith(`.${normalizedDomain}`))
    ) {
      return true;
    }
  }
  return false;
}

function cleanOwner(raw: string, companyName: string): string | null {
  const normalized = raw
    .replace(/[.,;:'"]+$/g, "")
    .trim()
    .replace(/\s+/g, " ");
  if (/^(?:private\s+)?investors?\b/iu.test(normalized)) return null;
  let ownerCandidate = normalized.replace(
    /\s+(?:in\s+order\s+to|so\s+as\s+to|with\s+(?:plans?|the\s+intent|the\s+goal)\s+to|as\s+part\s+of|committed\s+to|focused\s+on|aimed\s+at|intended\s+to|to)(?=\s|$)[\s\S]*$/iu,
    "",
  );
  if (
    /^(?:successful\s+)?(?:completion|closing|announcement)\s+of(?=\s|$)/iu.test(
      ownerCandidate,
    )
  ) {
    const buyerClause = /\s+and\s+(?=[A-Z0-9])/iu.exec(ownerCandidate);
    ownerCandidate =
      buyerClause === null
        ? ""
        : ownerCandidate.slice(buyerClause.index + buyerClause[0].length);
  }
  const namedSpan =
    /^[A-Z0-9][\w'’&.,-]*(?:\s+(?:(?:and|of|the|&)\s+)?[A-Z0-9][\w'’&.,-]*){0,5}/u.exec(
      ownerCandidate,
    )?.[0] ?? "";
  const owner = namedSpan
    .replace(/[.,;:'"]+$/g, "")
    .replace(/\s+(?:in|on|as of)$/i, "")
    .replace(/\s+(completes?|announces?|closes?|has|have)$/i, "")
    .replace(/['’]s$/u, "");
  if (owner.length === 0 || owner.length > OWNER_MAX_CHARS) return null;
  if (owner.toLowerCase() === cleanCompanyName(companyName)) return null;
  if (/^(?:a|an|its|their|this|that)\b|^the$/iu.test(owner)) return null;
  return owner;
}

const NEGATED_ACQUISITION_PREFIX_RE =
  /\b(?:has|have|had|do|does|did|is|are|was|were|be|been)(?:\s+[\p{L}-]+){0,2}\s+(?:not(?!\s+only\b)|never)(?:\s+[\p{L}-]+){0,2}\s*$/iu;
const CONTRACTED_NEGATED_ACQUISITION_PREFIX_RE =
  /\b(?:hasn|haven|hadn|don|doesn|didn|isn|aren|wasn|weren)['’]t(?:\s+[\p{L}-]+){0,2}\s*$/iu;
const DIRECT_ACQUISITION_DENIAL_PREFIX_RE =
  /\b(?:(?:no|not(?!\s+only\b))\s+(?:an?|the|any)|never|(?:deny|denies|denied|dispute|disputes|disputed|reject|rejects|rejected|abandon|abandons|abandoned)\s+(?:an?|the|any)?|without|rather\s+than)\s*$/iu;
const POSSESSIVE_ACQUISITION_DENIAL_PREFIX_RE =
  /\b(?:[Dd]eny|[Dd]enies|[Dd]enied|[Dd]ispute|[Dd]isputes|[Dd]isputed|[Rr]eject|[Rr]ejects|[Rr]ejected)\s+(?:the\s+)?[A-Z0-9][\w'’&.,-]*(?:\s+(?:(?:and|of|the|&)\s+)?[A-Z0-9][\w'’&.,-]*){0,5}['’]s\s*$/u;
const PROPOSED_ACQUISITION_PREFIX_RE =
  /\b(?:(?:plan(?:s|ned|ning)?|intend(?:s|ed)?|propose(?:s|d)?|seek(?:s|ing|sought)?|expect(?:s|ed)?|aim(?:s|ed)?|agree(?:s|d)?|offer(?:s|ed)?|attempt(?:s|ed)?|try|tries|tried|hope(?:s|d)?|fail(?:s|ed)?|decide(?:s|d)?|prepare(?:s|d)?|move(?:s|d)?|set|scheduled|agreement|offer|bid|proposal)\s+to|(?:may|might|could|would|will|shall|should|can)(?:\s+have)?|potential|possible|proposed|planned|pending|prospective|contemplated)\s*$/iu;
const BARE_BUYER_TO_ACQUIRE_PREFIX_RE =
  /^\s*(?:[A-Z0-9][\w'’&.,-]*|&)(?:\s+(?:[A-Z0-9][\w'’&.,-]*|&|of|the)){0,7}\s+to\s*$/u;
const CONDITIONAL_ACQUISITION_SUFFIX_RE =
  /^\s*(?:[,;]\s*)?(?:if|unless|provided(?:\s+that)?|subject\s+to|pending)\b/iu;
const UNFINISHED_ACQUISITION_SUFFIX_RE =
  /^\s*(?:[,;]\s*)?(?:(?:(?:is|was)\s+)?(?:expected|planned|proposed)\s+to|(?:will|would|may|might|could|should)\b)/iu;

function isAffirmativeAcquisitionPredicate(
  sentence: string,
  predicateStart: number,
  predicateEnd: number,
): boolean {
  const prefix = sentence.slice(0, predicateStart);
  if (
    NEGATED_ACQUISITION_PREFIX_RE.test(prefix) ||
    CONTRACTED_NEGATED_ACQUISITION_PREFIX_RE.test(prefix) ||
    DIRECT_ACQUISITION_DENIAL_PREFIX_RE.test(prefix) ||
    POSSESSIVE_ACQUISITION_DENIAL_PREFIX_RE.test(prefix) ||
    PROPOSED_ACQUISITION_PREFIX_RE.test(prefix) ||
    BARE_BUYER_TO_ACQUIRE_PREFIX_RE.test(prefix)
  ) {
    return false;
  }

  const clauseStart = Math.max(
    prefix.lastIndexOf("."),
    prefix.lastIndexOf(";"),
    prefix.lastIndexOf(":"),
    prefix.lastIndexOf("!"),
    prefix.lastIndexOf("?"),
  );
  if (
    /^\s*(?:if|unless|whether|should|in\s+the\s+event\s+that)\b/iu.test(
      prefix.slice(clauseStart + 1),
    )
  ) {
    return false;
  }

  const suffix = sentence.slice(predicateEnd);
  return (
    !CONDITIONAL_ACQUISITION_SUFFIX_RE.test(suffix) &&
    !UNFINISHED_ACQUISITION_SUFFIX_RE.test(suffix)
  );
}

interface SentenceVote {
  status: Exclude<AcquisitionStatus, "unknown">;
  owner: string | null;
  sentence: string;
}

export function classifySentence(
  sentence: string,
  companyName: string,
): SentenceVote | null {
  const companyPattern = companyMentionPattern(companyName);
  if (companyPattern === null) return null;
  const companySubject = new RegExp(
    `^\\s*(?:(?:in|as of)\\s+\\d{4}\\s*,\\s*)?${companyPattern}(?=\\s*(?:$|[,;:]|\\b(?:is|are|was|were|has|had|became|remains|ceased|shut|went|closed|acquired|no longer|dissolved|liquidated)\\b))`,
    "iu",
  ).exec(sentence);
  const subjectTail =
    companySubject === null
      ? ""
      : sentence.slice(companySubject.index + companySubject[0].length);
  const companyAcquiredBy =
    companySubject !== null &&
    /^[\s,()—-]{0,20}(?:is|are|was|were|has(?:\s+recently)?\s+been|had\s+been)?\s*acquired\s+by\b/iu.test(
      subjectTail,
    );
  const companyRelationship =
    companySubject !== null &&
    /^[\s,()—-]{0,20}(?:is|are|became|remains)\s+(?:a\s+)?(?:(?:subsidiary|division|unit)\s+of|(?:wholly[-\s]?\s*)?owned\s+by)\b/iu.test(
      subjectTail,
    );
  const completeTargetBoundary =
    "(?=\\s*(?:$|[.,;:()—-]|\\b(?:in|on|from|for|as|but)\\b))";
  const companyAcquisitionNoun = new RegExp(
    `\\bacquisition\\s+of\\s+(?:the\\s+)?${companyPattern}${completeTargetBoundary}`,
    "iu",
  ).exec(sentence);
  const companyAcquisitionVerb = new RegExp(
    `\\bacquir(?:e|es|ed|ing)\\s+(?:the\\s+)?${companyPattern}${completeTargetBoundary}`,
    "iu",
  ).exec(sentence);
  const companyAcquisitionObject =
    (companyAcquisitionNoun !== null &&
      isAffirmativeAcquisitionPredicate(
        sentence,
        companyAcquisitionNoun.index,
        companyAcquisitionNoun.index + companyAcquisitionNoun[0].length,
      )) ||
    (companyAcquisitionVerb !== null &&
      isAffirmativeAcquisitionPredicate(
        sentence,
        companyAcquisitionVerb.index,
        companyAcquisitionVerb.index + companyAcquisitionVerb[0].length,
      ));
  const acquired = ACQUIRE_RE.test(sentence);
  const companyDead =
    companySubject !== null &&
    DEAD_SIGNAL_RE.test(subjectTail.split(/[;.!?]/u)[0] ?? "");
  if (companyDead && acquired) return null;
  if (companyDead) return { status: "dead", owner: null, sentence };
  if (!companyAcquiredBy && !companyRelationship && !companyAcquisitionObject) {
    return null;
  }

  const ownerPatterns = companyAcquiredBy
    ? PASSIVE_ACQUIRED_BY_OWNER_PATTERNS
    : companyRelationship
      ? RELATIONSHIP_OWNER_PATTERNS
      : ACTIVE_ACQUISITION_OWNER_PATTERNS;
  let owner: string | null = null;
  for (const pattern of ownerPatterns) {
    const match = pattern.exec(sentence);
    if (match?.[1] !== undefined) {
      owner = cleanOwner(match[1], companyName);
      if (owner !== null) break;
    }
  }
  if (owner === null) {
    if (
      companyAcquiredBy &&
      /\bacquired\s+by\s+(?:["“][^"”\n]{1,80}["”]\s+)?(?:private\s+)?investors?\b/iu.test(
        subjectTail,
      )
    ) {
      return { status: "acquired", owner: null, sentence };
    }
    if (companyAcquisitionObject) {
      return { status: "acquired", owner: null, sentence };
    }
    return null;
  }
  if (PE_SIGNAL_RE.test(sentence)) {
    return { status: "pe_owned", owner, sentence };
  }
  if (PUBLIC_SIGNAL_RE.test(sentence)) {
    return { status: "public_parent", owner, sentence };
  }
  return { status: "acquired", owner, sentence };
}

function extractYear(text: string): number | null {
  const match = YEAR_RE.exec(text);
  if (match?.[1] === undefined) return null;
  const year = Number(match[1]);
  const currentYear = new Date().getUTCFullYear();
  if (year < 1980 || year > currentYear + 1) return null;
  return year;
}

function completeExcerpt(sentence: string): string | null {
  const excerpt = sentence.replace(/\s+/g, " ").trim();
  return excerpt.length <= EXCERPT_MAX_CHARS ? excerpt : null;
}

/**
 * Search is discovery only. An affirmative ownership/death result is returned
 * only after the cited page itself is safely retrieved and the target identity
 * and ownership sentence are both present in that retrieved content.
 *
 * This function never writes canonical company, ownership or unified-target
 * rows. Provider/configuration/budget failures are distinct from a successful
 * search with no finding so callers can durably retry the former.
 */
export async function researchAcquisitionHistory(
  apiKey: string,
  companyName: string,
  _domain?: string,
  options: ResearchAcquisitionHistoryOptions = {},
): Promise<AcquisitionResearchOutcome> {
  const unknown = emptyAcquisitionResult();
  const name = companyName.trim();
  if (apiKey.trim().length === 0 || name.length === 0) {
    return {
      outcome: "configuration_error",
      finding: unknown,
      checkedSources: [],
      errorCode: null,
    };
  }
  if (!canSpendExa(EXA_SEARCH_COST_USD)) {
    return {
      outcome: "budget_limited",
      finding: unknown,
      checkedSources: [],
      errorCode: null,
    };
  }

  const client = options.client ?? new ExaSearchClient({ apiKey });
  let results: readonly ExaSearchResult[];
  try {
    results = await client.search(
      `"${name}" acquired by OR acquisition OR acquired OR dissolved`,
    );
  } catch (error) {
    return {
      outcome:
        error instanceof ExaApiKeyMissingError
          ? "configuration_error"
          : error instanceof ExaSearchError && !error.transient
            ? "provider_error"
            : "retryable_error",
      finding: unknown,
      checkedSources: [],
      errorCode: error instanceof ExaSearchError ? error.code : null,
    };
  }
  recordExaSpendUsd(EXA_SEARCH_COST_USD);
  const costUsd = EXA_SEARCH_COST_USD;
  const fetchUrl = options.fetchUrl ?? safeFetchUrl;
  const checkedSources: AcquisitionCheckedSource[] = [];
  const votes: Array<
    SentenceVote & {
      url: string;
      contentSha256: string;
      retrievedAt: string;
    }
  > = [];
  let retrievalFailure: SafeFetchError["code"] | null = null;

  for (const result of results.slice(0, MAX_SNIPPETS)) {
    let fetched: SafeFetchResult;
    try {
      fetched = await fetchUrl(result.url);
    } catch (error) {
      const code =
        error instanceof SafeFetchError ? error.code : "network_error";
      if (isRetryableSafeFetchError(error)) {
        retrievalFailure ??= code;
      }
      checkedSources.push({
        url: result.url,
        outcome: "unreachable",
        contentSha256: null,
        retrievedAt: null,
      });
      continue;
    }
    const pageText = normalizeEvidencePageText(fetched.content);
    if (!passesIdentityGate(pageText, name, undefined, fetched.finalUrl)) {
      checkedSources.push({
        url: fetched.finalUrl,
        outcome: "identity_mismatch",
        contentSha256: fetched.contentSha256,
        retrievedAt: fetched.retrievedAt,
      });
      continue;
    }
    checkedSources.push({
      url: fetched.finalUrl,
      outcome: "retrieved",
      contentSha256: fetched.contentSha256,
      retrievedAt: fetched.retrievedAt,
    });
    for (const sentence of splitEvidenceSentences(pageText)) {
      const vote = classifySentence(sentence, name);
      if (vote !== null) {
        votes.push({
          ...vote,
          url: fetched.finalUrl,
          contentSha256: fetched.contentSha256,
          retrievedAt: fetched.retrievedAt,
        });
      }
    }
  }

  if (votes.length === 0) {
    return {
      outcome: retrievalFailure === null ? "no_evidence" : "retryable_error",
      finding: { ...unknown, costUsd },
      checkedSources,
      errorCode: retrievalFailure,
    };
  }

  const first = votes[0];
  if (first === undefined) {
    return {
      outcome: "no_evidence",
      finding: { ...unknown, costUsd },
      checkedSources,
      errorCode: null,
    };
  }
  const statuses = new Set(votes.map((vote) => vote.status));
  const owners = new Set(
    votes
      .map((vote) => vote.owner)
      .filter((owner): owner is string => owner !== null),
  );
  if (statuses.size !== 1 || (first.status !== "dead" && owners.size !== 1)) {
    return {
      outcome: retrievalFailure === null ? "no_evidence" : "retryable_error",
      finding: { ...unknown, costUsd },
      checkedSources,
      errorCode: retrievalFailure,
    };
  }

  const owner = first.status === "dead" ? null : ([...owners][0] ?? null);
  if (first.status !== "dead" && owner === null) {
    return {
      outcome: "no_evidence",
      finding: { ...unknown, costUsd },
      checkedSources,
      errorCode: null,
    };
  }

  let proof: (typeof votes)[number] | undefined;
  let excerpt: string | null = null;
  for (const vote of votes) {
    if (
      vote.status !== first.status ||
      (vote.status !== "dead" && vote.owner !== owner)
    ) {
      continue;
    }
    const candidateExcerpt = completeExcerpt(vote.sentence);
    if (candidateExcerpt === null) continue;
    proof = vote;
    excerpt = candidateExcerpt;
    break;
  }
  if (proof === undefined || excerpt === null) {
    return {
      outcome: retrievalFailure === null ? "no_evidence" : "retryable_error",
      finding: { ...unknown, costUsd },
      checkedSources,
      errorCode: retrievalFailure,
    };
  }

  return {
    outcome: "affirmative",
    finding: {
      status: proof.status,
      owner,
      year: extractYear(excerpt),
      excerpt,
      sourceUrl: proof.url,
      sourceContentSha256: proof.contentSha256,
      sourceRetrievedAt: proof.retrievedAt,
      costUsd,
    },
    checkedSources,
    errorCode: null,
  };
}

function emptyAcquisitionResult(): AcquisitionHistoryResult {
  return {
    status: "unknown",
    owner: null,
    year: null,
    excerpt: null,
    sourceUrl: null,
    sourceContentSha256: null,
    sourceRetrievedAt: null,
    costUsd: 0,
  };
}

// ownership_type has no PE/public/dead variants: any named-owner finding is
// recorded as a subsidiary relationship, with the truth in owner_name.
const OBSERVATION_TYPE = "subsidiary";

function unifiedStatusFor(status: AcquisitionStatus): string {
  switch (status) {
    case "acquired":
      return "strategic_owned";
    case "pe_owned":
      return "pe_owned";
    case "public_parent":
      return "public";
    case "dead":
      return "dead";
    case "unknown":
      return "unknown";
  }
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Explicit legacy projection persistence. Search/classification stays pure;
 * scheduler callers choose when to update canonical company projections.
 * Persistence failures propagate so a successful check is never reported
 * while its evidence write silently failed.
 */
async function persistAffirmativeFinding(
  db: Database,
  companyName: string,
  result: AcquisitionHistoryResult,
): Promise<void> {
  if (
    result.status === "unknown" ||
    result.sourceUrl === null ||
    result.excerpt === null
  ) {
    return;
  }
  const companyKey = companyName.replace(/\s+/g, " ").trim().toLowerCase();
  const normalized = normalizeUnifiedName(companyName);

  const companyRows = await db.execute<{ id: string }>(sql`
    SELECT id FROM companies
    WHERE lower(legal_name) = ${companyKey} OR lower(display_name) = ${companyKey}
    LIMIT 1
  `);
  const companyId = companyRows.rows[0]?.id ?? null;

  if (companyId !== null && result.owner !== null && result.status !== "dead") {
    const sourceId = await resolveExaSourceId(db, "news");
    if (sourceId === null) {
      throw new Error("Unable to persist Exa acquisition source");
    }
    const documentId = await resolveDocumentId(db, {
      sourceId,
      url: result.sourceUrl,
      title: `Acquisition source: ${companyName}`,
      documentType: "news",
      contentHash:
        result.sourceContentSha256 ??
        sha256Hex(`${result.sourceUrl}\u0000${result.excerpt}`),
      metadataJson: JSON.stringify({
        companyName,
        method: "verified_acquisition_source_v2",
        retrievedAt: result.sourceRetrievedAt,
      }),
    });
    if (documentId === null) {
      throw new Error("Unable to persist acquisition source document");
    }
    const evidenceRows = await db.execute<{ id: string }>(sql`
      INSERT INTO evidence
        (source_document_id, quote, locator, extraction_method, content_sha256, metadata)
      VALUES (
        ${documentId},
        ${result.excerpt},
        ${result.sourceUrl},
        'verified_acquisition_source_v2',
        ${sha256Hex(result.excerpt)},
        ${JSON.stringify({ companyName, owner: result.owner, year: result.year })}::jsonb
      )
      RETURNING id
    `);
    const evidenceId = evidenceRows.rows[0]?.id;
    if (evidenceId === undefined) {
      throw new Error("Unable to persist acquisition evidence");
    }
    await db.execute(sql`
      INSERT INTO ownership_observations
        (company_id, type, owner_name, confidence, evidence_id, valid_from)
      VALUES (
        ${companyId},
        ${OBSERVATION_TYPE}::ownership_type,
        ${result.owner},
        ${result.year !== null ? 0.8 : 0.7},
        ${evidenceId},
        ${result.year !== null ? `${result.year}-01-01` : null}
      )
    `);
  }

  await db.execute(sql`
    UPDATE unified_targets
    SET ownership_status = ${unifiedStatusFor(result.status)},
        evidence_urls = (
          SELECT COALESCE(jsonb_agg(DISTINCT e), '[]'::jsonb)
          FROM jsonb_array_elements_text(
            COALESCE(unified_targets.evidence_urls, '[]'::jsonb) || ${JSON.stringify([result.sourceUrl])}::jsonb
          ) AS e
        ),
        updated_at = now()
    WHERE normalized_name = ${normalized}
  `);
}

export interface OwnershipCheckCandidate {
  readonly companyName: string;
  readonly domain: string | null;
}

export interface OwnershipCheckOptions {
  /** Max names to check; clamped to OWNERSHIP_CHECK_TICK_CAP. */
  readonly limit?: number;
  /** Defaults to process.env.EXA_API_KEY (never logged). */
  readonly exaApiKey?: string;
}

export interface OwnershipCheckSummary {
  readonly checked: number;
  readonly affirmed: number;
  readonly skipped: string | null;
  readonly costUsd: number;
}

/** Research-queue / P1 names still lacking ownership evidence, oldest-touched first. */
export async function selectOwnershipCheckCandidates(
  db: Database,
  limit: number,
): Promise<OwnershipCheckCandidate[]> {
  const capped = Math.max(0, Math.min(limit, OWNERSHIP_CHECK_TICK_CAP));
  if (capped === 0) return [];
  const result = await db.execute<{
    company_name: string;
    domain: string | null;
  }>(sql`
    SELECT company_name, domain
    FROM unified_targets
    WHERE (
        tier IN ('needs_research', 'evaluate', 'high_interest')
        OR investor_priority = 1
      )
      AND (ownership_status IS NULL OR ownership_status = 'unknown')
    ORDER BY updated_at ASC NULLS FIRST
    LIMIT ${capped}
  `);
  return result.rows.map((row) => ({
    companyName: row.company_name,
    domain: row.domain,
  }));
}

/**
 * Batch ownership sweep for the scheduler tick: research queue + P1 names
 * lacking ownership evidence, cap OWNERSHIP_CHECK_TICK_CAP/tick, stops early
 * when the EXA_DAILY_BUDGET_USD cap is reached. Never throws.
 */
export async function runOwnershipChecks(
  db: Database = getDatabase(),
  opts: OwnershipCheckOptions = {},
): Promise<OwnershipCheckSummary> {
  try {
    const apiKey = opts.exaApiKey ?? process.env["EXA_API_KEY"] ?? "";
    if (apiKey.trim().length === 0) {
      return {
        checked: 0,
        affirmed: 0,
        skipped: "missing_exa_api_key",
        costUsd: 0,
      };
    }
    const candidates = await selectOwnershipCheckCandidates(
      db,
      opts.limit ?? OWNERSHIP_CHECK_TICK_CAP,
    );
    let checked = 0;
    let affirmed = 0;
    let costUsd = 0;
    let skipped: string | null =
      candidates.length === 0 ? "no_candidates" : null;
    for (const candidate of candidates) {
      if (!canSpendExa(EXA_SEARCH_COST_USD)) {
        skipped = "budget_exhausted";
        break;
      }
      const research = await researchAcquisitionHistory(
        apiKey,
        candidate.companyName,
        candidate.domain ?? undefined,
      );
      const outcome = research.finding;
      checked += 1;
      costUsd += outcome.costUsd;
      if (research.outcome === "affirmative") {
        await persistAffirmativeFinding(db, candidate.companyName, outcome);
        affirmed += 1;
      } else if (
        research.outcome === "budget_limited" ||
        research.outcome === "configuration_error"
      ) {
        skipped =
          research.outcome === "budget_limited"
            ? "budget_exhausted"
            : "missing_exa_api_key";
        break;
      } else if (
        research.outcome === "retryable_error" ||
        research.outcome === "provider_error"
      ) {
        skipped = "provider_error";
        break;
      } else {
        const normalized = normalizeUnifiedName(candidate.companyName);
        await db.execute(sql`
          UPDATE unified_targets SET updated_at = now()
          WHERE normalized_name = ${normalized}
        `);
      }
    }
    return { checked, affirmed, skipped, costUsd };
  } catch {
    return { checked: 0, affirmed: 0, skipped: "error", costUsd: 0 };
  }
}
