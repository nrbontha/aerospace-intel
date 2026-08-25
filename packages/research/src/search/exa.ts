import { z } from "zod";

const EXA_SEARCH_ENDPOINT = "https://api.exa.ai/search";
export const EXA_SEARCH_TIMEOUT_MS = 15_000;
export const EXA_SEARCH_RESULT_LIMIT = 5;
export const EXA_SEARCH_QUERY_MAX_LENGTH = 512;
export const EXA_SEARCH_TEXT_MAX_CHARACTERS = 1_000;

const exaResultSchema = z.object({
  title: z.string().trim().min(1),
  url: z.string().trim().url(),
  text: z.string().trim().min(1),
  score: z.number().finite().optional().default(0),
});
const exaResponseSchema = z.object({
  results: z.array(exaResultSchema).max(EXA_SEARCH_RESULT_LIMIT),
});

const officialDomainIdentitySchema = z.object({
  legalName: z.string().trim().min(1).max(200),
  city: z.string().trim().min(1).max(64).optional(),
  state: z.string().trim().min(1).max(32).optional(),
  uei: z.string().trim().min(1).max(32).optional(),
  cage: z.string().trim().min(1).max(32).optional(),
});

const blockedDomainSuffixes = [
  "linkedin.com",
  "crunchbase.com",
  "usaspending.gov",
  "govtribe.com",
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "tiktok.com",
  "zoominfo.com",
  "dnb.com",
  "dunandbradstreet.com",
  "yellowpages.com",
  "yelp.com",
  "manta.com",
  "bizapedia.com",
  "opencorporates.com",
  "chamberofcommerce.com",
  "rocketreach.co",
  "pitchbook.com",
  "bloomberg.com",
  "glassdoor.com",
  "indeed.com",
  "wikipedia.org",
] as const;

export type ExaSearchErrorCode =
  | "invalid_request"
  | "timeout"
  | "network_error"
  | "rate_limited"
  | "provider_unavailable"
  | "request_rejected"
  | "invalid_response";

/** A deliberate fail-closed error for deployments without an Exa credential. */
export class ExaApiKeyMissingError extends Error {
  constructor() {
    super("Exa API key is not configured");
    this.name = "ExaApiKeyMissingError";
  }
}

export class ExaSearchError extends Error {
  constructor(
    readonly code: ExaSearchErrorCode,
    readonly transient: boolean,
    readonly status: number | null = null,
  ) {
    super(
      {
        invalid_request: "Exa search request is invalid",
        timeout: "Exa search request timed out",
        network_error: "Exa search network request failed",
        rate_limited: "Exa search request was rate limited",
        provider_unavailable: "Exa search provider is temporarily unavailable",
        request_rejected: "Exa search request was rejected",
        invalid_response: "Exa search returned an invalid response",
      }[code],
    );
    this.name = "ExaSearchError";
  }
}

export interface ExaSearchResult {
  readonly title: string;
  readonly url: string;
  readonly text: string;
  readonly score: number;
}

export interface ExaOfficialDomainIdentity {
  readonly legalName: string;
  readonly city?: string;
  readonly state?: string;
  readonly uei?: string;
  readonly cage?: string;
}

/**
 * A search result is only a weak external observation. It is not a lead or a
 * verified domain and must be qualified before entering a user-facing list.
 */
export interface OfficialDomainCandidate {
  readonly url: string;
  readonly domain: string;
  readonly title: string;
  readonly textSnippet: string;
  readonly score: number;
}

export interface ExaSearchClientOptions {
  readonly apiKey?: string | undefined;
  readonly fetch?: typeof fetch | undefined;
}

export class ExaSearchClient {
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: ExaSearchClientOptions = {}) {
    const apiKey = options.apiKey?.trim();
    this.#apiKey =
      apiKey === undefined || apiKey.length === 0 || /[\r\n]/u.test(apiKey)
        ? undefined
        : apiKey;
    this.#fetch = options.fetch ?? fetch;
  }

  async search(query: string): Promise<readonly ExaSearchResult[]> {
    const apiKey = this.#apiKey;
    if (apiKey === undefined) throw new ExaApiKeyMissingError();

    const normalizedQuery = normalizeQuery(query);
    if (normalizedQuery.includes(apiKey)) {
      throw new ExaSearchError("invalid_request", false);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EXA_SEARCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.#fetch(EXA_SEARCH_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({
          query: normalizedQuery,
          numResults: EXA_SEARCH_RESULT_LIMIT,
          contents: { text: { maxCharacters: EXA_SEARCH_TEXT_MAX_CHARACTERS } },
        }),
        signal: controller.signal,
      });
    } catch {
      throw new ExaSearchError(
        controller.signal.aborted ? "timeout" : "network_error",
        true,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const code =
        response.status === 429
          ? "rate_limited"
          : response.status >= 500
            ? "provider_unavailable"
            : "request_rejected";
      throw new ExaSearchError(
        code,
        response.status === 408 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500,
        response.status,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ExaSearchError("invalid_response", false, response.status);
    }

    const parsed = exaResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ExaSearchError("invalid_response", false, response.status);
    }
    return parsed.data.results;
  }

  async searchOfficialDomainCandidates(
    identity: ExaOfficialDomainIdentity,
  ): Promise<readonly OfficialDomainCandidate[]> {
    return searchOfficialDomainCandidates(identity, this);
  }
}

export function buildOfficialDomainQuery(
  identity: ExaOfficialDomainIdentity,
): string {
  const parsed = officialDomainIdentitySchema.safeParse(identity);
  if (!parsed.success) throw new ExaSearchError("invalid_request", false);

  const { legalName, city, state, uei, cage } = parsed.data;
  const query = [
    `official website \"${legalName}\"`,
    city,
    state,
    uei === undefined ? undefined : `UEI ${uei}`,
    cage === undefined ? undefined : `CAGE ${cage}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ");
  return normalizeQuery(query);
}

export async function searchOfficialDomainCandidates(
  identity: ExaOfficialDomainIdentity,
  client: Pick<ExaSearchClient, "search">,
): Promise<readonly OfficialDomainCandidate[]> {
  const results = await client.search(buildOfficialDomainQuery(identity));
  const candidates: OfficialDomainCandidate[] = [];
  const seenDomains = new Set<string>();

  for (const result of results) {
    const normalized = normalizeOfficialCandidate(result);
    if (
      normalized === null ||
      seenDomains.has(normalized.domain) ||
      isSuppressedDirectoryDomain(normalized.domain)
    ) {
      continue;
    }
    seenDomains.add(normalized.domain);
    candidates.push(normalized);
  }

  return candidates;
}

function normalizeQuery(query: string): string {
  const normalized = query.trim().replace(/\s+/gu, " ");
  if (normalized.length === 0 || normalized.length > EXA_SEARCH_QUERY_MAX_LENGTH) {
    throw new ExaSearchError("invalid_request", false);
  }
  return normalized;
}

function normalizeOfficialCandidate(
  result: ExaSearchResult,
): OfficialDomainCandidate | null {
  let url: URL;
  try {
    url = new URL(result.url);
  } catch {
    return null;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return null;
  }

  const domain = normalizeDomain(url.hostname);
  if (domain === null) return null;
  return {
    url: url.href,
    domain,
    title: result.title.trim(),
    textSnippet: result.text.trim().slice(0, EXA_SEARCH_TEXT_MAX_CHARACTERS),
    score: result.score,
  };
}

function normalizeDomain(hostname: string): string | null {
  const normalized = hostname.toLowerCase().replace(/\.$/u, "");
  const domain = normalized.startsWith("www.") ? normalized.slice(4) : normalized;
  return domain.length === 0 ? null : domain;
}

function isSuppressedDirectoryDomain(domain: string): boolean {
  return blockedDomainSuffixes.some(
    (blocked) => domain === blocked || domain.endsWith(`.${blocked}`),
  );
}
