"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";

import {
  Badge,
  Button,
  EmptyState,
  Select,
  StatusDot,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@asi/ui";

import { apiJson } from "@/components/csrf-client";

export type ResearchRunStatus =
  "queued" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";

export type ResearchRunRecordView = Readonly<{
  id: string;
  status: ResearchRunStatus;
  targetType?: string;
  targetId?: string;
  targetLabel?: string;
  objective?: string;
  phase?: string;
  progressMessage?: string;
  progressPercent?: number;
  requestedModel?: string;
  actualCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  proposalCount?: number;
  pendingProposalCount?: number;
  acceptedProposalCount?: number;
  rejectedProposalCount?: number;
  documentCount?: number;
  warnings?: readonly string[];
  errorCode?: string;
  errorMessage?: string;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string;
  completedAt?: string;
}>;
type MutableResearchRunRecordView = {
  -readonly [Key in keyof ResearchRunRecordView]: ResearchRunRecordView[Key];
};

const statusOptions: readonly ResearchRunStatus[] = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
];
const terminalStatuses = new Set<ResearchRunStatus>([
  "succeeded",
  "failed",
  "cancelled",
]);
const ACTIVE_REFRESH_INTERVAL_MS = 10_000;

const toolbarStyle: CSSProperties = {
  alignItems: "end",
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--asi-space-8)",
  justifyContent: "space-between",
  marginBlockEnd: "var(--asi-space-8)",
};
const filterStyle: CSSProperties = {
  display: "grid",
  gap: "var(--asi-space-3)",
};
const compactStackStyle: CSSProperties = {
  display: "grid",
  gap: "var(--asi-space-2)",
};
const mutedStyle: CSSProperties = {
  color: "var(--asi-text-muted)",
  fontSize: "var(--asi-text-xs)",
};
const monoStyle: CSSProperties = {
  color: "var(--asi-text-muted)",
  fontFamily: "var(--asi-font-mono)",
  fontSize: "var(--asi-text-xs)",
};
const progressStyle: CSSProperties = {
  accentColor: "var(--asi-accent)",
  inlineSize: "100%",
};
const issueStyle: CSSProperties = {
  alignItems: "start",
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--asi-space-3)",
};

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

function finiteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function nonnegativeInteger(...values: unknown[]): number | undefined {
  const value = finiteNumber(...values);
  return value === undefined || value < 0 ? undefined : Math.floor(value);
}

function stringList(...values: unknown[]): readonly string[] | undefined {
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    const strings = value.filter(
      (item): item is string => typeof item === "string" && item.trim() !== "",
    );
    if (strings.length > 0) return strings;
  }
  return undefined;
}

export function isTerminalResearchRun(status: ResearchRunStatus): boolean {
  return terminalStatuses.has(status);
}

export function formatResearchRunStatus(status: ResearchRunStatus): string {
  return status === "unknown"
    ? "Status unavailable"
    : `${status.charAt(0).toUpperCase()}${status.slice(1)}`;
}

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

export function normalizeResearchRun(
  value: unknown,
): ResearchRunRecordView | undefined {
  const raw = objectValue(value);
  if (raw === undefined) return undefined;

  const id = nonEmptyString(raw.id);
  if (id === undefined) return undefined;

  const rawStatus = nonEmptyString(raw.status);
  const status = statusOptions.includes(rawStatus as ResearchRunStatus)
    ? (rawStatus as ResearchRunStatus)
    : "unknown";
  const input = objectValue(raw.input);
  const metadata = objectValue(raw.metadata) ?? objectValue(input?.metadata);
  const progress = objectValue(raw.progress);
  const target = objectValue(raw.target);
  const targets = Array.isArray(raw.targets) ? raw.targets : undefined;
  const firstTarget = objectValue(targets?.[0]);
  const error = objectValue(raw.error);
  const completedUnits = finiteNumber(progress?.completedUnits);
  const totalUnits = finiteNumber(progress?.totalUnits);
  let progressPercent = finiteNumber(
    raw.progressPercent,
    progress?.progressPercent,
  );
  const scalarProgress = finiteNumber(raw.progress);
  if (
    progressPercent === undefined &&
    completedUnits !== undefined &&
    totalUnits
  ) {
    progressPercent = (completedUnits / totalUnits) * 100;
  }
  if (progressPercent === undefined && scalarProgress !== undefined) {
    progressPercent =
      scalarProgress <= 1 ? scalarProgress * 100 : scalarProgress;
  }
  if (progressPercent !== undefined) {
    progressPercent = Math.min(100, Math.max(0, progressPercent));
  }

  const normalized: MutableResearchRunRecordView = { id, status };
  const targetType = nonEmptyString(
    raw.targetType,
    target?.type,
    firstTarget?.type,
  );
  if (targetType !== undefined) normalized.targetType = targetType;
  const targetId = nonEmptyString(raw.targetId, target?.id, firstTarget?.id);
  if (targetId !== undefined) normalized.targetId = targetId;
  const targetLabel = nonEmptyString(
    raw.targetLabel,
    target?.label,
    target?.name,
    firstTarget?.label,
    firstTarget?.name,
    input?.targetLabel,
    input?.dataSourceName,
    input?.sourceName,
  );
  if (targetLabel !== undefined) normalized.targetLabel = targetLabel;
  const objective = nonEmptyString(raw.objective, firstTarget?.objective);
  if (objective !== undefined) normalized.objective = objective;
  const phase = nonEmptyString(raw.phase, raw.currentPhase, progress?.phase);
  if (phase !== undefined) normalized.phase = phase;
  const progressMessage = nonEmptyString(
    raw.progressMessage,
    progress?.message,
  );
  if (progressMessage !== undefined)
    normalized.progressMessage = progressMessage;
  if (progressPercent !== undefined)
    normalized.progressPercent = progressPercent;
  const requestedModel = nonEmptyString(
    raw.requestedModel,
    raw.model,
    input?.requestedModel,
  );
  if (requestedModel !== undefined) normalized.requestedModel = requestedModel;
  const actualCostUsd = finiteNumber(raw.actualCostUsd, raw.costUsd);
  if (actualCostUsd !== undefined) normalized.actualCostUsd = actualCostUsd;
  const inputTokens = nonnegativeInteger(raw.inputTokens);
  if (inputTokens !== undefined) normalized.inputTokens = inputTokens;
  const outputTokens = nonnegativeInteger(raw.outputTokens);
  if (outputTokens !== undefined) normalized.outputTokens = outputTokens;
  const proposalCount = nonnegativeInteger(raw.proposalCount);
  if (proposalCount !== undefined) normalized.proposalCount = proposalCount;
  const pendingProposalCount = nonnegativeInteger(raw.pendingProposalCount);
  if (pendingProposalCount !== undefined) {
    normalized.pendingProposalCount = pendingProposalCount;
  }
  const acceptedProposalCount = nonnegativeInteger(raw.acceptedProposalCount);
  if (acceptedProposalCount !== undefined) {
    normalized.acceptedProposalCount = acceptedProposalCount;
  }
  const rejectedProposalCount = nonnegativeInteger(raw.rejectedProposalCount);
  if (rejectedProposalCount !== undefined) {
    normalized.rejectedProposalCount = rejectedProposalCount;
  }
  const documentCount = nonnegativeInteger(raw.documentCount);
  if (documentCount !== undefined) normalized.documentCount = documentCount;
  const warnings = stringList(
    raw.warnings,
    metadata?.warnings,
    input?.warnings,
  );
  if (warnings !== undefined) normalized.warnings = warnings;
  const errorCode = nonEmptyString(raw.errorCode, error?.code);
  if (errorCode !== undefined) normalized.errorCode = errorCode;
  const errorMessage = nonEmptyString(raw.errorMessage, error?.message);
  if (errorMessage !== undefined) normalized.errorMessage = errorMessage;
  const createdAt = nonEmptyString(raw.createdAt);
  if (createdAt !== undefined) normalized.createdAt = createdAt;
  const updatedAt = nonEmptyString(raw.updatedAt);
  if (updatedAt !== undefined) normalized.updatedAt = updatedAt;
  const startedAt = nonEmptyString(raw.startedAt);
  if (startedAt !== undefined) normalized.startedAt = startedAt;
  const completedAt = nonEmptyString(raw.completedAt, raw.finishedAt);
  if (completedAt !== undefined) normalized.completedAt = completedAt;

  return normalized;
}

export function mergeResearchRun(
  current: ResearchRunRecordView,
  update: unknown,
): ResearchRunRecordView {
  const raw = objectValue(update);
  const candidate = objectValue(raw?.data) ?? raw;
  if (candidate === undefined) return current;
  const normalized = normalizeResearchRun({ ...current, ...candidate });
  return normalized ?? current;
}

export function formatRunTimestamp(value?: string): string {
  if (value === undefined) return "—";
  const instant = new Date(value);
  if (Number.isNaN(instant.valueOf())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(instant);
}

export function formatRunCost(value?: number): string {
  if (value === undefined) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(value);
}

function targetText(run: ResearchRunRecordView): string {
  if (run.targetLabel !== undefined) return run.targetLabel;
  if (run.targetType !== undefined && run.targetId !== undefined) {
    return `${run.targetType} · ${run.targetId}`;
  }
  return run.targetType ?? run.targetId ?? "Target unavailable";
}

function phaseText(run: ResearchRunRecordView): string {
  return run.phase ?? formatResearchRunStatus(run.status);
}

function proposalDetail(run: ResearchRunRecordView): string | undefined {
  const details = [
    run.pendingProposalCount === undefined
      ? undefined
      : `${run.pendingProposalCount} pending`,
    run.acceptedProposalCount === undefined
      ? undefined
      : `${run.acceptedProposalCount} accepted`,
    run.rejectedProposalCount === undefined
      ? undefined
      : `${run.rejectedProposalCount} rejected`,
  ].filter((value): value is string => value !== undefined);
  return details.length === 0 ? undefined : details.join(" · ");
}

function ResearchRunRow({ run }: Readonly<{ run: ResearchRunRecordView }>) {
  const detail = proposalDetail(run);
  const warningCount = run.warnings?.length;

  return (
    <TableRow>
      <TableCell>
        <div style={compactStackStyle}>
          <Link href={`/research-runs/${encodeURIComponent(run.id)}`}>
            {targetText(run)}
          </Link>
          <span style={monoStyle}>{run.id}</span>
        </div>
      </TableCell>
      <TableCell>
        <StatusDot
          label={formatResearchRunStatus(run.status)}
          tone={statusTone(run.status)}
        />
      </TableCell>
      <TableCell>
        <div style={compactStackStyle}>
          <span>{phaseText(run)}</span>
          {run.progressPercent === undefined ? (
            <span style={mutedStyle}>Progress not reported</span>
          ) : (
            <>
              <progress
                aria-label={`${phaseText(run)} progress`}
                max={100}
                style={progressStyle}
                value={run.progressPercent}
              />
              <span style={monoStyle}>{Math.round(run.progressPercent)}%</span>
            </>
          )}
        </div>
      </TableCell>
      <TableCell>
        <div style={compactStackStyle}>
          <span>{run.requestedModel ?? "Model not reported"}</span>
          <span style={monoStyle}>{formatRunCost(run.actualCostUsd)}</span>
        </div>
      </TableCell>
      <TableCell numeric>
        <div style={compactStackStyle}>
          <span>{run.proposalCount ?? "—"}</span>
          {detail === undefined ? null : (
            <span style={mutedStyle}>{detail}</span>
          )}
        </div>
      </TableCell>
      <TableCell>
        <div style={compactStackStyle}>
          <time dateTime={run.createdAt}>
            {formatRunTimestamp(run.createdAt)}
          </time>
          <span style={mutedStyle}>
            Updated {formatRunTimestamp(run.updatedAt)}
          </span>
        </div>
      </TableCell>
      <TableCell>
        {run.errorMessage !== undefined || warningCount !== undefined ? (
          <div style={issueStyle}>
            {run.errorMessage !== undefined ? (
              <Badge tone="danger">Error</Badge>
            ) : null}
            {warningCount !== undefined ? (
              <Badge tone="warning">
                {warningCount} warning{warningCount === 1 ? "" : "s"}
              </Badge>
            ) : null}
          </div>
        ) : (
          <span style={mutedStyle}>None reported</span>
        )}
      </TableCell>
    </TableRow>
  );
}

function normalizeRunList(value: unknown): ResearchRunRecordView[] {
  const raw = objectValue(value);
  const items = Array.isArray(value)
    ? value
    : Array.isArray(raw?.items)
      ? raw.items
      : Array.isArray(raw?.runs)
        ? raw.runs
        : [];
  return items
    .map((item) => normalizeResearchRun(item))
    .filter((item): item is ResearchRunRecordView => item !== undefined);
}

export function ResearchRunsTable() {
  const [runs, setRuns] = useState<ResearchRunRecordView[]>([]);
  const [statusFilter, setStatusFilter] = useState<ResearchRunStatus | "all">(
    "all",
  );
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();

  const loadRuns = useCallback(async (initial: boolean) => {
    if (initial) setLoading(true);
    else setRefreshing(true);
    setError(undefined);
    try {
      const data = await apiJson<unknown>(
        "/api/v1/research-runs?page=1&pageSize=100",
      );
      setRuns(normalizeRunList(data));
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Unable to load research runs.",
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadRuns(true);
  }, [loadRuns]);

  useEffect(() => {
    if (!runs.some((run) => !isTerminalResearchRun(run.status))) return;
    const interval = window.setInterval(() => {
      void loadRuns(false);
    }, ACTIVE_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [loadRuns, runs]);

  const visibleRuns = useMemo(
    () =>
      statusFilter === "all"
        ? runs
        : runs.filter((run) => run.status === statusFilter),
    [runs, statusFilter],
  );

  if (loading) {
    return (
      <section aria-busy="true" aria-label="Research runs">
        <StatusDot label="Loading research runs" tone="info" />
      </section>
    );
  }

  if (error !== undefined && runs.length === 0) {
    return (
      <EmptyState
        title="Research runs could not be loaded"
        description={<p role="alert">{error}</p>}
        action={
          <Button onClick={() => void loadRuns(true)} variant="secondary">
            Try again
          </Button>
        }
      />
    );
  }

  if (runs.length === 0) {
    return (
      <EmptyState
        title="No research runs yet"
        description={
          <p>
            Create a traceable data source and queue research from its source
            record. Runs will appear here without invented activity.
          </p>
        }
        action={<Link href="/data-sources">Go to Data Sources</Link>}
      />
    );
  }

  return (
    <section aria-labelledby="research-runs-heading">
      <h2 className="asi-sr-only" id="research-runs-heading">
        Research run records
      </h2>
      <div style={toolbarStyle}>
        <label style={filterStyle}>
          <span style={mutedStyle}>Status</span>
          <Select
            value={statusFilter}
            onChange={(event) =>
              setStatusFilter(event.target.value as ResearchRunStatus | "all")
            }
          >
            <option value="all">All statuses</option>
            {statusOptions.map((status) => (
              <option key={status} value={status}>
                {formatResearchRunStatus(status)}
              </option>
            ))}
          </Select>
        </label>
        <Button
          disabled={refreshing}
          isLoading={refreshing}
          onClick={() => void loadRuns(false)}
          size="small"
          variant="secondary"
        >
          Refresh
        </Button>
      </div>

      {error !== undefined ? (
        <p className="admin-feedback" data-tone="error" role="alert">
          {error} Existing rows may be out of date.
        </p>
      ) : null}

      {visibleRuns.length === 0 ? (
        <EmptyState
          title={`No ${formatResearchRunStatus(statusFilter as ResearchRunStatus).toLowerCase()} runs`}
          description={<p>Choose another status to inspect recorded runs.</p>}
        />
      ) : (
        <Table>
          <TableCaption>
            {visibleRuns.length} of {runs.length} loaded run
            {runs.length === 1 ? "" : "s"}. Active runs refresh from recorded
            state.
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Target / run</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Phase / progress</TableHead>
              <TableHead>Model / cost</TableHead>
              <TableHead numeric>Proposals</TableHead>
              <TableHead>Timestamps</TableHead>
              <TableHead>Warnings / errors</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleRuns.map((run) => (
              <ResearchRunRow key={run.id} run={run} />
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
