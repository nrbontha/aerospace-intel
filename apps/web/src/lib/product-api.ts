import type {
  BuildToPrintRisk,
  GoldenExampleType,
  LabelScale,
  ReviewStatus,
  SnapshotMemberMatchStatus,
  SnapshotSourceType,
} from "@asi/contracts";

import { apiJson } from "@/components/csrf-client";

// ---------------------------------------------------------------------------
// Shared envelopes
// ---------------------------------------------------------------------------

export type PageMeta = Readonly<{
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}>;

export type PageEnvelope<T> = Readonly<{ data: T[]; meta?: PageMeta }>;

// ---------------------------------------------------------------------------
// Known-universe snapshots and members
// ---------------------------------------------------------------------------

export type SnapshotRecord = Readonly<{
  id: string;
  key: string;
  name: string;
  sourceType: SnapshotSourceType;
  importFileName?: string | null;
  contentSha256?: string | null;
  effectiveDate?: string | null;
  notes?: string | null;
  rowCount: number;
  active: boolean;
  createdBy: string | null;
  createdAt: string;
}>;

export type MatchBreakdown = Readonly<Record<string, number>>;

export type MemberRecord = Readonly<{
  id: string;
  snapshotId: string;
  companyId: string | null;
  matchedCompanyId: string | null;
  rawName: string;
  rawDomain: string | null;
  normalizedDomain: string | null;
  normalizedName: string | null;
  matchStatus: SnapshotMemberMatchStatus;
  matchConfidence: number | null;
  rawPayload: Record<string, unknown>;
  sourceRow: number | null;
  createdAt: string;
}>;

export type SnapshotDetail = Readonly<{
  snapshot: SnapshotRecord;
  totalMembers: number;
  matchBreakdown: MatchBreakdown;
  membersPage: PageMeta;
  members: MemberRecord[];
}>;

export type NoveltyMemberHit = Readonly<{
  kind: "known_universe_member";
  memberId: string;
  snapshotId: string;
  snapshotKey: string;
  rawName: string;
  normalizedDomain: string | null;
  matchStatus: string;
}>;

export type NoveltyCompanyHit = Readonly<{
  kind: "company";
  companyId: string;
  displayName: string;
  legalName: string;
  domain: string | null;
}>;

export type NoveltySearchResult = Readonly<{
  query: Readonly<{ q?: string; domain?: string }>;
  summary: Readonly<{
    knownUniverseMemberHits: number;
    companyHits: number;
    novel: boolean;
  }>;
  results: ReadonlyArray<NoveltyMemberHit | NoveltyCompanyHit>;
}>;

// ---------------------------------------------------------------------------
// Golden examples
// ---------------------------------------------------------------------------

export type ProposedLabels = Readonly<{
  archetypeFit?: LabelScale;
  currentActionability?: LabelScale;
  businessModelFit?: LabelScale;
  ownershipFit?: LabelScale;
  goldenExampleType?: GoldenExampleType;
  buildToPrintRisk?: BuildToPrintRisk;
  rationale?: string;
}>;

export type GoldenExampleRecord = Readonly<{
  id: string;
  companyId: string | null;
  snapshotId: string | null;
  name: string;
  domain: string | null;
  descriptionRaw: string | null;
  grataPayload: Record<string, unknown>;
  workbookRow: number | null;
  proposedLabels: ProposedLabels;
  archetypeFit: LabelScale | null;
  currentActionability: LabelScale | null;
  businessModelFit: LabelScale | null;
  ownershipFit: LabelScale | null;
  goldenExampleType: GoldenExampleType | null;
  buildToPrintRisk: BuildToPrintRisk | null;
  reviewNotes: string | null;
  reviewStatus: ReviewStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
}>;

export type GoldenReviewPayload = Readonly<{
  archetypeFit?: LabelScale | undefined;
  currentActionability?: LabelScale | undefined;
  businessModelFit?: LabelScale | undefined;
  ownershipFit?: LabelScale | undefined;
  goldenExampleType?: GoldenExampleType | undefined;
  buildToPrintRisk?: BuildToPrintRisk | undefined;
  rationale: string;
}>;

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

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
    return new Error(`${payload.error.message} (${status})`);
  }
  return new Error(`Request failed (${status}).`);
}

async function fetchEnvelope<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "same-origin",
    signal,
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("The service returned an unreadable response.");
  }
  if (!response.ok) throw envelopeError(payload, response.status);
  return payload as T;
}

/** GET helpers for jsonSuccess routes, which wrap payloads in { data }. */
async function fetchSuccessData<T>(
  url: string,
  signal: AbortSignal,
): Promise<T> {
  const envelope = await fetchEnvelope<Readonly<{ data: T }>>(url, signal);
  return envelope.data;
}

export async function listSnapshots(
  signal: AbortSignal,
): Promise<PageEnvelope<SnapshotRecord>> {
  return fetchEnvelope("/api/v1/snapshots?page=1&pageSize=100", signal);
}

export async function getSnapshotDetail(
  snapshotId: string,
  params: Readonly<{
    page?: number | undefined;
    pageSize?: number | undefined;
    matchStatus?: string | undefined;
    query?: string | undefined;
  }>,
  signal: AbortSignal,
): Promise<SnapshotDetail> {
  const search = new URLSearchParams({
    page: String(params.page ?? 1),
    pageSize: String(params.pageSize ?? 25),
  });
  if (params.matchStatus) search.set("matchStatus", params.matchStatus);
  if (params.query) search.set("query", params.query);
  return fetchSuccessData(
    `/api/v1/snapshots/${snapshotId}?${search.toString()}`,
    signal,
  );
}

export async function searchKnownUniverse(
  params: Readonly<{ q?: string; domain?: string; limit?: number }>,
  signal: AbortSignal,
): Promise<NoveltySearchResult> {
  const search = new URLSearchParams();
  if (params.q) search.set("q", params.q);
  if (params.domain) search.set("domain", params.domain);
  if (params.limit) search.set("limit", String(params.limit));
  return fetchSuccessData(
    `/api/v1/known-universe/search?${search.toString()}`,
    signal,
  );
}

export async function listGoldenExamples(
  params: Readonly<{
    reviewStatus?: string | undefined;
    goldenExampleType?: string | undefined;
    query?: string | undefined;
  }>,
  signal: AbortSignal,
): Promise<PageEnvelope<GoldenExampleRecord>> {
  const search = new URLSearchParams({ page: "1", pageSize: "100" });
  if (params.reviewStatus) search.set("reviewStatus", params.reviewStatus);
  if (params.goldenExampleType)
    search.set("goldenExampleType", params.goldenExampleType);
  if (params.query) search.set("query", params.query);
  return fetchEnvelope(
    `/api/v1/golden-examples?${search.toString()}`,
    signal,
  );
}

export async function reviewGoldenExample(
  exampleId: string,
  payload: GoldenReviewPayload,
): Promise<GoldenExampleRecord> {
  return apiJson<GoldenExampleRecord>(
    `/api/v1/golden-examples/${exampleId}/review`,
    { body: JSON.stringify(payload), method: "PATCH" },
  );
}
