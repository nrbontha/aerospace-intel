"use client";

import type {
  CandidateDto,
  CandidateStatus,
  EffectiveTier,
  NoveltyStatus,
  TierOverride,
} from "@asi/contracts";
import { effectiveTierValues, tierOverrideValues } from "@asi/contracts";
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
  ConfidenceChip,
  NoveltyBadge,
  TierChip,
  confidenceBand,
  formatInstant,
  humanLabel,
  type ConfidenceBand,
} from "@/components/target-feed/candidate-bits";
import {
  createFeedback,
  listCandidates,
  resolveCandidateFacts,
  resolveCompanyIdentities,
  setCandidateTier,
  updateCandidateStatus,
  type CandidateRowFacts,
  type CompanyIdentity,
  type TierMutationResult,
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

const AXIS_FILTER_KEYS = ["minFit", "minNovelty", "minActionability"] as const;

type AxisFilterKey = (typeof AXIS_FILTER_KEYS)[number];

const AXIS_FILTER_LABELS: Record<AxisFilterKey, string> = {
  minFit: "Min fit",
  minNovelty: "Min novelty",
  minActionability: "Min actionability",
};

/** Confidence band → server-side axis range. Bands mirror
 * confidenceBand(): ≥70 strong, ≥50 medium, ≥25 weak, else thin. The
 * 0.01 gap keeps the <= range comparisons from overlapping neighbors. */
const CONFIDENCE_BAND_RANGES: Record<
  ConfidenceBand,
  { minConfidence?: number; maxConfidence?: number }
> = {
  strong: { minConfidence: 70 },
  medium: { minConfidence: 50, maxConfidence: 69.99 },
  weak: { minConfidence: 25, maxConfidence: 49.99 },
  thin: { maxConfidence: 24.99 },
};

// Frozen engine band ladders (packages/database/src/candidates/bands.ts;
// parity with the research engine is asserted there by unit test). Local
// copies because the client must not pull @asi/database into the bundle.
const REVENUE_BAND_OPTIONS: readonly string[] = [
  "<5m",
  "5-10m",
  "10-20m",
  "20-35m",
  "35-50m",
  "unknown",
];
const OWNERSHIP_TYPE_OPTIONS: readonly string[] = [
  "independent_founder",
  "independent_family",
  "pe_owned",
  "strategic_sub",
  "public_sub",
  "unknown",
];

// ---------------------------------------------------------------------------
// Saved views (URL-persisted presets, REDESIGN_PLAN §2.3)
// ---------------------------------------------------------------------------

type SavedView = Readonly<{
  key: string;
  label: string;
  /** URL params applied when the preset is chosen (clearing other filters). */
  params: Readonly<Record<string, string>>;
}>;

const SAVED_VIEWS: readonly SavedView[] = [
  {
    key: "partner-queue",
    label: "Partner queue",
    params: { tier: "high_interest" },
  },
  {
    key: "needs-research",
    label: "Needs research",
    params: { tier: "needs_research" },
  },
  { key: "watchlist", label: "Watchlist", params: { tier: "watchlist" } },
  // No created-after API param exists yet, so freshness filters client-side
  // over the loaded page — surfaced honestly in the UI.
  { key: "fresh-finds", label: "Fresh finds (24h)", params: { fresh: "24h" } },
];

const FILTER_PARAM_KEYS = [
  "tier",
  "noveltyStatus",
  "confBand",
  "ownership",
  "revenue",
  "lowconf",
  "origin",
  "q",
  "fresh",
  ...AXIS_FILTER_KEYS,
] as const;

function activeSavedViewKey(searchParams: URLSearchParams): string | null {
  for (const view of SAVED_VIEWS) {
    const entries = Object.entries(view.params);
    if (
      entries.every(([key, value]) => searchParams.get(key) === value) &&
      !FILTER_PARAM_KEYS.some(
        (key) =>
          !(key in view.params) &&
          (searchParams.get(key) ?? "") !== "" &&
          key !== "origin",
      )
    ) {
      return view.key;
    }
  }
  return null;
}

type RowView = Readonly<{
  candidate: CandidateDto;
  identity: CompanyIdentity;
  facts: CandidateRowFacts;
}>;

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
// Per-row tier menu (single-row human override with audit note)
// ---------------------------------------------------------------------------

function RowTierMenu({
  candidate,
  onUpdated,
}: {
  candidate: CandidateDto;
  onUpdated: (candidateId: string, result: TierMutationResult) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draftTier, setDraftTier] = useState<TierOverride>("high_interest");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const result = await setCandidateTier(
        candidate.id,
        draftTier,
        note.trim() === "" ? undefined : note.trim(),
      );
      onUpdated(candidate.id, result);
      setOpen(false);
      setNote("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Tier change failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <details
      open={open}
      onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
    >
      <summary>Tier ▾</summary>
      <div
        style={{
          minWidth: "16rem",
          padding: "0.5rem",
          border: "1px solid var(--asi-border, currentColor)",
          borderRadius: "4px",
          background: "var(--asi-surface-muted, transparent)",
        }}
      >
        <p className="asi-page-description" role="note">
          Human override — audited, recorded as investment feedback, and
          pinned: engine routing may still move the underlying status, but it
          will not change your tier.
        </p>
        <label className="admin-field">
          <span className="admin-field__label">Set tier</span>
          <Select
            value={draftTier}
            onChange={(event) => setDraftTier(event.target.value as TierOverride)}
          >
            {tierOverrideValues.map((tier) => (
              <option key={tier} value={tier}>
                {humanLabel(tier)}
              </option>
            ))}
          </Select>
        </label>
        <label className="admin-field">
          <span className="admin-field__label">Audit note</span>
          <Input
            maxLength={2000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Why this tier (recorded with the override)"
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
// Per-row status menu (single-row bookkeeping with audit note; also used by
// the candidate profile page)
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

export function TargetFeed() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const tierFilter = searchParams.get("tier") ?? "";
  const noveltyFilter = searchParams.get("noveltyStatus") ?? "";
  const confidenceBandFilter = searchParams.get("confBand") ?? "";
  const ownershipFilter = searchParams.get("ownership") ?? "";
  const revenueFilter = searchParams.get("revenue") ?? "";
  const lowConfidenceOnly = searchParams.get("lowconf") === "1";
  const freshOnly = searchParams.get("fresh") === "24h";
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
        const bandRange =
          confidenceBandFilter !== ""
            ? CONFIDENCE_BAND_RANGES[confidenceBandFilter as ConfidenceBand]
            : undefined;
        const result = await listCandidates(
          {
            ...(tierFilter ? { tier: tierFilter as EffectiveTier } : {}),
            ...(noveltyFilter
              ? { noveltyStatus: noveltyFilter as NoveltyStatus }
              : {}),
            ...(bandRange ?? {}),
            ...axisFilters,
            page,
            pageSize: 25,
          },
          signal,
        );
        const [identities, facts] = await Promise.all([
          resolveCompanyIdentities(
            result.data.map((candidate) => candidate.companyId),
            signal,
          ),
          resolveCandidateFacts(
            result.data.map((candidate) => candidate.id),
            signal,
          ),
        ]);
        if (signal.aborted) return;
        setRows(
          result.data.map((candidate) => ({
            candidate,
            identity: identities.get(candidate.companyId) ?? {
              name: null,
              domain: null,
              headquartersCountryCode: null,
            },
            facts: facts.get(candidate.id) ?? {
              revenueBand: null,
              ownershipType: null,
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
    [axisFilters, confidenceBandFilter, noveltyFilter, page, tierFilter],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, reloadKey, queryString]);

  function patchParams(mutate: (params: URLSearchParams) => void): void {
    const params = new URLSearchParams(queryString);
    mutate(params);
    if (!params.get("tier")) params.delete("tier");
    if (!params.get("confBand")) params.delete("confBand");
    if (!params.get("lowconf")) params.delete("lowconf");
    if (!params.get("fresh")) params.delete("fresh");
    params.delete("page");
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  function setFilter(key: string, value: string): void {
    patchParams((params) => {
      if (value === "") params.delete(key);
      else params.set(key, value);
    });
  }

  function applySavedView(view: SavedView): void {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(view.params)) {
      params.set(key, value);
    }
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  function clearFilters(): void {
    router.replace(pathname, { scroll: false });
  }

  // Client-side fallbacks operate on the loaded page only (labeled in the UI):
  // text match, ownership/revenue band (feature snapshot slice), the
  // low-confidence-fields proxy, and the 24h freshness window. The API does
  // not support these predicates server-side yet.
  const filteredRows = useMemo(() => {
    const query = textQuery.trim().toLocaleLowerCase("en-US");
    const cutoff = freshOnly ? Date.now() - 24 * 60 * 60 * 1000 : null;
    return rows.filter(({ candidate, identity, facts }) => {
      if (query !== "") {
        const haystack =
          `${identity.name ?? ""} ${identity.domain ?? ""}`.toLocaleLowerCase(
            "en-US",
          );
        if (!haystack.includes(query)) return false;
      }
      if (
        ownershipFilter !== "" &&
        (facts.ownershipType ?? "unknown") !== ownershipFilter
      ) {
        return false;
      }
      if (
        revenueFilter !== "" &&
        (facts.revenueBand ?? "unknown") !== revenueFilter
      ) {
        return false;
      }
      if (lowConfidenceOnly) {
        const band = confidenceBand(candidate.currentScores.confidence);
        if (band !== "weak" && band !== "thin") return false;
      }
      if (
        cutoff !== null &&
        new Date(candidate.createdAt).getTime() < cutoff
      ) {
        return false;
      }
      return true;
    });
  }, [rows, textQuery, ownershipFilter, revenueFilter, lowConfidenceOnly, freshOnly]);

  const anyServerFilter =
    tierFilter !== "" ||
    noveltyFilter !== "" ||
    confidenceBandFilter !== "" ||
    textQuery !== "" ||
    AXIS_FILTER_KEYS.some((key) => axisFilters[key] !== "");
  const anyClientFilter =
    ownershipFilter !== "" ||
    revenueFilter !== "" ||
    lowConfidenceOnly ||
    freshOnly;
  const anyFilter = anyServerFilter || anyClientFilter;

  const activeViewKey = activeSavedViewKey(searchParams);

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

  function handleRowTier(
    candidateId: string,
    result: TierMutationResult,
  ): void {
    setRows((current) =>
      current.map((row) =>
        row.candidate.id === candidateId
          ? {
              ...row,
              candidate: {
                ...row.candidate,
                status: result.status,
                tierOverride: result.tierOverride,
                tierSource: result.tierSource,
                effectiveTier: result.effectiveTier,
              },
            }
          : row,
      ),
    );
    setReloadKey((key) => key + 1);
  }

  return (
    <section aria-labelledby="target-feed-title">
      <div className="admin-panel">
        <header className="admin-panel__header">
            <h2 id="target-feed-title">Scored candidates</h2>
          <p className="asi-page-description">
            One tiered table of every acquisition-target candidate. Tiers are
            engine-proposed and human-overridable; overrides are audited and
            survive engine re-routing.
          </p>
        </header>
        <div className="admin-actions" role="group" aria-label="Saved views">
          <span className="admin-field__label">Saved views</span>
          {SAVED_VIEWS.map((view) => (
            <Button
              key={view.key}
              size="small"
              variant={activeViewKey === view.key ? "secondary" : "ghost"}
              aria-pressed={activeViewKey === view.key}
              title={
                view.key === "fresh-finds"
                  ? "Client-side filter over the currently loaded page"
                  : view.label
              }
              onClick={() => applySavedView(view)}
            >
              {view.label}
            </Button>
          ))}
        </div>
        <form
          className="admin-form-grid"
          role="search"
          onSubmit={(event) => event.preventDefault()}
        >
          <label className="admin-field" htmlFor="feed-tier">
            <span className="admin-field__label">Tier</span>
            <Select
              id="feed-tier"
              value={tierFilter}
              onChange={(event) => setFilter("tier", event.target.value)}
            >
              <option value="">All tiers</option>
              {effectiveTierValues.map((tier) => (
                <option key={tier} value={tier}>
                  {humanLabel(tier)}
                </option>
              ))}
            </Select>
          </label>
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
          <label className="admin-field" htmlFor="feed-conf-band">
            <span className="admin-field__label">Confidence band</span>
            <Select
              id="feed-conf-band"
              value={confidenceBandFilter}
              onChange={(event) => setFilter("confBand", event.target.value)}
            >
              <option value="">All bands</option>
              <option value="strong">Strong</option>
              <option value="medium">Medium</option>
              <option value="weak">Weak</option>
              <option value="thin">Thin</option>
            </Select>
          </label>
          <label className="admin-field" htmlFor="feed-ownership">
            <span className="admin-field__label">Ownership †</span>
            <Select
              id="feed-ownership"
              value={ownershipFilter}
              onChange={(event) => setFilter("ownership", event.target.value)}
            >
              <option value="">All ownership types</option>
              {OWNERSHIP_TYPE_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {humanLabel(value)}
                </option>
              ))}
            </Select>
          </label>
          <label className="admin-field" htmlFor="feed-revenue">
            <span className="admin-field__label">Revenue band †</span>
            <Select
              id="feed-revenue"
              value={revenueFilter}
              onChange={(event) => setFilter("revenue", event.target.value)}
            >
              <option value="">All revenue bands</option>
              {REVENUE_BAND_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </label>
          <label className="admin-field" htmlFor="feed-origin">
            <span className="admin-field__label">Discovery origin</span>
            <Select
              id="feed-origin"
              disabled
              title="Discovery provenance is not tracked by the API yet"
              defaultValue=""
            >
              <option value="">Not tracked by the API yet</option>
            </Select>
          </label>
          <label className="admin-field" htmlFor="feed-lowconf">
            <span className="admin-field__label">Low-confidence fields †</span>
            <Select
              id="feed-lowconf"
              value={lowConfidenceOnly ? "1" : ""}
              onChange={(event) =>
                setFilter("lowconf", event.target.value === "1" ? "1" : "")
              }
            >
              <option value="">Any evidence quality</option>
              <option value="1">Weak/thin confidence only</option>
            </Select>
          </label>
          <label className="admin-field" htmlFor="feed-query">
            <span className="admin-field__label">Text filter †</span>
            <Input
              id="feed-query"
              maxLength={200}
              placeholder="Company name or domain"
              value={textQuery}
              onChange={(event) => setFilter("q", event.target.value)}
            />
          </label>
          {AXIS_FILTER_KEYS.map((key) => (
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
            {anyFilter ? (
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
          <p className="asi-page-description">
            † runs client-side against the currently loaded page — the
            candidates list API does not support these predicates yet.
          </p>
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
            anyFilter
              ? "No candidates match these filters"
              : "No scored candidates yet"
          }
          description={
            anyFilter
              ? "Clear or change the filters to see other candidates."
              : "Candidates appear here after resolved companies are promoted through scoring. No fake or sample rows are shown."
          }
          action={
            anyFilter ? (
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
                <TableHead>Tier</TableHead>
                <TableHead>Company</TableHead>
                <TableHead>Domain</TableHead>
                <TableHead>HQ</TableHead>
                <TableHead>Revenue band</TableHead>
                <TableHead>Ownership</TableHead>
                <TableHead>Novelty</TableHead>
                <TableHead>Confidence</TableHead>
                <TableHead title="Last researched / last update">Last researched</TableHead>
                <TableHead title="Discovery provenance">Source</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredRows.map(({ candidate, identity, facts }) => {
                const band = confidenceBand(candidate.currentScores.confidence);
                const lowConfidenceFields = band === "weak" || band === "thin";
                return (
                  <TableRow key={candidate.id}>
                    <TableCell>
                      <TierChip
                        tier={candidate.effectiveTier}
                        pinned={
                          candidate.tierSource === "human" &&
                          candidate.tierOverride !== null
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <Link href={`/candidates/${candidate.id}`}>
                        <strong>{identity.name ?? "Unnamed company"}</strong>
                      </Link>
                    </TableCell>
                    <TableCell>{identity.domain ?? "—"}</TableCell>
                    <TableCell>{identity.headquartersCountryCode ?? "—"}</TableCell>
                    <TableCell>{facts.revenueBand ?? "—"}</TableCell>
                    <TableCell>
                      {facts.ownershipType === null
                        ? "—"
                        : humanLabel(facts.ownershipType)}
                    </TableCell>
                    <TableCell>
                      <NoveltyBadge novelty={candidate.noveltyStatus} />
                    </TableCell>
                    <TableCell>
                      <span
                        style={{
                          display: "inline-flex",
                          gap: "0.25rem",
                          alignItems: "baseline",
                        }}
                      >
                        <ConfidenceChip value={candidate.currentScores.confidence} />
                        {lowConfidenceFields ? (
                          <Link
                            href={`/candidates/${candidate.id}`}
                            aria-label={`Low-confidence material fields — review field badges on the profile`}
                            title="Low-confidence material fields — review field badges on the profile"
                          >
                            ⚠
                          </Link>
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell>{formatInstant(candidate.updatedAt)}</TableCell>
                    <TableCell>
                      <span
                        className="asi-badge"
                        style={{ opacity: 0.6 }}
                        title="Discovery provenance is not surfaced by the API yet"
                      >
                        untracked
                      </span>
                    </TableCell>
                    <TableCell>
                      <span
                        style={{
                          display: "inline-flex",
                          gap: "0.5rem",
                          alignItems: "flex-start",
                        }}
                      >
                        <RowTierMenu
                          candidate={candidate}
                          onUpdated={handleRowTier}
                        />
                        <RowStatusMenu
                          candidate={candidate}
                          onUpdated={handleRowStatus}
                        />
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })}
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
