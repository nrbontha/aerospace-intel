import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import type { InvestorReferenceSet } from "@asi/contracts";
import {
  closeDatabase,
  getDatabase,
  importInvestorReferenceSet,
} from "@asi/database";
import { currentFaaReviewInputContract } from "@asi/research";

const USAGE = `Usage:
  DATABASE_URL=postgresql://... npx tsx scripts/investor-picks.mts \\
    --set golden --expected-host <host> \\
    --expected-database <database> --apply

Atomically imports the stored Golden collection from the immutable Golden18 and
Booie29 reference snapshots. The command never loads local environment files.
--apply, destination host, and destination database are all required before it
opens a database connection.`;

export interface InvestorPicksCliOptions {
  readonly set: InvestorReferenceSet;
  readonly expectedHost: string;
  readonly expectedDatabase: string;
}

export function parseInvestorPicksCliOptions(
  args: string[],
): InvestorPicksCliOptions {
  const parsed = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      set: { type: "string" },
      "expected-host": { type: "string" },
      "expected-database": { type: "string" },
      apply: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (parsed.values.help === true) throw new Error(USAGE);
  if (parsed.values.apply !== true) {
    throw new Error("--apply is required before importing investor picks");
  }

  const set = parsed.values.set?.trim();
  if (set !== "golden") {
    throw new Error("--set must be golden");
  }

  const expectedHost = parsed.values["expected-host"]?.trim();
  if (expectedHost === undefined || expectedHost.length === 0) {
    throw new Error("--expected-host is required");
  }

  const expectedDatabase = parsed.values["expected-database"]?.trim();
  if (expectedDatabase === undefined || expectedDatabase.length === 0) {
    throw new Error("--expected-database is required");
  }

  return { set, expectedHost, expectedDatabase };
}

export function validateInvestorPicksDestination(
  databaseUrl: string | undefined,
  expectedHost: string,
  expectedDatabase: string,
): void {
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new Error("DATABASE_URL must be explicitly set");
  }

  let destination: URL;
  try {
    destination = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL");
  }
  if (
    destination.protocol !== "postgres:" &&
    destination.protocol !== "postgresql:"
  ) {
    throw new Error("DATABASE_URL must use the postgres or postgresql protocol");
  }
  for (const parameter of destination.searchParams.keys()) {
    if (parameter.toLowerCase() === "host") {
      throw new Error("DATABASE_URL query host overrides are not allowed");
    }
  }

  let database: string;
  try {
    database = decodeURIComponent(destination.pathname).replace(/^\//u, "");
  } catch {
    throw new Error("DATABASE_URL must include a valid database name");
  }
  if (database.length === 0 || database.includes("/")) {
    throw new Error("DATABASE_URL must include exactly one database name");
  }
  if (destination.hostname !== expectedHost.toLowerCase()) {
    throw new Error(
      `DATABASE_URL host ${destination.hostname} does not match --expected-host ${expectedHost}`,
    );
  }
  if (database !== expectedDatabase) {
    throw new Error(
      `DATABASE_URL database ${database} does not match --expected-database ${expectedDatabase}`,
    );
  }
}

async function main(): Promise<void> {
  const options = parseInvestorPicksCliOptions(process.argv.slice(2));
  validateInvestorPicksDestination(
    process.env.DATABASE_URL,
    options.expectedHost,
    options.expectedDatabase,
  );

  try {
    const result = await importInvestorReferenceSet(getDatabase(), {
      set: options.set,
      actor: { kind: "system", label: "investor-picks-cli" },
      expectedReviewInputContract: currentFaaReviewInputContract(),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await closeDatabase();
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
