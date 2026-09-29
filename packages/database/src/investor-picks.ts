import {
  investorPickCreateInputSchema,
  investorPickUpdateInputSchema,
  type InvestorPickCreateInput,
  type InvestorPickDto,
  type InvestorPickOriginDto,
  type InvestorPickUpdateInput,
  type InvestorPicksPageDto,
  type InvestorReferenceImportResultDto,
  type InvestorReferenceSet,
} from "@asi/contracts";
import { asc, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "./client.js";
import {
  listSourceSignalAnalystOverviewsInSnapshot,
  type SourceSignalAnalystOverview,
} from "./analyst-research.js";
import { normalizeDomain, normalizeLegalName } from "./provenance.js";
import {
  auditEvents,
  investorPickOrigins,
  investorPicks,
  knownUniverseMembers,
  knownUniverseSnapshots,
  sourceSignals,
} from "./schema.js";
import type { SignalReviewTransaction } from "./signal-reviews.js";
import { sourceSignalFingerprint } from "./source-signals/records.js";
import type { ExpectedFaaReviewInputContract } from "./unified-targets/records.js";

const REFERENCE_SETS = {
  golden: {
    snapshotKey: "golden-set-v01",
    label: "Golden",
  },
  booie: {
    snapshotKey: "booie-original29-2026-09-09",
    label: "Booie",
  },
} as const satisfies Record<
  InvestorReferenceSet,
  { readonly snapshotKey: string; readonly label: string }
>;

const OVERVIEW_BATCH_SIZE = 100;
const ASSOCIATION_CANDIDATE_LIMIT = 101;
const CANDIDATE_SOURCE_KEY = "investor_pick_reference";

export type InvestorPicksActor =
  | { readonly kind: "admin"; readonly userId: string }
  | { readonly kind: "system"; readonly label: string };

export class InvestorPicksError extends Error {
  constructor(
    readonly code: "not_found" | "invalid_input" | "reference_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "InvestorPicksError";
  }
}

type InvestorPickRow = typeof investorPicks.$inferSelect;
type SourceSignalRow = typeof sourceSignals.$inferSelect;
type OriginRow = typeof investorPickOrigins.$inferSelect;

function invalidInput(message: string): InvestorPicksError {
  return new InvestorPicksError("invalid_input", message);
}

function asActor(actor: InvestorPicksActor): InvestorPicksActor {
  if (
    actor !== null &&
    typeof actor === "object" &&
    actor.kind === "admin" &&
    typeof actor.userId === "string" &&
    actor.userId.trim() !== ""
  ) {
    return { kind: "admin", userId: actor.userId };
  }
  if (
    actor !== null &&
    typeof actor === "object" &&
    actor.kind === "system" &&
    typeof actor.label === "string" &&
    actor.label.trim() !== ""
  ) {
    return { kind: "system", label: actor.label.trim() };
  }
  throw invalidInput("actor must identify an admin user or named system operator");
}

function normalizedNote(note: string | undefined): string | null | undefined {
  if (note === undefined) return undefined;
  const trimmed = note.trim();
  return trimmed === "" ? null : trimmed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function currentIdentity(overview: SourceSignalAnalystOverview): {
  verified: boolean;
  domain: string | null;
} {
  if (overview.currentTriage === null || overview.review === null) {
    return { verified: false, domain: null };
  }
  const manifest = asRecord(overview.review.inputManifest);
  const evidence = asRecord(manifest?.["evidence"]);
  const sourcedSupport = asRecord(evidence?.["sourcedSupport"]);
  const evidenceDomain =
    typeof evidence?.["domain"] === "string" ? evidence["domain"] : "";
  const domain =
    evidence?.["identityStatus"] === "verified" &&
    sourcedSupport?.["identity"] === true
      ? normalizeDomain(evidenceDomain)
      : null;
  return { verified: domain !== null, domain };
}

function currentReadiness(
  overview: SourceSignalAnalystOverview,
): InvestorPickDto["readiness"] {
  if (
    overview.currentTriage === null ||
    overview.ranking.status === "unscored"
  ) {
    return "unknown";
  }
  if (overview.ranking.status === "excluded") return "blocked";
  const triage = asRecord(overview.currentTriage.parsed);
  return triage?.["acquisitionReadiness"] === "ready"
    ? "ready"
    : "needs_research";
}

function currentMuseStatus(overview: SourceSignalAnalystOverview): string | null {
  return overview.currentCaseProofCurrent && overview.currentCase !== null
    ? overview.currentCase.status
    : null;
}

function actorMetadata(actor: InvestorPicksActor): Record<string, unknown> {
  return actor.kind === "admin"
    ? { actor: { kind: "admin", userId: actor.userId } }
    : { actor: { kind: "system", label: actor.label } };
}

async function recordAudit(
  tx: SignalReviewTransaction,
  input: {
    actor: InvestorPicksActor;
    action: string;
    entityId: string | null;
    before?: unknown;
    after?: unknown;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(auditEvents).values({
    actorUserId: input.actor.kind === "admin" ? input.actor.userId : null,
    action: input.action,
    entityType: "investor_pick",
    entityId: input.entityId,
    ...(input.before === undefined ? {} : { before: input.before }),
    ...(input.after === undefined ? {} : { after: input.after }),
    metadata: {
      ...actorMetadata(input.actor),
      ...(input.metadata ?? {}),
    },
  });
}

/**
 * Repeatable-read gives score hydration a consistent proof snapshot. PostgreSQL
 * may reject a concurrent overlay write with SQLSTATE 40001; retry only that
 * normal serialization outcome, with the audit work still inside each attempt.
 */
async function withMutationTransaction<T>(
  db: Database,
  operation: (tx: SignalReviewTransaction) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db.transaction(operation, { isolationLevel: "repeatable read" });
    } catch (error) {
      const failure = asRecord(error);
      const code = failure?.["code"] ?? asRecord(failure?.["cause"])?.["code"];
      if (code !== "40001" || attempt === 2) throw error;
    }
  }
  throw new Error("unreachable investor picks transaction retry state");
}

function referenceSet(set: InvestorReferenceSet) {
  return REFERENCE_SETS[set];
}

function originDto(origin: OriginRow): InvestorPickOriginDto {
  return {
    kind: origin.kind,
    label: origin.label,
    snapshotId: origin.snapshotId,
    snapshotKey: origin.snapshotKey,
    memberId: origin.memberId,
    sourceRow: origin.sourceRow,
  };
}

function originSort(left: OriginRow, right: OriginRow): number {
  const kindOrder = { manual: 0, golden: 1, booie: 2 } as const;
  const kind = kindOrder[left.kind] - kindOrder[right.kind];
  if (kind !== 0) return kind;
  const row = (left.sourceRow ?? Number.MAX_SAFE_INTEGER) -
    (right.sourceRow ?? Number.MAX_SAFE_INTEGER);
  return row !== 0 ? row : left.id.localeCompare(right.id);
}

async function hydratePicksInSnapshot(
  tx: SignalReviewTransaction,
  input: {
    pickIds: readonly string[];
    expectedReviewInputContract: ExpectedFaaReviewInputContract;
  },
): Promise<InvestorPickDto[]> {
  if (input.pickIds.length === 0) return [];
  const picks = await tx
    .select({ pick: investorPicks, signal: sourceSignals })
    .from(investorPicks)
    .innerJoin(sourceSignals, eq(investorPicks.sourceSignalId, sourceSignals.id))
    .where(inArray(investorPicks.id, input.pickIds));
  const origins = await tx
    .select()
    .from(investorPickOrigins)
    .where(inArray(investorPickOrigins.investorPickId, input.pickIds));
  const originsByPick = new Map<string, OriginRow[]>();
  for (const origin of origins) {
    const group = originsByPick.get(origin.investorPickId) ?? [];
    group.push(origin);
    originsByPick.set(origin.investorPickId, group);
  }

  const overviewBySignal = new Map<string, SourceSignalAnalystOverview>();
  const signalIds = picks.map(({ signal }) => signal.id);
  for (let offset = 0; offset < signalIds.length; offset += OVERVIEW_BATCH_SIZE) {
    const sourceSignalIds = signalIds.slice(offset, offset + OVERVIEW_BATCH_SIZE);
    const overview = await listSourceSignalAnalystOverviewsInSnapshot(tx, {
      expectedReviewInputContract: input.expectedReviewInputContract,
      limit: sourceSignalIds.length,
      sourceSignalIds,
    });
    for (const item of overview.items) overviewBySignal.set(item.signal.id, item);
  }

  return picks.map(({ pick, signal }) => {
    const overview = overviewBySignal.get(signal.id);
    if (overview === undefined) {
      throw new Error(`investor pick source signal ${signal.id} disappeared`);
    }
    const identity = currentIdentity(overview);
    return {
      id: pick.id,
      sourceSignalId: signal.id,
      name: signal.rawName,
      domain: signal.rawDomain,
      verifiedDomain: identity.domain,
      identityVerified: identity.verified,
      note: pick.note,
      active: pick.active,
      createdAt: pick.createdAt.toISOString(),
      updatedAt: pick.updatedAt.toISOString(),
      origins: (originsByPick.get(pick.id) ?? []).sort(originSort).map(originDto),
      researchScore: overview.ranking.score,
      readiness: currentReadiness(overview),
      jevCurrent: overview.currentTriage !== null,
      museStatus: currentMuseStatus(overview),
    };
  });
}

async function loadReferenceSetsInSnapshot(
  tx: SignalReviewTransaction,
): Promise<InvestorPicksPageDto["referenceSets"]> {
  const keys = Object.values(REFERENCE_SETS).map(({ snapshotKey }) => snapshotKey);
  const snapshots = await tx
    .select()
    .from(knownUniverseSnapshots)
    .where(inArray(knownUniverseSnapshots.key, keys));
  const snapshotByKey = new Map(snapshots.map((snapshot) => [snapshot.key, snapshot]));
  const snapshotIds = snapshots.map((snapshot) => snapshot.id);
  const [memberCounts, importedOrigins] = await Promise.all([
    snapshotIds.length === 0
      ? Promise.resolve([])
      : tx
          .select({
            snapshotId: knownUniverseMembers.snapshotId,
            count: sql<number>`count(*)::int`,
          })
          .from(knownUniverseMembers)
          .where(inArray(knownUniverseMembers.snapshotId, snapshotIds))
          .groupBy(knownUniverseMembers.snapshotId),
    snapshotIds.length === 0
      ? Promise.resolve([])
      : tx
          .select({
            snapshotId: investorPickOrigins.snapshotId,
            memberId: investorPickOrigins.memberId,
          })
          .from(investorPickOrigins)
          .where(inArray(investorPickOrigins.snapshotId, snapshotIds)),
  ]);
  const memberCountBySnapshot = new Map(
    memberCounts.map((row) => [row.snapshotId, Number(row.count)]),
  );
  const importedBySnapshot = new Map<string, Set<string>>();
  for (const origin of importedOrigins) {
    if (origin.snapshotId === null || origin.memberId === null) continue;
    const members = importedBySnapshot.get(origin.snapshotId) ?? new Set<string>();
    members.add(origin.memberId);
    importedBySnapshot.set(origin.snapshotId, members);
  }

  return (Object.keys(REFERENCE_SETS) as InvestorReferenceSet[]).map((key) => {
    const config = referenceSet(key);
    const snapshot = snapshotByKey.get(config.snapshotKey);
    return {
      key,
      label: config.label,
      snapshotKey: config.snapshotKey,
      available: snapshot?.active === true,
      memberCount: snapshot === undefined ? 0 : (memberCountBySnapshot.get(snapshot.id) ?? 0),
      importedMemberCount:
        snapshot === undefined ? 0 : (importedBySnapshot.get(snapshot.id)?.size ?? 0),
    };
  });
}

export async function listInvestorPicks(
  db: Database,
  input: {
    expectedReviewInputContract: ExpectedFaaReviewInputContract;
    includeInactive?: boolean;
  },
): Promise<Omit<InvestorPicksPageDto, "canManage">> {
  if (input.expectedReviewInputContract === undefined) {
    throw invalidInput("expectedReviewInputContract is required");
  }
  return db.transaction(
    async (tx) => {
      const pickRows = await tx
        .select({ id: investorPicks.id })
        .from(investorPicks)
        .where(input.includeInactive ? undefined : eq(investorPicks.active, true))
        .orderBy(asc(investorPicks.createdAt), asc(investorPicks.id));
      const [items, referenceSets] = await Promise.all([
        hydratePicksInSnapshot(tx, {
          pickIds: pickRows.map((row) => row.id),
          expectedReviewInputContract: input.expectedReviewInputContract,
        }),
        loadReferenceSetsInSnapshot(tx),
      ]);
      items.sort((left, right) => {
        if (left.researchScore !== null && right.researchScore !== null) {
          const score = right.researchScore - left.researchScore;
          if (score !== 0) return score;
        } else if (left.researchScore !== right.researchScore) {
          return left.researchScore === null ? 1 : -1;
        }
        const name = left.name.localeCompare(right.name);
        return name !== 0 ? name : left.id.localeCompare(right.id);
      });
      return { items, total: items.length, referenceSets };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/**
 * The raw-signal identity proof is shared by association and conflict checks:
 * a candidate is safe only when the current Jev-linked evidence package proves
 * both its identity and the exact requested domain.
 */
async function findCurrentRawSignalByIdentity(
  tx: SignalReviewTransaction,
  input: {
    name: string;
    domain: string | null;
    expectedReviewInputContract: ExpectedFaaReviewInputContract;
  },
): Promise<string | null> {
  if (input.name === "" || input.domain === null) return null;
  const candidates = await tx
    .select({ id: sourceSignals.id, rawName: sourceSignals.rawName })
    .from(sourceSignals)
    .where(
      sql`lower(regexp_replace(btrim(${sourceSignals.rawName}), '\\s+', ' ', 'g')) = ${input.name}`,
    )
    .limit(ASSOCIATION_CANDIDATE_LIMIT);
  if (candidates.length >= ASSOCIATION_CANDIDATE_LIMIT) return null;
  const sourceSignalIds = candidates
    .filter((candidate) => normalizeLegalName(candidate.rawName) === input.name)
    .map((candidate) => candidate.id);
  if (sourceSignalIds.length === 0) return null;
  const overviews = await listSourceSignalAnalystOverviewsInSnapshot(tx, {
    expectedReviewInputContract: input.expectedReviewInputContract,
    limit: sourceSignalIds.length,
    sourceSignalIds,
  });
  const matching = overviews.items.filter((overview) => {
    const identity = currentIdentity(overview);
    return identity.verified && identity.domain === input.domain;
  });
  return matching.length === 1 ? matching[0]?.signal.id ?? null : null;
}

async function hasContradictoryCurrentIdentity(
  tx: SignalReviewTransaction,
  input: {
    sourceSignalId: string;
    requestedDomain: string | null;
    expectedReviewInputContract: ExpectedFaaReviewInputContract;
  },
): Promise<boolean> {
  const overviews = await listSourceSignalAnalystOverviewsInSnapshot(tx, {
    expectedReviewInputContract: input.expectedReviewInputContract,
    limit: 1,
    sourceSignalIds: [input.sourceSignalId],
  });
  const overview = overviews.items[0];
  if (overview === undefined) return false;
  const identity = currentIdentity(overview);
  return (
    identity.verified &&
    (input.requestedDomain === null || identity.domain !== input.requestedDomain)
  );
}

function candidateLocator(
  normalizedName: string,
  normalizedDomain: string | null,
  scope: string,
): string {
  return `investor-pick:${normalizedName}:${normalizedDomain ?? ""}:${scope}`;
}

async function insertCandidateSignal(
  tx: SignalReviewTransaction,
  input: {
    name: string;
    rawName: string;
    domain: string | null;
    scope: string;
  },
): Promise<{ signal: SourceSignalRow; created: boolean }> {
  const locator = candidateLocator(input.name, input.domain, input.scope);
  const sourceFingerprint = sourceSignalFingerprint({
    sourceKey: CANDIDATE_SOURCE_KEY,
    sourceLocator: locator,
    rawName: input.rawName,
  });
  const inserted = await tx
    .insert(sourceSignals)
    .values({
      sourceKey: CANDIDATE_SOURCE_KEY,
      sourceLocator: locator,
      sourceFingerprint,
      rawName: input.rawName,
      ...(input.domain === null ? {} : { rawDomain: input.domain }),
      sourcePayload: {
        kind: "investor_pick_unverified_reference",
        normalizedName: input.name,
        normalizedDomain: input.domain,
      },
      status: "queued_qualification",
    })
    .onConflictDoNothing({ target: sourceSignals.sourceFingerprint })
    .returning();
  if (inserted[0] !== undefined) return { signal: inserted[0], created: true };
  const existing = await tx
    .select()
    .from(sourceSignals)
    .where(eq(sourceSignals.sourceFingerprint, sourceFingerprint))
    .limit(1);
  if (existing[0] === undefined) {
    throw new Error("investor candidate conflict did not return a source signal");
  }
  return { signal: existing[0], created: false };
}

async function ensureUnverifiedCandidate(
  tx: SignalReviewTransaction,
  input: {
    name: string;
    rawName: string;
    domain: string | null;
    scope: string;
    expectedReviewInputContract: ExpectedFaaReviewInputContract;
  },
): Promise<{ signal: SourceSignalRow; created: boolean }> {
  let candidate = await insertCandidateSignal(tx, {
    ...input,
    scope: "shared",
  });
  let scope = input.scope;
  while (
    !candidate.created &&
    (await hasContradictoryCurrentIdentity(tx, {
      sourceSignalId: candidate.signal.id,
      requestedDomain: input.domain,
      expectedReviewInputContract: input.expectedReviewInputContract,
    }))
  ) {
    candidate = await insertCandidateSignal(tx, { ...input, scope });
    // A scoped intake can also acquire contradictory proof later. Advance
    // deterministically so repeated requests reuse the next safe observation.
    scope = `${input.scope}:${candidate.signal.id}`;
  }
  return candidate;
}

async function ensurePick(
  tx: SignalReviewTransaction,
  input: {
    sourceSignalId: string;
    restore: boolean;
    note?: string | null;
  },
): Promise<{
  pick: InvestorPickRow;
  created: boolean;
  restored: boolean;
  inactivePreserved: boolean;
}> {
  const inserted = await tx
    .insert(investorPicks)
    .values({
      sourceSignalId: input.sourceSignalId,
      ...(input.note === undefined ? {} : { note: input.note }),
    })
    .onConflictDoNothing({ target: investorPicks.sourceSignalId })
    .returning();
  if (inserted[0] !== undefined) {
    return {
      pick: inserted[0],
      created: true,
      restored: false,
      inactivePreserved: false,
    };
  }
  const existing = await tx
    .select()
    .from(investorPicks)
    .where(eq(investorPicks.sourceSignalId, input.sourceSignalId))
    .limit(1)
    .for("update");
  if (existing[0] === undefined) {
    throw new Error("investor pick conflict did not return a pick");
  }
  if (!input.restore) {
    return {
      pick: existing[0],
      created: false,
      restored: false,
      inactivePreserved: !existing[0].active,
    };
  }
  if (existing[0].active && input.note === undefined) {
    return {
      pick: existing[0],
      created: false,
      restored: false,
      inactivePreserved: false,
    };
  }
  const updated = await tx
    .update(investorPicks)
    .set({
      ...(existing[0].active ? {} : { active: true }),
      ...(input.note === undefined ? {} : { note: input.note }),
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(investorPicks.id, existing[0].id))
    .returning();
  if (updated[0] === undefined) throw new Error("investor pick update did not persist");
  return {
    pick: updated[0],
    created: false,
    restored: !existing[0].active,
    inactivePreserved: false,
  };
}

async function ensureManualOrigin(
  tx: SignalReviewTransaction,
  pickId: string,
): Promise<void> {
  await tx
    .insert(investorPickOrigins)
    .values({ investorPickId: pickId, kind: "manual", label: "Manual" })
    .onConflictDoNothing();
}

export async function createInvestorPick(
  db: Database,
  input: {
    input: InvestorPickCreateInput;
    actor: InvestorPicksActor;
    expectedReviewInputContract: ExpectedFaaReviewInputContract;
  },
): Promise<InvestorPickDto> {
  const parsed = investorPickCreateInputSchema.safeParse(input.input);
  if (!parsed.success) throw invalidInput("invalid investor pick input");
  if (input.expectedReviewInputContract === undefined) {
    throw invalidInput("expectedReviewInputContract is required");
  }
  const actor = asActor(input.actor);
  return withMutationTransaction(db, async (tx) => {
    const note = normalizedNote(parsed.data.note);
    let sourceSignalId: string;
    if (parsed.data.mode === "existing") {
      const signal = await tx
        .select({ id: sourceSignals.id })
        .from(sourceSignals)
        .where(eq(sourceSignals.id, parsed.data.sourceSignalId))
        .limit(1);
      if (signal[0] === undefined) {
        throw new InvestorPicksError("not_found", "source signal does not exist");
      }
      sourceSignalId = signal[0].id;
    } else {
      const name = normalizeLegalName(parsed.data.name);
      const domain = normalizeDomain(parsed.data.domain ?? "");
      if (name === "") throw invalidInput("name must not be empty");
      if (parsed.data.domain !== undefined && domain === null) {
        throw invalidInput("domain must be a valid HTTP(S) domain");
      }
      sourceSignalId =
        (await findCurrentRawSignalByIdentity(tx, {
          name,
          domain,
          expectedReviewInputContract: input.expectedReviewInputContract,
        })) ??
        (await ensureUnverifiedCandidate(tx, {
          name,
          rawName: parsed.data.name.trim(),
          domain,
          scope: "manual",
          expectedReviewInputContract: input.expectedReviewInputContract,
        })).signal.id;
    }
    const before = await tx
      .select()
      .from(investorPicks)
      .where(eq(investorPicks.sourceSignalId, sourceSignalId))
      .limit(1);
    const result = await ensurePick(tx, {
      sourceSignalId,
      restore: true,
      ...(note === undefined ? {} : { note }),
    });
    await ensureManualOrigin(tx, result.pick.id);
    const dto = await hydratePicksInSnapshot(tx, {
      pickIds: [result.pick.id],
      expectedReviewInputContract: input.expectedReviewInputContract,
    });
    if (dto[0] === undefined) throw new Error("investor pick was not hydrated");
    await recordAudit(tx, {
      actor,
      action: result.created
        ? "investor_pick.create"
        : result.restored
          ? "investor_pick.restore"
          : "investor_pick.update",
      entityId: result.pick.id,
      ...(before[0] === undefined ? {} : { before: before[0] }),
      after: dto[0],
    });
    return dto[0];
  });
}

export async function updateInvestorPick(
  db: Database,
  input: {
    id: string;
    input: InvestorPickUpdateInput;
    actor: InvestorPicksActor;
    expectedReviewInputContract: ExpectedFaaReviewInputContract;
  },
): Promise<InvestorPickDto> {
  const parsed = investorPickUpdateInputSchema.safeParse(input.input);
  if (!parsed.success) throw invalidInput("invalid investor pick update");
  if (input.expectedReviewInputContract === undefined) {
    throw invalidInput("expectedReviewInputContract is required");
  }
  const actor = asActor(input.actor);
  return withMutationTransaction(db, async (tx) => {
    const existing = await tx
      .select()
      .from(investorPicks)
      .where(eq(investorPicks.id, input.id))
      .limit(1)
      .for("update");
    if (existing[0] === undefined) {
      throw new InvestorPicksError("not_found", "investor pick does not exist");
    }
    const updated = await tx
      .update(investorPicks)
      .set({
        ...(parsed.data.active === undefined ? {} : { active: parsed.data.active }),
        ...(parsed.data.note === undefined
          ? {}
          : { note: normalizedNote(parsed.data.note) }),
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(investorPicks.id, input.id))
      .returning();
    if (updated[0] === undefined) throw new Error("investor pick update did not persist");
    const dto = await hydratePicksInSnapshot(tx, {
      pickIds: [updated[0].id],
      expectedReviewInputContract: input.expectedReviewInputContract,
    });
    if (dto[0] === undefined) throw new Error("investor pick was not hydrated");
    await recordAudit(tx, {
      actor,
      action: parsed.data.active === false ? "investor_pick.archive" : "investor_pick.update",
      entityId: updated[0].id,
      before: existing[0],
      after: dto[0],
    });
    return dto[0];
  });
}

export async function importInvestorReferenceSet(
  db: Database,
  input: {
    set: InvestorReferenceSet;
    actor: InvestorPicksActor;
    expectedReviewInputContract: ExpectedFaaReviewInputContract;
  },
): Promise<InvestorReferenceImportResultDto> {
  if (input.set !== "golden" && input.set !== "booie") {
    throw invalidInput("unknown investor reference set");
  }
  if (input.expectedReviewInputContract === undefined) {
    throw invalidInput("expectedReviewInputContract is required");
  }
  const actor = asActor(input.actor);
  const config = referenceSet(input.set);
  return withMutationTransaction(db, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${config.snapshotKey}))`);
    const snapshots = await tx
      .select()
      .from(knownUniverseSnapshots)
      .where(eq(knownUniverseSnapshots.key, config.snapshotKey))
      .limit(1)
      .for("share");
    const snapshot = snapshots[0];
    if (snapshot === undefined || !snapshot.active) {
      throw new InvestorPicksError(
        "reference_unavailable",
        `reference snapshot ${config.snapshotKey} is unavailable`,
      );
    }
    const members = await tx
      .select()
      .from(knownUniverseMembers)
      .where(eq(knownUniverseMembers.snapshotId, snapshot.id))
      .orderBy(asc(knownUniverseMembers.sourceRow), asc(knownUniverseMembers.id));

    let createdPicks = 0;
    let createdSignals = 0;
    let alreadyImported = 0;
    let inactivePreserved = 0;
    for (const member of members) {
      const existingOrigin = await tx
        .select({ investorPickId: investorPickOrigins.investorPickId })
        .from(investorPickOrigins)
        .where(eq(investorPickOrigins.memberId, member.id))
        .limit(1);
      if (existingOrigin[0] !== undefined) {
        const existingPick = await tx
          .select({ active: investorPicks.active })
          .from(investorPicks)
          .where(eq(investorPicks.id, existingOrigin[0].investorPickId))
          .limit(1)
          .for("update");
        if (existingPick[0] === undefined) {
          throw new Error(`investor origin ${member.id} no longer has a pick`);
        }
        alreadyImported++;
        if (!existingPick[0].active) inactivePreserved++;
        continue;
      }
      const name = member.normalizedName ?? normalizeLegalName(member.rawName);
      const domain = normalizeDomain(member.normalizedDomain ?? member.rawDomain ?? "");
      const matchedSourceSignalId = await findCurrentRawSignalByIdentity(tx, {
        name,
        domain,
        expectedReviewInputContract: input.expectedReviewInputContract,
      });
      const candidate =
        matchedSourceSignalId === null
          ? await ensureUnverifiedCandidate(tx, {
              name,
              rawName: member.rawName,
              domain,
              scope: member.id,
              expectedReviewInputContract: input.expectedReviewInputContract,
            })
          : null;
      const sourceSignalId = matchedSourceSignalId ?? candidate?.signal.id;
      if (sourceSignalId === undefined) {
        throw new Error(`reference member ${member.id} was not associated to a source signal`);
      }
      if (candidate?.created === true) createdSignals++;
      const pick = await ensurePick(tx, { sourceSignalId, restore: false });
      if (pick.created) createdPicks++;
      if (pick.inactivePreserved) inactivePreserved++;
      const origin = await tx
        .insert(investorPickOrigins)
        .values({
          investorPickId: pick.pick.id,
          kind: input.set,
          label: config.label,
          snapshotId: snapshot.id,
          snapshotKey: snapshot.key,
          memberId: member.id,
          sourceRow: member.sourceRow,
        })
        .onConflictDoNothing()
        .returning({ id: investorPickOrigins.id });
      if (origin[0] === undefined) alreadyImported++;
    }
    const result = {
      set: input.set,
      memberCount: members.length,
      createdPicks,
      createdSignals,
      alreadyImported,
      inactivePreserved,
    };
    await recordAudit(tx, {
      actor,
      action: "investor_pick.import_reference_set",
      entityId: null,
      after: result,
      metadata: { snapshotKey: config.snapshotKey },
    });
    return result;
  });
}
