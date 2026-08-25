/**
 * DB-gated coverage for migration 0006 against the production backup.
 *
 *   ASI_DB_TESTS=1 npx vitest run tests/faa-synthesis-migration.db.test.ts
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { type SQL, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@asi/database";

import { closeDatabase as closeSourceDatabase } from "../packages/database/src/client.js";
import {
  type MigrationSummary,
  runMigrations,
} from "../packages/database/src/migrate.js";

const execFileAsync = promisify(execFile);
const DB_TESTS_ENABLED = process.env.ASI_DB_TESTS === "1";
const DUMP_PATH = path.join(
  process.cwd(),
  "backups/prod-20260822T234724Z/database.dump",
);
const CONTAINER = "asi-mig-0006-scratch";
const IMAGE = "postgres:18-alpine";

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, {
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

async function waitForPostgres(): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await docker([
        "exec",
        CONTAINER,
        "psql",
        "-U",
        "asi",
        "-d",
        "asi_app",
        "-c",
        "SELECT 1",
      ]);
      return;
    } catch {
      // Docker readiness is an external process condition; fake timers cannot advance it.
      await delay(500);
    }
  }
  throw new Error(`scratch postgres did not become ready (${CONTAINER})`);
}

async function snapshotTableCounts(): Promise<Map<string, number>> {
  const db = getDatabase();
  const tables = await db.execute<{ table_name: string }>(sql`
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND c.relname NOT LIKE '\\_asi\\_%' ESCAPE '\\'
    ORDER BY c.relname
  `);
  const counts = new Map<string, number>();
  for (const { table_name } of tables.rows) {
    const counted = await db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM ${sql.identifier(table_name)}`,
    );
    counts.set(table_name, Number(counted.rows[0]?.count ?? "0"));
  }
  return counts;
}

async function expectRejected(statement: SQL): Promise<void> {
  await expect(getDatabase().execute(statement)).rejects.toBeDefined();
}

describe.skipIf(!DB_TESTS_ENABLED)(
  "migration 0006 on restored prod copy (DB)",
  () => {
    let countsBefore = new Map<string, number>();
    let countsAfter = new Map<string, number>();
    let migrationSummary: MigrationSummary = { applied: [], skipped: [] };
    let canonicalSourceLinkId = "";
    let duplicateFixtureDocumentId = "";

    beforeAll(async () => {
      if (!existsSync(DUMP_PATH)) {
        throw new Error(`prod backup dump not found at ${DUMP_PATH}`);
      }
      await docker(["rm", "-f", CONTAINER]).catch(() => undefined);
      await docker([
        "run",
        "-d",
        "--name",
        CONTAINER,
        "-e",
        "POSTGRES_USER=asi",
        "-e",
        "POSTGRES_PASSWORD=test",
        "-e",
        "POSTGRES_DB=asi_app",
        "-p",
        "127.0.0.1::5432",
        IMAGE,
        "-c",
        "fsync=off",
      ]);
      const mapping = await docker(["port", CONTAINER, "5432"]);
      const assigned = /(?:127\.0\.0\.1|0\.0\.0\.0):(\d+)/.exec(mapping);
      if (assigned?.[1] === undefined) {
        throw new Error(`could not parse docker port mapping: ${mapping}`);
      }
      process.env.DATABASE_URL = `postgres://asi:test@127.0.0.1:${assigned[1]}/asi_app`;
      await waitForPostgres();
      await docker(["cp", DUMP_PATH, `${CONTAINER}:/tmp/database.dump`]);
      await docker([
        "exec",
        CONTAINER,
        "pg_restore",
        "--no-owner",
        "-U",
        "asi",
        "-d",
        "asi_app",
        "/tmp/database.dump",
      ]);

      countsBefore = await snapshotTableCounts();

      const db = getDatabase();
      const fixtureCompany = await db.execute<{ id: string }>(sql`
        INSERT INTO companies (legal_name, display_name)
        VALUES (
          'FAA Migration Duplicate Fixture Company',
          'FAA Migration Duplicate Fixture Company'
        )
        RETURNING id
      `);
      const fixtureSource = await db.execute<{ id: string }>(sql`
        INSERT INTO data_sources (name, source_type, publisher)
        VALUES (
          'FAA Migration Duplicate Fixture Source',
          'migration_fixture',
          'FAA migration test'
        )
        RETURNING id
      `);
      const fixtureDocument = await db.execute<{ id: string }>(sql`
        INSERT INTO source_documents (data_source_id, canonical_url)
        VALUES (
          ${fixtureSource.rows[0]?.id},
          'https://example.test/faa-migration-duplicate-fixture'
        )
        RETURNING id
      `);
      duplicateFixtureDocumentId = fixtureDocument.rows[0]?.id ?? "";
      const canonicalLink = await db.execute<{ id: string }>(sql`
        INSERT INTO source_document_links (
          source_document_id, company_id, relationship, created_at
        ) VALUES (
          ${duplicateFixtureDocumentId},
          ${fixtureCompany.rows[0]?.id},
          'supports',
          '2026-08-01T00:00:00Z'
        )
        RETURNING id
      `);
      canonicalSourceLinkId = canonicalLink.rows[0]?.id ?? "";
      await db.execute(sql`
        INSERT INTO source_document_links (
          source_document_id, company_id, relationship, created_at
        ) VALUES (
          ${duplicateFixtureDocumentId},
          ${fixtureCompany.rows[0]?.id},
          'supports',
          '2026-08-02T00:00:00Z'
        )
      `);

      migrationSummary = await runMigrations();
      countsAfter = await snapshotTableCounts();
    }, 240_000);

    afterAll(async () => {
      try {
        await Promise.allSettled([closeDatabase(), closeSourceDatabase()]);
      } finally {
        await docker(["stop", "-t", "10", CONTAINER]).catch(() => undefined);
        await execFileAsync("docker", ["rm", "-f", CONTAINER]).catch(
          () => undefined,
        );
      }
    });

    it("keeps old counts and retains one deterministic duplicate fixture row", async () => {
      expect(migrationSummary.applied).toContain("0006_faa_synthesis.sql");
      const fixtureDeltas: Readonly<Record<string, number>> = {
        companies: 1,
        data_sources: 1,
        source_documents: 1,
        source_document_links: 1,
      };
      for (const [table, count] of countsBefore) {
        expect(countsAfter.get(table), `table ${table}`).toBe(
          count + (fixtureDeltas[table] ?? 0),
        );
      }

      const retained = await getDatabase().execute<{ id: string }>(sql`
        SELECT id
        FROM source_document_links
        WHERE source_document_id = ${duplicateFixtureDocumentId}
      `);
      expect(retained.rows).toEqual([{ id: canonicalSourceLinkId }]);
    });

    it("is a no-op after the committed enum alteration", async () => {
      const summary = await runMigrations();
      expect(summary.applied).toEqual([]);
      expect(summary.skipped).toContain("0006_faa_synthesis.sql");
    });

    it("installs the enum, columns, indexes, checks, and foreign keys", async () => {
      const db = getDatabase();
      const identifiers = await db.execute<{ value: string }>(sql`
        SELECT unnest(enum_range(NULL::identifier_type))::text AS value
      `);
      expect(identifiers.rows.map(({ value }) => value)).toContain(
        "faa_pma_holder",
      );

      const columns = await db.execute<{
        column_name: string;
        column_default: string | null;
        is_nullable: string;
      }>(sql`
        SELECT column_name, column_default, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (
            (table_name = 'source_document_links' AND column_name IN (
              'platform_variant_id', 'facility_qualification_id'
            ))
            OR (table_name = 'facility_qualifications' AND column_name = 'status')
          )
        ORDER BY column_name
      `);
      expect(columns.rows.map(({ column_name }) => column_name)).toEqual([
        "facility_qualification_id",
        "platform_variant_id",
        "status",
      ]);
      expect(columns.rows.find(({ column_name }) => column_name === "status")).toMatchObject({
        column_default: "'draft'::record_status",
        is_nullable: "NO",
      });

      const indexes = await db.execute<{ indexname: string; indexdef: string }>(sql`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = 'public' AND indexname IN (
          'source_document_links_target_uidx',
          'facility_qualifications_context_uidx',
          'facility_qualifications_reference_uidx',
          'platform_variants_id_platform_uidx',
          'part_alternate_ids_natural_uidx',
          'part_alternate_ids_lookup_idx',
          'facilities_complete_address_uidx'
        )
        ORDER BY indexname
      `);
      expect(indexes.rows.map(({ indexname }) => indexname)).toEqual([
        "facilities_complete_address_uidx",
        "facility_qualifications_context_uidx",
        "facility_qualifications_reference_uidx",
        "part_alternate_ids_lookup_idx",
        "part_alternate_ids_natural_uidx",
        "platform_variants_id_platform_uidx",
        "source_document_links_target_uidx",
      ]);
      expect(
        indexes.rows.find(
          ({ indexname }) => indexname === "part_alternate_ids_natural_uidx",
        )?.indexdef,
      ).toContain("part_id");

      const constraints = await db.execute<{
        conname: string;
        definition: string;
      }>(sql`
        SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
        FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = 'public' AND c.conname IN (
          'source_document_links_platform_variant_fk',
          'source_document_links_facility_qualification_fk',
          'source_document_links_target_chk',
          'facility_qualifications_variant_platform_fk'
        )
        ORDER BY c.conname
      `);
      expect(constraints.rows.map(({ conname }) => conname)).toEqual([
        "facility_qualifications_variant_platform_fk",
        "source_document_links_facility_qualification_fk",
        "source_document_links_platform_variant_fk",
        "source_document_links_target_chk",
      ]);
      expect(
        constraints.rows.find(
          ({ conname }) => conname === "source_document_links_target_chk",
        )?.definition,
      ).toContain("platform_variant_id");
      expect(
        constraints.rows.find(
          ({ conname }) =>
            conname === "facility_qualifications_variant_platform_fk",
        )?.definition,
      ).toContain("FOREIGN KEY (platform_variant_id, platform_id)");
    });

    it("rejects conflicting synthesis identities while preserving scoped reuse", async () => {
      const db = getDatabase();
      const company = await db.execute<{ id: string }>(sql`
        INSERT INTO companies (legal_name, display_name)
        VALUES ('FAA Synthesis Migration Test Company', 'FAA Synthesis Migration Test Company')
        RETURNING id
      `);
      const companyId = company.rows[0]?.id;
      expect(companyId).toBeDefined();

      await db.execute(sql`
        INSERT INTO company_identifiers (company_id, type, value)
        VALUES (${companyId}, 'faa_pma_holder', 'PQ0006CE')
      `);

      const facility = await db.execute<{ id: string }>(sql`
        INSERT INTO facilities (
          company_id, name, address_line_1, city, region, postal_code, country_code
        ) VALUES (
          ${companyId}, 'FAA Plant', '100 Flight Way', 'Wichita', 'KS', '67209', 'US'
        )
        RETURNING id
      `);
      const facilityId = facility.rows[0]?.id;
      expect(facilityId).toBeDefined();
      await expectRejected(sql`
        INSERT INTO facilities (
          company_id, name, address_line_1, city, region, postal_code, country_code
        ) VALUES (
          ${companyId}, 'SAM Plant Duplicate', ' 100 FLIGHT WAY ', ' wichita ', 'ks', ' 67209 ', 'us'
        )
      `);
      const otherCompany = await db.execute<{ id: string }>(sql`
        INSERT INTO companies (legal_name, display_name)
        VALUES (
          'FAA Synthesis Migration Other Company',
          'FAA Synthesis Migration Other Company'
        )
        RETURNING id
      `);
      await db.execute(sql`
        INSERT INTO facilities (
          company_id, name, address_line_1, city, region, postal_code, country_code
        ) VALUES (
          ${otherCompany.rows[0]?.id}, 'Independently Owned Plant',
          '100 Flight Way', 'Wichita', 'KS', '67209', 'US'
        )
      `);

      const platformA = await db.execute<{ id: string }>(sql`
        INSERT INTO platforms (name) VALUES ('FAA Migration Platform A') RETURNING id
      `);
      const platformB = await db.execute<{ id: string }>(sql`
        INSERT INTO platforms (name) VALUES ('FAA Migration Platform B') RETURNING id
      `);
      const platformAId = platformA.rows[0]?.id;
      const platformBId = platformB.rows[0]?.id;
      const variant = await db.execute<{ id: string }>(sql`
        INSERT INTO platform_variants (platform_id, name)
        VALUES (${platformAId}, 'FAA Migration Variant')
        RETURNING id
      `);
      const variantId = variant.rows[0]?.id;

      const partA = await db.execute<{ id: string }>(sql`
        INSERT INTO parts (part_number) VALUES ('FAA-MIGRATION-PART-A') RETURNING id
      `);
      const partB = await db.execute<{ id: string }>(sql`
        INSERT INTO parts (part_number) VALUES ('FAA-MIGRATION-PART-B') RETURNING id
      `);
      const partAId = partA.rows[0]?.id;
      const partBId = partB.rows[0]?.id;

      const qualification = await db.execute<{ id: string; status: string }>(sql`
        INSERT INTO facility_qualifications (
          facility_id, part_id, platform_id, platform_variant_id,
          qualification_reference
        ) VALUES (
          ${facilityId}, ${partAId}, ${platformAId}, ${variantId}, 'FAA-REF-0006'
        )
        RETURNING id, status::text
      `);
      const qualificationId = qualification.rows[0]?.id;
      expect(qualification.rows[0]?.status).toBe("draft");

      await expectRejected(sql`
        INSERT INTO facility_qualifications (
          facility_id, part_id, platform_id, platform_variant_id,
          qualification_reference
        ) VALUES (
          ${facilityId}, ${partBId}, ${platformBId}, ${variantId}, 'FAA-BAD-PAIR'
        )
      `);
      await expectRejected(sql`
        INSERT INTO facility_qualifications (
          facility_id, part_id, qualification_reference
        ) VALUES (${facilityId}, ${partBId}, 'FAA-REF-0006')
      `);

      await db.execute(sql`
        INSERT INTO facility_qualifications (facility_id, part_id)
        VALUES (${facilityId}, ${partBId})
      `);
      await expectRejected(sql`
        INSERT INTO facility_qualifications (facility_id, part_id)
        VALUES (${facilityId}, ${partBId})
      `);

      await db.execute(sql`
        INSERT INTO part_alternate_ids (
          part_id, identifier_type, identifier_value, authority
        ) VALUES
          (${partAId}, 'faa_pma', 'alt-0006', NULL),
          (${partBId}, 'faa_pma', 'ALT-0006', NULL)
      `);
      await expectRejected(sql`
        INSERT INTO part_alternate_ids (
          part_id, identifier_type, identifier_value, authority
        ) VALUES (${partAId}, 'faa_pma', 'ALT-0006', NULL)
      `);

      const source = await db.execute<{ id: string }>(sql`
        INSERT INTO data_sources (name, source_type, base_url, publisher, ingestion)
        VALUES (
          'FAA PMA Migration Test Source', 'regulatory_registry',
          'https://drs.faa.gov', 'FAA', 'web_fetch'
        )
        RETURNING id
      `);
      const document = await db.execute<{ id: string }>(sql`
        INSERT INTO source_documents (data_source_id, canonical_url, document_type)
        VALUES (
          ${source.rows[0]?.id},
          'https://drs.faa.gov/browse/excelExternalWindow/DRSDOCID0006',
          'faa_pma'
        )
        RETURNING id
      `);
      const documentId = document.rows[0]?.id;
      await db.execute(sql`
        INSERT INTO source_document_links (
          source_document_id, platform_variant_id, relationship
        ) VALUES (${documentId}, ${variantId}, 'supports')
      `);
      await expectRejected(sql`
        INSERT INTO source_document_links (
          source_document_id, platform_variant_id, relationship
        ) VALUES (${documentId}, ${variantId}, 'supports')
      `);
      await expectRejected(sql`
        INSERT INTO source_document_links (
          source_document_id, platform_id, platform_variant_id, relationship
        ) VALUES (${documentId}, ${platformAId}, ${variantId}, 'supports')
      `);
      await expectRejected(sql`
        INSERT INTO source_document_links (
          source_document_id, facility_qualification_id, relationship
        ) VALUES (${documentId}, gen_random_uuid(), 'supports')
      `);
      await db.execute(sql`
        INSERT INTO source_document_links (
          source_document_id, facility_qualification_id, relationship
        ) VALUES (${documentId}, ${qualificationId}, 'supports')
      `);
    });
  },
);
