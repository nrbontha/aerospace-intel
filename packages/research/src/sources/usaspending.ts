import { z } from "zod";

import type { LeadCandidate } from "./types.js";
import { SourceFetchError } from "./types.js";

/**
 * USAspending award-search client.
 *
 * Endpoint: POST https://api.usaspending.gov/api/v2/search/spending_by_award/
 * No API key required (public_no_auth).
 *
 * HONEST SCOPE NOTE: spending_by_award returns RECIPIENTS of federal
 * awards, not a manufacturer registry. This adapter therefore applies a
 * conservative post-fetch qualification gate before it emits any candidate:
 * returned NAICS must be a strict aerospace-manufacturing code and the
 * award/business text must carry aerospace or defense manufacturing evidence.
 */

export const USASPENDING_SEARCH_URL =
  "https://api.usaspending.gov/api/v2/search/spending_by_award/";

/**
 * Default discovery seed list: US aerospace/defense engineered-component
 * manufacturing only. It deliberately excludes sector rollups and adjacent
 * instrument codes; campaign-specific seeds must opt in separately.
 */
export const AEROSPACE_NAICS = [
  "336411",
  "336412",
  "336413",
  "336419",
  "334511",
] as const;

/**
 * Aircraft-related PSC values remain available to explicitly configured
 * campaigns, but are never part of the default discovery query and cannot
 * qualify a recipient without strict returned NAICS evidence.
 */
export const AIRCRAFT_COMPONENT_PSC = [
  "1510",
  "1520",
  "1560",
  "1610",
  "1620",
  "1630",
  "1650",
  "1660",
  "1680",
  "1730",
] as const;

export interface SourceQualification {
  readonly appliedFilters: {
    readonly awardTypeCodes: readonly string[];
    readonly naicsCodes: readonly string[];
    readonly pscCodes: readonly string[];
    readonly timePeriods: readonly UsaspendingTimePeriod[];
    readonly placeOfPerformanceLocations: readonly UsaspendingPlaceOfPerformance[];
    readonly keywords: readonly string[];
  };
  readonly returnedNaics: readonly string[];
  readonly returnedPsc: readonly string[];
  readonly awardDescriptionExcerpt: string;
  readonly awardAgency?: string;
  /** Stable endpoint + canonicalized query/recipient locator for replay. */
  readonly queryLocator: string;
}

export type UsaspendingLeadCandidate = LeadCandidate & {
  readonly sourceQualification: SourceQualification;
};

export interface QualificationFindings {
  readonly qualified: number;
  readonly rejected: {
    readonly missingStrictNaics: number;
    readonly missingAerospaceDefenseEvidence: number;
    readonly excludedServiceWithoutManufacturing: number;
  };
}

/** Award type codes: B/C/D = purchase orders + definitive contracts (and A/B combined continuing). */
const DEFAULT_AWARD_TYPE_CODES = ["A", "B", "C", "D"] as const;

const FIELDS = [
  "Recipient Name",
  "Recipient UEI",
  "Recipient UEI Count",
  "Award Amount",
  "Awarding Agency",
  "Start Date",
  "Description",
  // Verified against the live award-search response on 2026-08-24.
  "NAICS Code",
  "Product or Service Code",
  "Recipient Location",
] as const;

const MIN_PAGE_DELAY_MS = 1_000;
const DEFAULT_MAX_PAGES = 5;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 2;

/**
 * Explicit stable result ordering. Omitting `sort`/`order` makes the API
 * walk recipients in near-alphabetical DESCENDING order, so a bounded
 * crawl samples only the tail of the alphabet (verified 2026-08-24: the
 * unsorted stream starts at "ZOTIQUE TOWELS & SCRUBS"). Pinning an
 * ascending recipient-name order makes every pagination window
 * deterministic, which cursor-based full coverage requires — amount-based
 * ordering shifts between calls as award records change.
 */
export const USASPENDING_SORT_FIELD = "Recipient Name";
export const USASPENDING_SORT_ORDER = "asc";

/**
 * Hard API ceiling: `page * limit` may not exceed 50_000 records via the
 * page parameter alone (page 550 at limit=100 is rejected with "over the
 * maximum result limit 50000"; verified 2026-08-24). Deeper traversal
 * resumes through the `last_record_sort_value`/`last_record_unique_id`
 * cursor params carried by UsaspendingCursor.
 */
export const USASPENDING_API_MAX_PAGE = 500;

/** USAspending renders amounts as strings like "$1,234.56" or null. */
function parseAmountUsd(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const cleaned = String(raw).replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

const locationSchema = z.object({
  address_line1: z.union([z.string(), z.null()]).optional(),
  city_name: z.union([z.string(), z.null()]).optional(),
  state_code: z.union([z.string(), z.null()]).optional(),
  zip5: z.union([z.string(), z.number(), z.null()]).optional(),
});

const rowSchema = z.object({
  // Real pages occasionally carry null/blank recipient cells; such rows are
  // dropped during aggregation instead of failing the whole 100-row page.
  "Recipient Name": z.union([z.string(), z.null()]).optional(),
  "Recipient UEI": z
    .union([z.string(), z.number(), z.null()])
    .optional()
    .transform((v) => (v === null || v === undefined ? undefined : String(v))),
  "Recipient UEI Count": z
    .union([z.number(), z.string(), z.null()])
    .optional(),
  "Award Amount": z
    .union([z.string(), z.number(), z.null()])
    .transform(parseAmountUsd),
  "Awarding Agency": z.union([z.string(), z.null()]).optional(),
  "Start Date": z.union([z.string(), z.null()]).optional(),
  Description: z.union([z.string(), z.null()]).optional(),
  "NAICS Code": z.union([z.string(), z.number(), z.null()]).optional(),
  "Product or Service Code": z
    .union([z.string(), z.number(), z.null()])
    .optional(),
  "Recipient Location": locationSchema.nullish(),
});

const pageMetadataSchema = z.object({
  page: z.number().optional(),
  hasNext: z.boolean().optional(),
  // The API emits explicit nulls for both cursor fields once hasNext=false.
  last_record_unique_id: z.number().nullable().optional(),
  last_record_sort_value: z.string().nullable().optional(),
});

const responseSchema = z.object({
  results: z.array(rowSchema),
  // The API sometimes emits an explicit null here between pages.
  page_metadata: pageMetadataSchema.nullish(),
});

export interface UsaspendingTimePeriod {
  readonly startDate: string; // YYYY-MM-DD
  readonly endDate: string; // YYYY-MM-DD
}

export interface UsaspendingPlaceOfPerformance {
  readonly country?: string;
  readonly state?: string;
  readonly city?: string;
}


/** Resume anchor returned by the API for sequential pagination. */
export interface UsaspendingCursor {
  readonly sortValue: string;
  readonly uniqueId: number;
}

export interface UsaspendingPageQuery extends UsaspendingQuery {
  /** First page to fetch (default 1). */
  readonly startPage?: number;
  /** Resume anchor from a previous slice when walking past the ceiling. */
  readonly cursor?: UsaspendingCursor | null;
}

export interface UsaspendingPageResult {
  readonly leads: UsaspendingLeadCandidate[];
  /** Page to resume from when more results remain; null when exhausted or at the API ceiling. */
  readonly nextPage: number | null;
  /** Cursor for the resume point; null when the API did not report one. */
  readonly cursor: UsaspendingCursor | null;
  /** Deterministic post-fetch gate accounting for this page-set. */
  readonly qualificationFindings: QualificationFindings;
}
export interface UsaspendingQuery {
  readonly naicsCodes?: readonly string[];
  readonly pscCodes?: readonly string[];
  readonly timePeriod: UsaspendingTimePeriod | readonly UsaspendingTimePeriod[];
  readonly placeOfPerformanceLocations?: readonly UsaspendingPlaceOfPerformance[];
  /** Free-text recipient keyword filter, if a campaign wants one. */
  readonly keyword?: string;
}

export interface UsaspendingClientOptions {
  readonly maxPages?: number; // default 5 — budget bound on pagination
  readonly pageSize?: number; // default 100 (API cap)
  readonly timeoutMs?: number; // default 20s per request
  /** Delay between paged requests; clamped to >= 1000ms rate limit. */
  readonly requestDelayMs?: number;
  readonly maxRetries?: number; // transient-error retries per page, default 2
  readonly fetchImpl?: typeof fetch; // injectable for tests
  /** Injectable clock for tests (rate-limit sleeps). */
  readonly sleep?: (ms: number) => Promise<void>;
}

interface AggRow {
  totalUsd: number;
  count: number;
  freshestDate?: string;
  readonly naics: Set<string>;
  readonly psc: Set<string>;
  qualification: SourceQualification;
  city?: string;
  state?: string;
  addressLine?: string;
  zip?: string;
}

interface UsaspendingPage {
  readonly rows: z.output<typeof rowSchema>[];
  readonly metadata?: {
    readonly hasNext?: boolean;
    /** Present when the API reported both cursor fields. */
    readonly lastRecordCursor?: UsaspendingCursor | null;
  };
}

function buildRequestBody(
  pageSize: number,
  query: UsaspendingQuery,
  page: number,
  cursor?: UsaspendingCursor | null,
): object {
  const timePeriods = Array.isArray(query.timePeriod)
    ? query.timePeriod
    : [query.timePeriod];
  const filters: Record<string, unknown> = {
    award_type_codes: [...DEFAULT_AWARD_TYPE_CODES],
    // API wants snake_case date keys.
    time_period: timePeriods.map((tp) => ({
      start_date: tp.startDate,
      end_date: tp.endDate,
    })),
  };
  if (query.naicsCodes?.length) filters.naics_codes = [...query.naicsCodes];
  if (query.pscCodes?.length)
    filters.product_or_service_code = [...query.pscCodes];
  if (query.placeOfPerformanceLocations?.length)
    filters.place_of_performance_locations = [
      ...query.placeOfPerformanceLocations,
    ];
  if (query.keyword) filters.keywords = [query.keyword];
  return {
    filters,
    fields: [...FIELDS],
    limit: pageSize,
    page,
    sort: USASPENDING_SORT_FIELD,
    order: USASPENDING_SORT_ORDER,
    ...(cursor === undefined || cursor === null
      ? {}
      : {
          last_record_sort_value: cursor.sortValue,
          last_record_unique_id: cursor.uniqueId,
        }),
  };
}
type AwardRow = z.output<typeof rowSchema>;

const STRICT_NAICS: Record<string, true> = {
  "336411": true,
  "336412": true,
  "336413": true,
  "336419": true,
  "334511": true,
};
const AEROSPACE_DEFENSE_RELEVANCE =
  /\b(?:aerospace|aviation|aircraft|airframe|avionics|rotary[-\s]?wing|defen[cs]e|military)\b/iu;
const MANUFACTURING_SIGNAL =
  /\b(?:manufactur(?:e|ed|ing)|machin(?:e|ed|ing)|fabricat(?:e|ed|ing)|assembly|assembl(?:e|ed|ing)|tooling|production)\b/iu;
const EXCLUDED_SERVICE_SIGNAL =
  /\b(?:service(?:s|ing)?|distribution|distributor|procurement|consult(?:ant|ing)|staffing|brokerage|reseller)\b/iu;

function codeList(raw: unknown): string[] {
  if (typeof raw === "number") return [String(raw)];
  if (typeof raw !== "string") return [];
  return raw
    .split(/[,\s;]+/u)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function queryLocator(
  query: UsaspendingQuery,
  recipientName: string,
  uei: string | undefined,
): string {
  const timePeriods = Array.isArray(query.timePeriod)
    ? query.timePeriod
    : [query.timePeriod];
  const params = new URLSearchParams({
    award_type_codes: [...DEFAULT_AWARD_TYPE_CODES].join(","),
    naics_codes: [...(query.naicsCodes ?? [])].join(","),
    psc_codes: [...(query.pscCodes ?? [])].join(","),
    time_period: timePeriods
      .map((period) => `${period.startDate}:${period.endDate}`)
      .join(","),
    place_of_performance_locations: JSON.stringify(
      query.placeOfPerformanceLocations ?? [],
    ),
    keywords: query.keyword ?? "",
    recipient_name: recipientName,
  });
  if (uei !== undefined) params.set("recipient_uei", uei);
  return `${USASPENDING_SEARCH_URL}?${params.toString()}`;
}


function appliedFilters(query: UsaspendingQuery): SourceQualification["appliedFilters"] {
  const timePeriods = Array.isArray(query.timePeriod)
    ? query.timePeriod
    : [query.timePeriod];
  return {
    awardTypeCodes: [...DEFAULT_AWARD_TYPE_CODES],
    naicsCodes: [...(query.naicsCodes ?? [])],
    pscCodes: [...(query.pscCodes ?? [])],
    placeOfPerformanceLocations: [...(query.placeOfPerformanceLocations ?? [])],
    keywords: query.keyword === undefined ? [] : [query.keyword],
    timePeriods: timePeriods.map(({ startDate, endDate }) => ({ startDate, endDate })),
  };
}

function qualificationRejection(
  row: AwardRow,
): keyof QualificationFindings["rejected"] | null {
  const naics = codeList(row["NAICS Code"]);
  if (!naics.some((code) => STRICT_NAICS[code] === true)) {
    return "missingStrictNaics";
  }
  const businessText = [
    row["Recipient Name"] ?? "",
    row.Description ?? "",
  ].join(" ");
  if (!AEROSPACE_DEFENSE_RELEVANCE.test(businessText)) {
    return "missingAerospaceDefenseEvidence";
  }
  if (
    EXCLUDED_SERVICE_SIGNAL.test(businessText) &&
    !MANUFACTURING_SIGNAL.test(businessText)
  ) {
    return "excludedServiceWithoutManufacturing";
  }
  return null;
}


export class UsaspendingClient {
  readonly #maxPages: number;
  readonly #pageSize: number;
  readonly #timeoutMs: number;
  readonly #requestDelayMs: number;
  readonly #maxRetries: number;
  readonly #fetchImpl: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: UsaspendingClientOptions = {}) {
    this.#maxPages = Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES);
    this.#pageSize = Math.min(
      DEFAULT_PAGE_SIZE,
      options.pageSize ?? DEFAULT_PAGE_SIZE,
    );
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Rate limit is contractual: never below 1000ms between pages.
    this.#requestDelayMs = Math.max(
      MIN_PAGE_DELAY_MS,
      options.requestDelayMs ?? MIN_PAGE_DELAY_MS,
    );
    this.#maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#sleep =
      options.sleep ??
      ((ms) => {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, ms);
        return promise;
      });
  }

  /**
   * Run an award search and aggregate rows into one LeadCandidate per
   * recipient (summed amounts, counted awards, freshest award date).
   * Reads at most #maxPages pages starting from page 1.
   */
  async searchRecipients(query: UsaspendingQuery): Promise<UsaspendingLeadCandidate[]> {
    const result = await this.searchRecipientsPage(query);
    return result.leads;
  }

  /**
   * Pagination-aware variant of {@link searchRecipients}: starts at
   * `startPage` (optionally resuming after `cursor`) and reports how to
   * continue — `nextPage` while page-param traversal is possible, plus the
   * API's sequential cursor for walking past the 50k-record ceiling.
   */
  async searchRecipientsPage(
    query: UsaspendingPageQuery,
  ): Promise<UsaspendingPageResult> {
    const byRecipient = new Map<string, AggRow>();
    const findings: {
      qualified: number;
      rejected: {
        missingStrictNaics: number;
        missingAerospaceDefenseEvidence: number;
        excludedServiceWithoutManufacturing: number;
      };
    } = {
      qualified: 0,
      rejected: {
        missingStrictNaics: 0,
        missingAerospaceDefenseEvidence: 0,
        excludedServiceWithoutManufacturing: 0,
      },
    };
    const filters = appliedFilters(query);
    const startPage = Math.max(1, query.startPage ?? 1);
    let cursor = query.cursor ?? null;
    let page = startPage;
    let nextPage: number | null = null;
    let nextCursor: UsaspendingCursor | null = null;

    while (page < startPage + this.#maxPages) {
      const { rows, metadata } = await this.#fetchPageWithRetry(
        query,
        page,
        cursor,
      );
      for (const row of rows) {
        const name = row["Recipient Name"];
        if (name === undefined || name === null || name.trim() === "") {
          continue;
        }
        const rejection = qualificationRejection(row);
        if (rejection !== null) {
          findings.rejected[rejection] += 1;
          continue;
        }
        findings.qualified += 1;
        const uei = row["Recipient UEI"];
        const key = `${name}|${uei ?? ""}`;
        const returnedNaics = codeList(row["NAICS Code"]);
        const returnedPsc = codeList(row["Product or Service Code"]);
        const location = row["Recipient Location"];
        const qualification: SourceQualification = {
          appliedFilters: filters,
          returnedNaics,
          returnedPsc,
          awardDescriptionExcerpt: (row.Description ?? "").slice(0, 1_000),
          ...(row["Awarding Agency"] === undefined ||
          row["Awarding Agency"] === null
            ? {}
            : { awardAgency: row["Awarding Agency"] }),
          queryLocator: queryLocator(query, name, uei),
        };
        const agg = byRecipient.get(key);
        if (agg === undefined) {
          const fresh: AggRow = {
            totalUsd: row["Award Amount"] ?? 0,
            count: 1,
            naics: new Set(returnedNaics),
            psc: new Set(returnedPsc),
            qualification,
            ...(location?.city_name === undefined || location.city_name === null
              ? {}
              : { city: location.city_name }),
            ...(location?.state_code === undefined || location.state_code === null
              ? {}
              : { state: location.state_code }),
            ...(location?.address_line1 === undefined ||
            location.address_line1 === null
              ? {}
              : { addressLine: location.address_line1 }),
            ...(location?.zip5 === undefined || location.zip5 === null
              ? {}
              : { zip: String(location.zip5) }),
          };
          if (row["Start Date"] !== undefined && row["Start Date"] !== null) {
            fresh.freshestDate = row["Start Date"];
          }
          byRecipient.set(key, fresh);
          continue;
        }
        agg.totalUsd += row["Award Amount"] ?? 0;
        agg.count += 1;
        for (const code of returnedNaics) agg.naics.add(code);
        for (const code of returnedPsc) agg.psc.add(code);
        const start = row["Start Date"];
        if (
          start &&
          (agg.freshestDate === undefined || start > agg.freshestDate)
        ) {
          agg.freshestDate = start;
        }
      }

      // Continue while the page came back full. The API's hasNext flag is
      // unreliable under sorted access — it flips to false at its internal
      // 10k-record window even though deeper pages keep returning data
      // (verified live 2026-08-24: pages 101-102 served continuing rows
      // while reporting hasNext:false). Partial page = true end.
      const moreAvailable = rows.length >= this.#pageSize;
      if (!moreAvailable) {
        nextPage = null;
        nextCursor = null;
        break;
      }
      // Without a fresh anchor the page parameter cannot advance past the
      // API record ceiling; with one, sequential pagination may proceed.
      nextCursor = metadata?.lastRecordCursor ?? null;
      if (page + 1 > USASPENDING_API_MAX_PAGE && nextCursor === null) {
        nextPage = null;
        break;
      }
      nextPage = page + 1;
      // Each subsequent fetch anchors on the freshest cursor so deep
      // sequential requests resume from the true stream position.
      cursor = nextCursor;
      if (page + 1 < startPage + this.#maxPages) {
        await this.#sleep(this.#requestDelayMs);
      }
      page += 1;
    }

    return {
      leads: this.#toCandidates(byRecipient),
      nextPage,
      cursor: nextCursor,
      qualificationFindings: findings,
    };
  }

  #toCandidates(byRecipient: Map<string, AggRow>): UsaspendingLeadCandidate[] {
    return [...byRecipient.entries()].map(([key, agg]) => {
      const [rawNameKey, ueiKey] = key.split("|");
      const rawName = rawNameKey!;
      const uei = ueiKey === "" ? undefined : (ueiKey as string);
      return {
        rawName,
        ...(uei ? { uei } : {}),
        ...(agg.addressLine === undefined ? {} : { addressLine: agg.addressLine }),
        ...(agg.city === undefined ? {} : { city: agg.city }),
        ...(agg.state === undefined ? {} : { state: agg.state }),
        ...(agg.zip === undefined ? {} : { zip: agg.zip }),
        naics: [...agg.naics],
        pscCodes: [...agg.psc],
        awardCount: agg.count,
        totalAwardValueUsd: agg.totalUsd,
        ...(agg.freshestDate !== undefined
          ? { freshestAwardDate: agg.freshestDate }
          : {}),
        source: "usaspending" as const,
        sourceLocator: agg.qualification.queryLocator.replace(
          USASPENDING_SEARCH_URL,
          "usaspending://spending_by_award",
        ),
        sourceQualification: {
          ...agg.qualification,
          returnedNaics: [...agg.naics],
          returnedPsc: [...agg.psc],
        },
      };
    });
  }

  async #fetchPageWithRetry(
    query: UsaspendingQuery,
    page: number,
    cursor?: UsaspendingCursor | null,
  ): Promise<UsaspendingPage> {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await this.#fetchPage(query, page, cursor);
      } catch (error) {
        const retryable =
          error instanceof SourceFetchError && error.transient;
        if (!retryable || attempt >= this.#maxRetries) throw error;
        attempt += 1;
        await this.#sleep(this.#requestDelayMs * attempt);
      }
    }
  }

  async #fetchPage(
    query: UsaspendingQuery,
    page: number,
    cursor?: UsaspendingCursor | null,
  ): Promise<UsaspendingPage> {
    const response = await this.#fetchImpl(USASPENDING_SEARCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(buildRequestBody(this.#pageSize, query, page, cursor)),
      signal: AbortSignal.timeout(this.#timeoutMs),
    }).catch((cause: unknown) => {
      // Network failures and timeouts are inherently retryable.
      throw new SourceFetchError("USAspending request failed", {
        transient: true,
        cause,
      });
    });

    if (!response.ok) {
      // 429 and 5xx are transient; any other 4xx is permanent.
      throw new SourceFetchError(
        `USAspending returned HTTP ${response.status}`,
        {
          transient: response.status === 429 || response.status >= 500,
          status: response.status,
        },
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      throw new SourceFetchError(
        "USAspending returned a non-JSON body",
        { transient: false, cause },
      );
    }
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) {
      throw new SourceFetchError("USAspending response failed validation", {
        transient: false,
        cause: parsed.error,
      });
    }
    const meta = parsed.data.page_metadata;
    if (meta === undefined || meta === null) {
      return { rows: parsed.data.results };
    }
    const lastRecordCursor =
      meta.last_record_unique_id !== undefined &&
      meta.last_record_unique_id !== null &&
      typeof meta.last_record_sort_value === "string"
        ? {
            sortValue: meta.last_record_sort_value,
            uniqueId: meta.last_record_unique_id,
          }
        : null;
    return {
      rows: parsed.data.results,
      metadata: {
        ...(meta.hasNext === undefined ? {} : { hasNext: meta.hasNext }),
        lastRecordCursor,
      },
    };
  }
}

