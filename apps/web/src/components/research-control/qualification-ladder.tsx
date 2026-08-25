import type { AgentListItem } from "@/lib/agents-api";

type QualificationLadderProps = Readonly<{
  agents: readonly AgentListItem[];
}>;

function qualificationAgentState(
  agents: readonly AgentListItem[],
): Readonly<{ label: string; names: string | null }> {
  const qualificationAgents = agents.filter(
    (agent) => agent.agentType === "qualify_award_lead",
  );
  if (qualificationAgents.length === 0) {
    return { label: "Not configured", names: null };
  }

  const status = qualificationAgents.some((agent) => agent.status === "running")
    ? "Running"
    : qualificationAgents.some((agent) => agent.status === "paused")
      ? "Paused"
      : "Idle";

  return {
    label: status,
    names: qualificationAgents.map((agent) => agent.name).join(", "),
  };
}

/**
 * Operational explanation of the qualification boundary. It intentionally
 * exposes counts and agent state, never the raw source-signal recipients.
 */
export function QualificationLadder({ agents }: QualificationLadderProps) {
  const agent = qualificationAgentState(agents);

  return (
    <details
      className="admin-panel"
      data-testid="qualification-ladder"
      style={{ marginTop: "1.5rem" }}
    >
      <summary>
        <strong>Qualification ladder</strong>
      </summary>
      <p>
        Qualification agent:{" "}
        <strong data-testid="qualification-agent-state">{agent.label}</strong>
        {agent.names === null ? null : ` (${agent.names})`}.
      </p>
      <p className="asi-page-description">
        This is observability only. Raw source signals stay quarantined and are
        never listed here as leads or targets.
      </p>
      <ol>
        <li>USAspending creates a quarantined source signal.</li>
        <li>Exa proposes the company&apos;s official domain.</li>
        <li>Official site, location, and CAGE or UEI verify the identity.</li>
        <li>
          Official-site URL and excerpt evidence verify manufacturing and
          aerospace relevance.
        </li>
        <li>
          Ownership and actionability screening determines whether it can proceed.
        </li>
        <li>Only a passing, evidence-backed manufacturer creates a Lead.</li>
      </ol>
    </details>
  );
}
