/**
 * DB-gated integration suite for F4: company research persists ALL fetched
 * documents and attributes each fact's evidence to the document its excerpt
 * came from (homepage + subpage scenario).
 *
 *   ASI_DB_TESTS=1 DATABASE_URL=postgres://... npx vitest run tests/company-research-artifacts.db.test.ts
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDatabase,
  companies,
  evidence,
  getDatabase,
  mapResearchRunInput,
  researchRuns,
  sourceDocuments,
} from "@asi/database";
import {
  recordCompanyResearchArtifacts,
  type RecordedCompanyResearchArtifacts,
} from "../packages/database/src/provenance.js";
import { runMigrations } from "../packages/database/src/migrate.js";

const DB_TESTS_ENABLED = process.env.ASI_DB_TESTS === "1";
const repoPath = (suffix: string) => path.join(process.cwd(), suffix);

function loadDatabaseUrl(): void {
  if (process.env.DATABASE_URL !== undefined && process.env.DATABASE_URL !== "") return;
  for (const candidate of [repoPath(".env.local"), repoPath(".env")]) {
    if (!existsSync(candidate)) continue;
    for (const line of readFileSync(candidate, "utf8").split("\n")) {
      const match = /^DATABASE_URL=(.*)$/.exec(line.trim());
      if (match?.[1] !== undefined) {
        process.env.DATABASE_URL = match[1].trim();
        return;
      }
    }
  }
}

const RUN_TAG = randomUUID().slice(0, 8);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function doc(canonicalUrl: string, marker: string) {
  return {
    canonicalUrl,
    title: `doc ${marker}`,
    mimeType: "text/html",
    byteLength: 100,
    contentSha256: sha(`${RUN_TAG}:${marker}`),
    retrievedAt: new Date().toISOString(),
    metadata: { requestedUrl: canonicalUrl, redirects: [] },
  };
}

describe.skipIf(!DB_TESTS_ENABLED)("company research artifacts (DB)", () => {
  let companyId: string;
  let firstCall: RecordedCompanyResearchArtifacts | null = null;
  // research_runs FK columns are uuid — run ids must be real UUIDs with rows.
  const runId = randomUUID();
  const legacyRunId = randomUUID();
  const homepageUrl = `https://artifact-${RUN_TAG}.example.com/`;
  const subpageUrl = `${homepageUrl}about`;

  /** Ensure the research_runs FK row exists (idempotent). */
  async function seedRun(db: ReturnType<typeof getDatabase>, id: string): Promise<void> {
    await db
      .insert(researchRuns)
      .values({
        id,
        ...mapResearchRunInput({
          targetType: "company",
          targetId: companyId,
          objective: "artifact persistence test",
          metadata: {},
          promptVersion: "candidate-research.v1",
        }),
      })
      .onConflictDoNothing();
  }

  const baseResult = {
    status: "completed" as const,
    sourceDocuments: [doc(homepageUrl, "home"), doc(subpageUrl, "sub")],
    facts: [
      {
        fieldKey: "description",
        value: "precision machining",
        evidenceExcerpt: "provides precision machining",
        confidence: 0.9,
        sourceUrl: homepageUrl,
      },
      {
        fieldKey: "capability",
        value: "5-axis impeller machining",
        evidenceExcerpt: "five-axis impeller capability on the about page",
        confidence: 0.8,
        sourceUrl: subpageUrl,
      },
    ],
    telemetry: {
      promptVersion: "candidate-research.v1",
      fetch: {
        toolName: "fetch_url" as const,
        requestedUrlSha256: sha(`req:${RUN_TAG}`),
        responseSha256: sha(`${RUN_TAG}:home`),
        finalUrl: homepageUrl,
        byteLength: 100,
        durationMs: 10,
        redirectCount: 0,
      },
      model: {
        route: "fast",
        schemaName: "company_research_v1",
        schemaSha256: sha("schema"),
        responseSha256: sha("resp"),
        provider: "openrouter",
        attempts: [
          {
            attempt: 1,
            model: "test-model",
            provider: "test",
            status: "succeeded" as const,
            httpStatus: 200,
            promptSha256: sha("p"),
            responseSha256: sha("resp"),
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            costUsd: 0,
            latencyMs: 5,
            retryDelayMs: null,
            errorCode: null,
          },
        ],
      },
    },
  };

  beforeAll(async () => {
    loadDatabaseUrl();
    await runMigrations();
    const db = getDatabase();
    const [company] = await db
      .insert(companies)
      .values({
        legalName: `Artifact Test ${RUN_TAG} LLC`,
        displayName: `Artifact Test ${RUN_TAG}`,
        headquartersCountryCode: "US",
      })
      .returning({ id: companies.id });
    companyId = company!.id;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("persists both documents and attributes each fact to its own document", async () => {
    const db = getDatabase();
    await seedRun(db, runId);
    const artifacts = await recordCompanyResearchArtifacts({
      companyId,
      researchRunId: runId,
      result: baseResult,
    });

    // Two distinct source_documents rows for this run.
    const docs = await db
      .select({ id: sourceDocuments.id, url: sourceDocuments.canonicalUrl })
      .from(sourceDocuments)
      .where(sql`${sourceDocuments.metadata}->>'researchRunId' = ${runId}`);
    expect(docs.map((d) => d.url).sort()).toEqual([homepageUrl, subpageUrl].sort());
    expect(artifacts.sourceDocumentIds).toHaveLength(2);
    expect(artifacts.evidenceIds).toHaveLength(2);

    const homeDoc = docs.find((d) => d.url === homepageUrl)!;
    const subDoc = docs.find((d) => d.url === subpageUrl)!;

    const rows = await db
      .select({
        quote: evidence.quote,
        locator: evidence.locator,
        documentId: evidence.sourceDocumentId,
      })
      .from(evidence)
      .where(sql`${evidence.metadata}->>'researchRunId' = ${runId}`);

    const homeEvidence = rows.find((r) => r.quote.includes("precision machining"))!;
    const subEvidence = rows.find((r) => r.quote.includes("impeller"))!;
    // Homepage fact → homepage document + homepage locator.
    expect(homeEvidence.documentId).toBe(homeDoc.id);
    expect(homeEvidence.locator).toBe(homepageUrl);
    // Subpage fact → SUBPAGE document + subpage locator (was misattributed).
    expect(subEvidence.documentId).toBe(subDoc.id);
    expect(subEvidence.locator).toBe(subpageUrl);
    // Recorder's primary id is still the homepage document.
    expect(artifacts.sourceDocumentId).toBe(homeDoc.id);

    firstCall = artifacts;
  });

  it("falls back to the homepage with an explicit locator note when attribution is missing", async () => {
    const db = getDatabase();
    await seedRun(db, legacyRunId);
    await recordCompanyResearchArtifacts({
      companyId,
      researchRunId: legacyRunId,
      result: {
        ...baseResult,
        facts: [
          {
            fieldKey: "description",
            value: "legacy unattributed fact",
            evidenceExcerpt: "excerpt without a sourceUrl",
            confidence: 0.7,
          },
        ],
      },
    });
    const rows = await db
      .select({ locator: evidence.locator })
      .from(evidence)
      .where(sql`${evidence.metadata}->>'researchRunId' = ${legacyRunId}`);
    expect(rows[0]?.locator).toBe(`${homepageUrl} (homepage)`);
  });

  it("is idempotent: replaying the same result returns the same ids", async () => {
    const db = getDatabase();
    await seedRun(db, runId);
    const replay = await recordCompanyResearchArtifacts({
      companyId,
      researchRunId: runId,
      result: baseResult,
    });
    expect(firstCall).not.toBeNull();
    expect(replay.sourceDocumentIds.sort()).toEqual(
      firstCall!.sourceDocumentIds.slice().sort(),
    );
    // Same evidence ids come back — duplicates were not re-created.
    expect(replay.evidenceIds.sort()).toEqual(firstCall!.evidenceIds.slice().sort());
  });
});
