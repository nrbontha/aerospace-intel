/**
 * Freeze real website evidence for the JEv benchmark.
 *
 * Golden identities use the original workbook domains from
 * `jev-bakeoff-golden.json`. The supplied domain is a benchmark premise, not
 * proof that production discovery found it. A raw, safely fetched same-domain
 * homepage is retained for the production publisher-identity assessment.
 *
 *   npx tsx scripts/jev-bakeoff-evidence.ts [--out exports/jev-bakeoff-evidence-v3.json]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";
import { z } from "zod";

import { normalizeTargetDomain } from "../packages/database/src/unified-targets/records.js";
import {
  classifyWebsiteEvidence,
  fetchWebsiteEvidence,
  normalizeWebsiteOrigin,
  type WebsiteFetchOutcome,
} from "../packages/research/src/enrichment/website.js";
import { INVESTOR_VERDICTS_V1 } from "../packages/research/src/scoring-axial/fixtures/investor-verdicts.js";
import {
  isRetryableSafeFetchError,
  SafeFetchError,
  safeFetchUrl,
  type SafeFetchErrorCode,
  type SafeFetchResult,
} from "../packages/research/src/safe-fetch.js";

for (const line of existsSync(".env.local")
  ? readFileSync(".env.local", "utf8").split("\n")
  : []) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/u);
  const key = match?.[1];
  const value = match?.[2];
  if (
    key !== undefined &&
    value !== undefined &&
    process.env[key] === undefined
  ) {
    process.env[key] = value.trim().replace(/^["']|["']$/gu, "");
  }
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const goldenDocumentSchema = z.object({
  version: z.string(),
  cases: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      domain: z.string().min(1),
    }),
  ),
});

type IdentityStatus = "source_domain" | "candidate" | "unresolved";
type PublisherOutcome =
  "success" | "not_attempted" | "retryable_error" | "permanent_error";
type PublisherErrorCode = SafeFetchErrorCode | "cross_domain_redirect";
type FrozenWebsiteOutcome = WebsiteFetchOutcome | "not_attempted";

interface FreezeCase {
  id: string;
  name: string;
  cohort: "sourced_real" | "investor_review_report_only";
  sourceDomain: string | null;
}

interface FrozenPublisherPage {
  url: string;
  content: string;
  contentSha256: string;
  retrievedAt: string;
}

interface FrozenWebsiteCase {
  id: string;
  name: string;
  cohort: FreezeCase["cohort"];
  identityStatus: IdentityStatus;
  domain: string | null;
  publisherOutcome: PublisherOutcome;
  publisherErrorCode: PublisherErrorCode | null;
  publisherPages: readonly FrozenPublisherPage[];
  websiteOutcome: FrozenWebsiteOutcome;
  websiteErrorCode: string | null;
  websiteExcludedPageCount: number;
  websiteOffering: string;
  excerpts: string;
  ownershipHints: readonly string[];
  sizeHints: readonly string[];
  productHints: readonly string[];
  pages: readonly {
    url: string;
    title: string;
    text: string;
    textChars: number;
    excerpt: string;
    contentSha256: string;
    retrievedAt: string;
  }[];
  fetchesAttempted: number;
  fetchesSucceeded: number;
  budgetLimited: boolean;
  costUsd: number;
  error: string | null;
}

interface FrozenEvidenceDocument {
  version: "jev-bakeoff-evidence-v3";
  frozenAt: string;
  cases: FrozenWebsiteCase[];
  totals: {
    cases: number;
    sourceDomains: number;
    candidates: number;
    unresolved: number;
    errors: number;
    publisherFailures: number;
    websiteFailures: number;
    excludedWebsitePages: number;
    costUsd: number;
  };
}

function publisherFailure(error: unknown): {
  outcome: Exclude<PublisherOutcome, "success" | "not_attempted">;
  errorCode: PublisherErrorCode;
} {
  if (error instanceof SafeFetchError) {
    return {
      outcome: isRetryableSafeFetchError(error)
        ? "retryable_error"
        : "permanent_error",
      errorCode: error.code,
    };
  }
  return { outcome: "retryable_error", errorCode: "network_error" };
}

function isSameDomain(url: string, domain: string): boolean {
  const expected = normalizeTargetDomain(domain);
  return expected !== null && normalizeTargetDomain(url) === expected;
}

// This benchmark performs publisher-safe fetches only. Paid Exa fallback is
// deliberately disabled because the script has no source-signal budget scope.
const apiKey = "";

const outputPath = argValue("--out") ?? "exports/jev-bakeoff-evidence-v3.json";
mkdirSync(dirname(outputPath), { recursive: true });
const goldenRaw = JSON.parse(
  readFileSync(new URL("./jev-bakeoff-golden.json", import.meta.url), "utf8"),
) as unknown;
const golden = goldenDocumentSchema.parse(goldenRaw);

const cases: FreezeCase[] = [
  ...golden.cases.map((entry) => ({
    id: `golden:${entry.id}`,
    name: entry.name,
    cohort: "sourced_real" as const,
    sourceDomain: entry.domain,
  })),
  ...INVESTOR_VERDICTS_V1.map((entry, index) => ({
    id: `investor-review:${index}:${entry.name}`,
    name: entry.name,
    cohort: "investor_review_report_only" as const,
    sourceDomain: null,
  })),
];

const frozen: FrozenWebsiteCase[] = [];
let totalCostUsd = 0;

for (const entry of cases) {
  const domain = entry.sourceDomain;
  const identityStatus: IdentityStatus =
    domain === null ? "unresolved" : "source_domain";
  const searchCostUsd = 0;
  let publisherOutcome: PublisherOutcome = "not_attempted";
  let publisherErrorCode: PublisherErrorCode | null = null;
  let publisherSourcePages: readonly SafeFetchResult[] = [];

  try {
    // Paid discovery is intentionally excluded from this benchmark freezer.
    // Cases without a source-supplied domain remain unresolved rather than
    // minting an unscoped Exa allowance.

    if (domain === null) {
      frozen.push({
        id: entry.id,
        name: entry.name,
        cohort: entry.cohort,
        identityStatus,
        domain,
        publisherOutcome: "not_attempted",
        publisherErrorCode: null,
        publisherPages: [],
        websiteOutcome: "not_attempted",
        websiteErrorCode: null,
        websiteExcludedPageCount: 0,
        websiteOffering: "unknown",
        excerpts: "",
        ownershipHints: [],
        sizeHints: [],
        productHints: [],
        pages: [],
        fetchesAttempted: 0,
        fetchesSucceeded: 0,
        budgetLimited: false,
        costUsd: searchCostUsd,
        error: null,
      });
      totalCostUsd += searchCostUsd;
      console.log(
        `${identityStatus === "candidate" ? "CANDIDATE" : "UNRESOLVED"} ${entry.name}` +
          `${domain === null ? "" : ` -> ${domain}`}`,
      );
      continue;
    }

    publisherOutcome = "not_attempted";
    publisherErrorCode = null;
    publisherSourcePages = [];
    const origin = normalizeWebsiteOrigin(domain);
    if (origin === null) {
      publisherOutcome = "permanent_error";
      publisherErrorCode = "invalid_url";
    } else {
      try {
        const publisherPage = await safeFetchUrl(`${origin}/`);
        if (!isSameDomain(publisherPage.finalUrl, domain)) {
          publisherOutcome = "permanent_error";
          publisherErrorCode = "cross_domain_redirect";
        } else {
          publisherOutcome = "success";
          publisherSourcePages = [publisherPage];
        }
      } catch (error) {
        const failure = publisherFailure(error);
        publisherOutcome = failure.outcome;
        publisherErrorCode = failure.errorCode;
      }
    }

    const website = await fetchWebsiteEvidence(apiKey, domain, entry.name, {
      sourcePages: publisherSourcePages,
    });
    const exactWebsitePages = website.pages.filter((page) =>
      isSameDomain(page.url, domain),
    );
    const websiteExcludedPageCount =
      website.pages.length - exactWebsitePages.length;
    const exactWebsiteEvidence = classifyWebsiteEvidence(exactWebsitePages);
    const websiteOutcome =
      website.outcome === "success" && exactWebsitePages.length === 0
        ? "no_content"
        : website.outcome;
    const costUsd = searchCostUsd + website.costUsd;
    frozen.push({
      id: entry.id,
      name: entry.name,
      cohort: entry.cohort,
      identityStatus,
      domain,
      publisherOutcome,
      publisherErrorCode,
      publisherPages: publisherSourcePages.map((page) => ({
        url: page.finalUrl,
        content: page.content,
        contentSha256: page.contentSha256,
        retrievedAt: page.retrievedAt,
      })),
      websiteOutcome,
      websiteErrorCode: website.errorCode,
      websiteExcludedPageCount,
      websiteOffering: exactWebsiteEvidence.websiteOffering,
      excerpts: exactWebsiteEvidence.excerpts,
      ownershipHints: exactWebsiteEvidence.ownershipHints,
      sizeHints: exactWebsiteEvidence.sizeHints,
      productHints: exactWebsiteEvidence.productHints,
      pages: exactWebsitePages,
      fetchesAttempted: website.fetchesAttempted,
      fetchesSucceeded: exactWebsitePages.length,
      budgetLimited: website.budgetLimited,
      costUsd,
      error: null,
    });
    totalCostUsd += costUsd;
    console.log(
      `SOURCE ${entry.name} -> ${domain} ` +
        `[publisher ${publisherOutcome}, website ${websiteOutcome}, ` +
        `pages ${exactWebsitePages.length}/${website.fetchesAttempted}, ` +
        `excluded ${websiteExcludedPageCount}]`,
    );
  } catch (error) {
    frozen.push({
      id: entry.id,
      name: entry.name,
      cohort: entry.cohort,
      identityStatus,
      domain,
      publisherOutcome,
      publisherErrorCode,
      publisherPages: publisherSourcePages.map((page) => ({
        url: page.finalUrl,
        content: page.content,
        contentSha256: page.contentSha256,
        retrievedAt: page.retrievedAt,
      })),
      websiteOutcome:
        identityStatus === "source_domain"
          ? "retryable_error"
          : "not_attempted",
      websiteErrorCode: null,
      websiteExcludedPageCount: 0,
      websiteOffering: "unknown",
      excerpts: "",
      ownershipHints: [],
      sizeHints: [],
      productHints: [],
      pages: [],
      fetchesAttempted: 0,
      fetchesSucceeded: 0,
      budgetLimited: false,
      costUsd: searchCostUsd,
      error: error instanceof Error ? error.message : String(error),
    });
    totalCostUsd += searchCostUsd;
    console.log(`ERROR ${entry.name}`);
  }
}

const document: FrozenEvidenceDocument = {
  version: "jev-bakeoff-evidence-v3",
  frozenAt: new Date().toISOString(),
  cases: frozen,
  totals: {
    cases: frozen.length,
    sourceDomains: frozen.filter(
      (entry) => entry.identityStatus === "source_domain",
    ).length,
    candidates: frozen.filter((entry) => entry.identityStatus === "candidate")
      .length,
    unresolved: frozen.filter((entry) => entry.identityStatus === "unresolved")
      .length,
    errors: frozen.filter(
      (entry) =>
        entry.error !== null ||
        entry.publisherOutcome === "retryable_error" ||
        entry.publisherOutcome === "permanent_error" ||
        (entry.identityStatus === "source_domain" &&
          entry.websiteOutcome !== "success"),
    ).length,
    publisherFailures: frozen.filter(
      (entry) =>
        entry.publisherOutcome === "retryable_error" ||
        entry.publisherOutcome === "permanent_error",
    ).length,
    websiteFailures: frozen.filter(
      (entry) =>
        entry.identityStatus === "source_domain" &&
        entry.websiteOutcome !== "success",
    ).length,
    excludedWebsitePages: frozen.reduce(
      (total, entry) => total + entry.websiteExcludedPageCount,
      0,
    ),
    costUsd: totalCostUsd,
  },
};

writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`);
console.log("---");
console.log(
  `cases=${document.totals.cases} source_domains=${document.totals.sourceDomains} ` +
    `candidates=${document.totals.candidates} unresolved=${document.totals.unresolved} ` +
    `errors=${document.totals.errors} publisher_failures=${document.totals.publisherFailures} ` +
    `website_failures=${document.totals.websiteFailures} ` +
    `excluded_website_pages=${document.totals.excludedWebsitePages} ` +
    `cost_usd=${totalCostUsd.toFixed(3)}`,
);
console.log(`wrote ${outputPath}`);
