import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { PoolClient } from "pg";

import { closeDatabase, getPool } from "./client.js";

const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);
const advisoryLockKeys: [number, number] = [4_281_161, 1_296_648_018];
const outerBeginPattern = /^\uFEFF?\s*BEGIN(?:\s+(?:WORK|TRANSACTION))?\s*;/i;
const outerCommitPattern = /COMMIT(?:\s+(?:WORK|TRANSACTION))?\s*;\s*$/i;

export interface MigrationSummary {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

interface MigrationFile {
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

function transactionalBody(sql: string, name: string): string {
  const hasOuterBegin = outerBeginPattern.test(sql);
  const hasOuterCommit = outerCommitPattern.test(sql);

  if (hasOuterBegin !== hasOuterCommit) {
    throw new Error(`Migration ${name} has an incomplete outer transaction`);
  }

  if (!hasOuterBegin) {
    return sql;
  }

  return sql.replace(outerBeginPattern, "").replace(outerCommitPattern, "");
}

async function readMigrationFiles(): Promise<MigrationFile[]> {
  const entries = await readdir(migrationsDirectory, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();

  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(resolve(migrationsDirectory, name), "utf8");
      return {
        name,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
}

async function applyMigration(
  client: PoolClient,
  migration: MigrationFile,
): Promise<"applied" | "skipped"> {
  await client.query("BEGIN");

  try {
    const ledgerEntry = await client.query<{ checksum: string }>(
      'SELECT checksum FROM public."_asi_migrations" WHERE migration_name = $1',
      [migration.name],
    );
    const existingChecksum = ledgerEntry.rows[0]?.checksum;

    if (existingChecksum !== undefined) {
      if (existingChecksum !== migration.checksum) {
        throw new Error(
          `Applied migration ${migration.name} no longer matches its recorded checksum`,
        );
      }

      await client.query("COMMIT");
      return "skipped";
    }

    await client.query(transactionalBody(migration.sql, migration.name));
    await client.query(
      'INSERT INTO public."_asi_migrations" (migration_name, checksum) VALUES ($1, $2)',
      [migration.name, migration.checksum],
    );
    await client.query("COMMIT");
    return "applied";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function runMigrations(): Promise<MigrationSummary> {
  const client = await getPool().connect();
  let lockAcquired = false;

  try {
    await client.query(
      "SELECT pg_advisory_lock($1::integer, $2::integer)",
      advisoryLockKeys,
    );
    lockAcquired = true;

    await client.query(`
      CREATE TABLE IF NOT EXISTS public."_asi_migrations" (
        migration_name text PRIMARY KEY,
        checksum varchar(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const migrations = await readMigrationFiles();
    const applied: string[] = [];
    const skipped: string[] = [];

    for (const migration of migrations) {
      const status = await applyMigration(client, migration);
      (status === "applied" ? applied : skipped).push(migration.name);
    }

    return { applied, skipped };
  } finally {
    try {
      if (lockAcquired) {
        await client.query(
          "SELECT pg_advisory_unlock($1::integer, $2::integer)",
          advisoryLockKeys,
        );
      }
    } finally {
      client.release();
    }
  }
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error";
  const databaseUrl = process.env.DATABASE_URL;
  return databaseUrl === undefined || databaseUrl.length === 0
    ? message
    : message.replaceAll(databaseUrl, "[redacted]");
}

async function main(): Promise<void> {
  try {
    const summary = await runMigrations();
    process.stdout.write(
      `Database migrations complete: ${summary.applied.length} applied, ${summary.skipped.length} already applied.\n`,
    );
  } catch (error) {
    process.exitCode = 1;
    process.stderr.write(
      `Database migration failed: ${safeErrorMessage(error)}\n`,
    );
  } finally {
    try {
      await closeDatabase();
    } catch (error) {
      process.exitCode = 1;
      process.stderr.write(
        `Database shutdown failed: ${safeErrorMessage(error)}\n`,
      );
    }
  }
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  pathToFileURL(resolve(entryPoint)).href === import.meta.url
) {
  void main();
}
