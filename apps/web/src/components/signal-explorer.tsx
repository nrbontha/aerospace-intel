"use client";

import {
  Badge,
  Button,
  EmptyState,
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
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { apiJson } from "@/components/csrf-client";
import { GoldenBadge } from "@/components/golden-badge";
import { InvestorRankingDisplay } from "@/components/investor-ranking";
import type {
  JsonRecord,
  SignalOverviewCursorDto,
  SignalOverviewDto,
  SignalOverviewPageDto,
} from "@/lib/signal-analyst";

const PAGE_SIZE = 100;
const REFRESH_INTERVAL_MS = 30_000;

type QueueSort = "priority" | "newest";
type ReadinessFilter = "" | "ready" | "needs_research" | "blocked" | "unscored";

type QueueFilters = Readonly<{
  sort: QueueSort;
  q: string;
  readiness: ReadinessFilter;
}>;

function recordValue(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function verifiedIdentity(item: SignalOverviewDto): string {
  const research = recordValue(item.review?.researchEvidence);
  if (
    item.review !== null &&
    item.review.sourceRevision !== item.signal.reviewRevision
  ) {
    return "Historical evidence only";
  }
  const identity = recordValue(research?.["identity"]);
  if (identity?.["status"] !== "verified") return "Unverified";
  const domain = identity["verifiedDomain"];
  return typeof domain === "string" && domain.trim() !== ""
    ? domain
    : "Verified; domain not recorded";
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "Not recorded";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString();
}

function dueText(value: string | null | undefined): string {
  if (!value) return "No retry scheduled";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString();
}

function conciseMuseSummary(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const maxLength = 280;
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 1)}…`;
}

function overviewUrl(
  filters: QueueFilters,
  cursor: SignalOverviewCursorDto | null,
): string {
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    sort: filters.sort,
  });
  if (filters.q !== "") params.set("q", filters.q);
  if (filters.readiness !== "") params.set("readiness", filters.readiness);
  if (cursor !== null) params.set("cursor", JSON.stringify(cursor));
  return `/api/v1/signals?${params.toString()}`;
}

async function fetchOverviewDepth(
  filters: QueueFilters,
  targetDepth: number,
  signal: AbortSignal,
): Promise<{
  items: readonly SignalOverviewDto[];
  nextCursor: SignalOverviewCursorDto | null;
}> {
  const uniqueItems = new Map<string, SignalOverviewDto>();
  const seenCursors = new Set<string>();
  let cursor: SignalOverviewCursorDto | null = null;
  let nextCursor: SignalOverviewCursorDto | null;

  do {
    const page: SignalOverviewPageDto = await apiJson<SignalOverviewPageDto>(
      overviewUrl(filters, cursor),
      { signal },
    );
    for (const item of page.items) uniqueItems.set(item.signal.id, item);
    nextCursor = page.nextCursor;
    if (nextCursor === null || uniqueItems.size >= targetDepth) break;

    const serializedCursor = JSON.stringify(nextCursor);
    if (seenCursors.has(serializedCursor)) break;
    seenCursors.add(serializedCursor);
    cursor = nextCursor;
  } while (!signal.aborted);

  return { items: [...uniqueItems.values()], nextCursor };
}

function readinessTone(
  value: "ready" | "needs_research" | "blocked",
): "success" | "warning" | "danger" {
  if (value === "ready") return "success";
  if (value === "blocked") return "danger";
  return "warning";
}

export function SignalExplorer() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryString = searchParams.toString();
  const sort: QueueSort =
    searchParams.get("sort") === "newest" ? "newest" : "priority";
  const readinessValue = searchParams.get("readiness");
  const readiness: ReadinessFilter =
    readinessValue === "ready" ||
    readinessValue === "needs_research" ||
    readinessValue === "blocked" ||
    readinessValue === "unscored"
      ? readinessValue
      : "";
  const q = (searchParams.get("q") ?? "").trim().slice(0, 200);
  const filterKey = `${sort}\u0000${readiness}\u0000${q}`;
  const filters = useMemo<QueueFilters>(
    () => ({ sort, q, readiness }),
    [q, readiness, sort],
  );

  const [items, setItems] = useState<readonly SignalOverviewDto[]>([]);
  const [nextCursor, setNextCursor] = useState<SignalOverviewCursorDto | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [autoRefreshPaused, setAutoRefreshPaused] = useState(false);
  const [lastSuccessfulRefresh, setLastSuccessfulRefresh] = useState<Date>();
  const [error, setError] = useState<string>();
  const [downloadError, setDownloadError] = useState<string>();
  const [downloading, setDownloading] = useState(false);
  const [searchDraft, setSearchDraft] = useState(q);
  const activeRequestRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const requestedDepthRef = useRef(PAGE_SIZE);

  useEffect(() => {
    setSearchDraft(q);
  }, [q]);

  const replaceItems = useCallback(
    (showInitialLoading: boolean, supersede = false): AbortController | null => {
      const activeRequest = activeRequestRef.current;
      if (activeRequest !== null && !activeRequest.signal.aborted) {
        if (!supersede) return null;
        activeRequest.abort();
      }

      const controller = new AbortController();
      const generation = ++generationRef.current;
      activeRequestRef.current = controller;
      if (showInitialLoading) {
        setLoading(true);
        setRefreshing(false);
        setLoadingMore(false);
      } else {
        setRefreshing(true);
      }
      setError(undefined);

      void fetchOverviewDepth(
        filters,
        requestedDepthRef.current,
        controller.signal,
      )
        .then((page) => {
          if (
            controller.signal.aborted ||
            generation !== generationRef.current
          ) {
            return;
          }
          setItems(page.items);
          setNextCursor(page.nextCursor);
          setLastSuccessfulRefresh(new Date());
        })
        .catch((caught: unknown) => {
          if (
            controller.signal.aborted ||
            generation !== generationRef.current
          ) {
            return;
          }
          setError(
            caught instanceof Error
              ? caught.message
              : "Unable to load the investor research queue.",
          );
        })
        .finally(() => {
          if (
            activeRequestRef.current !== controller ||
            generation !== generationRef.current
          ) {
            return;
          }
          activeRequestRef.current = null;
          setLoading(false);
          setRefreshing(false);
        });
      return controller;
    },
    [filters],
  );

  useEffect(() => {
    requestedDepthRef.current = PAGE_SIZE;
    setItems([]);
    setNextCursor(null);
    const controller = replaceItems(true, true);
    return () => controller?.abort();
  }, [filterKey, replaceItems]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      activeRequestRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    const refreshForVisibility = () => {
      if (
        document.visibilityState === "visible" &&
        !autoRefreshPaused
      ) {
        replaceItems(false);
      }
    };
    const timer = autoRefreshPaused
      ? undefined
      : window.setInterval(() => {
          if (document.visibilityState === "visible") replaceItems(false);
        }, REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", refreshForVisibility);
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshForVisibility);
    };
  }, [autoRefreshPaused, replaceItems]);

  async function loadMore(): Promise<void> {
    if (
      nextCursor === null ||
      (activeRequestRef.current !== null &&
        !activeRequestRef.current.signal.aborted)
    ) {
      return;
    }

    const controller = new AbortController();
    const generation = ++generationRef.current;
    activeRequestRef.current = controller;
    setLoadingMore(true);
    setError(undefined);
    try {
      const page = await apiJson<SignalOverviewPageDto>(
        overviewUrl(filters, nextCursor),
        { signal: controller.signal },
      );
      if (controller.signal.aborted || generation !== generationRef.current) return;
      setItems((current) => {
        const uniqueItems = new Map(
          current.map((item) => [item.signal.id, item] as const),
        );
        for (const item of page.items) uniqueItems.set(item.signal.id, item);
        return [...uniqueItems.values()];
      });
      requestedDepthRef.current += PAGE_SIZE;
      setNextCursor(page.nextCursor);
      setLastSuccessfulRefresh(new Date());
    } catch (caught) {
      if (controller.signal.aborted || generation !== generationRef.current) return;
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to load more source signals.",
      );
    } finally {
      if (
        activeRequestRef.current === controller &&
        generation === generationRef.current
      ) {
        activeRequestRef.current = null;
        setLoadingMore(false);
      }
    }
  }

  function patchParams(
    mutate: (params: URLSearchParams) => void,
  ): void {
    const params = new URLSearchParams(queryString);
    mutate(params);
    if ((params.get("q") ?? "").trim() === "") params.delete("q");
    if ((params.get("readiness") ?? "") === "") params.delete("readiness");
    if (params.get("sort") !== "newest") params.delete("sort");
    params.delete("cursor");
    const nextQuery = params.toString();
    router.replace(nextQuery === "" ? pathname : `${pathname}?${nextQuery}`, {
      scroll: false,
    });
  }

  function submitSearch(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    patchParams((params) => {
      const nextQuery = searchDraft.trim().slice(0, 200);
      if (nextQuery === "") params.delete("q");
      else params.set("q", nextQuery);
    });
  }

  async function download(format: "csv" | "json"): Promise<void> {
    setDownloading(true);
    setDownloadError(undefined);
    try {
      const params = new URLSearchParams({ format, sort });
      if (q !== "") params.set("q", q);
      if (readiness !== "") params.set("readiness", readiness);
      const response = await fetch(`/api/v1/signals/export?${params}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(`Export failed (${response.status}).`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const disposition = response.headers.get("content-disposition");
      link.href = url;
      link.download =
        disposition?.match(/filename="([^"]+)"/)?.[1] ??
        `source-signals.${format}`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setDownloadError(
        caught instanceof Error ? caught.message : "Export failed.",
      );
    } finally {
      setDownloading(false);
    }
  }

  const hasFilters = q !== "" || readiness !== "" || sort !== "priority";
  const busy = loading || refreshing || loadingMore;

  if (loading && items.length === 0) {
    return (
      <div className="admin-stack" aria-busy>
        <div className="admin-panel" role="status" aria-live="polite">
          Loading investor research queue…
        </div>
      </div>
    );
  }
  if (error && items.length === 0) {
    return (
      <div className="admin-stack">
        <EmptyState
          title="Research queue unavailable"
          description={<p>{error}</p>}
          action={
            <Button onClick={() => replaceItems(true)}>Try again</Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="admin-stack" aria-busy={busy}>
      <section className="admin-panel admin-stack" aria-label="Queue controls">
        <form className="signal-queue-controls" onSubmit={submitSearch}>
          <div className="admin-field signal-queue-controls__search">
            <label className="admin-field__label" htmlFor="signal-queue-search">
              Source name or domain
            </label>
            <input
              className="login-input"
              id="signal-queue-search"
              maxLength={200}
              onChange={(event) => setSearchDraft(event.target.value)}
              placeholder="Search source records"
              type="search"
              value={searchDraft}
            />
          </div>
          <Button type="submit" variant="secondary">
            Search
          </Button>
          <div className="admin-field">
            <label className="admin-field__label" htmlFor="signal-readiness">
              Acquisition readiness
            </label>
            <select
              className="login-input"
              id="signal-readiness"
              onChange={(event) =>
                patchParams((params) => {
                  if (event.target.value === "") params.delete("readiness");
                  else params.set("readiness", event.target.value);
                })
              }
              value={readiness}
            >
              <option value="">All readiness states</option>
              <option value="ready">Ready</option>
              <option value="needs_research">Needs research</option>
              <option value="blocked">Blocked</option>
              <option value="unscored">Unknown / unscored</option>
            </select>
          </div>
          <div className="admin-field">
            <label className="admin-field__label" htmlFor="signal-sort">
              Order
            </label>
            <select
              className="login-input"
              id="signal-sort"
              onChange={(event) =>
                patchParams((params) => {
                  if (event.target.value === "newest") {
                    params.set("sort", "newest");
                  } else {
                    params.delete("sort");
                  }
                })
              }
              value={sort}
            >
              <option value="priority">Research priority</option>
              <option value="newest">Newest source record</option>
            </select>
          </div>
          {hasFilters ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => router.replace(pathname, { scroll: false })}
            >
              Clear filters
            </Button>
          ) : null}
        </form>

        <div className="signal-refresh-bar">
          <div aria-live="polite">
            <strong>
              {autoRefreshPaused ? "Automatic refresh paused" : "Live ordering on"}
            </strong>
            <span className="signal-refresh-bar__meta">
              Approximately every 30 seconds while this tab is visible · Last
              successful refresh:{" "}
              {lastSuccessfulRefresh
                ? lastSuccessfulRefresh.toLocaleString()
                : "Not yet"}
            </span>
          </div>
          <div className="admin-actions">
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => replaceItems(false)}
            >
              {refreshing ? "Refreshing…" : "Refresh now"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              aria-pressed={autoRefreshPaused}
              onClick={() => setAutoRefreshPaused((paused) => !paused)}
            >
              {autoRefreshPaused ? "Resume automatic refresh" : "Pause automatic refresh"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={downloading}
              onClick={() => void download("csv")}
            >
              Export CSV
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={downloading}
              onClick={() => void download("json")}
            >
              Export JSON
            </Button>
          </div>
        </div>
      </section>

      <p className="asi-page-description">
        {sort === "priority"
          ? "The whole matching dataset is ordered by the current research-priority policy before pagination. Scores may move as Jev and Muse evidence changes."
          : "The whole matching dataset is ordered by newest source record. Priority scores remain visible but do not control this view."}
      </p>

      {downloadError ? (
        <p className="admin-feedback" data-tone="error" role="alert">
          {downloadError}
        </p>
      ) : null}
      {items.length === 0 ? (
        <EmptyState
          title={hasFilters ? "No source signals match" : "No source signals"}
          description={
            <p>
              {hasFilters
                ? "Try a different name, domain, readiness state, or ordering."
                : "No raw source observations have been imported. No company records are created by this view."}
            </p>
          }
          action={
            hasFilters ? (
              <Button
                variant="secondary"
                onClick={() => router.replace(pathname, { scroll: false })}
              >
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="signal-table-wrap">
          <Table>
            <TableCaption>
              Investor research queue of raw source observations. These rows are
              not canonical companies, investment recommendations, or automatic
              approvals.
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Research priority</TableHead>
                <TableHead scope="col">Raw source identity</TableHead>
                <TableHead scope="col">Verified identity</TableHead>
                <TableHead scope="col">Readiness and gaps</TableHead>
                <TableHead scope="col">Current Jev / Muse progress</TableHead>
                <TableHead scope="col">Next action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => {
                const triage = item.currentTriage?.parsed;
                const museSummary = item.memoEvidenceCurrent
                  ? conciseMuseSummary(item.memoSummary)
                  : null;
                return (
                  <TableRow key={item.signal.id}>
                    <TableCell>
                      <InvestorRankingDisplay ranking={item.ranking} compact />
                    </TableCell>
                    <TableHead scope="row" className="signal-table__identity">
                      <Link href={`/signals/${item.signal.id}`}>
                        {item.signal.rawName}
                      </Link>
                      {item.investorApproved ? <GoldenBadge /> : null}
                      <span className="signal-table__meta">
                        {item.signal.rawDomain ?? "Domain unknown"}
                      </span>
                      <span
                        className="signal-table__meta"
                        title={item.signal.sourceLocator}
                      >
                        {item.signal.sourceKey} · {item.signal.sourceLocator}
                      </span>
                    </TableHead>
                    <TableCell>{verifiedIdentity(item)}</TableCell>
                    <TableCell>
                      {triage ? (
                        <span className="signal-table__stack">
                          <Badge tone={readinessTone(triage.acquisitionReadiness)}>
                            {triage.acquisitionReadiness.replaceAll("_", " ")}
                          </Badge>
                          <span>
                            {triage.gaps.length} open research gap
                            {triage.gaps.length === 1 ? "" : "s"}
                          </span>
                        </span>
                      ) : (
                        <span className="signal-table__stack">
                          <Badge tone="warning">unknown / unscored</Badge>
                          <span>No current-policy Jev result</span>
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="signal-table__stack">
                        <span>
                          <strong>Jev:</strong>{" "}
                          {triage
                            ? `${triage.productFit.replaceAll("_", " ")} · current`
                            : "no current proof"}
                        </span>
                        <span>
                          <strong>Muse:</strong>{" "}
                          {item.currentCase
                            ? `${item.currentCase.status} · ${
                                item.currentCaseProofCurrent
                                  ? "current proof"
                                  : "proof not current"
                              } · ${
                                item.memoCurrent
                                  ? "current research memo"
                                  : item.memoEvidenceCurrent
                                    ? "Muse research · In progress"
                                    : item.currentCase.memo
                                      ? "draft / historical memo"
                                      : "no memo"
                              }`
                            : "no current-policy case"}
                        </span>
                        {museSummary ? (
                          <span>
                            <strong>
                              {item.memoCurrent
                                ? "Muse findings"
                                : "Provisional findings"}
                              :
                            </strong>{" "}
                            {museSummary}{" "}
                            <Link href={`/signals/${item.signal.id}#muse-research`}>
                              View sourced findings
                            </Link>
                          </span>
                        ) : item.currentCase?.memo ? (
                          <span>
                            <strong>Muse findings:</strong> Draft or historical
                            memo — open research record.
                          </span>
                        ) : null}
                        <span>Review stage: {item.review?.phase ?? "not started"}</span>
                        <span>
                          Score updated: {formatTime(item.ranking.updatedAt)}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell>
                      {dueText(
                        item.currentCase?.nextAttemptAt ??
                          item.review?.nextAttemptAt,
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {error ? (
        <div className="signal-refresh-error" role="alert">
          <p className="admin-feedback" data-tone="error">
            {error} Existing rows remain visible.
          </p>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => replaceItems(false)}
          >
            Retry refresh
          </Button>
        </div>
      ) : null}
      {nextCursor ? (
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => void loadMore()}
        >
          {loadingMore ? "Loading…" : `Load ${PAGE_SIZE} more source signals`}
        </Button>
      ) : items.length > 0 ? (
        <p className="asi-page-description">
          End of matching source-signal list · {items.length} unique record
          {items.length === 1 ? "" : "s"} loaded.
        </p>
      ) : null}
    </div>
  );
}
