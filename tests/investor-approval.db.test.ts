import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { closeDatabase, getDatabase } from "../packages/database/src/client.js";
import { isSourceSignalInvestorApproved } from "../packages/database/src/investor-approval.js";
import { listSourceSignalAnalystOverviews } from "../packages/database/src/analyst-research.js";
import { runMigrations } from "../packages/database/src/migrate.js";
import {
  companies,
  faaEnsembleEvaluations,
  investorPicks,
  signalAnalystCases,
  signalReviewState,
} from "../packages/database/src/schema.js";
import {
  claimSignalReviews,
  hashSignalReviewInput,
} from "../packages/database/src/signal-reviews.js";

const DB_TESTS_ENABLED =
  process.env.ASI_DB_TESTS === "1" &&
  process.env.ASI_TEST_DATABASE_ADMIN_URL !== undefined;
const SAFE_SCRATCH_DATABASE = /^asi_investor_approval_[0-9a-f]{32}$/u;
const EXPECTED_REVIEW_CONTRACT = {
  version: "investor-approval-test-v1",
  policy: {
    ladder: "investor-approval-ladder-v1",
    analyst: "investor-approval-analyst-v1",
    jevModel: "investor-approval-jev-v1",
    museModel: "investor-approval-muse-v1",
    evaluatorPrompt: "investor-approval-evaluator-v1",
  },
} as const;

const FULL_EVIDENCE = {
  identityStatus: "verified",
  namedProductProofs: [{ quote: "Named aerospace component" }],
  headquarters: { status: "supported", country: "US" },
  ownershipStatus: "independent",
  revenueAssessment: "under_50m",
  sourcedSupport: {
    identity: true,
    product: true,
    ownership: true,
    size: true,
    headquarters: true,
  },
} as const;

const LOW_EVIDENCE = {
  identityStatus: "not_found",
  namedProductProofs: [],
  headquarters: { status: "unknown", country: null },
  ownershipStatus: "unknown",
  revenueAssessment: "unknown",
  sourcedSupport: {
    identity: false,
    product: false,
    ownership: false,
    size: false,
    headquarters: false,
  },
} as const;

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

type RankedSignalOptions = {
  rawName?: string;
  rawDomain?: string | null;
  companyId?: string;
  createdAt?: string;
  evidence?: typeof FULL_EVIDENCE | typeof LOW_EVIDENCE | Record<string, unknown>;
  productFit?: "supported_product" | "plausible_supplier";
  researchPriority?: 1 | 2 | 3;
  stateRevision?: number;
  signalRevision?: number;
};

async function createRankedSignal(
  label: string,
  options: RankedSignalOptions = {},
): Promise<{ signalId: string; inputHash: string }> {
  const signalId = randomUUID();
  const signalRevision = options.signalRevision ?? 0;
  const stateRevision = options.stateRevision ?? signalRevision;
  const evidence = options.evidence ?? FULL_EVIDENCE;
  const inputManifest = {
    ...EXPECTED_REVIEW_CONTRACT,
    sourceRevision: stateRevision,
    evidence,
  };
  const inputHash = hashSignalReviewInput(inputManifest);
  const createdAt = options.createdAt ?? "2040-01-01T00:00:00.000001Z";
  await getDatabase().execute(sql`
    INSERT INTO source_signals (
      id,
      review_revision,
      source_key,
      source_locator,
      source_fingerprint,
      raw_name,
      raw_domain,
      company_id,
      created_at,
      updated_at
    ) VALUES (
      ${signalId}::uuid,
      ${signalRevision},
      'investor_approval_fixture',
      ${`investor-approval:${label}`},
      ${`investor-approval:${label}:${signalId}`},
      ${options.rawName ?? `Approval ${label}`},
      ${options.rawDomain ?? null},
      ${options.companyId ?? null}::uuid,
      ${createdAt}::timestamptz,
      ${createdAt}::timestamptz
    )
  `);
  const [evaluation] = await getDatabase()
    .insert(faaEnsembleEvaluations)
    .values({
      signalId,
      modelId: EXPECTED_REVIEW_CONTRACT.policy.jevModel,
      promptVersion: "investor-approval-triage-v1",
      inputHash,
      inputManifest,
      parsed: {
        version: "jev-triage-v1",
        decision: "research",
        confidence: 80,
        productFit: options.productFit ?? "supported_product",
        acquisitionReadiness: "needs_research",
        researchPriority: options.researchPriority ?? 2,
        reasonCodes: [],
        explanation: "investor approval regression fixture",
        observations: [],
        gaps: [],
      },
      decision: "research",
      confidence: 80,
    })
    .returning({ id: faaEnsembleEvaluations.id });
  if (evaluation === undefined) throw new Error("expected Jev evaluation");
  await getDatabase().insert(signalReviewState).values({
    signalId,
    sourceRevision: stateRevision,
    phase: "muse",
    inputHash,
    inputManifest,
    jevEvaluationId: evaluation.id,
    nextAttemptAt: new Date(0),
    createdAt: new Date(createdAt),
  });
  return { signalId, inputHash };
}

async function approve(sourceSignalId: string, active = true): Promise<void> {
  await getDatabase().insert(investorPicks).values({ sourceSignalId, active });
}

async function claimMuse(limit: number, sourceSignalIds?: readonly string[]) {
  return claimSignalReviews(getDatabase(), {
    phase: "muse",
    limit,
    leaseSeconds: 60,
    expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
    ...(sourceSignalIds === undefined ? {} : { sourceSignalIds }),
  });
}

describe.skipIf(!DB_TESTS_ENABLED)(
  "investor approval propagation (isolated PostgreSQL)",
  () => {
    const adminDatabaseUrl = process.env.ASI_TEST_DATABASE_ADMIN_URL!;
    const scratchDatabase = `asi_investor_approval_${randomUUID().replaceAll("-", "")}`;
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
          faa_ensemble_evaluations,
          signal_analyst_cases,
          signal_review_state,
          investor_picks,
          source_signals,
          companies
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

    it("propagates only active direct, canonical-company, and exact normalized name-and-domain approvals", async () => {
      const direct = await createRankedSignal("direct");
      await approve(direct.signalId);

      const companyId = randomUUID();
      await getDatabase().insert(companies).values({
        id: companyId,
        legalName: "Canonical Aerospace",
        displayName: "Canonical Aerospace",
      });
      const canonicalPick = await createRankedSignal("canonical-pick", { companyId });
      const canonicalTarget = await createRankedSignal("canonical-target", { companyId });
      await approve(canonicalPick.signalId);

      const exactPick = await createRankedSignal("exact-pick", {
        rawName: "\tＡcme\tAerospace, LLC\n",
        rawDomain: "https://ACME.example/about",
      });
      const exactTarget = await createRankedSignal("exact-target", {
        rawName: "  Acme   Aerospace, LLC  ",
        rawDomain: "www.acme.example",
      });
      await approve(exactPick.signalId);

      const sameDomainDifferentName = await createRankedSignal("same-domain-different-name", {
        rawName: "Different Acme Holdings",
        rawDomain: "acme.example",
      });
      const sameNameConflictingDomain = await createRankedSignal("same-name-conflicting-domain", {
        rawName: "Acme Aerospace, LLC",
        rawDomain: "other-acme.example",
      });

      await expect(isSourceSignalInvestorApproved(getDatabase(), direct.signalId)).resolves.toBe(
        true,
      );
      await expect(
        isSourceSignalInvestorApproved(getDatabase(), canonicalTarget.signalId),
      ).resolves.toBe(true);
      await expect(
        isSourceSignalInvestorApproved(getDatabase(), exactTarget.signalId),
      ).resolves.toBe(true);
      await expect(
        isSourceSignalInvestorApproved(getDatabase(), sameDomainDifferentName.signalId),
      ).resolves.toBe(false);
      await expect(
        isSourceSignalInvestorApproved(getDatabase(), sameNameConflictingDomain.signalId),
      ).resolves.toBe(false);
    });

    it("removes active approvals from Muse without changing their overview score and restores archived Haltec", async () => {
      const approved = await createRankedSignal("archived-halte", {
        rawName: "Haltec Corporation",
        rawDomain: "haltec.com",
        researchPriority: 3,
      });
      const fallback = await createRankedSignal("archived-fallback", {
        evidence: LOW_EVIDENCE,
        productFit: "plausible_supplier",
        researchPriority: 1,
      });
      await approve(approved.signalId);

      const beforeArchive = await listSourceSignalAnalystOverviews(getDatabase(), {
        expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
        sourceSignalIds: [approved.signalId, fallback.signalId],
      });
      const approvedOverview = beforeArchive.items.find(
        (item) => item.signal.id === approved.signalId,
      );
      const fallbackOverview = beforeArchive.items.find(
        (item) => item.signal.id === fallback.signalId,
      );
      expect(approvedOverview).toMatchObject({
        investorApproved: true,
        ranking: { status: "ranked", score: 90 },
      });
      expect(fallbackOverview).toMatchObject({
        investorApproved: false,
        ranking: { status: "ranked", score: 15 },
      });
      expect((await claimMuse(2)).map((claim) => claim.signalId)).toEqual([
        fallback.signalId,
      ]);

      await getDatabase()
        .update(investorPicks)
        .set({ active: false })
        .where(eq(investorPicks.sourceSignalId, approved.signalId));
      const afterArchive = await listSourceSignalAnalystOverviews(getDatabase(), {
        expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
        sourceSignalIds: [approved.signalId],
      });
      expect(afterArchive.items).toMatchObject([
        {
          signal: { id: approved.signalId },
          investorApproved: false,
          ranking: { status: "ranked", score: 90 },
        },
      ]);
      expect((await claimMuse(1)).map((claim) => claim.signalId)).toEqual([
        approved.signalId,
      ]);
    });

    it("claims only current unfinished non-approved work in descending canonical score order", async () => {
      const highNew = await createRankedSignal("high-new", {
        createdAt: "2050-01-01T00:00:00.000001Z",
        researchPriority: 3,
      });
      const lowOld = await createRankedSignal("low-old", {
        createdAt: "2000-01-01T00:00:00.000001Z",
        evidence: LOW_EVIDENCE,
        productFit: "plausible_supplier",
        researchPriority: 1,
      });
      const approved = await createRankedSignal("approved-high", {
        createdAt: "2060-01-01T00:00:00.000001Z",
      });
      await approve(approved.signalId);
      await createRankedSignal("stale", {
        stateRevision: 0,
        signalRevision: 1,
      });
      await createRankedSignal("excluded", {
        evidence: { ...FULL_EVIDENCE, ownershipStatus: "acquired" },
      });
      const completed = await createRankedSignal("completed");
      const exhausted = await createRankedSignal("exhausted");
      for (const [fixture, status] of [
        [completed, "completed"],
        [exhausted, "exhausted"],
      ] as const) {
        await getDatabase().insert(signalAnalystCases).values({
          signalId: fixture.signalId,
          sourceRevision: 0,
          policyVersion: EXPECTED_REVIEW_CONTRACT.policy.analyst,
          inputHash: fixture.inputHash,
          status,
          limits: {},
          checkpoint: {},
        });
      }

      expect((await claimMuse(1)).map((claim) => claim.signalId)).toEqual([
        highNew.signalId,
      ]);
      expect((await claimMuse(1)).map((claim) => claim.signalId)).toEqual([
        lowOld.signalId,
      ]);
      expect(await claimMuse(1)).toEqual([]);
    });

    it("honors Muse source scopes, due times, leases, and concurrent claims", async () => {
      const scoped = await createRankedSignal("scoped");
      const outsideScope = await createRankedSignal("outside-scope");
      const future = await createRankedSignal("future");
      await getDatabase()
        .update(signalReviewState)
        .set({ nextAttemptAt: new Date(Date.now() + 60_000) })
        .where(eq(signalReviewState.signalId, future.signalId));

      expect(
        (await claimMuse(10, [scoped.signalId])).map((claim) => claim.signalId),
      ).toEqual([scoped.signalId]);
      expect(
        (await claimMuse(10, [future.signalId])).map((claim) => claim.signalId),
      ).toEqual([]);

      const contested = await createRankedSignal("contested");
      const [left, right] = await Promise.all([
        claimMuse(1, [contested.signalId]),
        claimMuse(1, [contested.signalId]),
      ]);
      expect([...left, ...right].map((claim) => claim.signalId)).toEqual([
        contested.signalId,
      ]);
      expect(
        (await claimMuse(1, [contested.signalId])).map((claim) => claim.signalId),
      ).toEqual([]);
      expect(
        (await claimMuse(1, [outsideScope.signalId])).map((claim) => claim.signalId),
      ).toEqual([outsideScope.signalId]);
    });
  },
);
