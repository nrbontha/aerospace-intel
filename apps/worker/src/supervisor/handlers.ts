import type { AgentType } from "@asi/database";

import type { TickHandler, TickHandlerRegistry } from "./types.js";

/**
 * v1 passthrough: performs no work and costs nothing. It exists so the
 * lease/heartbeat/journal/budget machinery is fully exercisable before the
 * real per-type executors land (REDESIGN_PLAN delivery step 3–4).
 */
export const createNoopTickHandler = (): TickHandler => async () => ({});

const ALL_AGENT_TYPES: AgentType[] = [
  "discover_source",
  "enrich_candidate",
  "monitor_ownership",
  "refresh_stale",
  "golden_neighbor",
];

export const createV1TickHandlerRegistry = (): TickHandlerRegistry => {
  const noop = createNoopTickHandler();
  return new Map(ALL_AGENT_TYPES.map((type) => [type, noop]));
};
