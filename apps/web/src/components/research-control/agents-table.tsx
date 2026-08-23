"use client";

import type { Role } from "@asi/contracts";
import { Button, StatusDot, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@asi/ui";
import { useState } from "react";

import {
  postAgentLifecycle,
  type AgentListItem,
  type AgentStatus,
} from "@/lib/agents-api";

import { formatCadence, formatRelativeTime, formatUsd, truncate } from "./format";
import type { AgentActivity } from "./types";

const STATUS_TONES: Readonly<Record<AgentStatus, "info" | "neutral" | "warning" | "danger">> = {
  running: "info",
  idle: "neutral",
  paused: "warning",
  failed: "danger",
};

const OUTCOME_LABELS: Readonly<Record<string, string>> = {
  planned: "planned",
  executed: "executed",
  stuck: "stuck",
  done: "done",
  budget_exhausted: "budget exhausted",
  error: "error",
  preempted: "preempted",
};

export const ACTIVITY_TRUNCATION = 110;

/** Effective spend ceiling shown against an agent's spend-today. */
function agentBudgetUsd(
  agent: Pick<AgentListItem, "dailyBudgetUsd" | "budgetSharePct">,
  dailyCapUsd: number,
): number | null {
  if (agent.dailyBudgetUsd !== null) return agent.dailyBudgetUsd;
  if (agent.budgetSharePct !== null) return (dailyCapUsd * agent.budgetSharePct) / 100;
  return dailyCapUsd;
}

type RowControlsProps = Readonly<{
  agent: AgentListItem;
  canOperate: boolean;
  isAdmin: boolean;
  busy: boolean;
  onLifecycleDone: () => void;
  onLifecycleError: (message: string) => void;
}>;

/**
 * Pause/resume (analyst+) and kill (admin only, reason required). The kill
 * reason is collected inline — a bare confirm would post an empty audit
 * trail, which the API rejects anyway.
 */
function RowControls({
  agent,
  canOperate,
  isAdmin,
  busy,
  onLifecycleDone,
  onLifecycleError,
}: RowControlsProps) {
  const [killing, setKilling] = useState(false);
  const [reason, setReason] = useState("");

  if (!canOperate && !isAdmin) {
    return (
      <span className="admin-user-meta">Viewers cannot change agent state.</span>
    );
  }

  const run = (action: "pause" | "resume" | "kill") => {
    void postAgentLifecycle(
      agent.id,
      action,
      action === "kill" ? reason : undefined,
    )
      .then(onLifecycleDone)
      .catch((error: unknown) => {
        onLifecycleError(
          error instanceof Error ? error.message : `${action} failed.`,
        );
      })
      .finally(() => {
        setKilling(false);
        setReason("");
      });
  };

  return (
    <div className="admin-actions">
      {canOperate ? (
        agent.status === "paused" ? (
          <Button
            size="small"
            variant="secondary"
            disabled={busy}
            onClick={() => run("resume")}
          >
            Resume
          </Button>
        ) : (
          <Button
            size="small"
            variant="secondary"
            disabled={busy}
            onClick={() => run("pause")}
          >
            Pause
          </Button>
        )
      ) : null}
      {isAdmin ? (
        killing ? (
          <>
            <input
              aria-label={`Reason for killing ${agent.name}`}
              placeholder="Reason (required)"
              maxLength={2000}
              value={reason}
              autoFocus
              onChange={(event) => setReason(event.target.value)}
              style={{ minWidth: "12rem" }}
            />
            <Button
              size="small"
              variant="danger"
              disabled={busy || reason.trim().length === 0}
              onClick={() => run("kill")}
            >
              Confirm kill
            </Button>
            <Button
              size="small"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setKilling(false);
                setReason("");
              }}
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button
            size="small"
            variant="ghost"
            disabled={busy}
            title="Admin only: aborts the current tick and pauses the agent"
            onClick={() => setKilling(true)}
          >
            Kill…
          </Button>
        )
      ) : null}
    </div>
  );
}

type AgentsTableRowProps = Readonly<{
  agent: AgentListItem;
  activity: AgentActivity | undefined;
  canOperate: boolean;
  isAdmin: boolean;
  dailyCapUsd: number;
  busy: boolean;
  onLifecycleDone: () => void;
  onLifecycleError: (message: string) => void;
  onOpenTicks: (agent: AgentListItem) => void;
}>;

function AgentsTableRow({
  agent,
  activity,
  canOperate,
  isAdmin,
  dailyCapUsd,
  busy,
  onLifecycleDone,
  onLifecycleError,
  onOpenTicks,
}: AgentsTableRowProps) {
  const budget = agentBudgetUsd(agent, dailyCapUsd);
  const spentPct =
    budget !== null && budget > 0
      ? Math.min(100, (agent.spendTodayUsd / budget) * 100)
      : agent.spendTodayUsd > 0
        ? 100
        : 0;
  // Discovery-origin filtering does not exist in the feed API yet (the feed
  // renders its origin select disabled), so the link degrades honestly to the
  // tier filter alone.
  const findsHref = `/feed?tier=high_interest`;

  let activityText: string;
  if (activity === undefined) {
    activityText = "…";
  } else if (activity.inProgress) {
    activityText = `Tick in progress${
      activity.reasoning === null ? "" : ` — ${truncate(activity.reasoning, ACTIVITY_TRUNCATION)}`
    }`;
  } else if (activity.reasoning !== null) {
    activityText = truncate(activity.reasoning, ACTIVITY_TRUNCATION);
  } else if (activity.lastOutcome !== null) {
    activityText = `Last tick ${OUTCOME_LABELS[activity.lastOutcome] ?? activity.lastOutcome}`;
  } else {
    activityText = "No ticks recorded yet";
  }

  return (
    <TableRow data-testid="agent-row" data-agent-key={agent.key}>
      <TableCell>
        <StatusDot
          label={OUTCOME_LABELS[agent.status] ?? agent.status}
          tone={STATUS_TONES[agent.status]}
        />
      </TableCell>
      <TableCell>
        <strong>{agent.name}</strong>
        <span className="admin-user-meta">
          {" "}
          {agent.key} · {agent.agentType}
        </span>
      </TableCell>
      <TableCell>{activityText}</TableCell>
      <TableCell>
        {agent.findsToday > 0 ? (
          <a href={findsHref} title="High-interest finds; discovery-origin filtering is not supported by the feed yet">
            {agent.findsToday} today ↗
          </a>
        ) : (
          <span className="admin-user-meta">0 today</span>
        )}
      </TableCell>
      <TableCell>
        {formatUsd(agent.spendTodayUsd)}
        {budget === null ? null : (
          <>
            {" "}
            <span className="admin-user-meta">
              of {formatUsd(budget)}
            </span>
            <span
              role="progressbar"
              aria-valuenow={Math.round(spentPct)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${agent.name} spend against its budget share`}
              style={{
                display: "block",
                height: "4px",
                borderRadius: "2px",
                background: "var(--asi-border, #d4d4d8)",
                overflow: "hidden",
              }}
            >
              <span
                style={{
                  display: "block",
                  width: `${spentPct}%`,
                  height: "100%",
                  background:
                    spentPct >= 100
                      ? "var(--asi-danger, #dc2626)"
                      : "var(--asi-accent, #2563eb)",
                }}
              />
            </span>
          </>
        )}
      </TableCell>
      <TableCell>
        {agent.consecutiveFailures > 0 ? (
          <strong aria-label="Consecutive failures">
            {agent.consecutiveFailures} ✗
          </strong>
        ) : (
          "0"
        )}
      </TableCell>
      <TableCell>
        every {formatCadence(agent.cadenceSeconds)}
        <span className="admin-user-meta">
          {agent.nextTickAt === null
            ? ""
            : ` · next ${formatRelativeTime(agent.nextTickAt)}`}
        </span>
      </TableCell>
      <TableCell>
        <RowControls
          agent={agent}
          canOperate={canOperate}
          isAdmin={isAdmin}
          busy={busy}
          onLifecycleDone={onLifecycleDone}
          onLifecycleError={onLifecycleError}
        />
      </TableCell>
      <TableCell>
        <Button size="small" variant="secondary" onClick={() => onOpenTicks(agent)}>
          Ticks
        </Button>
      </TableCell>
    </TableRow>
  );
}

type AgentsTableProps = Readonly<{
  agents: readonly AgentListItem[];
  activities: ReadonlyMap<string, AgentActivity>;
  role: Role;
  dailyCapUsd: number;
  busyAgentIds: ReadonlySet<string>;
  onLifecycleDone: () => void;
  onLifecycleError: (message: string) => void;
  onOpenTicks: (agent: AgentListItem) => void;
}>;

/**
 * Agents table (REDESIGN_PLAN §3): status dot · current activity · finds ·
 * spend vs share · consecutive failures · cadence · pause/resume/kill · ticks.
 */
export function AgentsTable(props: AgentsTableProps) {
  const {
    agents,
    activities,
    role,
    dailyCapUsd,
    busyAgentIds,
    onLifecycleDone,
    onLifecycleError,
    onOpenTicks,
  } = props;
  const canOperate = role === "analyst" || role === "admin";

  if (agents.length === 0) {
    return (
      <p className="asi-page-description" role="status">
        No research agents are registered yet. Agents appear here as soon as the
        registry has rows — nothing is invented while the registry is empty.
      </p>
    );
  }

  return (
    <Table data-testid="agents-table">
      <TableCaption>
        {agents.length} registered agent{agents.length === 1 ? "" : "s"}.
        Activity summaries come from each agent&apos;s most recent tick journal
        entry.
      </TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Status</TableHead>
          <TableHead scope="col">Agent</TableHead>
          <TableHead scope="col">Current activity</TableHead>
          <TableHead scope="col">Finds</TableHead>
          <TableHead scope="col">Spend today</TableHead>
          <TableHead scope="col">Failures</TableHead>
          <TableHead scope="col">Cadence</TableHead>
          <TableHead scope="col">Controls</TableHead>
          <TableHead scope="col">Journal</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {agents.map((agent) => (
          <AgentsTableRow
            key={agent.id}
            agent={agent}
            activity={activities.get(agent.id)}
            canOperate={canOperate}
            isAdmin={role === "admin"}
            dailyCapUsd={dailyCapUsd}
            busy={busyAgentIds.has(agent.id)}
            onLifecycleDone={onLifecycleDone}
            onLifecycleError={onLifecycleError}
            onOpenTicks={() => onOpenTicks(agent)}
          />
        ))}
      </TableBody>
    </Table>
  );
}
