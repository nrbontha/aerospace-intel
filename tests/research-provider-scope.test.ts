import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  cohortCoversPaidTargets,
  configuredJevCohort,
  readSourceSignalIdFile,
  resolveSourceSignalIds,
  runResearchProviderPreflight,
} from "../scripts/research-provider-preflight.mjs";

const SOURCE_A = "00000000-0000-4000-8000-000000000001";
const SOURCE_B = "00000000-0000-4000-8000-000000000002";
const SOURCE_C = "00000000-0000-4000-8000-000000000003";
const temporaryDirectories: string[] = [];

async function temporaryJson(value: unknown): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "asi-provider-scope-"));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, "cohort.json");
  await writeFile(filePath, JSON.stringify(value), "utf8");
  return filePath;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("research provider cohort input", () => {
  it("loads a non-empty UUID array and deduplicates file members", async () => {
    const filePath = await temporaryJson([SOURCE_A, SOURCE_B, SOURCE_A]);

    await expect(readSourceSignalIdFile(filePath)).resolves.toEqual([
      SOURCE_A,
      SOURCE_B,
    ]);
  });

  it.each([
    ["an empty array", []],
    ["a non-array", { sourceSignalIds: [SOURCE_A] }],
    ["a non-string member", [SOURCE_A, 7]],
    ["an invalid UUID", [SOURCE_A, "not-a-uuid"]],
  ])("rejects %s in a cohort file", async (_label, contents) => {
    const filePath = await temporaryJson(contents);

    await expect(readSourceSignalIdFile(filePath)).rejects.toThrow();
  });

  it("requires exactly one repeated-ID or file input mode", async () => {
    const filePath = await temporaryJson([SOURCE_A]);

    await expect(
      resolveSourceSignalIds([SOURCE_A], filePath),
    ).rejects.toThrow(/mutually exclusive/iu);
    await expect(resolveSourceSignalIds(undefined, undefined)).rejects.toThrow(
      /is required/iu,
    );
    await expect(resolveSourceSignalIds([SOURCE_A], undefined)).resolves.toEqual(
      [SOURCE_A],
    );
  });

  it("allows full cheap Jev or an explicit superset without enlarging paid scope", () => {
    const fullCheapCohort = configuredJevCohort(undefined);
    const explicitSuperset = configuredJevCohort(
      `${SOURCE_A},${SOURCE_B},${SOURCE_C}`,
    );

    expect(cohortCoversPaidTargets(fullCheapCohort, [SOURCE_A, SOURCE_B])).toBe(
      true,
    );
    expect(cohortCoversPaidTargets(explicitSuperset, [SOURCE_A, SOURCE_B])).toBe(
      true,
    );
  });

  it("covers sealed paid targets across UUID case variants", () => {
    const caseVariantSource = "aabbccdd-abcd-4abc-8abc-aabbccddeeff";
    const caseDistinctRuntimeEntries = configuredJevCohort(
      caseVariantSource.toUpperCase(),
    );

    expect(caseDistinctRuntimeEntries.valid).toBe(true);
    expect(
      cohortCoversPaidTargets(caseDistinctRuntimeEntries, [caseVariantSource]),
    ).toBe(true);
  });

  it("rejects explicit cohorts that prevent a sealed paid target's Jev recheck", () => {
    const explicitEmpty = configuredJevCohort("");
    const excludingList = configuredJevCohort(SOURCE_A);

    expect(cohortCoversPaidTargets(explicitEmpty, [SOURCE_A])).toBe(false);
    expect(cohortCoversPaidTargets(excludingList, [SOURCE_A, SOURCE_B])).toBe(
      false,
    );
  });

  it("mirrors runtime UUID-list rejection without normalizing membership", () => {
    expect(configuredJevCohort(`${SOURCE_A},${SOURCE_A}`).valid).toBe(false);
    expect(configuredJevCohort(`${SOURCE_A},not-a-uuid`).valid).toBe(false);
  });
});

describe("research provider preflight decisions", () => {
  it("refuses a mismatched database target before connecting and never reports secrets", async () => {
    let databaseCalled = false;
    const report = await runResearchProviderPreflight({
      database: () => {
        databaseCalled = true;
        throw new Error("must not connect");
      },
      scopeId: "approved-cohort",
      expectedDatabaseHost: "expected.internal",
      expectedDatabaseName: "asi",
      env: {
        DATABASE_URL:
          "postgresql://private-user:database-secret@actual.internal:5432/asi",
        FAA_ANALYST_MODE: "bounded_paid",
        EXA_BUDGET_SCOPE_ID: "approved-cohort",
        EXA_DAILY_BUDGET_USD: "5",
        OPENROUTER_MAX_COST_PER_DAY_USD: "",
        EXA_API_KEY: "exa-secret",
        OPENROUTER_API_KEY: "openrouter-secret",
      },
    });
    const serialized = JSON.stringify(report);

    expect(databaseCalled).toBe(false);
    expect(report.localChecks).toBe("BLOCKED");
    expect(
      report.blockers.some((blocker) =>
        /configured database host.*expected-database-host/iu.test(blocker),
      ),
    ).toBe(true);
    expect(serialized).not.toContain("private-user");
    expect(serialized).not.toContain("database-secret");
    expect(serialized).not.toContain("exa-secret");
    expect(serialized).not.toContain("openrouter-secret");
  });
});

