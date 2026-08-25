import type { AgentType, ResearchAgent } from "@asi/database";

import type { QueueLogger } from "../queue.js";

export type SupervisorLogger = QueueLogger;

export interface TickContext {
  agent: ResearchAgent;
  /** Aborted on graceful shutdown or wall-time breach. */
  signal: AbortSignal;
}

/** Success-family outcomes a handler may report ('executed' is the default). */
export type TickOutcomeReported = "executed" | "done" | "stuck" | "budget_exhausted";

export interface TickResult {
  outcome?: TickOutcomeReported;
  /** Proposed action batch / reasoning summary persisted on the tick row. */
  plan?: Record<string, unknown>;
  actionsExecuted?: number;
  findings?: Record<string, unknown>;
  costUsd?: number;
  /** Override normal cadence scheduling, for provider-supplied reset times. */
  nextTickAt?: Date;
}

/**
 * One agent tick. Real handlers land next wave (REDESIGN_PLAN §1.3);
 * v1 registers a passthrough no-op so the supervisor is fully exercisable.
 */
export type TickHandler = (context: TickContext) => Promise<TickResult>;

/** agent_type → handler. Every registry type MUST have an entry. */
export type TickHandlerRegistry = ReadonlyMap<AgentType, TickHandler>;

export interface SupervisorOptions {
  handlers: TickHandlerRegistry;
  logger?: SupervisorLogger;
  instanceId?: string;
  /** Due-agent polling period. */
  pollIntervalMs?: number;
  leaseSeconds?: number;
  maxConcurrentAgents?: number;
  /** Hard wall-time bound per tick; breach aborts and fails the tick. */
  tickWallTimeMs?: number;
  heartbeatIntervalMs?: number;
  /** Graceful-shutdown drains: natural completion first, then abort. */
  gracefulDrainMs?: number;
  abortDrainMs?: number;
  /** Injectable clock (tests advance it explicitly). */
  now?: () => Date;
  /**
   * Global daily model spend in USD; defaults to the shared model_usage sum
   * used by campaign budgets. Injectable for deterministic tests.
   */
  getDailySpendUsd?: () => Promise<number>;
}

export interface SupervisorRuntime {
  readonly instanceId: string;
  /** Stops claiming, drains ≤ gracefulDrainMs + abortDrainMs, resolves. */
  stop(): Promise<void>;
}
