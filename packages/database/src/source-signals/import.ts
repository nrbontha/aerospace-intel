import { createHash } from "node:crypto";

import type { Database } from "../client.js";
import { upsertHarvestedSourceSignal } from "./records.js";

export const SOURCE_SIGNAL_BATCH_MAX_ROWS = 100_000;

export interface SourceSignalColumnMapping {
  readonly name: string;
  readonly domain?: string;
  readonly city?: string;
  readonly state?: string;
  readonly country?: string;
  readonly uei?: string;
  readonly cage?: string;
  readonly awardCount?: string;
  readonly awardValue?: string;
  readonly freshestAward?: string;
}

export interface SourceSignalRowError {
  /** Zero-based index in the supplied rows array. */
  readonly rowIndex: number;
  readonly error: string;
}

export interface SourceSignalBatchResult {
  readonly created: number;
  readonly duplicate: number;
  readonly rejected: number;
  readonly rowErrors: readonly SourceSignalRowError[];
  readonly dryRun: boolean;
}

export interface IngestSourceSignalBatchInput {
  readonly sourceKey: string;
  readonly sourceLocator: string;
  readonly rows: readonly Record<string, unknown>[];
  readonly mapping: SourceSignalColumnMapping;
  readonly agentId?: string;
  /** Validate and report rows without calling the persistence layer. */
  readonly dryRun?: boolean;
}

/**
 * Map an imported list into quarantined source signals. This is intentionally
 * source-agnostic and never creates leads or other visible records.
 */
export async function ingestSourceSignalBatch(
  db: Database,
  input: IngestSourceSignalBatchInput,
): Promise<SourceSignalBatchResult> {
  const sourceKey = input.sourceKey.trim();
  const sourceLocator = input.sourceLocator.trim();
  if (sourceKey === "") throw new Error("sourceKey is required");
  if (sourceLocator === "") throw new Error("sourceLocator is required");
  if (input.mapping.name.trim() === "") throw new Error("mapping.name is required");
  if (input.rows.length > SOURCE_SIGNAL_BATCH_MAX_ROWS) {
    throw new Error(
      `Source signal imports are limited to ${SOURCE_SIGNAL_BATCH_MAX_ROWS.toLocaleString("en-US")} rows; received ${input.rows.length.toLocaleString("en-US")}`,
    );
  }

  const mappedKeys = new Set(
    Object.values(input.mapping).filter(
      (value): value is string => typeof value === "string" && value !== "",
    ),
  );
  const rowErrors: SourceSignalRowError[] = [];
  let created = 0;
  let duplicate = 0;
  let rejected = 0;

  for (const [rowIndex, row] of input.rows.entries()) {
    try {
      const rawName = requiredText(row[input.mapping.name], "name");
      const rawDomain = mappedText(row, input.mapping.domain, "domain");
      const city = mappedText(row, input.mapping.city, "city");
      const state = mappedText(row, input.mapping.state, "state");
      const country = mappedText(row, input.mapping.country, "country");
      const uei = mappedText(row, input.mapping.uei, "UEI");
      const cage = mappedText(row, input.mapping.cage, "CAGE");
      const awardCount = mappedNonNegativeNumber(
        row,
        input.mapping.awardCount,
        "award count",
      );
      const awardValue = mappedNonNegativeNumber(
        row,
        input.mapping.awardValue,
        "award value",
      );
      const freshestAward = mappedDate(row, input.mapping.freshestAward);
      const sourcePayload = Object.fromEntries(
        Object.entries(row).filter(([key]) => !mappedKeys.has(key)),
      );
      const rowLocator = buildRowLocator(sourceLocator, rowIndex, {
        rawName,
        ...(rawDomain === undefined ? {} : { rawDomain }),
        ...(uei === undefined ? {} : { uei }),
        ...(cage === undefined ? {} : { cage }),
      });

      if (input.dryRun === true) {
        created += 1;
        continue;
      }

      const result = await upsertHarvestedSourceSignal(db, {
        sourceKey,
        sourceLocator: rowLocator,
        ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
        rawName,
        ...(rawDomain === undefined ? {} : { rawDomain }),
        ...(uei === undefined ? {} : { uei }),
        ...(cage === undefined ? {} : { cage }),
        ...(city === undefined ? {} : { city }),
        ...(state === undefined ? {} : { state }),
        ...(country === undefined ? {} : { country }),
        awardCount,
        awardValue,
        ...(freshestAward === undefined ? {} : { freshestAward }),
        sourcePayload,
      });
      if (result.duplicate) duplicate += 1;
      else created += 1;
    } catch (error) {
      rejected += 1;
      rowErrors.push({
        rowIndex,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    created,
    duplicate,
    rejected,
    rowErrors,
    dryRun: input.dryRun === true,
  };
}

function requiredText(value: unknown, label: string): string {
  const text = optionalText(value, label);
  if (text === undefined) throw new Error(`Missing required ${label}`);
  return text;
}

function mappedText(
  row: Record<string, unknown>,
  key: string | undefined,
  label: string,
): string | undefined {
  return key === undefined ? undefined : optionalText(row[key], label);
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`${label} must be text`);
  }
  const text = String(value).trim();
  return text === "" ? undefined : text;
}

function mappedNonNegativeNumber(
  row: Record<string, unknown>,
  key: string | undefined,
  label: string,
): number {
  if (key === undefined) return 0;
  const value = row[key];
  if (value === null || value === undefined || value === "") return 0;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return parsed;
}

function mappedDate(
  row: Record<string, unknown>,
  key: string | undefined,
): string | undefined {
  if (key === undefined) return undefined;
  const value = row[key];
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value !== "string" && !(value instanceof Date)) {
    throw new Error("freshest award must be a date");
  }
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("freshest award must be a valid date");
  return parsed.toISOString();
}

function buildRowLocator(
  sourceLocator: string,
  rowIndex: number,
  identity: {
    readonly rawName: string;
    readonly rawDomain?: string;
    readonly uei?: string;
    readonly cage?: string;
  },
): string {
  const identityFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        name: identity.rawName.trim().toLocaleLowerCase("en-US"),
        domain: identity.rawDomain?.trim().toLocaleLowerCase("en-US") ?? null,
        uei: identity.uei?.trim().toLocaleUpperCase("en-US") ?? null,
        cage: identity.cage?.trim().toLocaleUpperCase("en-US") ?? null,
      }),
      "utf8",
    )
    .digest("hex");
  const separator = sourceLocator.includes("#") ? "&" : "#";
  return `${sourceLocator}${separator}row=${rowIndex}&identity=${identityFingerprint}`;
}
