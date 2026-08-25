import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ExaSearchResult } from "../search/exa.js";
import type { SamEntity } from "../sources/sam.js";
import {
  buildExaCompanyListQuery,
  EXA_COMPANY_LIST_MAX_RESULTS_PER_QUERY,
  ExaCompanyListHarvester,
} from "./exa-harvester.js";
import {
  fingerprintSamEntity,
  SamEntityHarvester,
  samEntityHarvesterConfigSchema,
} from "./sam-harvester.js";
import {
  parseSourceHarvestOptions,
  sourceSignalProposalSchema,
  type SourceHarvester,
} from "./harvester.js";
import {
  DuplicateSourceHarvesterError,
  SourceHarvesterRegistry,
} from "./registry.js";

function exaResult(
  title: string,
  url: string,
  score = 0.5,
): ExaSearchResult {
  return { title, url, text: `${title} manufactures aerospace components`, score };
}

function samEntity(
  uei: string,
  overrides: Partial<SamEntity> = {},
): SamEntity {
  return {
    legalName: `Entity ${uei}`,
    uei,
    cageCode: null,
    officialUrl: null,
    officialDomain: null,
    addressLine1: null,
    addressLine2: null,
    city: "Wichita",
    state: "KS",
    zip: null,
    country: "USA",
    registrationStatus: "Active",
    exclusionStatusFlag: false,
    primaryNaics: {
      code: "336413",
      description: "Aircraft parts",
      sbaSmallBusiness: true,
    },
    naics: [
      {
        code: "336413",
        description: "Aircraft parts",
        sbaSmallBusiness: true,
      },
    ],
    psc: [],
    entityTypeHints: [],
    businessTypeHints: [],
    ownershipHints: [],
    parentUei: null,
    matchedNaicsCodes: ["336413"],
    sourceLocator: `sam://entity-information/v4/entities/${uei}?naics=336413`,
    raw: {
      entityRegistration: {
        ueiSAM: uei,
        legalBusinessName: `Entity ${uei}`,
        registrationStatus: "Active",
        exclusionStatusFlag: false,
      },
      assertions: {
        goodsAndServices: {
          primaryNaics: "336413",
        },
      },
    },
    ...overrides,
  };
}

function stubHarvester(id: string): SourceHarvester<{ key: string }> {
  return {
    id,
    configSchema: z.strictObject({ key: z.string() }),
    async harvest() {
      return {
        signals: [],
        metrics: {
          fetched: 0,
          emitted: 0,
          rejected: 0,
          duplicateCandidates: 0,
        },
      };
    },
  };
}

describe("source harvester contract", () => {
  it("strictly accepts proposals rather than visible lead records", () => {
    const proposal = {
      sourceKey: "fixture",
      sourceLocator: "fixture.csv#row=2",
      sourceFingerprint: "stable-fingerprint",
      rawName: "Fixture Components",
      sourcePayload: { row: 2 },
    };

    expect(sourceSignalProposalSchema.parse(proposal)).toEqual(proposal);
    expect(
      sourceSignalProposalSchema.safeParse({
        ...proposal,
        leadId: "2ad1aa3c-f122-4d68-b653-ddb67c8c02bf",
      }).success,
    ).toBe(false);
    expect(
      sourceSignalProposalSchema.safeParse({ ...proposal, awardCount: -1 }).success,
    ).toBe(false);
  });

  it("enforces the shared hard cap and lower adapter caps", () => {
    expect(() => parseSourceHarvestOptions({ limit: 51 })).toThrow();
    expect(() => parseSourceHarvestOptions({ limit: 26 }, 25)).toThrow();
    expect(parseSourceHarvestOptions({ limit: 25 }, 25).limit).toBe(25);
  });
});

describe("SourceHarvesterRegistry", () => {
  it("registers, looks up, and lists adapters while rejecting duplicate ids", () => {
    const registry = new SourceHarvesterRegistry();
    const first = stubHarvester("fixture");
    const second = stubHarvester("other");

    registry.register(first).register(second);

    expect(registry.lookup("fixture")).toBe(first);
    expect(registry.lookup("missing")).toBeUndefined();
    expect(registry.list()).toEqual([first, second]);
    expect(() => registry.register(stubHarvester("fixture"))).toThrow(
      DuplicateSourceHarvesterError,
    );
  });
});

describe("ExaCompanyListHarvester", () => {
  it("encodes the golden archetype and optional query metadata", () => {
    const query = buildExaCompanyListQuery("landing gear suppliers", {
      geography: "Ohio",
      product: "actuators",
      platform: "Boeing 737",
    });

    expect(query).toContain("United States");
    expect(query).toContain("aerospace/defense");
    expect(query).toContain("engineered component");
    expect(query).toContain("manufacturer");
    for (const qualifier of ["PMA", "proprietary", "AS9100", "qualified"]) {
      expect(query).toContain(qualifier);
    }
    expect(query).toContain('geography "Ohio"');
    expect(query).toContain('product "actuators"');
    expect(query).toContain('platform "Boeing 737"');
  });

  it("emits weak proposals with provenance and stable per-query dedupe", async () => {
    const search = vi.fn(async (query: string) => {
      expect(query).toContain("precision machining");
      return [
        exaResult(
          "Acme Aerospace",
          "https://www.acme-aero.com/components",
          0.91,
        ),
        exaResult("Acme duplicate", "https://acme-aero.com/about", 0.72),
        exaResult(
          "Directory result",
          "https://linkedin.com/company/acme",
          0.88,
        ),
      ];
    });
    const harvester = new ExaCompanyListHarvester({ search });

    const result = await harvester.harvest(
      {
        queryTemplates: ["precision machining"],
        geography: "United States",
        product: "flight controls",
      },
      { limit: 25 },
    );

    expect(result.metrics).toEqual({
      fetched: 3,
      emitted: 1,
      rejected: 1,
      duplicateCandidates: 1,
    });
    expect(result.nextCursor).toBeUndefined();
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]).toMatchObject({
      sourceKey: "exa_company_search",
      sourceLocator: "https://www.acme-aero.com/components",
      rawName: "Acme Aerospace",
      rawDomain: "acme-aero.com",
      sourcePayload: {
        score: 0.91,
        url: "https://www.acme-aero.com/components",
        appliedQueryMetadata: {
          template: "precision machining",
          templateIndex: 0,
          geography: "United States",
          product: "flight controls",
          platform: null,
        },
      },
    });
    expect(result.signals[0]?.sourcePayload.query).toBe(search.mock.calls[0]?.[0]);
    expect(result.signals[0]?.sourcePayload.snippet).toContain(
      "manufactures aerospace components",
    );
    expect(result.signals[0]?.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("caps each query at ten proposals and each tick at twenty-five", async () => {
    let invocation = 0;
    const search = vi.fn(async () => {
      const batch = Array.from({ length: 12 }, (_, index) =>
        exaResult(
          `Company ${invocation}-${index}`,
          `https://company-${invocation}-${index}.example.com`,
        ),
      );
      invocation += 1;
      return batch;
    });
    const harvester = new ExaCompanyListHarvester({ search });

    const result = await harvester.harvest(
      { queryTemplates: ["one", "two", "three", "four"] },
      { limit: 25 },
    );

    expect(EXA_COMPANY_LIST_MAX_RESULTS_PER_QUERY).toBe(10);
    expect(search).toHaveBeenCalledTimes(3);
    expect(result.signals).toHaveLength(25);
    expect(result.metrics).toEqual({
      fetched: 25,
      emitted: 25,
      rejected: 0,
      duplicateCandidates: 0,
    });
    expect(result.nextCursor).toBe("3");
  });

  it("resumes at the next configured query using its opaque cursor", async () => {
    const search = vi.fn(async (query: string) => [
      exaResult(
        query.includes("first") ? "First Company" : "Second Company",
        query.includes("first")
          ? "https://first.example.com"
          : "https://second.example.com",
      ),
    ]);
    const harvester = new ExaCompanyListHarvester({ search });
    const config = { queryTemplates: ["first", "second"] };

    const firstPage = await harvester.harvest(config, { limit: 1 });
    const secondPage = await harvester.harvest(config, {
      limit: 1,
      cursor: firstPage.nextCursor,
    });

    expect(firstPage.signals[0]?.rawName).toBe("First Company");
    expect(firstPage.nextCursor).toBe("1");
    expect(secondPage.signals[0]?.rawName).toBe("Second Company");
    expect(secondPage.nextCursor).toBeUndefined();
  });

  it("keeps signal adapters outside lead, candidate, and database storage", () => {
    const files = [
      "harvester.ts",
      "registry.ts",
      "exa-harvester.ts",
      "sam-harvester.ts",
    ];
    for (const file of files) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).not.toMatch(
        /from\s+["'][^"']*(?:lead|candidate|@asi\/database)[^"']*["']/iu,
      );
    }
  });
});

describe("SamEntityHarvester", () => {
  it("requires unique exact six-digit NAICS codes and at most 25 results", () => {
    expect(() =>
      samEntityHarvesterConfigSchema.parse({
        naicsCodes: ["3364"],
        maxResults: 25,
      }),
    ).toThrow(/six digits/);
    expect(() =>
      samEntityHarvesterConfigSchema.parse({
        naicsCodes: ["336413", "336413"],
        maxResults: 25,
      }),
    ).toThrow(/unique/);
    expect(() =>
      samEntityHarvesterConfigSchema.parse({
        naicsCodes: ["336413"],
        maxResults: 26,
      }),
    ).toThrow();
  });

  it("emits provenance-rich signals, dedupes UEIs, and rejects inactive, non-US, or excluded entities", async () => {
    const official = samEntity("ACTIVE000001", {
      legalName: "Official Aero Components",
      cageCode: "1ABC2",
      officialUrl: "https://official-aero.example/",
      officialDomain: "official-aero.example",
      matchedNaicsCodes: ["332722", "336413"],
      sourceLocator:
        "sam://entity-information/v4/entities/ACTIVE000001?naics=332722%2C336413",
      raw: {
        entityRegistration: {
          ueiSAM: "ACTIVE000001",
          legalBusinessName: "Official Aero Components",
          providerPublicField: "preserved",
        },
      },
    });
    const unknownDomain = samEntity("ACTIVE000002");
    const search = vi.fn(async () => ({
      totalRecords: 6,
      entities: [
        official,
        official,
        samEntity("EXCLUDED0001", { exclusionStatusFlag: true }),
        samEntity("INACTIVE0001", { registrationStatus: "Inactive" }),
        samEntity("FOREIGN00001", { country: "CAN" }),
        unknownDomain,
      ],
    }));
    const harvester = new SamEntityHarvester({ search });

    const result = await harvester.harvest(
      {
        naicsCodes: ["336413", "332722"],
        state: "KS",
        maxResults: 25,
      },
      { limit: 25 },
    );

    expect(search).toHaveBeenCalledWith({
      naicsCodes: ["336413", "332722"],
      state: "KS",
      maxResults: 25,
    });
    expect(result.metrics).toEqual({
      fetched: 6,
      emitted: 2,
      rejected: 3,
      duplicateCandidates: 1,
    });
    expect(result.signals).toHaveLength(2);
    expect(result.signals[0]).toEqual({
      sourceKey: "sam_entity",
      sourceLocator:
        "sam://entity-information/v4/entities/ACTIVE000001?naics=332722%2C336413",
      sourceFingerprint: fingerprintSamEntity("ACTIVE000001"),
      rawName: "Official Aero Components",
      rawDomain: "official-aero.example",
      uei: "ACTIVE000001",
      cage: "1ABC2",
      city: "Wichita",
      state: "KS",
      country: "USA",
      sourcePayload: {
        matchedNaicsCodes: ["332722", "336413"],
        rawEntity: official.raw,
      },
    });
    expect(result.signals[0]!.sourceLocator).not.toContain("key");
    expect(result.signals[0]!.sourcePayload).toMatchObject({
      matchedNaicsCodes: ["332722", "336413"],
      rawEntity: {
        entityRegistration: { providerPublicField: "preserved" },
      },
    });
    expect(result.signals[1]).not.toHaveProperty("rawDomain");
    expect(result.signals[0]).not.toHaveProperty("awardCount");
    expect(fingerprintSamEntity("ACTIVE000001")).toBe(
      fingerprintSamEntity("ACTIVE000001"),
    );
    expect(fingerprintSamEntity("ACTIVE000001")).not.toBe(
      fingerprintSamEntity("ACTIVE000002"),
    );
  });
});
