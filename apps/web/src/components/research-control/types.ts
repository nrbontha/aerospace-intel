// Shared view types for the Research control plane components.

/**
 * Current-activity summary for one agent row, derived from the agent's most
 * recent tick journal entry. `undefined` (absent from the map) means "still
 * loading"; `null` fields mean the journal honestly has nothing to show.
 */
export type AgentActivity = Readonly<{
  /** Planner reasoning sentence from the latest tick's plan envelope. */
  reasoning: string | null;
  /** True when the latest tick has started but not finished. */
  inProgress: boolean;
  /** Outcome of the latest finished tick, if any. */
  lastOutcome: string | null;
}>;
