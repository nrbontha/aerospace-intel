/**
 * Populate the `unified_targets` acquisition-target table (migration 0008).
 *
 * Idempotent + rerunnable: every row is keyed by `normalized_name` and merged
 * on conflict (origins/evidence array-union, first-non-null scalars, tier
 * never downgrades). Uses raw SQL only — never DELETE/UPDATEs pipeline
 * tables, so it is safe to run while the FAA ensemble benchmark writes
 * `faa_ensemble_*` rows concurrently.
 *
 * Sources, in order:
 *   (a) `golden_examples` DB rows            → tier reference, golden_v1_member true
 *   (b) `exports/curated-aerospace-targets-evidence.csv`
 *   (c) `companies` JOIN `candidates` (skip rejected/archived)
 *   (d) `faa_ensemble_results` JOIN `source_signals` (research/high_priority only)
 *
 * Usage:
 *   npx tsx scripts/populate-unified-targets.mts [--curated path/to.csv]
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

import { getPool } from "../packages/database/src/client.js";

// ---------------------------------------------------------------------------
// env bootstrap (mirror scripts/run-faa-ensemble.mts: source .env.local)
// ---------------------------------------------------------------------------
for (const line of existsSync(".env.local")
  ? readFileSync(".env.local", "utf8").split("\n")
  : []) {
  const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/u);
  const key = match?.[1];
  const value = match?.[2];
  if (
    key !== undefined &&
    value !== undefined &&
    process.env[key] === undefined
  ) {
    process.env[key] = value;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in tests/unified-targets.test.ts)
// ---------------------------------------------------------------------------

export const ORIGIN_GOLDEN_V1 = "golden_v1";
export const ORIGIN_CURATED = "curated";
export const ORIGIN_DISCOVERY = "discovery";
export const ORIGIN_FAA_ENSEMBLE = "faa_ensemble";

/** Tier rank: higher wins, never downgrades on merge. */
export const TIER_RANK: Record<string, number> = {
  needs_research: 1,
  evaluate: 2,
  high_interest: 3,
  reference: 4,
};

/**
 * Contract normalization: lowercase, trim, collapse whitespace, strip one
 * trailing legal-entity suffix. MUST match normalizeTargetName in
 * packages/database/src/unified-targets/records.ts.
 */
export function normalizeUnifiedName(name: string): string {
  return name
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[,.\s]+$/, "")
    .replace(
      /\s+(llc|inc|corp|corporation|incorporated|co|company|ltd|limited|lp|llp|pllc|plc)\.?$/,
      "",
    )
    .replace(/[,.\s]+$/, "");
}

/** Tier-no-downgrade merge: returns the higher-ranked of two tiers. */

/**
 * Entity-resolution benchmark fixtures (e.g. "New Domain Foundry a534ffe2",
 * "Aero Precision Machining mt5u8ng8", "Shared Brand ...") are seeded into
 * dev databases by tests. They must never leak into the shareable set.
 */
export function isSyntheticTargetName(name: string): boolean {
  const trimmed = name.trim();
  if (/^(New Domain|Shared Brand)\b/i.test(trimmed)) return true;
  if (/\s(mt[a-z0-9]{6}|[a-f0-9]{8})$/i.test(trimmed)) return true;
  return false;
}

/**
 * Names categorically off-thesis by scale (mega-cap primes/strategics that
 * can never be sub-$50M acquisitions). Documented, minimal, test-pinned.
 * Everything else is judged by evidence, not fame.
 */
const OFF_THESIS_NAMES = new Set(["anduril industries", "skydweller us"]);

export function isOffThesisName(name: string): boolean {
  return OFF_THESIS_NAMES.has(normalizeUnifiedName(name));
}
export function higherTier(a: string, b: string): string {
  return (TIER_RANK[a] ?? 0) >= (TIER_RANK[b] ?? 0) ? a : b;
}

/**
 * Curated CSV `screen_status` → tier. `credible_target` is high_interest;
 * anything else needs more evidence (evaluate). Rejects are excluded (null).
 */
export function mapCuratedTier(screenStatus: string | null): string | null {
  const status = (screenStatus ?? "").trim().toLowerCase();
  if (status === "credible_target") return "high_interest";
  if (status === "reject" || status === "rejected") return null;
  return "evaluate";
}

/**
 * Candidate status → tier. research_ready is high_interest, queued research
 * still needs research, everything else is evaluate. Rejects are excluded.
 */
export function mapCandidateTier(status: string | null): string | null {
  const s = (status ?? "").trim().toLowerCase();
  if (s === "research_ready") return "high_interest";
  if (s === "queued_research" || s === "queued") return "needs_research";
  if (s === "rejected" || s === "archived") return null;
  return "evaluate";
}

/** Ensemble final_decision → tier. Rejects are excluded (null). */
export function mapEnsembleTier(decision: string | null): string | null {
  const d = (decision ?? "").trim().toLowerCase();
  if (d === "high_priority") return "high_interest";
  if (d === "research") return "needs_research";
  return null;
}

/** Extract a bare lowercase domain from a website URL (null when absent). */
export function domainFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const bare = url
    .trim()
    .replace(/^https?:\/\//i, "")
    .split("/")[0]!
    .replace(/^www\./i, "")
    .trim()
    .toLowerCase();
  return bare === "" ? null : bare;
}

const US_STATE_CODES: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
  "district of columbia": "DC",
};

/**
 * Parse curated `hq` values like "Conway, South Carolina, US" into
 * city / state_code / country_code.
 */
export function parseHq(hq: string | null | undefined): {
  city: string | null;
  stateCode: string | null;
  countryCode: string | null;
} {
  const empty = { city: null, stateCode: null, countryCode: null };
  if (!hq || hq.trim() === "") return empty;
  const parts = hq.split(",").map((p) => p.trim());
  const city = parts[0] === "" ? null : (parts[0] ?? null);
  let stateCode: string | null = null;
  let countryCode: string | null = null;
  if (parts.length >= 3) {
    const stateName = (parts[1] ?? "").toLowerCase();
    stateCode =
      US_STATE_CODES[stateName] ?? (parts[1]!.trim() === "" ? null : parts[1]);
    const country = (parts[2] ?? "").toLowerCase();
    countryCode =
      country === "us" || country === "usa" || country === "united states"
        ? "US"
        : parts[2]!.trim().toUpperCase().slice(0, 2) || null;
  } else if (parts.length === 2) {
    const tail = (parts[1] ?? "").toLowerCase();
    if (tail === "us" || tail === "usa" || tail === "united states") {
      countryCode = "US";
    } else {
      stateCode =
        US_STATE_CODES[tail] ?? (parts[1]!.trim() === "" ? null : parts[1]);
    }
  }
  return { city, stateCode, countryCode };
}

/** Join a rationale string array into display text (null when empty). */
export function rationaleText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const items = value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v !== "");
  return items.length === 0 ? null : items.join("; ");
}

/** Coerce a current_scores axis value to a number (null when absent). */
export function scoreNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(String(value));
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Minimal CSV parser (curated export is small; handles quoted commas)
// ---------------------------------------------------------------------------

export function parseSimpleCsv(text: string): Record<string, string>[] {
  const source = text.replace(/^\uFEFF/, "");
  const table: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      table.push(row);
      row = [];
      field = "";
    } else if (ch === "\r") {
      // skip; \n handles the break
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    table.push(row);
  }
  if (table.length === 0) return [];
  const headers = table[0]!.map((h) => h.trim());
  return table.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    headers.forEach((h, idx) => {
      record[h] = (cells[idx] ?? "").trim();
    });
    return record;
  });
}

// ---------------------------------------------------------------------------
// Upsert plumbing (raw SQL, idempotent on normalized_name)
// ---------------------------------------------------------------------------

export interface UnifiedTargetRow {
  companyName: string;
  domain: string | null;
  websiteUrl: string | null;
  city: string | null;
  stateCode: string | null;
  countryCode: string | null;
  origin: string;
  goldenV1Member: boolean;
  tier: string;
  pipelineStatus: string | null;
  fit: number | null;
  novelty: number | null;
  confidence: number | null;
  actionability: number | null;
  ensembleDecision: string | null;
  ensembleConfidence: number | null;
  whyInteresting: string | null;
  risks: string | null;
  unknowns: string | null;
  evidenceUrls: string[];
  companyId: string | null;
  signalId: string | null;
  candidateId: string | null;
}

const UPSERT_COLUMNS = [
  "company_name",
  "normalized_name",
  "domain",
  "website_url",
  "city",
  "state_code",
  "country_code",
  "origins",
  "golden_v1_member",
  "tier",
  "pipeline_status",
  "fit",
  "novelty",
  "confidence",
  "actionability",
  "ensemble_decision",
  "ensemble_confidence",
  "why_interesting",
  "risks",
  "unknowns",
  "evidence_urls",
  "company_id",
  "signal_id",
  "candidate_id",
] as const;

function firstNonNull<T>(a: T | null, b: T | null): T | null {
  return a ?? b;
}

/**
 * Fold rows sharing a normalized name so a single INSERT batch never hits
 * the same conflict target twice (e.g. one company with two candidate rows).
 * Keeps the highest tier, unions origins/evidence, prefers first non-null scalars.
 */
export function mergeBatchDuplicates(
  rows: readonly UnifiedTargetRow[],
): UnifiedTargetRow[] {
  const byName = new Map<string, UnifiedTargetRow>();
  for (const row of rows) {
    const key = normalizeUnifiedName(row.companyName);
    const existing = byName.get(key);
    if (existing === undefined) {
      byName.set(key, { ...row, evidenceUrls: [...row.evidenceUrls] });
      continue;
    }
    const rank = (t: string): number => TIER_RANK[t] ?? 0;
    byName.set(key, {
      ...existing,
      domain: firstNonNull(existing.domain, row.domain),
      websiteUrl: firstNonNull(existing.websiteUrl, row.websiteUrl),
      city: firstNonNull(existing.city, row.city),
      stateCode: firstNonNull(existing.stateCode, row.stateCode),
      countryCode: firstNonNull(existing.countryCode, row.countryCode),
      goldenV1Member: existing.goldenV1Member || row.goldenV1Member,
      tier: rank(row.tier) > rank(existing.tier) ? row.tier : existing.tier,
      pipelineStatus: firstNonNull(existing.pipelineStatus, row.pipelineStatus),
      fit: firstNonNull(existing.fit, row.fit),
      novelty: firstNonNull(existing.novelty, row.novelty),
      confidence: firstNonNull(existing.confidence, row.confidence),
      actionability: firstNonNull(existing.actionability, row.actionability),
      ensembleDecision: firstNonNull(
        existing.ensembleDecision,
        row.ensembleDecision,
      ),
      ensembleConfidence: firstNonNull(
        existing.ensembleConfidence,
        row.ensembleConfidence,
      ),
      whyInteresting: firstNonNull(existing.whyInteresting, row.whyInteresting),
      risks: firstNonNull(existing.risks, row.risks),
      unknowns: firstNonNull(existing.unknowns, row.unknowns),
      evidenceUrls: [
        ...new Set([...existing.evidenceUrls, ...row.evidenceUrls]),
      ],
      companyId: firstNonNull(existing.companyId, row.companyId),
      signalId: firstNonNull(existing.signalId, row.signalId),
      candidateId: firstNonNull(existing.candidateId, row.candidateId),
    });
  }
  return [...byName.values()];
}

const EXISTING_RANK_SQL =
  "CASE unified_targets.tier WHEN 'reference' THEN 4 WHEN 'high_interest' THEN 3 WHEN 'evaluate' THEN 2 ELSE 1 END";
const EXCLUDED_RANK_SQL =
  "CASE EXCLUDED.tier WHEN 'reference' THEN 4 WHEN 'high_interest' THEN 3 WHEN 'evaluate' THEN 2 ELSE 1 END";

const CONFLICT_CLAUSE = `ON CONFLICT (normalized_name) DO UPDATE SET
  domain = COALESCE(unified_targets.domain, EXCLUDED.domain),
  website_url = COALESCE(unified_targets.website_url, EXCLUDED.website_url),
  city = COALESCE(unified_targets.city, EXCLUDED.city),
  state_code = COALESCE(unified_targets.state_code, EXCLUDED.state_code),
  country_code = COALESCE(unified_targets.country_code, EXCLUDED.country_code),
  origins = (SELECT COALESCE(jsonb_agg(DISTINCT e), '[]'::jsonb)
             FROM jsonb_array_elements_text(unified_targets.origins || EXCLUDED.origins) AS e),
  golden_v1_member = unified_targets.golden_v1_member OR EXCLUDED.golden_v1_member,
  tier = CASE WHEN (${EXCLUDED_RANK_SQL}) > (${EXISTING_RANK_SQL})
              THEN EXCLUDED.tier ELSE unified_targets.tier END,
  pipeline_status = COALESCE(unified_targets.pipeline_status, EXCLUDED.pipeline_status),
  fit = COALESCE(unified_targets.fit, EXCLUDED.fit),
  novelty = COALESCE(unified_targets.novelty, EXCLUDED.novelty),
  confidence = COALESCE(unified_targets.confidence, EXCLUDED.confidence),
  actionability = COALESCE(unified_targets.actionability, EXCLUDED.actionability),
  ensemble_decision = COALESCE(unified_targets.ensemble_decision, EXCLUDED.ensemble_decision),
  ensemble_confidence = COALESCE(unified_targets.ensemble_confidence, EXCLUDED.ensemble_confidence),
  why_interesting = COALESCE(unified_targets.why_interesting, EXCLUDED.why_interesting),
  risks = COALESCE(unified_targets.risks, EXCLUDED.risks),
  unknowns = COALESCE(unified_targets.unknowns, EXCLUDED.unknowns),
  evidence_urls = (SELECT COALESCE(jsonb_agg(DISTINCT e), '[]'::jsonb)
                   FROM jsonb_array_elements_text(unified_targets.evidence_urls || EXCLUDED.evidence_urls) AS e),
  company_id = COALESCE(unified_targets.company_id, EXCLUDED.company_id),
  signal_id = COALESCE(unified_targets.signal_id, EXCLUDED.signal_id),
  candidate_id = COALESCE(unified_targets.candidate_id, EXCLUDED.candidate_id),
  updated_at = now()`;

/**
 * Bulk upsert one source batch. Returns per-source inserted/merged counts
 * (`xmax = 0` marks freshly inserted rows).
 */
export async function upsertBatch(
  query: (
    text: string,
    params: unknown[],
  ) => Promise<{ rows: { inserted: boolean }[] }>,
  rows: readonly UnifiedTargetRow[],
): Promise<{ inserted: number; merged: number }> {
  if (rows.length === 0) return { inserted: 0, merged: 0 };
  // Entity-resolution benchmark fixtures live in dev databases; they must
  // never leak into the shareable golden set.
  const deduped = mergeBatchDuplicates(
    rows.filter((r) => !isSyntheticTargetName(r.companyName)),
  );
  const params: unknown[] = [];
  const tuples = deduped.map((r) => {
    const values: unknown[] = [
      r.companyName,
      normalizeUnifiedName(r.companyName),
      r.domain,
      r.websiteUrl,
      r.city,
      r.stateCode,
      r.countryCode,
      JSON.stringify([r.origin]),
      r.goldenV1Member,
      r.tier,
      r.pipelineStatus,
      r.fit,
      r.novelty,
      r.confidence,
      r.actionability,
      r.ensembleDecision,
      r.ensembleConfidence,
      r.whyInteresting,
      r.risks,
      r.unknowns,
      JSON.stringify(r.evidenceUrls),
      r.companyId,
      r.signalId,
      r.candidateId,
    ];
    const placeholders = values.map((v) => {
      params.push(v);
      return `$${params.length}`;
    });
    // origins / evidence_urls ride as JSON text cast to jsonb.
    placeholders[7] += "::jsonb";
    placeholders[20] += "::jsonb";
    return `(${placeholders.join(", ")})`;
  });
  const text =
    `INSERT INTO unified_targets (${UPSERT_COLUMNS.join(", ")}) VALUES ${tuples.join(", ")} ` +
    `${CONFLICT_CLAUSE} RETURNING (xmax = 0) AS inserted`;
  const result = await query(text, params);
  let inserted = 0;
  for (const row of result.rows) {
    if (row.inserted) inserted++;
  }
  return { inserted, merged: result.rows.length - inserted };
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

interface SourceCounts {
  inserted: number;
  merged: number;
}

async function loadGolden(
  query: (
    text: string,
    params: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>,
): Promise<UnifiedTargetRow[]> {
  const { rows } = await query(
    `SELECT g.name, g.domain, g.company_id,
            COALESCE(NULLIF(g.review_notes, ''), g.description_raw) AS why_interesting,
            c.website_url, c.headquarters_country_code
     FROM golden_examples g
     LEFT JOIN companies c ON c.id = g.company_id
     WHERE COALESCE(g.golden_example_type::text, '') <> 'known_non_target'`,
    [],
  );
  return rows.flatMap((r) => {
    const name = String(r["name"] ?? "").trim();
    if (name === "") return [];
    const websiteUrl =
      typeof r["website_url"] === "string" && r["website_url"] !== ""
        ? (r["website_url"] as string)
        : null;
    return [
      {
        companyName: name,
        domain:
          typeof r["domain"] === "string" && r["domain"] !== ""
            ? (r["domain"] as string).toLowerCase()
            : domainFromUrl(websiteUrl),
        websiteUrl,
        city: null,
        stateCode: null,
        countryCode:
          typeof r["headquarters_country_code"] === "string"
            ? (r["headquarters_country_code"] as string)
            : null,
        origin: ORIGIN_GOLDEN_V1,
        goldenV1Member: true,
        tier: "reference",
        pipelineStatus: null,
        fit: null,
        novelty: null,
        confidence: null,
        actionability: null,
        ensembleDecision: null,
        ensembleConfidence: null,
        whyInteresting:
          typeof r["why_interesting"] === "string" &&
          r["why_interesting"] !== ""
            ? (r["why_interesting"] as string)
            : null,
        risks: null,
        unknowns: null,
        evidenceUrls: [] as string[],
        companyId:
          typeof r["company_id"] === "string"
            ? (r["company_id"] as string)
            : null,
        signalId: null,
        candidateId: null,
      } satisfies UnifiedTargetRow,
    ];
  });
}

function loadCurated(csvPath: string): UnifiedTargetRow[] {
  const text = readFileSync(csvPath, "utf8");
  return parseSimpleCsv(text).flatMap((r) => {
    const name = (r["company"] ?? "").trim();
    if (name === "") return [];
    const tier = mapCuratedTier(r["screen_status"] ?? "");
    if (tier === null) return [];
    const websiteUrl = (r["website_url"] ?? "").trim() || null;
    const hq = parseHq(r["hq"] ?? "");
    const evidenceUrls = [
      r["government_evidence_url"],
      r["company_evidence_url"],
      r["ownership_or_risk_evidence_url"],
    ]
      .map((u) => (u ?? "").trim())
      .filter((u) => u !== "");
    return [
      {
        companyName: name,
        domain: domainFromUrl(websiteUrl),
        websiteUrl,
        city: hq.city,
        stateCode: hq.stateCode,
        countryCode: hq.countryCode,
        origin: ORIGIN_CURATED,
        goldenV1Member: false,
        tier,
        pipelineStatus: null,
        fit: null,
        novelty: null,
        confidence: null,
        actionability: null,
        ensembleDecision: null,
        ensembleConfidence: null,
        whyInteresting: (r["fit_summary"] ?? "").trim() || null,
        risks: (r["key_risk"] ?? "").trim() || null,
        unknowns: null,
        evidenceUrls,
        companyId: null,
        signalId: null,
        candidateId: null,
      } satisfies UnifiedTargetRow,
    ];
  });
}

async function loadDiscovery(
  query: (
    text: string,
    params: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>,
): Promise<UnifiedTargetRow[]> {
  const { rows } = await query(
    `SELECT c.id AS company_id, cand.id AS candidate_id,
            COALESCE(NULLIF(c.display_name, ''), c.legal_name) AS name,
            c.website_url, c.headquarters_country_code,
            cand.status::text AS status,
            cand.current_scores, cand.rationale
     FROM candidates cand
     JOIN companies c ON c.id = cand.company_id
     WHERE cand.status::text NOT IN ('rejected', 'archived')`,
    [],
  );
  return rows.flatMap((r) => {
    const name = String(r["name"] ?? "").trim();
    if (name === "" || isOffThesisName(name)) return [];
    const tier = mapCandidateTier(
      typeof r["status"] === "string" ? (r["status"] as string) : null,
    );
    if (tier === null) return [];
    const scores = (r["current_scores"] ?? {}) as Record<string, unknown>;
    const rationale = (r["rationale"] ?? {}) as Record<string, unknown>;
    const websiteUrl =
      typeof r["website_url"] === "string" && r["website_url"] !== ""
        ? (r["website_url"] as string)
        : null;
    return [
      {
        companyName: name,
        domain: domainFromUrl(websiteUrl),
        websiteUrl,
        city: null,
        stateCode: null,
        countryCode:
          typeof r["headquarters_country_code"] === "string"
            ? (r["headquarters_country_code"] as string)
            : null,
        origin: ORIGIN_DISCOVERY,
        goldenV1Member: false,
        tier,
        pipelineStatus:
          typeof r["status"] === "string" ? (r["status"] as string) : null,
        fit: scoreNumber(scores["fit"]),
        novelty: scoreNumber(scores["novelty"]),
        confidence: scoreNumber(scores["confidence"]),
        actionability: scoreNumber(scores["actionability"]),
        ensembleDecision: null,
        ensembleConfidence: null,
        whyInteresting: rationaleText(rationale["whyInteresting"]),
        risks: rationaleText(rationale["risks"]),
        unknowns: rationaleText(rationale["unknowns"]),
        evidenceUrls: [] as string[],
        companyId:
          typeof r["company_id"] === "string"
            ? (r["company_id"] as string)
            : null,
        signalId: null,
        candidateId:
          typeof r["candidate_id"] === "string"
            ? (r["candidate_id"] as string)
            : null,
      } satisfies UnifiedTargetRow,
    ];
  });
}

async function loadEnsemble(
  query: (
    text: string,
    params: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>,
): Promise<UnifiedTargetRow[]> {
  const { rows } = await query(
    `SELECT r.signal_id, r.final_decision, r.final_confidence, r.reason,
            s.raw_name, s.raw_domain, s.city, s.state, s.country, s.source_payload
     FROM faa_ensemble_results r
     JOIN source_signals s ON s.id = r.signal_id
     WHERE r.final_decision IN ('research', 'high_priority')`,
    [],
  );
  return rows.flatMap((r) => {
    const name = String(r["raw_name"] ?? "").trim();
    if (name === "") return [];
    const decision =
      typeof r["final_decision"] === "string"
        ? (r["final_decision"] as string)
        : "";
    const tier = mapEnsembleTier(decision);
    if (tier === null) return [];
    const payload = (r["source_payload"] ?? {}) as Record<string, unknown>;
    const guidUrl =
      typeof payload["guid_url"] === "string" && payload["guid_url"] !== ""
        ? (payload["guid_url"] as string)
        : typeof payload["guidUrl"] === "string" && payload["guidUrl"] !== ""
          ? (payload["guidUrl"] as string)
          : null;
    const makes = Array.isArray(payload["makes"])
      ? (payload["makes"] as unknown[])
          .filter((m): m is string => typeof m === "string" && m.trim() !== "")
          .slice(0, 12)
      : [];
    const address =
      typeof payload["address"] === "string" && payload["address"].trim() !== ""
        ? (payload["address"] as string).trim()
        : null;
    const bits = [
      makes.length > 0 ? `makes: ${makes.join(", ")}` : null,
      address,
    ].filter((b): b is string => b !== null);
    const reason =
      typeof r["reason"] === "string" && r["reason"].trim() !== ""
        ? (r["reason"] as string).trim()
        : null;
    const whyInteresting =
      bits.length > 0
        ? `FAA PMA holder (${bits.join("; ")})${reason ? ` — ${reason}` : ""}`
        : reason;
    const rawDomain =
      typeof r["raw_domain"] === "string" && r["raw_domain"] !== ""
        ? (r["raw_domain"] as string).toLowerCase()
        : null;
    const conf =
      typeof r["final_confidence"] === "number"
        ? (r["final_confidence"] as number)
        : Number(r["final_confidence"]);
    return [
      {
        companyName: name,
        domain: rawDomain,
        websiteUrl: null,
        city: typeof r["city"] === "string" ? (r["city"] as string) : null,
        stateCode:
          typeof r["state"] === "string" ? (r["state"] as string) : null,
        countryCode:
          typeof r["country"] === "string" ? (r["country"] as string) : null,
        origin: ORIGIN_FAA_ENSEMBLE,
        goldenV1Member: false,
        tier,
        pipelineStatus: null,
        fit: null,
        novelty: null,
        confidence: null,
        actionability: null,
        ensembleDecision: decision,
        ensembleConfidence: Number.isFinite(conf) ? conf : null,
        whyInteresting,
        risks: null,
        unknowns: null,
        evidenceUrls: guidUrl ? [guidUrl] : [],
        companyId: null,
        signalId:
          typeof r["signal_id"] === "string"
            ? (r["signal_id"] as string)
            : null,
        candidateId: null,
      } satisfies UnifiedTargetRow,
    ];
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parsePopulateArgs(argv: readonly string[]): {
  curatedPath: string;
} {
  let curatedPath = path.join(
    "exports",
    "curated-aerospace-targets-evidence.csv",
  );
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--curated" && i + 1 < argv.length) {
      curatedPath = argv[i + 1]!;
      i++;
    }
  }
  return { curatedPath };
}

async function main(argv: string[]): Promise<void> {
  const { curatedPath } = parsePopulateArgs(argv);
  const pool = getPool();
  const query = async (text: string, params: unknown[]) => {
    const result = await pool.query(text, params as unknown[]);
    return { rows: result.rows as Record<string, unknown>[] };
  };
  const batchQuery = async (text: string, params: unknown[]) => {
    const result = await pool.query(text, params as unknown[]);
    return { rows: result.rows as { inserted: boolean }[] };
  };

  const totals: SourceCounts = { inserted: 0, merged: 0 };
  const report = (label: string, counts: SourceCounts) => {
    totals.inserted += counts.inserted;
    totals.merged += counts.merged;
    console.log(
      `[unified-targets] ${label}: ${counts.inserted} inserted, ${counts.merged} merged`,
    );
  };

  report(
    ORIGIN_GOLDEN_V1,
    await upsertBatch(batchQuery, await loadGolden(query)),
  );
  report(
    ORIGIN_CURATED,
    await upsertBatch(batchQuery, loadCurated(curatedPath)),
  );
  report(
    ORIGIN_DISCOVERY,
    await upsertBatch(batchQuery, await loadDiscovery(query)),
  );
  report(
    ORIGIN_FAA_ENSEMBLE,
    await upsertBatch(batchQuery, await loadEnsemble(query)),
  );
  console.log(
    `[unified-targets] total: ${totals.inserted} inserted, ${totals.merged} merged`,
  );
  await pool.end();
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  await main(process.argv.slice(2));
}
