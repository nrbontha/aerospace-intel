import { z } from "zod";

export const SOURCE_HARVEST_LIMIT_MAX = 50;

const optionalIdentity = z.string().trim().min(1).max(300).optional();

/**
 * An unqualified observation from an external source. Proposals are deliberately
 * source-shaped and must pass through qualification before becoming visible
 * lead or candidate records.
 */
export const sourceSignalProposalSchema = z.strictObject({
  sourceKey: z.string().trim().min(1).max(100),
  sourceLocator: z.string().trim().min(1).max(2_000),
  sourceFingerprint: z.string().trim().min(1).max(128),
  rawName: z.string().trim().min(1).max(1_000),
  rawDomain: z.string().trim().min(1).max(500).optional(),
  uei: optionalIdentity,
  cage: optionalIdentity,
  city: optionalIdentity,
  state: optionalIdentity,
  country: optionalIdentity,
  awardCount: z.number().int().min(0).optional(),
  awardValue: z.number().finite().min(0).optional(),
  freshestAward: z.iso.datetime().optional(),
  sourcePayload: z.record(z.string(), z.unknown()),
});

export type SourceSignalProposal = z.infer<typeof sourceSignalProposalSchema>;

export const sourceHarvestOptionsSchema = z.strictObject({
  limit: z.number().int().min(1).max(SOURCE_HARVEST_LIMIT_MAX),
  cursor: z.string().trim().min(1).max(500).optional(),
  signal: z.custom<AbortSignal>(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      "aborted" in value &&
      typeof value.aborted === "boolean",
  ).optional(),
});

export type SourceHarvestOptions = z.infer<typeof sourceHarvestOptionsSchema>;

export const sourceHarvestMetricsSchema = z.strictObject({
  fetched: z.number().int().min(0),
  emitted: z.number().int().min(0),
  rejected: z.number().int().min(0),
  duplicateCandidates: z.number().int().min(0),
});

export type SourceHarvestMetrics = z.infer<typeof sourceHarvestMetricsSchema>;

export interface SourceHarvestResult {
  readonly signals: readonly SourceSignalProposal[];
  readonly nextCursor?: string;
  readonly metrics: SourceHarvestMetrics;
}

export interface SourceHarvester<Config> {
  readonly id: string;
  readonly configSchema: z.ZodType<Config>;
  harvest(
    config: Config,
    options: SourceHarvestOptions,
  ): Promise<SourceHarvestResult>;
}

/** Enforces both the shared limit contract and an adapter's lower ceiling. */
export function parseSourceHarvestOptions(
  options: SourceHarvestOptions,
  adapterLimitMax: number = SOURCE_HARVEST_LIMIT_MAX,
): SourceHarvestOptions {
  if (
    !Number.isInteger(adapterLimitMax) ||
    adapterLimitMax < 1 ||
    adapterLimitMax > SOURCE_HARVEST_LIMIT_MAX
  ) {
    throw new RangeError(
      `adapterLimitMax must be between 1 and ${SOURCE_HARVEST_LIMIT_MAX}`,
    );
  }

  return sourceHarvestOptionsSchema.extend({
    limit: z.number().int().min(1).max(adapterLimitMax),
  }).parse(options);
}
