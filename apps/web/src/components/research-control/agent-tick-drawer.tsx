"use client";

import { Badge, Button, EmptyState } from "@asi/ui";
import { useEffect, useState } from "react";

import { getAgentDetail, type AgentTickRecord } from "@/lib/agents-api";

import { findingsDeltas, formatTimestamp, formatUsd, planReasoning } from "./format";

const OUTCOME_TONES: Readonly<Record<string, "neutral" | "info" | "success" | "warning" | "danger">> = {
  planned: "info",
  executed: "success",
  done: "success",
  stuck: "warning",
  budget_exhausted: "warning",
  error: "danger",
  preempted: "neutral",
};

const REASONING_PREVIEW_CHARS = 140;

type TickEntryProps = Readonly<{ tick: AgentTickRecord }>;

/** One tick journal entry: outcome chip, expandable plan reasoning, deltas. */
function TickEntry({ tick }: TickEntryProps) {
  const [expanded, setExpanded] = useState(false);
  const reasoning = planReasoning(tick.plan);
  const deltas = findingsDeltas(tick.findings);
  const longReasoning = reasoning !== null && reasoning.length > REASONING_PREVIEW_CHARS;

  return (
    <li data-testid="tick-entry" data-outcome={tick.outcome}>
      <p>
        <Badge tone={OUTCOME_TONES[tick.outcome] ?? "neutral"}>
          {tick.outcome.replaceAll("_", " ")}
        </Badge>{" "}
        <time dateTime={tick.startedAt}>{formatTimestamp(tick.startedAt)}</time>
        {" → "}
        {tick.finishedAt === null ? (
          <span className="admin-user-meta">unfinished</span>
        ) : (
          <time dateTime={tick.finishedAt}>{formatTimestamp(tick.finishedAt)}</time>
        )}
        {" · "}
        {tick.actionsExecuted} action{tick.actionsExecuted === 1 ? "" : "s"}
        {" · "}
        {formatUsd(tick.costUsd)}
      </p>
      {reasoning === null ? null : (
        <p>
          {expanded || !longReasoning
            ? reasoning
            : `${reasoning.slice(0, REASONING_PREVIEW_CHARS).trimEnd()}…`}{" "}
          {longReasoning ? (
            <Button
              size="small"
              variant="ghost"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Show less" : "Show more"}
            </Button>
          ) : null}
        </p>
      )}
      {deltas.length === 0 ? null : (
        <p className="admin-user-meta">
          Findings:{" "}
          {deltas
            .map(([key, count]) => `${count} ${key.replace(/^new/, "").toLowerCase()}`)
            .join(", ")}
        </p>
      )}
      {tick.error === null ? null : (
        <p className="admin-feedback" data-tone="error" role="alert">
          {tick.error}
        </p>
      )}
    </li>
  );
}

type AgentTickDrawerProps = Readonly<{
  agentId: string;
  agentName: string;
  onClose: () => void;
}>;

/**
 * Tick drawer (REDESIGN_PLAN §3): the agent's recent ticks with plan
 * summaries, outcomes, findings deltas and cost — read straight from
 * GET /api/v1/agents/:id.
 */
export function AgentTickDrawer({ agentId, agentName, onClose }: AgentTickDrawerProps) {
  const [ticks, setTicks] = useState<readonly AgentTickRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setTicks(null);
    setError(null);
    getAgentDetail(agentId, controller.signal)
      .then((detail) => setTicks(detail.recentTicks))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "Failed to load ticks.");
      });
    return () => controller.abort();
  }, [agentId]);

  return (
    <aside
      className="admin-panel"
      role="dialog"
      aria-label={`Recent ticks for ${agentName}`}
      data-testid="tick-drawer"
      style={{ marginTop: "1rem" }}
    >
      <div className="admin-panel__header">
        <h3>Recent ticks — {agentName}</h3>
        <Button size="small" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      {error !== null ? (
        <p className="admin-feedback" data-tone="error" role="alert">
          Could not load ticks: {error}
        </p>
      ) : ticks === null ? (
        <p className="asi-page-description" role="status" aria-live="polite">
          Loading tick journal…
        </p>
      ) : ticks.length === 0 ? (
        <EmptyState
          title="No ticks recorded yet"
          description={
            <p>
              This agent has never run a tick. Ticks appear once the supervisor
              schedules it (check its status and cadence in the table above).
            </p>
          }
        />
      ) : (
        <ul className="asi-timeline">
          {ticks.map((tick) => (
            <TickEntry key={tick.id} tick={tick} />
          ))}
        </ul>
      )}
    </aside>
  );
}
