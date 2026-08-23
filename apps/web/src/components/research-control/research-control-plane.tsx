"use client";

import type { Role } from "@asi/contracts";
import { Button } from "@asi/ui";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  getAgentDetail,
  getAgentsOverview,
  listAgents,
  type AgentListItem,
  type AgentsOverview,
} from "@/lib/agents-api";

import { AgentTickDrawer } from "./agent-tick-drawer";
import { AgentsTable } from "./agents-table";
import { CampaignsStrip } from "./campaigns-strip";
import { LiveStrip } from "./live-strip";
import type { AgentActivity } from "./types";

const POLL_INTERVAL_MS = 10_000;

type ControlPlaneState = Readonly<{
  overview: AgentsOverview | null;
  agents: readonly AgentListItem[];
  activities: ReadonlyMap<string, AgentActivity>;
}>;

type PollOutcome =
  | Readonly<{ kind: "ok"; overview: AgentsOverview; agents: readonly AgentListItem[] }>
  | Readonly<{ kind: "error"; message: string }>;

/** One full control-plane refresh; aborts cleanly when superseded/unmounted. */
async function pollControlPlane(
  signal: AbortSignal,
): Promise<PollOutcome> {
  try {
    const [overview, agentPage] = await Promise.all([
      getAgentsOverview(signal),
      listAgents(signal),
    ]);
    return { kind: "ok", overview, agents: agentPage };
  } catch (cause) {
    if (signal.aborted) return { kind: "error", message: "aborted" };
    return {
      kind: "error",
      message: cause instanceof Error ? cause.message : "Request failed.",
    };
  }
}

/**
 * Per-agent activity summaries from the latest tick journal entry. Fetched
 * outside the strip poll so one slow detail call cannot stall the table;
 * failures degrade to the honest "no activity" rendering.
 */
async function loadActivities(
  agents: readonly AgentListItem[],
  signal: AbortSignal,
): Promise<ReadonlyMap<string, AgentActivity>> {
  const details = await Promise.all(
    agents.map((agent) =>
      getAgentDetail(agent.id, signal)
        .then((detail) => [agent.id, detail] as const)
        .catch(() => null),
    ),
  );
  const activities = new Map<string, AgentActivity>();
  for (const entry of details) {
    if (entry === null || signal.aborted) continue;
    const [, detail] = entry;
    const latest = detail.recentTicks[0] ?? null;
    const lastFinished = [...detail.recentTicks].find(
      (tick) => tick.finishedAt !== null,
    );
    activities.set(entry[0], {
      reasoning:
        latest === null
          ? null
          : typeof latest.plan.reasoning === "string" && latest.plan.reasoning.trim().length > 0
            ? latest.plan.reasoning
            : null,
      inProgress: latest !== null && latest.finishedAt === null,
      lastOutcome: lastFinished?.outcome ?? null,
    });
  }
  return activities;
}

export function ResearchControlPlane({ role }: Readonly<{ role: Role }>) {
  const [state, setState] = useState<ControlPlaneState>({
    overview: null,
    agents: [],
    activities: new Map(),
  });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAgentIds, setBusyAgentIds] = useState<ReadonlySet<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [drawerAgent, setDrawerAgent] = useState<AgentListItem | null>(null);
  const [campaignRefresh, setCampaignRefresh] = useState(0);
  const generationRef = useRef(0);

  const refresh = useCallback((showLoading: boolean) => {
    const generation = ++generationRef.current;
    const controller = new AbortController();
    if (showLoading) setLoading(true);
    void pollControlPlane(controller.signal).then(async (outcome) => {
      if (controller.signal.aborted || generation !== generationRef.current) return;
      if (outcome.kind === "error") {
        setLoadError(outcome.message);
        setLoading(false);
        return;
      }
      setLoadError(null);
      setState((previous) => ({
        overview: outcome.overview,
        agents: outcome.agents,
        // Activity details land separately below; stale rows show "…" briefly.
        activities: previous.activities,
      }));
      setLoading(false);
      const activities = await loadActivities(outcome.agents, controller.signal);
      if (controller.signal.aborted || generation !== generationRef.current) return;
      setState((previous) => ({ ...previous, activities }));
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const cancelInitial = refresh(true);
    const interval = window.setInterval(() => refresh(false), POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
      cancelInitial();
    };
  }, [refresh]);

  const handleLifecycleDone = useCallback(() => {
    setActionError(null);
    setBusyAgentIds(new Set());
    setCampaignRefresh((value) => value + 1);
    refresh(false);
  }, [refresh]);

  return (
    <div data-testid="research-control-plane">
      <LiveStrip loading={loading} overview={state.overview} error={loadError} />

      <section aria-labelledby="research-agents-heading" style={{ marginTop: "1.5rem" }}>
        <div className="admin-panel__header">
          <h2 id="research-agents-heading">Agents</h2>
          <p>
            Continuous research agents with their live activity, spend and
            controls. The strip and table refresh every{" "}
            {POLL_INTERVAL_MS / 1000} seconds.
          </p>
          <Button size="small" variant="secondary" onClick={() => refresh(true)} disabled={loading}>
            Refresh now
          </Button>
        </div>
        {actionError !== null ? (
          <p className="admin-feedback" data-tone="error" role="alert">
            Agent action failed: {actionError}
          </p>
        ) : null}
        {loadError !== null && state.agents.length === 0 ? (
          <p className="admin-feedback" data-tone="error" role="alert">
            Could not load agents: {loadError}
          </p>
        ) : (
          <AgentsTable
            agents={state.agents}
            activities={state.activities}
            role={role}
            dailyCapUsd={state.overview?.dailyCapUsd ?? 0}
            busyAgentIds={busyAgentIds}
            onLifecycleDone={handleLifecycleDone}
            onLifecycleError={setActionError}
            onOpenTicks={setDrawerAgent}
          />
        )}
        {drawerAgent !== null ? (
          <AgentTickDrawer
            agentId={drawerAgent.id}
            agentName={drawerAgent.name}
            onClose={() => setDrawerAgent(null)}
          />
        ) : null}
      </section>

      <section aria-labelledby="research-campaigns-section" style={{ marginTop: "1.5rem" }}>
        <h2 className="asi-sr-only" id="research-campaigns-section">
          Campaigns
        </h2>
        <CampaignsStrip refreshSignal={campaignRefresh} />
      </section>
    </div>
  );
}
