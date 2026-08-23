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
 * awards. Small private aerospace manufacturers surface heavily here, but so
 * do distributors, service firms, universities and other federal grantees.
 * Recipient-vs-actual-manufacturer filtering happens downstream (scoring /
 * partner review) — this adapter deliberately does not guess at it.
 */

export const USASPENDING_SEARCH_URL =
  "https://api.usaspending.gov/api/v2/search/spending_by_award/";

/**
 * NAICS seed list for aerospace manufacturing discovery.
 *
 * 336411 Aircraft Manufacturing (airframes)
 * 336412 Aircraft Engine and Engine Parts Manufacturing (power)
 * 336413 Other Aircraft Parts and Auxiliary Equipment Manufacturing
 *        (structural components / auxiliary equipment)
 * 336419 Other Guided Missile and Space Vehicle Parts and Equipment
 * 334511 Search, Detection, Navigation, Guidance, Aeronautical System Mfg
 *        (instrument navigation)
 * 334515 Instrument Manufacturing for Measuring/Testing Electricity &
 *        Electrical Signals (avionics test bench)
 * 334517 Instrument Manufacturing for Physical Property Testing
 * 3364    Aerospace Product and Parts Manufacturing (sector-level rollup;
 *        catches recipients coded only at the parent industry)
 *
 * Seeds for campaign queries — intentionally includes the 3364 rollup so we
 * also reach recipients the census codes coarsely. Not exhaustive: missile/
 * space vehicle primes sit in 336414/336415/336416 and are added per-campaign
 * when that thesis is active.
 */
export const AEROSPACE_NAICS = [
  "336411",
  "336412",
  "336413",
  "336419",
  "334511",
  "334515",
  "334517",
  "3364",
] as const;

/**
 * PSC/FSC seed list focused on aircraft components & support.
 *
 * 1510 Fixed Wing Aircraft          1520 Rotary Wing Aircraft
 * 1560 Airframe Structural Components
 * 1610 Airplane Propellers and Components
 * 1620 Aircraft Wheels and Brakes? -> landing gear components group
 * 1630 Aircraft Landing Gear? -> wheel/brake/control subsystems
 * 1650 Aircraft Hydraulic Systems   1660 Aircraft Environmental Systems
 * 1680 Miscellaneous Aircraft Components and Parts
 * 1730 Aircraft Ground Serving Equipment
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
] as const;

const MIN_PAGE_DELAY_MS = 1_000;
const DEFAULT_MAX_PAGES = 5;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 2;

/** USAspending renders amounts as strings like "$1,234.56" or null. */
function parseAmountUsd(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const cleaned = String(raw).replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

const rowSchema = z.object({
  "Recipient Name": z.string().min(1),
  "Recipient UEI": z.union([z.string(), z.null()]).optional(),
  "Recipient UEI Count": z
    .union([z.number(), z.string(), z.null()])
    .optional(),
  "Award Amount": z
    .union([z.string(), z.number(), z.null()])
    .transform(parseAmountUsd),
  "Awarding Agency": z.union([z.string(), z.null()]).optional(),
  "Start Date": z.union([z.string(), z.null()]).optional(),
  Description: z.union([z.string(), z.null()]).optional(),
});

const responseSchema = z.object({
  results: z.array(rowSchema),
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
}
function buildRequestBody(
  pageSize: number,
  query: UsaspendingQuery,
  page: number,
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
  return { filters, fields: [...FIELDS], limit: pageSize, page };
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
   */
  async searchRecipients(query: UsaspendingQuery): Promise<LeadCandidate[]> {
    const byRecipient = new Map<string, AggRow>();
    let page = 1;
    while (page <= this.#maxPages) {
      const rows = await this.#fetchPageWithRetry(query, page);
      for (const row of rows) {
        const key = `${row["Recipient Name"]}|${row["Recipient UEI"] ?? ""}`;
        const agg = byRecipient.get(key) ?? { totalUsd: 0, count: 0 };
        agg.totalUsd += row["Award Amount"] ?? 0;
        agg.count += 1;
        const start = row["Start Date"];
        if (
          start &&
          (agg.freshestDate === undefined || start > agg.freshestDate)
        ) {
          agg.freshestDate = start;
        }
        byRecipient.set(key, agg);
      }
      // Stop when the API returns a partial page (end of results).
      if (rows.length < this.#pageSize) break;
      if (page < this.#maxPages) await this.#sleep(this.#requestDelayMs);
      page += 1;
    }

    return [...byRecipient.entries()].map(([key, agg]) => {
      const [rawNameKey, ueiKey] = key.split("|");
      const rawName = rawNameKey!;
      const uei = ueiKey === "" ? undefined : (ueiKey as string);
      return {
        rawName,
        ...(uei ? { uei } : {}),
        awardCount: agg.count,
        totalAwardValueUsd: agg.totalUsd,
        ...(agg.freshestDate !== undefined
          ? { freshestAwardDate: agg.freshestDate }
          : {}),
        source: "usaspending" as const,
        sourceLocator: `usaspending://spending_by_award?${
          new URLSearchParams(
            uei
              ? [["recipient_name", rawName], ["uei", uei]]
              : [["recipient_name", rawName]],
          ).toString()
        }`,
      };
    });
  }

  async #fetchPageWithRetry(
    query: UsaspendingQuery,
    page: number,
  ): Promise<z.output<typeof rowSchema>[]> {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await this.#fetchPage(query, page);
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
  ): Promise<z.output<typeof rowSchema>[]> {
    const response = await this.#fetchImpl(USASPENDING_SEARCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(buildRequestBody(this.#pageSize, query, page)),
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
    return parsed.data.results;
  }
}
