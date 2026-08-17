"use client";

import { Button, StatusDot } from "@asi/ui";
import Link from "next/link";
import { useState } from "react";

import { apiJson } from "@/components/csrf-client";

type QueuedRun = Readonly<{ id: string; status: string }>;

type EntityResearchActionProps = Readonly<{
  targetType: "platform" | "part" | "company" | "data_source";
  targetId: string;
  targetName: string;
  canQueue: boolean;
}>;

function statusTone(status: string): "info" | "success" | "warning" | "danger" {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "cancelled") return "danger";
  if (status === "queued" || status === "running") return "info";
  return "warning";
}

export function EntityResearchAction({
  targetType,
  targetId,
  targetName,
  canQueue,
}: EntityResearchActionProps) {
  const [queueing, setQueueing] = useState(false);
  const [error, setError] = useState<string>();
  const [queuedRun, setQueuedRun] = useState<QueuedRun>();
  const currentStatus = queuedRun?.status ?? "not_queued";
  const inProgress = currentStatus === "queued" || currentStatus === "running";
  const disabled = !canQueue || inProgress;

  async function queueResearch(): Promise<void> {
    setQueueing(true);
    setError(undefined);
    try {
      const run = await apiJson<QueuedRun>("/api/v1/research-runs", {
        method: "POST",
        body: JSON.stringify({
          targets: [
            {
              type: targetType,
              id: targetId,
              objective: `Search local reviewed evidence first, then extract reviewable facts about ${targetName}. Do not write canonical values.`,
            },
          ],
          metadata: { initiatedFrom: `${targetType}_profile` },
        }),
      });
      setQueuedRun(run);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to queue research.",
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
          target: { type: targetType, id: targetId },
          metadata: { initiatedFrom: `${targetType}_profile_refresh` },
        }),
      });
      setQueuedRun(run);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to queue refresh.",
      );
    } finally {
      setQueueing(false);
    }
  }

  return (
    <section className="admin-panel" aria-labelledby="entity-research-heading">
      <div className="admin-panel__header">
        <h2 id="entity-research-heading">Research</h2>
        <StatusDot
          label={currentStatus.replaceAll("_", " ")}
          tone={statusTone(currentStatus)}
        />
      </div>
      <p className="asi-page-description">
        {canQueue
          ? "Local reviewed evidence is searched first. New claims remain proposals."
          : "An analyst or administrator can queue bounded research."}
      </p>
      <div className="admin-actions">
        <Button
          onClick={() => void queueResearch()}
          isLoading={queueing}
          disabled={disabled}
        >
          {inProgress ? "Research in progress" : `Queue ${targetType} research`}
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
        <p className="admin-feedback" data-tone="error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
