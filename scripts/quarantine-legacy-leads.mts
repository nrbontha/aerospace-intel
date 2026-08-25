import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { auditEvents, closeDatabase, getDatabase, leads, type Database } from "@asi/database";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

export const QUARANTINE_REASON = "legacy_unqualified_source_query";
export const QUARANTINE_SCRIPT_VERSION = "2026-08-24";

export interface LegacyLeadRow {
  readonly id: string;
  readonly rawName: string;
  readonly context: Record<string, unknown>;
}

export async function selectLegacyUnqualifiedLeads(db: Database): Promise<LegacyLeadRow[]> {
  return db
    .select({ id: leads.id, rawName: leads.rawName, context: leads.context })
    .from(leads)
    .where(
      and(
        inArray(leads.status, ["unresolved_lead", "resolving"]),
        isNull(leads.resolvedCompanyId),
        sql`NOT (${leads.context} ? 'sourceQualification')`,
      ),
    )
    .orderBy(leads.createdAt);
}

export async function quarantineLegacyUnqualifiedLeads(
  db: Database,
  options: {
    readonly apply: boolean;
    readonly at?: Date;
    /** Test-only narrowing; production CLI intentionally never supplies this. */
    readonly leadIds?: readonly string[];
  } = { apply: false },
): Promise<LegacyLeadRow[]> {
  const selected = (await selectLegacyUnqualifiedLeads(db)).filter(
    (lead) => options.leadIds === undefined || options.leadIds.includes(lead.id),
  );
  if (!options.apply || selected.length === 0) return selected;

  const at = (options.at ?? new Date()).toISOString();
  await db.transaction(async (tx) => {
    for (const lead of selected) {
      await tx
        .update(leads)
        .set({
          status: "discarded",
          context: {
            ...lead.context,
            quarantine: { reason: QUARANTINE_REASON, at, scriptVersion: QUARANTINE_SCRIPT_VERSION },
          },
        })
        .where(eq(leads.id, lead.id));
    }
    await tx.insert(auditEvents).values({
      actorUserId: null,
      action: "lead.legacy_quarantine_applied",
      entityType: "lead_quarantine",
      entityId: null,
      metadata: {
        reason: QUARANTINE_REASON,
        scriptVersion: QUARANTINE_SCRIPT_VERSION,
        at,
        selectedCount: selected.length,
        leadIds: selected.map((lead) => lead.id),
      },
    });
  });
  return selected;
}

function loadDatabaseUrl(): void {
  if (process.env.DATABASE_URL) return;
  for (const candidate of [path.join(process.cwd(), ".env.local"), path.join(process.cwd(), ".env")]) {
    if (!existsSync(candidate)) continue;
    const match = readFileSync(candidate, "utf8").match(/^DATABASE_URL=(.*)$/m);
    if (match?.[1]) {
      process.env.DATABASE_URL = match[1].trim();
      return;
    }
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  loadDatabaseUrl();
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required (.env.local or environment)");

  const selected = await quarantineLegacyUnqualifiedLeads(getDatabase(), { apply });
  const sample = selected.slice(0, 10).map((lead) => lead.rawName).join(", ") || "(none)";
  console.log(`${apply ? "applied" : "dry-run selected"} ${selected.length} legacy lead(s); sample: ${sample}`);
  await closeDatabase();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
