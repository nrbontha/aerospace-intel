import { createHash } from "node:crypto";

import { z } from "zod";

import {
  normalizeExaOfficialCandidate,
  type ExaSearchClient,
  type ExaSearchResult,
} from "../search/exa.js";
import {
  parseSourceHarvestOptions,
  type SourceHarvestResult,
  type SourceHarvester,
  type SourceSignalProposal,
} from "./harvester.js";

export const EXA_COMPANY_LIST_SOURCE_KEY = "exa_company_search";
export const EXA_COMPANY_LIST_HARVESTER_ID = "exa_company_list";
export const EXA_COMPANY_LIST_MAX_RESULTS_PER_QUERY = 10;
export const EXA_COMPANY_LIST_MAX_RESULTS_PER_TICK = 25;

export const exaCompanyListHarvesterConfigSchema = z.strictObject({
  queryTemplates: z
    .array(z.string().trim().min(1).max(80))
    .min(1)
    .max(EXA_COMPANY_LIST_MAX_RESULTS_PER_TICK),
  geography: z.string().trim().min(1).max(80).optional(),
  product: z.string().trim().min(1).max(80).optional(),
  platform: z.string().trim().min(1).max(80).optional(),
});

export type ExaCompanyListHarvesterConfig = z.infer<
  typeof exaCompanyListHarvesterConfigSchema
>;

export interface ExaCompanySearchClient {
  search(query: string): Promise<readonly ExaSearchResult[]>;
}

const GOLDEN_ARCHETYPE_QUERY =
  '"United States" aerospace/defense "engineered component" manufacturer (PMA OR proprietary OR AS9100 OR qualified)';

export function buildExaCompanyListQuery(
  template: string,
  metadata: Pick<
    ExaCompanyListHarvesterConfig,
    "geography" | "product" | "platform"
  > = {},
): string {
  const suffix = [
    template.trim(),
    metadata.geography === undefined
      ? undefined
      : `geography "${metadata.geography}"`,
    metadata.product === undefined ? undefined : `product "${metadata.product}"`,
    metadata.platform === undefined
      ? undefined
      : `platform "${metadata.platform}"`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ");

  return `${GOLDEN_ARCHETYPE_QUERY} ${suffix}`;
}

export function fingerprintExaCompanyListResult(
  query: string,
  domain: string,
): string {
  return createHash("sha256")
    .update(`${EXA_COMPANY_LIST_SOURCE_KEY}\u0000${query}\u0000${domain}`)
    .digest("hex");
}

export class ExaCompanyListHarvester
  implements SourceHarvester<ExaCompanyListHarvesterConfig>
{
  readonly id = EXA_COMPANY_LIST_HARVESTER_ID;
  readonly configSchema = exaCompanyListHarvesterConfigSchema;

  constructor(
    private readonly client: Pick<ExaSearchClient, "search"> | ExaCompanySearchClient,
  ) {}

  async harvest(
    config: ExaCompanyListHarvesterConfig,
    unparsedOptions: Parameters<
      SourceHarvester<ExaCompanyListHarvesterConfig>["harvest"]
    >[1],
  ): Promise<SourceHarvestResult> {
    const parsedConfig = this.configSchema.parse(config);
    const options = parseSourceHarvestOptions(
      unparsedOptions,
      EXA_COMPANY_LIST_MAX_RESULTS_PER_TICK,
    );
    const startIndex = parseCursor(options.cursor, parsedConfig.queryTemplates.length);
    const signals: SourceSignalProposal[] = [];
    const seenFingerprints = new Set<string>();
    let fetched = 0;
    let rejected = 0;
    let duplicateCandidates = 0;
    let nextTemplateIndex = startIndex;

    for (
      let templateIndex = startIndex;
      templateIndex < parsedConfig.queryTemplates.length &&
      signals.length < options.limit &&
      fetched < EXA_COMPANY_LIST_MAX_RESULTS_PER_TICK;
      templateIndex += 1
    ) {
      throwIfAborted(options.signal);
      const template = parsedConfig.queryTemplates[templateIndex];
      if (template === undefined) break;
      const query = buildExaCompanyListQuery(template, parsedConfig);
      const results = await this.client.search(query);
      const boundedResults = results.slice(
        0,
        Math.min(
          EXA_COMPANY_LIST_MAX_RESULTS_PER_QUERY,
          EXA_COMPANY_LIST_MAX_RESULTS_PER_TICK - fetched,
        ),
      );
      fetched += boundedResults.length;
      nextTemplateIndex = templateIndex + 1;

      for (const result of boundedResults) {
        if (signals.length >= options.limit) break;
        const candidate = normalizeExaOfficialCandidate(result);
        if (candidate === null) {
          rejected += 1;
          continue;
        }

        const fingerprint = fingerprintExaCompanyListResult(
          query,
          candidate.domain,
        );
        if (seenFingerprints.has(fingerprint)) {
          duplicateCandidates += 1;
          continue;
        }
        seenFingerprints.add(fingerprint);

        signals.push({
          sourceKey: EXA_COMPANY_LIST_SOURCE_KEY,
          sourceLocator: candidate.url,
          sourceFingerprint: fingerprint,
          rawName: candidate.title,
          rawDomain: candidate.domain,
          sourcePayload: {
            query,
            snippet: candidate.textSnippet,
            score: candidate.score,
            url: candidate.url,
            appliedQueryMetadata: {
              template,
              templateIndex,
              geography: parsedConfig.geography ?? null,
              product: parsedConfig.product ?? null,
              platform: parsedConfig.platform ?? null,
            },
          },
        });
      }
    }

    return {
      signals,
      ...(nextTemplateIndex < parsedConfig.queryTemplates.length
        ? { nextCursor: String(nextTemplateIndex) }
        : {}),
      metrics: {
        fetched,
        emitted: signals.length,
        rejected,
        duplicateCandidates,
      },
    };
  }
}

function parseCursor(cursor: string | undefined, templateCount: number): number {
  if (cursor === undefined) return 0;
  if (!/^(?:0|[1-9]\d*)$/u.test(cursor)) {
    throw new RangeError("Exa company-list cursor is invalid");
  }

  const index = Number(cursor);
  if (!Number.isSafeInteger(index) || index < 0 || index > templateCount) {
    throw new RangeError("Exa company-list cursor is out of range");
  }
  return index;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("Harvest aborted", "AbortError");
}
