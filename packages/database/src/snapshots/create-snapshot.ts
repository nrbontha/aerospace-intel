import { and, eq, sql } from "drizzle-orm";

import type { Database } from "../client.js";
import {
  knownUniverseMembers,
  knownUniverseSnapshots,
  type KnownUniverseSnapshot,
} from "../schema.js";
import { matchMember } from "./matching.js";
import {
  memberIdentityKey,
  normalizeDomain,
  normalizeName,
  parseUsStateCode,
} from "./normalize.js";

/**
 * Snapshot creation with idempotency by key.
 *
 * - No existing snapshot for the key → create it with all members.
 * - Existing snapshot AND identical content_sha256 → skip entirely
 *   (snapshots are immutable once written).
 * - Existing snapshot with a DIFFERENT sha → hard error asking the caller
 *   to pick a new key; an existing snapshot is never mutated.
 *
 * `known_universe_members` is append-only (UPDATE/DELETE denied by trigger),
 * so domain/name normalization and company matching are computed BEFORE the
 * single INSERT pass — there is no insert-then-update anywhere.
 */
export class SnapshotKeyConflictError extends Error {
  readonly key: string;
  readonly storedSha256: string | null;
  readonly incomingSha256: string;

  constructor(
    key: string,
    storedSha256: string | null,
    incomingSha256: string,
  ) {
    super(
      `Snapshot key "${key}" already exists with a different content_sha256 ` +
        `(stored ${storedSha256 ?? "NULL"}, incoming ${incomingSha256}). ` +
        `Snapshots are immutable — import under a new key.`,
    );
    this.name = "SnapshotKeyConflictError";
    this.key = key;
    this.storedSha256 = storedSha256;
    this.incomingSha256 = incomingSha256;
  }
}

export type SnapshotAction = "create" | "skip" | "conflict";

/** Pure key/sha decision. `content_sha256` is CHAR(64): trim before compare. */
export function resolveSnapshotAction(
  existing: { contentSha256: string | null } | undefined,
  incomingSha256: string,
): SnapshotAction {
  if (existing === undefined) return "create";
  const stored = (existing.contentSha256 ?? "").trim();
  return stored === incomingSha256.trim() ? "skip" : "conflict";
}

export interface SnapshotMemberInput {
  rawName: string;
  rawDomain?: string | null;
  /** Verbatim row payload preserved inside the member record. */
  rawPayload?: Record<string, unknown>;
  sourceRow?: number | null;
}

export interface CreateSnapshotInput {
  key: string;
  name: string;
  sourceType: string;
  importFileName?: string | null;
  effectiveDate?: string | null;
  notes?: string | null;
  createdBy?: string | null;
  active?: boolean;
  contentSha256: string;
  members: SnapshotMemberInput[];
}

export interface MatchBreakdown {
  exact: number;
  probable: number;
  none: number;
}

export interface SnapshotImportResult {
  status: "created" | "skipped";
  snapshot: KnownUniverseSnapshot;
  memberCount: number;
  matchBreakdown: MatchBreakdown;
}

type MemberInsertValues = {
  snapshotId: string;
  companyId: string | null;
  matchedCompanyId: string | null;
  rawName: string;
  rawDomain: string | null;
  normalizedDomain: string | null;
  normalizedName: string;
  matchStatus: "exact" | "probable" | "none";
  /** numeric(4,3) round-trips as text through drizzle. */
  matchConfidence: string | null;
  rawPayload: Record<string, unknown>;
  sourceRow: number | null;
};

/** Build insert values for one member, computing identity + match first. */
async function buildMemberValues(
  db: Database,
  snapshotId: string,
  input: SnapshotMemberInput,
): Promise<MemberInsertValues> {
  const rawDomain =
    typeof input.rawDomain === "string" && input.rawDomain.trim() !== ""
      ? input.rawDomain.trim()
      : null;
  const normalizedDomain =
    rawDomain === null ? null : normalizeDomain(rawDomain);
  const normalizedName = normalizeName(input.rawName);
  const stateCode = parseStateFromPayload(input);
  const match = await matchMember(db, {
    rawName: input.rawName,
    normalizedDomain,
    stateCode,
  });
  return {
    snapshotId,
    companyId: match.companyId,
    matchedCompanyId: match.matchedCompanyId,
    rawName: input.rawName,
    rawDomain,
    normalizedDomain,
    normalizedName,
    matchStatus: match.matchStatus,
    matchConfidence:
      match.matchConfidence === null
        ? null
        : match.matchConfidence.toFixed(3),
    rawPayload: input.rawPayload ?? {},
    sourceRow: input.sourceRow ?? null,
  };
}
function parseStateFromPayload(input: SnapshotMemberInput): string | null {
  const payload = input.rawPayload;
  if (payload === undefined) return null;
  for (const [key, value] of Object.entries(payload)) {
    const lower = key.trim().toLowerCase();
    if (
      (lower === "hq" || lower === "headquarters") &&
      typeof value === "string"
    ) {
      return parseUsStateCode(value);
    }
  }
  return null;
}

type BreakdownRow = {
  exact: number;
  probable: number;
  none: number;
};

async function loadBreakdown(
  db: Database,
  snapshotId: string,
): Promise<{ breakdown: MatchBreakdown; memberCount: number }> {
  const result = await db.execute<BreakdownRow & { total: number }>(sql`
    SELECT
      count(*) FILTER (WHERE match_status = 'exact')::int   AS exact,
      count(*) FILTER (WHERE match_status = 'probable')::int AS probable,
      count(*) FILTER (WHERE match_status = 'none')::int     AS none,
      count(*)::int AS total
    FROM known_universe_members
    WHERE snapshot_id = ${snapshotId}
  `);
  const row = result.rows[0];
  const breakdown: MatchBreakdown = {
    exact: row?.exact ?? 0,
    probable: row?.probable ?? 0,
    none: row?.none ?? 0,
  };
  return { breakdown, memberCount: row?.total ?? 0 };
}

export async function createKnownUniverseSnapshot(
  db: Database,
  input: CreateSnapshotInput,
): Promise<SnapshotImportResult> {
  const incomingSha = input.contentSha256.trim();
  const existingRows = await db
    .select({ contentSha256: knownUniverseSnapshots.contentSha256 })
    .from(knownUniverseSnapshots)
    .where(eq(knownUniverseSnapshots.key, input.key))
    .limit(1);

  const action = resolveSnapshotAction(existingRows[0], incomingSha);
  if (action === "conflict") {
    throw new SnapshotKeyConflictError(
      input.key,
      existingRows[0]?.contentSha256 ?? null,
      incomingSha,
    );
  }

  const existingSnapshot = await db
    .select()
    .from(knownUniverseSnapshots)
    .where(eq(knownUniverseSnapshots.key, input.key))
    .limit(1);

  if (action === "skip" && existingSnapshot[0] !== undefined) {
    const { breakdown, memberCount } = await loadBreakdown(
      db,
      existingSnapshot[0].id,
    );
    return {
      status: "skipped",
      snapshot: existingSnapshot[0],
      memberCount,
      matchBreakdown: breakdown,
    };
  }

  const inserted = await db.transaction(async (tx) => {
    const [snapshot] = await tx
      .insert(knownUniverseSnapshots)
      .values({
        key: input.key,
        name: input.name,
        sourceType: input.sourceType,
        importFileName: input.importFileName ?? null,
        contentSha256: incomingSha,
        effectiveDate: input.effectiveDate ?? null,
        notes: input.notes ?? null,
        active: input.active ?? true,
        rowCount: 0,
        createdBy: input.createdBy ?? null,
      })
      .returning();
    if (snapshot === undefined) throw new Error("Snapshot insert failed");

    let memberCount = 0;
    const breakdown: MatchBreakdown = { exact: 0, probable: 0, none: 0 };
    const seenIdentities = new Set<string>();

    for (const member of input.members) {
      const values = await buildMemberValues(tx, snapshot.id, member);
      const identity = memberIdentityKey(
        values.normalizedDomain,
        values.normalizedName,
      );
      // Within-file duplicate identities would violate the partial unique
      // indexes and the append-only contract — keep first occurrence only.
      if (seenIdentities.has(identity)) continue;
      seenIdentities.add(identity);
      await tx.insert(knownUniverseMembers).values(values);
      memberCount += 1;
      breakdown[values.matchStatus] += 1;
    }

    await tx
      .update(knownUniverseSnapshots)
      .set({ rowCount: memberCount })
      .where(eq(knownUniverseSnapshots.id, snapshot.id));

    return { snapshot, memberCount, breakdown };
  });

  return {
    status: "created",
    snapshot: inserted.snapshot,
    memberCount: inserted.memberCount,
    matchBreakdown: inserted.breakdown,
  };
}

/** Members of one snapshot, paginated, with optional filters. */
export async function listSnapshotMembers(
  db: Database,
  options: {
    snapshotId: string;
    page: number;
    pageSize: number;
    matchStatus?: "exact" | "probable" | "possible" | "none" | "unresolved";
    query?: string;
  },
): Promise<{ records: unknown[]; total: number }> {
  const conditions = [
    eq(knownUniverseMembers.snapshotId, options.snapshotId),
  ];
  if (options.matchStatus !== undefined) {
    conditions.push(eq(knownUniverseMembers.matchStatus, options.matchStatus));
  }
  if (options.query !== undefined) {
    const pattern = `%${options.query.toLowerCase()}%`;
    conditions.push(
      sql`(lower(${knownUniverseMembers.rawName}) LIKE ${pattern}
        OR lower(coalesce(${knownUniverseMembers.normalizedName}, '')) LIKE ${pattern}
        OR lower(coalesce(${knownUniverseMembers.normalizedDomain}, '')) LIKE ${pattern})`,
    );
  }
  const where = and(...conditions);
  const countRows = (
    await db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count
      FROM known_universe_members
      WHERE ${where}
    `)
  ).rows;
  const total = countRows[0]?.count ?? 0;
  const offset = (options.page - 1) * options.pageSize;
  const records = await db
    .select()
    .from(knownUniverseMembers)
    .where(where)
    .orderBy(knownUniverseMembers.sourceRow, knownUniverseMembers.createdAt)
    .limit(options.pageSize)
    .offset(offset);
  return { records, total };
}
