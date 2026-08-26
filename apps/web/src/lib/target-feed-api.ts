import type {
  CandidateDto,
  CandidateStatus,
  EffectiveTier,
  FeedbackCreate,
  FeedbackDto,
  NoveltyStatus,
  ResearchQuestionCreate,
  ResearchQuestionDto,
  ScoreRecordDto,
  TierOverride,
} from "@asi/contracts";

import { apiJson } from "@/components/csrf-client";

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

export type PageMeta = Readonly<{
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}>;

export type PageEnvelope<T> = Readonly<{ data: T[]; meta?: PageMeta }>;
export type SuccessEnvelope<T> = Readonly<{ data: T }>;

function envelopeError(payload: unknown, status: number): Error {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof payload.error === "object" &&
    payload.error !== null &&
    "message" in payload.error &&
    typeof payload.error.message === "string"
  ) {
    return new Error(payload.error.message);
  }
  return new Error(`Request failed (${status}).`);
}

export async function fetchEnvelope<T>(
  url: string,
  signal: AbortSignal,
): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "same-origin",
    signal,
  });
  const payload: unknown = await response.json();
  if (!response.ok) throw envelopeError(payload, response.status);
  return payload as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  return apiJson<T>(url, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

export type CandidateFilterParams = Readonly<{
  status?: CandidateStatus | "";
  tier?: EffectiveTier | "";
  noveltyStatus?: NoveltyStatus | "";
  minFit?: number | "";
  maxFit?: number | "";
  minNovelty?: number | "";
  maxNovelty?: number | "";
  minConfidence?: number | "";
  maxConfidence?: number | "";
  minActionability?: number | "";
  maxActionability?: number | "";
  page?: number;
  pageSize?: number;
}>;

export function candidateQueryString(params: CandidateFilterParams): string {
  const query = new URLSearchParams();
  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 25;
  query.set("page", String(page));
  query.set("pageSize", String(pageSize));
  if (params.status) query.set("status", params.status);
  if (params.tier) query.set("tier", params.tier);
  if (params.noveltyStatus) query.set("noveltyStatus", params.noveltyStatus);
  for (const key of [
    "minFit",
    "maxFit",
    "minNovelty",
    "maxNovelty",
    "minConfidence",
    "maxConfidence",
    "minActionability",
    "maxActionability",
  ] as const) {
    const value = params[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      query.set(key, String(value));
    }
  }
  return query.toString();
}

export async function listCandidates(
  params: CandidateFilterParams,
  signal: AbortSignal,
): Promise<PageEnvelope<CandidateDto>> {
  return fetchEnvelope(
    `/api/v1/candidates?${candidateQueryString(params)}`,
    signal,
  );
}

/**
 * Download a candidates export as a file. Mirrors the shared CatalogExport
 * download mechanism; only predicates the export API accepts today are
 * forwarded (text search via `query`). Extend `filters` in lockstep with
 * exportQuerySchema when server-side tier/axis filters land.
 */
export async function downloadCandidateExport(
  format: "csv" | "jsonl",
  filters: { readonly q?: string } = {},
): Promise<void> {
  const params = new URLSearchParams({ entity: "candidates", format });
  if (filters.q !== undefined && filters.q.trim() !== "") {
    params.set("query", filters.q.trim());
  }
  const response = await fetch(`/api/v1/exports?${params}`, {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error(`Export failed (${response.status}).`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const matched = response.headers
    .get("content-disposition")
    ?.match(/filename="([^"]+)"/);
  link.href = url;
  link.download = matched?.[1] ?? `candidates.${format}`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export type CandidateFeatureSnapshot = Readonly<{
  id: string;
  schemaVersion: string;
  features: Record<string, unknown>;
  contentSha256: string;
  createdAt: string;
}>;

export type CandidateDetail = Readonly<{
  candidate: CandidateDto;
  scores: ScoreRecordDto[];
  featureSnapshot: CandidateFeatureSnapshot | null;
}>;

export async function getCandidateDetail(
  candidateId: string,
  signal: AbortSignal,
): Promise<CandidateDetail> {
  const envelope = await fetchEnvelope<SuccessEnvelope<CandidateDetail>>(
    `/api/v1/candidates/${candidateId}`,
    signal,
  );
  return envelope.data;
}

/** Manual status change. The API accepts the bookkeeping targets plus
 * queued_research ("Needs More Research"); research-lifecycle routing
 * (in_research, research_ready, partner_review) stays engine-owned. */
export async function updateCandidateStatus(
  candidateId: string,
  status: Extract<
    CandidateStatus,
    "archived" | "rejected" | "hold" | "shortlist" | "queued_research"
  >,
): Promise<Readonly<{ id: string; status: CandidateStatus }>> {
  const envelope = await apiJson<
    SuccessEnvelope<Readonly<{ id: string; status: CandidateStatus }>>
  >(`/api/v1/candidates/${candidateId}/status`, {
    body: JSON.stringify({ status }),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
  return envelope.data;
}

/** Human tier override (REDESIGN_PLAN §2.1). Audited server-side: writes
 * tier_override + investment feedback + a candidate.tier_overridden audit
 * event; engine routing never clobbers a human tier. */
export type TierMutationResult = Readonly<{
  id: string;
  status: CandidateStatus;
  tierOverride: TierOverride | null;
  tierSource: "engine" | "human";
  effectiveTier: EffectiveTier;
}>;

export async function setCandidateTier(
  candidateId: string,
  tier: TierOverride,
  note?: string,
): Promise<TierMutationResult> {
  const envelope = await postJson<SuccessEnvelope<TierMutationResult>>(
    `/api/v1/candidates/${candidateId}/tier`,
    {
      tier,
      ...(note === undefined || note.trim() === ""
        ? {}
        : { note: note.trim() }),
    },
  );
  return envelope.data;
}

// ---------------------------------------------------------------------------
// Company identity enrichment
// ---------------------------------------------------------------------------

/**
 * Minimal identity slice of GET /api/v1/companies/[id] used to label
 * candidate rows. The candidates list API does not join company identity —
 * this is the documented workaround until a batch endpoint exists.
 */
export type CompanyIdentity = Readonly<{
  name: string | null;
  domain: string | null;
  headquartersCountryCode: string | null;
}>;

type RawCompanySlice = Readonly<{
  legalName?: unknown;
  displayName?: unknown;
  commonName?: unknown;
  headquartersCountryCode?: unknown;
  domains?: unknown;
}>;

const identityCache = new Map<
  string,
  { value: CompanyIdentity; expires: number }
>();
const IDENTITY_TTL_MS = 60_000;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function identityFromCompany(company: RawCompanySlice): CompanyIdentity {
  const name =
    text(company.displayName) ??
    text(company.commonName) ??
    text(company.legalName);
  let domain: string | null = null;
  if (Array.isArray(company.domains)) {
    const primary = company.domains.find(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null && "domain" in entry,
    );
    if (primary !== undefined) {
      const candidates = company.domains.filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" &&
          entry !== null &&
          text(entry.domain) !== null,
      );
      const preferred =
        candidates.find((entry) => entry.isPrimary === true) ??
        candidates.find((entry) => entry.verifiedAt != null) ??
        primary;
      domain = text(preferred.domain);
    }
  }
  return {
    name,
    domain,
    headquartersCountryCode: text(company.headquartersCountryCode),
  };
}

export async function getCompanyIdentity(
  companyId: string,
  signal: AbortSignal,
): Promise<CompanyIdentity> {
  const cached = identityCache.get(companyId);
  if (cached !== undefined && cached.expires > Date.now()) return cached.value;
  try {
    const envelope = await fetchEnvelope<SuccessEnvelope<RawCompanySlice>>(
      `/api/v1/companies/${companyId}`,
      signal,
    );
    const value = identityFromCompany(envelope.data);
    identityCache.set(companyId, {
      value,
      expires: Date.now() + IDENTITY_TTL_MS,
    });
    return value;
  } catch (error) {
    if (signal.aborted) throw error;
    // A missing/unreadable company must not break the whole table row.
    return { name: null, domain: null, headquartersCountryCode: null };
  }
}

export function primeCompanyIdentity(
  companyId: string,
  identity: CompanyIdentity,
): void {
  identityCache.set(companyId, {
    value: identity,
    expires: Date.now() + IDENTITY_TTL_MS,
  });
}

/** Resolve identities for every unique companyId on one page, in parallel. */
export async function resolveCompanyIdentities(
  companyIds: readonly string[],
  signal: AbortSignal,
): Promise<Map<string, CompanyIdentity>> {
  const unique = [...new Set(companyIds)];
  const entries = await Promise.all(
    unique.map(async (companyId) => {
      const identity = await getCompanyIdentity(companyId, signal);
      return [companyId, identity] as const;
    }),
  );
  return new Map(entries);
}

// ---------------------------------------------------------------------------
// Per-row feature facts (revenue band / ownership)
// ---------------------------------------------------------------------------

/**
 * Feature-snapshot slice of GET /api/v1/candidates/[id] used for the table's
 * Revenue band and Ownership columns plus their client-side filters. Like the
 * identity slice above, this is a documented N+1 workaround: the list API
 * does not join feature snapshots. Results are cached briefly per candidate.
 */
export type CandidateRowFacts = Readonly<{
  revenueBand: string | null;
  ownershipType: string | null;
}>;

const NO_FACTS: CandidateRowFacts = { revenueBand: null, ownershipType: null };

const factsCache = new Map<
  string,
  { value: CandidateRowFacts; expires: number }
>();
const FACTS_TTL_MS = 60_000;

function factsFromDetail(detail: {
  featureSnapshot: { features: Record<string, unknown> } | null;
}): CandidateRowFacts {
  const snapshot = detail.featureSnapshot;
  if (snapshot === null) return NO_FACTS;
  const features = snapshot.features;
  const ownership = features["ownership"];
  const nestedOwnershipType =
    typeof ownership === "object" && ownership !== null
      ? (ownership as Record<string, unknown>)["ownershipType"]
      : undefined;
  return {
    revenueBand: text(features["revenue_band"]),
    ownershipType:
      text(nestedOwnershipType) ?? text(features["ownership_type"]),
  };
}

export async function getCandidateFacts(
  candidateId: string,
  signal: AbortSignal,
): Promise<CandidateRowFacts> {
  const cached = factsCache.get(candidateId);
  if (cached !== undefined && cached.expires > Date.now()) return cached.value;
  try {
    const detail = await getCandidateDetail(candidateId, signal);
    if (signal.aborted) return NO_FACTS;
    const value = factsFromDetail(detail);
    factsCache.set(candidateId, {
      value,
      expires: Date.now() + FACTS_TTL_MS,
    });
    return value;
  } catch (error) {
    if (signal.aborted) throw error;
    // A missing/unreadable snapshot must not break the whole table row.
    return NO_FACTS;
  }
}

/** Resolve feature facts for every candidate on one page, in parallel. */
export async function resolveCandidateFacts(
  candidateIds: readonly string[],
  signal: AbortSignal,
): Promise<Map<string, CandidateRowFacts>> {
  const unique = [...new Set(candidateIds)];
  const entries = await Promise.all(
    unique.map(async (candidateId) => {
      const facts = await getCandidateFacts(candidateId, signal);
      return [candidateId, facts] as const;
    }),
  );
  return new Map(entries);
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export async function createFeedback(
  payload: FeedbackCreate,
): Promise<FeedbackDto> {
  const envelope = await postJson<SuccessEnvelope<FeedbackDto>>(
    "/api/v1/feedback",
    payload,
  );
  return envelope.data;
}

export async function listFeedbackForCandidate(
  candidateId: string,
  signal: AbortSignal,
): Promise<PageEnvelope<FeedbackDto>> {
  return fetchEnvelope(
    `/api/v1/feedback?candidateId=${candidateId}&pageSize=100`,
    signal,
  );
}

// ---------------------------------------------------------------------------
// Research questions
// ---------------------------------------------------------------------------

export async function listResearchQuestions(
  candidateId: string,
  signal: AbortSignal,
): Promise<PageEnvelope<ResearchQuestionDto>> {
  return fetchEnvelope(
    `/api/v1/research-questions?candidateId=${candidateId}&pageSize=100`,
    signal,
  );
}

export async function createResearchQuestion(
  payload: ResearchQuestionCreate,
): Promise<ResearchQuestionDto> {
  const envelope = await postJson<SuccessEnvelope<ResearchQuestionDto>>(
    "/api/v1/research-questions",
    payload,
  );
  return envelope.data;
}

// ---------------------------------------------------------------------------
// Full company payload (candidate profile page)
// ---------------------------------------------------------------------------

export type CompanyObservation = Readonly<{
  id: string;
  fieldKey: string;
  value: unknown;
  observedAt: string | null;
  evidenceQuote: string | null;
  documentTitle: string | null;
  documentCanonicalUrl: string | null;
  dataSourceName: string | null;
  isCanonical: boolean;
}>;

export type CompanyProfile = Readonly<{
  name: string | null;
  legalName: string | null;
  headquartersCountryCode: string | null;
  domains: readonly string[];
  aliases: readonly string[];
  observations: readonly CompanyObservation[];
  researchGaps: readonly string[];
}>;

function asStringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null,
    )
    .map((entry) => text(entry[key]))
    .filter((entry): entry is string => entry !== null);
}

function asObservations(value: unknown): CompanyObservation[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null,
    )
    .map((entry) => ({
      id: text(entry.id) ?? "",
      fieldKey: text(entry.fieldKey) ?? "unknown",
      value: entry.value ?? null,
      observedAt: text(entry.observedAt),
      evidenceQuote: text(entry.evidenceQuote),
      documentTitle: text(entry.documentTitle),
      documentCanonicalUrl: text(entry.documentCanonicalUrl),
      dataSourceName: text(entry.dataSourceName),
      isCanonical: entry.isCanonical === true,
    }))
    .filter((observation) => observation.id !== "");
}

export async function getCompanyProfile(
  companyId: string,
  signal: AbortSignal,
): Promise<CompanyProfile> {
  const envelope = await fetchEnvelope<
    SuccessEnvelope<Record<string, unknown>>
  >(`/api/v1/companies/${companyId}`, signal);
  const payload = envelope.data;
  return {
    name:
      text(payload.displayName) ??
      text(payload.commonName) ??
      text(payload.legalName),
    legalName: text(payload.legalName),
    headquartersCountryCode: text(payload.headquartersCountryCode),
    domains: asStringArray(payload.domains, "domain"),
    aliases: asStringArray(payload.aliases, "alias"),
    observations: asObservations(payload.observations),
    researchGaps: Array.isArray(payload.researchGaps)
      ? payload.researchGaps.filter(
          (gap): gap is string => typeof gap === "string",
        )
      : [],
  };
}
