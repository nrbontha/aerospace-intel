import { z } from "zod";

import type { LeadCandidate } from "./types.js";
import { SourceApiKeyMissingError, SourceFetchError } from "./types.js";

/**
 * SAM.gov entity-information search client.
 *
 * Endpoint: GET https://api.sam.gov/entity-information/v3/search
 * Access model: api_key_required — SAM requires `api_key` as a query param.
 * Without a key we throw {@link SamApiKeyMissingError} and never fabricate,
 * degrade, or hit the API anonymously.
 */

export const SAM_ENTITY_SEARCH_URL =
  "https://api.sam.gov/entity-information/v3/search";

export class SamApiKeyMissingError extends SourceApiKeyMissingError {
  override readonly name: string = "SamApiKeyMissingError";
  constructor() {
    super("SAM.gov");
  }
}

const MAX_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 2;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_TIMEOUT_MS = 20_000;

export interface SamSearchQuery {
  /** Free-text entity name / keyword search (`q`). */
  readonly q?: string;
  readonly uei?: string;
  readonly cageCode?: string;
  /** Two-letter state filter. */
  readonly state?: string;
  readonly naicsCodes?: readonly string[];
  readonly pscCodes?: readonly string[];
}

export interface SamClientOptions {
  readonly apiKey?: string; // SAM "public" API key (api.sam.gov account)
  readonly maxPages?: number; // default 2 — budget bound
  readonly pageSize?: number; // capped at the API's 100-record page size
  readonly timeoutMs?: number; // default 20s per request
  readonly fetchImpl?: typeof fetch; // injectable for tests
}

// SAM v3 search record. Fields beyond these are ignored (passthrough) so an
// upstream schema addition never breaks ingestion, but required identity
// fields are enforced.
const recordSchema = z
  .object({
    ueiUEI: z.string().min(1),
    legalBusinessName: z.string().min(1),
    cageCode: z.string().optional(),
    physicalAddress: z
      .object({
        addressLine1: z.string().optional(),
        city: z.string().optional(),
        stateOrProvinceCode: z.string().optional(),
        zipCode: z.string().optional(),
      })
      .nullish(),
    naicsCodes: z.array(z.string()).optional(),
    pscCodes: z.array(z.string()).optional(),
    // Some key tiers return registration status instead of active flags.
    registrationStatus: z.string().optional(),
  })
  .passthrough();

const responseSchema = z.object({
  totalRecords: z.number(),
  records: z.array(recordSchema),
});

function toLeadCandidate(
  record: z.output<typeof recordSchema>,
): LeadCandidate {
  const address = record.physicalAddress ?? undefined;
  const params = new URLSearchParams({ uei: record.ueiUEI });
  return {
    rawName: record.legalBusinessName,
    uei: record.ueiUEI,
    ...(record.cageCode ? { cageCode: record.cageCode } : {}),
    ...(address?.addressLine1 ? { addressLine: address.addressLine1 } : {}),
    ...(address?.city ? { city: address.city } : {}),
    ...(address?.stateOrProvinceCode
      ? { state: address.stateOrProvinceCode }
      : {}),
    ...(address?.zipCode ? { zip: address.zipCode } : {}),
    ...(record.naicsCodes?.length ? { naics: [...record.naicsCodes] } : {}),
    ...(record.pscCodes?.length ? { pscCodes: [...record.pscCodes] } : {}),
    awardCount: 0, // registry data: no awards observed in this source
    totalAwardValueUsd: 0,
    source: "sam_gov",
    sourceLocator: `sam://entity-information/v3/search?${params.toString()}`,
  };
}

export class SamEntityClient {
  readonly #apiKey: string | undefined;
  readonly #maxPages: number;
  readonly #pageSize: number;
  readonly #timeoutMs: number;
  readonly #fetchImpl: typeof fetch;

  constructor(options: SamClientOptions = {}) {
    this.#apiKey = options.apiKey;
    this.#maxPages = Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES);
    this.#pageSize = Math.min(MAX_PAGE_SIZE, options.pageSize ?? DEFAULT_PAGE_SIZE);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Search registered entities. Throws {@link SamApiKeyMissingError}
   * immediately when no key is configured — before any network I/O.
   */
  async search(query: SamSearchQuery): Promise<{
    totalRecords: number;
    leads: LeadCandidate[];
  }> {
    if (!this.#apiKey) throw new SamApiKeyMissingError();

    let totalRecords = 0;
    const leads: LeadCandidate[] = [];
    let page = 1;
    while (page <= this.#maxPages) {
      const result = await this.#fetchPage(query, page);
      totalRecords = result.totalRecords;
      leads.push(...result.records.map(toLeadCandidate));
      const seen = page * this.#pageSize;
      if (result.records.length < this.#pageSize || seen >= result.totalRecords)
        break;
      page += 1;
    }
    return { totalRecords, leads };
  }

  async #fetchPage(
    query: SamSearchQuery,
    page: number,
  ): Promise<{ totalRecords: number; records: z.output<typeof recordSchema>[] }> {
    const params = new URLSearchParams({
      api_key: this.#apiKey!,
      page: String(page),
      size: String(this.#pageSize),
    });
    if (query.q) params.set("q", query.q);
    if (query.uei) params.set("ueiUEI", query.uei);
    if (query.cageCode) params.set("cageCode", query.cageCode);
    if (query.state) params.set("stateOfIncorporation", query.state);
    if (query.naicsCodes?.length) params.set("naicsCode", query.naicsCodes.join(","));
    if (query.pscCodes?.length) params.set("pscCode", query.pscCodes.join(","));

    const response = await this.#fetchImpl(
      `${SAM_ENTITY_SEARCH_URL}?${params.toString()}`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(this.#timeoutMs),
      },
    ).catch((cause: unknown) => {
      // Network failures and timeouts are inherently retryable.
      throw new SourceFetchError("SAM.gov request failed", {
        transient: true,
        cause,
      });
    });

    if (!response.ok) {
      throw new SourceFetchError(`SAM.gov returned HTTP ${response.status}`, {
        transient: response.status === 429 || response.status >= 500,
        status: response.status,
      });
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      throw new SourceFetchError("SAM.gov returned a non-JSON body", {
        transient: false,
        cause,
      });
    }
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) {
      throw new SourceFetchError("SAM.gov response failed validation", {
        transient: false,
        cause: parsed.error,
      });
    }
    return parsed.data;
  }
}
