import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as XLSX from "xlsx";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@asi/database", async () =>
  import("../packages/database/src/index.js"),
);

import {
  ingestSourceSignalBatch,
  sourceSignals,
  SOURCE_SIGNAL_BATCH_MAX_ROWS,
  type Database,
} from "../packages/database/src/index.js";
import {
  parseImportSourceSignalArgs,
  runSourceSignalImport,
  SOURCE_SIGNAL_IMPORT_METADATA_KEY,
} from "../scripts/import-source-signals.js";

interface StoredSignal {
  readonly sourceFingerprint: string;
  readonly rawName: string;
  readonly rawDomain?: string;
  readonly sourcePayload: Record<string, unknown>;
  readonly [key: string]: unknown;
}

class SourceSignalDatabaseFake {
  readonly signals: StoredSignal[] = [];
  readonly insertedTables: unknown[] = [];
  readonly fingerprints = new Set<string>();

  insert(table: unknown) {
    this.insertedTables.push(table);
    if (table !== sourceSignals) {
      throw new Error("Importer attempted to create a non-source-signal record");
    }
    return {
      values: (value: StoredSignal) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (this.fingerprints.has(value.sourceFingerprint)) return [];
            this.fingerprints.add(value.sourceFingerprint);
            this.signals.push(value);
            return [value];
          },
        }),
      }),
    };
  }
}

const tempDirectories: string[] = [];
const importedAt = new Date("2026-08-24T12:00:00.000Z");

async function fixturePath(name: string, content: string | Uint8Array): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "source-signal-import-"));
  tempDirectories.push(directory);
  const file = path.join(directory, name);
  await writeFile(file, content);
  return file;
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe("import-source-signals", () => {
  it("imports CSV rows, preserves unmapped payload and provenance, and is fingerprint-idempotent", async () => {
    const file = await fixturePath(
      "suppliers.csv",
      "Company Name,Website,City,Notes\nAcme Aero,acme.example,Wichita,AS9100 certified\n",
    );
    const fake = new SourceSignalDatabaseFake();
    const options = {
      file,
      sourceKey: "analyst-list",
      mapping: {
        name: "Company Name",
        domain: "Website",
        city: "City",
      },
      apply: true,
    } as const;

    const first = await runSourceSignalImport(fake as unknown as Database, options, importedAt);
    const replay = await runSourceSignalImport(fake as unknown as Database, options, importedAt);

    expect(first.result).toMatchObject({ created: 1, duplicate: 0, rejected: 0 });
    expect(replay.result).toMatchObject({ created: 0, duplicate: 1, rejected: 0 });
    expect(fake.signals).toHaveLength(1);
    expect(fake.signals[0]).toMatchObject({
      rawName: "Acme Aero",
      rawDomain: "acme.example",
      sourcePayload: {
        notes: "AS9100 certified",
        [SOURCE_SIGNAL_IMPORT_METADATA_KEY]: {
          fileSha256: first.fileSha256,
          sheet: null,
          row: 2,
          importedAt: importedAt.toISOString(),
        },
      },
    });
    expect(fake.signals[0]!.sourcePayload).not.toHaveProperty("company_name");
    expect(fake.insertedTables.every((table) => table === sourceSignals)).toBe(true);
  });

  it("imports a JSON array into source signals and reports missing names by row", async () => {
    const file = await fixturePath(
      "suppliers.json",
      JSON.stringify([
        { legalName: "Orbital Forge", uei: "UEI-123", confidence: 0.92 },
        { legalName: "", uei: "UEI-EMPTY", confidence: 0.1 },
      ]),
    );
    const fake = new SourceSignalDatabaseFake();

    const run = await runSourceSignalImport(
      fake as unknown as Database,
      {
        file,
        sourceKey: "portfolio-json",
        mapping: { name: "legalName", uei: "uei" },
        apply: true,
      },
      importedAt,
    );

    expect(run.result).toMatchObject({ created: 1, duplicate: 0, rejected: 1 });
    expect(run.rowErrors).toEqual([{ row: 2, error: "Missing required name" }]);
    expect(fake.signals[0]!.sourcePayload).toMatchObject({
      confidence: 0.92,
      [SOURCE_SIGNAL_IMPORT_METADATA_KEY]: {
        fileSha256: run.fileSha256,
        row: 1,
        importedAt: importedAt.toISOString(),
      },
    });
  });

  it("imports only the first XLSX sheet and retains sheet and workbook-row provenance", async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["Supplier", "CAGE", "Country", "Raw Rating"],
        ["Vector Components", "1A2B3", "US", "A"],
      ]),
      "Selected Suppliers",
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["Supplier"],
        ["Must Not Import"],
      ]),
      "Ignored",
    );
    const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    const file = await fixturePath("suppliers.xlsx", bytes);
    const fake = new SourceSignalDatabaseFake();

    const run = await runSourceSignalImport(
      fake as unknown as Database,
      {
        file,
        sourceKey: "workbook-list",
        mapping: {
          name: "Supplier",
          cage: "CAGE",
          country: "Country",
        },
        apply: true,
      },
      importedAt,
    );

    expect(run).toMatchObject({ format: "xlsx", sheet: "Selected Suppliers" });
    expect(run.result).toMatchObject({ created: 1, duplicate: 0, rejected: 0 });
    expect(fake.signals.map((signal) => signal.rawName)).toEqual(["Vector Components"]);
    expect(fake.signals[0]!.sourcePayload).toMatchObject({
      "Raw Rating": "A",
      [SOURCE_SIGNAL_IMPORT_METADATA_KEY]: {
        sheet: "Selected Suppliers",
        row: 2,
        importedAt: importedAt.toISOString(),
      },
    });
  });

  it("defaults to dry-run and performs no source-signal or lead writes", async () => {
    const file = await fixturePath(
      "dry-run.json",
      JSON.stringify([{ name: "Dry Run Aerospace", extra: "retained" }]),
    );
    const fake = new SourceSignalDatabaseFake();
    const options = parseImportSourceSignalArgs([
      "--file",
      file,
      "--source-key",
      "dry-run-list",
      "--name-column",
      "name",
    ]);
    expect(options.apply).toBe(false);

    const run = await runSourceSignalImport(
      fake as unknown as Database,
      options,
      importedAt,
    );

    expect(run.result).toMatchObject({
      created: 1,
      duplicate: 0,
      rejected: 0,
      dryRun: true,
    });
    expect(fake.signals).toHaveLength(0);
    expect(fake.insertedTables).toHaveLength(0);
  });

  it("rejects batches over 100,000 rows before persistence with a clear report", async () => {
    const fake = new SourceSignalDatabaseFake();
    const rows = Array.from(
      { length: SOURCE_SIGNAL_BATCH_MAX_ROWS + 1 },
      (_, index) => ({ name: `Supplier ${index}` }),
    );

    await expect(
      ingestSourceSignalBatch(fake as unknown as Database, {
        sourceKey: "oversized",
        sourceLocator: "file:///oversized.json",
        rows,
        mapping: { name: "name" },
        dryRun: true,
      }),
    ).rejects.toThrow("limited to 100,000 rows; received 100,001");
    expect(fake.insertedTables).toHaveLength(0);
  });
});
