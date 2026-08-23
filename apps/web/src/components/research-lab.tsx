"use client";

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";

import {
  Badge,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@asi/ui";

import { apiJson } from "@/components/csrf-client";
import {
  RESEARCH_RUN_KINDS,
  type ExperimentRunView,
} from "@/components/experiments-types";

const mutedStyle: CSSProperties = {
  color: "var(--asi-text-muted)",
  fontSize: "var(--asi-text-xs)",
};

function formatNumber(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(4)
    : "—";
}

/**
 * Read-only view of the research-side experiment journal. Policies evolve
 * next wave — this tab deliberately offers no mutation affordances.
 */
export function ResearchLab() {
  const [runs, setRuns] = useState<ExperimentRunView[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await apiJson<{ records: ExperimentRunView[] }>(
        "/api/v1/experiments?limit=200",
      );
      setRuns(
        data.records.filter((run) =>
          (RESEARCH_RUN_KINDS as readonly string[]).includes(run.kind),
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div
      style={{
        display: "grid",
        gap: "var(--asi-space-4)",
      }}
    >
      {error !== null ? (
        <p role="alert" style={{ color: "var(--asi-danger, #b00)" }}>
          {error}
        </p>
      ) : null}
      <p style={mutedStyle}>
        Read-only research journal: policy, enrichment-benchmark, blind
        discovery, entity-resolution, evidence-quality, and efficiency runs.
        Policies and their writers evolve in the next wave.
      </p>
      {runs.length === 0 ? (
        <EmptyState title="No research runs journaled yet">
          <p style={mutedStyle}>
            Scorer runs live in the Qualifier Lab; this tab fills up as the
            other experiment kinds start journaling.
          </p>
        </EmptyState>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Created</TableHead>
              <TableHead scope="col">Kind</TableHead>
              <TableHead scope="col">Label</TableHead>
              <TableHead scope="col">Primary metric</TableHead>
              <TableHead scope="col">Value</TableHead>
              <TableHead scope="col">Cost (USD)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => {
              const cost = run.result["costUsd"];
              const costText =
                typeof cost === "number" && Number.isFinite(cost)
                  ? cost.toFixed(4)
                  : "—";
              return (
                <TableRow key={run.id}>
                  <TableCell>{new Date(run.createdAt).toLocaleString()}</TableCell>
                  <TableCell>
                    <Badge>{run.kind}</Badge>
                  </TableCell>
                  <TableCell>{run.label}</TableCell>
                  <TableCell>{run.primaryMetricName ?? "—"}</TableCell>
                  <TableCell>
                    {formatNumber(run.primaryMetricValue)}
                  </TableCell>
                  <TableCell>{costText}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
