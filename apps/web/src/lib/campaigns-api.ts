import type {
  CampaignDto,
  FrontierItemDto,
  FrontierItemStatus,
  FrontierItemType,
} from "@asi/contracts";

import { apiJson } from "@/components/csrf-client";

// ---------------------------------------------------------------------------
// Envelopes (mirrors lib/product-api.ts)
// ---------------------------------------------------------------------------

export type PageMeta = Readonly<{
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}>;

export type PageEnvelope<T> = Readonly<{ data: T[]; meta?: PageMeta }>;

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

async function fetchSuccessData<T>(
  url: string,
  signal: AbortSignal,
): Promise<T> {
  const envelope = await fetchEnvelope<Readonly<{ data: T }>>(url, signal);
  return envelope.data;
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export type CampaignRecord = CampaignDto;

/** Resolved policy persisted at plan time (subset the UI renders). */
export type CampaignPolicySummary = Readonly<{
  version: string;
  enabledSources: readonly string[];
  maxDepth: number;
}>;

export type CampaignDetailPayload = Readonly<{
  campaign: CampaignDto;
  policy: CampaignPolicySummary;
  frontierBreakdown: Record<string, number>;
}>;

export async function listCampaigns(
  page: number,
  signal: AbortSignal,
): Promise<PageEnvelope<CampaignRecord>> {
  return fetchEnvelope(
    `/api/v1/campaigns?page=${page}&pageSize=25`,
    signal,
  );
}

export type CampaignCreatePayload = Readonly<{
  name: string;
  objective?: string;
  seeds?: Record<string, unknown>;
  budgetUsd?: number;
  concurrency?: number;
  maxDepth?: number;
}>;

export async function createCampaign(
  payload: CampaignCreatePayload,
): Promise<CampaignRecord> {
  return apiJson<CampaignRecord>("/api/v1/campaigns", {
    body: JSON.stringify(payload),
    method: "POST",
  });
}

export async function getCampaignDetail(
  campaignId: string,
  signal: AbortSignal,
): Promise<CampaignDetailPayload> {
  return fetchSuccessData(`/api/v1/campaigns/${campaignId}`, signal);
}

export type LifecycleAction = "start" | "pause" | "resume" | "cancel";

export async function postLifecycleAction(
  campaignId: string,
  action: LifecycleAction,
): Promise<CampaignRecord> {
  return apiJson<CampaignRecord>(
    `/api/v1/campaigns/${campaignId}/${action}`,
    { body: JSON.stringify({ action }), method: "POST" },
  );
}

// ---------------------------------------------------------------------------
// Frontier items
// ---------------------------------------------------------------------------

export type FrontierListParams = Readonly<{
  status?: FrontierItemStatus | "";
  itemType?: FrontierItemType | "";
  page: number;
}>;

export async function listFrontierItems(
  campaignId: string,
  params: FrontierListParams,
  signal: AbortSignal,
): Promise<PageEnvelope<FrontierItemDto>> {
  const search = new URLSearchParams({
    page: String(params.page),
    pageSize: "25",
  });
  if (params.status) search.set("status", params.status);
  if (params.itemType) search.set("itemType", params.itemType);
  return fetchEnvelope(
    `/api/v1/campaigns/${campaignId}/frontier?${search.toString()}`,
    signal,
  );
}

export type ManualFrontierPayload = Readonly<{
  itemType: FrontierItemType;
  normalizedValue: string;
  payload?: Record<string, unknown>;
}>;

/** Result is the created item, or `{ duplicate: true }` when it already existed. */
export type ManualFrontierResult =
  | FrontierItemDto
  | Readonly<{ duplicate: true }>;

export function isDuplicateFrontierResult(
  result: ManualFrontierResult,
): result is Readonly<{ duplicate: true }> {
  return "duplicate" in result && result.duplicate === true;
}

export async function addManualFrontierItem(
  campaignId: string,
  payload: ManualFrontierPayload,
): Promise<ManualFrontierResult> {
  return apiJson<ManualFrontierResult>(
    `/api/v1/campaigns/${campaignId}/items`,
    { body: JSON.stringify(payload), method: "POST" },
  );
}

// ---------------------------------------------------------------------------
// Leads scoped to a campaign
// ---------------------------------------------------------------------------

export type LeadMatchSummary = Readonly<{
  pending: number;
  merged: number;
  rejected: number;
}>;

export type LeadRecord = Readonly<{
  id: string;
  campaignId: string | null;
  rawName: string;
  status: string;
  possibleDomain: string | null;
  possibleLocation: string | null;
  resolvedCompanyId: string | null;
  createdAt: string;
  matchSummary: LeadMatchSummary;
}>;

export async function listCampaignLeads(
  campaignId: string,
  page: number,
  signal: AbortSignal,
): Promise<PageEnvelope<LeadRecord>> {
  const search = new URLSearchParams({
    campaignId,
    page: String(page),
    pageSize: "25",
  });
  return fetchEnvelope(`/api/v1/leads?${search.toString()}`, signal);
}
