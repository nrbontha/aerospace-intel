/**
 * Unit tests for the enrichment-benchmark extraction schema (malformed model
 * output must be rejected) and the runner's resumability + budget behavior
 * with injected fetch/extract doubles. No network, no database.
 */
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectAboutLinks,
  enrichProfileSchema,
  htmlToText,
  normalizeExtraction,
} from "../packages/research/src/benchmarks/schema.js";
import {
  runEnrichmentBenchmark,
  type BenchmarkCompanyInput,
  type FetchPageOutcome,
  type ProfileExtractor,
} from "../packages/research/src/benchmarks/runner.js";

const VALID_PROFILE = {
  identity: { legalName: "Test Co", domain: "test.example" },
  size: { revenueEstimateUsd: 5_000_000 },
  ownership: { ownershipType: "privately held" },
  business: {
    descriptionOneLiner: "Makes parts.",
    manufacturesProducts: true,
    distributes: false,
    services: false,
    pmaMentioned: false,
    proprietaryLanguage: false,
  },
  provenance: [{ field: "size.revenueEstimateUsd", url: "https://test.example/", excerpt: "$5M revenue" }],
};

describe("enrichment profile schema", () => {
  it("accepts a well-formed extraction", () => {
    const parsed = enrichProfileSchema.parse(VALID_PROFILE);
    expect(parsed.identity.legalName).toBe("Test Co");
    expect(parsed.provenance).toHaveLength(1);
  });

  it("rejects malformed extractions", () => {
    // negative revenue
    expect(() =>
      enrichProfileSchema.parse({
        ...VALID_PROFILE,
        size: { revenueEstimateUsd: -1 },
      }),
    ).toThrow();
    // excerpt over 200 chars
    expect(() =>
      enrichProfileSchema.parse({
        ...VALID_PROFILE,
        provenance: [{ field: "x", url: "https://t.example/", excerpt: "a".repeat(201) }],
      }),
    ).toThrow();
    // missing required boolean flags
    const { manufacturesProducts: _dropped, ...businessWithoutFlag } = VALID_PROFILE.business;
    expect(() =>
      enrichProfileSchema.parse({ ...VALID_PROFILE, business: businessWithoutFlag }),
    ).toThrow();
    // unknown extra key (strictObject)
    expect(() =>
      enrichProfileSchema.parse({ ...VALID_PROFILE, hallucinatedField: true }),
    ).toThrow();
    // non-integer employees
    expect(() =>
      enrichProfileSchema.parse({
        ...VALID_PROFILE,
        size: { revenueEstimateUsd: 1_000, employees: 12.5 },
      }),
    ).toThrow();
  });
});

describe("normalizeExtraction", () => {
  it("repairs numeric strings, nulls, string flags, and over-long excerpts", () => {
    const profile = normalizeExtraction({
      identity: { legalName: "Test Co", domain: "test.example", hqState: "Connecticut", hqCity: null },
      size: { revenueEstimateUsd: "5,000,000", employees: "58" },
      ownership: { ownershipType: "privately held" },
      business: {
        descriptionOneLiner: "Makes parts.",
        manufacturesProducts: "true",
        distributes: false,
        services: null,
        pmaMentioned: false,
        proprietaryLanguage: false,
      },
      provenance: [
        { field: "size.revenueEstimateUsd", url: "https://test.example/", excerpt: "x".repeat(260) },
        { field: "broken", url: "" },
        "not-an-object",
      ],
    });
    expect(profile.size.revenueEstimateUsd).toBe(5_000_000);
    expect(profile.size.employees).toBe(58);
    expect(profile.identity.hqCity).toBeUndefined();
    expect(profile.business.manufacturesProducts).toBe(true);
    expect(profile.business.services).toBe(false);
    expect(profile.provenance).toHaveLength(1);
    expect(profile.provenance[0]?.excerpt).toHaveLength(200);
  });

  it("throws when required fields are missing entirely", () => {
    expect(() => normalizeExtraction("no json here")).toThrow();
    expect(() => normalizeExtraction({ identity: {} })).toThrow();
    expect(() =>
      normalizeExtraction({
        identity: { legalName: "X", domain: "x.example" },
        ownership: { ownershipType: "private" },
        business: { descriptionOneLiner: "d" },
      }),
    ).toThrow(/boolean/);
  });
});

describe("html helpers", () => {
  it("strips scripts/styles and keeps meta + title text", () => {
    const html = `<html><head><title>ACMT</title>
      <meta name="description" content="Aerospace parts">
      <script>var x=1;</script></head>
      <body><style>.a{}</style><p>Manchester, Connecticut</p></body></html>`;
    const text = htmlToText(html, "text/html");
    expect(text).toContain("ACMT");
    expect(text).toContain("Aerospace parts");
    expect(text).toContain("Manchester, Connecticut");
    expect(text).not.toContain("var x");
  });

  it("collects only same-host about links", () => {
    const links = collectAboutLinks(
      `<a href="/about">About</a><a href="https://cdn.test.example/x">bad host</a>
       <a href="/Contact-Us">contact</a><a href="/products">products</a>`,
      "https://test.example/",
    );
    expect(links).toEqual([
      "https://test.example/about",
      "https://test.example/Contact-Us",
    ]);
  });
});

describe("runner resumability and budget", () => {
  const grataPayload = { State: "Connecticut", "Revenue Estimate": 10_000_000, Ownership: "Bootstrapped" };
  const company: BenchmarkCompanyInput = { name: "Test Co", domain: "test.example", grataPayload };

  let cacheDir: string;
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  const okPage = (url: string): FetchPageOutcome => ({
    url,
    ok: true,
    contentType: "text/html",
    body: "<html><head><title>T</title></head><body>About us in Connecticut</body></html>",
  });

  const makeExtractor = () => {
    const state = { calls: 0 };
    const extract: ProfileExtractor = async () => {
      state.calls += 1;
      return {
        profile: enrichProfileSchema.parse(VALID_PROFILE),
        telemetry: { tokens: 100, costUsd: 0, model: "test-model" },
      };
    };
    return { extract, calls: () => state.calls };
  };

  it("caches per domain: second run skips fetch and extract entirely", async () => {
    cacheDir = await mkdtemp(path.join(os.tmpdir(), "bench-cache-"));
    let fetchCalls = 0;
    const fetcher = async (url: string): Promise<FetchPageOutcome> => {
      fetchCalls += 1;
      return okPage(url);
    };
    const firstExtractor = makeExtractor();

    const firstRun = await runEnrichmentBenchmark({
      companies: [company],
      cacheDir,
      fetchPage: fetcher,
      extract: firstExtractor.extract,
    });
    expect(firstRun.totals.completed).toBe(1);
    expect(firstRun.totals.cacheHits).toBe(0);
    expect(fetchCalls).toBeGreaterThanOrEqual(1);
    expect(firstExtractor.calls()).toBe(1);

    // Second run: fetch must never be called; extraction must not rerun.
    let secondRunFetches = 0;
    const secondExtractor = makeExtractor();
    const secondRun = await runEnrichmentBenchmark({
      companies: [company],
      cacheDir,
      fetchPage: async (url) => {
        secondRunFetches += 1;
        return okPage(url);
      },
      extract: secondExtractor.extract,
    });
    expect(secondRunFetches).toBe(0);
    expect(secondExtractor.calls()).toBe(0);
    expect(secondRun.totals.cacheHits).toBe(1);
    expect(secondRun.perCompany[0]?.fromCache).toBe(true);
    // Comparisons are recomputed from cached content.
    expect(secondRun.perCompany[0]?.comparisons.length).toBeGreaterThan(0);
  });

  it("ignores a corrupted cache entry and refetches", async () => {
    cacheDir = await mkdtemp(path.join(os.tmpdir(), "bench-cache-"));
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      path.join(cacheDir, "test.example.json"),
      JSON.stringify({ version: 1, domain: "test.example", documents: [], profile: { garbage: true } }),
      "utf8",
    );
    const extractor = makeExtractor();
    const run = await runEnrichmentBenchmark({
      companies: [company],
      cacheDir,
      fetchPage: async (url) => okPage(url),
      extract: extractor.extract,
    });
    expect(run.totals.cacheHits).toBe(0);
    expect(extractor.calls()).toBe(1);
    const persisted = JSON.parse(await readFile(path.join(cacheDir, "test.example.json"), "utf8")) as {
      profile?: unknown;
    };
    expect(persisted.profile).toHaveProperty("identity");
  });

  it("aborts before spending when the daily baseline approaches the cap", async () => {
    cacheDir = await mkdtemp(path.join(os.tmpdir(), "bench-cache-"));
    const companies = [
      company,
      { name: "Other Co", domain: "other.example", grataPayload },
    ];
    const run = await runEnrichmentBenchmark({
      companies,
      cacheDir,
      fetchPage: async (url) => okPage(url),
      extract: async () => ({
        profile: enrichProfileSchema.parse(VALID_PROFILE),
        telemetry: { tokens: 10, costUsd: 0.05, model: "m" },
      }),
      dailySpendBaselineUsd: 0.81,
      dailyAbortThresholdUsd: 0.8,
    });
    expect(run.totals.aborted).toBe(true);
    expect(run.totals.abortReason).toContain("daily");
    // Nothing was spent: abort fired before any extraction.
    expect(run.totals.completed).toBe(0);
    expect(run.perCompany).toHaveLength(0);
  });

  it("stops after the run cost cap is exhausted mid-run", async () => {
    cacheDir = await mkdtemp(path.join(os.tmpdir(), "bench-cache-"));
    const companies = [
      company,
      { name: "Second Co", domain: "second.example", grataPayload },
      { name: "Third Co", domain: "third.example", grataPayload },
    ];
    const run = await runEnrichmentBenchmark({
      companies,
      cacheDir,
      fetchPage: async (url) => okPage(url),
      extract: async () => ({
        profile: enrichProfileSchema.parse(VALID_PROFILE),
        telemetry: { tokens: 10, costUsd: 0.3, model: "m" },
      }),
      runCostCapUsd: 0.5,
    });
    expect(run.totals.aborted).toBe(true);
    expect(run.totals.completed).toBeLessThan(companies.length);
    expect(run.totals.abortReason).toContain("run cost cap");
  });

  it("records fetch failures honestly as failed companies", async () => {
    cacheDir = await mkdtemp(path.join(os.tmpdir(), "bench-cache-"));
    const run = await runEnrichmentBenchmark({
      companies: [company],
      cacheDir,
      fetchPage: async (url) => ({ url, ok: false, contentType: "text/plain", body: "", error: "dns_failed: no address" }),
      extract: makeExtractor(),
    });
    expect(run.totals.failed).toBe(1);
    expect(run.perCompany[0]?.profile).toBeNull();
    expect(run.perCompany[0]?.fetchErrors[0]).toContain("dns_failed");
  });
});
