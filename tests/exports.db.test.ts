/**
 * DB-gated integration test for the shortlist export (Inv-B1): the
 * `candidates` entity joins companies for name/domain and exposes status,
 * novelty_status, current_scores axes, priorities and created_at.
 *
 *   ASI_DB_TESTS=1 DATABASE_URL=postgres://... npx vitest run tests/exports.db.test.ts
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  candidates,
  closeDatabase,
  companies,
  getDatabase,
  exportRecords,
} from "@asi/database";

import { runMigrations } from "../packages/database/src/migrate.js";

const DB_TESTS_ENABLED = process.env.ASI_DB_TESTS === "1";
const RUN_TAG = Date.now().toString(36);

describe.skipIf(!DB_TESTS_ENABLED)("exports (DB)", () => {
  let companyId: string;
  let candidateId: string;

  beforeAll(async () => {
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
  });

  afterAll(async () => {
    const db = getDatabase();
    await db.delete(candidates).where(eq(candidates.id, candidateId));
    await db.delete(companies).where(eq(companies.id, companyId));
    await closeDatabase();
  });

  it("returns a CSV row for the seeded candidate", async () => {
    const file = await exportRecords({ entity: "candidates", format: "csv" });
    expect(file.fileName).toMatch(/^candidates-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(file.contentType).toBe("text/csv; charset=utf-8");
    expect(file.rowCount).toBeGreaterThanOrEqual(1);

    const lines = file.body.trimEnd().split("\n");
    const headers = lines[0]!.split(",");
    for (const expected of [
      "id",
      "companyId",
      "companyName",
      "companyDomain",
      "status",
      "noveltyStatus",
      "currentScores",
      "researchPriority",
      "partnerReviewPriority",
      "createdAt",
    ]) {
      expect(headers).toContain(expected);
    }
    const dataRow = lines.find((line) => line.includes(`Export Test Holdings ${RUN_TAG}`));
    expect(dataRow).toBeDefined();
    expect(dataRow).toContain("shortlist");
    expect(dataRow).toContain("not_matched_to_current_known_universe");
    expect(dataRow).toContain('"fit"'); // current_scores JSON survives CSV quoting
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
    const scores = JSON.parse(String(row["currentScores"])) as Record<string, number>;
    expect(scores).toEqual(expect.objectContaining({ fit: 72.5 }));
    expect(Number(row["researchPriority"])).toBeCloseTo(81.2);

    const miss = await exportRecords({
      entity: "candidates",
      format: "csv",
      query: `No Such Company ${RUN_TAG}`,
    });
    expect(miss.rowCount).toBe(0);
  });
});
