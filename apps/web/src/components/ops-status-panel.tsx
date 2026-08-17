"use client";

import { Button, Metric } from "@asi/ui";
import { useCallback, useEffect, useState } from "react";

type OpsSnapshot = Readonly<{
  drainable: boolean;
  queue: Readonly<{
    created: number;
    retry: number;
    active: number;
    completed: number;
    cancelled: number;
    failed: number;
  }>;
  storage: Readonly<{
    documentCount: number;
    fileCount: number;
    findings: readonly { kind: string; storageKey: string }[];
  }>;
  alerts?: readonly {
    severity: "warning" | "danger";
    code: string;
    message: string;
  }[];
}>;

export function OpsStatusPanel() {
  const [snapshot, setSnapshot] = useState<OpsSnapshot>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (signal: AbortSignal) => {
    try {
      const response = await fetch("/api/v1/ops/status", {
        cache: "no-store",
        credentials: "same-origin",
        signal,
      });
      const payload = (await response.json()) as {
        data?: OpsSnapshot;
        error?: { message?: string };
      };
      if (!response.ok || !payload.data) {
        throw new Error(payload.error?.message ?? `Unable to load operations status (${response.status})`);
      }
      if (!signal.aborted) setSnapshot(payload.data);
    } catch (caught) {
      if (!signal.aborted) {
        setError(caught instanceof Error ? caught.message : "Unable to load operations status");
      }
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (loading) {
    return <p className="asi-page-description" role="status">Loading operations snapshot…</p>;
  }
  if (error || !snapshot) {
    return (
      <p className="admin-feedback" data-tone="error" role="alert">
        {error ?? "Operations snapshot unavailable"}
      </p>
    );
  }

  return (
    <section className="admin-panel" aria-labelledby="ops-status-heading">
      <header className="admin-panel__header">
        <h2 id="ops-status-heading">Production operations</h2>
        <p className="asi-page-description">
          Queue drain and storage/database reconciliation. Secrets, sessions, and
          document bytes are not included.
        </p>
      </header>
      <div className="admin-form-grid">
        <Metric
          label="Drainable"
          value={snapshot.drainable ? "Yes" : "No"}
          detail={`${snapshot.queue.active} active / ${snapshot.queue.created + snapshot.queue.retry} queued`}
        />
        <Metric
          label="Failed jobs"
          value={String(snapshot.queue.failed)}
          detail={`${snapshot.queue.completed} completed`}
        />
        <Metric
          label="Stored documents"
          value={String(snapshot.storage.documentCount)}
          detail={`${snapshot.storage.fileCount} files on disk`}
        />
        <Metric
          label="Reconcile findings"
          value={String(snapshot.storage.findings.length)}
          detail="Missing, orphan, digest, or size mismatches"
        />
      </div>
      {(snapshot.alerts ?? []).length > 0 ? (
        <ul aria-label="Operations alerts">
          {(snapshot.alerts ?? []).map((alert) => (
            <li key={alert.code}>
              <strong>{alert.severity}</strong>
              {": "}
              {alert.message}
            </li>
          ))}
        </ul>
      ) : (
        <p className="asi-page-description">No operations alerts.</p>
      )}
      {snapshot.storage.findings.length > 0 ? (
        <ul>
          {snapshot.storage.findings.slice(0, 20).map((finding) => (
            <li key={`${finding.kind}:${finding.storageKey}`}>
              {finding.kind}: {finding.storageKey}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="admin-actions">
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setLoading(true);
            setError(undefined);
            const controller = new AbortController();
            void load(controller.signal);
          }}
        >
          Refresh
        </Button>
      </div>
    </section>
  );
}
