import type { LeadStatus } from "@asi/contracts";

import { apiJson } from "@/components/csrf-client";
import {
  fetchEnvelope,
  type PageEnvelope,
  type SuccessEnvelope,
} from "@/lib/target-feed-api";

// ---------------------------------------------------------------------------
// Lead pipeline client (REDESIGN_PLAN §2 — discovery inbox).
//
// Read model mirrors GET /api/v1/leads (listLeads rows, camelCase JSON).
// `context` is an open jsonb bag from the discovery agents; every reader
// below is defensive — missing/malformed keys render as "unknown", never as
// fabricated zeros.
// ---------------------------------------------------------------------------

export type LeadRow = Readonly<{
  id: string;
  campaignId: string | null;
  rawName: string;
  status: string;
  possibleDomain: string | null;
  possibleLocation: string | null;
  possibleIdentifiers: unknown[];
  context: Record<string, unknown>;
  resolvedCompanyId: string | null;
  createdAt: string;
  updatedAt?: string;
}>;

/** One homepage-identity probe recorded by the resolve-domain service. */
export type DomainAttempt = Readonly<{
  domain: string;
  outcome: string;
  reason?: string;
}>;

/** context.domainVerification once a lead's domain has been probed. */
export type DomainVerification = Readonly<{
  verifiedAt?: string;
  method?: string;
  url?: string;
  confidence?: number;
  attempts?: readonly DomainAttempt[];
}>;

export type ResolveDomainOutcome =
  | "domain_verified"
  | "no_domain_found"
  | "identity_mismatch"
  | "already_resolved";

/** POST /api/v1/leads/[id]/resolve-domain response (contract fixed with the
 * route owner; fields beyond the outcome are optional because the failure
 * outcomes legitimately omit them). */
export type ResolveDomainResult = Readonly<{
  outcome: ResolveDomainOutcome;
  domain?: string;
  companyId?: string;
  candidateId?: string;
  attempts?: readonly DomainAttempt[];
}>;

export type LeadListParams = Readonly<{
  status?: Extract<
    LeadStatus,
    "unresolved_lead" | "resolved" | "discarded" | "new" | "resolving"
  >;
  q?: string;
  page: number;
  pageSize: number;
}>;

export async function listLeads(
  params: LeadListParams,
  signal: AbortSignal,
): Promise<PageEnvelope<LeadRow>> {
  const search = new URLSearchParams();
  if (params.status !== undefined) search.set("status", params.status);
  // Text search per the documented leads contract; servers without the q
  // predicate ignore it (honest gap until listLeads grows search).
  if (params.q !== undefined && params.q.trim() !== "")
    search.set("q", params.q.trim());
  search.set("page", String(params.page));
  search.set("pageSize", String(params.pageSize));
  return fetchEnvelope<PageEnvelope<LeadRow>>(
    `/api/v1/leads?${search.toString()}`,
    signal,
  );
}

export async function resolveLeadDomain(
  leadId: string,
): Promise<ResolveDomainResult> {
  const payload = await apiJson<SuccessEnvelope<ResolveDomainResult>>(
    `/api/v1/leads/${encodeURIComponent(leadId)}/resolve-domain`,
    {
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  return payload.data;
}

export async function discardLead(
  leadId: string,
  reason: string,
): Promise<Readonly<{ status: string }>> {
  const payload = await apiJson<SuccessEnvelope<{ status: string }>>(
    `/api/v1/leads/${encodeURIComponent(leadId)}/discard`,
    {
      body: JSON.stringify({ reason }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  return payload.data;
}

// ---------------------------------------------------------------------------
// Defensive readers over the open context jsonb
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value
    : undefined;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Award-context summary written by the USAspending discovery agent. */
export type LeadAwardContext = Readonly<{
  awardCount: number | null;
  totalAwardValueUsd: number | null;
  freshestAwardDate: string | null;
  sourceLocator: string | null;
}>;

export function leadAwardContext(
  context: Record<string, unknown>,
): LeadAwardContext {
  return {
    awardCount: finiteNumber(context.awardCount),
    totalAwardValueUsd: finiteNumber(context.totalAwardValueUsd),
    freshestAwardDate: optionalString(context.freshestAwardDate) ?? null,
    sourceLocator: optionalString(context.sourceLocator) ?? null,
  };
}

export function leadDomainVerification(
  context: Record<string, unknown>,
): DomainVerification | null {
  const raw = asRecord(context.domainVerification);
  if (raw === null) return null;

  const verifiedAt = optionalString(raw.verifiedAt);
  const method = optionalString(raw.method);
  const url = optionalString(raw.url);
  const confidence = finiteNumber(raw.confidence);
  const verification: {
    verifiedAt?: string;
    method?: string;
    url?: string;
    confidence?: number;
    attempts?: DomainAttempt[];
  } = {};
  if (verifiedAt !== undefined) verification.verifiedAt = verifiedAt;
  if (method !== undefined) verification.method = method;
  if (url !== undefined) verification.url = url;
  if (confidence !== null) verification.confidence = confidence;

  if (Array.isArray(raw.attempts)) {
    verification.attempts = raw.attempts.flatMap((entry) => {
      const record = asRecord(entry);
      if (record === null || typeof record.domain !== "string") return [];
      const reason = optionalString(record.reason);
      return [
        {
          domain: record.domain,
          outcome:
            typeof record.outcome === "string" ? record.outcome : "unknown",
          ...(reason === undefined ? {} : { reason }),
        } satisfies DomainAttempt,
      ];
    });
  }
  return verification;
}

/** context.discarded written by discardLead ({ reason, at }). */
export function leadDiscardRecord(
  context: Record<string, unknown>,
): Readonly<{ reason: string; at: string }> | null {
  const raw = asRecord(context.discarded);
  if (raw === null) return null;
  const reason = optionalString(raw.reason);
  const at = optionalString(raw.at);
  return reason !== undefined && at !== undefined ? { reason, at } : null;
}
