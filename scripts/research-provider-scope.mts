import { parseArgs } from "node:util";

import { instantSchema } from "@asi/contracts"
import {
  closeDatabase,
  createResearchProviderBudgetScope,
  getDatabase,
  importLegacyResearchProviderEstimate,
  readResearchProviderBudgetScope,
  setResearchProviderBudgetPermit,
} from "@asi/database";

import {
  resolveSourceSignalIds,
  runResearchProviderPreflight,
} from "./research-provider-preflight.mjs";

const USAGE = `Usage:
  npm run ops:research-scope -- create --id <scope-id> --starts-at <ISO instant> --total-cap-usd <decimal> (--source-signal-id <uuid> [--source-signal-id <uuid> ...] | --source-signal-ids-file <json-file>) [--provider exa]
  npm run ops:research-scope -- preflight --id <scope-id> --expected-database-host <host> --expected-database-name <name>
  npm run ops:research-scope -- status --id <scope-id>
  npm run ops:research-scope -- activate --id <scope-id>
  npm run ops:research-scope -- pause --id <scope-id>
  npm run ops:research-scope -- close --id <scope-id>
  npm run ops:research-scope -- import-legacy-estimate --utc-day <YYYY-MM-DD> --estimated-cost-usd <decimal> --idempotency-key <key> [--provider exa]

create always creates a paused, sealed, immutable allowance. Reissuing create
with the same definition is idempotent; conflicting cap, start, provider, or
allowlist values are rejected. The JSON file must contain an explicit non-empty
UUID array; it never implies all sources. preflight is read-only and never
contacts a provider. Only activate grants paid provider permission.`;

const parsed = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  strict: true,
  options: {
    help: { type: "boolean", short: "h" },
    id: { type: "string" },
    provider: { type: "string" },
    "starts-at": { type: "string" },
    "total-cap-usd": { type: "string" },
    "source-signal-id": { type: "string", multiple: true },
    "source-signal-ids-file": { type: "string" },
    "utc-day": { type: "string" },
    "estimated-cost-usd": { type: "string" },
    "idempotency-key": { type: "string" },
    "expected-database-host": { type: "string" },
    "expected-database-name": { type: "string" },
  },
});

type OptionName = keyof typeof parsed.values;

function requireOption(name: OptionName): string {
  const value = parsed.values[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`--${name} is required`);
  }
  return value.trim();
}

function rejectUnexpectedOptions(allowed: readonly OptionName[]): void {
  const allowedNames = new Set<OptionName>([...allowed, "help"]);
  for (const [name, value] of Object.entries(parsed.values)) {
    if (value !== undefined && !allowedNames.has(name as OptionName)) {
      throw new Error(`--${name} is not valid for this command`);
    }
  }
}

function requiredCommand(): string {
  if (parsed.positionals.length !== 1) {
    throw new Error("exactly one command is required");
  }
  return parsed.positionals[0]!;
}

function providerOption(): string {
  const provider = parsed.values.provider?.trim() ?? "exa";
  if (provider === "") throw new Error("--provider must not be empty");
  return provider;
}

async function readRequiredScope(id: string) {
  const view = await readResearchProviderBudgetScope(getDatabase(), id);
  if (view === null) throw new Error(`provider budget scope ${id} does not exist`);
  return view;
}

async function run(): Promise<unknown> {
  if (parsed.values.help === true) {
    process.stdout.write(`${USAGE}\n`);
    return undefined;
  }

  const command = requiredCommand();
  switch (command) {
    case "create": {
      rejectUnexpectedOptions([
        "id",
        "provider",
        "starts-at",
        "total-cap-usd",
        "source-signal-id",
        "source-signal-ids-file",
      ]);
      const repeatedSourceSignalIds = parsed.values["source-signal-id"];
      const sourceSignalIdsFile = parsed.values["source-signal-ids-file"];
      const validatedSourceSignalIds = await resolveSourceSignalIds(
        repeatedSourceSignalIds,
        sourceSignalIdsFile,
      );
      await createResearchProviderBudgetScope(getDatabase(), {
        id: requireOption("id"),
        provider: providerOption(),
        startsAt: new Date(instantSchema.parse(requireOption("starts-at"))),
        totalCapUsd: requireOption("total-cap-usd"),
        permitStatus: "paused",
        allowlistedSourceSignalIds: validatedSourceSignalIds,
      });
      return {
        command,
        scope: await readRequiredScope(requireOption("id")),
      };
    }
    case "preflight": {
      rejectUnexpectedOptions([
        "id",
        "expected-database-host",
        "expected-database-name",
      ]);
      const report = await runResearchProviderPreflight({
        database: getDatabase,
        scopeId: requireOption("id"),
        expectedDatabaseHost: requireOption("expected-database-host"),
        expectedDatabaseName: requireOption("expected-database-name"),
      });
      if (report.localChecks === "BLOCKED") process.exitCode = 1;
      return report;
    }
    case "status": {
      rejectUnexpectedOptions(["id"]);
      return { command, scope: await readRequiredScope(requireOption("id")) };
    }
    case "activate":
    case "pause":
    case "close": {
      rejectUnexpectedOptions(["id"]);
      const id = requireOption("id");
      await setResearchProviderBudgetPermit(getDatabase(), id, {
        status:
          command === "activate"
            ? "active"
            : command === "pause"
              ? "paused"
              : "closed",
        observedAt: new Date(),
      });
      return { command, scope: await readRequiredScope(id) };
    }
    case "import-legacy-estimate": {
      rejectUnexpectedOptions([
        "provider",
        "utc-day",
        "estimated-cost-usd",
        "idempotency-key",
      ]);
      const result = await importLegacyResearchProviderEstimate(getDatabase(), {
        provider: providerOption(),
        utcDay: requireOption("utc-day"),
        estimatedCostUsd: requireOption("estimated-cost-usd"),
        idempotencyKey: requireOption("idempotency-key"),
      });
      return { command, ...result };
    }
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

try {
  const result = await run();
  if (result !== undefined) process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown error";
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
