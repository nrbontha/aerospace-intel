import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import { getDatabase, type Database } from "@asi/database/client";
import { normalizeUnifiedName } from "@asi/database";

import { ExaSearchClient } from "../search/exa.js";
import {
  canSpendExa,
  EXA_SEARCH_COST_USD,
  recordExaSpendUsd,
} from "./exa-budget.js";

/**
 * Acquisition/ownership news check (Agent OwnNewsCheck owns this module).
 *
 * Exa search `"<name>" acquired by OR acquisition OR acquired`, classify the
 * snippets, and persist affirmative findings. Writes `ownership_observations`
 * (plus the supporting `source_documents` + `evidence` rows, extraction
 * method `exa_acquisition_search`) ONLY on affirmative acquisition / PE /
 * public-parent findings with a named owner — never on ambiguous results.
 * `unified_targets.ownership_status` is updated on any affirmative finding
 * (including `dead`, which carries no owner and therefore no observation
 * row). Everything here is fail-soft: any failure resolves to `unknown`
 * and this module never throws, never logs the Exa key.
 *
 * Conservative by construction: a supporting snippet must pass an identity
 * gate (the company name — or every significant token of it — or its
 * domain must appear in the snippet) before it can affirm anything, so
 * conglomerate-name collisions (common surnames, e.g. "Smith ...") resolve
 * to `unknown`, never to a false owner. Conflicting signals (dead vs
 * acquired, two different owners) also resolve to `unknown`.
 */

export type AcquisitionStatus =
  "acquired" | "pe_owned" | "public_parent" | "dead" | "unknown";

export interface AcquisitionHistoryResult {
  readonly status: AcquisitionStatus;
  readonly owner: string | null;
  readonly year: number | null;
  readonly excerpt: string | null;
  readonly sourceUrl: string | null;
  readonly costUsd: number;
}

/** Scheduler cap: at most this many ownership checks per tick. */
export const OWNERSHIP_CHECK_TICK_CAP = 10;

const EXCERPT_MAX_CHARS = 500;
const OWNER_MAX_CHARS = 120;
const MAX_SNIPPETS = 3;

const LEGAL_SUFFIX_RE =
  /\s+(llc|inc|corp|corporation|incorporated|co|company|ltd|limited|lp|llp|pllc|plc|gmbh|pa|pc)\.?$/i;

const ACQUIRE_RE = /acquir|acquisit/i;
const PE_SIGNAL_RE =
  /private[\s-]?equity|portfolio company|buyout|backed by|investment firm|venture capital/i;
const PUBLIC_SIGNAL_RE =
  /nasdaq|nyse|publicly[\s-]?traded|public company|stock exchange|\bticker\b|s&p 500/i;
const DEAD_SIGNAL_RE =
  /ceased (all )?operations|shut\s?down|went out of business|\bdefunct\b|was dissolved|liquidat(?:ed|ion)|wound down|closed (its doors|permanently)|no longer operates|out of business/i;
const YEAR_RE = /\b(19[89]\d|20[0-2]\d)\b/;

const OWNER_PHRASE = "([A-Z][\\w'’&.,-]*(?:\\s+[A-Z][\\w'’&.,-]*){0,3})";
const OWNER_PATTERNS: RegExp[] = [
  new RegExp(`acquired\\s+by\\s+${OWNER_PHRASE}`, "i"),
  new RegExp(`acquisition\\b[^.;]{0,120}?\\bby\\s+${OWNER_PHRASE}`, "i"),
  new RegExp(`${OWNER_PHRASE}\\s+(?:has|have)\\s+acquired\\b`, "i"),
  new RegExp(`${OWNER_PHRASE}\\s+acquires\\b`, "i"),
  new RegExp(
    `${OWNER_PHRASE}\\s+(?:has\\s+|have\\s+)?(?:complet(?:e|es|ed)(?:\\s+its)?\\s+|announc(?:e|es|ed)(?:\\s+its)?\\s+|clos(?:e|es|ed)(?:\\s+its)?\\s+)?(?:the\\s+)?acquisition\\b`,
    "i",
  ),
  new RegExp(`(?:subsidiary|division|unit)\\s+of\\s+${OWNER_PHRASE}`, "i"),
  new RegExp(`wholly[-\\s]?owned\\s+by\\s+${OWNER_PHRASE}`, "i"),
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanCompanyName(name: string): string {
  return name
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(LEGAL_SUFFIX_RE, "")
    .trim();
}

function identityTokens(name: string): string[] {
  return cleanCompanyName(name)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Identity gate: the snippet (title + text) must mention this company, or
 * the result URL must belong to its domain. Word-boundary matching so short
 * tokens (e.g. "ami") cannot match inside unrelated words.
 */
function passesIdentityGate(
  snippet: string,
  companyName: string,
  domain: string | undefined,
  url: string,
): boolean {
  const hay = snippet.toLowerCase();
  const cleaned = cleanCompanyName(companyName);
  if (cleaned.length >= 4) {
    const full = new RegExp(`\\b${escapeRegExp(cleaned)}\\b`);
    if (full.test(hay)) return true;
  }
  const tokens = identityTokens(companyName);
  if (
    tokens.length > 0 &&
    tokens.every((token) =>
      new RegExp(`\\b${escapeRegExp(token)}\\b`).test(hay),
    )
  ) {
    return true;
  }
  if (domain !== undefined) {
    const host = hostOf(url);
    const normalizedDomain = domain.toLowerCase().replace(/^www\./, "");
    if (
      host !== null &&
      (host === normalizedDomain || host.endsWith(`.${normalizedDomain}`))
    ) {
      return true;
    }
  }
  return false;
}

function cleanOwner(raw: string, companyName: string): string | null {
  const owner = raw
    .replace(/[.,;:'"]+$/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s+(completes?|announces?|closes?|has|have)$/i, "");
  if (owner.length === 0 || owner.length > OWNER_MAX_CHARS) return null;
  if (owner.toLowerCase() === cleanCompanyName(companyName)) return null;
  if (/^(the|a|an|its|their|this|that)\b/i.test(owner)) return null;
  return owner;
}

interface SentenceVote {
  status: Exclude<AcquisitionStatus, "unknown">;
  owner: string | null;
  sentence: string;
}

export function classifySentence(
  sentence: string,
  companyName: string,
): SentenceVote | null {
  const dead = DEAD_SIGNAL_RE.test(sentence);
  const acquired = ACQUIRE_RE.test(sentence);
  const hasOwnerSignal =
    acquired || /subsidiary|division|unit of|wholly[-\s]?owned/i.test(sentence);
  // Dead and acquired in the same sentence is contradictory — no vote.
  if (dead && acquired) return null;
  if (dead) return { status: "dead", owner: null, sentence };
  if (!hasOwnerSignal) return null;
  let owner: string | null = null;
  for (const pattern of OWNER_PATTERNS) {
    const match = pattern.exec(sentence);
    if (match?.[1] !== undefined) {
      owner = cleanOwner(match[1], companyName);
      if (owner !== null) break;
    }
  }
  if (owner === null) return null;
  if (PE_SIGNAL_RE.test(sentence))
    return { status: "pe_owned", owner, sentence };
  if (PUBLIC_SIGNAL_RE.test(sentence))
    return { status: "public_parent", owner, sentence };
  return { status: "acquired", owner, sentence };
}

function extractYear(text: string): number | null {
  const match = YEAR_RE.exec(text);
  if (match?.[1] === undefined) return null;
  const year = Number(match[1]);
  const currentYear = new Date().getUTCFullYear();
  if (year < 1980 || year > currentYear + 1) return null;
  return year;
}

function truncate(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > maxChars ? collapsed.slice(0, maxChars) : collapsed;
}

/**
 * Exa acquisition-history check. Never throws: any failure (missing key,
 * budget exhausted, network, parse, DB) resolves to `status: "unknown"`.
 * The key is read from the argument (scheduler sources it from EXA_API_KEY
 * env) and is never logged.
 */
export async function checkAcquisitionHistory(
  apiKey: string,
  companyName: string,
  domain?: string,
): Promise<AcquisitionHistoryResult> {
  const unknown: AcquisitionHistoryResult = {
    status: "unknown",
    owner: null,
    year: null,
    excerpt: null,
    sourceUrl: null,
    costUsd: 0,
  };
  try {
    const name = companyName.trim();
    if (apiKey.trim().length === 0 || name.length === 0) return unknown;
    // Spend cap: resolve to unknown without calling Exa when the day's
    // budget is already exhausted.
    if (!canSpendExa(EXA_SEARCH_COST_USD)) return unknown;

    const client = new ExaSearchClient({ apiKey });
    // Exa search costs ~$0.005/call; the client response carries no usage
    // actuals, so record the conservative estimate.
    const results = await client.search(
      `"${name}" acquired by OR acquisition OR acquired`,
    );
    recordExaSpendUsd(EXA_SEARCH_COST_USD);
    const costUsd = EXA_SEARCH_COST_USD;

    const votes: SentenceVote[] = [];
    let supportingUrl: string | null = null;
    for (const result of results.slice(0, MAX_SNIPPETS)) {
      const snippet = `${result.title}. ${result.text}`;
      if (
        !passesIdentityGate(
          snippet,
          name,
          domain?.trim() || undefined,
          result.url,
        )
      ) {
        continue;
      }
      const sentences = snippet.split(/(?<=[.!?])\s+/);
      for (const sentence of sentences) {
        const vote = classifySentence(sentence, name);
        if (vote !== null) {
          votes.push(vote);
          supportingUrl ??= result.url;
        }
      }
    }

    if (votes.length === 0) return { ...unknown, costUsd };
    const first = votes[0];
    if (first === undefined) return { ...unknown, costUsd };
    const status = first.status;
    const statuses = new Set(votes.map((vote) => vote.status));
    if (statuses.size !== 1) return { ...unknown, costUsd };
    const owners = new Set(
      votes
        .map((vote) => vote.owner)
        .filter((owner): owner is string => owner !== null),
    );
    // Two different named owners (name collision across snippets) → unknown.
    if (status !== "dead" && owners.size !== 1) return { ...unknown, costUsd };
    const owner = status === "dead" ? null : ([...owners][0] ?? null);
    if (status !== "dead" && owner === null) return { ...unknown, costUsd };

    const excerpt = truncate(
      votes.map((vote) => vote.sentence).join(" "),
      EXCERPT_MAX_CHARS,
    );
    const year = extractYear(votes.map((vote) => vote.sentence).join(" "));
    const result: AcquisitionHistoryResult = {
      status,
      owner,
      year,
      excerpt,
      sourceUrl: supportingUrl,
      costUsd,
    };
    await persistAffirmativeFinding(name, result);
    return result;
  } catch {
    return unknown;
  }
}

// ownership_type has no PE/public/dead variants: any named-owner finding is
// recorded as a subsidiary relationship, with the truth in owner_name.
const OBSERVATION_TYPE = "subsidiary";

function unifiedStatusFor(status: AcquisitionStatus): string {
  switch (status) {
    case "acquired":
      return "strategic_owned";
    case "pe_owned":
      return "pe_owned";
    case "public_parent":
      return "public";
    case "dead":
      return "dead";
    case "unknown":
      return "unknown";
  }
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Persist an affirmative finding. Best-effort and never throws:
 * - `unified_targets.ownership_status` (+ evidence URL) always updates;
 * - `ownership_observations` (+ `source_documents`/`evidence`, extraction
 *   method `exa_acquisition_search`) writes only when the company resolves
 *   to a `companies` row and an owner is named (schema requires one of
 *   owner_name / parent_company_id).
 */
async function persistAffirmativeFinding(
  companyName: string,
  result: AcquisitionHistoryResult,
): Promise<void> {
  try {
    if (
      result.status === "unknown" ||
      result.sourceUrl === null ||
      result.excerpt === null
    ) {
      return;
    }
    const db = getDatabase();
    // Unified rows are keyed by contract normalization (lowercase + legal
    // suffix strip); companies rows are matched on raw lowercase instead.
    const companyKey = companyName.replace(/\s+/g, " ").trim().toLowerCase();
    const normalized = normalizeUnifiedName(companyName);

    const companyRows = await db.execute<{ id: string }>(sql`
      SELECT id FROM companies
      WHERE lower(legal_name) = ${companyKey} OR lower(display_name) = ${companyKey}
      LIMIT 1
    `);
    const companyId = companyRows.rows[0]?.id ?? null;

    if (
      companyId !== null &&
      result.owner !== null &&
      result.status !== "dead"
    ) {
      const sourceRows = await db.execute<{ id: string }>(sql`
        INSERT INTO data_sources (name, source_type, publisher, access, ingestion)
        VALUES ('Exa', 'news', 'Exa', 'public', 'manual')
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
      if (sourceId !== null) {
        const docHash = sha256Hex(`${result.sourceUrl}\u0000${result.excerpt}`);
        const docRows = await db.execute<{ id: string }>(sql`
          INSERT INTO source_documents
            (data_source_id, canonical_url, title, document_type, content_sha256, metadata)
          VALUES (
            ${sourceId},
            ${result.sourceUrl},
            ${`Exa acquisition check: ${companyName}`},
            'news',
            ${docHash},
            ${JSON.stringify({ companyName, method: "exa_acquisition_search" })}::jsonb
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
        if (documentId !== null) {
          const evidenceRows = await db.execute<{ id: string }>(sql`
            INSERT INTO evidence
              (source_document_id, quote, locator, extraction_method, content_sha256, metadata)
            VALUES (
              ${documentId},
              ${result.excerpt},
              ${result.sourceUrl},
              'exa_acquisition_search',
              ${sha256Hex(result.excerpt)},
              ${JSON.stringify({ companyName, owner: result.owner, year: result.year })}::jsonb
            )
            RETURNING id
          `);
          const evidenceId = evidenceRows.rows[0]?.id ?? null;
          if (evidenceId !== null) {
            await db.execute(sql`
              INSERT INTO ownership_observations
                (company_id, type, owner_name, confidence, evidence_id, valid_from)
              VALUES (
                ${companyId},
                ${OBSERVATION_TYPE}::ownership_type,
                ${result.owner},
                ${result.year !== null ? 0.8 : 0.7},
                ${evidenceId},
                ${result.year !== null ? `${result.year}-01-01` : null}
              )
            `);
          }
        }
      }
    }

    await db.execute(sql`
      UPDATE unified_targets
      SET ownership_status = ${unifiedStatusFor(result.status)},
          evidence_urls = (
            SELECT COALESCE(jsonb_agg(DISTINCT e), '[]'::jsonb)
            FROM jsonb_array_elements_text(
              COALESCE(unified_targets.evidence_urls, '[]'::jsonb) || ${JSON.stringify([result.sourceUrl])}::jsonb
            ) AS e
          ),
          updated_at = now()
      WHERE normalized_name = ${normalized}
    `);
  } catch {
    // Persistence is best-effort; the classification result still stands.
  }
}

export interface OwnershipCheckCandidate {
  readonly companyName: string;
  readonly domain: string | null;
}

export interface OwnershipCheckOptions {
  /** Max names to check; clamped to OWNERSHIP_CHECK_TICK_CAP. */
  readonly limit?: number;
  /** Defaults to process.env.EXA_API_KEY (never logged). */
  readonly exaApiKey?: string;
}

export interface OwnershipCheckSummary {
  readonly checked: number;
  readonly affirmed: number;
  readonly skipped: string | null;
  readonly costUsd: number;
}

/** HP-unified names still lacking ownership evidence, oldest-touched first. */
export async function selectOwnershipCheckCandidates(
  db: Database,
  limit: number,
): Promise<OwnershipCheckCandidate[]> {
  const capped = Math.max(0, Math.min(limit, OWNERSHIP_CHECK_TICK_CAP));
  if (capped === 0) return [];
  const result = await db.execute<{
    company_name: string;
    domain: string | null;
  }>(sql`
    SELECT company_name, domain
    FROM unified_targets
    WHERE tier = 'high_interest'
      AND (ownership_status IS NULL OR ownership_status = 'unknown')
    ORDER BY updated_at ASC NULLS FIRST
    LIMIT ${capped}
  `);
  return result.rows.map((row) => ({
    companyName: row.company_name,
    domain: row.domain,
  }));
}

/**
 * Batch ownership sweep for the scheduler tick: HP-unified names lacking
 * ownership evidence, cap OWNERSHIP_CHECK_TICK_CAP/tick, stops early when
 * the EXA_DAILY_BUDGET_USD cap is reached. Never throws.
 */
export async function runOwnershipChecks(
  db: Database = getDatabase(),
  opts: OwnershipCheckOptions = {},
): Promise<OwnershipCheckSummary> {
  try {
    const apiKey = opts.exaApiKey ?? process.env["EXA_API_KEY"] ?? "";
    if (apiKey.trim().length === 0) {
      return {
        checked: 0,
        affirmed: 0,
        skipped: "missing_exa_api_key",
        costUsd: 0,
      };
    }
    const candidates = await selectOwnershipCheckCandidates(
      db,
      opts.limit ?? OWNERSHIP_CHECK_TICK_CAP,
    );
    let checked = 0;
    let affirmed = 0;
    let costUsd = 0;
    let skipped: string | null =
      candidates.length === 0 ? "no_candidates" : null;
    for (const candidate of candidates) {
      if (!canSpendExa(EXA_SEARCH_COST_USD)) {
        skipped = "budget_exhausted";
        break;
      }
      const outcome = await checkAcquisitionHistory(
        apiKey,
        candidate.companyName,
        candidate.domain ?? undefined,
      );
      checked += 1;
      costUsd += outcome.costUsd;
      if (outcome.status !== "unknown") affirmed += 1;
      // Touch last-checked order on ambiguous results so the same names do
      // not burn the cap every tick (no evidence is claimed by this touch).
      if (outcome.status === "unknown") {
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
    return { checked, affirmed, skipped, costUsd };
  } catch {
    return { checked: 0, affirmed: 0, skipped: "error", costUsd: 0 };
  }
}
