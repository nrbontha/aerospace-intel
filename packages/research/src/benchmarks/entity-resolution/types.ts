/**
 * Entity-resolution benchmark types.
 *
 * The benchmark measures the production identity matchers (snapshot
 * `matchMember` trigram/domain path and the leads ingestion identity
 * resolution path) against a ground-truth set derived from live database
 * reality: catalog companies, known-universe snapshot members, and campaign
 * leads. Everything here is deterministic; only the runner touches the DB.
 */

/** One canonical company as loaded from the database. */
export interface KnownCompany {
  readonly companyId: string;
  readonly legalName: string;
  readonly displayName: string;
  readonly domains: readonly string[];
  readonly aliases: readonly string[];
  /** Primary US facility state code, when known (drives the state bonus). */
  readonly usState: string | null;
}

/** One known-universe snapshot member row. */
export interface MemberRecord {
  readonly snapshotId: string;
  readonly snapshotName: string;
  readonly rawName: string;
  readonly normalizedDomain: string | null;
}

/** One campaign lead row. */
export interface LeadRecord {
  readonly leadId: string;
  readonly rawName: string;
  readonly domain: string | null;
  readonly resolvedCompanyId: string | null;
  readonly status: string;
}

export interface GroundTruth {
  readonly companies: readonly KnownCompany[];
  /** Members of the golden-set + grata snapshots (the rediscovery targets). */
  readonly goldenMembers: readonly MemberRecord[];
  /** Members of the large preliminary-pipeline snapshot. */
  readonly pipelineMembers: readonly MemberRecord[];
  readonly leads: readonly LeadRecord[];
  /** Distinct domains shared by golden and pipeline snapshots. */
  readonly goldenPipelineDomainOverlap: number;
}

/** Perturbation case kinds, grouped by what they are supposed to prove. */
export type ErCaseKind =
  | "exact_name"
  | "legal_suffix_variant"
  | "whitespace_punct_noise"
  | "transposed_order"
  | "city_append"
  | "state_append"
  | "alias_short_name"
  | "former_name_style"
  | "member_replay"
  | "lead_replay"
  | "confusable_negative"
  | "family_sibling";

export interface ErCase {
  readonly caseId: string;
  readonly kind: ErCaseKind;
  readonly rawName: string;
  readonly domain: string | null;
  /**
   * Expected canonical company when the case SHOULD resolve; `null` for
   * negatives (confusables, family siblings) that must match nothing.
   */
  readonly expectedCompanyId: string | null;
  /** Human-readable provenance of the case (which record spawned it). */
  readonly note: string;
  /** Family grouping key for sibling cases (Yulista family etc.). */
  readonly family: string | null;
}

/**
 * Outcome of running one case through a read-only production matcher
 * (`matchMember`). Mirrors `MemberMatch` with the originating case id.
 */
export interface ErOutcome {
  readonly caseId: string;
  readonly matchStatus: "exact" | "probable" | "none";
  readonly confidence: number | null;
  readonly matchedCompanyId: string | null;
}
