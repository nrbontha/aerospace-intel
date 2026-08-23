"use client";

import type { CandidateDto, CandidateStatus, NoveltyStatus } from "@asi/contracts";
import {
  Button,
  EmptyState,
  Input,
  Select,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@asi/ui";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { CatalogExport } from "@/components/catalog-export";
import {
  AxisChip,
  NoveltyBadge,
  StatusBadge,
  formatInstant,
  humanLabel,
} from "@/components/target-feed/candidate-bits";
import {
  createFeedback,
  listCandidates,
  resolveCompanyIdentities,
  updateCandidateStatus,
  type CompanyIdentity,
} from "@/lib/target-feed-api";

/**
 * Manual status targets. `queued_research` is the analyst's
 * "Needs More Research" lever: it sends the candidate back to the research
 * queue. NOTE: the engine re-routes statuses on the next promotion cycle,
 * so a manual queued_research persists only until then unless the analyst
 * records an audit note (the human-status preservation logic keys off it).
 */
type ManualStatus = Extract<
  CandidateStatus,
  "archived" | "rejected" | "hold" | "shortlist" | "queued_research"
>;
const STATUS_FILTER_OPTIONS: readonly CandidateStatus[] = [
  "queued_research",
  "in_research",
  "research_ready",
  "partner_review",
  "shortlist",
  "hold",
  "rejected",
  "watchlist",
  "archived",
];

const NOVELTY_OPTIONS: readonly NoveltyStatus[] = [
  "not_matched_to_current_known_universe",
  "possible_known_universe_match",
  "confirmed_known_company",
  "unable_to_assess",
];
/** Manual status targets offered in the feed/profile status menus. */
const MANUAL_STATUS_OPTIONS: readonly ManualStatus[] = [
  "shortlist",
  "hold",
  "rejected",
  "queued_research",
  "archived",
];

// queued_research records no investment feedback — it is a research-queue
// request, not an investment decision; the audit note on the transition
// carries the reasoning.
const FEEDBACK_ACTION_BY_STATUS: Record<ManualStatus, "shortlist" | "hold" | "reject" | null> =
  {
    shortlist: "shortlist",
    hold: "hold",
    rejected: "reject",
    queued_research: null,
    archived: null,
  };

const AXIS_FILTER_KEYS = [
  "minFit",
  "maxFit",
  "minNovelty",
  "maxNovelty",
  "minConfidence",
  "maxConfidence",
  "minActionability",
  "maxActionability",
] as const;

type AxisFilterKey = (typeof AXIS_FILTER_KEYS)[number];

const AXIS_FILTER_LABELS: Record<AxisFilterKey, string> = {
  minFit: "Min fit",
  maxFit: "Max fit",
  minNovelty: "Min novelty",
  maxNovelty: "Max novelty",
  minConfidence: "Min confidence",
  maxConfidence: "Max confidence",
  minActionability: "Min actionability",
  maxActionability: "Max actionability",
};

export const REJECT_REASONS: Record<string, string> = {
  ownership_unactionable: "Ownership makes it unactionable",
  outside_archetype: "Outside target archetype",
  too_small: "Too small for the program",
  distributor_service: "Pure distributor / service business",
  already_covered: "Already covered elsewhere in pipeline",
  insufficient_evidence: "Insufficient evidence to proceed",
  other: "Other (note required)",
};

type RowView = Readonly<{ candidate: CandidateDto; identity: CompanyIdentity }>;

function filterValue(
  params: URLSearchParams,
  key: AxisFilterKey,
): number | "" {
  const raw = params.get(key);
  if (raw === null || raw.trim() === "") return "";
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : "";
}

// ---------------------------------------------------------------------------
// Partner-review inline actions
// ---------------------------------------------------------------------------

function PartnerReviewActions({
  candidate,
  onResolved,
}: {
  candidate: CandidateDto;
  onResolved: (candidateId: string) => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reasonCode, setReasonCode] = useState("ownership_unactionable");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function run(
    actionKey: string,
    work: () => Promise<void>,
  ): Promise<void> {
    setPending(actionKey);
    setError(null);
    try {
      await work();
      onResolved(candidate.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Action failed.");
    } finally {
      setPending(null);
    }
  }

  function feedbackWork(
    action: "strong_fit" | "possible_fit" | "reject" | "needs_more_research",
    status: ManualStatus,
    reason?: string,
  ): () => Promise<void> {
    return async () => {
      await createFeedback({
        channel: "investment",
        action,
        candidateId: candidate.id,
        ...(reason === undefined ? {} : { reason }),
        ...(notes.trim() === "" ? {} : { notes: notes.trim() }),
      });
      await updateCandidateStatus(candidate.id, status);
    };
  }

  return (
    <div className="admin-stack">
      <div className="admin-actions">
        <Button
          size="small"
          disabled={pending !== null}
          onClick={() => void run("strong_fit", feedbackWork("strong_fit", "shortlist"))}
        >
          Strong Fit
        </Button>
        <Button
          size="small"
          variant="secondary"
          disabled={pending !== null}
          onClick={() =>
            void run("possible_fit", feedbackWork("possible_fit", "hold"))
          }
        >
          Possible Fit
        </Button>
        <Button
          size="small"
          variant="secondary"
          aria-expanded={rejectOpen}
          disabled={pending !== null}
          onClick={() => setRejectOpen((open) => !open)}
        >
          Reject…
        </Button>
        <Button
          size="small"
          variant="ghost"
          disabled={pending !== null}
          onClick={() =>
            void run(
              "needs_more_research",
              feedbackWork("needs_more_research", "hold"),
            )
          }
        >
          Needs More Research
        </Button>
      </div>
      {rejectOpen ? (
        <form
          className="admin-form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            const reason = REJECT_REASONS[reasonCode];
            if (reason === undefined) return;
            if (reasonCode === "other" && notes.trim() === "") {
              setError('Reason "Other" requires a note.');
              return;
            }
            void run(
              "reject",
              feedbackWork("reject", "rejected", `reject_reason:${reasonCode}`),
            );
          }}
        >
          <label className="admin-field">
            <span className="admin-field__label">Rejection reason</span>
            <Select
              value={reasonCode}
              onChange={(event) => setReasonCode(event.target.value)}
            >
              {Object.entries(REJECT_REASONS).map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </Select>
          </label>
          <label className="admin-field">
            <span className="admin-field__label">Note</span>
            <Input
              maxLength={2000}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Optional context recorded with the decision"
            />
          </label>
          <div className="admin-actions">
            <Button
              size="small"
              type="submit"
              disabled={pending !== null}
              variant="danger"
            >
              Confirm rejection
            </Button>
          </div>
        </form>
      ) : null}
      {pending !== null ? (
        <p className="asi-page-description" role="status">
          Recording {pending}…
        </p>
      ) : null}
      {error !== null ? (
        <p className="admin-feedback" data-tone="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-row status menu (single-row bookkeeping with audit note)
// ---------------------------------------------------------------------------

export function RowStatusMenu({
  candidate,
  onUpdated,
}: {
  candidate: CandidateDto;
  onUpdated: (candidateId: string, status: CandidateStatus) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draftStatus, setDraftStatus] = useState<ManualStatus>("shortlist");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const feedbackAction = FEEDBACK_ACTION_BY_STATUS[draftStatus];
      if (feedbackAction !== null) {
        await createFeedback({
          channel: "investment",
          action: feedbackAction,
          candidateId: candidate.id,
          ...(note.trim() === "" ? {} : { notes: note.trim() }),
        });
      }
      await updateCandidateStatus(candidate.id, draftStatus);
      onUpdated(candidate.id, draftStatus);
      setOpen(false);
      setNote("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Status change failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <details
      open={open}
      onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
    >
      <summary>Status ▾</summary>
      <div
        style={{
          minWidth: "16rem",
          padding: "0.5rem",
          border: "1px solid var(--asi-border, currentColor)",
          borderRadius: "4px",
          background: "var(--asi-surface-muted, transparent)",
        }}
      >
        <label className="admin-field">
          <span className="admin-field__label">Set status</span>
          <Select
            value={draftStatus}
            onChange={(event) => setDraftStatus(event.target.value as ManualStatus)}
          >
            {MANUAL_STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>
                {status === "queued_research"
                  ? "Needs more research"
                  : humanLabel(status)}
              </option>
            ))}
            <option disabled value="watchlist">
              Watchlist (engine-routed only)
            </option>
          </Select>
        </label>
        {draftStatus === "queued_research" ? (
          <p className="asi-page-description" role="note">
            Sends the candidate back to the research queue. The engine may
            re-route it on the next promotion cycle; record a note so your
            reasoning stays on the audit trail.
          </p>
        ) : null}
        <label className="admin-field">
          <span className="admin-field__label">
            {draftStatus === "queued_research"
              ? "What needs more research? (recommended)"
              : "Audit note"}
          </span>
          <Input
            maxLength={2000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={
              draftStatus === "queued_research"
                ? "e.g. Ownership picture unclear — re-run research after filings update"
                : "Why this status changed (recorded as investment feedback)"
            }
          />
        </label>
        <div className="admin-actions">
          <Button
            size="small"
            type="button"
            disabled={pending}
            onClick={() => void apply()}
          >
            Apply
          </Button>
        </div>
        {error !== null ? (
          <p className="admin-feedback" data-tone="error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Main table
// ---------------------------------------------------------------------------

export function TargetFeed({ queue = false }: { queue?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const statusFilter = queue ? "partner_review" : (searchParams.get("status") ?? "");
  const noveltyFilter = searchParams.get("noveltyStatus") ?? "";
  const textQuery = searchParams.get("q") ?? "";
  const page = Number(searchParams.get("page") ?? "1") || 1;

  const axisFilters = useMemo(() => {
    const entries: Partial<Record<AxisFilterKey, number | "">> = {};
    for (const key of AXIS_FILTER_KEYS) {
      entries[key] = filterValue(searchParams, key);
    }
    return entries;
  }, [searchParams]);

  const [rows, setRows] = useState<RowView[]>([]);
  const [meta, setMeta] = useState<{ totalItems: number; totalPages: number }>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const queryString = searchParams.toString();

  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const result = await listCandidates(
          {
            ...(queue
              ? { status: "partner_review" as const }
              : { status: (statusFilter || "") as CandidateStatus | "" }),
            ...(noveltyFilter
              ? { noveltyStatus: noveltyFilter as NoveltyStatus }
              : {}),
            ...axisFilters,
            page,
            pageSize: 25,
          },
          signal,
        );
        const identities = await resolveCompanyIdentities(
          result.data.map((candidate) => candidate.companyId),
          signal,
        );
        if (signal.aborted) return;
        setRows(
          result.data.map((candidate) => ({
            candidate,
            identity: identities.get(candidate.companyId) ?? {
              name: null,
              domain: null,
              headquartersCountryCode: null,
            },
          })),
        );
        setMeta({
          totalItems: result.meta?.totalItems ?? result.data.length,
          totalPages: result.meta?.totalPages ?? 1,
        });
      } catch (caught) {
        if (signal.aborted) return;
        setRows([]);
        setMeta(undefined);
        setError(
          caught instanceof Error ? caught.message : "Unable to load candidates.",
        );
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [axisFilters, noveltyFilter, page, queue, statusFilter],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, reloadKey, queryString]);

  function patchParams(mutate: (params: URLSearchParams) => void): void {
    const params = new URLSearchParams(queryString);
    mutate(params);
    if (!queue && !params.get("status")) params.delete("status");
    params.delete("page");
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  function setFilter(key: string, value: string): void {
    patchParams((params) => {
      if (value === "") params.delete(key);
      else params.set(key, value);
    });
  }

  function clearFilters(): void {
    router.replace(queue ? `${pathname}?queue=partner` : pathname, {
      scroll: false,
    });
  }

  const filteredRows = useMemo(() => {
    const query = textQuery.trim().toLocaleLowerCase("en-US");
    if (query === "") return rows;
    return rows.filter(({ identity }) => {
      const haystack =
        `${identity.name ?? ""} ${identity.domain ?? ""}`.toLocaleLowerCase(
          "en-US",
        );
      return haystack.includes(query);
    });
  }, [rows, textQuery]);

  const anyServerFilter =
    queue ||
    statusFilter !== "" ||
    noveltyFilter !== "" ||
    textQuery !== "" ||
    AXIS_FILTER_KEYS.some((key) => axisFilters[key] !== "");

  function handleRowStatus(candidateId: string, status: CandidateStatus): void {
    setRows((current) =>
      current.map((row) =>
        row.candidate.id === candidateId
          ? { ...row, candidate: { ...row.candidate, status } }
          : row,
      ),
    );
    setReloadKey((key) => key + 1);
  }

  function handleQueueResolution(candidateId: string): void {
    // Optimistic removal; the reload reconciles against the server.
    setRows((current) =>
      current.filter((row) => row.candidate.id !== candidateId),
    );
    setReloadKey((key) => key + 1);
  }

  return (
    <section aria-labelledby="target-feed-title">
      <div className="admin-panel">
        <header className="admin-panel__header">
          <h2 id="target-feed-title">
            {queue ? "Partner review queue" : "Scored candidates"}
          </h2>
          <p className="asi-page-description">
            {queue
              ? "Candidates routed to partner review, ordered by partner review priority. Actions record investment feedback and transition the candidate."
              : "Discovery candidates ranked by partner-review priority. Scores come from the champion scoring program; “—” means the axis was not scoreable."}
          </p>
        </header>
        <form
          className="admin-form-grid"
          role="search"
          onSubmit={(event) => event.preventDefault()}
        >
          {!queue ? (
            <label className="admin-field" htmlFor="feed-status">
              <span className="admin-field__label">Status</span>
              <Select
                id="feed-status"
                value={statusFilter}
                onChange={(event) => setFilter("status", event.target.value)}
              >
                <option value="">All statuses</option>
                {STATUS_FILTER_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {humanLabel(value)}
                  </option>
                ))}
              </Select>
            </label>
          ) : null}
          <label className="admin-field" htmlFor="feed-novelty">
            <span className="admin-field__label">Novelty verdict</span>
            <Select
              id="feed-novelty"
              value={noveltyFilter}
              onChange={(event) => setFilter("noveltyStatus", event.target.value)}
            >
              <option value="">All novelty verdicts</option>
              {NOVELTY_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {humanLabel(value)}
                </option>
              ))}
            </Select>
          </label>
          <label className="admin-field" htmlFor="feed-query">
            <span className="admin-field__label">Text filter (this page)</span>
            <Input
              id="feed-query"
              maxLength={200}
              placeholder="Company name or domain"
              value={textQuery}
              onChange={(event) => setFilter("q", event.target.value)}
            />
          </label>
          {AXIS_FILTER_KEYS.filter((key) => key.startsWith("min")).map((key) => (
            <label className="admin-field" key={key} htmlFor={`feed-${key}`}>
              <span className="admin-field__label">{AXIS_FILTER_LABELS[key]}</span>
              <Input
                id={`feed-${key}`}
                inputMode="numeric"
                max={101}
                min={-1}
                type="number"
                value={axisFilters[key] === "" ? "" : String(axisFilters[key])}
                onChange={(event) => setFilter(key, event.target.value)}
              />
            </label>
          ))}
          <div className="admin-actions">
            {anyServerFilter ? (
              <Button
                type="button"
                variant="ghost"
                disabled={loading}
                onClick={clearFilters}
              >
                Clear filters
              </Button>
            ) : null}
          </div>
        </form>
        <div className="admin-actions">
          <CatalogExport entity="candidates" />
        </div>
      </div>

      {error !== null ? (
        <div className="admin-feedback" data-tone="error" role="alert">
          <p>{error}</p>
          <Button
            size="small"
            variant="secondary"
            onClick={() => setReloadKey((key) => key + 1)}
          >
            Try again
          </Button>
        </div>
      ) : null}
      {loading ? (
        <p className="asi-page-description" role="status" aria-live="polite">
          Loading candidates…
        </p>
      ) : null}
      {!loading && error === null && filteredRows.length === 0 ? (
        <EmptyState
          title={
            anyServerFilter
              ? queue
                ? "Partner review queue is empty"
                : "No candidates match these filters"
              : "No scored candidates yet"
          }
          description={
            anyServerFilter
              ? queue
                ? "Every candidate routed to partner review has been decided. New candidates appear here after scoring routes them."
                : "Clear or change the filters to see other candidates."
              : "Candidates appear here after resolved companies are promoted through scoring. No fake or sample rows are shown."
          }
          action={
            anyServerFilter ? (
              <Button variant="secondary" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : null
          }
        />
      ) : null}

      {!loading && error === null && filteredRows.length > 0 ? (
        <>
          <Table>
            <TableCaption>
              {meta
                ? `${meta.totalItems.toLocaleString()} candidate${meta.totalItems === 1 ? "" : "s"}; page ${page} of ${Math.max(meta.totalPages, 1)}`
                : "Scored candidates"}
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Company</TableHead>
                <TableHead>Domain</TableHead>
                <TableHead>HQ</TableHead>
                <TableHead>Revenue band</TableHead>
                <TableHead>Ownership</TableHead>
                <TableHead>Scores (fit/novelty/conf/act)</TableHead>
                <TableHead>Novelty</TableHead>
                <TableHead>Status</TableHead>
                <TableHead numeric>Priority</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead>{queue ? "Decision" : "Actions"}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredRows.map(({ candidate, identity }) => (
                <TableRow key={candidate.id}>
                  <TableCell>
                    <Link href={`/candidates/${candidate.id}`}>
                      <strong>{identity.name ?? "Unnamed company"}</strong>
                    </Link>
                  </TableCell>
                  <TableCell>{identity.domain ?? "—"}</TableCell>
                  <TableCell>{identity.headquartersCountryCode ?? "—"}</TableCell>
                  <TableCell title="Revenue band comes from the feature snapshot; open the profile to see it">—</TableCell>
                  <TableCell title="Ownership chip comes from the feature snapshot; open the profile to see it">—</TableCell>
                  <TableCell>
                    <span style={{ display: "inline-flex", gap: "0.25rem", flexWrap: "wrap" }}>
                      <AxisChip axis="fit" value={candidate.currentScores.fit} />
                      <AxisChip axis="novelty" value={candidate.currentScores.novelty} />
                      <AxisChip axis="confidence" value={candidate.currentScores.confidence} />
                      <AxisChip axis="actionability" value={candidate.currentScores.actionability} />
                    </span>
                  </TableCell>
                  <TableCell>
                    <NoveltyBadge novelty={candidate.noveltyStatus} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={candidate.status} />
                  </TableCell>
                  <TableCell numeric>
                    {candidate.partnerReviewPriority === null
                      ? "—"
                      : Math.round(candidate.partnerReviewPriority).toString()}
                  </TableCell>
                  <TableCell>{formatInstant(candidate.updatedAt)}</TableCell>
                  <TableCell>
                    {queue ? (
                      <PartnerReviewActions
                        candidate={candidate}
                        onResolved={handleQueueResolution}
                      />
                    ) : (
                      <RowStatusMenu
                        candidate={candidate}
                        onUpdated={handleRowStatus}
                      />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <nav className="admin-actions" aria-label="Candidate pagination">
            <Button
              size="small"
              variant="secondary"
              disabled={page <= 1}
              onClick={() =>
                patchParams((params) => {
                  params.set("page", String(Math.max(1, page - 1)));
                })
              }
            >
              Previous
            </Button>
            <span className="asi-page-description" aria-live="polite">
              Page {page} of {Math.max(meta?.totalPages ?? 1, 1)}
            </span>
            <Button
              size="small"
              variant="secondary"
              disabled={!meta || page >= meta.totalPages}
              onClick={() =>
                patchParams((params) => {
                  params.set("page", String(page + 1));
                })
              }
            >
              Next
            </Button>
          </nav>
        </>
      ) : null}
    </section>
  );
}

export function TargetFeedQueue() {
  return <TargetFeed queue />;
}


