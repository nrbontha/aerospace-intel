/**
 * Normalized lead-candidate output shared by all discovery source adapters.
 *
 * A `LeadCandidate` is the *only* contract adapters owe the rest of the
 * pipeline: everything else (pagination, auth, rate limits, error taxonomy)
 * is private to each adapter.
 */

export type LeadSource = "usaspending" | "sam_gov";

export interface LeadCandidate {
  /** Legal or dba recipient/entity name exactly as the source reports it. */
  readonly rawName: string;
  /** Best-guess primary web domain, when derivable from the record. */
  readonly domain?: string;
  /** SAM Unique Entity Identifier. */
  readonly uei?: string;
  /** SAM Commercial and Government Entity (CAGE) code. */
  readonly cageCode?: string;
  readonly addressLine?: string;
  readonly city?: string;
  /** Two-letter state/province code where the source provides one. */
  readonly state?: string;
  readonly zip?: string;
  /** NAICS codes asserted by the source for this entity (no inference here). */
  readonly naics?: string[];
  readonly pscCodes?: string[];
  /**
   * Award records observed in this query window. Sources without award data
   * (e.g. SAM.gov registry search) report 0 — absence of awards is real data,
   * not missingness.
   */
  readonly awardCount: number;
  readonly totalAwardValueUsd: number;
  /** ISO date (YYYY-MM-DD) of the most recent award in the window. */
  readonly freshestAwardDate?: string;
  readonly source: LeadSource;
  /**
   * Stable locator identifying which API call/record produced this candidate,
   * for provenance replay. Scheme-prefixed, deterministic per record:
   * e.g. `usaspending://spending_by_award?recipient_name=...&uei=...`.
   */
  readonly sourceLocator: string;
}

/** Base class for fetch/validation failures raised by source adapters. */
export class SourceFetchError extends Error {
  override readonly name: string = "SourceFetchError";
  /**
   * true → retrying later may succeed (HTTP 429/5xx, network/timeout).
   * false → the request itself is wrong (4xx other than 429) or the response
   * shape violates the schema; retrying unchanged will not help.
   */
  readonly transient: boolean;
  readonly status?: number;

  constructor(
    message: string,
    options: { transient: boolean; status?: number; cause?: unknown } = {
      transient: false,
    },
  ) {
    super(message);
    this.transient = options.transient;
    if (options.status !== undefined) this.status = options.status;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/** Raised when an adapter requires credentials that were not supplied. */
export class SourceApiKeyMissingError extends SourceFetchError {
  override readonly name: string = "SourceApiKeyMissingError";
  constructor(sourceName: string) {
    super(
      `${sourceName} requires an API key; none was configured. Refusing to fabricate or degrade results.`,
      { transient: false },
    );
  }
}
