/**
 * Shared restricted-source access policy for every research workflow that
 * fetches a URL.
 *
 * A data source flagged `restricted_metadata_only` (the storage enum also
 * carries the precise `accessState` vocabulary, where `paid_subscription`
 * and `restricted` are manual-research-only states) must never be fetched
 * by an automated workflow. Enforcement is host-based: if the fetch target's
 * host matches a restricted/paid source's host, the fetch is rejected unless
 * a trusted caller explicitly passes an override.
 *
 * Identity-based enforcement (fetching only sources explicitly linked to the
 * subject) remains a documented follow-up; both workflows call THIS predicate
 * so the policy lives in exactly one place.
 */

export const RESTRICTED_SOURCE_ACCESS_STATES = [
  "restricted",
  "paid_subscription",
] as const;

export interface SourceAccessPolicySource {
  /** Hostname of the source, when already resolved by the caller. */
  readonly host?: string | null;
  /** Homepage URL — used to derive the host when `host` is absent. */
  readonly homepageUrl?: string | null;
  /** data_sources.access enum value. */
  readonly access?: string | null;
  /** Precise access-state vocabulary carried in source metadata/notes. */
  readonly accessState?: string | null;
}

export interface SourceAccessDecision {
  readonly allowed: boolean;
  /** Populated when not allowed: why the fetch was refused. */
  readonly reason?: "restricted_source";
  readonly message?: string;
}

/** True when this descriptor marks a source as off-limits to automated fetches. */
export function isRestrictedPolicySource(source: SourceAccessPolicySource): boolean {
  return (
    source.access === "restricted_metadata_only" ||
    RESTRICTED_SOURCE_ACCESS_STATES.some((state) => source.accessState === state)
  );
}

function hostFromUrl(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Host of a policy source: explicit host first, then derived from its URL. */
export function sourcePolicyHost(source: SourceAccessPolicySource): string | null {
  const explicit = source.host === null ? null : source.host?.trim().toLowerCase();
  return explicit !== undefined && explicit !== "" && explicit !== null
    ? explicit.replace(/^www\./u, "")
    : hostFromUrl(source.homepageUrl)?.replace(/^www\./u, "") ?? null;
}

/**
 * The one host-policy predicate used by company- and subject-research:
 * is fetching `url` permitted given these known sources and the override flag?
 * Host comparison ignores a leading `www.` and case.
 */
export function decideSourceAccess(
  url: string,
  sources: readonly SourceAccessPolicySource[],
  allowRestrictedOverride = false,
): SourceAccessDecision {
  if (allowRestrictedOverride) return { allowed: true };
  let targetHost: string | null = null;
  try {
    targetHost = new URL(url).hostname.toLowerCase().replace(/^www\./u, "");
  } catch {
    return {
      allowed: false,
      reason: "restricted_source",
      message: "Not fetched: the requested URL is not a valid http(s) address.",
    };
  }
  for (const source of sources) {
    if (!isRestrictedPolicySource(source)) continue;
    if (sourcePolicyHost(source) === targetHost) {
      const label = source.accessState ?? source.access ?? "restricted_metadata_only";
      return {
        allowed: false,
        reason: "restricted_source",
        message: `Identified but not accessed: the matching source is ${label} (manual research only).`,
      };
    }
  }
  return { allowed: true };
}
