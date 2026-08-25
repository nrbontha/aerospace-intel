import type { FaaPmaRecord, FaaPmaScrapeResult } from "@asi/contracts";
import type { Database, HarvestedSourceSignal } from "@asi/database";
import { describe, expect, it, vi } from "vitest";

import {
  FAA_PMA_HARVEST_AGENT_KEY,
  parseHarvestFaaPmaArgs,
  runFaaPmaHarvest,
} from "../scripts/harvest-faa-pma.mts";

const record: FaaPmaRecord = {
  recordId: "1365986",
  guidUrl: "https://drs.faa.gov/browse/excelExternalWindow/DRSDOCID1365986",
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
};

const result: FaaPmaScrapeResult = {
  query: { holderName: "RAM Aerospace", maxRecords: 1 },
  records: [record],
  source: {
    publicUrl: "https://drs.faa.gov/browse/PMA/doctypeDetails",
    scrapedAt: "2026-08-25T12:00:00.000Z",
    retrievalMethod: "guest_browser_dom",
  },
};

function browserReturning(value: FaaPmaScrapeResult) {
  return { search: vi.fn(async () => value) };
}

const fakeDb = {} as Database;

describe("FAA PMA harvest CLI arguments", () => {
  it("defaults to a dry run, the targeted agent key, and a limit of 25", () => {
    expect(parseHarvestFaaPmaArgs(["--holder-name", "RAM Aerospace"]))
      .toEqual({
        query: { holderName: "RAM Aerospace", maxRecords: 25 },
        agentKey: FAA_PMA_HARVEST_AGENT_KEY,
        apply: false,
        refreshExisting: false,
      });
    expect(
      parseHarvestFaaPmaArgs([
        "--part-number=RAM-101-1",
        "--limit=7",
        "--agent-key",
        "manual-faa-agent",
        "--apply",
      ]),
    ).toEqual({
      query: { partNumber: "RAM-101-1", maxRecords: 7 },
      agentKey: "manual-faa-agent",
      apply: true,
      refreshExisting: false,
    });
  });

  it("rejects missing or multiple filters, excessive limits, and invalid mode flags", () => {
    expect(() => parseHarvestFaaPmaArgs([])).toThrow(/targeted filter/iu);
    expect(() =>
      parseHarvestFaaPmaArgs(["--make", "Honeywell", "--model", "HTF7000"]),
    ).toThrow(/exactly one/iu);
    expect(() =>
      parseHarvestFaaPmaArgs(["--holder-number", "PQ1826CE", "--limit", "26"]),
    ).toThrow(/1 through 25/iu);
    expect(() =>
      parseHarvestFaaPmaArgs([
        "--holder-name",
        "RAM Aerospace",
        "--dry-run",
        "--apply",
      ]),
    ).toThrow(/either --dry-run or --apply/iu);
    expect(() =>
      parseHarvestFaaPmaArgs([
        "--holder-name",
        "RAM Aerospace",
        "--refresh-existing",
      ]),
    ).toThrow(/valid only with --apply/iu);
    expect(
      parseHarvestFaaPmaArgs([
        "--holder-name",
        "RAM Aerospace",
        "--apply",
        "--refresh-existing",
      ]),
    ).toMatchObject({ apply: true, refreshExisting: true });
    expect(() =>
      parseHarvestFaaPmaArgs([
        "--holder-name",
        "RAM Aerospace",
        "--output",
        "faa.json",
      ]),
    ).toThrow(/unknown argument/iu);
  });
});

describe("FAA PMA source-signal harvest", () => {
  it("queries the browser once and performs no database work in dry-run mode", async () => {
    const client = browserReturning(result);
    const resolveAgentId = vi.fn(async () => "agent-id");
    const upsertSignal = vi.fn(async () => ({ duplicate: false }));

    await expect(
      runFaaPmaHarvest(
        parseHarvestFaaPmaArgs(["--holder-name", "RAM Aerospace", "--limit", "1"]),
        { client, db: fakeDb, resolveAgentId, upsertSignal },
      ),
    ).resolves.toEqual({
      records: 1,
      created: 0,
      duplicates: 0,
      refreshed: 0,
    });
    expect(client.search).toHaveBeenCalledOnce();
    expect(client.search).toHaveBeenCalledWith({
      holderName: "RAM Aerospace",
      maxRecords: 1,
    });
    expect(resolveAgentId).not.toHaveBeenCalled();
    expect(upsertSignal).not.toHaveBeenCalled();
  });

  it("attaches an optional agent and upserts only source signals on apply", async () => {
    const client = browserReturning(result);
    const resolveAgentId = vi.fn(async () => "faa-agent-id");
    const inputs: HarvestedSourceSignal[] = [];
    const upsertSignal = vi.fn(async (_db: Database, input: HarvestedSourceSignal) => {
      inputs.push(input);
      return { duplicate: false };
    });

    await expect(
      runFaaPmaHarvest(
        parseHarvestFaaPmaArgs(["--holder-name", "RAM Aerospace", "--limit", "1", "--apply"]),
        {
          client,
          db: fakeDb,
          resolveAgentId,
          upsertSignal,
          now: () => new Date("2026-08-25T14:30:00.000Z"),
        },
      ),
    ).resolves.toEqual({
      records: 1,
      created: 1,
      duplicates: 0,
      refreshed: 0,
    });

    expect(resolveAgentId).toHaveBeenCalledWith(
      fakeDb,
      FAA_PMA_HARVEST_AGENT_KEY,
    );
    expect(inputs).toEqual([
      {
        sourceKey: "faa_drs_pma",
        sourceLocator: record.guidUrl,
        agentId: "faa-agent-id",
        rawName: "RAM Aerospace, Inc.",
        city: "St. George",
        state: "UT",
        country: "US",
        awardCount: 0,
        awardValue: 0,
        sourcePayload: {
          record,
          query: result.query,
          source: result.source,
          manualHarvest: { at: "2026-08-25T14:30:00.000Z" },
        },
      },
    ]);
  });

  it("reports duplicate guid records idempotently when no agent exists", async () => {
    const secondRecord: FaaPmaRecord = {
      ...record,
      recordId: "1365987",
      guidUrl:
        "https://drs.faa.gov/browse/excelExternalWindow/DRSDOCID1365987",
    };
    const client = browserReturning({
      ...result,
      query: { holderName: "RAM Aerospace", maxRecords: 2 },
      records: [record, secondRecord],
    });
    const seenAgentIds: Array<string | undefined> = [];
    const upsertSignal = vi.fn(async (_db: Database, input: HarvestedSourceSignal) => {
      seenAgentIds.push(input.agentId);
      return { duplicate: input.sourceLocator === record.guidUrl };
    });
    const refreshSignal = vi.fn(async () => true);

    await expect(
      runFaaPmaHarvest(
        parseHarvestFaaPmaArgs(["--holder-name", "RAM Aerospace", "--limit", "2", "--apply"]),
        {
          client,
          db: fakeDb,
          resolveAgentId: async () => undefined,
          upsertSignal,
          refreshSignal,
        },
      ),
    ).resolves.toEqual({
      records: 2,
      created: 1,
      duplicates: 1,
      refreshed: 0,
    });
    expect(upsertSignal).toHaveBeenCalledTimes(2);
    expect(seenAgentIds).toEqual([undefined, undefined]);
    expect(refreshSignal).not.toHaveBeenCalled();
  });

  it("refreshes official payload and address fields without requeueing terminal state", async () => {
    const refreshedRecord: FaaPmaRecord = {
      ...record,
      fullAddress: "900 New Flight Road\nCedar City, UT 84720\nUnited States",
      renderedSourceText:
        "PMA Holder Name: RAM Aerospace, Inc.\nPMA Holder Physical Address: 900 New Flight Road",
    };
    const client = browserReturning({
      ...result,
      records: [refreshedRecord],
      source: {
        ...result.source,
        scrapedAt: "2026-08-25T15:00:00.000Z",
      },
    });
    let updatePatch: Record<string, unknown> | undefined;
    const returning = vi.fn(async () => [{ id: "existing-signal" }]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn((patch: Record<string, unknown>) => {
      updatePatch = patch;
      return { where };
    });
    const update = vi.fn(() => ({ set }));
    const db = { update } as unknown as Database;
    const existing = {
      status: "qualified",
      qualification: { decision: "qualified", reason: "reviewed" },
      leadId: "lead-existing",
      companyId: "company-existing",
      createdAt: new Date("2026-08-20T00:00:00.000Z"),
      qualifiedAt: new Date("2026-08-21T00:00:00.000Z"),
      rejectedAt: null,
    };

    await expect(
      runFaaPmaHarvest(
        parseHarvestFaaPmaArgs([
          "--holder-name",
          "RAM Aerospace",
          "--limit",
          "1",
          "--apply",
          "--refresh-existing",
        ]),
        {
          client,
          db,
          resolveAgentId: async () => undefined,
          upsertSignal: async () => ({ duplicate: true }),
          now: () => new Date("2026-08-25T15:01:00.000Z"),
        },
      ),
    ).resolves.toEqual({
      records: 1,
      created: 0,
      duplicates: 0,
      refreshed: 1,
    });

    if (updatePatch === undefined) throw new Error("Expected refresh update");
    expect(Object.keys(updatePatch).sort()).toEqual([
      "city",
      "country",
      "rawName",
      "sourcePayload",
      "state",
      "updatedAt",
    ]);
    expect(updatePatch).toMatchObject({
      city: "Cedar City",
      state: "UT",
      country: "US",
      updatedAt: new Date("2026-08-25T15:01:00.000Z"),
    });
    expect(updatePatch.sourcePayload).toMatchObject({
      record: {
        fullAddress: refreshedRecord.fullAddress,
        renderedSourceText: refreshedRecord.renderedSourceText,
      },
      manualHarvest: { at: "2026-08-25T15:01:00.000Z" },
    });
    expect({ ...existing, ...updatePatch }).toMatchObject(existing);
  });
});
