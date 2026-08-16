import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;

let pool: Pool | undefined;
let database: Database | undefined;
let closingPool: Promise<void> | undefined;

function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;

  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required to use the database client");
  }

  return databaseUrl;
}

export function getPool(): Pool {
  if (closingPool !== undefined) {
    throw new Error("The database pool is shutting down");
  }

  pool ??= new Pool({ connectionString: requireDatabaseUrl() });
  return pool;
}

export function getDatabase(): Database {
  database ??= drizzle(getPool(), { schema });
  return database;
}

export async function closeDatabase(): Promise<void> {
  if (closingPool !== undefined) {
    await closingPool;
    return;
  }

  const poolToClose = pool;
  if (poolToClose === undefined) {
    return;
  }

  pool = undefined;
  database = undefined;
  closingPool = poolToClose.end();

  try {
    await closingPool;
  } finally {
    closingPool = undefined;
  }
}
