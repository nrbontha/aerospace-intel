import { sql } from "drizzle-orm";

import type { Database } from "../client.js";

/**
 * Company matching for known-universe members.
 *
 * Rules (applied BEFORE any member INSERT — the table is append-only):
 *  1. exact   — lower(normalized_domain) joins an existing
 *               companies/company_domains row → confidence 1.0
 *  2. probable — pg_trgm similarity between the raw name and the company's
 *               display/legal name reaches the threshold, with a same-US-state
 *               bonus when both sides have a known state (capped at 0.99)
 *  3. none    — nothing plausible found
 */
export const PROBABLE_BASE_THRESHOLD = 0.72;
export const SAME_STATE_BONUS = 0.08;
export const MATCH_CONFIDENCE_CAP = 0.99;

export type MatchStatus = "exact" | "probable" | "none";

export interface MemberMatch {
  matchStatus: MatchStatus;
  matchConfidence: number | null;
  /** Resolved canonical identity — set only on exact matches. */
  companyId: string | null;
  /** Best candidate — set for both exact and probable matches. */
  matchedCompanyId: string | null;
}

export interface MemberMatchInput {
  rawName: string;
  normalizedDomain: string | null;
  /** Two-letter US state parsed from workbook HQ text, when present. */
  stateCode: string | null;
}

type DomainHitRow = {
  id: string;
}

async function findExactDomainMatch(
  db: Database,
  domain: string,
): Promise<string | null> {
  const result = await db.execute<DomainHitRow>(sql`
    SELECT c.id
    FROM company_domains d
    JOIN companies c ON c.id = d.company_id
    WHERE lower(d.domain) = ${domain}
    ORDER BY d.is_primary DESC, c.created_at
    LIMIT 1
  `);
  return result.rows[0]?.id ?? null;
}

type NameCandidateRow = {
  id: string;
  similarity: number;
}

/**
 * Best trigram name candidate within the widened window (threshold minus the
 * state bonus), so a same-state pair can still clear the bar via the bonus.
 * Returns null when no candidate is close enough even with the bonus.
 */
async function findProbableNameMatch(
  db: Database,
  input: MemberMatchInput,
): Promise<{ companyId: string; confidence: number } | null> {
  const widenedThreshold =
    PROBABLE_BASE_THRESHOLD -
    (input.stateCode === null ? 0 : SAME_STATE_BONUS);
  const name = input.rawName.trim().toLowerCase();
  const result = await db.execute<NameCandidateRow>(sql`
    SELECT c.id,
           greatest(
             similarity(lower(c.display_name), ${name}),
             similarity(lower(c.legal_name), ${name})
           ) AS similarity
    FROM companies c
    WHERE greatest(
            similarity(lower(c.display_name), ${name}),
            similarity(lower(c.legal_name), ${name})
          ) >= ${widenedThreshold}
    ORDER BY similarity DESC, c.created_at
    LIMIT 1
  `);
  const row = result.rows[0];
  if (row === undefined) return null;

  let score = Number(row.similarity);
  if (
    input.stateCode !== null &&
    (await companyUsState(db, row.id)) === input.stateCode
  ) {
    score += SAME_STATE_BONUS;
  }
  if (score < PROBABLE_BASE_THRESHOLD) return null;
  return {
    companyId: row.id,
    confidence: Math.min(score, MATCH_CONFIDENCE_CAP),
  };
}

/** Primary US facility state for a company, when known. */
async function companyUsState(
  db: Database,
  companyId: string,
): Promise<string | null> {
  const result = await db.execute<{ region: string }>(sql`
    SELECT upper(f.region) AS region
    FROM facilities f
    WHERE f.company_id = ${companyId}
      AND f.region IS NOT NULL
      AND upper(f.country_code) = 'US'
    ORDER BY f.created_at
    LIMIT 1
  `);
  return result.rows[0]?.region ?? null;
}

/** Compute the full match triple for one member before it is inserted. */
export async function matchMember(
  db: Database,
  input: MemberMatchInput,
): Promise<MemberMatch> {
  if (input.normalizedDomain !== null) {
    const exactId = await findExactDomainMatch(db, input.normalizedDomain);
    if (exactId !== null) {
      return {
        matchStatus: "exact",
        matchConfidence: 1,
        companyId: exactId,
        matchedCompanyId: exactId,
      };
    }
  }

  const probable = await findProbableNameMatch(db, input);
  if (probable !== null) {
    return {
      matchStatus: "probable",
      matchConfidence: probable.confidence,
      // Probable matches stay candidates: only exact matches resolve identity.
      companyId: null,
      matchedCompanyId: probable.companyId,
    };
  }

  return {
    matchStatus: "none",
    matchConfidence: null,
    companyId: null,
    matchedCompanyId: null,
  };
}
