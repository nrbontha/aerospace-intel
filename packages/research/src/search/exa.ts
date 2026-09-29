import { z } from "zod";

const EXA_SEARCH_ENDPOINT = "https://api.exa.ai/search";
const EXA_CONTENTS_ENDPOINT = "https://api.exa.ai/contents";
export const EXA_SEARCH_TIMEOUT_MS = 15_000;
export const EXA_SEARCH_RESULT_LIMIT = 5;
export const EXA_SEARCH_QUERY_MAX_LENGTH = 512;
export const EXA_SEARCH_TEXT_MAX_CHARACTERS = 1_000;
/** Max characters of extracted text requested per page from /contents. */
export const EXA_CONTENTS_TEXT_MAX_CHARACTERS = 8_000;
/** Max page URLs per /contents call (homepage + products + about). */
export const EXA_CONTENTS_URL_LIMIT = 3;

const exaResultSchema = z.object({
  title: z.string().trim(),
  url: z.string().trim().url(),
  text: z.string().trim().min(1),
  score: z.number().finite().optional().default(0),
});
const exaResponseSchema = z.object({
  results: z.array(exaResultSchema),
});
const exaContentsResultSchema = z.object({
  url: z.string().trim().url(),
  title: z.string().optional().default(""),
  text: z.string().optional().default(""),
});
const exaContentsResponseSchema = z.object({
  results: z.array(exaContentsResultSchema).max(EXA_CONTENTS_URL_LIMIT),
});
const exaCostEnvelopeSchema = z
  .object({
    costDollars: z
      .union([
        z.number().finite().nonnegative(),
        z.string(),
        z
          .object({
            total: z.union([z.number().finite().nonnegative(), z.string()]),
          })
          .passthrough(),
      ])
      .optional(),
  })
  .passthrough();

const officialDomainIdentitySchema = z.object({
  legalName: z.string().trim().min(1).max(200),
  city: z.string().trim().min(1).max(64).optional(),
  state: z.string().trim().min(1).max(32).optional(),
  uei: z.string().trim().min(1).max(32).optional(),
  cage: z.string().trim().min(1).max(32).optional(),
});

export const OFFICIAL_CANDIDATE_BLOCKED_DOMAIN_SUFFIXES: ReadonlySet<string> =
  new Set([
    "highergov.com",
    "govtribe.com",
    "cage.report",
    "sam.gov",
    "usaspending.gov",
    "dnb.com",
    "dunandbradstreet.com",
    "zoominfo.com",
    "rocketreach.co",
    "opencorporates.com",
    "linkedin.com",
    "crunchbase.com",
    "bloomberg.com",
    "pitchbook.com",
    "manta.com",
    "bbb.org",
    "chamberofcommerce.com",
    "mapquest.com",
    "lead411.com",
    "signalhire.com",
    "inknowvation.com",
    "facebook.com",
    "instagram.com",
    "twitter.com",
    "x.com",
    "youtube.com",
    "tiktok.com",
    "yellowpages.com",
    "yelp.com",
    "bizapedia.com",
    "glassdoor.com",
    "indeed.com",
    "wikipedia.org",
  ]);

export type ExaSearchErrorCode =
  | "invalid_request"
  | "timeout"
  | "network_error"
  | "rate_limited"
  | "quota_exhausted"
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
    /** Provider-reported charge retained even when the HTTP 200 body is invalid. */
    readonly providerCostUsd: string | null = null,
  ) {
    super(
      {
        invalid_request: "Exa search request is invalid",
        timeout: "Exa search request timed out",
        network_error: "Exa search network request failed",
        rate_limited: "Exa search request was rate limited",
        quota_exhausted: "Exa provider credits are exhausted",
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

export interface ExaContentsResult {
  readonly url: string;
  readonly title: string;
  readonly text: string;
}
export interface ExaProviderResult<T> {
  readonly results: readonly T[];
  /** Exact decimal text when Exa supplied costDollars; null means unknown. */
  readonly providerCostUsd: string | null;
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

export interface ExaNormalizedSearchRequest {
  readonly query: string;
  readonly type: "auto";
  readonly numResults: typeof EXA_SEARCH_RESULT_LIMIT;
  readonly contents: {
    readonly text: { readonly maxCharacters: typeof EXA_SEARCH_TEXT_MAX_CHARACTERS };
  };
}

export interface ExaNormalizedContentsRequest {
  readonly urls: readonly string[];
  readonly text: {
    readonly maxCharacters: typeof EXA_CONTENTS_TEXT_MAX_CHARACTERS;
  };
}

/** The complete, bounded text-only body used for every paid /search call. */
export function normalizeExaSearchRequest(query: string): ExaNormalizedSearchRequest {
  return {
    query: normalizeQuery(query),
    type: "auto",
    numResults: EXA_SEARCH_RESULT_LIMIT,
    contents: { text: { maxCharacters: EXA_SEARCH_TEXT_MAX_CHARACTERS } },
  };
}

/** The complete, bounded text-only body used for every paid /contents call. */
export function normalizeExaContentsRequest(
  urls: readonly string[],
): ExaNormalizedContentsRequest {
  const targets = urls
    .map((url) => url.trim())
    .filter((url) => url.startsWith("http://") || url.startsWith("https://"))
    .slice(0, EXA_CONTENTS_URL_LIMIT);
  if (targets.length === 0) throw new ExaSearchError("invalid_request", false);
  return {
    urls: targets,
    text: { maxCharacters: EXA_CONTENTS_TEXT_MAX_CHARACTERS },
  };
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
    return (await this.searchWithMetadata(query)).results;
  }

  async searchWithMetadata(
    query: string,
  ): Promise<ExaProviderResult<ExaSearchResult>> {
    const apiKey = this.#apiKey;
    if (apiKey === undefined) throw new ExaApiKeyMissingError();

    const request = normalizeExaSearchRequest(query);
    if (request.query.includes(apiKey)) {
      throw new ExaSearchError("invalid_request", false);
    }

    const response = await this.#post(EXA_SEARCH_ENDPOINT, apiKey, request);
    const providerCostUsd = extractProviderCostUsd(response.payload);
    const parsed = exaResponseSchema.safeParse(response.payload);
    if (!parsed.success) {
      throw new ExaSearchError(
        "invalid_response",
        false,
        response.status,
        providerCostUsd,
      );
    }
    return { results: parsed.data.results, providerCostUsd };
  }
  /**
   * Fetch extracted text for up to EXA_CONTENTS_URL_LIMIT page URLs via
   * POST /contents. Returns one entry per page Exa could extract; pages
   * Exa cannot fetch are omitted (never an error). Throws ExaSearchError
   * on transport/provider failures and ExaApiKeyMissingError without a key.
   */
  async fetchContents(
    urls: readonly string[],
  ): Promise<readonly ExaContentsResult[]> {
    return (await this.fetchContentsWithMetadata(urls)).results;
  }

  async fetchContentsWithMetadata(
    urls: readonly string[],
  ): Promise<ExaProviderResult<ExaContentsResult>> {
    const apiKey = this.#apiKey;
    if (apiKey === undefined) throw new ExaApiKeyMissingError();
    const request = normalizeExaContentsRequest(urls);
    const response = await this.#post(EXA_CONTENTS_ENDPOINT, apiKey, request);
    const providerCostUsd = extractProviderCostUsd(response.payload);
    const parsed = exaContentsResponseSchema.safeParse(response.payload);
    if (!parsed.success) {
      throw new ExaSearchError(
        "invalid_response",
        false,
        response.status,
        providerCostUsd,
      );
    }
    return { results: parsed.data.results, providerCostUsd };
  }

  async #post(
    endpoint: string,
    apiKey: string,
    body: object,
  ): Promise<{ readonly payload: unknown; readonly status: number }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EXA_SEARCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.#fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timeout);
      throw new ExaSearchError(
        controller.signal.aborted ? "timeout" : "network_error",
        true,
      );
    }

    if (!response.ok) {
      let errorPayload: unknown = null;
      try {
        errorPayload = await readResponseJson(response, controller.signal);
      } catch {
        await response.body?.cancel().catch(() => undefined);
        if (controller.signal.aborted) {
          throw new ExaSearchError("timeout", true, response.status);
        }
      } finally {
        clearTimeout(timeout);
      }
      const code =
        response.status === 402
          ? "quota_exhausted"
          : response.status === 429
            ? "rate_limited"
            : response.status >= 500
              ? "provider_unavailable"
              : "request_rejected";
      throw new ExaSearchError(
        code,
        response.status === 402 ||
          response.status === 408 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500,
        response.status,
        extractProviderCostUsd(errorPayload),
      );
    }

    let payload: unknown;
    try {
      payload = await readResponseJson(response, controller.signal);
    } catch {
      throw new ExaSearchError(
        controller.signal.aborted ? "timeout" : "invalid_response",
        controller.signal.aborted,
        response.status,
      );
    } finally {
      clearTimeout(timeout);
    }
    return { payload, status: response.status };
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
    `official website "${legalName}"`,
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
    const normalized = normalizeExaOfficialCandidate(result);
    if (normalized === null || seenDomains.has(normalized.domain)) {
      continue;
    }
    seenDomains.add(normalized.domain);
    candidates.push(normalized);
  }

  return candidates;
}

async function readResponseJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const abort = () => {
    void response.body?.cancel().catch(() => undefined);
    reject(new DOMException("Aborted", "AbortError"));
  };
  signal.addEventListener("abort", abort, { once: true });
  response.json().then(
    (value) => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    },
    (error: unknown) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    },
  );
  return promise;
}

function extractProviderCostUsd(payload: unknown): string | null {
  const envelope = exaCostEnvelopeSchema.safeParse(payload);
  if (!envelope.success || envelope.data.costDollars === undefined) return null;
  const raw =
    typeof envelope.data.costDollars === "object"
      ? envelope.data.costDollars.total
      : envelope.data.costDollars;
  const decimal =
    typeof raw === "number" ? plainDecimal(raw) : raw.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(decimal)) return null;
  return decimal;
}

function plainDecimal(value: number): string {
  const source = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/u.exec(source);
  if (match === null) return source;
  const sign = match[1] ?? "";
  const integer = match[2] ?? "0";
  const fraction = match[3] ?? "";
  const exponent = Number.parseInt(match[4] ?? "0", 10);
  const digits = integer + fraction;
  const point = integer.length + exponent;
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) {
    return `${sign}${digits}${"0".repeat(point - digits.length)}`;
  }
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

function normalizeQuery(query: string): string {
  const normalized = query.trim().replace(/\s+/gu, " ");
  if (
    normalized.length === 0 ||
    normalized.length > EXA_SEARCH_QUERY_MAX_LENGTH
  ) {
    throw new ExaSearchError("invalid_request", false);
  }
  return normalized;
}

export function normalizeExaOfficialCandidate(
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
  if (domain === null || isSuppressedDirectoryDomain(domain)) return null;
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
  const domain = normalized.startsWith("www.")
    ? normalized.slice(4)
    : normalized;
  return domain.length === 0 ? null : domain;
}

export function isSuppressedDirectoryDomain(domain: string): boolean {
  const normalized = normalizeDomain(domain);
  if (normalized === null) return false;
  for (const blocked of OFFICIAL_CANDIDATE_BLOCKED_DOMAIN_SUFFIXES) {
    if (normalized === blocked || normalized.endsWith(`.${blocked}`))
      return true;
  }
  return false;
}
