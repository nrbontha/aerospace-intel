"use client";

import { Button, StatusDot } from "@asi/ui";
import Link from "next/link";
import { useState } from "react";

import { apiJson } from "@/components/csrf-client";

type QueuedRun = Readonly<{ id: string; status: string }>;

type CompanyResearchActionProps = Readonly<{
  companyId: string;
  companyName: string;
  canQueue: boolean;
  latestStatus?: string | null;
  onQueued?: (run: QueuedRun) => void;
}>;

function statusTone(status: string): "info" | "success" | "warning" | "danger" {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "cancelled") return "danger";
  if (status === "queued" || status === "running") return "info";
  return "warning";
}

export function CompanyResearchAction({
  companyId,
  companyName,
  canQueue,
  latestStatus,
  onQueued,
}: CompanyResearchActionProps) {
  const [queueing, setQueueing] = useState(false);
  const [error, setError] = useState<string>();
  const [queuedRun, setQueuedRun] = useState<QueuedRun>();
  const currentStatus = queuedRun?.status ?? latestStatus ?? "not_queued";
  const inProgress = currentStatus === "queued" || currentStatus === "running";

  async function queueResearch(): Promise<void> {
    setQueueing(true);
    setError(undefined);
    try {
      const run = await apiJson<QueuedRun>("/api/v1/research-runs", {
        method: "POST",
        body: JSON.stringify({
          targets: [
            {
              type: "company",
              id: companyId,
              objective: `Extract additional evidence-backed facts about ${companyName} from its public website and already-reviewed local evidence. Leave unsupported fields unassessed.`,
            },
          ],
          metadata: { initiatedFrom: "company_profile" },
        }),
      });
      setQueuedRun(run);
      onQueued?.(run);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to queue company research.",
      );
    } finally {
      setQueueing(false);
    }
  }

  async function queueRefresh(): Promise<void> {
    setQueueing(true);
    setError(undefined);
    try {
      const run = await apiJson<QueuedRun>("/api/v1/research-runs", {
        method: "POST",
        body: JSON.stringify({
          kind: "refresh",
          target: { type: "company", id: companyId },
          metadata: { initiatedFrom: "company_profile_refresh" },
        }),
      });
      setQueuedRun(run);
      onQueued?.(run);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to queue company refresh.",
      );
    } finally {
      setQueueing(false);
    }
  }

  return (
    <section className="admin-panel" aria-labelledby="company-research-heading">
      <div className="admin-panel__header">
        <h2 id="company-research-heading">Company research</h2>
        <StatusDot
          label={currentStatus.replaceAll("_", " ")}
          tone={statusTone(currentStatus)}
        />
      </div>
      {canQueue ? (
        <p className="asi-page-description">
          Search local reviewed evidence first, then optionally fetch the
          company website. New claims remain proposals until analyst review.
        </p>
      ) : (
        <p className="asi-page-description">
          An analyst or administrator can queue bounded company research.
        </p>
      )}
      <div className="admin-actions">
        <Button
          onClick={() => void queueResearch()}
          isLoading={queueing}
          disabled={!canQueue || inProgress}
        >
          {inProgress ? "Research in progress" : "Queue company research"}
        </Button>
        <Button
          variant="secondary"
          onClick={() => void queueRefresh()}
          isLoading={queueing}
          disabled={!canQueue || inProgress}
        >
          Refresh if stale
        </Button>
        {queuedRun ? (
          <Link href={`/research-runs/${queuedRun.id}`}>View queued run</Link>
        ) : null}
      </div>
      {error ? (
        <p
          className="admin-feedback"
          data-tone="error"
          role="alert"
          style={{ marginBlockStart: "var(--asi-space-8)" }}
        >
          {error}
        </p>
      ) : null}
    </section>
  );
}
