/**
 * Registry of the five candidate discovery sources nominated in the ADCO
 * workbook (Database Sources sheet). Canonical names match the `data_sources`
 * rows seeded in the database — keep them byte-identical.
 */

export type SourceAccessModel =
  | "public_no_auth" // open API / site, no credentials
  | "public_account_required" // free account needed before search
  | "api_key_required" // API key (free tier) required
  | "paid_subscription" // commercial data, paid access
  | "restricted"; // contractually/technically locked; manual research only

export interface SourceCatalogEntry {
  /** true when a programmatic adapter exists in src/sources/. */
  readonly adapterAvailable: boolean;
  readonly accessModel: SourceAccessModel;
  readonly notes: string;
}

export const SOURCE_CATALOG: Readonly<
  Record<string, SourceCatalogEntry>
> = {
  "Online Aerospace Supplier Information System (OASIS)": {
    adapterAvailable: false,
    accessModel: "public_account_required",
    notes:
      "IAQG OASIS certification registry. Free but requires an interactive account + login session before search; scrape/adapter deferred until an account workflow exists.",
  },
  "Performance Review Institute": {
    adapterAvailable: false,
    accessModel: "paid_subscription",
    notes:
      "PRI/Nadcap qualified-processor directories behind paid subscription; no public search surface. Manual research or licensed export only.",
  },
  "System for Award Management (SAM)": {
    adapterAvailable: true,
    accessModel: "api_key_required",
    notes:
      "Entity Management API v4. Free api.sam.gov key is sent only in the X-Api-Key header; SamEntityClient refuses to run without one.",
  },
  USAspending: {
    adapterAvailable: true,
    accessModel: "public_no_auth",
    notes:
      "Federal award spending search API v2, no auth. UsaspendingClient aggregates award rows into per-recipient LeadCandidates.",
  },
  "Boeing Illustrated Parts Catalog (IPC)": {
    adapterAvailable: false,
    accessModel: "restricted",
    notes:
      "Boeing-proprietary parts data; contractual restrictions permit manual_research_only. No automated ingestion permitted.",
  },
};

/** Sources with a ready adapter — the only ones a campaign can query now. */
export function getSearchableSources(): Record<string, SourceCatalogEntry> {
  const searchable: Record<string, SourceCatalogEntry> = {};
  for (const [name, entry] of Object.entries(SOURCE_CATALOG)) {
    if (entry.adapterAvailable) searchable[name] = entry;
  }
  return searchable;
}
