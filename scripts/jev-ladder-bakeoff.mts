/**
 * JEv production-ladder classification benchmark.
 *
 * Decisions come from `evaluateJevLadder`, the same pure engine used by the
 * worker. Expected labels are consumed only after evaluation. This is a
 * classification benchmark, not end-to-end worker, persistence, Muse, or
 * promotion proof.
 *
 * Curated workbook domains are supplied identity context, not proof that the
 * production discovery stage found them. Publisher identity is assessed from
 * a safely retrieved raw same-domain homepage; website support is restricted
 * to pages on that verified reference domain. `BAKEOFF_LIVE=1` preserves live
 * retrieval. Otherwise the private v3 evidence freeze is required. Synthetic
 * controls and historical investor labels remain separate diagnostics.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { z } from "zod";

import { normalizeTargetDomain } from "../packages/database/src/unified-targets/records.js";
import {
  classifyWebsiteEvidence,
  fetchWebsiteEvidence,
  normalizeWebsiteOrigin,
  type WebsiteFetchResult,
} from "../packages/research/src/enrichment/website.js";
import {
  assessSignalSiteIdentity,
  buildSignalIdentityQuote,
  extractFirstPartyNamedProductQuotes,
  extractWebsiteFacts,
} from "../packages/research/src/enrichment/signal-evidence.js";
import {
  isRetryableSafeFetchError,
  SafeFetchError,
  safeFetchUrl,
  type SafeFetchErrorCode,
  type SafeFetchResult,
} from "../packages/research/src/safe-fetch.js";
import { callJev } from "../packages/research/src/faa-ensemble/jev.js";
import {
  buildEvidencePackage,
  evaluateJevLadder,
  resolveEnsembleConfig,
  type FaaEvidencePackage,
  type JevLadderEvaluation,
} from "../packages/research/src/faa-ensemble/runner.js";
import { INVESTOR_VERDICTS_V1 } from "../packages/research/src/scoring-axial/fixtures/investor-verdicts.js";
import {
  BENCHMARK_DECISIONS,
  summarizeBenchmark,
  type BenchmarkCohort,
  type BenchmarkDecision,
  type BenchmarkOutcome,
} from "./run-validation.mts";

const decisionSchema = z.enum(BENCHMARK_DECISIONS);
const goldenDocumentSchema = z.object({
  version: z.string(),
  cases: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      domain: z.string().min(1),
      expected: decisionSchema,
      referenceExpected: decisionSchema.optional(),
      labelBasis: z.string().min(1).optional(),
    }),
  ),
});

const extrasSchema = z.array(
  z.object({
    name: z.string().min(1),
    ownership: z.enum([
      "independent",
      "pe_owned",
      "strategic_owned",
      "public",
      "dead",
      "unknown",
    ]),
    expected: decisionSchema,
    synthetic: z
      .object({
        makes: z.array(z.string()).optional(),
        modelsSample: z.array(z.string()).optional(),
        excerpts: z.string().optional(),
        websiteOffering: z.string().optional(),
        mandate: z
          .object({
            verifiedDomain: z.string().min(1),
            revenueAssessment: z.enum(["under_50m", "over_50m"]),
            headquarters: z.object({
              city: z.string().min(1),
              state: z.string().min(1),
              country: z.string().min(1),
            }),
          })
          .optional(),
      })
      .optional(),
  }),
);

const publisherOutcomeSchema = z.enum([
  "success",
  "not_attempted",
  "retryable_error",
  "permanent_error",
]);
const websiteOutcomeSchema = z.enum([
  "success",
  "no_content",
  "budget_limited",
  "configuration_error",
  "retryable_error",
  "provider_error",
  "not_attempted",
]);
const frozenEvidenceSchema = z.object({
  version: z.literal("jev-bakeoff-evidence-v3"),
  cases: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      identityStatus: z.enum(["source_domain", "candidate", "unresolved"]),
      domain: z.string().nullable(),
      publisherOutcome: publisherOutcomeSchema,
      publisherErrorCode: z.string().nullable(),
      publisherPages: z.array(
        z.object({
          url: z.string(),
          content: z.string(),
          contentSha256: z.string(),
          retrievedAt: z.string(),
        }),
      ),
      websiteOutcome: websiteOutcomeSchema,
      websiteErrorCode: z.string().nullable(),
      websiteExcludedPageCount: z.number().int().nonnegative(),
      websiteOffering: z.string(),
      excerpts: z.string(),
      ownershipHints: z.array(z.string()),
      sizeHints: z.array(z.string()),
      productHints: z.array(z.string()),
      pages: z.array(
        z.object({
          url: z.string(),
          title: z.string(),
          text: z.string(),
          textChars: z.number(),
          excerpt: z.string(),
          contentSha256: z.string(),
          retrievedAt: z.string(),
        }),
      ),
      error: z.string().nullable(),
    }),
  ),
});

type FrozenEvidenceCase = z.infer<typeof frozenEvidenceSchema>["cases"][number];

interface BenchmarkCaseInput {
  id: string;
  name: string;
  domain: string | null;
  kind: BenchmarkCohort;
  syntheticOwnership?: string;
  syntheticWebsite?: {
    offering: string;
    excerpts: string;
    productHints: readonly string[];
    mandate?: {
      verifiedDomain: string;
      revenueAssessment: "under_50m" | "over_50m";
      headquarters: { city: string; state: string; country: string };
    };
  };
}

interface BenchmarkCase {
  input: BenchmarkCaseInput;
  expected: BenchmarkDecision;
  referenceExpected: BenchmarkDecision;
  labelBasis: string;
  cohort: BenchmarkCohort;
}

interface CaseResult {
  outcome: BenchmarkOutcome;
  exitRung: JevLadderEvaluation["exitRung"] | "error";
}

function readJson(url: URL): unknown {
  return JSON.parse(readFileSync(url, "utf8")) as unknown;
}

const golden = goldenDocumentSchema.parse(
  readJson(new URL("./jev-bakeoff-golden.json", import.meta.url)),
);
const extras = extrasSchema.parse(
  readJson(new URL("./jev-bakeoff-extras.json", import.meta.url)),
);

const liveFetch = process.env["BAKEOFF_LIVE"] === "1";
const frozenEvidenceUrl = new URL(
  "../exports/jev-bakeoff-evidence-v3.json",
  import.meta.url,
);
const frozenParse = frozenEvidenceSchema.safeParse(
  existsSync(frozenEvidenceUrl) ? readJson(frozenEvidenceUrl) : null,
);
if (!frozenParse.success && !liveFetch) {
  throw new Error(
    "Cached benchmark evidence is not v3. Run scripts/jev-bakeoff-evidence.ts " +
      "to freeze current raw publisher and website evidence, or explicitly " +
      "select BAKEOFF_LIVE=1.",
  );
}
const frozenByName = new Map<string, FrozenEvidenceCase>(
  frozenParse.success
    ? frozenParse.data.cases
        .filter((entry) => entry.identityStatus === "source_domain")
        .map((entry) => [entry.name, entry])
    : [],
);
const frozenPublisherFailures = frozenParse.success
  ? frozenParse.data.cases.filter(
      (entry) =>
        entry.identityStatus === "source_domain" &&
        entry.publisherOutcome !== "success",
    ).length
  : 0;
const frozenWebsiteHolds = frozenParse.success
  ? frozenParse.data.cases.filter(
      (entry) =>
        entry.identityStatus === "source_domain" &&
        entry.websiteOutcome !== "success",
    ).length
  : 0;
const frozenExcludedWebsitePages = frozenParse.success
  ? frozenParse.data.cases.reduce(
      (total, entry) => total + entry.websiteExcludedPageCount,
      0,
    )
  : 0;
if (frozenParse.success && !liveFetch) {
  for (const entry of frozenParse.data.cases) {
    if (
      entry.identityStatus !== "source_domain" ||
      (entry.publisherOutcome === "success" &&
        entry.websiteOutcome === "success" &&
        entry.websiteExcludedPageCount === 0 &&
        entry.error === null)
    ) {
      continue;
    }
    console.error(
      `EVIDENCE_HOLD ${JSON.stringify({
        name: entry.name,
        publisherOutcome: entry.publisherOutcome,
        publisherErrorCode: entry.publisherErrorCode,
        websiteOutcome: entry.websiteOutcome,
        websiteErrorCode: entry.websiteErrorCode,
        websiteExcludedPageCount: entry.websiteExcludedPageCount,
        error: entry.error,
      })}`,
    );
  }
}

const investorExpected = (verdict: string): BenchmarkDecision => {
  if (verdict === "add") return "high_priority";
  if (verdict === "hold") return "research";
  return "reject";
};
const syntheticOwnershipStatus = (ownership: string): string => {
  if (ownership === "public") return "public_parent";
  if (ownership === "strategic_owned") return "acquired";
  return ownership;
};

const cases: BenchmarkCase[] = [
  ...golden.cases.map((entry) => ({
    input: {
      id: `golden:${entry.id}`,
      name: entry.name,
      domain: entry.domain,
      kind: "sourced_real" as const,
    },
    cohort: "sourced_real" as const,
    expected: entry.expected,
    referenceExpected: entry.referenceExpected ?? entry.expected,
    labelBasis:
      entry.labelBasis ?? "historical_reference_not_current_diligence",
  })),
  ...INVESTOR_VERDICTS_V1.map((entry, index) => ({
    input: {
      id: `investor-review:${index}:${entry.name}`,
      name: entry.name,
      domain: null,
      kind: "investor_review_report_only" as const,
    },
    cohort: "investor_review_report_only" as const,
    expected: investorExpected(entry.verdict),
    referenceExpected: investorExpected(entry.verdict),
    labelBasis: "prior_investor_review_report_only",
  })),
  ...extras.map((entry, index) => ({
    input: {
      id: `synthetic:${index}:${entry.name}`,
      name: entry.name,
      domain: null,
      kind: "synthetic_control" as const,
      syntheticOwnership: syntheticOwnershipStatus(entry.ownership),
      syntheticWebsite:
        entry.synthetic === undefined
          ? undefined
          : {
              offering: entry.synthetic.websiteOffering ?? "unknown",
              excerpts: entry.synthetic.excerpts ?? "",
              productHints: [
                ...(entry.synthetic.makes ?? []),
                ...(entry.synthetic.modelsSample ?? []),
              ],
              ...(entry.synthetic.mandate === undefined
                ? {}
                : { mandate: entry.synthetic.mandate }),
            },
    },
    cohort: "synthetic_control" as const,
    expected: entry.expected,
    referenceExpected: entry.expected,
    labelBasis: "synthetic_control",
  })),
];

type PublisherOutcome = z.infer<typeof publisherOutcomeSchema>;
type BenchmarkWebsiteEvidence = FrozenEvidenceCase;

function sameDomain(url: string, domain: string): boolean {
  const expected = normalizeTargetDomain(domain);
  return expected !== null && normalizeTargetDomain(url) === expected;
}

function publisherFailure(error: unknown): {
  outcome: Exclude<PublisherOutcome, "success" | "not_attempted">;
  errorCode: SafeFetchErrorCode;
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

const liveCache = new Map<string, BenchmarkWebsiteEvidence>();
async function liveWebsite(
  domain: string,
  name: string,
): Promise<BenchmarkWebsiteEvidence> {
  const hit = liveCache.get(domain);
  if (hit !== undefined) return hit;
  let publisherOutcome: PublisherOutcome;
  let publisherErrorCode: string | null = null;
  let publisherSourcePages: SafeFetchResult[] = [];
  const origin = normalizeWebsiteOrigin(domain);
  if (origin === null) {
    publisherOutcome = "permanent_error";
    publisherErrorCode = "invalid_url";
  } else {
    try {
      const publisherPage = await safeFetchUrl(`${origin}/`);
      if (!sameDomain(publisherPage.finalUrl, domain)) {
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
  const exaApiKey = process.env["EXA_API_KEY"] ?? "";
  const website: WebsiteFetchResult = await fetchWebsiteEvidence(
    exaApiKey,
    domain,
    name,
    { sourcePages: publisherSourcePages },
  );
  const exactWebsitePages = website.pages.filter((page) =>
    sameDomain(page.url, domain),
  );
  const websiteExcludedPageCount =
    website.pages.length - exactWebsitePages.length;
  const exactWebsiteEvidence = classifyWebsiteEvidence(exactWebsitePages);
  const websiteOutcome =
    website.outcome === "success" && exactWebsitePages.length === 0
      ? "no_content"
      : website.outcome;
  const result: BenchmarkWebsiteEvidence = {
    id: `live:${name}`,
    name,
    identityStatus: "source_domain",
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
    ownershipHints: [...exactWebsiteEvidence.ownershipHints],
    sizeHints: [...exactWebsiteEvidence.sizeHints],
    productHints: [...exactWebsiteEvidence.productHints],
    pages: exactWebsitePages,
    error: null,
  };
  if (
    publisherOutcome !== "success" ||
    websiteOutcome !== "success" ||
    websiteExcludedPageCount > 0
  ) {
    console.error(
      `EVIDENCE_HOLD ${JSON.stringify({
        name,
        publisherOutcome,
        publisherErrorCode,
        websiteOutcome,
        websiteErrorCode: website.errorCode,
        websiteExcludedPageCount,
      })}`,
    );
  }
  liveCache.set(domain, result);
  return result;
}

function researchInput(
  entry: BenchmarkCaseInput,
  website: BenchmarkWebsiteEvidence | null,
): Record<string, unknown> {
  if (entry.kind === "synthetic_control") {
    const synthetic = entry.syntheticWebsite;
    const mandate = synthetic?.mandate;
    const quote = synthetic?.excerpts ?? "";
    const contentSha256 = createHash("sha256").update(quote).digest("hex");
    const sourceUrl = `synthetic://control/${encodeURIComponent(entry.name)}`;
    const supportId = (stage: string): string =>
      `synthetic-${stage}:${contentSha256}`;
    const productSupported =
      mandate !== undefined && (synthetic?.productHints.length ?? 0) > 0;
    const evidenceRefs =
      mandate === undefined
        ? []
        : [
            {
              evidenceId: supportId("domain"),
              role: "support",
              stage: "domain",
              url: sourceUrl,
              title: "Declared synthetic benchmark control",
              quote,
              contentSha256,
              sourceKind: "synthetic_control",
              firstParty: false,
            },
            ...(productSupported
              ? [
                  {
                    evidenceId: supportId("website"),
                    role: "support",
                    stage: "website",
                    url: sourceUrl,
                    title: "Declared synthetic benchmark control",
                    quote,
                    contentSha256,
                    sourceKind: "synthetic_control",
                    firstParty: false,
                  },
                ]
              : []),
            {
              evidenceId: supportId("ownership"),
              role: "support",
              stage: "ownership",
              url: sourceUrl,
              title: "Declared synthetic benchmark control",
              quote,
              contentSha256,
              sourceKind: "synthetic_control",
              firstParty: false,
            },
            {
              evidenceId: supportId("size"),
              role: "support",
              stage: "size",
              url: sourceUrl,
              title: "Declared synthetic benchmark control",
              quote,
              contentSha256,
              sourceKind: "synthetic_control",
              firstParty: false,
            },
            {
              evidenceId: supportId("hq"),
              role: "support",
              stage: "hq",
              url: sourceUrl,
              title: "Declared synthetic benchmark control",
              quote,
              contentSha256,
              sourceKind: "synthetic_control",
              firstParty: false,
            },
          ];
    return {
      identity: {
        status: mandate === undefined ? "not_found" : "verified",
        verifiedDomain: mandate?.verifiedDomain ?? null,
        legalName: entry.name,
        proofEvidenceIds: mandate === undefined ? [] : [supportId("domain")],
      },
      website: {
        status: synthetic === undefined ? "not_checked" : "supported",
        offering: synthetic?.offering ?? "unknown",
        excerpts: quote,
        productHints: synthetic?.productHints ?? [],
        namedProductEvidenceIds: productSupported ? [supportId("website")] : [],
      },
      ownership: {
        status: entry.syntheticOwnership ?? "unknown",
        owner: null,
        year: null,
        supportEvidenceIds:
          mandate === undefined ? [] : [supportId("ownership")],
      },
      size: {
        status: mandate === undefined ? "unknown" : "supported",
        assessment: mandate?.revenueAssessment ?? "unknown",
        indicators:
          mandate === undefined
            ? []
            : [
                {
                  kind: "declared_synthetic_mandate",
                  excerpt: quote,
                  evidenceId: supportId("size"),
                },
              ],
      },
      headquarters: {
        status: mandate === undefined ? "unknown" : "supported",
        city: mandate?.headquarters.city ?? null,
        state: mandate?.headquarters.state ?? null,
        country: mandate?.headquarters.country ?? null,
        supportEvidenceIds: mandate === undefined ? [] : [supportId("hq")],
      },
      missingFacts:
        mandate === undefined
          ? [
              "verified_official_identity",
              "first_party_named_product",
              "revenue_under_50m",
              "us_headquarters",
            ]
          : productSupported
            ? []
            : ["first_party_named_product"],
      checkedSources: [],
      evidenceRefs,
    };
  }

  const referenceDomain = normalizeTargetDomain(entry.domain);
  const suppliedReferenceDomain =
    entry.kind === "sourced_real" &&
    referenceDomain !== null &&
    website !== null &&
    website.identityStatus === "source_domain" &&
    normalizeTargetDomain(website.domain) === referenceDomain;
  const publisherPages =
    suppliedReferenceDomain && website.publisherOutcome === "success"
      ? website.publisherPages.filter(
          (page) => normalizeTargetDomain(page.url) === referenceDomain,
        )
      : [];
  const identitySignal = {
    rawName: entry.name,
    uei: null,
    cage: null,
    city: null,
    state: null,
  };
  const identityAssessment =
    publisherPages.length === 0
      ? null
      : assessSignalSiteIdentity(
          identitySignal,
          publisherPages.map((page) => page.content),
          publisherPages.map((page) => page.url),
        );
  const identityProof =
    identityAssessment === null
      ? undefined
      : publisherPages
          .map((page) => {
            const quote = buildSignalIdentityQuote(
              page.content,
              page.url,
              identitySignal,
              identityAssessment,
            );
            return { page, quote };
          })
          .find(
            ({ page, quote }) =>
              quote.trim() !== "" &&
              assessSignalSiteIdentity(identitySignal, [quote], [page.url])
                .nameMatched,
          );
  const identityPage = identityProof?.page;
  const identityQuote = identityProof?.quote ?? null;
  const identityEvidenceId =
    identityPage === undefined
      ? null
      : `benchmark-domain:${identityPage.contentSha256}`;
  const pages =
    identityPage === undefined || referenceDomain === null
      ? []
      : (website?.pages ?? []).filter(
          (page) => normalizeTargetDomain(page.url) === referenceDomain,
        );
  const classifiedWebsite = classifyWebsiteEvidence(pages);
  const productSupport = pages.flatMap((page) =>
    extractFirstPartyNamedProductQuotes(
      [page.title, page.text].filter((value) => value.trim() !== "").join("\n"),
      entry.name,
    ).map((quote) => {
      const evidenceId = `benchmark-website:${page.contentSha256}:${quote}`;
      return { evidenceId, quote, page };
    }),
  );
  const facts = extractWebsiteFacts(
    identityPage === undefined || pages.length === 0
      ? null
      : { outcome: "success", pages },
    entry.name,
  );
  const factRefs = [
    ...facts.ownershipDocuments,
    ...facts.sizeDocuments,
    ...facts.headquartersDocuments,
  ].map((document, index) => ({
    ...document,
    evidenceId: `benchmark-${document.stage}:${document.contentSha256}:${index}`,
    role: "support" as const,
  }));
  const evidenceRefs = [
    ...(identityPage === undefined ||
    identityEvidenceId === null ||
    identityQuote === null
      ? []
      : [
          {
            evidenceId: identityEvidenceId,
            role: "support",
            stage: "domain",
            url: identityPage.url,
            title: `Official site: ${entry.name}`,
            quote: identityQuote,
            contentSha256: identityPage.contentSha256,
            retrievedAt: identityPage.retrievedAt,
            sourceKind: "official_site",
            firstParty: true,
          },
        ]),
    ...productSupport.map(({ evidenceId, quote, page }) => ({
      evidenceId,
      role: "support",
      stage: "website",
      url: page.url,
      title: page.title,
      quote,
      contentSha256: page.contentSha256,
      retrievedAt: page.retrievedAt,
      sourceKind: "official_site",
      firstParty: true,
    })),
    ...factRefs,
  ];
  const verifiedDomain = identityEvidenceId === null ? null : entry.domain;
  const checkedSources = [
    ...publisherPages.map((page) => ({
      url: page.url,
      outcome: "retrieved",
      contentSha256: page.contentSha256,
      retrievedAt: page.retrievedAt,
      stage: "publisher_identity",
    })),
    ...pages.map((page) => ({
      url: page.url,
      outcome: "retrieved",
      contentSha256: page.contentSha256,
      retrievedAt: page.retrievedAt,
      stage: "website",
    })),
    ...(website === null ||
    website.publisherOutcome === "success" ||
    website.publisherOutcome === "not_attempted"
      ? []
      : [
          {
            url:
              normalizeWebsiteOrigin(entry.domain ?? "") ?? entry.domain ?? "",
            outcome: website.publisherOutcome,
            errorCode: website.publisherErrorCode,
            stage: "publisher_identity",
          },
        ]),
    ...(website === null ||
    website.websiteOutcome === "success" ||
    website.websiteOutcome === "no_content" ||
    website.websiteOutcome === "not_attempted"
      ? []
      : [
          {
            url:
              normalizeWebsiteOrigin(entry.domain ?? "") ?? entry.domain ?? "",
            outcome: website.websiteOutcome,
            errorCode: website.websiteErrorCode,
            stage: "website",
          },
        ]),
  ];
  return {
    identity: {
      status:
        verifiedDomain !== null
          ? "verified"
          : entry.domain === null
            ? "not_found"
            : "ambiguous",
      verifiedDomain,
      legalName: entry.name,
      proofEvidenceIds: identityEvidenceId === null ? [] : [identityEvidenceId],
    },
    website: {
      status:
        website === null
          ? "not_checked"
          : pages.length > 0
            ? "supported"
            : "no_content",
      offering: classifiedWebsite.websiteOffering,
      excerpts: classifiedWebsite.excerpts,
      productHints: productSupport.map(({ quote }) => quote),
      namedProductEvidenceIds: productSupport.map(
        ({ evidenceId }) => evidenceId,
      ),
    },
    ownership: {
      status: facts.ownershipStatus,
      owner: facts.owner,
      year: null,
      supportEvidenceIds: factRefs
        .filter((ref) => ref.stage === "ownership")
        .map((ref) => ref.evidenceId),
    },
    size: {
      status: facts.sizeDocuments.length > 0 ? "supported" : "unknown",
      assessment: facts.sizeAssessment,
      indicators: factRefs
        .filter((ref) => ref.stage === "size")
        .map((ref) => ({
          kind: ref.metadata["sizeKind"],
          excerpt: ref.quote,
          evidenceId: ref.evidenceId,
        })),
    },
    headquarters: {
      status: facts.headquartersStatus,
      city: facts.headquarters?.city ?? null,
      state: facts.headquarters?.state ?? null,
      country: facts.headquarters?.country ?? null,
      supportEvidenceIds: factRefs
        .filter((ref) => ref.stage === "hq")
        .map((ref) => ref.evidenceId),
    },
    missingFacts: [
      ...(identityPage === undefined ? ["verified_official_identity"] : []),
      ...(productSupport.length === 0 ? ["first_party_named_product"] : []),
      ...(facts.ownershipStatus === "unknown" ? ["ownership"] : []),
      ...(facts.sizeAssessment === "unknown" ? ["revenue_under_50m"] : []),
      ...(facts.headquartersStatus !== "supported" ||
      facts.headquarters?.country !== "US"
        ? ["us_headquarters"]
        : []),
    ],
    checkedSources,
    evidenceRefs,
  };
}

async function evidenceFor(
  entry: BenchmarkCaseInput,
): Promise<FaaEvidencePackage> {
  const website =
    liveFetch && entry.domain !== null
      ? await liveWebsite(entry.domain, entry.name)
      : (frozenByName.get(entry.name) ?? null);
  if (
    entry.kind !== "synthetic_control" &&
    website !== null &&
    (website.publisherOutcome === "retryable_error" ||
      website.websiteOutcome === "retryable_error" ||
      website.websiteOutcome === "budget_limited")
  ) {
    throw new Error(
      `Evidence collection deferred: publisher=${website.publisherOutcome}, ` +
        `website=${website.websiteOutcome}`,
    );
  }
  return buildEvidencePackage(
    {
      id: `bakeoff:${entry.id}`,
      source_key: "validation_benchmark",
      raw_name: entry.name,
      raw_domain: entry.domain,
      cage: null,
      uei: null,
      city: null,
      state: null,
      country: null,
      award_count: null,
      freshest_award: null,
      source_payload: {},
    },
    researchInput(entry, website),
  );
}

const apiKey = process.env["OPENROUTER_API_KEY"] ?? "";
if (apiKey === "") throw new Error("OPENROUTER_API_KEY is required");
const model = resolveEnsembleConfig().jevModel;
const repeats = Number(process.env["BAKEOFF_REPEATS"] ?? "1");
if (!Number.isInteger(repeats) || repeats <= 0) {
  throw new Error("BAKEOFF_REPEATS must be a positive integer");
}

async function evaluateCase(
  entry: BenchmarkCase,
  repetition: number,
): Promise<CaseResult> {
  let observedCostUsd = 0;
  let observedCallCount = 0;
  try {
    const evidence = await evidenceFor(entry.input);
    const evaluation = await evaluateJevLadder({
      evidence,
      call: async (request) => {
        const result = await callJev(
          apiKey,
          { ...request.state },
          { ...request.questions },
          { model },
        );
        observedCallCount += 1;
        observedCostUsd += result.costUsd ?? 0;
        return result;
      },
    });
    return {
      outcome: {
        id: `${entry.input.id}:rep-${repetition}`,
        cohort: entry.cohort,
        expected: entry.expected,
        actual: evaluation.decision,
        costUsd: evaluation.costUsd ?? observedCostUsd,
        callCount: evaluation.callCount,
      },
      exitRung: evaluation.exitRung,
    };
  } catch (error) {
    console.error(
      `CASE_ERROR ${JSON.stringify({
        id: entry.input.id,
        cohort: entry.cohort,
        error: error instanceof Error ? error.message : String(error),
      })}`,
    );
    return {
      outcome: {
        id: `${entry.input.id}:rep-${repetition}`,
        cohort: entry.cohort,
        expected: entry.expected,
        actual: "error",
        costUsd: observedCostUsd,
        callCount: observedCallCount,
      },
      exitRung: "error",
    };
  }
}

const results: CaseResult[] = [];
const exits: Record<string, number> = {};
for (let repetition = 0; repetition < repeats; repetition++) {
  for (const entry of cases) {
    const result = await evaluateCase(entry, repetition);
    results.push(result);
    exits[result.exitRung] = (exits[result.exitRung] ?? 0) + 1;
    console.log(
      `CASE cohort=${result.outcome.cohort} rep=${repetition} ` +
        `name=${entry.input.name} reference=${entry.referenceExpected} ` +
        `expected=${result.outcome.expected} label_basis=${entry.labelBasis} ` +
        `actual=${result.outcome.actual} exit=${result.exitRung} ` +
        `calls=${result.outcome.callCount} cost_usd=${result.outcome.costUsd.toFixed(6)}`,
    );
  }
}

const outcomes = results.map((result) => result.outcome);
const summary = summarizeBenchmark(outcomes);
const ladderMiss =
  summary.byCohort.sourced_real.caseCount -
  summary.byCohort.sourced_real.exactMatches;
const syntheticMiss =
  summary.byCohort.synthetic_control.caseCount -
  summary.byCohort.synthetic_control.exactMatches;
const investorReferenceMiss =
  summary.byCohort.investor_review_report_only.caseCount -
  summary.byCohort.investor_review_report_only.exactMatches;
const sourcedCases = cases.filter((entry) => entry.cohort === "sourced_real");
const fitOnlyConflicts = sourcedCases.filter(
  (entry) => entry.referenceExpected !== entry.expected,
).length;

console.log(`EXITS ${JSON.stringify(exits)}`);
for (const [cohort, cohortSummary] of Object.entries(summary.byCohort)) {
  console.log(`COHORT ${cohort} ${JSON.stringify(cohortSummary)}`);
}
console.log(
  `METRIC cases=${summary.caseCount} false_promotions=${summary.falsePromotions} ` +
    `false_rejects=${summary.falseRejects} missed_hp=${summary.missedHighPriority} ` +
    `abstentions=${summary.abstentions} errors=${summary.errors} ` +
    `coverage=${summary.coverage === null ? "n/a" : summary.coverage.toFixed(4)} ` +
    `cost_usd=${summary.totalCostUsd.toFixed(6)}`,
);
console.log(
  `METRIC research_to_hp=${summary.expectedResearchPromotions} ` +
    `exact=${summary.exactMatches}/${summary.caseCount}`,
);
console.log(`METRIC ladder_miss=${ladderMiss}`);
console.log(
  `DIAGNOSTIC synthetic_miss=${syntheticMiss} investor_reference_miss=${investorReferenceMiss}`,
);
console.log(
  `REFERENCE sourced_cases=${sourcedCases.length} ` +
    `fit_only_conflicts=${fitOnlyConflicts}`,
);
console.log(
  `SCOPE classification_only=true worker_proof=false primary_cohort=sourced_real ` +
    `legacy_segment_comparable=false current_actionability_truth=false ` +
    `supplied_reference_domains=true identity_discovery_exercised=false ` +
    `publisher_identity_from_raw=true website_same_domain_only=true ` +
    `live_website=${liveFetch} frozen_evidence_v3=${frozenParse.success}`,
);
console.log(
  `EVIDENCE publisher_failures=${frozenPublisherFailures} website_holds=${frozenWebsiteHolds} ` +
    `excluded_website_pages=${frozenExcludedWebsitePages}`,
);
console.log(
  `ASI cases=${summary.caseCount} cost_usd=${summary.totalCostUsd.toFixed(6)}`,
);

const resultPath = process.env["BAKEOFF_RESULTS_PATH"];
if (resultPath !== undefined && resultPath.trim() !== "") {
  writeFileSync(
    resultPath,
    `${JSON.stringify(
      {
        version: "jev-bakeoff-v3",
        generatedAt: new Date().toISOString(),
        scope: {
          classificationOnly: true,
          workerProof: false,
          primaryCohort: "sourced_real",
          legacySegmentComparable: false,
          currentActionabilityTruth: false,
          suppliedReferenceDomains: true,
          identityDiscoveryExercised: false,
          publisherIdentityFromRaw: true,
          websiteSameDomainOnly: true,
          liveWebsite: liveFetch,
          frozenEvidenceVersion: frozenParse.success
            ? frozenParse.data.version
            : null,
        },
        evidenceRetrieval: {
          publisherFailures: frozenPublisherFailures,
          websiteHolds: frozenWebsiteHolds,
          excludedWebsitePages: frozenExcludedWebsitePages,
        },
        outcomes,
        labels: cases.map((entry) => ({
          id: entry.input.id,
          cohort: entry.cohort,
          referenceExpected: entry.referenceExpected,
          expected: entry.expected,
          labelBasis: entry.labelBasis,
        })),
        summary,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`RESULTS ${resultPath}`);
}
