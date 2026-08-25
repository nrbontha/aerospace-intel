import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  auditEvents,
  candidates,
  closeDatabase,
  companyDomains,
  getDatabase,
  identityMatchCandidates,
  leads,
  type Database,
} from "@asi/database";
import { and, eq, inArray, sql } from "drizzle-orm";

export const ZITEC_WRONG_DOMAIN = "zitec.com";
export const ZITEC_CORRECT_DOMAIN = "zitecusa.com";
export const ZITEC_CORRECTION_SCRIPT_VERSION = "2026-08-24";
export const ZITEC_EVIDENCE_URLS = [
  "https://www.zitecusa.com/about.html",
  "https://www.war.gov/News/Contracts/Contract/Article/1929800/contracts-for-aug-8-2019/",
] as const;

export interface ZitecCorrectionRow {
  readonly leadId: string;
  readonly rawName: string;
  readonly companyId: string;
  readonly possibleDomain: string | null;
  readonly status: string;
  readonly context: Record<string, unknown>;
}

export async function selectWronglyResolvedZitecLeads(db: Database): Promise<ZitecCorrectionRow[]> {
  return db
    .select({
      leadId: leads.id,
      rawName: leads.rawName,
      companyId: leads.resolvedCompanyId,
      possibleDomain: leads.possibleDomain,
      status: leads.status,
      context: leads.context,
    })
    .from(leads)
    .innerJoin(companyDomains, eq(companyDomains.companyId, leads.resolvedCompanyId))
    .where(
      and(
        sql`lower(${leads.rawName}) = 'zitec, inc'`,
        sql`lower(${companyDomains.domain}) = ${ZITEC_WRONG_DOMAIN}`,
      ),
    )
    .then((rows) =>
      rows.map((row) => {
        if (row.companyId === null) throw new Error(`resolved ZITEC lead ${row.leadId} has no company`);
        return { ...row, companyId: row.companyId };
      }),
    );
}

export async function correctZitecIdentity(
  db: Database,
  options: {
    readonly apply: boolean;
    readonly at?: Date;
    /** Test-only narrowing; production CLI intentionally never supplies this. */
    readonly leadIds?: readonly string[];
  } = { apply: false },
): Promise<ZitecCorrectionRow[]> {
  const selected = (await selectWronglyResolvedZitecLeads(db)).filter(
    (lead) => options.leadIds === undefined || options.leadIds.includes(lead.leadId),
  );
  if (!options.apply || selected.length === 0) return selected;

  const at = (options.at ?? new Date()).toISOString();
  const companyIds = [...new Set(selected.map((lead) => lead.companyId))];
  await db.transaction(async (tx) => {
    for (const lead of selected) {
      await tx
        .update(leads)
        .set({
          status: "unresolved_lead",
          possibleDomain: null,
          resolvedCompanyId: null,
          context: {
            ...lead.context,
            identityCorrection: {
              reason: "identity mismatch: zitec.com",
              wrongDomain: ZITEC_WRONG_DOMAIN,
              correctDomain: ZITEC_CORRECT_DOMAIN,
              evidenceUrls: ZITEC_EVIDENCE_URLS,
              at,
              scriptVersion: ZITEC_CORRECTION_SCRIPT_VERSION,
            },
          },
        })
        .where(eq(leads.id, lead.leadId));
      await tx
        .update(identityMatchCandidates)
        .set({
          decision: "rejected_merge",
          explanation: "identity mismatch: zitec.com; correct evidence identifies ZITEC, INC at zitecusa.com",
          decidedAt: new Date(at),
        })
        .where(
          and(
            eq(identityMatchCandidates.leadId, lead.leadId),
            eq(identityMatchCandidates.companyId, lead.companyId),
          ),
        );
      await tx.insert(auditEvents).values({
        actorUserId: null,
        action: "lead.identity_corrected",
        entityType: "lead",
        entityId: lead.leadId,
        before: {
          status: lead.status,
          possibleDomain: lead.possibleDomain,
          resolvedCompanyId: lead.companyId,
        },
        after: { status: "unresolved_lead", possibleDomain: null, resolvedCompanyId: null },
        metadata: {
          reason: "identity mismatch: zitec.com",
          wrongDomain: ZITEC_WRONG_DOMAIN,
          correctDomain: ZITEC_CORRECT_DOMAIN,
          evidenceUrls: ZITEC_EVIDENCE_URLS,
          scriptVersion: ZITEC_CORRECTION_SCRIPT_VERSION,
        },
      });
    }

    for (const companyId of companyIds) {
      const companyCandidates = await tx
        .select({ id: candidates.id, rationale: candidates.rationale })
        .from(candidates)
        .where(eq(candidates.companyId, companyId));
      for (const candidate of companyCandidates) {
        const risks = Array.isArray(candidate.rationale["risks"])
          ? candidate.rationale["risks"].filter((risk): risk is string => typeof risk === "string")
          : [];
        await tx
          .update(candidates)
          .set({
            status: "rejected",
            rationale: {
              ...candidate.rationale,
              risks: [...new Set([...risks, "identity mismatch: zitec.com"])],
            },
          })
          .where(eq(candidates.id, candidate.id));
      }
    }

    await tx
      .delete(companyDomains)
      .where(
        and(
          inArray(companyDomains.companyId, companyIds),
          sql`lower(${companyDomains.domain}) = ${ZITEC_WRONG_DOMAIN}`,
        ),
      );
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

  const selected = await correctZitecIdentity(getDatabase(), { apply });
  console.log(`${apply ? "applied" : "dry-run selected"} ${selected.length} ZITEC lead(s)`);
  for (const lead of selected) {
    console.log(
      `${lead.rawName}: ${lead.status}/${lead.possibleDomain ?? "null"}/${lead.companyId} -> ` +
        `unresolved_lead/null/null`,
    );
  }
  await closeDatabase();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
