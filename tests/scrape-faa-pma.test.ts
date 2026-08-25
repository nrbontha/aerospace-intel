import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { FaaPmaScrapeResult } from "@asi/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  parseScrapeFaaPmaArgs,
  runFaaPmaScrape,
  type FaaPmaScrapeClient,
} from "../scripts/scrape-faa-pma.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

const sampleResult: FaaPmaScrapeResult = {
  query: { holderName: "RAM Aerospace", maxRecords: 1 },
  records: [
    {
      recordId: "1365986",
      guidUrl:
        "https://drs.faa.gov/browse/excelExternalWindow/DRSDOCID1365986",
      status: "Active",
      subStatus: "Current",
      holderName: "RAM Aerospace, Inc.",
      holderNumber: "PQ1826CE",
      fullAddress: "1450 Aviation Drive\nSt. George, UT 84790\nUnited States",
      pmaPartNumber: "RAM-101-1",
      partName: "Bleed Air Valve",
      replacementPartNumber: "3215612-4",
      make: "Honeywell",
      models: ["AS907-2-1G"],
      supplementNumber: "12",
      supplementDate: "2024-04-18",
      approvalBasis: "Test and computation per 14 CFR 21.303",
      serviceOffice: "Denver ACO Branch",
      opr: "AIR-780",
      cfrReferences: ["14 CFR 21.303"],
      comments: null,
      renderedSourceText: "PMA Holder Name: RAM Aerospace, Inc.",
    },
  ],
  source: {
    publicUrl: "https://drs.faa.gov/browse/PMA/doctypeDetails",
    scrapedAt: "2026-08-25T12:00:00.000Z",
    retrievalMethod: "guest_browser_dom",
  },
};

describe("scrape-faa-pma argument parsing", () => {
  it("builds one targeted query with a default limit of 25", () => {
    expect(parseScrapeFaaPmaArgs(["--holder-name", "RAM Aerospace"]))
      .toEqual({
        query: { holderName: "RAM Aerospace", maxRecords: 25 },
      });
    expect(
      parseScrapeFaaPmaArgs([
        "--part-number=RAM-101-1",
        "--limit=7",
        "--output",
        "out/ram.json",
      ]),
    ).toEqual({
      query: { partNumber: "RAM-101-1", maxRecords: 7 },
      outputPath: "out/ram.json",
    });
  });

  it("rejects broad, multiple-filter, over-limit, and ingest invocations", () => {
    expect(() => parseScrapeFaaPmaArgs([])).toThrow(/targeted filter/iu);
    expect(() =>
      parseScrapeFaaPmaArgs([
        "--make",
        "Honeywell",
        "--model",
        "HTF7000",
      ]),
    ).toThrow(/exactly one/iu);
    expect(() =>
      parseScrapeFaaPmaArgs(["--holder-number", "PQ1826CE", "--limit", "26"]),
    ).toThrow(/1 through 25/iu);
    expect(() =>
      parseScrapeFaaPmaArgs(["--holder-name", "RAM", "--ingest"]),
    ).toThrow(/unknown argument/iu);
  });
});

describe("scrape-faa-pma cache and JSON output", () => {
  it("reuses a query-hash cache for 24 hours and writes the requested JSON path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "faa-pma-cli-"));
    temporaryDirectories.push(root);
    let searches = 0;
    const client: FaaPmaScrapeClient = {
      async search() {
        searches += 1;
        return sampleResult;
      },
    };
    const options = parseScrapeFaaPmaArgs([
      "--holder-name",
      "RAM Aerospace",
      "--limit",
      "1",
      "--output",
      path.join(root, "first.json"),
    ]);

    const first = await runFaaPmaScrape(options, {
      client,
      cacheDirectory: path.join(root, "cache"),
      now: () => new Date("2026-08-25T12:00:00.000Z"),
    });
    const second = await runFaaPmaScrape(
      { ...options, outputPath: path.join(root, "second.json") },
      {
        client,
        cacheDirectory: path.join(root, "cache"),
        now: () => new Date("2026-08-26T11:59:59.999Z"),
      },
    );

    expect(searches).toBe(1);
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.cachePath).toBe(first.cachePath);
    expect(JSON.parse(await readFile(second.outputPath, "utf8"))).toEqual(
      sampleResult,
    );
  });

  it("refreshes a cached query at the 24-hour boundary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "faa-pma-expiry-"));
    temporaryDirectories.push(root);
    let searches = 0;
    const client: FaaPmaScrapeClient = {
      async search() {
        searches += 1;
        return sampleResult;
      },
    };
    const options = parseScrapeFaaPmaArgs([
      "--holder-name",
      "RAM Aerospace",
      "--limit",
      "1",
      "--output",
      path.join(root, "result.json"),
    ]);
    const cacheDirectory = path.join(root, "cache");

    await runFaaPmaScrape(options, {
      client,
      cacheDirectory,
      now: () => new Date("2026-08-25T12:00:00.000Z"),
    });
    const refreshed = await runFaaPmaScrape(options, {
      client,
      cacheDirectory,
      now: () => new Date("2026-08-26T12:00:00.000Z"),
    });

    expect(searches).toBe(2);
    expect(refreshed.cacheHit).toBe(false);
  });
});
