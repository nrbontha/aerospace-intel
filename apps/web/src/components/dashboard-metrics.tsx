"use client";

import { Button, Metric, StatusDot } from "@asi/ui";
import { useCallback, useEffect, useState } from "react";

type Metrics = Readonly<{
  companyCount: number;
  dataSourceCount: number;
  unminedDataSourceCount: number;
  restrictedDataSourceCount: number;
  sourceDocumentCount: number;
  evidenceCount: number;
  observationCount: number;
  canonicalFactCount: number;
  pendingProposalCount: number;
  activeResearchRunCount: number;
  failedResearchRunCount: number;
  succeededResearchRunCount: number;
  facilityCount: number;
  platformCount: number;
  partCount: number;
  qualificationCount: number;
  importCount: number;
  capabilityCount: number;
  certificationCount: number;
  subsystemCount?: number;
  customerCount?: number;
  totalSpendUsd: string | number;
  todaySpendUsd: string | number;
  inputTokens: number;
  outputTokens: number;
}>;

type Envelope = Readonly<{ data: Metrics }>;

function errorMessage(payload: unknown, status: number) {
  if (typeof payload === "object" && payload !== null && "error" in payload) {
    const error = payload.error;
    if (
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof error.message === "string"
    )
      return error.message;
  }
  return `Unable to load dashboard aggregates (${status}).`;
}

function integer(value: number) {
  return value.toLocaleString();
}

function dollars(value: string | number) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed)
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
      }).format(parsed)
    : "Unavailable";
}

export function DashboardMetrics() {
  const [metrics, setMetrics] = useState<Metrics>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError(undefined);
      try {
        const response = await fetch("/api/v1/analytics/dashboard", {
          cache: "no-store",
          credentials: "same-origin",
          signal,
        });
        const payload: unknown = await response.json();
        if (!response.ok)
          throw new Error(errorMessage(payload, response.status));
        if (
          typeof payload !== "object" ||
          payload === null ||
          !("data" in payload) ||
          typeof payload.data !== "object" ||
          payload.data === null
        )
          throw new Error(
            "The dashboard service returned an invalid response.",
          );
        setMetrics((payload as Envelope).data);
      } catch (caught) {
        if (signal.aborted) return;
        setMetrics(undefined);
        setError(
          caught instanceof Error
            ? caught.message
            : "Unable to load dashboard aggregates.",
        );
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [reloadKey],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (loading)
    return (
      <p className="asi-page-description" role="status" aria-live="polite">
        Loading database aggregates…
      </p>
    );
  if (error)
    return (
      <div className="admin-feedback" data-tone="error" role="alert">
        <p>{error}</p>
        <Button
          size="small"
          variant="secondary"
          onClick={() => setReloadKey((value) => value + 1)}
        >
          Try again
        </Button>
      </div>
    );
  if (!metrics) return null;

  return (
    <div className="admin-grid">
      <section className="admin-panel" aria-labelledby="coverage-metrics">
        <header className="admin-panel__header">
          <h2 id="coverage-metrics">Coverage</h2>
          <p className="asi-page-description">
            Persisted entities and source material available for intelligence
            work.
          </p>
        </header>
        <div className="admin-form-grid">
          <Metric
            label="Known companies"
            value={integer(metrics.companyCount)}
            detail={`${integer(metrics.canonicalFactCount)} canonical facts`}
          />
          <Metric
            label="Data sources"
            value={integer(metrics.dataSourceCount)}
            detail={`${integer(metrics.sourceDocumentCount)} retrieved documents`}
          />
          <Metric
            label="Unmined sources"
            value={integer(metrics.unminedDataSourceCount)}
            detail="No retrieved source documents"
          />
          <Metric
            label="Restricted sources"
            value={integer(metrics.restrictedDataSourceCount)}
            detail="Metadata only; not fetched"
          />
          <Metric
            label="Evidence items"
            value={integer(metrics.evidenceCount)}
            detail={`${integer(metrics.observationCount)} observations`}
          />
          <Metric
            label="Canonical fields"
            value={integer(metrics.canonicalFactCount)}
            detail="Accepted current observations"
          />
          <Metric
            label="Facilities"
            value={integer(metrics.facilityCount ?? 0)}
            detail={`${integer(metrics.qualificationCount ?? 0)} qualifications`}
          />
          <Metric
            label="Platforms / parts"
            value={`${integer(metrics.platformCount ?? 0)} / ${integer(metrics.partCount ?? 0)}`}
            detail={`${integer(metrics.importCount ?? 0)} import batches`}
          />
          <Metric
            label="Capabilities"
            value={integer(metrics.capabilityCount ?? 0)}
            detail="Process capabilities, not qualifications"
          />
          <Metric
            label="Certifications"
            value={integer(metrics.certificationCount ?? 0)}
            detail="Separate from qualification scope"
          />
          <Metric
            label="Subsystems"
            value={integer(metrics.subsystemCount ?? 0)}
            detail="Qualification scope, when known"
          />
          <Metric
            label="Customers"
            value={integer(metrics.customerCount ?? 0)}
            detail="Companies named as buyers"
          />
        </div>
      </section>

      <section className="admin-panel" aria-labelledby="review-metrics">
        <header className="admin-panel__header">
          <h2 id="review-metrics">Analyst review</h2>
          <p className="asi-page-description">
            The current queue between extracted observations and canonical
            facts.
          </p>
        </header>
        <Metric
          label="Pending proposals"
          value={integer(metrics.pendingProposalCount)}
          detail={
            metrics.pendingProposalCount === 0
              ? "No proposals currently await review"
              : "Evidence-backed proposals awaiting a decision"
          }
        />
      </section>

      <section className="admin-panel" aria-labelledby="research-metrics">
        <header className="admin-panel__header">
          <h2 id="research-metrics">Research runs</h2>
          <p className="asi-page-description">
            Run outcomes recorded by the research worker.
          </p>
        </header>
        <div className="admin-form-grid">
          <Metric
            label="Active"
            value={integer(metrics.activeResearchRunCount)}
            detail={
              <StatusDot
                label="Queued or running"
                tone={metrics.activeResearchRunCount > 0 ? "info" : "neutral"}
              />
            }
          />
          <Metric
            label="Succeeded"
            value={integer(metrics.succeededResearchRunCount)}
            detail="Completed successfully"
          />
          <Metric
            label="Failed"
            value={integer(metrics.failedResearchRunCount)}
            detail={
              <StatusDot
                label="Requires investigation"
                tone={metrics.failedResearchRunCount > 0 ? "danger" : "neutral"}
              />
            }
          />
        </div>
      </section>

      <section className="admin-panel" aria-labelledby="model-metrics">
        <header className="admin-panel__header">
          <h2 id="model-metrics">Model usage</h2>
          <p className="asi-page-description">
            Recorded OpenRouter usage only; credentials and prompt content are
            never displayed.
          </p>
        </header>
        <div className="admin-form-grid">
          <Metric
            label="Total spend"
            value={dollars(metrics.totalSpendUsd)}
            detail="All recorded model calls"
          />
          <Metric
            label="Spend today"
            value={dollars(metrics.todaySpendUsd)}
            detail="UTC day"
          />
          <Metric
            label="Input tokens"
            value={integer(metrics.inputTokens)}
            detail="Recorded provider usage"
          />
          <Metric
            label="Output tokens"
            value={integer(metrics.outputTokens)}
            detail="Recorded provider usage"
          />
        </div>
      </section>
    </div>
  );
}
