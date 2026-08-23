import { frontierItemTypeSchema } from "@asi/contracts";
import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Frontier item type values, re-exported as a plain union so strategy
 * authors do not need to depend on zod inference.
 */
export type FrontierItemType = z.infer<typeof frontierItemTypeSchema>;

/** Seed shape shared with the `campaignSeedsSchema` contract. */
export interface CampaignSeeds {
  sources: string[];
  platforms: string[];
  capabilities: string[];
  geography: string[];
}

/**
 * A resolved research policy: which sources are enabled, how deep and how
 * wide discovery may go, and when the campaign must stop. Persisted as JSON
 * under `research_campaigns.metrics.policy` at plan time; derived from
 * column defaults when absent.
 */
export interface ResearchPolicyVersion {
  version: string;
  enabledSources: string[];
  sourcePriorities: Record<string, number>;
  maxDepth: number;
  maxDocumentsPerCandidate: number;
  stoppingRules: {
    maxFrontierItems?: number;
    targetCompanies?: number;
    stopWhenBudgetExhausted: true;
  };
}

/** A child frontier item proposed by a discovery strategy. */
export interface FrontierProposal {
  itemType: FrontierItemType;
  normalizedValue: string;
  payload?: Record<string, unknown>;
  estimatedCostUsd?: number;
  priority?: number;
}

/**
 * Read-only view of a campaign handed to strategies. Kept deliberately
 * narrow: strategies never mutate campaign state directly.
 */
export interface CampaignView {
  id: string;
  name: string;
  objective: string | null;
  thesisVersion: string;
  policyVersion: string;
  seeds: CampaignSeeds;
  excludedSources: string[];
  budgetUsd: number | null;
  spendUsd: number;
  maxDepth: number;
  policy: ResearchPolicyVersion;
}

/** Frontier item row shape strategies receive (subset they may rely on). */
export interface FrontierItemView {
  id: string;
  campaignId: string;
  itemType: FrontierItemType;
  normalizedValue: string;
  parentItemId: string | null;
  discoveryPath: string | null;
  depth: number;
  payload: Record<string, unknown>;
}

/**
 * Pluggable discovery strategy. Implementations MUST be effectively pure:
 * no campaign-state mutation, no direct spend recording — the frontier
 * runner owns claims, child insertion, and budget accounting. Concrete
 * source-adapter strategies are integrated in a later wave.
 */
export interface DiscoveryStrategy {
  readonly id: string;
  /** Whether this strategy can expand the given seed set. */
  seedsSupported(seeds: CampaignSeeds): boolean;
  /**
   * Propose child frontier items for a claimed item. MUST NOT persist
   * anything and MUST NOT make unbounded network/model calls without the
   * caller's budget gate (the runner checks budgets before invoking).
   */
  proposeFrontierItems(
    campaign: CampaignView,
    item: FrontierItemView,
  ): Promise<FrontierProposal[]>;
}

/**
 * Minimal strategy used by tests and as a no-op fallback: it echoes child
 * items supplied inline via `item.payload.children`, otherwise proposes
 * nothing.
 */
export class PassthroughStrategy implements DiscoveryStrategy {
  readonly id = "passthrough";

  seedsSupported(): boolean {
    return true;
  }

  async proposeFrontierItems(
    _campaign: CampaignView,
    item: FrontierItemView,
  ): Promise<FrontierProposal[]> {
    const children = item.payload["children"];
    if (!Array.isArray(children)) return [];
    const proposals: FrontierProposal[] = [];
    for (const child of children) {
      const parsed = z
        .object({
          itemType: frontierItemTypeSchema,
          normalizedValue: z.string().trim().min(1),
          payload: z.record(z.string(), z.unknown()).optional(),
          estimatedCostUsd: z.number().min(0).optional(),
          priority: z.number().optional(),
        })
        .safeParse(child);
      if (!parsed.success) continue;
      const value = parsed.data;
      proposals.push({
        itemType: value.itemType,
        normalizedValue: value.normalizedValue,
        ...(value.payload === undefined ? {} : { payload: value.payload }),
        ...(value.estimatedCostUsd === undefined
          ? {}
          : { estimatedCostUsd: value.estimatedCostUsd }),
        ...(value.priority === undefined ? {} : { priority: value.priority }),
      });
    }
    return proposals;
  }
}

/**
 * Delegates to every registered strategy and merges their proposals.
 * Each concrete strategy decides relevance itself; the runner dedupes via
 * idempotency keys.
 */
export class CompositeDiscoveryStrategy implements DiscoveryStrategy {
  readonly id: string;

  constructor(private readonly strategies: readonly DiscoveryStrategy[]) {
    this.id = `composite(${strategies.map((s) => s.id).join("+")})`;
  }

  seedsSupported(seeds: CampaignSeeds): boolean {
    return this.strategies.some((strategy) => strategy.seedsSupported(seeds));
  }

  async proposeFrontierItems(
    campaign: CampaignView,
    item: FrontierItemView,
  ): Promise<FrontierProposal[]> {
    const results = await Promise.all(
      this.strategies.map((strategy) =>
        strategy.proposeFrontierItems(campaign, item),
      ),
    );
    return results.flat();
  }
}

export function frontierIdempotencyKey(
  campaignId: string,
  itemType: FrontierItemType,
  normalizedValue: string,
): string {
  return createHash("sha256")
    .update(`${campaignId}|${itemType}|${normalizedValue}`)
    .digest("hex");
}

/** Body schema for the manual frontier-add route. */
export const manualFrontierItemSchema = z.strictObject({
  itemType: frontierItemTypeSchema,
  normalizedValue: z.string().trim().min(1).max(2_000),
  priority: z.number().min(-100).max(100).optional(),
  estimatedCostUsd: z.number().min(0).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export type ManualFrontierItem = z.infer<typeof manualFrontierItemSchema>;
