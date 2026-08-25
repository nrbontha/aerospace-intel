import { createHash } from "node:crypto";

import { and, asc, eq, sql } from "drizzle-orm";

import {
  sourceSignals,
  type SourceSignal,
} from "../schema.js";
import type { Database } from "../client.js";
export interface HarvestedSourceSignal {
  readonly sourceKey: string;
  readonly sourceLocator: string;
  readonly agentId?: string;
  readonly rawName: string;
  readonly rawDomain?: string;
  readonly uei?: string;
  readonly cage?: string;
  readonly city?: string;
  readonly state?: string;
  readonly country?: string;
  readonly awardCount: number;
  readonly awardValue: number;
  readonly freshestAward?: string;
  readonly sourcePayload: Record<string, unknown>;
}

/**
 * Stable quarantine key. An issuer identifier wins; otherwise a normalized
 * legal name is paired with its award locator and award month.
 */
export function sourceSignalFingerprint(input: Pick<
  HarvestedSourceSignal,
  "sourceKey" | "sourceLocator" | "rawName" | "uei" | "cage" | "freshestAward"
>): string {
  const identifier =
    normalizedIdentifier(input.uei) ??
    normalizedIdentifier(input.cage) ??
    `name:${normalizeName(input.rawName)}`;
  const payload = [
    input.sourceKey.trim().toLowerCase(),
    identifier,
    input.sourceLocator.trim(),
    awardMonth(input.freshestAward),
  ].join("|");
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/** Insert one raw observation once; conflicting source fingerprints are duplicates. */
export async function upsertHarvestedSourceSignal(
  db: Database,
  input: HarvestedSourceSignal,
): Promise<{ readonly signal: SourceSignal | null; readonly duplicate: boolean }> {
  const sourceFingerprint = sourceSignalFingerprint(input);
  const rows = await db
    .insert(sourceSignals)
    .values({
      sourceKey: input.sourceKey,
      sourceLocator: input.sourceLocator,
      sourceFingerprint,
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      rawName: input.rawName,
      ...(input.rawDomain === undefined ? {} : { rawDomain: input.rawDomain }),
      ...(input.uei === undefined ? {} : { uei: input.uei }),
      ...(input.cage === undefined ? {} : { cage: input.cage }),
      ...(input.city === undefined ? {} : { city: input.city }),
      ...(input.state === undefined ? {} : { state: input.state }),
      ...(input.country === undefined ? {} : { country: input.country }),
      awardCount: input.awardCount,
      awardValue: String(input.awardValue),
      ...(input.freshestAward === undefined
        ? {}
        : { freshestAward: new Date(input.freshestAward) }),
      sourcePayload: input.sourcePayload,
      status: "queued_qualification",
    })
    .onConflictDoNothing({ target: sourceSignals.sourceFingerprint })
    .returning();
  return { signal: rows[0] ?? null, duplicate: rows.length === 0 };
}

/** Claim a bounded oldest-first batch; status compare prevents double workers. */
export async function claimQueuedSourceSignals(
  db: Database,
  limit: number,
): Promise<SourceSignal[]> {
  const queued = await db
    .select()
    .from(sourceSignals)
    .where(eq(sourceSignals.status, "queued_qualification"))
    .orderBy(asc(sourceSignals.createdAt))
    .limit(Math.min(Math.max(1, Math.trunc(limit)), 5));
  const claimed: SourceSignal[] = [];
  for (const signal of queued) {
    const rows = await db
      .update(sourceSignals)
      .set({ status: "qualifying", updatedAt: new Date() })
      .where(
        and(
          eq(sourceSignals.id, signal.id),
          eq(sourceSignals.status, "queued_qualification"),
        ),
      )
      .returning();
    if (rows[0] !== undefined) claimed.push(rows[0]);
  }
  return claimed;
}

export interface SourceSignalQualification {
  readonly decision: "qualified" | "rejected" | "quarantined";
  readonly reason: string;
  readonly evidence: Record<string, unknown>;
  readonly leadId?: string;
  readonly companyId?: string;
}

/** Persist a terminal qualification decision without deleting its raw signal. */
export async function recordSourceSignalQualification(
  db: Database,
  signalId: string,
  input: SourceSignalQualification,
): Promise<void> {
  const now = new Date();
  await db
    .update(sourceSignals)
    .set({
      status: input.decision,
      qualification: sql`${sourceSignals.qualification} || ${JSON.stringify({
        decision: input.decision,
        reason: input.reason,
        evidence: input.evidence,
        decidedAt: now.toISOString(),
      })}::jsonb`,
      ...(input.leadId === undefined ? {} : { leadId: input.leadId }),
      ...(input.companyId === undefined ? {} : { companyId: input.companyId }),
      ...(input.decision === "qualified" ? { qualifiedAt: now } : {}),
      ...(input.decision === "rejected" ? { rejectedAt: now } : {}),
      updatedAt: now,
    })
    .where(eq(sourceSignals.id, signalId));
}

function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/\s+/gu, " ");
}

function normalizedIdentifier(value: string | undefined): string | null {
  const normalized = value?.trim().toLocaleUpperCase("en-US");
  return normalized === undefined || normalized === "" ? null : normalized;
}

function awardMonth(value: string | undefined): string {
  if (value === undefined) return "unknown-month";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown-month";
  return date.toISOString().slice(0, 7);
}
