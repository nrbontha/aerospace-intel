"use client";

import type { SourceAccess } from "@asi/contracts";
import { Button, StatusDot } from "@asi/ui";
import Link from "next/link";
import { useState } from "react";

import { apiJson } from "@/components/csrf-client";

type QueuedRun = Readonly<{ id: string; status: string }>;

type SourceResearchActionProps = Readonly<{
  sourceId: string;
  sourceName: string;
  access: SourceAccess;
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

export function SourceResearchAction({
  sourceId,
  sourceName,
  access,
  canQueue,
  latestStatus,
  onQueued,
}: SourceResearchActionProps) {
  const [queueing, setQueueing] = useState(false);
  const [error, setError] = useState<string>();
  const [queuedRun, setQueuedRun] = useState<QueuedRun>();
  const restricted = access === "restricted_metadata_only";
  const currentStatus = queuedRun?.status ?? latestStatus ?? "not_queued";
  const inProgress = currentStatus === "queued" || currentStatus === "running";
  const disabled = restricted || !canQueue || inProgress;

  async function queueResearch(): Promise<void> {
    setQueueing(true);
    setError(undefined);
    try {
      const run = await apiJson<QueuedRun>("/api/v1/research-runs", {
        method: "POST",
        body: JSON.stringify({
          targets: [
            {
              type: "data_source",
              id: sourceId,
              objective: `Extract evidence-backed company and supplier facts from ${sourceName}. Preserve source citations and leave unsupported fields unassessed.`,
            },
          ],
          metadata: { initiatedFrom: "source_profile" },
        }),
      });
      setQueuedRun(run);
      onQueued?.(run);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to queue source research.",
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
          target: { type: "data_source", id: sourceId },
          metadata: { initiatedFrom: "source_profile_refresh" },
        }),
      });
      setQueuedRun(run);
      onQueued?.(run);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to queue source refresh.",
      );
    } finally {
      setQueueing(false);
    }
  }

  return (
    <section className="admin-panel" aria-labelledby="source-research-heading">
      <div className="admin-panel__header">
        <h2 id="source-research-heading">Source research</h2>
        <StatusDot
          label={
            restricted ? "Never searched" : currentStatus.replaceAll("_", " ")
          }
          tone={restricted ? "warning" : statusTone(currentStatus)}
        />
      </div>
      {restricted ? (
        <p className="asi-page-description">
          This is a restricted metadata-only record. Its links remain available
          for human metadata navigation, but automatic research is disabled and
          no source content is represented as searched.
        </p>
      ) : !canQueue ? (
        <p className="asi-page-description">
          An analyst or administrator can queue bounded research for this
          source.
        </p>
      ) : (
        <p className="asi-page-description">
          Queue one bounded research run. Extracted claims remain proposals
          until analyst review.
        </p>
      )}
      <div className="admin-actions">
        <Button
          onClick={() => void queueResearch()}
          isLoading={queueing}
          disabled={disabled}
        >
          {inProgress ? "Research in progress" : "Queue source research"}
        </Button>
        <Button
          variant="secondary"
          onClick={() => void queueRefresh()}
          isLoading={queueing}
          disabled={disabled}
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
