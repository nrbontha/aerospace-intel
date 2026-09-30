"use client";

import type { SignalTimelineEvent } from "@asi/database";
import { Badge, Button, EmptyState } from "@asi/ui";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiJson } from "@/components/csrf-client";
import { isNavigableHttpUrl } from "@/lib/signal-analyst";

const TIMELINE_PAGE_SIZE = 50;

type SignalTimelinePage = Readonly<{
  items: readonly SignalTimelineEvent[];
  nextCursor: string | null;
}>;

function formatTime(value: string | null): string {
  if (value === null || value.trim() === "") return "Not recorded";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? value
    : `${value} (${parsed.toLocaleString()})`;
}

function timelineUrl(signalId: string, after: string | null): string {
  const parameters = new URLSearchParams({ limit: String(TIMELINE_PAGE_SIZE) });
  if (after !== null) parameters.set("after", after);
  return `/api/v1/signals/${encodeURIComponent(signalId)}/timeline?${parameters.toString()}`;
}

function TimelineSources({ event }: { event: SignalTimelineEvent }) {
  if (event.sources.length === 0) {
    return (
      <p className="asi-page-description">
        No source link is retained for this event.
      </p>
    );
  }
  return (
    <ul className="signal-timeline__sources" aria-label="Event sources">
      {event.sources.map((source, index) => (
        <li key={`${source.url}-${index}`}>
          {isNavigableHttpUrl(source.url) ? (
            <a href={source.url} rel="noreferrer" target="_blank">
              {source.title?.trim() || source.url}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : (
            <span>{source.title?.trim() || source.url}</span>
          )}
          {source.role ? (
            <span className="signal-timeline__source-role">
              {" "}
              —{" "}
              {source.role === "support"
                ? "Support"
                : source.role === "discovery_only"
                  ? "Discovery only (not evidence)"
                  : "Checked failure"}
            </span>
          ) : null}
          {source.representation ? (
            <span className="signal-timeline__source-representation">
              {" "}
              ({source.representation})
            </span>
          ) : null}
          {source.quote ? <blockquote>{source.quote}</blockquote> : null}
        </li>
      ))}
    </ul>
  );
}

function TimelineEvent({ event }: { event: SignalTimelineEvent }) {
  const rungValue = event.details["rung"];
  const stageValue = event.details["stage"];
  const rung =
    typeof rungValue === "string" && rungValue.trim() !== ""
      ? rungValue
      : typeof stageValue === "string" && stageValue.trim() !== ""
        ? stageValue
        : null;
  const cost =
    event.costKnown === true && event.costUsd !== null
      ? `$${event.costUsd} known actual`
      : event.costKnown === false
        ? "Actual cost unknown"
        : "Cost not recorded";

  return (
    <li className="signal-timeline__event">
      <div className="signal-section-heading">
        <div>
          <h3>{event.title}</h3>
          <span className="signal-timeline__kind">{event.kind}</span>
        </div>
        {event.status ? <Badge>{event.status}</Badge> : null}
      </div>
      {event.summary ? <p>{event.summary}</p> : null}
      <dl className="signal-facts signal-facts--compact">
        <div className="signal-fact">
          <dt>Started / observed</dt>
          <dd>
            <time dateTime={event.occurredAt}>
              {formatTime(event.occurredAt)}
            </time>
          </dd>
        </div>
        <div className="signal-fact">
          <dt>Ended</dt>
          <dd>
            {event.endedAt ? (
              <time dateTime={event.endedAt}>{formatTime(event.endedAt)}</time>
            ) : (
              "Not recorded"
            )}
          </dd>
        </div>
        <div className="signal-fact">
          <dt>Actor</dt>
          <dd>{event.actor}</dd>
        </div>
        <div className="signal-fact">
          <dt>Rung / stage</dt>
          <dd>{rung ?? "Not recorded"}</dd>
        </div>
        <div className="signal-fact">
          <dt>Outcome</dt>
          <dd>{event.status ?? "Not recorded"}</dd>
        </div>
        <div className="signal-fact">
          <dt>Cost</dt>
          <dd>{cost}</dd>
        </div>
        <div className="signal-fact">
          <dt>Model</dt>
          <dd>
            {event.modelId ? <code>{event.modelId}</code> : "Not recorded"}
          </dd>
        </div>
        {event.promptVersion ? (
          <div className="signal-fact">
            <dt>Prompt version</dt>
            <dd>
              <code>{event.promptVersion}</code>
            </dd>
          </div>
        ) : null}
        {event.inputHash ? (
          <div className="signal-fact">
            <dt>Input hash</dt>
            <dd>
              <code>{event.inputHash}</code>
            </dd>
          </div>
        ) : null}
        {event.caseId ? (
          <div className="signal-fact">
            <dt>Case</dt>
            <dd>
              <code>{event.caseId}</code>
            </dd>
          </div>
        ) : null}
      </dl>
      <TimelineSources event={event} />
      <details>
        <summary>Retained raw and parsed details</summary>
        <pre className="signal-json">
          {JSON.stringify(event.details, null, 2)}
        </pre>
      </details>
    </li>
  );
}

export function SignalTimeline({ signalId }: { signalId: string }) {
  const [items, setItems] = useState<readonly SignalTimelineEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const [olderError, setOlderError] = useState<string>();
  const requestRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);

  const replaceTimeline = useCallback(
    (initial: boolean) => {
      requestRef.current?.abort();
      const controller = new AbortController();
      const generation = ++generationRef.current;
      requestRef.current = controller;
      if (initial) setLoading(true);
      else setRefreshing(true);
      setError(undefined);
      setOlderError(undefined);

      void apiJson<SignalTimelinePage>(timelineUrl(signalId, null), {
        signal: controller.signal,
      })
        .then((page) => {
          if (controller.signal.aborted || generation !== generationRef.current)
            return;
          const unique = new Map(
            page.items.map((item) => [item.id, item] as const),
          );
          setItems([...unique.values()]);
          setNextCursor(page.nextCursor);
        })
        .catch((caught: unknown) => {
          if (controller.signal.aborted || generation !== generationRef.current)
            return;
          setError(
            caught instanceof Error
              ? caught.message
              : "Unable to load the signal timeline.",
          );
        })
        .finally(() => {
          if (
            requestRef.current !== controller ||
            generation !== generationRef.current
          )
            return;
          requestRef.current = null;
          setLoading(false);
          setRefreshing(false);
        });
      return controller;
    },
    [signalId],
  );

  useEffect(() => {
    setItems([]);
    setNextCursor(null);
    setLoadingMore(false);
    setRefreshing(false);
    setError(undefined);
    setOlderError(undefined);
    const controller = replaceTimeline(true);
    return () => controller.abort();
  }, [replaceTimeline]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      requestRef.current?.abort();
    },
    [],
  );

  const loadOlder = useCallback(async () => {
    if (nextCursor === null || requestRef.current !== null) return;
    const cursor = nextCursor;
    const controller = new AbortController();
    const generation = ++generationRef.current;
    requestRef.current = controller;
    setLoadingMore(true);
    setOlderError(undefined);
    try {
      const page = await apiJson<SignalTimelinePage>(
        timelineUrl(signalId, cursor),
        {
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted || generation !== generationRef.current)
        return;
      setItems((current) => {
        const unique = new Map(current.map((item) => [item.id, item] as const));
        for (const item of page.items) unique.set(item.id, item);
        return [...unique.values()];
      });
      setNextCursor(page.nextCursor);
    } catch (caught) {
      if (controller.signal.aborted || generation !== generationRef.current)
        return;
      setOlderError(
        caught instanceof Error
          ? caught.message
          : "Unable to load older timeline events.",
      );
    } finally {
      if (
        requestRef.current === controller &&
        generation === generationRef.current
      ) {
        requestRef.current = null;
        setLoadingMore(false);
      }
    }
  }, [nextCursor, signalId]);

  if (loading && items.length === 0) {
    return (
      <section
        id="signal-timeline"
        className="admin-panel"
        role="status"
        aria-live="polite"
      >
        Loading retained event history…
      </section>
    );
  }
  if (error && items.length === 0) {
    return (
      <section id="signal-timeline" aria-label="Retained event timeline">
        <EmptyState
          title="Timeline unavailable"
          description={<p>{error}</p>}
          action={
            <Button onClick={() => replaceTimeline(true)}>
              Retry timeline
            </Button>
          }
        />
      </section>
    );
  }

  return (
    <section
      id="signal-timeline"
      className="admin-panel admin-stack"
      aria-busy={refreshing || loadingMore}
      aria-labelledby="signal-timeline-heading"
    >
      <div className="signal-section-heading">
        <div>
          <h2 id="signal-timeline-heading">Retained event timeline</h2>
          <p className="asi-page-description">
            Latest first. This history includes retained source observations,
            evaluations, research passes, and system outcomes.
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          disabled={refreshing || loadingMore}
          onClick={() => replaceTimeline(false)}
        >
          {refreshing ? "Refreshing…" : "Refresh timeline"}
        </Button>
      </div>
      {error ? (
        <div className="signal-refresh-error" role="alert">
          <p className="admin-feedback" data-tone="error">
            {error} The last successfully loaded events remain visible.
          </p>
          <Button
            type="button"
            variant="secondary"
            disabled={refreshing || loadingMore}
            onClick={() => replaceTimeline(false)}
          >
            Retry refresh
          </Button>
        </div>
      ) : null}
      {items.length === 0 ? (
        <p className="asi-page-description">
          No retained events are available for this signal.
        </p>
      ) : (
        <div
          className="signal-timeline__scroll"
          tabIndex={0}
          aria-label="Loaded retained timeline events"
        >
          <ol className="signal-timeline__list">
            {items.map((event) => (
              <TimelineEvent event={event} key={event.id} />
            ))}
          </ol>
        </div>
      )}
      {olderError ? (
        <div className="signal-refresh-error" role="alert">
          <p className="admin-feedback" data-tone="error">
            {olderError}
          </p>
          <Button
            type="button"
            variant="secondary"
            disabled={loadingMore || refreshing}
            onClick={() => void loadOlder()}
          >
            Retry older events
          </Button>
        </div>
      ) : null}
      {nextCursor ? (
        <Button
          type="button"
          variant="secondary"
          disabled={loadingMore || refreshing}
          onClick={() => void loadOlder()}
        >
          {loadingMore ? "Loading older events…" : "Load older events"}
        </Button>
      ) : items.length > 0 ? (
        <p className="asi-page-description">End of retained event history.</p>
      ) : null}
    </section>
  );
}
