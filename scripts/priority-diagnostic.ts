/**
 * Priority held-out diagnostic CLI (READ-ONLY — never writes anything).
 *
 *   npx tsx scripts/priority-diagnostic.ts [--snapshot preliminary-pipeline-v01]
 *
 * Loads the pipeline known-universe snapshot members whose raw_payload
 * carries the verbatim workbook `Priority` ("1" | "2" | "3"), resolves each
 * member to a scored company candidate (direct match link first, then a
 * normalized-name fallback), reads the LATEST fit score from
 * candidate_scores, and prints the Spearman rank correlation between the
 * human Priority ordering and the champion scorer's fit scores.
 *
 * Priority is an outcome of the manual pipeline: this report measures the
 * scorer against it AFTER the fact and never feeds it into scoring.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";

import { closeDatabase, getDatabase } from "@asi/database";
import {
  parsePriorityOrdinal,
  priorityDiagnostic,
  type PriorityDiagnosticEntry,
} from "@asi/research/scoring-axial";

function loadDatabaseUrl(): void {
  if (process.env.DATABASE_URL !== undefined && process.env.DATABASE_URL !== "") return;
  for (const candidate of ["data/../.env.local", ".env.local", ".env"]) {
    const filePath = path.join(process.cwd(), candidate);
    if (!existsSync(filePath)) continue;
    for (const line of readFileSync(filePath, "utf8").split("\n")) {
      const match = /^DATABASE_URL=(.*)$/.exec(line.trim());
      if (match?.[1] !== undefined) {
        process.env.DATABASE_URL = match[1].trim();
        return;
      }
    }
  }
}

interface MemberRow {
  readonly memberId: string;
  readonly rawName: string;
  readonly normalizedName: string;
  readonly companyId: string | null;
  readonly matchedCompanyId: string | null;
  readonly stage: string | null;
  readonly priorityRaw: string | null;
}

async function loadPipelineMembers(
  snapshotKey: string,
): Promise<MemberRow[]> {
  const result = await getDatabase().execute<MemberRow>(sql`
    select m.id as "memberId",
           m.raw_name as "rawName",
           coalesce(m.normalized_name, '') as "normalizedName",
           m.company_id as "companyId",
           m.matched_company_id as "matchedCompanyId",
           m.raw_payload->>'Stage' as stage,
           m.raw_payload->>'Priority' as "priorityRaw"
    from known_universe_members m
    join known_universe_snapshots s on s.id = m.snapshot_id
    where s.key = ${snapshotKey}
    order by m.raw_name
  `);
  return result.rows;
}

interface ScoreRow {
  readonly companyId: string;
  readonly fitScore: string | null;
}

/** Latest fit-axis candidate score per company (append-only history). */
async function loadLatestFitScores(
  companyIds: string[],
): Promise<Map<string, number>> {
  if (companyIds.length === 0) return new Map();
  const result = await getDatabase().execute<ScoreRow>(sql`
    select distinct on (c.company_id) c.company_id as "companyId", c.value::text as "fitScore"
    from candidate_scores c
    where c.axis = 'fit' and c.company_id in (${sql.join(
      companyIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
    order by c.company_id, c.computed_at desc
  `);
  const scores = new Map<string, number>();
  for (const row of result.rows) {
    if (row.fitScore === null) continue;
    const parsed = Number(row.fitScore);
    if (Number.isFinite(parsed)) scores.set(row.companyId, parsed);
  }
  return scores;
}

/** Fallback name resolution when no direct member→company link exists. */
async function resolveCompaniesByName(
  names: string[],
): Promise<Map<string, string>> {
  if (names.length === 0) return new Map();
  const result = await getDatabase().execute<{ id: string; displayName: string }>(sql`
    select id, display_name as "displayName"
    from companies
    where lower(display_name) in (${sql.join(
      names.map((name) => sql`${name.toLowerCase()}`),
      sql`, `,
    )})
  `);
  const byName = new Map<string, string>();
  for (const row of result.rows) {
    byName.set(row.displayName.toLowerCase(), row.id);
  }
  return byName;
}

async function main(): Promise<void> {
  const snapshotArgIndex = process.argv.indexOf("--snapshot");
  const snapshotKey =
    snapshotArgIndex >= 0
      ? (process.argv[snapshotArgIndex + 1] ?? "preliminary-pipeline-v01")
      : "preliminary-pipeline-v01";

  loadDatabaseUrl();
  const db = getDatabase();

  const members = await loadPipelineMembers(snapshotKey);
  const withPriority = members.filter(
    (member) => parsePriorityOrdinal(member.priorityRaw) !== null,
  );

  console.log(`priority-diagnostic (read-only)`);
  console.log(`snapshot: ${snapshotKey}`);
  console.log(`members total: ${members.length}`);
  console.log(
    `members carrying a parsable verbatim Priority: ${withPriority.length}`,
  );
  console.log("");

  // Resolve members to companies: explicit links first, then exact
  // normalized/display-name equality. No fuzzy guessing.
  const linkedCompanyIds = [
    ...new Set(
      withPriority
        .map((m) => m.matchedCompanyId ?? m.companyId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const unlinked = withPriority.filter(
    (m) => m.matchedCompanyId === null && m.companyId === null,
  );
  const byName = await resolveCompaniesByName(
    unlinked.map((m) => m.normalizedName),
  );

  const companyIdByMember = new Map<string, string>();
  for (const member of withPriority) {
    const linked = member.matchedCompanyId ?? member.companyId;
    if (linked !== null) {
      companyIdByMember.set(member.memberId, linked);
      continue;
    }
    const resolved = byName.get(member.normalizedName.toLowerCase());
    if (resolved !== undefined) {
      companyIdByMember.set(member.memberId, resolved);
    }
  }

  const scores = await loadLatestFitScores([...companyIdByMember.values()]);

  const entries: PriorityDiagnosticEntry[] = [];
  const unmatched: string[] = [];
  const unscored: string[] = [];
  for (const member of withPriority) {
    const companyId = companyIdByMember.get(member.memberId);
    if (companyId === undefined) {
      unmatched.push(member.rawName);
      continue;
    }
    const fitScore = scores.get(companyId);
    if (fitScore === undefined) {
      unscored.push(member.rawName);
      continue;
    }
    entries.push({
      companyId,
      priorityRaw: member.priorityRaw,
      fitScore,
      stage: member.stage,
    });
  }

  console.log(`resolved to companies: ${companyIdByMember.size}`);
  console.log(`with BOTH priority and a fit score: ${entries.length}`);
  if (unmatched.length > 0) {
    console.log(`no company match: ${unmatched.join(", ")}`);
  }
  if (unscored.length > 0) {
    console.log(`no candidate fit score yet: ${unscored.join(", ")}`);
  }
  console.log("");

  const diagnostic = priorityDiagnostic(entries);

  if (diagnostic.n < 2 || diagnostic.spearman === null) {
    console.log(
      `RESULT: n=${diagnostic.n}, spearman=null — sample too small or ` +
        `degenerate to correlate. This is the honest answer for now: the ` +
        `pipeline snapshot carries only ${withPriority.length} Priority ` +
        `value(s), and scoring coverage over them is ${diagnostic.n}.`,
    );
  } else {
    console.log(
      `RESULT: n=${diagnostic.n}, spearman=${diagnostic.spearman.toFixed(4)}`,
    );
  }
  for (const stage of diagnostic.stages ?? []) {
    console.log(
      `  stage=${stage.stage}: n=${stage.n}, spearman=${
        stage.spearman === null ? "null" : stage.spearman.toFixed(4)
      }`,
    );
  }
  console.log("");
  console.log(diagnostic.note);

  await closeDatabase();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
