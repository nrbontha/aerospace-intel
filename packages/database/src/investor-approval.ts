import { sql, type SQL } from "drizzle-orm";

import type { Database } from "./client.js";
import { investorPicks, sourceSignals } from "./schema.js";

function normalizedLegalNameSql(value: SQL): SQL<string> {
  // PostgreSQL's NFKC form and whitespace folding match normalizeLegalName's
  // canonical comparison without persisting a second identity convention.
  return sql<string>`lower(btrim(regexp_replace(normalize(${value}, NFKC), '\\s+', ' ', 'g')))`;
}

function normalizedDomainSql(value: SQL): SQL<string | null> {
  // Match normalizeDomain's ordinary HTTP(S) host inputs. Ambiguous authority
  // forms (credentials, ports, IPv6, or malformed URLs) deliberately fail
  // closed instead of creating a false investor approval.
  const trimmed = sql<string>`btrim(${value})`;
  const acceptedInput = sql<string | null>`
    CASE
      WHEN ${trimmed} = '' THEN NULL
      WHEN ${trimmed} ~ '^[[:alpha:]][[:alnum:]+.-]*://'
        AND ${trimmed} !~* '^https?://' THEN NULL
      WHEN ${trimmed} !~* '^(https?://)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?\\.?([/?#].*)?$'
        THEN NULL
      ELSE ${trimmed}
    END
  `;
  const host = sql<string | null>`regexp_replace(
    regexp_replace(${acceptedInput}, '^https?://', '', 'i'),
    '[/?#].*$', ''
  )`;
  return sql<string | null>`nullif(
    lower(regexp_replace(rtrim(${host}, '.'), '^www\\.', '', 'i')),
    ''
  )`;
}

/**
 * SQL predicate shared by overview projection and Muse claim selection.
 * `signalId` must identify a source_signals row in the surrounding query.
 */
export function investorApprovedSql(signalId: SQL): SQL<boolean> {
  const candidateName = normalizedLegalNameSql(sql`candidate.raw_name`);
  const approvedName = normalizedLegalNameSql(sql`approved.raw_name`);
  const candidateDomain = normalizedDomainSql(sql`candidate.raw_domain`);
  const approvedDomain = normalizedDomainSql(sql`approved.raw_domain`);
  return sql<boolean>`EXISTS (
    SELECT 1
    FROM ${sourceSignals} candidate
    JOIN ${investorPicks} pick
      ON pick.active = TRUE
    JOIN ${sourceSignals} approved
      ON approved.id = pick.source_signal_id
    WHERE candidate.id = ${signalId}::uuid
      AND (
        pick.source_signal_id = candidate.id
        OR (
          candidate.company_id IS NOT NULL
          AND approved.company_id IS NOT NULL
          AND candidate.company_id = approved.company_id
        )
        OR (
          ${candidateName} = ${approvedName}
          AND ${candidateDomain} IS NOT NULL
          AND ${candidateDomain} = ${approvedDomain}
        )
      )
  )`;
}

/** Read one source signal's active investor-approval projection without mutation. */
export async function isSourceSignalInvestorApproved(
  db: Database,
  signalId: string,
): Promise<boolean> {
  const result = await db.execute<{ investor_approved: boolean }>(sql`
    SELECT ${investorApprovedSql(sql`${signalId}`)} AS investor_approved
  `);
  return result.rows[0]?.investor_approved === true;
}
