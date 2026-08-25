import { z } from "zod";
import { instantSchema, paginatedQuerySchema, uuidSchema } from "../schemas.js";

// ---------------------------------------------------------------------------
// Agent runtime enums (REDESIGN_PLAN §1.1) — shared with the Drizzle schema
// ---------------------------------------------------------------------------

export const agentTypeValues = [
  "discover_source",
  "enrich_candidate",
  "monitor_ownership",
  "refresh_stale",
  "golden_neighbor",
  "resolve_domain",
  "qualify_award_lead",
] as const;
export const agentStatusValues = ["idle", "running", "paused", "failed"] as const;
export const tickOutcomeValues = [
  "planned",
  "executed",
  "stuck",
  "done",
  "budget_exhausted",
  "error",
  "preempted",
] as const;

export const agentTypeSchema = z.enum(agentTypeValues);
export const agentStatusSchema = z.enum(agentStatusValues);
export const tickOutcomeSchema = z.enum(tickOutcomeValues);

const slug = z
  .string()
  .trim()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase kebab-case slug")
  .max(100);

// ---------------------------------------------------------------------------
// Research agents
// ---------------------------------------------------------------------------

export const agentCreateSchema = z.strictObject({
  key: slug,
  name: z.string().trim().min(1).max(300),
  agentType: agentTypeSchema,
  goal: z.string().trim().min(1).max(10_000),
  seedScope: z.record(z.string(), z.unknown()).default({}),
  policyVersion: z.string().trim().max(100).optional(),
  budgetSharePct: z.number().min(0).max(100).optional(),
  dailyBudgetUsd: z.number().min(0).optional(),
  cadenceSeconds: z.number().int().min(1).default(900),
  status: agentStatusSchema.default("idle"),
  config: z.record(z.string(), z.unknown()).default({}),
});

/** key and agentType are immutable after registration; everything else editable. */
export const agentUpdateSchema = agentCreateSchema
  .omit({ key: true, agentType: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be supplied",
  });

export const agentDtoSchema = z.strictObject({
  id: uuidSchema,
  ...agentCreateSchema.shape,
  policyVersion: z.string().max(100).nullable(),
  budgetSharePct: z.number().min(0).max(100).nullable(),
  dailyBudgetUsd: z.number().min(0).nullable(),
  lastTickAt: instantSchema.nullable(),
  nextTickAt: instantSchema.nullable(),
  heartbeatAt: instantSchema.nullable(),
  leaseExpiresAt: instantSchema.nullable(),
  leasedBy: z.string().trim().min(1).max(300).nullable(),
  consecutiveFailures: z.number().int().min(0),
  spendTodayUsd: z.number().min(0),
  createdBy: uuidSchema.nullable(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});

export const agentListQuerySchema = paginatedQuerySchema.extend({
  status: agentStatusSchema.optional(),
  agentType: agentTypeSchema.optional(),
});

// ---------------------------------------------------------------------------
// Agent ticks
// ---------------------------------------------------------------------------

export const agentTickDtoSchema = z.strictObject({
  id: uuidSchema,
  agentId: uuidSchema,
  startedAt: instantSchema,
  finishedAt: instantSchema.nullable(),
  outcome: tickOutcomeSchema,
  plan: z.record(z.string(), z.unknown()),
  actionsExecuted: z.number().int().min(0),
  findings: z.record(z.string(), z.unknown()),
  costUsd: z.number().min(0),
  error: z.string().max(10_000).nullable(),
});

export const agentTickListQuerySchema = paginatedQuerySchema.extend({
  outcome: tickOutcomeSchema.optional(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentType = (typeof agentTypeValues)[number];
export type AgentStatus = (typeof agentStatusValues)[number];
export type TickOutcome = (typeof tickOutcomeValues)[number];
export type AgentCreate = z.infer<typeof agentCreateSchema>;
export type AgentUpdate = z.infer<typeof agentUpdateSchema>;
export type AgentDto = z.infer<typeof agentDtoSchema>;
export type AgentListQuery = z.infer<typeof agentListQuerySchema>;
export type AgentTickDto = z.infer<typeof agentTickDtoSchema>;
export type AgentTickListQuery = z.infer<typeof agentTickListQuerySchema>;
