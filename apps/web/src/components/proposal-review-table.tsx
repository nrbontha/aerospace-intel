"use client";

import {
  Badge,
  Button,
  EmptyState,
  EvidenceConfidence,
  Input,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@asi/ui";
import { useCallback, useEffect, useMemo, useState } from "react";

type ProposalRecord = {
  id: string;
  status: "pending" | "accepted" | "rejected" | "superseded";
  researchRunId: string;
  observationId: string;
  subjectType: string;
  subjectId: string;
  fieldKey: string;
  proposedValue: unknown;
  currentValue: unknown;
  rationale: string | null;
  confidence: number | null;
  conflictStatus: string;
  evidence: {
    quote: string | null;
    locator: string | null;
    documentTitle: string | null;
    canonicalUrl: string | null;
    dataSourceName: string;
  };
  createdAt: string;
  updatedAt: string;
};

type Feedback = { tone: "error" | "success"; message: string };
type BulkResult = {
  accepted: ProposalRecord[];
  skipped: Array<{ id: string; reason: string }>;
};
const csrfCookieName = "asi_session_csrf";
const sensitiveField =
  /(^|[._-])(ownership|owner|parent_company|revenue|financial|income|sales|turnover|identity|legal_name|company_name|name|alias|duns|cage|uei|lei|registration|tax_id|qualification|qualified|certification|approval|sole_?source|source_?scarcity|supplier_?status)($|[._-])/i;

class ApiRequestError extends Error {}

function csrfToken(): string | undefined {
  let fallback: string | undefined;
  for (const pair of document.cookie.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const name = decodeURIComponent(pair.slice(0, separator).trim());
    const value = decodeURIComponent(pair.slice(separator + 1));
    if (name === csrfCookieName) return value;
    if (name.endsWith("_csrf")) fallback ??= value;
  }
  return fallback;
}

async function apiRequest<T>(
  url: string,
  init: RequestInit = {},
): Promise<{ data: T }> {
  const method = init.method?.toUpperCase() ?? "GET";
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (method !== "GET" && method !== "HEAD") {
    const csrf = csrfToken();
    if (!csrf)
      throw new ApiRequestError(
        "Your session is missing CSRF protection. Sign in again.",
      );
    headers.set("x-csrf-token", csrf);
  }
  const response = await fetch(url, {
    ...init,
    method,
    headers,
    cache: "no-store",
    credentials: "same-origin",
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiRequestError("The server returned an unreadable response.");
  }
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    if (typeof payload === "object" && payload !== null && "error" in payload) {
      const error = payload.error;
      if (
        typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof error.message === "string"
      )
        message = error.message;
    }
    throw new ApiRequestError(message);
  }
  if (typeof payload !== "object" || payload === null || !("data" in payload))
    throw new ApiRequestError("The server returned an invalid response.");
  return payload as { data: T };
}

function displayValue(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "undefined";
  } catch {
    return "Unable to display value";
  }
}

function conflict(proposal: ProposalRecord): boolean {
  return proposal.conflictStatus.toLowerCase() !== "none";
}

function bulkRestriction(proposal: ProposalRecord): string | null {
  if (proposal.status !== "pending") return "Already reviewed";
  if (conflict(proposal))
    return "Conflicting evidence requires individual review";
  if (
    sensitiveField.test(
      `${proposal.subjectType}.${proposal.fieldKey}`.replaceAll("-", "_"),
    )
  )
    return "Sensitive field requires individual review";
  return null;
}

function ProposalRow({
  proposal,
  canReview,
  selected,
  onSelected,
  onReviewed,
}: Readonly<{
  proposal: ProposalRecord;
  canReview: boolean;
  selected: boolean;
  onSelected: (selected: boolean) => void;
  onReviewed: (originalId: string, proposal: ProposalRecord) => void;
}>) {
  const [reason, setReason] = useState("");
  const [editedValue, setEditedValue] = useState(() =>
    displayValue(proposal.proposedValue),
  );
  const [showEditor, setShowEditor] = useState(false);
  const [pending, setPending] = useState<string>();
  const [feedback, setFeedback] = useState<Feedback>();
  const restriction = bulkRestriction(proposal);

  async function review(decision: "accept" | "reject" | "edit_and_accept") {
    const reviewReason = reason.trim();
    if (
      (decision === "reject" || decision === "edit_and_accept") &&
      !reviewReason
    ) {
      setFeedback({
        tone: "error",
        message: "Give a reason for rejection or an edited acceptance.",
      });
      return;
    }
    let parsedValue: unknown;
    if (decision === "edit_and_accept") {
      try {
        parsedValue = JSON.parse(editedValue);
      } catch {
        setFeedback({
          tone: "error",
          message: "Edited value must be valid JSON.",
        });
        return;
      }
    }
    setPending(decision);
    setFeedback(undefined);
    try {
      const response = await apiRequest<ProposalRecord>(
        `/api/v1/proposals/${proposal.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            decision,
            ...(reviewReason ? { reason: reviewReason } : {}),
            ...(decision === "edit_and_accept"
              ? { editedValue: parsedValue }
              : {}),
          }),
        },
      );
      onReviewed(proposal.id, response.data);
    } catch (error) {
      setFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : "Review failed",
      });
    } finally {
      setPending(undefined);
    }
  }

  return (
    <TableRow
      className={conflict(proposal) ? "bg-red-50/70" : undefined}
      data-conflict={conflict(proposal) || undefined}
    >
      <TableCell className="align-top">
        <input
          aria-label={`Select ${proposal.fieldKey} proposal`}
          type="checkbox"
          checked={selected}
          disabled={!canReview || restriction !== null || pending !== undefined}
          title={restriction ?? "Select for bulk acceptance"}
          onChange={(event) => onSelected(event.target.checked)}
        />
      </TableCell>
      <TableCell className="min-w-44 align-top text-xs">
        <strong className="block text-sm">{proposal.subjectType}</strong>
        <code className="block break-all text-[0.68rem] text-slate-500">
          {proposal.subjectId}
        </code>
      </TableCell>
      <TableCell className="min-w-40 align-top">
        <code className="text-xs font-semibold">{proposal.fieldKey}</code>
      </TableCell>
      <TableCell className="min-w-64 max-w-96 align-top">
        <div className="grid gap-2">
          <div>
            <p className="m-0 text-[0.68rem] font-semibold uppercase tracking-wide text-slate-500">
              Current canonical
            </p>
            {proposal.currentValue === null ||
            proposal.currentValue === undefined ? (
              <Badge tone="neutral">No canonical value</Badge>
            ) : (
              <pre className="m-0 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded bg-white p-2 text-xs">
                {displayValue(proposal.currentValue)}
              </pre>
            )}
          </div>
          <div>
            <p className="m-0 text-[0.68rem] font-semibold uppercase tracking-wide text-slate-500">
              Proposed
            </p>
            <pre className="m-0 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-100 p-2 text-xs">
              {displayValue(proposal.proposedValue)}
            </pre>
          </div>
        </div>
      </TableCell>
      <TableCell className="min-w-80 max-w-md align-top text-xs">
        {proposal.evidence.quote ? (
          <blockquote className="m-0 border-l-2 border-sky-600 pl-3 leading-relaxed text-slate-800">
            “{proposal.evidence.quote}”
          </blockquote>
        ) : (
          <Badge tone="warning">No excerpt</Badge>
        )}
        <div className="mt-2 text-slate-600">
          {proposal.evidence.canonicalUrl ? (
            <a
              className="font-semibold underline underline-offset-2"
              href={proposal.evidence.canonicalUrl}
              target="_blank"
              rel="noreferrer"
            >
              {proposal.evidence.documentTitle ??
                proposal.evidence.dataSourceName}
            </a>
          ) : (
            <span>
              {proposal.evidence.documentTitle ??
                proposal.evidence.dataSourceName}
            </span>
          )}
          {proposal.evidence.locator ? (
            <span className="block">Location: {proposal.evidence.locator}</span>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="min-w-36 align-top">
        <EvidenceConfidence value={proposal.confidence} label="Confidence" />
      </TableCell>
      <TableCell className="min-w-40 align-top text-xs">
        {conflict(proposal) ? (
          <Badge tone="danger">Conflict: {proposal.conflictStatus}</Badge>
        ) : (
          <Badge tone="success">No conflict</Badge>
        )}
        <span
          className={`mt-2 block leading-snug ${restriction ? "text-slate-600" : "text-emerald-800"}`}
        >
          {restriction ?? "Bulk eligible"}
        </span>
      </TableCell>
      <TableCell className="min-w-64 max-w-80 align-top text-xs leading-relaxed">
        {proposal.rationale ?? "No rationale supplied."}
      </TableCell>
      <TableCell className="min-w-72 align-top">
        {proposal.status === "pending" && canReview ? (
          <div className="grid gap-2">
            <Input
              aria-label={`Review reason for ${proposal.fieldKey}`}
              maxLength={10_000}
              placeholder="Reason (required for reject or edit)"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
            <button
              className="justify-self-start text-xs font-semibold text-sky-800 underline underline-offset-2"
              type="button"
              onClick={() => setShowEditor((value) => !value)}
            >
              {showEditor ? "Hide edited value" : "Edit proposed value"}
            </button>
            {showEditor ? (
              <textarea
                aria-label={`Edited value for ${proposal.fieldKey}`}
                className="asi-input min-h-28 resize-y font-mono text-xs"
                maxLength={50_000}
                spellCheck={false}
                value={editedValue}
                onChange={(event) => setEditedValue(event.target.value)}
              />
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                size="small"
                isLoading={pending === "accept"}
                disabled={pending !== undefined}
                onClick={() => void review("accept")}
              >
                Accept
              </Button>
              <Button
                size="small"
                variant="secondary"
                isLoading={pending === "edit_and_accept"}
                disabled={pending !== undefined || !showEditor}
                onClick={() => void review("edit_and_accept")}
              >
                Edit & accept
              </Button>
              <Button
                size="small"
                variant="danger"
                isLoading={pending === "reject"}
                disabled={pending !== undefined}
                onClick={() => void review("reject")}
              >
                Reject
              </Button>
            </div>
            {feedback ? (
              <p
                className={
                  feedback.tone === "error"
                    ? "m-0 text-xs text-red-800"
                    : "m-0 text-xs text-emerald-800"
                }
                role="status"
              >
                {feedback.message}
              </p>
            ) : null}
          </div>
        ) : (
          <Badge
            tone={
              proposal.status === "accepted"
                ? "success"
                : proposal.status === "rejected"
                  ? "danger"
                  : "neutral"
            }
          >
            {proposal.status}
          </Badge>
        )}
      </TableCell>
    </TableRow>
  );
}

export function ProposalReviewTable({
  canReview,
}: Readonly<{ canReview: boolean }>) {
  const [filter, setFilter] = useState<"pending" | "all">("pending");
  const [proposals, setProposals] = useState<ProposalRecord[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [bulkPending, setBulkPending] = useState(false);
  const [bulkReason, setBulkReason] = useState("");
  const [bulkFeedback, setBulkFeedback] = useState<Feedback>();

  const loadProposals = useCallback(
    async (requestedFilter: "pending" | "all") => {
      setLoading(true);
      setLoadError(undefined);
      try {
        const response = await apiRequest<ProposalRecord[]>(
          `/api/v1/proposals?status=${requestedFilter}`,
        );
        setProposals(response.data);
        setSelected(new Set());
      } catch (error) {
        setLoadError(
          error instanceof Error ? error.message : "Unable to load proposals",
        );
      } finally {
        setLoading(false);
      }
    },
    [],
  );
  useEffect(() => {
    void loadProposals(filter);
  }, [filter, loadProposals]);

  const eligibleIds = useMemo(
    () =>
      proposals
        .filter((proposal) => bulkRestriction(proposal) === null)
        .map((proposal) => proposal.id),
    [proposals],
  );
  const allEligibleSelected =
    eligibleIds.length > 0 && eligibleIds.every((id) => selected.has(id));

  function reviewed(originalId: string, replacement: ProposalRecord) {
    setSelected((current) => {
      const next = new Set(current);
      next.delete(originalId);
      return next;
    });
    setProposals((current) =>
      filter === "pending"
        ? current.filter((item) => item.id !== originalId)
        : current.map((item) => (item.id === originalId ? replacement : item)),
    );
  }

  async function bulkAccept() {
    const proposalIds = [...selected];
    if (proposalIds.length === 0) return;
    setBulkPending(true);
    setBulkFeedback(undefined);
    try {
      const response = await apiRequest<BulkResult>("/api/v1/proposals/bulk", {
        method: "POST",
        body: JSON.stringify({
          proposalIds,
          ...(bulkReason.trim() ? { reason: bulkReason.trim() } : {}),
        }),
      });
      const acceptedIds = new Set(
        response.data.accepted.map((item) => item.id),
      );
      setProposals((current) =>
        filter === "pending"
          ? current.filter((item) => !acceptedIds.has(item.id))
          : current.map(
              (item) =>
                response.data.accepted.find(
                  (accepted) => accepted.id === item.id,
                ) ?? item,
            ),
      );
      setSelected(new Set());
      setBulkFeedback({
        tone: response.data.skipped.length ? "error" : "success",
        message: response.data.skipped.length
          ? `Accepted ${response.data.accepted.length}; skipped ${response.data.skipped.length} proposal(s) requiring individual review.`
          : `Accepted ${response.data.accepted.length} proposal(s).`,
      });
    } catch (error) {
      setBulkFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : "Bulk review failed",
      });
    } finally {
      setBulkPending(false);
    }
  }

  return (
    <section aria-labelledby="proposal-review-heading" className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4 rounded border border-slate-200 bg-white p-4">
        <div>
          <h2
            id="proposal-review-heading"
            className="m-0 text-lg font-semibold"
          >
            Evidence-backed proposals
          </h2>
          <p className="mb-0 mt-1 max-w-3xl text-sm text-slate-600">
            Acceptance updates the canonical fact. Rejection records the review
            without changing canonical state. Sensitive fields and conflicts
            must be reviewed individually.
          </p>
        </div>
        <label className="grid gap-1 text-xs font-semibold uppercase tracking-wide text-slate-600">
          Queue view
          <Select
            value={filter}
            onChange={(event) =>
              setFilter(event.target.value as "pending" | "all")
            }
          >
            <option value="pending">Pending</option>
            <option value="all">All proposals</option>
          </Select>
        </label>
      </div>
      {canReview ? (
        <div className="flex flex-wrap items-end gap-3 rounded border border-slate-200 bg-slate-50 p-3">
          <label className="grid min-w-72 flex-1 gap-1 text-xs font-semibold text-slate-700">
            Bulk acceptance note (optional)
            <Input
              maxLength={10_000}
              placeholder="Selected low-risk, non-conflicting proposals"
              value={bulkReason}
              onChange={(event) => setBulkReason(event.target.value)}
            />
          </label>
          <Button
            size="small"
            isLoading={bulkPending}
            disabled={selected.size === 0}
            onClick={() => void bulkAccept()}
          >
            Accept selected ({selected.size})
          </Button>
          {bulkFeedback ? (
            <p
              className={
                bulkFeedback.tone === "error"
                  ? "m-0 basis-full text-sm text-red-800"
                  : "m-0 basis-full text-sm text-emerald-800"
              }
              role="status"
            >
              {bulkFeedback.message}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="m-0 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
          View-only access: an analyst or administrator must review proposals.
        </p>
      )}
      {loading ? <p role="status">Loading proposal evidence…</p> : null}
      {loadError ? (
        <div
          className="rounded border border-red-300 bg-red-50 p-4 text-red-900"
          role="alert"
        >
          <p className="mt-0">{loadError}</p>
          <Button
            size="small"
            variant="secondary"
            onClick={() => void loadProposals(filter)}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {!loading && !loadError && proposals.length === 0 ? (
        <EmptyState
          title={
            filter === "pending"
              ? "No proposals awaiting review"
              : "No proposals recorded"
          }
          description="New proposals appear only after a research run produces source-backed observations."
        />
      ) : null}
      {!loading && !loadError && proposals.length > 0 ? (
        <Table className="min-w-[1500px] text-xs">
          <TableHeader>
            <TableRow>
              <TableHead>
                <input
                  aria-label="Select all bulk-eligible proposals"
                  type="checkbox"
                  checked={allEligibleSelected}
                  disabled={!canReview || eligibleIds.length === 0}
                  onChange={(event) =>
                    setSelected(
                      event.target.checked ? new Set(eligibleIds) : new Set(),
                    )
                  }
                />
              </TableHead>
              <TableHead>Entity</TableHead>
              <TableHead>Field</TableHead>
              <TableHead>Canonical vs proposed</TableHead>
              <TableHead>Source evidence</TableHead>
              <TableHead>Confidence</TableHead>
              <TableHead>Conflict</TableHead>
              <TableHead>Rationale</TableHead>
              <TableHead>Review</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {proposals.map((proposal) => (
              <ProposalRow
                key={proposal.id}
                proposal={proposal}
                canReview={canReview}
                selected={selected.has(proposal.id)}
                onSelected={(checked) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (checked) next.add(proposal.id);
                    else next.delete(proposal.id);
                    return next;
                  })
                }
                onReviewed={reviewed}
              />
            ))}
          </TableBody>
        </Table>
      ) : null}
    </section>
  );
}
