import { z } from "zod";

import {
  AEROSPACE_NAICS,
  AIRCRAFT_COMPONENT_PSC,
  USASPENDING_API_MAX_PAGE,
  UsaspendingClient,
  type LeadCandidate,
} from "../../sources/index.js";
import type {
  CampaignView,
  DiscoveryStrategy,
  FrontierItemView,
  FrontierProposal,
} from "../types.js";

/**
 * Concrete discovery strategy backed by the USAspending award-search client.
 *
 * Frontier contract:
 *  - `source` items naming USAspending expand to ONE deterministic default
 *    `query` item (aerospace NAICS/PSC seed lists, trailing-365-day window).
 *  - `query` items whose payload carries USAspending query parameters
 *    ({ naics?, psc?, timePeriod?, resumePage? }) run a bounded recipient
 *    search (maxPages 2 per item) and propose one `company` frontier item
 *    per aggregated recipient with estimatedCostUsd 0 (public API, no
 *    model spend).
 *  - When more result pages remain, the query item additionally proposes a
 *    SELF-continuation: same itemType + normalizedValue, payload advanced
 *    to `resumePage`. The frontier runner interprets that as "requeue me
 *    with this payload" instead of completing, so one query item walks the
 *    entire result stream slice by slice — including past the API's
 *    50k-record page ceiling via the sequential cursor. Clients without
 *    pagination support (test/agent stubs) degrade to single-slice
 *    behavior with no continuation.
 *
 * Proposals are deterministic and idempotent: `normalizedValue` is derived
 * only from stable recipient identity (UEI, else domain, else normalized
 * legal name), so the runner's idempotency-key dedupe collapses re-runs.
 */

/** Pagination bound per frontier item — public API politeness budget. */
export const USASPENDING_MAX_PAGES_PER_ITEM = 2;

/** Stable normalizedValue of the default expansion query. */
export const USASPENDING_DEFAULT_QUERY_VALUE =
  "usaspending:aerospace-components-default";

/** Structural client surface the strategy needs (injectable for tests). */
export interface UsaspendingSearchClient {
  searchRecipients(query: {
    naicsCodes?: readonly string[];
    pscCodes?: readonly string[];
    timePeriod: { startDate: string; endDate: string };
  }): Promise<LeadCandidate[]>;
  /**
   * Pagination-aware variant used for cursor-based full coverage; optional
   * so stub clients (agents, tests) keep working as single-slice searches.
   */
  searchRecipientsPage?(query: {
    naicsCodes?: readonly string[];
    pscCodes?: readonly string[];
    timePeriod: { startDate: string; endDate: string };
    startPage?: number;
    cursor?: { sortValue: string; uniqueId: number } | null;
  }): Promise<{
    leads: LeadCandidate[];
    nextPage: number | null;
    cursor?: { sortValue: string; uniqueId: number } | null;
  }>;
}

export interface UsaspendingStrategyOptions {
  /** Injectable client; defaults to a real client bounded to 2 pages. */
  readonly client?: UsaspendingSearchClient;
}

const timePeriodSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/**
 * Query-item payload shape. Unknown keys are ignored so hand-authored query
 * items with extra metadata still parse; an item is treated as a USAspending
 * query when at least one of naics/psc/timePeriod is present.
 */
const usaspendingQueryPayloadSchema = z
  .object({
    naics: z.array(z.string().trim().min(1)).optional(),
    psc: z.array(z.string().trim().min(1)).optional(),
    timePeriod: z.union([timePeriodSchema, z.array(timePeriodSchema)]).optional(),
    // Cursor for multi-slice full coverage: the page this slice starts
    // from. Pages past the API's record ceiling are valid only when the
    // payload carries the sequential anchor.
    resumePage: z.number().int().min(1).optional(),
    cursorSortValue: z.string().optional(),
    cursorUniqueId: z.number().int().optional(),
  })
  .refine(
    (value) =>
      value.resumePage === undefined ||
      value.resumePage <= USASPENDING_API_MAX_PAGE ||
      (value.cursorSortValue !== undefined && value.cursorUniqueId !== undefined),
    {
      message:
        "resumePage past the API ceiling requires cursorSortValue and cursorUniqueId",
    },
  );

/** Trailing-365-day window ending "today" (UTC date strings). */
function defaultTimePeriod(now: Date): { startDate: string; endDate: string } {
  const end = now.toISOString().slice(0, 10);
  const start = new Date(now.getTime() - 364 * 24 * 60 * 60 * 1_000)
    .toISOString()
    .slice(0, 10);
  return { startDate: start, endDate: end };
}

/**
 * Split [startDate, endDate] into contiguous calendar-month windows
 * (clamped to the enclosing range, inclusive). A trailing-365-day window
 * yields 12-13 buckets; each stays far below USAspending's sorted-access
 * limits so every monthly query can be walked to exhaustion.
 */
export function monthWindows(
  startDate: string,
  endDate: string,
): Array<{ startDate: string; endDate: string }> {
  const end = new Date(`${endDate}T00:00:00Z`);
  const windows: Array<{ startDate: string; endDate: string }> = [];
  let cursor = new Date(`${startDate}T00:00:00Z`);
  while (cursor <= end) {
    const monthEnd = new Date(
      Date.UTC(
        cursor.getUTCFullYear(),
        cursor.getUTCMonth() + 1,
        0, // last day of this month
      ),
    );
    const winStart = cursor.toISOString().slice(0, 10);
    const winEnd = (monthEnd < end ? monthEnd : end).toISOString().slice(0, 10);
    windows.push({ startDate: winStart, endDate: winEnd });
    cursor = new Date(
      Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1),
    );
  }
  return windows;
}

/** Collapse whitespace and lowercase — stable name identity without UEI/domain. */
function normalizeNameIdentity(rawName: string): string {
  return rawName.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Deterministic, collision-resistant normalizedValue for one recipient. */
function recipientNormalizedValue(candidate: LeadCandidate): string {
  if (candidate.uei !== undefined && candidate.uei !== "") {
    return `uei:${candidate.uei.toUpperCase()}`;
  }
  if (candidate.domain !== undefined && candidate.domain !== "") {
    return `domain:${candidate.domain.trim().toLowerCase()}`;
  }
  return `name:${normalizeNameIdentity(candidate.rawName)}`;
}

/** Map one aggregated source candidate onto a `company` frontier proposal. */
function leadCandidateToProposal(candidate: LeadCandidate): FrontierProposal {
  return {
    itemType: "company",
    normalizedValue: recipientNormalizedValue(candidate),
    estimatedCostUsd: 0,
    payload: {
      source: candidate.source,
      rawName: candidate.rawName,
      ...(candidate.domain === undefined ? {} : { domain: candidate.domain }),
      ...(candidate.uei === undefined ? {} : { uei: candidate.uei }),
      ...(candidate.cageCode === undefined ? {} : { cageCode: candidate.cageCode }),
      ...(candidate.city === undefined ? {} : { city: candidate.city }),
      ...(candidate.state === undefined ? {} : { state: candidate.state }),
      ...(candidate.naics === undefined ? {} : { naics: [...candidate.naics] }),
      awardCount: candidate.awardCount,
      totalAwardValueUsd: candidate.totalAwardValueUsd,
      ...(candidate.freshestAwardDate === undefined
        ? {}
        : { freshestAwardDate: candidate.freshestAwardDate }),
      sourceLocator: candidate.sourceLocator,
    },
  };
}

export class UsaspendingDiscoveryStrategy implements DiscoveryStrategy {
  readonly id = "usaspending";

  readonly #client: UsaspendingSearchClient;

  constructor(options: UsaspendingStrategyOptions = {}) {
    this.#client =
      options.client ??
      new UsaspendingClient({ maxPages: USASPENDING_MAX_PAGES_PER_ITEM });
  }

  seedsSupported(): boolean {
    // Relevance is decided per item below, not by the campaign seed set.
    return true;
  }

  async proposeFrontierItems(
    _campaign: CampaignView,
    item: FrontierItemView,
  ): Promise<FrontierProposal[]> {
    if (item.itemType === "source") return this.#expandSourceItem(item);
    if (item.itemType === "query") return this.#runQueryItem(item);
    return [];
  }

  /**
   * A USAspending source item expands to one default query item PER MONTH
   * of the trailing-365-day window. Sorted API access degrades at large
   * result volumes (spurious hasNext:false around the internal 10k-record
   * window; hard 50k-record page-param ceiling), so a single year-long
   * window cannot be fully walked. Monthly windows keep every crawl far
   * below all limits while the union covers the whole period.
   * normalizedValues are distinct per month so re-expansion dedupes.
   */
  #expandSourceItem(item: FrontierItemView): FrontierProposal[] {
    const identity = `${item.normalizedValue}`.trim().toLowerCase();
    if (!identity.includes("usaspending")) return [];
    const { startDate, endDate } = defaultTimePeriod(new Date());
    return monthWindows(startDate, endDate).map((timePeriod) => ({
      itemType: "query" as const,
      normalizedValue: `${USASPENDING_DEFAULT_QUERY_VALUE}:${timePeriod.startDate.slice(0, 7)}`,
      estimatedCostUsd: 0,
      priority: 5,
      payload: {
        source: "usaspending",
        naics: [...AEROSPACE_NAICS],
        psc: [...AIRCRAFT_COMPONENT_PSC],
        timePeriod,
      },
    }));
  }

  /**
   * Run a bounded recipient search slice for a USAspending-shaped query
   * payload, resuming at payload.resumePage when present. When the client
   * reports more pages, proposes a self-continuation (same itemType +
   * normalizedValue) whose payload advances resumePage — the frontier
   * runner requeues the item with that payload instead of completing it.
   * Source/client failures propagate — the runner owns retry/backoff.
   */
  async #runQueryItem(item: FrontierItemView): Promise<FrontierProposal[]> {
    const parsed = usaspendingQueryPayloadSchema.safeParse(item.payload ?? {});
    if (!parsed.success) return [];
    const query = parsed.data;
    // Not a USAspending query: no recognizable query parameters at all.
    if (
      query.naics === undefined &&
      query.psc === undefined &&
      query.timePeriod === undefined
    ) {
      return [];
    }

    // Bake the concrete window once so every continuation slice searches
    // the same period instead of drifting with the calendar.
    const timePeriod = resolveTimePeriod(query.timePeriod);
    const startPage = query.resumePage ?? 1;
    const cursor =
      query.cursorSortValue !== undefined && query.cursorUniqueId !== undefined
        ? { sortValue: query.cursorSortValue, uniqueId: query.cursorUniqueId }
        : null;
    const search = {
      ...(query.naics === undefined ? {} : { naicsCodes: query.naics }),
      ...(query.psc === undefined ? {} : { pscCodes: query.psc }),
      timePeriod,
    };

    if (this.#client.searchRecipientsPage === undefined) {
      // Stub clients (agents/tests): legacy single-slice behavior.
      const candidates = await this.#client.searchRecipients(search);
      return candidates.map(leadCandidateToProposal);
    }

    const result = await this.#client.searchRecipientsPage({
      ...search,
      startPage,
      cursor,
    });
    const proposals = result.leads.map(leadCandidateToProposal);
    if (result.nextPage !== null) {
      // The client only reports nextPage when it holds a valid way to
      // resume: page-param traversal below the ceiling, or a sequential
      // cursor past it.
      proposals.push({
        itemType: "query",
        normalizedValue: item.normalizedValue,
        estimatedCostUsd: 0,
        priority: 5,
        payload: {
          source: "usaspending",
          ...(query.naics === undefined ? {} : { naics: [...query.naics] }),
          ...(query.psc === undefined ? {} : { psc: [...query.psc] }),
          timePeriod,
          resumePage: result.nextPage,
          ...(result.cursor === undefined || result.cursor === null
            ? {}
            : {
                cursorSortValue: result.cursor.sortValue,
                cursorUniqueId: result.cursor.uniqueId,
              }),
        },
      });
    }
    return proposals;
  }
}

/**
 * Pick the effective search window: the last period of an explicit list,
 * an explicit singleton, or the trailing-365-day default.
 */
function resolveTimePeriod(
  timePeriod: z.infer<typeof usaspendingQueryPayloadSchema>["timePeriod"],
): { startDate: string; endDate: string } {
  if (timePeriod === undefined) return defaultTimePeriod(new Date());
  return Array.isArray(timePeriod)
    ? (timePeriod.at(-1) ?? defaultTimePeriod(new Date()))
    : timePeriod;
}
