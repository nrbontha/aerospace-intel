/**
 * Pure verdict math for the blind-discovery benchmark.
 *
 * The runner attributes each produced lead to a known entity (or not) using
 * the production matcher semantics; this module only counts and rates.
 */
import { normalizeLegalName } from "@asi/database";

/** A produced lead with its attribution, as computed by the runner. */
export interface AttributedLead {
  readonly rawName: string;
  readonly domain: string | null;
  /** Catalog company this lead resolved/probably matched, when any. */
  readonly matchedCompanyId: string | null;
  /** Exact-match kind: "exact" (auto-merged) or "probable" (review). */
  readonly matchKind: "exact" | "probable" | null;
  /**
   * Known-universe member (golden/pipeline snapshot) identity this lead was
   * attributed to via name/domain similarity, when any.
   */
  readonly matchedMemberKey: string | null;
}

export interface DiscoveryVerdict {
  readonly producedLeads: number;
  /** Leads attributed to a known company OR a known-universe member. */
  readonly knownRediscoveries: number;
  readonly rediscoveredCompanies: number;
  readonly rediscoveredMembers: number;
  /** Leads matching nothing known. */
  readonly novelLeads: number;
  /** Produced leads whose normalized identity existed in prior campaigns. */
  readonly duplicatesOfPriorCampaigns: number;
  readonly duplicateRate: number | null;
}

/**
 * Normalized lead identity used for cross-campaign duplicate measurement.
 * Mirrors the ingest dedupe value part (name + domain), minus the campaign
 * scoping so overlap ACROSS campaigns becomes measurable.
 */
export function leadIdentityKey(rawName: string, domain: string | null): string {
  const name = normalizeLegalName(rawName);
  const d = domain === null ? "" : domain.trim().toLowerCase();
  return `${name}|${d}`;
}

export function classifyDiscovery(
  leads: readonly AttributedLead[],
  priorCampaignKeys: ReadonlySet<string>,
): DiscoveryVerdict {
  let rediscoveredCompanies = 0;
  let rediscoveredMembers = 0;
  let novelLeads = 0;
  let duplicates = 0;

  for (const lead of leads) {
    if (lead.matchedCompanyId !== null) rediscoveredCompanies += 1;
    else if (lead.matchedMemberKey !== null) rediscoveredMembers += 1;
    else novelLeads += 1;
    if (priorCampaignKeys.has(leadIdentityKey(lead.rawName, lead.domain))) {
      duplicates += 1;
    }
  }

  return {
    producedLeads: leads.length,
    knownRediscoveries: rediscoveredCompanies + rediscoveredMembers,
    rediscoveredCompanies,
    rediscoveredMembers,
    novelLeads,
    duplicatesOfPriorCampaigns: duplicates,
    duplicateRate:
      leads.length > 0 ? Number((duplicates / leads.length).toFixed(4)) : null,
  };
}
