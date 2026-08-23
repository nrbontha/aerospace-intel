import {
  type CampaignDto,
  campaignCreateSchema,
  type FrontierItemDto,
  type FrontierItemType,
  frontierItemListQuerySchema,
} from "@asi/contracts";
import {
  type FrontierItem,
  type NewFrontierItem,
  type NewResearchCampaign,
  type ResearchCampaign,
  frontierItems,
  researchCampaigns,
} from "@asi/database";
import { getDatabase } from "@asi/database/client";
import { and, count, eq, sql } from "drizzle-orm";

import {
  frontierIdempotencyKey,
  manualFrontierItemSchema,
  type CampaignSeeds,
  type CampaignView,
  type DiscoveryStrategy,
  type ResearchPolicyVersion,
} from "./types.js";

export class CampaignNotFoundError extends Error {
  constructor(readonly campaignId: string) {
    super(`Campaign not found: ${campaignId}`);
    this.name = "CampaignNotFoundError";
  }
}

const EMPTY_SEEDS: CampaignSeeds = {
  sources: [],
  platforms: [],
  capabilities: [],
  geography: [],
};

function normalizeSeeds(raw: ResearchCampaign["seeds"]): CampaignSeeds {
  return {
    sources: raw?.sources ?? EMPTY_SEEDS.sources,
    platforms: raw?.platforms ?? EMPTY_SEEDS.platforms,
    capabilities: raw?.capabilities ?? EMPTY_SEEDS.capabilities,
    geography: raw?.geography ?? EMPTY_SEEDS.geography,
  };
}

export function serializeCampaign(row: ResearchCampaign): CampaignDto {
  return {
    id: row.id,
    name: row.name,
    objective: row.objective,
    thesisVersion: row.thesisVersion,
    policyVersion: row.policyVersion,
    seeds: normalizeSeeds(row.seeds),
    excludedSources: row.excludedSources,
    budgetUsd: row.budgetUsd === null ? null : Number(row.budgetUsd),
    spendUsd: Number(row.spendUsd),
    concurrency: row.concurrency,
    maxDepth: row.maxDepth,
    status: row.status,
    creator: row.creator,
    startedAt: row.startedAt?.toISOString() ?? null,
    pausedAt: row.pausedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    metrics: row.metrics,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Resolve the effective research policy for a campaign. A policy persisted
 * under `metrics.policy` wins; otherwise defaults are derived from columns
 * (enabledSources = seed sources minus excluded sources).
 */
export function resolvePolicyVersion(row: ResearchCampaign): ResearchPolicyVersion {
  const stored = row.metrics["policy"];
  if (
    typeof stored === "object" &&
    stored !== null &&
    "version" in stored &&
    "stoppingRules" in stored
  ) {
    return stored as ResearchPolicyVersion;
  }
  const seeds = normalizeSeeds(row.seeds);
  const excluded = new Set(row.excludedSources);
  return {
    version: row.policyVersion,
    enabledSources: seeds.sources.filter((s) => !excluded.has(s)),
    sourcePriorities: {},
    maxDepth: row.maxDepth,
    maxDocumentsPerCandidate: 25,
    stoppingRules: { stopWhenBudgetExhausted: true },
  };
}

export function toCampaignView(
  row: ResearchCampaign,
  policy: ResearchPolicyVersion = resolvePolicyVersion(row),
): CampaignView {
  return {
    id: row.id,
    name: row.name,
    objective: row.objective,
    thesisVersion: row.thesisVersion,
    policyVersion: row.policyVersion,
    seeds: normalizeSeeds(row.seeds),
    excludedSources: row.excludedSources,
    budgetUsd: row.budgetUsd === null ? null : Number(row.budgetUsd),
    spendUsd: Number(row.spendUsd),
    maxDepth: row.maxDepth,
    policy,
  };
}

export async function getCampaignRow(
  campaignId: string,
): Promise<ResearchCampaign | null> {
  const [row] = await getDatabase()
    .select()
    .from(researchCampaigns)
    .where(eq(researchCampaigns.id, campaignId))
    .limit(1);
  return row ?? null;
}

export interface CreateCampaignOptions {
  creator?: string;
}

/** Create a draft campaign from a validated create payload. */
export async function createCampaign(
  payload: unknown,
  options: CreateCampaignOptions = {},
): Promise<CampaignDto> {
  const parsed = campaignCreateSchema.parse(payload);
  const values: NewResearchCampaign = {
    name: parsed.name,
    ...(parsed.objective === undefined ? {} : { objective: parsed.objective }),
    ...(parsed.thesisVersion === undefined
      ? {}
      : { thesisVersion: parsed.thesisVersion }),
    ...(parsed.policyVersion === undefined
      ? {}
      : { policyVersion: parsed.policyVersion }),
    ...(parsed.seeds === undefined ? {} : { seeds: parsed.seeds }),
    ...(parsed.excludedSources === undefined
      ? {}
      : { excludedSources: parsed.excludedSources }),
    ...(options.creator === undefined ? {} : { creator: options.creator }),
    ...(parsed.budgetUsd === undefined
      ? {}
      : { budgetUsd: String(parsed.budgetUsd) }),
    ...(parsed.concurrency === undefined
      ? {}
      : { concurrency: parsed.concurrency }),
    ...(parsed.maxDepth === undefined ? {} : { maxDepth: parsed.maxDepth }),
    status: "draft",
  };
  const [row] = await getDatabase()
    .insert(researchCampaigns)
    .values(values)
    .returning();
  if (row === undefined) throw new Error("Campaign insert returned no row");
  return serializeCampaign(row);
}

export interface PlanCampaignOptions {
  /**
   * Searchable-source registry injected by the caller to avoid an import
   * cycle into the source catalog. Source seeds are intersected with this
   * list before insertion.
   */
  searchableSources?: string[] | (() => string[] | Promise<string[]>);
  /** Strategy consulted for seed support; defaults to accepting all. */
  strategy?: Pick<DiscoveryStrategy, "id" | "seedsSupported">;
}

export interface PlanCampaignResult {
  inserted: number;
  totalPlanned: number;
}

async function resolveSearchableSources(
  options: PlanCampaignOptions,
): Promise<string[]> {
  const raw = options.searchableSources;
  if (raw === undefined) return [];
  const resolved = typeof raw === "function" ? await raw() : raw;
  return resolved.map((source) => source.trim()).filter((s) => s.length > 0);
}

interface SeedPlanItem {
  itemType: FrontierItemType;
  normalizedValue: string;
  priority: number;
}

function buildSeedPlanItems(
  row: ResearchCampaign,
  policy: ResearchPolicyVersion,
  searchableSources: string[],
): SeedPlanItem[] {
  const seeds = normalizeSeeds(row.seeds);
  const excluded = new Set(row.excludedSources);
  const searchable = new Set(searchableSources);
  const items: SeedPlanItem[] = [];
  const seen = new Set<string>();
  const push = (itemType: FrontierItemType, value: string, priority: number) => {
    const normalizedValue = value.trim();
    const dedupeKey = `${itemType}|${normalizedValue}`;
    if (normalizedValue.length === 0 || seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    items.push({ itemType, normalizedValue, priority });
  };

  for (const source of seeds.sources) {
    if (excluded.has(source)) continue;
    if (!policy.enabledSources.includes(source)) continue;
    if (!searchable.has(source)) continue;
    push("source", source, policy.sourcePriorities[source] ?? 0);
  }
  for (const platform of seeds.platforms) push("platform", platform, 0);
  for (const capability of seeds.capabilities) push("qualification", capability, 0);
  for (const geography of seeds.geography) push("query", geography, 0);
  return items;
}

/**
 * Expand campaign seeds into initial frontier items. Idempotent: re-planning
 * inserts nothing for seeds whose idempotency keys already exist.
 */
export async function planCampaign(
  campaignId: string,
  options: PlanCampaignOptions = {},
): Promise<PlanCampaignResult> {
  const row = await getCampaignRow(campaignId);
  if (row === null) throw new CampaignNotFoundError(campaignId);

  const strategy = options.strategy;
  const seeds = normalizeSeeds(row.seeds);
  if (strategy !== undefined && !strategy.seedsSupported(seeds)) {
    throw new Error(
      `Strategy ${strategy.id} does not support the campaign seed set`,
    );
  }

  const policy = resolvePolicyVersion(row);
  const searchableSources = await resolveSearchableSources(options);
  const planned = buildSeedPlanItems(row, policy, searchableSources);

  if (planned.length === 0) return { inserted: 0, totalPlanned: 0 };

  const values: NewFrontierItem[] = planned.map((item) => ({
    campaignId,
    itemType: item.itemType,
    normalizedValue: item.normalizedValue,
    priority: String(item.priority),
    estimatedCostUsd: "0",
    depth: 0,
    status: "pending" as const,
    idempotencyKey: frontierIdempotencyKey(
      campaignId,
      item.itemType,
      item.normalizedValue,
    ),
    payload: {},
  }));

  const insertedRows = await getDatabase()
    .insert(frontierItems)
    .values(values)
    .onConflictDoNothing({ target: frontierItems.idempotencyKey })
    .returning({ id: frontierItems.id });

  // Persist the resolved policy so later waves observe identical rules.
  await getDatabase()
    .update(researchCampaigns)
    .set({ metrics: { ...row.metrics, policy } })
    .where(eq(researchCampaigns.id, campaignId));

  return {
    inserted: insertedRows.length,
    totalPlanned: planned.length,
  };
}

export interface CampaignDetail {
  campaign: CampaignDto;
  policy: ResearchPolicyVersion;
  frontierBreakdown: Record<string, number>;
}

export async function getCampaignDetail(
  campaignId: string,
): Promise<CampaignDetail> {
  const row = await getCampaignRow(campaignId);
  if (row === null) throw new CampaignNotFoundError(campaignId);
  return {
    campaign: serializeCampaign(row),
    policy: resolvePolicyVersion(row),
    frontierBreakdown: await countFrontierByStatus(campaignId),
  };
}

export interface ListCampaignsInput {
  page: number;
  pageSize: number;
}

export async function listCampaigns(input: ListCampaignsInput): Promise<{
  records: CampaignDto[];
  page: number;
  pageSize: number;
  total: number;
}> {
  const offset = (input.page - 1) * input.pageSize;
  const [rows, totals] = await Promise.all([
    getDatabase()
      .select()
      .from(researchCampaigns)
      .orderBy(sql`${researchCampaigns.createdAt} DESC`)
      .limit(input.pageSize)
      .offset(offset),
    getDatabase().select({ c: count() }).from(researchCampaigns),
  ]);
  const total = totals[0]?.c ?? 0;
  return {
    records: rows.map(serializeCampaign),
    page: input.page,
    pageSize: input.pageSize,
    total,
  };
}

function serializeFrontierItem(row: FrontierItem): FrontierItemDto {
  // Planner listings are campaign-scoped, so rows always carry a campaign.
  if (row.campaignId === null) {
    throw new Error("frontier item without a campaign owner reached the planner");
  }
  return {
    id: row.id,
    campaignId: row.campaignId,
    itemType: row.itemType,
    normalizedValue: row.normalizedValue,
    parentItemId: row.parentItemId,
    discoveryPath: row.discoveryPath,
    priority: Number(row.priority),
    estimatedValue: row.estimatedValue === null ? null : Number(row.estimatedValue),
    estimatedCostUsd: Number(row.estimatedCostUsd),
    depth: row.depth,
    status: row.status,
    attemptCount: row.attemptCount,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    idempotencyKey: row.idempotencyKey,
    normalizedUrl: row.normalizedUrl,
    contentSha256: row.contentSha256,
    failureReason: row.failureReason,
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

const frontierListQueryShape = frontierItemListQuerySchema;

export async function listFrontierItems(
  query: unknown,
): Promise<{
  records: FrontierItemDto[];
  page: number;
  pageSize: number;
  total: number;
}> {
  const parsed = frontierListQueryShape.parse(query);
  const conditions = [];
  if (parsed.campaignId !== undefined) {
    conditions.push(eq(frontierItems.campaignId, parsed.campaignId));
  }
  if (parsed.itemType !== undefined) {
    conditions.push(eq(frontierItems.itemType, parsed.itemType));
  }
  if (parsed.status !== undefined) {
    conditions.push(eq(frontierItems.status, parsed.status));
  }
  if (parsed.parentItemId !== undefined) {
    conditions.push(eq(frontierItems.parentItemId, parsed.parentItemId));
  }
  if (parsed.maxDepth !== undefined) {
    conditions.push(sql`${frontierItems.depth} <= ${parsed.maxDepth}`);
  }
  const where =
    conditions.length === 0 ? undefined : and(...conditions);
  const offset = (parsed.page - 1) * parsed.pageSize;

  const listQuery = getDatabase()
    .select()
    .from(frontierItems)
    .orderBy(sql`${frontierItems.priority} DESC, ${frontierItems.createdAt} ASC`)
    .limit(parsed.pageSize)
    .offset(offset);
  const countQuery = getDatabase().select({ c: count() }).from(frontierItems);
  const [rows, totals] = await Promise.all([
    where === undefined ? listQuery : listQuery.where(where),
    where === undefined ? countQuery : countQuery.where(where),
  ]);
  const total = totals[0]?.c ?? 0;
  return {
    records: rows.map(serializeFrontierItem),
    page: parsed.page,
    pageSize: parsed.pageSize,
    total,
  };
}

export async function countFrontierByStatus(
  campaignId: string,
): Promise<Record<string, number>> {
  const rows = await getDatabase()
    .select({
      status: frontierItems.status,
      c: count(),
    })
    .from(frontierItems)
    .where(eq(frontierItems.campaignId, campaignId))
    .groupBy(frontierItems.status);
  const breakdown: Record<string, number> = {};
  for (const row of rows) breakdown[row.status] = row.c;
  return breakdown;
}

export interface ManualFrontierAddResult {
  item: FrontierItemDto | null;
  duplicate: boolean;
}

/** Add one manually-authored frontier item (analyst action). */
export async function addManualFrontierItem(
  campaignId: string,
  payload: unknown,
): Promise<ManualFrontierAddResult> {
  const parsed = manualFrontierItemSchema.parse(payload);
  const row = await getCampaignRow(campaignId);
  if (row === null) throw new CampaignNotFoundError(campaignId);

  const inserted = await getDatabase()
    .insert(frontierItems)
    .values({
      campaignId,
      itemType: parsed.itemType satisfies FrontierItemType,
      normalizedValue: parsed.normalizedValue,
      priority: String(parsed.priority ?? 0),
      estimatedCostUsd: String(parsed.estimatedCostUsd ?? 0),
      depth: 0,
      status: "pending" as const,
      idempotencyKey: frontierIdempotencyKey(
        campaignId,
        parsed.itemType,
        parsed.normalizedValue,
      ),
      ...(parsed.payload === undefined ? {} : { payload: parsed.payload }),
    })
    .onConflictDoNothing({ target: frontierItems.idempotencyKey })
    .returning();

  const insertedRow = inserted[0];
  if (insertedRow === undefined) return { item: null, duplicate: true };
  return { item: serializeFrontierItem(insertedRow), duplicate: false };
}

