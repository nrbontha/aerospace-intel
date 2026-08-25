import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  closeDatabase,
  faaPmaQualificationReference,
  getDatabase,
  type Database,
} from "../packages/database/src/index.js";
import { sql } from "drizzle-orm";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type DbLike = Database | Tx;

export interface FaaQualificationDedupeMember {
  readonly id: string;
  readonly facilityId: string;
  readonly partId: string;
  readonly qualificationReference: string;
  readonly holderNumber: string;
  readonly supplementNumber: string;
  readonly partNumber: string;
  readonly status: "draft";
  readonly createdAt: Date;
  readonly sourceLinkCount: number;
  readonly snapshot: Record<string, unknown>;
}

export interface FaaQualificationDedupePlan {
  readonly companyId: string;
  readonly stableReference: string;
  readonly survivor: FaaQualificationDedupeMember;
  readonly duplicates: readonly FaaQualificationDedupeMember[];
}

export interface FaaQualificationDedupeReport {
  readonly mode: "dry-run" | "apply";
  readonly companyId: string;
  readonly plans: readonly FaaQualificationDedupePlan[];
  readonly mergedQualificationCount: number;
  readonly repointedSourceLinkCount: number;
}

type QualificationRow = {
  id: string;
  facility_id: string;
  part_id: string;
  qualification_reference: string;
  status: "draft";
  created_at: Date;
  part_number: string;
  source_link_count: number;
  snapshot: Record<string, unknown>;
};

function normalizedIdentifier(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toUpperCase();
}

function referenceIdentity(
  qualificationReference: string,
  partNumber: string,
): {
  readonly holderNumber: string;
  readonly supplementNumber: string;
  readonly stableReference: string;
} | null {
  const segments = qualificationReference.split(":");
  if (segments[0]?.toUpperCase() !== "FAA-PMA" || segments.length < 4) {
    return null;
  }
  const holderNumber = normalizedIdentifier(segments[1] ?? "");
  const supplementNumber = normalizedIdentifier(segments[2] ?? "");
  if (holderNumber === "" || supplementNumber === "") return null;
  return {
    holderNumber,
    supplementNumber,
    stableReference: faaPmaQualificationReference({
      holderNumber: holderNumber === "NO-HOLDER" ? null : holderNumber,
      supplementNumber:
        supplementNumber === "NO-SUPPLEMENT" ? null : supplementNumber,
      pmaPartNumber: partNumber,
    }),
  };
}

export async function selectFaaQualificationDedupePlans(
  db: DbLike,
  companyId: string,
): Promise<FaaQualificationDedupePlan[]> {
  const result = await db.execute<QualificationRow>(sql`
    SELECT
      q.id,
      q.facility_id,
      q.part_id,
      q.qualification_reference,
      q.status,
      q.created_at,
      p.part_number,
      count(l.id)::int AS source_link_count,
      to_jsonb(q.*) AS snapshot
    FROM facility_qualifications q
    JOIN facilities f ON f.id = q.facility_id
    JOIN parts p ON p.id = q.part_id
    LEFT JOIN source_document_links l ON l.facility_qualification_id = q.id
    WHERE f.company_id = ${companyId}
      AND q.status = 'draft'
      AND q.qualification_reference LIKE 'FAA-PMA:%'
    GROUP BY q.id, p.part_number
    ORDER BY q.created_at, q.id
  `);

  const groups = new Map<
    string,
    {
      stableReference: string;
      members: FaaQualificationDedupeMember[];
    }
  >();
  for (const row of result.rows) {
    const identity = referenceIdentity(
      row.qualification_reference,
      row.part_number,
    );
    if (identity === null) continue;
    const key = [
      row.facility_id,
      row.part_id,
      identity.holderNumber,
      identity.supplementNumber,
      normalizedIdentifier(row.part_number),
    ].join("\u0000");
    const member: FaaQualificationDedupeMember = {
      id: row.id,
      facilityId: row.facility_id,
      partId: row.part_id,
      qualificationReference: row.qualification_reference,
      holderNumber: identity.holderNumber,
      supplementNumber: identity.supplementNumber,
      partNumber: normalizedIdentifier(row.part_number),
      status: row.status,
      createdAt: row.created_at,
      sourceLinkCount: row.source_link_count,
      snapshot: row.snapshot,
    };
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        stableReference: identity.stableReference,
        members: [member],
      });
    } else {
      group.members.push(member);
    }
  }

  const plans: FaaQualificationDedupePlan[] = [];
  for (const group of groups.values()) {
    if (group.members.length < 2) continue;
    const members = [...group.members].sort(
      (left, right) =>
        right.sourceLinkCount - left.sourceLinkCount ||
        left.createdAt.getTime() - right.createdAt.getTime() ||
        left.id.localeCompare(right.id),
    );
    plans.push({
      companyId,
      stableReference: group.stableReference,
      survivor: members[0]!,
      duplicates: members.slice(1),
    });
  }
  return plans.sort(
    (left, right) =>
      left.stableReference.localeCompare(right.stableReference) ||
      left.survivor.id.localeCompare(right.survivor.id),
  );
}

async function applyPlan(
  tx: Tx,
  plan: FaaQualificationDedupePlan,
): Promise<{ merged: number; repointed: number }> {
  let merged = 0;
  let repointed = 0;
  for (const duplicate of plan.duplicates) {
    const duplicateLinks = await tx.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count
      FROM source_document_links
      WHERE facility_qualification_id = ${duplicate.id}
    `);
    const linkCount = duplicateLinks.rows[0]?.count ?? 0;

    await tx.execute(sql`
      DELETE FROM source_document_links duplicate
      WHERE duplicate.facility_qualification_id = ${duplicate.id}
        AND EXISTS (
          SELECT 1
          FROM source_document_links survivor
          WHERE survivor.facility_qualification_id = ${plan.survivor.id}
            AND survivor.source_document_id = duplicate.source_document_id
            AND survivor.relationship = duplicate.relationship
        )
    `);
    await tx.execute(sql`
      UPDATE source_document_links
      SET facility_qualification_id = ${plan.survivor.id}
      WHERE facility_qualification_id = ${duplicate.id}
    `);
    repointed += linkCount;

    const removed = await tx.execute<{ id: string }>(sql`
      DELETE FROM facility_qualifications
      WHERE id = ${duplicate.id} AND status = 'draft'
      RETURNING id
    `);
    if (removed.rows[0] === undefined) {
      throw new Error(
        `qualification ${duplicate.id} changed or is no longer a draft; dedupe aborted`,
      );
    }
    const survivorSnapshot = await tx.execute<{
      snapshot: Record<string, unknown>;
    }>(sql`
      SELECT to_jsonb(q.*) AS snapshot
      FROM facility_qualifications q
      WHERE id = ${plan.survivor.id} AND status = 'draft'
      FOR UPDATE
    `);
    const targetBefore = survivorSnapshot.rows[0]?.snapshot;
    if (targetBefore === undefined) {
      throw new Error(
        `survivor qualification ${plan.survivor.id} is missing or no longer a draft`,
      );
    }
    const merge = await tx.execute<{ id: string }>(sql`
      INSERT INTO entity_merges (
        entity_type,
        source_entity_id,
        target_entity_id,
        reason,
        source_snapshot,
        target_snapshot_before,
        target_snapshot_after
      ) VALUES (
        'facility_qualification',
        ${duplicate.id},
        ${plan.survivor.id},
        ${`duplicate transient FAA DRS record version for ${plan.stableReference}`},
        ${JSON.stringify(duplicate.snapshot)}::jsonb,
        ${JSON.stringify(targetBefore)}::jsonb,
        ${JSON.stringify({
          ...targetBefore,
          qualification_reference: plan.stableReference,
        })}::jsonb
      )
      RETURNING id
    `);
    const mergeId = merge.rows[0]?.id;
    if (mergeId === undefined) throw new Error("qualification merge audit insert failed");
    await tx.execute(sql`
      INSERT INTO audit_events (
        action, entity_type, entity_id, before, after, metadata
      ) VALUES (
        'faa.qualification_version_deduped',
        'entity_merge',
        ${mergeId},
        ${JSON.stringify({
          duplicateQualificationId: duplicate.id,
          duplicateReference: duplicate.qualificationReference,
        })}::jsonb,
        ${JSON.stringify({
          survivorQualificationId: plan.survivor.id,
          stableReference: plan.stableReference,
        })}::jsonb,
        ${JSON.stringify({
          companyId: plan.companyId,
          facilityId: plan.survivor.facilityId,
          partId: plan.survivor.partId,
          holderNumber: plan.survivor.holderNumber,
          supplementNumber: plan.survivor.supplementNumber,
          partNumber: plan.survivor.partNumber,
          preservedSourceLinkCount: linkCount,
        })}::jsonb
      )
    `);
    merged += 1;
  }

  await tx.execute(sql`
    UPDATE facility_qualifications
    SET qualification_reference = ${plan.stableReference}, updated_at = now()
    WHERE id = ${plan.survivor.id} AND status = 'draft'
  `);
  return { merged, repointed };
}

export async function dedupeFaaQualifications(
  db: Database,
  options: { readonly companyId: string; readonly apply?: boolean },
): Promise<FaaQualificationDedupeReport> {
  const plans = await selectFaaQualificationDedupePlans(
    db,
    options.companyId,
  );
  if (options.apply !== true) {
    return {
      mode: "dry-run",
      companyId: options.companyId,
      plans,
      mergedQualificationCount: 0,
      repointedSourceLinkCount: 0,
    };
  }

  return db.transaction(async (tx) => {
    const lockKey = `faa-qualification-dedupe:${options.companyId}`;
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
    );
    const currentPlans = await selectFaaQualificationDedupePlans(
      tx,
      options.companyId,
    );
    let mergedQualificationCount = 0;
    let repointedSourceLinkCount = 0;
    for (const plan of currentPlans) {
      const applied = await applyPlan(tx, plan);
      mergedQualificationCount += applied.merged;
      repointedSourceLinkCount += applied.repointed;
    }
    return {
      mode: "apply" as const,
      companyId: options.companyId,
      plans: currentPlans,
      mergedQualificationCount,
      repointedSourceLinkCount,
    };
  });
}

function loadDatabaseUrl(): void {
  if (process.env.DATABASE_URL) return;
  for (const candidate of [
    path.join(process.cwd(), ".env.local"),
    path.join(process.cwd(), ".env"),
  ]) {
    if (!existsSync(candidate)) continue;
    const match = readFileSync(candidate, "utf8").match(/^DATABASE_URL=(.*)$/mu);
    if (match?.[1]) {
      process.env.DATABASE_URL = match[1].trim();
      return;
    }
  }
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const companyId = argumentValue("--company-id");
  if (companyId === undefined || companyId.trim() === "") {
    throw new Error("--company-id <uuid> is required");
  }
  loadDatabaseUrl();
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required (.env.local or environment)");
  }
  const report = await dedupeFaaQualifications(getDatabase(), {
    companyId,
    apply: process.argv.includes("--apply"),
  });
  console.log(
    `${report.mode}: ${report.plans.length} duplicate group(s), ` +
      `${report.mergedQualificationCount} qualification merge(s), ` +
      `${report.repointedSourceLinkCount} source link(s) preserved`,
  );
  for (const plan of report.plans) {
    console.log(
      `${plan.stableReference}: survivor ${plan.survivor.id}; duplicates ` +
        plan.duplicates.map(({ id }) => id).join(", "),
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
