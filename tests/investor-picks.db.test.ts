import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { closeDatabase, getDatabase } from "../packages/database/src/client.js";
import {
  createInvestorPick,
  importInvestorReferenceSet,
  listInvestorPicks,
  updateInvestorPick,
} from "../packages/database/src/investor-picks.js";
import { runMigrations } from "../packages/database/src/migrate.js";
import {
  auditEvents,
  companies,
  companyDomains,
  faaEnsembleEvaluations,
  investorPickOrigins,
  investorPicks,
  knownUniverseMembers,
  knownUniverseSnapshots,
  researchProviderBudgetScopeSignals,
  researchProviderBudgetScopes,
  signalReviewState,
  sourceSignals,
} from "../packages/database/src/schema.js";

const DB_TESTS_ENABLED =
  process.env.ASI_DB_TESTS === "1" &&
  process.env.ASI_TEST_DATABASE_ADMIN_URL !== undefined;
const SAFE_SCRATCH_DATABASE = /^asi_investor_picks_[0-9a-f]{32}$/u;
const EXPECTED_REVIEW_CONTRACT = {
  version: "investor-picks-test-v1",
  policy: {
    ladder: "investor-picks-ladder-v1",
    analyst: "investor-picks-analyst-v1",
    jevModel: "investor-picks-jev",
    museModel: "investor-picks-muse",
    evaluatorPrompt: "investor-picks-evaluator",
  },
} as const;
const SYSTEM_ACTOR = { kind: "system", label: "investor-picks-native-test" } as const;

function nativeDatabaseUrls(
  adminDatabaseUrl: string,
  scratchDatabase: string,
): { adminDatabaseUrl: string; scratchDatabaseUrl: string } {
  const adminUrl = new URL(adminDatabaseUrl);
  if (adminUrl.protocol !== "postgres:" && adminUrl.protocol !== "postgresql:") {
    throw new Error("ASI_TEST_DATABASE_ADMIN_URL must be a PostgreSQL URL");
  }
  const hostname = adminUrl.hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname)) {
    throw new Error("ASI_TEST_DATABASE_ADMIN_URL must use a loopback host");
  }
  if (!SAFE_SCRATCH_DATABASE.test(scratchDatabase)) {
    throw new Error(`refusing unsafe scratch database name: ${scratchDatabase}`);
  }
  const scratchUrl = new URL(adminUrl);
  scratchUrl.pathname = `/${scratchDatabase}`;
  return {
    adminDatabaseUrl: adminUrl.toString(),
    scratchDatabaseUrl: scratchUrl.toString(),
  };
}

function quoteScratchDatabase(scratchDatabase: string): string {
  if (!SAFE_SCRATCH_DATABASE.test(scratchDatabase)) {
    throw new Error(`refusing unsafe scratch database name: ${scratchDatabase}`);
  }
  return `"${scratchDatabase}"`;
}

async function createScratchDatabase(
  adminDatabaseUrl: string,
  scratchDatabase: string,
): Promise<string> {
  const urls = nativeDatabaseUrls(adminDatabaseUrl, scratchDatabase);
  const admin = new Pool({ connectionString: urls.adminDatabaseUrl });
  try {
    await admin.query(`CREATE DATABASE ${quoteScratchDatabase(scratchDatabase)}`);
  } finally {
    await admin.end();
  }
  return urls.scratchDatabaseUrl;
}

async function dropScratchDatabase(
  adminDatabaseUrl: string,
  scratchDatabase: string,
): Promise<void> {
  const urls = nativeDatabaseUrls(adminDatabaseUrl, scratchDatabase);
  const admin = new Pool({ connectionString: urls.adminDatabaseUrl });
  try {
    await admin.query(
      `DROP DATABASE IF EXISTS ${quoteScratchDatabase(scratchDatabase)} WITH (FORCE)`,
    );
  } finally {
    await admin.end();
  }
}

/**
 * Coordinate separate service transactions on an observed PostgreSQL advisory
 * wait, rather than hoping a Promise.all race reaches the contested snapshot.
 */
async function waitForAdvisoryWaiters(pool: Pool, minimum: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
    );
    if ((result.rows[0]?.count ?? 0) >= minimum) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`expected ${minimum} blocked advisory transaction(s)`);
}

async function createVerifiedSignal(input: {
  rawName: string;
  domain: string;
  marker: string;
  companyId?: string;
  existingSignalId?: string;
  identityStatus?: "verified" | "ambiguous" | "not_found";
  identitySupported?: boolean;
  verifiedDomain?: string | null;
  ownershipStatus?: "unknown" | "pe_owned";
  ownershipSupported?: boolean;
  acquisitionReadiness?: "ready" | "needs_research" | "blocked";
}): Promise<string> {
  const db = getDatabase();
  const signalId = input.existingSignalId ?? randomUUID();
  const inputHash = randomUUID().replaceAll("-", "").repeat(2);
  const evidence = {
    signalId,
    name: input.rawName,
    reportedDomain: input.domain,
    domain: input.verifiedDomain ?? input.domain,
    identityStatus: input.identityStatus ?? "verified",
    headquarters: { status: "unknown", city: null, state: null, country: null },
    ownershipStatus: input.ownershipStatus ?? "unknown",
    revenueAssessment: "unknown",
    namedProductProofs: [],
    sourcedSupport: {
      identity: input.identitySupported ?? true,
      product: false,
      ownership: input.ownershipSupported ?? false,
      size: false,
      headquarters: false,
    },
  };
  const inputManifest = {
    ...EXPECTED_REVIEW_CONTRACT,
    sourceRevision: 0,
    evidence,
  };
  if (input.existingSignalId === undefined) {
    await db.insert(sourceSignals).values({
      id: signalId,
      sourceKey: "native_investor_fixture",
      sourceLocator: `fixture:${input.marker}:${signalId}`,
      sourceFingerprint: `fixture:${input.marker}:${signalId}`,
      rawName: input.rawName,
      rawDomain: input.domain,
      ...(input.companyId === undefined ? {} : { companyId: input.companyId }),
      sourcePayload: { marker: input.marker },
    });
  }
  const [evaluation] = await db
    .insert(faaEnsembleEvaluations)
    .values({
      signalId,
      modelId: EXPECTED_REVIEW_CONTRACT.policy.jevModel,
      inputHash,
      inputManifest,
      parsed: {
        version: "jev-triage-v1",
        decision: "research",
        confidence: null,
        productFit: "unknown",
        acquisitionReadiness: input.acquisitionReadiness ?? "needs_research",
        researchPriority: 2,
        reasonCodes: [],
        explanation: "native investor fixture",
        observations: [],
        gaps: [],
      },
      decision: "research",
    })
    .returning({ id: faaEnsembleEvaluations.id });
  if (evaluation === undefined) throw new Error("current Jev evaluation was not created");
  await db.insert(signalReviewState).values({
    signalId,
    sourceRevision: 0,
    phase: "muse",
    inputHash,
    inputManifest,
    jevEvaluationId: evaluation.id,
  });
  return signalId;
}

async function createReferenceSnapshots(): Promise<{
  goldenId: string;
  booieId: string;
}> {
  const db = getDatabase();
  const [golden] = await db
    .insert(knownUniverseSnapshots)
    .values({
      key: "golden-set-v01",
      name: "Golden fixture",
      sourceType: "external_export",
    })
    .returning({ id: knownUniverseSnapshots.id });
  const [booie] = await db
    .insert(knownUniverseSnapshots)
    .values({
      key: "booie-original29-2026-09-09",
      name: "Booie fixture",
      sourceType: "external_export",
    })
    .returning({ id: knownUniverseSnapshots.id });
  if (golden === undefined || booie === undefined) {
    throw new Error("reference snapshots were not created");
  }
  return { goldenId: golden.id, booieId: booie.id };
}

async function addReferenceMember(input: {
  snapshotId: string;
  rawName: string;
  domain: string | null;
  sourceRow: number;
}): Promise<string> {
  const [member] = await getDatabase()
    .insert(knownUniverseMembers)
    .values({
      snapshotId: input.snapshotId,
      rawName: input.rawName,
      rawDomain: input.domain,
      normalizedName: input.rawName.toLocaleLowerCase("en-US"),
      normalizedDomain: input.domain,
      sourceRow: input.sourceRow,
    })
    .returning({ id: knownUniverseMembers.id });
  if (member === undefined) throw new Error("reference member was not created");
  return member.id;
}

describe.skipIf(!DB_TESTS_ENABLED)(
  "investor picks overlay (isolated PostgreSQL)",
  () => {
    const adminDatabaseUrl = process.env.ASI_TEST_DATABASE_ADMIN_URL!;
    const scratchDatabase = `asi_investor_picks_${randomUUID().replaceAll("-", "")}`;
    let originalDatabaseUrl: string | undefined;
    let hadOriginalDatabaseUrl = false;

    beforeAll(async () => {
      hadOriginalDatabaseUrl = Object.prototype.hasOwnProperty.call(
        process.env,
        "DATABASE_URL",
      );
      originalDatabaseUrl = process.env.DATABASE_URL;
      await closeDatabase();
      process.env.DATABASE_URL = await createScratchDatabase(
        adminDatabaseUrl,
        scratchDatabase,
      );
      await runMigrations();
    }, 120_000);

    beforeEach(async () => {
      await getDatabase().execute(sql`
        TRUNCATE TABLE
          audit_events,
          research_provider_budget_scope_signals,
          research_provider_budget_scopes,
          faa_ensemble_evaluations,
          signal_review_state,
          source_signals,
          company_domains,
          companies,
          known_universe_members,
          known_universe_snapshots
        CASCADE
      `);
    });

    afterAll(async () => {
      await closeDatabase();
      await dropScratchDatabase(adminDatabaseUrl, scratchDatabase);
      if (hadOriginalDatabaseUrl) {
        process.env.DATABASE_URL = originalDatabaseUrl;
      } else {
        delete process.env.DATABASE_URL;
      }
    }, 120_000);

    it("imports both historical snapshots as one Golden collection and is idempotent", async () => {
      const snapshots = await createReferenceSnapshots();
      const overlapSignal = await createVerifiedSignal({
        rawName: "Overlap Aerospace",
        domain: "overlap.example",
        marker: "overlap",
      });
      const goldenOverlap = await addReferenceMember({
        snapshotId: snapshots.goldenId,
        rawName: "Overlap Aerospace",
        domain: "overlap.example",
        sourceRow: 1,
      });
      await addReferenceMember({
        snapshotId: snapshots.goldenId,
        rawName: "Golden Candidate",
        domain: "golden-candidate.example",
        sourceRow: 2,
      });
      const booieOverlap = await addReferenceMember({
        snapshotId: snapshots.booieId,
        rawName: "Overlap Aerospace",
        domain: "overlap.example",
        sourceRow: 5,
      });

      await expect(
        importInvestorReferenceSet(getDatabase(), {
          set: "golden",
          actor: SYSTEM_ACTOR,
          expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
        }),
      ).resolves.toEqual({
        set: "golden",
        memberCount: 3,
        createdPicks: 2,
        createdSignals: 1,
        alreadyImported: 0,
        inactivePreserved: 0,
      });
      await expect(
        importInvestorReferenceSet(getDatabase(), {
          set: "golden",
          actor: SYSTEM_ACTOR,
          expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
        }),
      ).resolves.toMatchObject({
        memberCount: 3,
        createdPicks: 0,
        createdSignals: 0,
        alreadyImported: 3,
      });

      const page = await listInvestorPicks(getDatabase(), {
        expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
      });
      const overlap = page.items.find((item) => item.sourceSignalId === overlapSignal);
      expect(overlap).toMatchObject({
        identityVerified: true,
        verifiedDomain: "overlap.example",
        jevCurrent: true,
      });
      expect(overlap?.origins).toEqual([
        expect.objectContaining({ kind: "golden", memberId: goldenOverlap, sourceRow: 1 }),
        expect.objectContaining({ kind: "booie", memberId: booieOverlap, sourceRow: 5 }),
      ]);
      expect(page.referenceSets).toEqual([
        expect.objectContaining({
          key: "golden",
          snapshotKeys: ["golden-set-v01", "booie-original29-2026-09-09"],
          memberCount: 3,
          importedMemberCount: 3,
        }),
      ]);
      expect(
        await getDatabase()
          .select({ count: sql<number>`count(*)::int` })
          .from(sourceSignals),
      ).toEqual([{ count: 2 }]);
    });

    it.each(["missing", "inactive"] as const)(
      "does not partially import when a source snapshot is %s",
      async (state) => {
        const snapshots = await createReferenceSnapshots();
        await addReferenceMember({
          snapshotId: snapshots.goldenId,
          rawName: "Unavailable Source Aerospace",
          domain: "unavailable-source.example",
          sourceRow: 1,
        });
        if (state === "missing") {
          await getDatabase()
            .delete(knownUniverseSnapshots)
            .where(eq(knownUniverseSnapshots.id, snapshots.booieId));
        } else {
          await getDatabase()
            .update(knownUniverseSnapshots)
            .set({ active: false })
            .where(eq(knownUniverseSnapshots.id, snapshots.booieId));
        }

        await expect(
          importInvestorReferenceSet(getDatabase(), {
            set: "golden",
            actor: SYSTEM_ACTOR,
            expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
          }),
        ).rejects.toMatchObject({ code: "reference_unavailable" });
        const writes = await Promise.all([
          getDatabase().select({ count: sql<number>`count(*)::int` }).from(sourceSignals),
          getDatabase().select({ count: sql<number>`count(*)::int` }).from(investorPicks),
          getDatabase()
            .select({ count: sql<number>`count(*)::int` })
            .from(investorPickOrigins),
          getDatabase().select({ count: sql<number>`count(*)::int` }).from(auditEvents),
        ]);
        expect(writes).toEqual([
          [{ count: 0 }],
          [{ count: 0 }],
          [{ count: 0 }],
          [{ count: 0 }],
        ]);
      },
    );

    it.each([
      {
        label: "source-backed ownership overrides a ready model label",
        supported: true,
        modelReadiness: "ready",
        expectedReadiness: "blocked",
        expectedScore: 0,
      },
      {
        label: "an unsupported model rejection does not become an exclusion",
        supported: false,
        modelReadiness: "blocked",
        expectedReadiness: "needs_research",
        expectedScore: 10,
      },
    ] as const)("$label", async (fixture) => {
      const signalId = await createVerifiedSignal({
        rawName: "Readiness Conflict Aerospace",
        domain: "readiness-conflict.example",
        marker: "readiness-conflict",
        ownershipStatus: "pe_owned",
        ownershipSupported: fixture.supported,
        acquisitionReadiness: fixture.modelReadiness,
      });
      const pick = await createInvestorPick(getDatabase(), {
        input: { mode: "existing", sourceSignalId: signalId },
        actor: SYSTEM_ACTOR,
        expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
      });
      expect(pick).toMatchObject({
        readiness: fixture.expectedReadiness,
        researchScore: fixture.expectedScore,
        jevCurrent: true,
      });
    });

    it("creates unverified candidates for ambiguous and conflicting identities without mutating sources", async () => {
      const snapshots = await createReferenceSnapshots();
      const sharedCompanyId = randomUUID();
      await getDatabase().insert(companies).values({
        id: sharedCompanyId,
        legalName: "Ambiguous Electronics",
        displayName: "Ambiguous Electronics",
      });
      await getDatabase().insert(companyDomains).values({
        companyId: sharedCompanyId,
        domain: "ambiguous.example",
        verifiedAt: new Date("2040-01-01T00:00:00.000Z"),
      });
      const ambiguousLeft = await createVerifiedSignal({
        rawName: "Ambiguous Electronics",
        domain: "ambiguous.example",
        marker: "ambiguous-left",
        companyId: sharedCompanyId,
      });
      const ambiguousRight = await createVerifiedSignal({
        rawName: "Ambiguous Electronics",
        domain: "ambiguous.example",
        marker: "ambiguous-right",
        companyId: sharedCompanyId,
      });
      const legacyCompanyId = randomUUID();
      await getDatabase().insert(companies).values({
        id: legacyCompanyId,
        legalName: "Electronics Inc",
        displayName: "Electronics Inc",
      });
      await getDatabase().insert(companyDomains).values({
        companyId: legacyCompanyId,
        domain: "electronics.example",
        verifiedAt: new Date("2040-01-01T00:00:00.000Z"),
      });
      const conflicting = await createVerifiedSignal({
        rawName: "Electronics Inc",
        domain: "electronics.example",
        verifiedDomain: "infinite-electronics.example",
        marker: "conflicting-control",
        companyId: legacyCompanyId,
      });
      const stale = await createVerifiedSignal({
        rawName: "Stale Proof Aerospace",
        domain: "stale-proof.example",
        marker: "stale-current-proof",
      });
      await getDatabase()
        .update(sourceSignals)
        .set({ city: "Bend" })
        .where(eq(sourceSignals.id, stale));
      await addReferenceMember({
        snapshotId: snapshots.goldenId,
        rawName: "Ambiguous Electronics",
        domain: "ambiguous.example",
        sourceRow: 1,
      });
      await addReferenceMember({
        snapshotId: snapshots.goldenId,
        rawName: "Electronics Inc",
        domain: "electronics.example",
        sourceRow: 2,
      });
      await addReferenceMember({
        snapshotId: snapshots.goldenId,
        rawName: "Stale Proof Aerospace",
        domain: "stale-proof.example",
        sourceRow: 3,
      });
      const before = await getDatabase()
        .select({ id: sourceSignals.id, companyId: sourceSignals.companyId, payload: sourceSignals.sourcePayload })
        .from(sourceSignals)
        .where(sql`${sourceSignals.id} IN (${ambiguousLeft}::uuid, ${ambiguousRight}::uuid, ${conflicting}::uuid, ${stale}::uuid)`);

      const result = await importInvestorReferenceSet(getDatabase(), {
        set: "golden",
        actor: SYSTEM_ACTOR,
        expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
      });
      expect(result).toMatchObject({ memberCount: 3, createdPicks: 3, createdSignals: 3 });
      const after = await getDatabase()
        .select({ id: sourceSignals.id, companyId: sourceSignals.companyId, payload: sourceSignals.sourcePayload })
        .from(sourceSignals)
        .where(sql`${sourceSignals.id} IN (${ambiguousLeft}::uuid, ${ambiguousRight}::uuid, ${conflicting}::uuid, ${stale}::uuid)`);
      expect(after).toEqual(before);
      expect(
        await getDatabase()
          .select({ count: sql<number>`count(*)::int` })
          .from(sourceSignals)
          .where(eq(sourceSignals.sourceKey, "investor_pick_reference")),
      ).toEqual([{ count: 3 }]);
    });

    it("preserves archived origin and note after the source proof changes, then restores explicitly", async () => {
      const snapshots = await createReferenceSnapshots();
      const sourceSignalId = await createVerifiedSignal({
        rawName: "Archive Candidate",
        domain: "archive.example",
        marker: "archive-current-proof",
      });
      await addReferenceMember({
        snapshotId: snapshots.goldenId,
        rawName: "Archive Candidate",
        domain: "archive.example",
        sourceRow: 1,
      });
      await importInvestorReferenceSet(getDatabase(), {
        set: "golden",
        actor: SYSTEM_ACTOR,
        expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
      });
      const imported = await listInvestorPicks(getDatabase(), {
        expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
      });
      const pick = imported.items[0];
      if (pick === undefined) throw new Error("expected imported pick");
      expect(pick.sourceSignalId).toBe(sourceSignalId);
      await updateInvestorPick(getDatabase(), {
        id: pick.id,
        input: { active: false, note: "Keep this archived note" },
        actor: SYSTEM_ACTOR,
        expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
      });
      await getDatabase().execute(sql`
        UPDATE signal_review_state
        SET input_manifest = jsonb_set(
          input_manifest,
          '{evidence,identityStatus}',
          '"ambiguous"'::jsonb
        )
        WHERE signal_id = ${sourceSignalId}::uuid
      `);
      await expect(
        importInvestorReferenceSet(getDatabase(), {
          set: "golden",
          actor: SYSTEM_ACTOR,
          expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
        }),
      ).resolves.toMatchObject({ alreadyImported: 1, inactivePreserved: 1 });
      const archived = await listInvestorPicks(getDatabase(), {
        expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
        includeInactive: true,
      });
      expect(archived.items).toEqual([
        expect.objectContaining({
          id: pick.id,
          sourceSignalId,
          active: false,
          note: "Keep this archived note",
        }),
      ]);
      const restored = await createInvestorPick(getDatabase(), {
        input: { mode: "existing", sourceSignalId: pick.sourceSignalId },
        actor: SYSTEM_ACTOR,
        expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
      });
      expect(restored).toMatchObject({ active: true, note: "Keep this archived note" });
      const renamed = await createInvestorPick(getDatabase(), {
        input: {
          mode: "existing",
          sourceSignalId: pick.sourceSignalId,
          note: "Manual note replaces",
        },
        actor: SYSTEM_ACTOR,
        expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
      });
      expect(renamed).toMatchObject({ active: true, note: "Manual note replaces" });
      expect(
        await getDatabase()
          .select({ count: sql<number>`count(*)::int` })
          .from(auditEvents)
          .where(eq(auditEvents.action, "investor_pick.update")),
      ).toEqual([{ count: 1 }]);
      const cleared = await updateInvestorPick(getDatabase(), {
        id: pick.id,
        input: { note: "" },
        actor: SYSTEM_ACTOR,
        expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
      });
      expect(cleared).toMatchObject({ id: pick.id, active: true, note: null });
    });

    it("keeps repeated intake separate from both shared and scoped identity conflicts", async () => {
      const input = {
        mode: "manual",
        name: "Repeated Conflict Aerospace",
        domain: "requested.example",
      } as const;
      const request = {
        input,
        actor: SYSTEM_ACTOR,
        expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
      };
      const shared = await createInvestorPick(getDatabase(), request);
      await createVerifiedSignal({
        rawName: input.name,
        domain: input.domain,
        verifiedDomain: "first-conflict.example",
        marker: "shared-identity-conflict",
        existingSignalId: shared.sourceSignalId,
      });
      const scoped = await createInvestorPick(getDatabase(), request);
      expect(scoped.sourceSignalId).not.toBe(shared.sourceSignalId);
      await createVerifiedSignal({
        rawName: input.name,
        domain: input.domain,
        verifiedDomain: "second-conflict.example",
        marker: "scoped-identity-conflict",
        existingSignalId: scoped.sourceSignalId,
      });
      const safe = await createInvestorPick(getDatabase(), request);
      expect([shared.sourceSignalId, scoped.sourceSignalId]).not.toContain(safe.sourceSignalId);
      expect(safe).toMatchObject({ identityVerified: false, verifiedDomain: null });
      const repeated = await createInvestorPick(getDatabase(), request);
      expect(repeated.sourceSignalId).toBe(safe.sourceSignalId);
    });

    it("retries a deterministically contested same-set import and keeps one member origin", async () => {
      const snapshots = await createReferenceSnapshots();
      await createVerifiedSignal({
        rawName: "Concurrent Aerospace",
        domain: "concurrent.example",
        marker: "concurrent-current-proof",
      });
      await addReferenceMember({
        snapshotId: snapshots.goldenId,
        rawName: "Concurrent Aerospace",
        domain: "concurrent.example",
        sourceRow: 1,
      });
      const blocker = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
      const pending: Promise<unknown>[] = [];
      try {
        await blocker.query("SELECT pg_advisory_lock(hashtext($1))", [
          "investor-picks:golden",
        ]);
        const first = Promise.allSettled([importInvestorReferenceSet(getDatabase(), {
          set: "golden",
          actor: SYSTEM_ACTOR,
          expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
        })]);
        pending.push(first);
        await waitForAdvisoryWaiters(blocker, 1);
        const second = Promise.allSettled([importInvestorReferenceSet(getDatabase(), {
          set: "golden",
          actor: SYSTEM_ACTOR,
          expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
        })]);
        pending.push(second);
        await waitForAdvisoryWaiters(blocker, 2);
        await blocker.query("SELECT pg_advisory_unlock(hashtext($1))", [
          "investor-picks:golden",
        ]);
        const results = (await Promise.all([first, second])).flat().map((result) => {
          if (result.status === "rejected") throw result.reason;
          return result.value;
        });
        expect(results.reduce((sum, result) => sum + result.createdPicks, 0)).toBe(1);
        expect(results.reduce((sum, result) => sum + result.alreadyImported, 0)).toBe(1);
      } finally {
        await blocker.query("SELECT pg_advisory_unlock(hashtext($1))", [
          "investor-picks:golden",
        ]);
        await Promise.allSettled(pending);
        await blocker.end();
      }
      expect(
        await getDatabase()
          .select({ count: sql<number>`count(*)::int` })
          .from(investorPickOrigins),
      ).toEqual([{ count: 1 }]);
    });

    it("keeps one source pick when Golden import and manual provenance overlap", async () => {
      const snapshots = await createReferenceSnapshots();
      const sourceSignalId = await createVerifiedSignal({
        rawName: "Cross Set Aerospace",
        domain: "cross-set.example",
        marker: "cross-set-current-proof",
      });
      await addReferenceMember({
        snapshotId: snapshots.goldenId,
        rawName: "Cross Set Aerospace",
        domain: "cross-set.example",
        sourceRow: 1,
      });
      await addReferenceMember({
        snapshotId: snapshots.booieId,
        rawName: "Cross Set Aerospace",
        domain: "cross-set.example",
        sourceRow: 1,
      });
      await importInvestorReferenceSet(getDatabase(), {
        set: "golden",
        actor: SYSTEM_ACTOR,
        expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
      });
      const manual = await createInvestorPick(getDatabase(), {
        input: {
          mode: "manual",
          name: "Cross Set Aerospace",
          domain: "cross-set.example",
        },
        actor: SYSTEM_ACTOR,
        expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
      });
      expect(manual.sourceSignalId).toBe(sourceSignalId);
      expect(manual.origins.map((origin) => origin.kind)).toEqual([
        "manual",
        "golden",
        "booie",
      ]);
      expect(
        await getDatabase()
          .select({ count: sql<number>`count(*)::int` })
          .from(investorPicks),
      ).toEqual([{ count: 1 }]);
    });

    it("does not alter historical source, review, scoring, or budget records", async () => {
      const snapshots = await createReferenceSnapshots();
      const signalId = await createVerifiedSignal({
        rawName: "Preserved Aerospace",
        domain: "preserved.example",
        marker: "preserved",
      });
      await addReferenceMember({
        snapshotId: snapshots.goldenId,
        rawName: "Preserved Aerospace",
        domain: "preserved.example",
        sourceRow: 1,
      });
      const scopeId = `investor-picks-scope-${randomUUID()}`;
      await getDatabase().insert(researchProviderBudgetScopes).values({
        id: scopeId,
        provider: "fixture-provider",
        startsAt: new Date("2040-01-01T00:00:00.000Z"),
        totalCapUsd: "1.00",
        permitStatus: "paused",
      });
      await getDatabase().insert(researchProviderBudgetScopeSignals).values({
        budgetScopeId: scopeId,
        sourceSignalId: signalId,
      });
      const before = await Promise.all([
        getDatabase().select().from(sourceSignals).where(eq(sourceSignals.id, signalId)),
        getDatabase().select().from(signalReviewState).where(eq(signalReviewState.signalId, signalId)),
        getDatabase().select().from(faaEnsembleEvaluations).where(eq(faaEnsembleEvaluations.signalId, signalId)),
        getDatabase().select().from(researchProviderBudgetScopes).where(eq(researchProviderBudgetScopes.id, scopeId)),
        getDatabase().select().from(researchProviderBudgetScopeSignals).where(eq(researchProviderBudgetScopeSignals.budgetScopeId, scopeId)),
      ]);

      await importInvestorReferenceSet(getDatabase(), {
        set: "golden",
        actor: SYSTEM_ACTOR,
        expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
      });

      const after = await Promise.all([
        getDatabase().select().from(sourceSignals).where(eq(sourceSignals.id, signalId)),
        getDatabase().select().from(signalReviewState).where(eq(signalReviewState.signalId, signalId)),
        getDatabase().select().from(faaEnsembleEvaluations).where(eq(faaEnsembleEvaluations.signalId, signalId)),
        getDatabase().select().from(researchProviderBudgetScopes).where(eq(researchProviderBudgetScopes.id, scopeId)),
        getDatabase().select().from(researchProviderBudgetScopeSignals).where(eq(researchProviderBudgetScopeSignals.budgetScopeId, scopeId)),
      ]);
      expect(after).toEqual(before);
      expect(
        await getDatabase().select({ count: sql<number>`count(*)::int` }).from(auditEvents),
      ).toEqual([{ count: 1 }]);
      expect(
        await getDatabase().select({ count: sql<number>`count(*)::int` }).from(investorPicks),
      ).toEqual([{ count: 1 }]);
      expect(
        await getDatabase().select({ count: sql<number>`count(*)::int` }).from(investorPickOrigins),
      ).toEqual([{ count: 1 }]);
    });
  },
);
