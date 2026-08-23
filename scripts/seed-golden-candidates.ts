/**
 * Seed the golden set into the Targets table at High interest
 * (REDESIGN_PLAN §2.1 decision): one canonical company per golden example
 * (created with provenance "golden-set reference import" when missing),
 * linked back onto golden_examples, promoted through the packages/database
 * candidates storage with tier_override='high_interest' / tier_source='human',
 * plus a 'golden.candidate_seeded' audit event per candidate.
 *
 * Idempotent by company domain/name: matched companies are reused and
 * already-seeded (human high_interest) candidates are skipped.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/seed-golden-candidates.ts [--dry-run]
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";

import {
  getDatabase,
  seedGoldenCandidates,
  users,
} from "@asi/database";

function loadDatabaseUrl(): void {
  if (process.env.DATABASE_URL !== undefined && process.env.DATABASE_URL !== "") return;
  for (const candidate of [path.join(process.cwd(), ".env.local"), path.join(process.cwd(), ".env")]) {
    if (!existsSync(candidate)) continue;
    for (const line of readFileSync(candidate, "utf8").split("\n")) {
      const match = /^DATABASE_URL=(.*)$/.exec(line.trim());
      if (match?.[1] !== undefined) {
        process.env.DATABASE_URL = match[1].trim();
        return;
      }
    }
  }
  throw new Error("DATABASE_URL is required (env or .env.local)");
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  loadDatabaseUrl();
  const db = getDatabase();

  // setHumanTier records investment feedback whose actor column is NOT NULL;
  // the seeding acts as the first analyst user.
  const [admin] = await db.select({ id: users.id }).from(users).limit(1);
  if (admin === undefined) throw new Error("No users — seed at least one user before golden seeding");

  const summary = await seedGoldenCandidates(db, { actorId: admin.id, dryRun });

  console.log(`golden candidate seeding ${dryRun ? "(dry run)" : ""}:`);
  for (const item of summary.items) {
    console.log(
      `  ${item.name.padEnd(40)} domain=${(item.domain ?? "-").padEnd(24)} ` +
        `company=${item.companyAction} candidate=${item.candidateAction}`,
    );
  }
  console.log(
    `\nsummary: examples=${summary.totalExamples} ` +
      `companies_created=${summary.companiesCreated} companies_matched=${summary.companiesMatched} ` +
      `candidates_seeded=${summary.candidatesSeeded} skipped_existing=${summary.candidatesSkippedExisting}`,
  );

  if (!dryRun) {
    const counts = await db.execute<{ candidates: string; audit: string; feedback: string }>(sql`
      SELECT
        (SELECT count(*) FROM candidates WHERE tier_override = 'high_interest' AND tier_source = 'human') AS candidates,
        (SELECT count(*) FROM audit_events WHERE action = 'golden.candidate_seeded') AS audit,
        (SELECT count(*) FROM feedback WHERE payload->>'tierOverride' = 'high_interest') AS feedback
    `);
    const row = counts.rows[0];
    if (row !== undefined) {
      console.log(
        `db-state: human_high_interest_candidates=${row.candidates} ` +
          `golden_seed_audits=${row.audit} high_interest_feedback=${row.feedback}`,
      );
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
