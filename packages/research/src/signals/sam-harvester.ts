import { createHash } from "node:crypto";

import { z } from "zod";

import {
  isSamEntityActive,
  isSamEntityExcluded,
  isSamEntityUnitedStates,
  type SamEntity,
  type SamEntityClient,
  type SamSearchQuery,
  type SamSearchResult,
} from "../sources/sam.js";
import {
  parseSourceHarvestOptions,
  type SourceHarvestResult,
  type SourceHarvester,
  type SourceSignalProposal,
} from "./harvester.js";

export const SAM_ENTITY_SOURCE_KEY = "sam_entity";
export const SAM_ENTITY_HARVESTER_ID = "sam_entity";
export const SAM_ENTITY_HARVEST_MAX_RESULTS = 25;

export const samEntityHarvesterConfigSchema = z
  .strictObject({
    naicsCodes: z
      .array(z.string().regex(/^\d{6}$/u, "SAM NAICS codes must contain exactly six digits"))
      .min(1)
      .max(SAM_ENTITY_HARVEST_MAX_RESULTS),
    state: z.string().trim().regex(/^[A-Z]{2}$/u).optional(),
    maxResults: z.number().int().min(1).max(SAM_ENTITY_HARVEST_MAX_RESULTS),
  })
  .superRefine((config, context) => {
    if (new Set(config.naicsCodes).size !== config.naicsCodes.length) {
      context.addIssue({
        code: "custom",
        path: ["naicsCodes"],
        message: "SAM NAICS codes must be unique",
      });
    }
  });

export type SamEntityHarvesterConfig = z.infer<
  typeof samEntityHarvesterConfigSchema
>;

export interface SamEntitySearchClient {
  search(query: SamSearchQuery): Promise<SamSearchResult>;
}

export function fingerprintSamEntity(uei: string): string {
  return createHash("sha256")
    .update(`${SAM_ENTITY_SOURCE_KEY}\u0000${uei}`)
    .digest("hex");
}

export class SamEntityHarvester
  implements SourceHarvester<SamEntityHarvesterConfig>
{
  readonly id = SAM_ENTITY_HARVESTER_ID;
  readonly configSchema = samEntityHarvesterConfigSchema;

  constructor(
    private readonly client: Pick<SamEntityClient, "search"> | SamEntitySearchClient,
  ) {}

  async harvest(
    config: SamEntityHarvesterConfig,
    unparsedOptions: Parameters<
      SourceHarvester<SamEntityHarvesterConfig>["harvest"]
    >[1],
  ): Promise<SourceHarvestResult> {
    const parsedConfig = this.configSchema.parse(config);
    const options = parseSourceHarvestOptions(
      unparsedOptions,
      SAM_ENTITY_HARVEST_MAX_RESULTS,
    );
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new DOMException("Harvest aborted", "AbortError");
    }

    const result = await this.client.search({
      naicsCodes: parsedConfig.naicsCodes,
      ...(parsedConfig.state === undefined ? {} : { state: parsedConfig.state }),
      maxResults: parsedConfig.maxResults,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    const signals: SourceSignalProposal[] = [];
    const seenFingerprints = new Set<string>();
    let rejected = 0;
    let duplicateCandidates = 0;

    for (const entity of result.entities) {
      if (signals.length >= options.limit) break;
      if (
        !isSamEntityActive(entity) ||
        !isSamEntityUnitedStates(entity) ||
        isSamEntityExcluded(entity)
      ) {
        rejected += 1;
        continue;
      }

      const fingerprint = fingerprintSamEntity(entity.uei);
      if (seenFingerprints.has(fingerprint)) {
        duplicateCandidates += 1;
        continue;
      }
      seenFingerprints.add(fingerprint);
      signals.push(toSourceSignal(entity, fingerprint));
    }

    return {
      signals,
      metrics: {
        fetched: result.entities.length,
        emitted: signals.length,
        rejected,
        duplicateCandidates,
      },
    };
  }
}

function toSourceSignal(
  entity: SamEntity,
  sourceFingerprint: string,
): SourceSignalProposal {
  return {
    sourceKey: SAM_ENTITY_SOURCE_KEY,
    sourceLocator: entity.sourceLocator,
    sourceFingerprint,
    rawName: entity.legalName,
    ...(entity.officialDomain === null ? {} : { rawDomain: entity.officialDomain }),
    uei: entity.uei,
    ...(entity.cageCode === null ? {} : { cage: entity.cageCode }),
    ...(entity.city === null ? {} : { city: entity.city }),
    ...(entity.state === null ? {} : { state: entity.state }),
    ...(entity.country === null ? {} : { country: entity.country }),
    sourcePayload: entity.raw,
  };
}
