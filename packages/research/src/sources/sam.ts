import { z } from "zod";

import { SourceApiKeyMissingError, SourceFetchError } from "./types.js";

/** SAM.gov Entity Management API v4. The credential is always sent in a header. */
export const SAM_ENTITY_SEARCH_URL =
  "https://api.sam.gov/entity-information/v4/entities";
export const SAM_ENTITY_PAGE_SIZE_MAX = 10;
export const SAM_ENTITY_MAX_PAGES = 10;
export const SAM_ENTITY_TIMEOUT_MS = 20_000;
export const SAM_ENTITY_RESULT_MAX = 25;

const DEFAULT_MAX_PAGES = 3;
const DEFAULT_PAGE_SIZE = 10;
const DEFAULT_MAX_RESULTS = 25;
const INCLUDED_SECTIONS = "entityRegistration,coreData,assertions";

export class SamApiKeyMissingError extends SourceApiKeyMissingError {
  override readonly name: string = "SamApiKeyMissingError";
  constructor() {
    super("SAM.gov");
  }
}

/** SAM.gov's daily personal-key quota has been consumed until `resetAt`. */
export class SamQuotaExceededError extends SourceFetchError {
  override readonly name: string = "SamQuotaExceededError";
  readonly resetAt: Date;

  constructor(resetAt: Date, status: number) {
    super("SAM.gov daily request quota exhausted", {
      transient: true,
      status,
    });
    this.resetAt = resetAt;
  }
}

const nonemptyString = z.string().min(1);
const optionalString = z.string().min(1).nullish();
const booleanish = z.union([z.boolean(), z.string(), z.number()]).nullish();

const physicalAddressSchema = z
  .object({
    addressLine1: optionalString,
    addressLine2: optionalString,
    city: optionalString,
    stateOrProvinceCode: optionalString,
    zipCode: optionalString,
    zipCodePlus4: optionalString,
    countryCode: optionalString,
    country: optionalString,
  })
  .passthrough();

const naicsItemSchema = z
  .object({
    naicsCode: z.string().nullish(),
    naicsDescription: z.string().nullish(),
    sbaSmallBusiness: booleanish,
  })
  .passthrough();

const pscItemSchema = z.union([
  z.string(),
  z
    .object({
      pscCode: z.string().nullish(),
      pscDescription: z.string().nullish(),
      pscName: z.string().nullish(),
    })
    .passthrough(),
]);

const goodsAndServicesSchema = z
  .object({
    primaryNaics: z.union([z.string(), naicsItemSchema]).nullish(),
    naicsList: z.array(naicsItemSchema).nullish(),
    pscList: z.array(pscItemSchema).nullish(),
  })
  .passthrough();

/** The public v4 shape is passthrough so the complete provider payload survives ingestion. */
export const samEntityRecordSchema = z
  .object({
    entityRegistration: z
      .object({
        ueiSAM: nonemptyString,
        cageCode: optionalString,
        legalBusinessName: nonemptyString,
        registrationStatus: optionalString,
        exclusionStatusFlag: booleanish,
      })
      .passthrough(),
    coreData: z
      .object({
        physicalAddress: physicalAddressSchema.nullish(),
        entityInformation: z
          .object({
            entityURL: optionalString,
          })
          .passthrough()
          .nullish(),
        generalInformation: z.record(z.string(), z.unknown()).nullish(),
      })
      .passthrough()
      .nullish(),
    assertions: z
      .object({
        goodsAndServices: goodsAndServicesSchema.nullish(),
        entityTypes: z.record(z.string(), z.unknown()).nullish(),
        businessTypes: z.record(z.string(), z.unknown()).nullish(),
        ownershipAndControl: z.record(z.string(), z.unknown()).nullish(),
      })
      .passthrough()
      .nullish(),
    relationships: z.record(z.string(), z.unknown()).nullish(),
  })
  .passthrough();

export const samEntityResponseSchema = z
  .object({
    totalRecords: z.number().int().nonnegative(),
    entityData: z.array(samEntityRecordSchema),
  })
  .passthrough();

export interface SamNaicsClassification {
  readonly code: string;
  readonly description: string | null;
  readonly sbaSmallBusiness: boolean | null;
}

export interface SamPscClassification {
  readonly code: string;
  readonly description: string | null;
}

export interface SamEntity {
  readonly legalName: string;
  readonly uei: string;
  readonly cageCode: string | null;
  readonly officialUrl: string | null;
  readonly officialDomain: string | null;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly zip: string | null;
  readonly country: string | null;
  readonly registrationStatus: string | null;
  readonly exclusionStatusFlag: boolean | null;
  readonly primaryNaics: SamNaicsClassification | null;
  readonly naics: readonly SamNaicsClassification[];
  readonly psc: readonly SamPscClassification[];
  readonly entityTypeHints: readonly string[];
  readonly businessTypeHints: readonly string[];
  readonly ownershipHints: readonly string[];
  readonly parentUei: string | null;
  readonly matchedNaicsCodes: readonly string[];
  readonly sourceLocator: string;
  readonly raw: Record<string, unknown>;
}

export interface SamSearchQuery {
  /** Exact six-digit NAICS codes only. */
  readonly naicsCodes: readonly string[];
  /** Two-letter physical-address state filter. */
  readonly state?: string;
  readonly maxResults?: number;
  readonly signal?: AbortSignal;
}

export interface SamClientOptions {
  readonly apiKey?: string;
  readonly maxPages?: number;
  readonly pageSize?: number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface SamSearchResult {
  readonly totalRecords: number;
  readonly entities: readonly SamEntity[];
}

type SamEntityRecord = z.output<typeof samEntityRecordSchema>;

export function samEntitySourceLocator(
  uei: string,
  matchedNaicsCodes: readonly string[] = [],
): string {
  const base = `sam://entity-information/v4/entities/${encodeURIComponent(uei)}`;
  if (matchedNaicsCodes.length === 0) return base;
  const params = new URLSearchParams({
    naics: [...new Set(matchedNaicsCodes)].sort().join(","),
  });
  return `${base}?${params.toString()}`;
}

export function isSamEntityActive(entity: SamEntity): boolean {
  const status = entity.registrationStatus?.trim().toUpperCase();
  return status === "A" || status === "ACTIVE";
}

export function isSamEntityUnitedStates(entity: SamEntity): boolean {
  const country = entity.country?.trim().toUpperCase();
  return country === "USA" || country === "US" || country === "UNITED STATES";
}

export function isSamEntityExcluded(entity: SamEntity): boolean {
  if (entity.exclusionStatusFlag === true) return true;
  const status = entity.registrationStatus?.toLowerCase() ?? "";
  return status.includes("debar") || status.includes("exclud");
}

export function normalizeSamEntity(
  record: SamEntityRecord,
  matchedNaicsCodes: readonly string[] = [],
): SamEntity {
  const registration = record.entityRegistration;
  const address = record.coreData?.physicalAddress;
  const goods = record.assertions?.goodsAndServices;
  const naics: SamNaicsClassification[] = [];
  for (const item of goods?.naicsList ?? []) {
    const normalized = normalizeNaics(item);
    if (normalized !== null) naics.push(normalized);
  }
  const dedupedNaics = dedupeNaics(naics);
  const primaryNaics = normalizePrimaryNaics(
    goods?.primaryNaics,
    dedupedNaics,
  );
  const psc: SamPscClassification[] = [];
  for (const item of goods?.pscList ?? []) {
    const normalized = normalizePsc(item);
    if (normalized !== null) psc.push(normalized);
  }
  const official = normalizeOfficialUrl(record.coreData?.entityInformation?.entityURL);

  return {
    legalName: registration.legalBusinessName,
    uei: registration.ueiSAM,
    cageCode: valueOrNull(registration.cageCode),
    officialUrl: official?.url ?? null,
    officialDomain: official?.domain ?? null,
    addressLine1: valueOrNull(address?.addressLine1),
    addressLine2: valueOrNull(address?.addressLine2),
    city: valueOrNull(address?.city),
    state: valueOrNull(address?.stateOrProvinceCode),
    zip: joinZip(address?.zipCode, address?.zipCodePlus4),
    country: valueOrNull(address?.countryCode ?? address?.country),
    registrationStatus: valueOrNull(registration.registrationStatus),
    exclusionStatusFlag: normalizeBoolean(registration.exclusionStatusFlag),
    primaryNaics,
    naics:
      primaryNaics === null
        ? dedupedNaics
        : dedupeNaics([primaryNaics, ...dedupedNaics]),
    psc: dedupePsc(psc),
    entityTypeHints: collectHints(
      record.assertions?.entityTypes,
      record.coreData?.generalInformation,
      /entity|structure|organization/iu,
    ),
    businessTypeHints: collectHints(
      record.assertions?.businessTypes,
      record.coreData?.generalInformation,
      /business|profit|structure/iu,
    ),
    ownershipHints: collectHints(
      record.assertions?.ownershipAndControl,
      undefined,
      /ownership|owner|control|minority|veteran|woman|women|female|tribal/iu,
    ),
    parentUei: findParentUei(record),
    matchedNaicsCodes: [...new Set(matchedNaicsCodes)].sort(),
    sourceLocator: samEntitySourceLocator(
      registration.ueiSAM,
      matchedNaicsCodes,
    ),
    raw: record as Record<string, unknown>,
  };
}

export class SamEntityClient {
  readonly #apiKey: string | undefined;
  readonly #maxPages: number;
  readonly #pageSize: number;
  readonly #timeoutMs: number;
  readonly #fetchImpl: typeof fetch;

  constructor(options: SamClientOptions = {}) {
    const apiKey = options.apiKey?.trim();
    this.#apiKey =
      apiKey === undefined || apiKey.length === 0 || /[\r\n]/u.test(apiKey)
        ? undefined
        : apiKey;
    this.#maxPages = boundedInteger(options.maxPages, DEFAULT_MAX_PAGES, SAM_ENTITY_MAX_PAGES);
    this.#pageSize = boundedInteger(
      options.pageSize,
      DEFAULT_PAGE_SIZE,
      SAM_ENTITY_PAGE_SIZE_MAX,
    );
    this.#timeoutMs = options.timeoutMs ?? SAM_ENTITY_TIMEOUT_MS;
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  async search(query: SamSearchQuery): Promise<SamSearchResult> {
    const apiKey = this.#apiKey;
    if (apiKey === undefined) throw new SamApiKeyMissingError();
    const parsedQuery = parseQuery(query);
    const entitiesByUei = new Map<string, SamEntity>();
    let totalRecords = 0;

    for (const naicsCode of parsedQuery.naicsCodes) {
      if (entitiesByUei.size >= parsedQuery.maxResults) break;

      for (let page = 0; page < this.#maxPages; page += 1) {
        const result = await this.#fetchPage(
          parsedQuery,
          naicsCode,
          page,
          apiKey,
        );
        if (page === 0) totalRecords += result.totalRecords;

        for (const record of result.entityData) {
          const uei = record.entityRegistration.ueiSAM;
          const existing = entitiesByUei.get(uei);
          if (existing !== undefined) {
            const matchedNaicsCodes = [
              ...new Set([...existing.matchedNaicsCodes, naicsCode]),
            ].sort();
            entitiesByUei.set(uei, {
              ...existing,
              matchedNaicsCodes,
              sourceLocator: samEntitySourceLocator(uei, matchedNaicsCodes),
            });
            continue;
          }
          if (entitiesByUei.size >= parsedQuery.maxResults) break;
          entitiesByUei.set(uei, normalizeSamEntity(record, [naicsCode]));
        }

        const seen = (page + 1) * this.#pageSize;
        if (
          entitiesByUei.size >= parsedQuery.maxResults ||
          result.entityData.length < this.#pageSize ||
          seen >= result.totalRecords
        ) {
          break;
        }
      }
    }

    return { totalRecords, entities: [...entitiesByUei.values()] };
  }

  async #fetchPage(
    query: ParsedSamSearchQuery,
    naicsCode: string,
    page: number,
    apiKey: string,
  ): Promise<z.output<typeof samEntityResponseSchema>> {
    const params = new URLSearchParams({
      samRegistered: "Yes",
      registrationStatus: "A",
      physicalAddressCountryCode: "USA",
      naicsCode,
      page: String(page),
      size: String(this.#pageSize),
      includeSections: INCLUDED_SECTIONS,
    });
    if (query.state !== undefined) params.set("physicalAddressStateCode", query.state);

    let response: Response;
    try {
      response = await this.#fetchImpl(`${SAM_ENTITY_SEARCH_URL}?${params.toString()}`, {
        headers: { Accept: "application/json", "X-Api-Key": apiKey },
        signal: combineSignals(AbortSignal.timeout(this.#timeoutMs), query.signal),
      });
    } catch (cause) {
      throw new SourceFetchError("SAM.gov request failed", {
        transient: true,
        cause,
      });
    }

    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        await response.body?.cancel().catch(() => undefined);
      }
      const quotaResetAt = samQuotaResetAt(body);
      if (quotaResetAt !== null) {
        throw new SamQuotaExceededError(quotaResetAt, response.status);
      }
      throw new SourceFetchError(`SAM.gov returned HTTP ${response.status}`, {
        transient:
          response.status === 408 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500,
        status: response.status,
      });
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      throw new SourceFetchError("SAM.gov returned a non-JSON body", {
        transient: false,
        cause,
      });
    }
    const parsed = samEntityResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new SourceFetchError("SAM.gov response failed validation", {
        transient: false,
        cause: parsed.error,
      });
    }
    return parsed.data;
  }
}

function samQuotaResetAt(body: unknown): Date | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const error = body as Record<string, unknown>;
  const code = typeof error.code === "number" ? String(error.code) : error.code;
  const message = error.message;
  const isQuotaResponse =
    code === "900804" ||
    (typeof message === "string" && /\bthrottl(?:e|ed|ing)\b/iu.test(message));
  if (!isQuotaResponse || typeof error.nextAccessTime !== "string") return null;
  const timestamp = Date.parse(error.nextAccessTime);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

interface ParsedSamSearchQuery {
  readonly naicsCodes: readonly string[];
  readonly state?: string;
  readonly maxResults: number;
  readonly signal?: AbortSignal;
}

function parseQuery(query: SamSearchQuery): ParsedSamSearchQuery {
  const parsed = z
    .strictObject({
      naicsCodes: z.array(z.string().regex(/^\d{6}$/u)).min(1).max(25),
      state: z.string().trim().regex(/^[A-Z]{2}$/u).optional(),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(SAM_ENTITY_RESULT_MAX)
        .default(DEFAULT_MAX_RESULTS),
      signal: z.custom<AbortSignal>().optional(),
    })
    .parse(query);
  if (new Set(parsed.naicsCodes).size !== parsed.naicsCodes.length) {
    throw new RangeError("SAM NAICS codes must be unique");
  }
  return {
    naicsCodes: parsed.naicsCodes,
    maxResults: parsed.maxResults,
    ...(parsed.state === undefined ? {} : { state: parsed.state }),
    ...(parsed.signal === undefined ? {} : { signal: parsed.signal }),
  };
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.trunc(value)));
}

function combineSignals(timeout: AbortSignal, supplied: AbortSignal | undefined): AbortSignal {
  return supplied === undefined ? timeout : AbortSignal.any([timeout, supplied]);
}

function valueOrNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value.length === 0 ? null : value;
}

function joinZip(zip: string | null | undefined, plus4: string | null | undefined): string | null {
  if (!zip) return null;
  return plus4 ? `${zip}-${plus4}` : zip;
}

function normalizeBoolean(value: boolean | string | number | null | undefined): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 0 ? false : value === 1 ? true : null;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (["Y", "YES", "TRUE", "1"].includes(normalized)) return true;
  if (["N", "NO", "FALSE", "0"].includes(normalized)) return false;
  return null;
}

function normalizeNaics(
  item: z.output<typeof naicsItemSchema>,
): SamNaicsClassification | null {
  const code = item.naicsCode?.trim();
  if (!code) return null;
  return {
    code,
    description: valueOrNull(item.naicsDescription),
    sbaSmallBusiness: normalizeBoolean(item.sbaSmallBusiness),
  };
}

function normalizePrimaryNaics(
  value: z.output<typeof goodsAndServicesSchema>["primaryNaics"],
  naics: readonly SamNaicsClassification[],
): SamNaicsClassification | null {
  if (!value) return null;
  if (typeof value !== "string") return normalizeNaics(value);
  const code = value.trim();
  if (!code) return null;
  return naics.find((item) => item.code === code) ?? {
    code,
    description: null,
    sbaSmallBusiness: null,
  };
}

function normalizePsc(
  item: z.output<typeof pscItemSchema>,
): SamPscClassification | null {
  const code =
    typeof item === "string" ? item.trim() : item.pscCode?.trim();
  if (!code) return null;
  return typeof item === "string"
    ? { code, description: null }
    : {
        code,
        description: valueOrNull(item.pscDescription ?? item.pscName),
      };
}

function dedupeNaics(items: readonly SamNaicsClassification[]): SamNaicsClassification[] {
  return [...new Map(items.map((item) => [item.code, item])).values()];
}

function dedupePsc(items: readonly SamPscClassification[]): SamPscClassification[] {
  return [...new Map(items.map((item) => [item.code, item])).values()];
}

function normalizeOfficialUrl(value: string | null | undefined): { url: string; domain: string } | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
      return null;
    }
    const domain = url.hostname.toLowerCase().replace(/^www\./u, "");
    return domain.length === 0 ? null : { url: url.href, domain };
  } catch {
    return null;
  }
}

function collectHints(
  primary: unknown,
  secondary: unknown,
  relevantKey: RegExp,
): string[] {
  const hints = new Set<string>();
  const visit = (value: unknown, key = ""): void => {
    if (typeof value === "string") {
      if (relevantKey.test(key) && value.trim()) hints.add(value.trim());
      return;
    }
    if (typeof value === "boolean") {
      if (value && relevantKey.test(key)) hints.add(key);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
  };
  visit(primary);
  visit(secondary);
  return [...hints].sort();
}

function findParentUei(record: SamEntityRecord): string | null {
  const candidates = [record.relationships, record.coreData?.entityInformation];
  let found: string | null = null;
  const visit = (value: unknown, key = ""): void => {
    if (found !== null) return;
    if (typeof value === "string" && /(?:parent|immediateOwner|highestLevelOwner).*uei|uei.*(?:parent|owner)/iu.test(key)) {
      found = value;
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
  };
  for (const candidate of candidates) visit(candidate);
  return found;
}
