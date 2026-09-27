/**
 * Website-content evidence for FAA ensemble screening (Exa /contents).
 *
 * Fetches a company's official homepage + /products + /about pages (max 3
 * fetches) through ExaSearchClient.fetchContents and derives the signals the
 * JEv screen cannot see today:
 * - websiteOffering: products_menu (product/catalog nav or a /products page
 *   with named items) vs capabilities_only (services/capabilities pages, no
 *   products) vs unknown (nothing fetched or nothing conclusive).
 * - ownershipHints / sizeHints: short excerpts backing ownership and scale
 *   questions (founded/family-owned/subsidiary/acquired; headcount/facility).
 *
 * Spend: every page of extracted text costs EXA_CONTENTS_COST_USD (see
 * ./exa-budget.js — Exa contents ~$0.005-0.01/page; the shared counter uses
 * the conservative $0.01 figure). The daily gate is checked up front for the
 * full 3-page estimate; spend is recorded per page actually returned. The
 * Exa key is read from EXA_API_KEY env only by callers and is never logged.
 *
 * Persistence contract (for the scheduler step that writes rows): one
 * source_documents row per fetched page plus evidence rows with
 * extractionMethod = WEBSITE_EVIDENCE_EXTRACTION_METHOD ("exa_..." prefix)
 * and metadata shaped as WEBSITE_EVIDENCE_METADATA_KEYS. The runner lookup
 * (loadWebsiteEvidence in ../faa-ensemble/runner.js) reads that shape back.
 */
import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import { getDatabase, type Database } from "@asi/database/client";
import { normalizeUnifiedName } from "@asi/database";

import {
  canSpendExa,
  recordExaSpendUsd,
  EXA_CONTENTS_COST_USD,
} from "./exa-budget.js";
import { EXA_CONTENTS_URL_LIMIT, ExaSearchClient } from "../search/exa.js";
import type { WebsiteOffering } from "../scoring-axial/features.js";

export type { WebsiteOffering };

/** extraction_method prefix contract: MUST stay "exa_..."-prefixed. */
export const WEBSITE_EVIDENCE_EXTRACTION_METHOD = "exa_website_content_v1";

/** Evidence-metadata keys the runner lookup reads back. */
export const WEBSITE_EVIDENCE_METADATA_KEYS = {
  offering: "website_offering",
  excerpts: "website_excerpts",
  ownershipHints: "ownership_hints",
  sizeHints: "size_hints",
} as const;

/** Total excerpt budget: excerpts are capped to 2,000 chars combined. */
export const WEBSITE_EXCERPTS_MAX_CHARS = 2_000;
const MAX_HINTS_PER_KIND = 6;
const HINT_MAX_CHARS = 240;
/** A /products page shorter than this is nav boilerplate, not a catalog. */
const PRODUCTS_PAGE_MIN_CHARS = 300;
const MAX_PAGES = EXA_CONTENTS_URL_LIMIT;

export interface WebsiteEvidence {
  readonly websiteOffering: WebsiteOffering;
  /** Combined excerpt text, capped at WEBSITE_EXCERPTS_MAX_CHARS. */
  readonly excerpts: string;
  readonly ownershipHints: readonly string[];
  readonly sizeHints: readonly string[];
}
export interface WebsiteFetchResult extends WebsiteEvidence {
  /** Conservative accounting: EXA_CONTENTS_COST_USD per page returned. */
  readonly costUsd: number;
  readonly fetchesAttempted: number;
  readonly fetchesSucceeded: number;
  /** True when the daily budget gate refused the fetch. */
  readonly budgetLimited: boolean;
  readonly pages: readonly {
    readonly url: string;
    readonly textChars: number;
    /** Leading excerpt for the persistence quote (capped, never the key). */
    readonly excerpt: string;
  }[];
}

export const EMPTY_WEBSITE_EVIDENCE: WebsiteEvidence = {
  websiteOffering: "unknown",
  excerpts: "",
  ownershipHints: [],
  sizeHints: [],
};

export interface FetchWebsiteEvidenceOptions {
  readonly client?: ExaSearchClient | undefined;
  readonly fetch?: typeof fetch | undefined;
}

/**
 * Normalize a bare domain or full URL to an https origin. Returns null when
 * no usable host can be derived.
 */
export function normalizeWebsiteOrigin(domainOrUrl: string): string | null {
  const trimmed = domainOrUrl.trim();
  if (trimmed === "") return null;
  const withScheme =
    trimmed.startsWith("http://") || trimmed.startsWith("https://")
      ? trimmed
      : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const host = url.hostname.trim().toLowerCase();
    if (host === "" || host.includes(" ")) return null;
    return `https://${host}`;
  } catch {
    return null;
  }
}

/** Homepage + /products + /about page URLs for one origin (max 3). */
export function buildWebsitePageUrls(domainOrUrl: string): string[] {
  const origin = normalizeWebsiteOrigin(domainOrUrl);
  if (origin === null) return [];
  return [`${origin}/`, `${origin}/products`, `${origin}/about`].slice(
    0,
    MAX_PAGES,
  );
}

const PRODUCTS_MENU_PATTERN =
  /product\s*(catalog|categories|lines?|overview|menu|families)|our products|shop\s+(all|products)|view\s+(all\s+)?products|featured products|product finder/iu;
const CAPABILITIES_PATTERN =
  /capabilit|our services|what we do|contract manufacturing|build.to.print|precision machining services|repair (services|station|capabilit)/iu;
const OWNERSHIP_SENTENCE_PATTERN =
  /founded|family.owned|privately held|subsidiary|division of|acquired by|acquisition|parent compan|a\s+\S+\s+compan(y|ies)\b|owned by|holding compan|private equit|portfolio compan/iu;
const SIZE_SENTENCE_PATTERN =
  /\d[\d,]*\s*(employees|associates|team members|staff|people)|square\s+feet|sq\.?\s*ft\.?|\d+\s*acre|manufacturing (plant|facilit)|facilit(ies|y)\s+(in|across|totaling)|headcount|employees\s+(in|across|worldwide)/iu;

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/gu, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9(])/gu)
    .map((s) => s.trim())
    .filter((s) => s.length >= 24 && s.length <= 600);
}

function pickHintSentences(text: string, pattern: RegExp): string[] {
  const out: string[] = [];
  for (const sentence of splitSentences(text)) {
    if (out.length >= MAX_HINTS_PER_KIND) break;
    pattern.lastIndex = 0;
    if (!pattern.test(sentence)) continue;
    const hint =
      sentence.length > HINT_MAX_CHARS
        ? `${sentence.slice(0, HINT_MAX_CHARS - 1).trimEnd()}…`
        : sentence;
    if (!out.includes(hint)) out.push(hint);
  }
  return out;
}

/**
 * Pure classifier over fetched page texts (keyed by URL). Exported for the
 * scheduler persistence step and tests.
 */
export function classifyWebsiteEvidence(
  pages: readonly { readonly url: string; readonly text: string }[],
): WebsiteEvidence {
  const combined = pages.map((p) => p.text).join("\n\n");
  const productsPage = pages.find((p) => /\/products\/?$/iu.test(p.url));
  const productsPageSubstantive =
    productsPage !== undefined &&
    productsPage.text.trim().length >= PRODUCTS_PAGE_MIN_CHARS;
  PRODUCTS_MENU_PATTERN.lastIndex = 0;
  const hasProductsMenu =
    productsPageSubstantive || PRODUCTS_MENU_PATTERN.test(combined);
  let websiteOffering: WebsiteOffering = "unknown";
  if (hasProductsMenu) {
    websiteOffering = "products_menu";
  } else if (combined.trim() !== "") {
    CAPABILITIES_PATTERN.lastIndex = 0;
    websiteOffering = CAPABILITIES_PATTERN.test(combined)
      ? "capabilities_only"
      : "unknown";
  }
  const ownershipHints = pickHintSentences(
    combined,
    OWNERSHIP_SENTENCE_PATTERN,
  );
  const sizeHints = pickHintSentences(combined, SIZE_SENTENCE_PATTERN);
  const excerpts = [...ownershipHints, ...sizeHints]
    .join(" ")
    .slice(0, WEBSITE_EXCERPTS_MAX_CHARS);
  return { websiteOffering, excerpts, ownershipHints, sizeHints };
}

/**
 * Fetch official-site evidence for one company. Never throws for provider or
 * budget outcomes: failures and budget limits return EMPTY evidence with
 * accounting attached (budgetLimited / fetchesSucceeded distinguish them).
 * The apiKey is used only as the Exa credential header — never logged.
 */
export async function fetchWebsiteEvidence(
  apiKey: string,
  domainOrUrl: string,
  _companyName: string,
  options: FetchWebsiteEvidenceOptions = {},
): Promise<WebsiteFetchResult> {
  const urls = buildWebsitePageUrls(domainOrUrl);
  const empty = (
    extra: Partial<WebsiteFetchResult> = {},
  ): WebsiteFetchResult => ({
    ...EMPTY_WEBSITE_EVIDENCE,
    costUsd: 0,
    fetchesAttempted: urls.length,
    fetchesSucceeded: 0,
    budgetLimited: false,
    pages: [],
    ...extra,
  });
  if (urls.length === 0) return empty();
  // Gate the full 3-page estimate up front against the shared daily counter.
  if (!canSpendExa(urls.length * EXA_CONTENTS_COST_USD)) {
    return empty({ budgetLimited: true });
  }
  const client =
    options.client ?? new ExaSearchClient({ apiKey, fetch: options.fetch });
  let results: readonly { url: string; text: string }[];
  try {
    results = await client.fetchContents(urls);
  } catch {
    return empty();
  }
  const pages = results
    .filter((r) => typeof r.text === "string" && r.text.trim() !== "")
    .map((r) => ({ url: r.url, text: r.text }));
  // Conservative accounting: one contents charge per page actually returned.
  // recordExaSpendUsd returns the day's running total, so the call's own
  // cost is the per-page charge times pages returned.
  const costUsd = pages.length * EXA_CONTENTS_COST_USD;
  if (pages.length > 0) recordExaSpendUsd(costUsd);
  if (pages.length === 0) {
    return empty({
      fetchesSucceeded: 0,
      pages: [],
    });
  }
  const evidence = classifyWebsiteEvidence(pages);
  return {
    ...evidence,
    costUsd,
    fetchesAttempted: urls.length,
    fetchesSucceeded: pages.length,
    budgetLimited: false,
    pages: pages.map((p) => ({
      url: p.url,
      textChars: p.text.length,
      excerpt: p.text.replace(/\s+/gu, " ").trim().slice(0, 500),
    })),
  };
}

// ---------------------------------------------------------------------------
// Scheduler tick entry-point (unvetted HP + P1 queue, cap 10/tick)
// ---------------------------------------------------------------------------

/** Scheduler cap: at most this many website enrichments per tick. */
export const WEBSITE_ENRICHMENT_TICK_CAP = 10;

export interface WebsiteEnrichmentCandidate {
  readonly companyName: string;
  readonly domain: string | null;
}

export interface WebsiteEnrichmentOptions {
  /** Max domains to enrich; clamped to WEBSITE_ENRICHMENT_TICK_CAP. */
  readonly limit?: number;
  /** Defaults to process.env.EXA_API_KEY (never logged). */
  readonly exaApiKey?: string;
}

export interface WebsiteEnrichmentSummary {
  readonly checked: number;
  readonly enriched: number;
  readonly skipped: string | null;
  readonly costUsd: number;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Persist one fetched site: a source_documents row per page plus an evidence
 * row per document (extraction method WEBSITE_EVIDENCE_EXTRACTION_METHOD,
 * metadata shaped as WEBSITE_EVIDENCE_METADATA_KEYS for the runner lookup).
 * Best-effort and never throws. Also appends the page URLs to the unified
 * target's evidence_urls.
 */
async function persistWebsiteEvidence(
  db: Database,
  companyName: string,
  result: WebsiteFetchResult,
): Promise<void> {
  try {
    if (result.fetchesSucceeded === 0) return;
    const sourceRows = await db.execute<{ id: string }>(sql`
      INSERT INTO data_sources (name, source_type, publisher, access, ingestion)
      VALUES ('Exa', 'website', 'Exa', 'public', 'manual')
      ON CONFLICT (lower(name), coalesce(publisher, '')) DO NOTHING
      RETURNING id
    `);
    let sourceId = sourceRows.rows[0]?.id ?? null;
    if (sourceId === null) {
      const existing = await db.execute<{ id: string }>(sql`
        SELECT id FROM data_sources WHERE lower(name) = 'exa' LIMIT 1
      `);
      sourceId = existing.rows[0]?.id ?? null;
    }
    if (sourceId === null) return;
    const metadata = JSON.stringify({
      companyName,
      [WEBSITE_EVIDENCE_METADATA_KEYS.offering]: result.websiteOffering,
      [WEBSITE_EVIDENCE_METADATA_KEYS.excerpts]: result.excerpts,
      [WEBSITE_EVIDENCE_METADATA_KEYS.ownershipHints]: result.ownershipHints,
      [WEBSITE_EVIDENCE_METADATA_KEYS.sizeHints]: result.sizeHints,
    });
    const pageUrls: string[] = [];
    for (const page of result.pages) {
      const docHash = sha256Hex(`${page.url}\u0000${result.websiteOffering}`);
      const docRows = await db.execute<{ id: string }>(sql`
        INSERT INTO source_documents
          (data_source_id, canonical_url, title, document_type, content_sha256, metadata)
        VALUES (
          ${sourceId},
          ${page.url},
          ${`Official site: ${companyName}`},
          'web_page',
          ${docHash},
          ${JSON.stringify({ companyName, method: WEBSITE_EVIDENCE_EXTRACTION_METHOD })}::jsonb
        )
        ON CONFLICT (content_sha256) DO NOTHING
        RETURNING id
      `);
      let documentId = docRows.rows[0]?.id ?? null;
      if (documentId === null) {
        const existing = await db.execute<{ id: string }>(sql`
          SELECT id FROM source_documents WHERE content_sha256 = ${docHash} LIMIT 1
        `);
        documentId = existing.rows[0]?.id ?? null;
      }
      if (documentId === null) continue;
      pageUrls.push(page.url);
      await db.execute(sql`
        INSERT INTO evidence
          (source_document_id, quote, locator, extraction_method, content_sha256, metadata)
        VALUES (
          ${documentId},
          ${page.excerpt},
          ${page.url},
          ${WEBSITE_EVIDENCE_EXTRACTION_METHOD},
          ${sha256Hex(`${page.url}\u0000${page.excerpt}`)},
          ${metadata}::jsonb
        )
      `);
    }
    if (pageUrls.length > 0) {
      const normalized = normalizeUnifiedName(companyName);
      await db.execute(sql`
        UPDATE unified_targets
        SET evidence_urls = (
          SELECT COALESCE(jsonb_agg(DISTINCT e), '[]'::jsonb)
          FROM jsonb_array_elements_text(
            COALESCE(unified_targets.evidence_urls, '[]'::jsonb) || ${JSON.stringify(pageUrls)}::jsonb
          ) AS e
        ),
        updated_at = now()
        WHERE normalized_name = ${normalized}
      `);
    }
  } catch {
    // Persistence is best-effort; the fetch result still stands.
  }
}

/**
 * Unified HP / P1 names with a domain that have no website evidence yet,
 * oldest-touched first. "Unvetted" is derived (no schema changes): no
 * evidence row with the website extraction method is linked to a document
 * whose URL contains the target's domain.
 */
export async function selectWebsiteEnrichmentCandidates(
  db: Database,
  limit: number,
): Promise<WebsiteEnrichmentCandidate[]> {
  const capped = Math.max(0, Math.min(limit, WEBSITE_ENRICHMENT_TICK_CAP));
  if (capped === 0) return [];
  const result = await db.execute<{
    company_name: string;
    domain: string | null;
    website_url: string | null;
  }>(sql`
    SELECT company_name, domain, website_url
    FROM unified_targets ut
    WHERE (tier = 'high_interest' OR investor_priority = 1)
      AND COALESCE(domain, website_url) IS NOT NULL
      AND COALESCE(domain, website_url) <> ''
      AND NOT EXISTS (
        SELECT 1 FROM evidence e
        JOIN source_documents sd ON sd.id = e.source_document_id
        WHERE e.extraction_method = ${WEBSITE_EVIDENCE_EXTRACTION_METHOD}
          AND position(lower(COALESCE(ut.domain, ut.website_url, '')) in lower(sd.canonical_url)) > 0
      )
    ORDER BY updated_at ASC NULLS FIRST
    LIMIT ${capped}
  `);
  return result.rows.map((row) => ({
    companyName: row.company_name,
    domain: row.domain ?? row.website_url,
  }));
}

/**
 * Batch website sweep for the scheduler tick: unvetted HP + P1 queue,
 * cap WEBSITE_ENRICHMENT_TICK_CAP/tick, stops early when the
 * EXA_DAILY_BUDGET_USD cap is reached. Key sourced from EXA_API_KEY env
 * unless overridden. Never throws.
 */
export async function runWebsiteEnrichment(
  db: Database = getDatabase(),
  opts: WebsiteEnrichmentOptions = {},
): Promise<WebsiteEnrichmentSummary> {
  try {
    const apiKey = opts.exaApiKey ?? process.env["EXA_API_KEY"] ?? "";
    if (apiKey.trim().length === 0) {
      return {
        checked: 0,
        enriched: 0,
        skipped: "missing_exa_api_key",
        costUsd: 0,
      };
    }
    const candidates = await selectWebsiteEnrichmentCandidates(
      db,
      opts.limit ?? WEBSITE_ENRICHMENT_TICK_CAP,
    );
    let checked = 0;
    let enriched = 0;
    let costUsd = 0;
    let skipped: string | null =
      candidates.length === 0 ? "no_candidates" : null;
    for (const candidate of candidates) {
      if (candidate.domain === null || !canSpendExa(EXA_CONTENTS_COST_USD)) {
        skipped = "budget_exhausted";
        break;
      }
      const outcome = await fetchWebsiteEvidence(
        apiKey,
        candidate.domain,
        candidate.companyName,
      );
      checked += 1;
      costUsd += outcome.costUsd;
      if (outcome.budgetLimited) {
        skipped = "budget_exhausted";
        break;
      }
      if (outcome.fetchesSucceeded > 0) {
        await persistWebsiteEvidence(db, candidate.companyName, outcome);
        enriched += 1;
      } else {
        // Touch last-checked order on empty fetches so the same dead
        // domains do not burn the cap every tick (no evidence is claimed).
        try {
          const normalized = normalizeUnifiedName(candidate.companyName);
          await db.execute(sql`
            UPDATE unified_targets SET updated_at = now()
            WHERE normalized_name = ${normalized}
          `);
        } catch {
          // Best-effort rotation touch.
        }
      }
    }
    return { checked, enriched, skipped, costUsd };
  } catch {
    return { checked: 0, enriched: 0, skipped: "error", costUsd: 0 };
  }
}
