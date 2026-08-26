import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("@asi/database", async () =>
  import("../packages/database/src/index.js"),
);

import { type Database } from "../packages/database/src/index.js";
import { sourceSignalProposalSchema } from "../packages/research/src/signals/harvester.js";
import {
  FAA_PMA_BATCH_SIZE,
  FAA_PMA_DATABASE_SOURCE_KEY,
  FAA_PMA_SIGNAL_MAPPING,
  FAA_PMA_SOURCE_LOCATOR,
  holderToProposal,
  normalizeHolderName,
  parseFaaPmaDatabaseArgs,
  PmaHolderAggregator,
  pmaHolderFingerprint,
  proposalToSignalRow,
  readCsvRowsFromFile,
  runFaaPmaDatabaseImport,
} from "../scripts/parse-faa-pma-database.mts";

const COLUMNS = [
  "Part Name",
  "PMA Holder Name",
  "Supplement Number",
  "Model",
  "City",
  "Address",
  "Make",
  "Country",
  "Zip",
  "Comments",
  "Section",
  "CFR Part",
  "Supplement Date",
  "Approved Replacement for Part Number",
  "FAA Approval Basis",
  "State",
  "Office Of Primary Responsibility",
  "Status",
  "Sub Status",
  "AB Reference",
  "guid",
  "PMA Holder Number",
  "PMA Part Number",
  "Service/Office",
];

const CSV_HEADER = COLUMNS.join(",");

function csvRow(fields: Record<string, string>): string {
  const escape = (value: string): string => `"${value.replaceAll('"', '""')}"`;
  return COLUMNS.map((column) => escape(fields[column] ?? "")).join(",");
}

async function writeFixtureCsv(
  directoryPrefix: string,
  rows: string[],
): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), `${directoryPrefix}-`));
  const file = path.join(directory, "pma.csv");
  await writeFile(file, [CSV_HEADER, ...rows].join("\r\n") + "\r\n", "utf8");
  return file;
}

async function collectRows(
  csvPath: string,
): Promise<Record<string, string>[]> {
  const rows: Record<string, string>[] = [];
  for await (const row of readCsvRowsFromFile(csvPath)) rows.push(row);
  return rows;
}

describe("FAA PMA database aggregation", () => {
  it("deduplicates holders case-insensitively and keeps the richest, freshest fields", async () => {
    const fixture = await writeFixtureCsv("faa-pma-agg", [
      csvRow({
        "PMA Holder Name": "Acme Aero, Inc.",
        Model: "737-800, 737-MAX8",
        City: "Wichita",
        Address: "1 Runway Rd",
        Make: "Boeing",
        Country: "United States",
        Zip: "67201",
        "Supplement Date": "03/15/2021",
        State: "KS",
        guid: "GUIDOLD0001",
      }),
      // Same holder (case/spacing variant); newer record with an empty city.
      csvRow({
        "PMA Holder Name": "ACME  AERO, INC.",
        Model: "787-9",
        City: "",
        Address: "",
        Make: "Boeing",
        Country: "United States",
        Zip: "",
        "Supplement Date": "07/20/2023",
        State: "KS",
        guid: "GUIDNEW0002",
      }),
      // A distinct holder with an unparsable date and no guid.
      csvRow({
        "PMA Holder Name": "Bravo Turbines LLC",
        Model: "A320neo FAMILY",
        City: "Monroe",
        Country: "United States",
        "Supplement Date": "13/45/2020",
        guid: "",
      }),
    ]);

    const aggregator = new PmaHolderAggregator();
    for (const row of await collectRows(fixture)) aggregator.add(row);
    await rm(path.dirname(fixture), { recursive: true, force: true });

    expect(aggregator.stats).toEqual({
      recordsParsed: 3,
      recordsWithoutHolderName: 0,
    });
    const holders = aggregator.finish();
    expect(holders.map((holder) => holder.rawName)).toEqual([
      "ACME  AERO, INC.",
      "Bravo Turbines LLC",
    ]);

    const [acme, bravo] = holders;
    expect(acme!.partCount).toBe(2);
    expect(acme!.city).toBe("Wichita"); // backfilled from the older record
    expect(acme!.state).toBe("KS");
    expect(acme!.address).toBe("1 Runway Rd");
    expect(acme!.zip).toBe("67201");
    expect(acme!.country).toBe("United States");
    expect(acme!.makes).toEqual(["Boeing"]);
    expect(acme!.modelsSample).toEqual(["737-800", "737-MAX8", "787-9"]);
    expect(acme!.latestSupplementDate).toBe("2023-07-20");
    expect(acme!.guidUrl).toBe(
      "https://drs.faa.gov/browse/excelExternalWindow/GUIDNEW0002",
    );
    expect(bravo!.partCount).toBe(1);
    expect(bravo!.latestSupplementDate).toBeNull();
    expect(bravo!.guidUrl).toBeNull();
  });

  it("caps the model sample at ten unique entries and counts blank holder names", () => {
    const aggregator = new PmaHolderAggregator();
    aggregator.add({
      "PMA Holder Name": "Sample Cap Co",
      Model: Array.from({ length: 12 }, (_, index) => `M${index + 1}`).join(", "),
      "Supplement Date": "01/02/2019",
    });
    aggregator.add({ "PMA Holder Name": "", "Supplement Date": "01/02/2019" });

    const [holder] = aggregator.finish();
    expect(holder!.modelsSample).toHaveLength(10);
    expect(holder!.modelsSample[9]).toBe("M10");
    expect(aggregator.stats.recordsWithoutHolderName).toBe(1);
  });
});

describe("FAA PMA proposals", () => {
  it("emits schema-valid SourceSignalProposal objects keyed on the holder name", () => {
    const aggregator = new PmaHolderAggregator();
    aggregator.add({
      "PMA Holder Name": "Acme Aero, Inc.",
      City: "Wichita",
      State: "KS",
      Country: "United States",
      Zip: "67201",
      Address: "1 Runway Rd",
      Make: "Boeing",
      Model: "737-800",
      "Supplement Date": "07/20/2023",
      guid: "GUIDNEW0002",
    });
    const built = holderToProposal(aggregator.finish()[0]!);

    const parsed = sourceSignalProposalSchema.parse(built);
    expect(parsed.sourceKey).toBe(FAA_PMA_DATABASE_SOURCE_KEY);
    expect(parsed.sourceLocator).toBe(FAA_PMA_SOURCE_LOCATOR);
    expect(parsed.rawName).toBe("Acme Aero, Inc.");
    expect(parsed.city).toBe("Wichita");
    expect(parsed.awardCount).toBe(1);
    expect(parsed.freshestAward).toBe("2023-07-20T00:00:00.000Z");
    expect(parsed.sourceFingerprint).toBe(
      createHash("sha256")
        .update(`${FAA_PMA_DATABASE_SOURCE_KEY}:acme aero, inc.`, "utf8")
        .digest("hex"),
    );
    expect(
      pmaHolderFingerprint(FAA_PMA_DATABASE_SOURCE_KEY, " ACME   AERO, INC. "),
    ).toBe(parsed.sourceFingerprint);

    const row = proposalToSignalRow(built);
    expect(row.holder_name).toBe("Acme Aero, Inc.");
    expect(row.part_count).toBe(1);
    expect(row.latest_supplement_date).toBe("2023-07-20T00:00:00.000Z");
    expect(row.city).toBe("Wichita");
    expect(row.state).toBe("KS");
    expect(row.country).toBe("United States");
    expect(row.makes).toEqual(["Boeing"]);
    expect(row.guid_url).toContain("GUIDNEW0002");
    for (const mapped of Object.values(FAA_PMA_SIGNAL_MAPPING)) {
      expect(mapped in row).toBe(true);
    }
  });
});

interface RecordedBatch {
  readonly sourceKey: string;
  readonly sourceLocator: string;
  readonly rows: readonly Record<string, unknown>[];
  readonly mapping: unknown;
  readonly dryRun?: boolean;
}

function recordingIngest() {
  const batches: RecordedBatch[] = [];
  return {
    batches,
    ingest: async (_db: Database, input: RecordedBatch) => {
      batches.push(input);
      return {
        created: input.rows.length,
        duplicate: 0,
        rejected: 0,
        rowErrors: [],
        dryRun: input.dryRun === true,
      };
    },
  };
}

async function copyFixtureToTarget(
  fixture: string,
  _accdbPath: string,
  csvPath: string,
): Promise<void> {
  await writeFile(csvPath, await readFile(fixture));
}

async function writeHolderFixture(holderCount: number): Promise<string> {
  const rows: string[] = [];
  for (let index = 0; index < holderCount; index += 1) {
    rows.push(
      csvRow({
        "PMA Holder Name":
          index === 0
            ? "Golden Aero Works"
            : `Holder ${String(index).padStart(5, "0")} Inc`,
        "Supplement Date": "05/02/2019",
        guid: `GUID${index}`,
      }),
    );
  }
  return writeFixtureCsv("faa-pma-run", rows);
}

describe("FAA PMA database import run", () => {
  it("skips known holders and batches inserts through ingestSourceSignalBatch", async () => {
    const fixture = await writeHolderFixture(1205);
    const { batches, ingest } = recordingIngest();
    try {
      const summary = await runFaaPmaDatabaseImport(
        { dataDir: "/unused", limit: 0, dryRun: false, skipKnown: true },
        {
          db: {} as Database,
          listAccdbFiles: async () => ["/fake/PMA_fromJan012010.accdb"],
          exportCsv: (accdbPath, csvPath) =>
            copyFixtureToTarget(fixture, accdbPath, csvPath),
          loadKnownHolderNames: async () =>
            new Set([normalizeHolderName("Golden Aero Works")]),
          ingestBatch: ingest,
        },
      );

      expect(summary.totalUniqueHolders).toBe(1205);
      expect(summary.skippedKnown).toBe(1);
      expect(summary.emitted).toBe(1204);
      expect(summary.created).toBe(1204);
      expect(summary.rejected).toBe(0);
      expect(batches.map((batch) => batch.rows.length)).toEqual([
        FAA_PMA_BATCH_SIZE,
        FAA_PMA_BATCH_SIZE,
        1204 - 2 * FAA_PMA_BATCH_SIZE,
      ]);
      for (const batch of batches) {
        expect(batch.sourceKey).toBe(FAA_PMA_DATABASE_SOURCE_KEY);
        expect(batch.sourceLocator).toBe(FAA_PMA_SOURCE_LOCATOR);
        expect(batch.mapping).toEqual(FAA_PMA_SIGNAL_MAPPING);
        expect(
          batch.rows.every((row) => typeof row.holder_name === "string"),
        ).toBe(true);
      }
      expect(
        batches.some((batch) =>
          batch.rows.some((row) => row.holder_name === "Golden Aero Works"),
        ),
      ).toBe(false);
    } finally {
      await rm(path.dirname(fixture), { recursive: true, force: true });
    }
  });

  it("applies --limit and validates without persistence on dry runs", async () => {
    const fixture = await writeHolderFixture(7);
    const { batches, ingest } = recordingIngest();
    try {
      const summary = await runFaaPmaDatabaseImport(
        { dataDir: "/unused", limit: 3, dryRun: true, skipKnown: false },
        {
          listAccdbFiles: async () => ["/fake/PMA.accdb"],
          exportCsv: (accdbPath, csvPath) =>
            copyFixtureToTarget(fixture, accdbPath, csvPath),
          ingestBatch: ingest,
        },
      );

      expect(summary.totalUniqueHolders).toBe(7);
      expect(summary.emitted).toBe(3);
      expect(summary.created).toBe(3);
      expect(summary.mode).toBe("dry-run");
      expect(batches).toHaveLength(1);
      expect(batches[0]!.dryRun).toBe(true);
      // Sorted by normalized name: "Golden Aero Works" sorts before "Holder …".
      expect(batches[0]!.rows[0]).toMatchObject({
        holder_name: "Golden Aero Works",
      });
    } finally {
      await rm(path.dirname(fixture), { recursive: true, force: true });
    }
  });
});

describe("FAA PMA parse CLI arguments", () => {
  it("defaults to /tmp/pma-parse, unlimited, apply mode without known-skip", () => {
    expect(parseFaaPmaDatabaseArgs([])).toEqual({
      dataDir: "/tmp/pma-parse",
      limit: 0,
      dryRun: false,
      skipKnown: false,
    });
    expect(
      parseFaaPmaDatabaseArgs([
        "--data-dir",
        "/tmp/other",
        "--limit",
        "25",
        "--dry-run",
        "--skip-known",
      ]),
    ).toEqual({
      dataDir: "/tmp/other",
      limit: 25,
      dryRun: true,
      skipKnown: true,
    });
  });

  it("rejects unknown flags and malformed limits", () => {
    expect(() => parseFaaPmaDatabaseArgs(["--bogus"])).toThrow(/unknown/i);
    expect(() => parseFaaPmaDatabaseArgs(["--limit", "-1"])).toThrow(
      /non-negative/i,
    );
    expect(() => parseFaaPmaDatabaseArgs(["--limit"])).toThrow(
      /requires a value/i,
    );
    expect(() => parseFaaPmaDatabaseArgs(["--data-dir"])).toThrow(
      /requires a value/i,
    );
  });
});
