"use client";

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";

import { Badge, Button, EmptyState, Metric, StatusDot } from "@asi/ui";

import { apiJson } from "@/components/csrf-client";
import {
  formatResearchRunStatus,
  formatRunCost,
  formatRunTimestamp,
  isTerminalResearchRun,
  mergeResearchRun,
  normalizeResearchRun,
} from "@/components/research-runs-table";
import type {
  ResearchRunRecordView,
  ResearchRunStatus,
} from "@/components/research-runs-table";

type ConnectionState = "connecting" | "live" | "disconnected" | "complete";

const sectionGridStyle: CSSProperties = {
  display: "grid",
  gap: "var(--asi-space-12)",
  gridTemplateColumns:
    "repeat(auto-fit, minmax(min(var(--asi-empty-max), 100%), 1fr))",
};
const panelStyle: CSSProperties = {
  background: "var(--asi-surface)",
  border: "var(--asi-border-width) solid var(--asi-border)",
  borderRadius: "var(--asi-radius-md)",
  minInlineSize: 0,
  padding: "var(--asi-space-12)",
};
const panelHeaderStyle: CSSProperties = {
  alignItems: "baseline",
  borderBlockEnd: "var(--asi-border-width) solid var(--asi-border)",
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--asi-space-6)",
  justifyContent: "space-between",
  marginBlockEnd: "var(--asi-space-8)",
  paddingBlockEnd: "var(--asi-space-6)",
};
const headingStyle: CSSProperties = {
  fontSize: "var(--asi-text-lg)",
  lineHeight: "var(--asi-leading-tight)",
  margin: 0,
};
const metricGridStyle: CSSProperties = {
  display: "grid",
  gap: "var(--asi-space-12)",
  gridTemplateColumns: "repeat(auto-fit, minmax(var(--asi-control-md), 1fr))",
};
const stackStyle: CSSProperties = {
  display: "grid",
  gap: "var(--asi-space-6)",
};
const tightStackStyle: CSSProperties = {
  display: "grid",
  gap: "var(--asi-space-3)",
};
const mutedStyle: CSSProperties = {
  color: "var(--asi-text-muted)",
  fontSize: "var(--asi-text-sm)",
  margin: 0,
};
const monoStyle: CSSProperties = {
  fontFamily: "var(--asi-font-mono)",
  fontSize: "var(--asi-text-xs)",
};
const progressStyle: CSSProperties = {
  accentColor: "var(--asi-accent)",
  inlineSize: "100%",
};
const issueStyle: CSSProperties = {
  background: "var(--asi-danger-soft)",
  border: "var(--asi-border-width) solid var(--asi-danger)",
  borderRadius: "var(--asi-radius-sm)",
  display: "grid",
  gap: "var(--asi-space-3)",
  margin: 0,
  padding: "var(--asi-space-6)",
};
const warningListStyle: CSSProperties = {
  margin: 0,
  paddingInlineStart: "var(--asi-space-12)",
};
const integerFormatter = new Intl.NumberFormat();

function statusTone(
  status: ResearchRunStatus,
): "neutral" | "info" | "success" | "warning" | "danger" {
  switch (status) {
    case "queued":
      return "warning";
    case "running":
      return "info";
    case "succeeded":
      return "success";
    case "failed":
      return "danger";
    default:
      return "neutral";
  }
}

function connectionPresentation(state: ConnectionState): {
  label: string;
  tone: "neutral" | "info" | "success" | "warning";
} {
  switch (state) {
    case "connecting":
      return { label: "Connecting to live updates", tone: "info" };
    case "live":
      return { label: "Live updates connected", tone: "success" };
    case "disconnected":
      return { label: "Live updates disconnected", tone: "warning" };
    case "complete":
      return { label: "Terminal record", tone: "neutral" };
  }
}

function targetDescription(run: ResearchRunRecordView): string {
  if (run.targetLabel !== undefined) return run.targetLabel;
  if (run.targetType !== undefined && run.targetId !== undefined) {
    return `${run.targetType} · ${run.targetId}`;
  }
  return run.targetType ?? run.targetId ?? "Target unavailable";
}

function countDetail(value?: number): string {
  return value === undefined ? "Not reported" : integerFormatter.format(value);
}

function DetailPanel({
  title,
  children,
  trailing,
}: Readonly<{
  title: string;
  children: React.ReactNode;
  trailing?: React.ReactNode;
}>) {
  return (
    <section style={panelStyle}>
      <header style={panelHeaderStyle}>
        <h2 style={headingStyle}>{title}</h2>
        {trailing}
      </header>
      {children}
    </section>
  );
}

export function ResearchRunLive({ runId }: Readonly<{ runId: string }>) {
  const [run, setRun] = useState<ResearchRunRecordView>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [connectionError, setConnectionError] = useState<string>();
  const [reloadKey, setReloadKey] = useState(0);
  const [cancelPending, setCancelPending] = useState(false);
  const [cancelError, setCancelError] = useState<string>();

  const retry = useCallback(() => setReloadKey((value) => value + 1), []);

  const cancelRun = useCallback(async () => {
    setCancelPending(true);
    setCancelError(undefined);
    try {
      const cancelled = await apiJson<unknown>(
        `/api/v1/research-runs/${encodeURIComponent(runId)}/cancel`,
        { method: "POST" },
      );
      const next = normalizeResearchRun(cancelled);
      if (next !== undefined) setRun(next);
      setConnection("complete");
    } catch (error) {
      setCancelError(
        error instanceof Error
          ? error.message
          : "Unable to cancel this research run.",
      );
    } finally {
      setCancelPending(false);
    }
  }, [runId]);

  useEffect(() => {
    let disposed = false;
    let events: EventSource | undefined;

    async function load(): Promise<void> {
      setLoading(true);
      setLoadError(undefined);
      setConnectionError(undefined);
      setConnection("connecting");

      try {
        const payload = await apiJson<unknown>(
          `/api/v1/research-runs/${encodeURIComponent(runId)}`,
        );
        if (disposed) return;
        const initial = normalizeResearchRun(payload);
        if (initial === undefined) {
          throw new Error("The server returned an invalid research run.");
        }
        setRun(initial);
        setLoading(false);

        if (isTerminalResearchRun(initial.status)) {
          setConnection("complete");
          return;
        }

        events = new EventSource(
          `/api/v1/research-runs/${encodeURIComponent(runId)}/events`,
          { withCredentials: true },
        );
        events.onopen = () => {
          if (disposed) return;
          setConnection("live");
          setConnectionError(undefined);
        };
        events.onerror = () => {
          if (disposed) return;
          setConnection("disconnected");
          setConnectionError(
            "The live connection was interrupted. Recorded state remains visible while the browser retries.",
          );
        };
        events.addEventListener("snapshot", (event) => {
          if (disposed || !(event instanceof MessageEvent)) return;
          try {
            const update: unknown = JSON.parse(event.data as string);
            setRun((current) => {
              if (current === undefined) return current;
              const next = mergeResearchRun(current, update);
              if (isTerminalResearchRun(next.status)) {
                events?.close();
                setConnection("complete");
                setConnectionError(undefined);
              }
              return next;
            });
          } catch {
            events?.close();
            setConnection("disconnected");
            setConnectionError(
              "The live stream sent an unreadable update. Reload to resume from recorded state.",
            );
          }
        });
      } catch (error) {
        if (disposed) return;
        setLoadError(
          error instanceof Error
            ? error.message
            : "Unable to load this research run.",
        );
        setLoading(false);
        setConnection("disconnected");
      }
    }

    void load();
    return () => {
      disposed = true;
      events?.close();
    };
  }, [reloadKey, runId]);

  if (loading) {
    return (
      <section aria-busy="true" aria-label="Research run detail">
        <StatusDot label="Loading recorded run state" tone="info" />
      </section>
    );
  }

  if (run === undefined) {
    return (
      <EmptyState
        title="Research run could not be loaded"
        description={<p role="alert">{loadError}</p>}
        action={
          <Button onClick={retry} variant="secondary">
            Try again
          </Button>
        }
      />
    );
  }

  const live = connectionPresentation(connection);
  const phase = run.phase ?? formatResearchRunStatus(run.status);

  return (
    <div style={stackStyle}>
      <section aria-label="Run state" style={panelStyle}>
        <div style={panelHeaderStyle}>
          <div style={tightStackStyle}>
            <span style={mutedStyle}>Target</span>
            <strong>{targetDescription(run)}</strong>
            {run.targetId === undefined ? null : (
              <span style={monoStyle}>{run.targetId}</span>
            )}
          </div>
          <div style={tightStackStyle}>
            <StatusDot
              label={formatResearchRunStatus(run.status)}
              tone={statusTone(run.status)}
            />
            <StatusDot label={live.label} tone={live.tone} />
          </div>
        </div>

        <div style={stackStyle}>
          <div style={tightStackStyle}>
            <div style={panelHeaderStyle}>
              <strong>{phase}</strong>
              <span style={monoStyle}>
                {run.progressPercent === undefined
                  ? "Progress not reported"
                  : `${Math.round(run.progressPercent)}%`}
              </span>
            </div>
            {run.progressPercent === undefined ? null : (
              <progress
                aria-label={`${phase} progress`}
                max={100}
                style={progressStyle}
                value={run.progressPercent}
              />
            )}
            {run.progressMessage === undefined ? null : (
              <p style={mutedStyle}>{run.progressMessage}</p>
            )}
          </div>
          {run.objective === undefined ? null : (
            <p style={mutedStyle}>{run.objective}</p>
          )}
          <p aria-live="polite" style={mutedStyle}>
            {connectionError ??
              (connection === "complete"
                ? "This run is terminal; its recorded result will not change through this connection."
                : "Updates reflect persisted run snapshots, not simulated activity.")}
          </p>
        </div>
      </section>

      <div style={sectionGridStyle}>
        <DetailPanel title="Model and cost">
          <div style={metricGridStyle}>
            <Metric
              label="Requested model"
              value={run.requestedModel ?? "Not reported"}
            />
            <Metric
              label="Actual cost"
              value={formatRunCost(run.actualCostUsd)}
            />
            <Metric label="Input tokens" value={countDetail(run.inputTokens)} />
            <Metric
              label="Output tokens"
              value={countDetail(run.outputTokens)}
            />
          </div>
        </DetailPanel>

        <DetailPanel title="Recorded output">
          <div style={metricGridStyle}>
            <Metric label="Proposals" value={countDetail(run.proposalCount)} />
            <Metric
              label="Pending review"
              value={countDetail(run.pendingProposalCount)}
            />
            <Metric
              label="Accepted"
              value={countDetail(run.acceptedProposalCount)}
            />
            <Metric
              label="Rejected"
              value={countDetail(run.rejectedProposalCount)}
            />
            <Metric
              label="Source documents"
              value={countDetail(run.documentCount)}
            />
          </div>
        </DetailPanel>
      </div>

      <div style={sectionGridStyle}>
        <DetailPanel title="Timestamps">
          <dl style={stackStyle}>
            <div style={tightStackStyle}>
              <dt style={mutedStyle}>Queued</dt>
              <dd style={{ margin: 0 }}>
                <time dateTime={run.createdAt}>
                  {formatRunTimestamp(run.createdAt)}
                </time>
              </dd>
            </div>
            <div style={tightStackStyle}>
              <dt style={mutedStyle}>Started</dt>
              <dd style={{ margin: 0 }}>
                <time dateTime={run.startedAt}>
                  {formatRunTimestamp(run.startedAt)}
                </time>
              </dd>
            </div>
            <div style={tightStackStyle}>
              <dt style={mutedStyle}>Completed</dt>
              <dd style={{ margin: 0 }}>
                <time dateTime={run.completedAt}>
                  {formatRunTimestamp(run.completedAt)}
                </time>
              </dd>
            </div>
            <div style={tightStackStyle}>
              <dt style={mutedStyle}>Last recorded update</dt>
              <dd style={{ margin: 0 }}>
                <time dateTime={run.updatedAt}>
                  {formatRunTimestamp(run.updatedAt)}
                </time>
              </dd>
            </div>
          </dl>
        </DetailPanel>

        <DetailPanel
          title="Warnings and errors"
          trailing={
            run.warnings === undefined ? null : (
              <Badge tone="warning">
                {run.warnings.length} warning
                {run.warnings.length === 1 ? "" : "s"}
              </Badge>
            )
          }
        >
          <div style={stackStyle}>
            {run.errorMessage === undefined ? (
              <p style={mutedStyle}>No error reported.</p>
            ) : (
              <div role="alert" style={issueStyle}>
                <strong>{run.errorCode ?? "Research run failed"}</strong>
                <span>{run.errorMessage}</span>
              </div>
            )}
            {run.warnings === undefined ? (
              <p style={mutedStyle}>No warnings reported.</p>
            ) : (
              <ul style={warningListStyle}>
                {run.warnings.map((warning, index) => (
                  <li key={`${index}-${warning}`}>{warning}</li>
                ))}
              </ul>
            )}
          </div>
        </DetailPanel>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem" }}>
        <Button onClick={retry} size="small" variant="secondary">
          Reload recorded state
        </Button>
        {run.status === "queued" || run.status === "running" ? (
          <Button
            onClick={() => void cancelRun()}
            size="small"
            variant="secondary"
            disabled={cancelPending}
          >
            {cancelPending ? "Cancelling…" : "Cancel run"}
          </Button>
        ) : null}
      </div>
      {cancelError ? (
        <p role="alert" style={issueStyle}>
          {cancelError}
        </p>
      ) : null}
    </div>
  );
}
