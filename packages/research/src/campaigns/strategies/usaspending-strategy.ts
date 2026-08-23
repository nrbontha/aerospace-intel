import { z } from "zod";

import {
  AEROSPACE_NAICS,
  AIRCRAFT_COMPONENT_PSC,
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
 *    ({ naics?, psc?, timePeriod? }) run a bounded recipient search
 *    (maxPages 2 per item) and propose one `company` frontier item per
 *    aggregated recipient with estimatedCostUsd 0 (public API, no model
 *    spend).
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
  });

/** Trailing-365-day window ending "today" (UTC date strings). */
function defaultTimePeriod(now: Date): { startDate: string; endDate: string } {
  const end = now.toISOString().slice(0, 10);
  const start = new Date(now.getTime() - 364 * 24 * 60 * 60 * 1_000)
    .toISOString()
    .slice(0, 10);
  return { startDate: start, endDate: end };
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
   * A USAspending source item expands to exactly one default query item.
   * The normalizedValue is constant so re-processing is deduped upstream;
   * the time window is recomputed at proposal time by design.
   */
  #expandSourceItem(item: FrontierItemView): FrontierProposal[] {
    const identity = `${item.normalizedValue}`.trim().toLowerCase();
    if (!identity.includes("usaspending")) return [];
    return [
      {
        itemType: "query",
        normalizedValue: USASPENDING_DEFAULT_QUERY_VALUE,
        estimatedCostUsd: 0,
        priority: 5,
        payload: {
          source: "usaspending",
          naics: [...AEROSPACE_NAICS],
          psc: [...AIRCRAFT_COMPONENT_PSC],
          timePeriod: defaultTimePeriod(new Date()),
        },
      },
    ];
  }

  /**
   * Run a bounded recipient search for a USAspending-shaped query payload.
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

    const candidates = await this.#client.searchRecipients({
      ...(query.naics === undefined ? {} : { naicsCodes: query.naics }),
      ...(query.psc === undefined ? {} : { pscCodes: query.psc }),
      timePeriod: resolveTimePeriod(query.timePeriod),
    });
    return candidates.map(leadCandidateToProposal);
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
