/**
 * DB-gated integration test for the shortlist export (Inv-B1): the
 * `candidates` entity joins companies for name/domain and exposes status,
 * novelty_status, current_scores axes, priorities and created_at.
 *
 *   ASI_DB_TESTS=1 ASI_TEST_DATABASE_ADMIN_URL=postgres://... npx vitest run tests/exports.db.test.ts
 */
import { createHash, randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listSourceSignalAnalystOverviews } from "../packages/database/src/analyst-research.js";
import { closeDatabase, getDatabase } from "../packages/database/src/client.js";
import { exportRecords } from "../packages/database/src/exports.js";
import { runMigrations } from "../packages/database/src/migrate.js";
import {
  candidates,
  companies,
  faaEnsembleEvaluations,
  faaEnsembleResults,
  signalReviewState,
  sourceSignals,
  unifiedTargets,
} from "../packages/database/src/schema.js";
import {
  exportSourceSignals,
  exportUnifiedTargets,
} from "../packages/database/src/unified-targets/export.js";

const DB_TESTS_ENABLED =
  process.env.ASI_DB_TESTS === "1" &&
  process.env.ASI_TEST_DATABASE_ADMIN_URL !== undefined;
const SAFE_SCRATCH_DATABASE = /^asi_exports_[0-9a-f]{32}$/u;

function nativeDatabaseUrls(
  adminDatabaseUrl: string,
  scratchDatabase: string,
): { adminDatabaseUrl: string; scratchDatabaseUrl: string } {
  const adminUrl = new URL(adminDatabaseUrl);
  if (adminUrl.protocol !== "postgres:" && adminUrl.protocol !== "postgresql:") {
    throw new Error("ASI_TEST_DATABASE_ADMIN_URL must be a PostgreSQL URL");
  }
  const hostname = adminUrl.hostname.toLowerCase();
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname)) {
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

const RUN_TAG = Date.now().toString(36);
const EXPECTED_REVIEW_CONTRACT = {
  version: "export-ranking-input-v1",
  policy: {
    ladder: "export-ranking-ladder-v1",
    analyst: "export-ranking-analyst-v1",
    jevModel: "export-ranking-jev-v1",
    museModel: "export-ranking-muse-v1",
    evaluatorPrompt: "export-ranking-evaluator-v1",
  },
} as const;

const FULL_RANKING_EVIDENCE = {
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

const UNKNOWN_RANKING_EVIDENCE = {
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

const PARTIAL_RANKING_EVIDENCE = {
  ...UNKNOWN_RANKING_EVIDENCE,
  identityStatus: "verified",
  namedProductProofs: [{ quote: "Named aerospace component" }],
  sourcedSupport: {
    ...UNKNOWN_RANKING_EVIDENCE.sourcedSupport,
    identity: true,
    product: true,
  },
} as const;

async function createRankingSource(
  label: string,
  options: {
    readonly createdAt: string;
    readonly fullEvidence?: boolean;
    readonly partialEvidence?: boolean;
    readonly stalePolicy?: boolean;
    readonly signalId?: string;
    readonly rawName?: string;
  },
): Promise<string> {
  const db = getDatabase();
  const signalId = options.signalId ?? randomUUID();
  const evaluationId = randomUUID();
  const inputHash = createHash("sha256")
    .update(`export-ranking:${RUN_TAG}:${label}`)
    .digest("hex");
  const verifiedDomain = `${label.toLowerCase()}.${RUN_TAG}.example`;
  const rankingEvidence = options.fullEvidence
    ? FULL_RANKING_EVIDENCE
    : options.partialEvidence
      ? PARTIAL_RANKING_EVIDENCE
      : UNKNOWN_RANKING_EVIDENCE;
  const manifest = {
    version: EXPECTED_REVIEW_CONTRACT.version,
    sourceRevision: 0,
    evidence: {
      ...rankingEvidence,
      domain:
        options.fullEvidence || options.partialEvidence
          ? verifiedDomain
          : null,
    },
    policy: {
      ...EXPECTED_REVIEW_CONTRACT.policy,
      ...(options.stalePolicy ? { jevModel: "stale-export-jev" } : {}),
    },
  };
  const researchEvidence = options.fullEvidence
    ? {
        version: "signal_research_v1",
        identity: {
          status: "verified",
          verifiedDomain,
          proofEvidenceIds: ["identity-proof"],
        },
        website: {
          status: "supported",
          offering: "products_menu",
          namedProductEvidenceIds: ["product-proof"],
        },
        ownership: {
          status: "independent",
          supportEvidenceIds: ["ownership-proof"],
        },
        size: {
          status: "supported",
          assessment: "under_50m",
          indicators: [{ kind: "revenue", evidenceId: "size-proof" }],
        },
        headquarters: {
          status: "supported",
          country: "US",
          supportEvidenceIds: ["hq-proof"],
        },
        missingFacts: [],
        evidenceRefs: [
          {
            evidenceId: "identity-proof",
            stage: "domain",
            role: "support",
            firstParty: true,
          },
          {
            evidenceId: "product-proof",
            stage: "website",
            role: "support",
            firstParty: true,
          },
          {
            evidenceId: "ownership-proof",
            stage: "ownership",
            role: "support",
          },
          {
            evidenceId: "size-proof",
            stage: "size",
            role: "support",
          },
          {
            evidenceId: "hq-proof",
            stage: "hq",
            role: "support",
          },
        ],
      }
    : null;
  const jevDecision = options.fullEvidence ? "high_priority" : "research";
  await db.insert(sourceSignals).values({
    id: signalId,
    sourceKey: "faa_pma_database",
    sourceLocator: `export-ranking:${RUN_TAG}:${label}`,
    sourceFingerprint: `export-ranking:${RUN_TAG}:${label}:${signalId}`,
    rawName: options.rawName ?? `Export Ranking ${RUN_TAG} ${label}`,
    rawDomain: verifiedDomain,
    sourcePayload: { rawMarker: `raw-${RUN_TAG}-${label}` },
    qualification: { exactMarker: `qualification-${RUN_TAG}-${label}` },
    createdAt: new Date(options.createdAt),
    updatedAt: new Date(options.createdAt),
  });
  await db.execute(sql`
    UPDATE source_signals
    SET created_at = ${options.createdAt}::timestamptz,
        updated_at = ${options.createdAt}::timestamptz
    WHERE id = ${signalId}::uuid
  `);
  await db.insert(faaEnsembleEvaluations).values({
    id: evaluationId,
    signalId,
    modelId: options.stalePolicy
      ? "stale-export-jev"
      : EXPECTED_REVIEW_CONTRACT.policy.jevModel,
    promptVersion: "jev-ladder-rung-prompt",
    inputHash,
    inputManifest: manifest,
    rawResponse: "{}",
    parsed: {
      version: "jev-triage-v1",
      decision: jevDecision,
      productFit:
        options.fullEvidence || options.partialEvidence
          ? "supported_product"
          : "unknown",
      acquisitionReadiness: options.partialEvidence
        ? "needs_research"
        : "ready",
      researchPriority: options.fullEvidence ? 1 : 3,
      confidence: null,
      reasonCodes: [],
      explanation: "Native export ranking fixture.",
      observations: [],
      gaps: [],
    },
    decision: jevDecision,
    error: null,
  });
  await db.insert(signalReviewState).values({
    signalId,
    sourceRevision: 0,
    phase: options.fullEvidence ? "settled" : "muse",
    inputHash,
    inputManifest: manifest,
    jevEvaluationId: evaluationId,
    ...(researchEvidence === null ? {} : { researchEvidence }),
    nextAttemptAt: new Date(0),
  });
  if (options.fullEvidence) {
    const museEvaluationId = randomUUID();
    await db.insert(faaEnsembleEvaluations).values({
      id: museEvaluationId,
      signalId,
      modelId: EXPECTED_REVIEW_CONTRACT.policy.museModel,
      promptVersion: "signal-analyst-final-v1",
      inputHash,
      inputManifest: manifest,
      rawResponse: "{}",
      parsed: { decision: "high_priority" },
      decision: "high_priority",
      error: null,
    });
    await db.insert(faaEnsembleResults).values({
      signalId,
      promptVersion: EXPECTED_REVIEW_CONTRACT.policy.evaluatorPrompt,
      inputHash,
      jevEvaluationId: evaluationId,
      museEvaluationId,
      modelAId: EXPECTED_REVIEW_CONTRACT.policy.jevModel,
      modelBId: EXPECTED_REVIEW_CONTRACT.policy.museModel,
      modelADecision: "high_priority",
      modelBDecision: "high_priority",
      agreed: true,
      adjudicationRequired: false,
      finalDecision: "high_priority",
    });
  }
  return signalId;
}

describe.skipIf(!DB_TESTS_ENABLED)("exports (isolated PostgreSQL)", () => {
  const adminDatabaseUrl = process.env.ASI_TEST_DATABASE_ADMIN_URL!;
  const scratchDatabase = `asi_exports_${randomUUID().replaceAll("-", "")}`;
  let originalDatabaseUrl: string | undefined;
  let hadOriginalDatabaseUrl = false;
  let companyId: string;
  let candidateId: string;
  let olderHighSignalId: string;
  let partialSignalId: string;
  let newerLowSignalId: string;
  let precisionNewerSignalId: string;
  let precisionOlderSignalId: string;
  let staleSignalId: string;

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
    const db = getDatabase();
    const inserted = await db
      .insert(companies)
      .values({
        legalName: `Export Test Holdings ${RUN_TAG} Inc`,
        displayName: `Export Test Holdings ${RUN_TAG}`,
        headquartersCountryCode: "US",
      })
      .returning({ id: companies.id });
    companyId = inserted[0]!.id;
    const candidate = await db
      .insert(candidates)
      .values({
        companyId,
        status: "shortlist",
        noveltyStatus: "not_matched_to_current_known_universe",
        currentScores: { fit: 72.5, novelty: 88, confidence: 41, actionability: 63.25 },
        researchPriority: "81.20",
        partnerReviewPriority: "77.90",
      })
      .returning({ id: candidates.id });
    candidateId = candidate[0]!.id;
    olderHighSignalId = await createRankingSource("OlderHigh", {
      createdAt: "2040-01-01T00:00:00.000Z",
      fullEvidence: true,
    });
    partialSignalId = await createRankingSource("PartialIdentity", {
      createdAt: "2045-01-01T00:00:00.000Z",
      partialEvidence: true,
    });
    newerLowSignalId = await createRankingSource("NewerLow", {
      createdAt: "2050-01-01T00:00:00.000Z",
    });
    precisionNewerSignalId = await createRankingSource(
      "PrecisionNewer",
      {
        createdAt: "2047-01-01T00:00:00.000002Z",
        signalId: `1${randomUUID().slice(1)}`,
        rawName: `Precision ${RUN_TAG} Newer`,
      },
    );
    precisionOlderSignalId = await createRankingSource(
      "PrecisionOlder",
      {
        createdAt: "2047-01-01T00:00:00.000001Z",
        signalId: `f${randomUUID().slice(1)}`,
        rawName: `Precision ${RUN_TAG} Older`,
      },
    );
    staleSignalId = await createRankingSource("StaleProof", {
      createdAt: "2030-01-01T00:00:00.000Z",
      fullEvidence: true,
      stalePolicy: true,
    });

    await db
      .insert(unifiedTargets)
      .values([
        {
          companyName: `Linked Export Target ${RUN_TAG}`,
          normalizedName: `linked export target ${RUN_TAG}`,
          domain: `olderhigh.${RUN_TAG}.example`,
          tier: "evaluate",
          signalId: olderHighSignalId,
          origins: ["faa_ensemble"],
        },
        {
          companyName: `Conflicting Export Target ${RUN_TAG}`,
          normalizedName: `conflicting export target ${RUN_TAG}`,
          domain: `different-${RUN_TAG}.example`,
          tier: "evaluate",
          signalId: olderHighSignalId,
          origins: ["faa_ensemble", "manual"],
        },
        {
          companyName: `Partial Conflict Target ${RUN_TAG}`,
          normalizedName: `partial conflict target ${RUN_TAG}`,
          domain: `partial-different-${RUN_TAG}.example`,
          tier: "evaluate",
          signalId: partialSignalId,
          origins: ["faa_ensemble"],
        },
        {
          companyName: `Precision Newer Target ${RUN_TAG}`,
          normalizedName: `precision newer target ${RUN_TAG}`,
          domain: `precisionnewer.${RUN_TAG}.example`,
          tier: "evaluate",
          signalId: precisionNewerSignalId,
          origins: ["faa_ensemble"],
        },
        {
          companyName: `Precision Older Target ${RUN_TAG}`,
          normalizedName: `precision older target ${RUN_TAG}`,
          domain: `precisionolder.${RUN_TAG}.example`,
          tier: "evaluate",
          signalId: precisionOlderSignalId,
          origins: ["faa_ensemble"],
        },
        {
          companyName: `Unlinked Export Target ${RUN_TAG}`,
          normalizedName: `unlinked export target ${RUN_TAG}`,
          tier: "evaluate",
          origins: ["manual"],
        },
      ]);
  }, 120_000);

  afterAll(async () => {
    await closeDatabase();
    await dropScratchDatabase(adminDatabaseUrl, scratchDatabase);
    if (hadOriginalDatabaseUrl) {
      process.env.DATABASE_URL = originalDatabaseUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
  }, 120_000);

  it("returns a CSV row for the seeded candidate", async () => {
    const file = await exportRecords({ entity: "candidates", format: "csv" });
    expect(file.contentType).toBe("text/csv; charset=utf-8");

    const lines = file.body.trimEnd().split("\n");
    const dataRow = lines.find((line) => line.includes(`Export Test Holdings ${RUN_TAG}`));
    expect(dataRow).toContain(candidateId);
    expect(dataRow).toContain("shortlist");
    expect(dataRow).toContain("not_matched_to_current_known_universe");
  });

  it("honors the text query filter against company names", async () => {
    const hit = await exportRecords({
      entity: "candidates",
      format: "jsonl",
      query: `Export Test Holdings ${RUN_TAG}`,
    });
    expect(hit.rowCount).toBe(1);
    const row = JSON.parse(hit.body.trimEnd()) as Record<string, unknown>;
    expect(row["id"]).toBe(candidateId);

    const miss = await exportRecords({
      entity: "candidates",
      format: "csv",
      query: `No Such Company ${RUN_TAG}`,
    });
    expect(miss.rowCount).toBe(0);
  });

  it("exports the same whole-dataset ranking order and scores as the list", async () => {
    const q = `Export Ranking ${RUN_TAG}`;
    const page = await listSourceSignalAnalystOverviews(getDatabase(), {
      expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
      q,
      limit: 10,
    });
    const firstPage = await listSourceSignalAnalystOverviews(getDatabase(), {
      expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
      q,
      limit: 1,
    });
    expect(firstPage.items.map((item) => item.signal.id)).toEqual([
      olderHighSignalId,
    ]);
    expect(firstPage.nextCursor).not.toBeNull();

    const exported = await exportSourceSignals(getDatabase(), "json", {
      expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
      q,
    });
    const rows = JSON.parse(exported.body) as Record<string, unknown>[];
    const exportedOrder = rows.map((row) => row["signal_id"]);
    const listOrder = page.items.map((item) => item.signal.id);
    expect(exportedOrder).toEqual(listOrder);
    expect(exportedOrder).toEqual([
      olderHighSignalId,
      partialSignalId,
      newerLowSignalId,
      staleSignalId,
    ]);
    const exportedRankings = rows.map((row) => {
      const ranking = row["ranking"] as Record<string, unknown>;
      return [ranking["status"], ranking["score"]];
    });
    const listRankings = page.items.map((item) => [
      item.ranking.status,
      item.ranking.score,
    ]);
    expect(exportedRankings).toEqual(listRankings);
    expect(exportedRankings).toEqual([
      ["ranked", 90],
      ["ranked", 60],
      ["ranked", 0],
      ["unscored", null],
    ]);
  });

  it("exports every matching filtered row without cursor or limit truncation", async () => {
    const q = `Export Ranking ${RUN_TAG}`;
    const exported = await exportSourceSignals(getDatabase(), "json", {
      expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
      q,
      readiness: "ready",
    });
    const rows = JSON.parse(exported.body) as Record<string, unknown>[];
    expect(exported.rowCount).toBe(2);
    expect(rows.map((row) => row["signal_id"])).toEqual([
      olderHighSignalId,
      newerLowSignalId,
    ]);

    const newest = await exportSourceSignals(getDatabase(), "json", {
      expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
      q,
      sort: "newest",
    });
    expect(
      (JSON.parse(newest.body) as Record<string, unknown>[]).map(
        (row) => row["signal_id"],
      ),
    ).toEqual([
      newerLowSignalId,
      partialSignalId,
      olderHighSignalId,
      staleSignalId,
    ]);
  });

  it("never awards current points to stale or policy-unverified exports", async () => {
    const stale = await exportSourceSignals(getDatabase(), "json", {
      expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
      q: `StaleProof`,
    });
    const staleRow = (
      JSON.parse(stale.body) as { ranking: Record<string, unknown> }[]
    )[0]!;
    expect(staleRow.ranking).toMatchObject({
      status: "unscored",
      score: null,
    });

    const policyUnverified = await exportSourceSignals(
      getDatabase(),
      "json",
      {
        expectedReviewInputContract: null,
        q: `Export Ranking ${RUN_TAG}`,
      },
    );
    const policyUnverifiedRows = JSON.parse(policyUnverified.body) as {
      ranking: Record<string, unknown>;
    }[];
    expect(
      policyUnverifiedRows.map((row) => [
        row.ranking["status"],
        row.ranking["score"],
      ]),
    ).toEqual([
      ["unscored", null],
      ["unscored", null],
      ["unscored", null],
      ["unscored", null],
    ]);
  });

  it("retains raw JSON while CSV omits raw blobs", async () => {
    const q = `OlderHigh`;
    const json = await exportSourceSignals(getDatabase(), "json", {
      expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
      q,
    });
    const row = (
      JSON.parse(json.body) as Record<string, unknown>[]
    )[0]!;
    expect(row).toMatchObject({
      signal_id: olderHighSignalId,
      source_payload: { rawMarker: `raw-${RUN_TAG}-OlderHigh` },
      qualification: {
        exactMarker: `qualification-${RUN_TAG}-OlderHigh`,
      },
    });

    const csv = await exportSourceSignals(getDatabase(), "csv", {
      expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
      q,
    });
    expect(csv.body).not.toContain(`raw-${RUN_TAG}-OlderHigh`);
    expect(csv.body).not.toContain(`qualification-${RUN_TAG}-OlderHigh`);
  });

  it("links exact source rankings but falls back to unscored at identity boundaries", async () => {
    const source = await exportSourceSignals(getDatabase(), "json", {
      expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
      q: "OlderHigh",
    });
    const sourceRows = JSON.parse(source.body) as Record<string, unknown>[];
    const sourceRanking = sourceRows[0]?.["ranking"];
    const partialSource = await exportSourceSignals(
      getDatabase(),
      "json",
      {
        expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
        q: "PartialIdentity",
      },
    );
    const partialSourceRows = JSON.parse(
      partialSource.body,
    ) as Record<string, unknown>[];
    const partialSourceRanking = partialSourceRows[0]?.["ranking"];
    const unified = JSON.parse(
      await exportUnifiedTargets(
        getDatabase(),
        "json",
        "evaluate",
        { expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT },
      ),
    ) as Record<string, unknown>[];
    const linked = unified.find(
      (row) => row["company_name"] === `Linked Export Target ${RUN_TAG}`,
    );
    const conflicting = unified.find(
      (row) =>
        row["company_name"] === `Conflicting Export Target ${RUN_TAG}`,
    );
    const partialConflict = unified.find(
      (row) =>
        row["company_name"] === `Partial Conflict Target ${RUN_TAG}`,
    );
    const unlinked = unified.find(
      (row) => row["company_name"] === `Unlinked Export Target ${RUN_TAG}`,
    );
    const unlinkedRanking = unlinked?.["ranking"];

    if (
      linked === undefined ||
      conflicting === undefined ||
      partialConflict === undefined
    ) {
      throw new Error("expected identity-boundary target fixtures");
    }
    expect(linked["ranking"]).toEqual(sourceRanking);
    expect(partialSourceRanking).toMatchObject({
      status: "ranked",
      score: 60,
    });
    expect(unified.indexOf(linked)).toBeLessThan(
      unified.indexOf(conflicting),
    );
    expect(unlinkedRanking).toMatchObject({
      status: "unscored",
      score: null,
    });
    expect(conflicting?.["ranking"]).toMatchObject({
      status: "unscored",
      score: null,
    });
    expect(conflicting?.["readiness"]).toBe("unscored");
    expect(conflicting?.["promotion_status"]).toBe("diligence_hold");
    expect(partialConflict["ranking"]).toMatchObject({
      status: "unscored",
      score: null,
    });
    expect(partialConflict["readiness"]).toBe("unscored");
    expect(unlinked?.["pre_jev_membership"]).toBe(false);
    expect(unlinked?.["possible_identity_match"]).toBe(false);
  });

  it("preserves six-fractional priority order when identity fallback resorts", async () => {
    const source = await exportSourceSignals(getDatabase(), "json", {
      expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
      q: `Precision ${RUN_TAG}`,
    });
    const sourceRows = JSON.parse(source.body) as Record<string, unknown>[];
    expect(
      sourceRows.map((row) => [row["signal_id"], row["created_at"]]),
    ).toEqual([
      [precisionNewerSignalId, "2047-01-01T00:00:00.000002Z"],
      [precisionOlderSignalId, "2047-01-01T00:00:00.000001Z"],
    ]);

    const unified = JSON.parse(
      await exportUnifiedTargets(
        getDatabase(),
        "json",
        "evaluate",
        { expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT },
      ),
    ) as Record<string, unknown>[];
    const precisionOrder = unified
      .map((row) => row["company_name"])
      .filter(
        (name) =>
          name === `Precision Newer Target ${RUN_TAG}` ||
          name === `Precision Older Target ${RUN_TAG}`,
      );
    expect(precisionOrder).toEqual([
      `Precision Newer Target ${RUN_TAG}`,
      `Precision Older Target ${RUN_TAG}`,
    ]);
  });
});
