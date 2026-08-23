import { createHash } from "node:crypto";

import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { getDatabase, type Database } from "../client.js";
import { normalizeDomain } from "../provenance.js";
import { matchMember } from "../snapshots/matching.js";
import {
  auditEvents,
  companies,
  companyDomains,
  companyIdentifiers,
  frontierItems,
  identityMatchCandidates,
  leads,
} from "../schema.js";
import { upsertCandidate } from "../candidates/storage.js";

/**
 * Lead ingestion + identity resolution.
 *
 * Turns raw discovery lead candidates (USAspending recipients today) into
 * `leads` rows and immediately resolves each against the known universe:
 *
 *  1. exact  — normalized-domain join OR uei/cage identifier hit →
 *              status `resolved`, identity_match_candidates row with
 *              decision `merged` (system-decided, confidence 1.0).
 *  2. probable — pg_trgm name similarity ≥ 0.72 → status `resolving`,
 *              pending match row for human review. NEVER auto-merged,
 *              NEVER auto-company-created.
 *  3. none   — leads with a real domain AND no probable conflict get a
 *              canonical company created (provenance recorded on the lead
 *              context + audit log) and are resolved to it; everything
 *              else stays `unresolved_lead` pending explicit creation.
 *
 * Ingestion is idempotent per (campaignId, rawName, domain) via a
 * deterministic dedupe key stored on the lead context.
 */

/** Structural subset of the research package's `LeadCandidate`. */
export interface LeadCandidateInput {
  readonly rawName: string;
  readonly domain?: string | undefined;
  readonly uei?: string | undefined;
  readonly cageCode?: string | undefined;
  readonly city?: string | undefined;
  readonly state?: string | undefined;
  readonly naics?: readonly string[] | undefined;
  readonly awardCount: number;
  readonly totalAwardValueUsd: number;
  readonly freshestAwardDate?: string | undefined;
  readonly sourceLocator: string;
}

export interface LeadIngestSummary {
  created: number;
  /** Exact identity hits AND deterministic new-company creations. */
  resolvedExact: number;
  probableReview: number;
  unresolved: number;
  duplicateSkipped: number;
}

export interface IdentityMatchDecisionInput {
  decision: "merged" | "rejected_merge" | "alias" | "parent_subsidiary" | "acquired_into";
  decidedBy: string | null;
  note?: string;
}

type TxLike = Parameters<Parameters<Database["transaction"]>[0]>[0];
type DbOrTx = Database | TxLike;

const leadCandidateInputSchema = z.object({
  rawName: z.string().trim().min(1),
  domain: z.string().trim().min(1).optional(),
  uei: z.string().trim().min(1).optional(),
  cageCode: z.string().trim().min(1).optional(),
  city: z.string().trim().min(1).optional(),
  state: z.string().trim().min(1).optional(),
  naics: z.array(z.string().trim().min(1)).optional(),
  awardCount: z.number().nonnegative(),
  totalAwardValueUsd: z.number(),
  freshestAwardDate: z.string().trim().min(1).optional(),
  sourceLocator: z.string().trim().min(1),
});

const frontierLeadPayloadSchema = leadCandidateInputSchema.extend({
  source: z.string().trim().min(1).optional(),
});

function dedupeKeyFor(campaignId: string, rawName: string, domain: string | null): string {
  return createHash("sha256")
    .update(`${campaignId}|${rawName.trim().toLowerCase()}|${domain ?? ""}`)
    .digest("hex");
}

interface ExactHit {
  companyId: string;
  signalType: "domain" | "uei" | "cage";
  matchedValue: string;
}

type IdentityResolution =
  | { kind: "exact"; hit: ExactHit }
  | { kind: "probable"; companyId: string; confidence: number }
  | { kind: "none" };

async function findIdentifierMatch(
  db: DbOrTx,
  type: "uei" | "cage",
  value: string,
): Promise<string | null> {
  const result = await db.execute<{ id: string }>(sql`
    SELECT c.id
    FROM company_identifiers i
    JOIN companies c ON c.id = i.company_id
    WHERE i.type = ${type}
      AND upper(i.value) = ${value.trim().toUpperCase()}
    ORDER BY c.created_at
    LIMIT 1
  `);
  return result.rows[0]?.id ?? null;
}

/** Owner of an exact lowercase domain row, when any. */
async function findDomainOwner(db: DbOrTx, domain: string): Promise<string | null> {
  const result = await db.execute<{ id: string }>(sql`
    SELECT c.id
    FROM company_domains d
    JOIN companies c ON c.id = d.company_id
    WHERE lower(d.domain) = ${domain}
    ORDER BY d.is_primary DESC, c.created_at
    LIMIT 1
  `);
  return result.rows[0]?.id ?? null;
}

/**
 * Resolve one candidate against the known universe BEFORE any lead row is
 * written: exact identifiers first, then exact domain join, then the shared
 * pg_trgm probable-name rule (same threshold/bonus as snapshot matching).
 */
async function resolveIdentity(input: {
  rawName: string;
  domain: string | null;
  stateCode: string | null;
  uei: string | undefined;
  cageCode: string | undefined;
}): Promise<IdentityResolution> {
  if (input.uei !== undefined) {
    const companyId = await findIdentifierMatch(getDatabase(), "uei", input.uei);
    if (companyId !== null) {
      return {
        kind: "exact",
        hit: { companyId, signalType: "uei", matchedValue: input.uei },
      };
    }
  }
  if (input.cageCode !== undefined) {
    const companyId = await findIdentifierMatch(getDatabase(), "cage", input.cageCode);
    if (companyId !== null) {
      return {
        kind: "exact",
        hit: { companyId, signalType: "cage", matchedValue: input.cageCode },
      };
    }
  }

  const memberMatch = await matchMember(getDatabase(), {
    rawName: input.rawName,
    normalizedDomain: input.domain,
    stateCode: input.stateCode,
  });
  if (memberMatch.matchStatus === "exact") {
    return {
      kind: "exact",
      hit: {
        companyId: memberMatch.companyId!,
        signalType: "domain",
        matchedValue: input.domain ?? "",
      },
    };
  }
  if (
    memberMatch.matchStatus === "probable" &&
    memberMatch.matchedCompanyId !== null &&
    memberMatch.matchConfidence !== null
  ) {
    return {
      kind: "probable",
      companyId: memberMatch.matchedCompanyId,
      confidence: memberMatch.matchConfidence,
    };
  }
  return { kind: "none" };
}

/**
 * Create the canonical catalog company implied by an unmatched lead with a
 * real domain, attach its domain + identifiers, record provenance in the
 * audit log, and queue it as a scored-candidate pipeline entry.
 */
async function createCompanyFromLead(
  tx: TxLike,
  leadId: string,
  input: {
    rawName: string;
    domain: string;
    stateCode: string | null;
    uei: string | undefined;
    cageCode: string | undefined;
    sourceLocator: string;
  },
): Promise<string> {
  const [company] = await tx
    .insert(companies)
    .values({
      legalName: input.rawName,
      displayName: input.rawName,
      websiteUrl: `https://${input.domain}`,
      ...(input.stateCode === null ? {} : { headquartersCountryCode: "US" }),
    })
    .returning({ id: companies.id });
  if (company === undefined) {
    throw new Error(`company insert returned no row for lead ${leadId}`);
  }
  await tx.insert(companyDomains).values({
    companyId: company.id,
    domain: input.domain,
    isPrimary: true,
  });
  const identifierValues = [
    ...(input.uei === undefined
      ? []
      : [{ type: "uei" as const, value: input.uei.toUpperCase(), issuingCountryCode: "US" }]),
    ...(input.cageCode === undefined
      ? []
      : [{ type: "cage" as const, value: input.cageCode.toUpperCase(), issuingCountryCode: "US" }]),
  ];
  if (identifierValues.length > 0) {
    await tx.insert(companyIdentifiers).values(
      identifierValues.map((identifier) => ({
        companyId: company.id,
        ...identifier,
      })),
    );
  }
  await tx.insert(auditEvents).values({
    action: "lead.company_auto_created",
    entityType: "company",
    entityId: company.id,
    metadata: {
      leadId,
      sourceLocator: input.sourceLocator,
      reason: "new_lead_with_real_domain_and_no_known_universe_conflict",
    },
  });
  // Auto-promote the brand-new company into the scored-candidate pipeline.
  // Full axial scoring runs later through the promotion/rescore path.
  await upsertCandidate(tx, {
    companyId: company.id,
    routedStatus: "queued_research",
    noveltyStatus: "unable_to_assess",
    noveltySnapshotIds: [],
    rationale: {
      whyInteresting: [`Discovered via federal awards: ${input.sourceLocator}`],
      risks: ["Auto-created from a single-source lead; identity not yet enriched."],
      unknowns: ["Revenue", "employees", "ownership", "qualifications"],
    },
    currentScores: {},
    researchPriority: null,
    partnerReviewPriority: null,
  });
  return company.id;
}


/** Ingest one batch of lead candidates for a campaign (idempotent). */
export async function ingestLeadCandidates(
  campaignId: string,
  candidates: readonly LeadCandidateInput[],
): Promise<LeadIngestSummary> {
  const db = getDatabase();
  const summary: LeadIngestSummary = {
    created: 0,
    resolvedExact: 0,
    probableReview: 0,
    unresolved: 0,
    duplicateSkipped: 0,
  };

  for (const candidate of candidates) {
    const parsed = leadCandidateInputSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const value = parsed.data;
    const domain =
      value.domain === undefined ? null : normalizeDomain(value.domain);
    const stateCode =
      value.state !== undefined && /^[A-Za-z]{2}$/.test(value.state)
        ? value.state.toUpperCase()
        : null;

    // Idempotency: skip anything already ingested for this campaign under
    // the same deterministic identity.
    const dedupeKey = dedupeKeyFor(campaignId, value.rawName, domain);
    const existing = await db.execute<{ id: string }>(sql`
      SELECT id FROM leads
      WHERE campaign_id = ${campaignId}
        AND context->>'dedupeKey' = ${dedupeKey}
      LIMIT 1
    `);
    if (existing.rows.length > 0) {
      summary.duplicateSkipped += 1;
      continue;
    }

    const identity = await resolveIdentity({
      rawName: value.rawName,
      domain,
      stateCode,
      uei: value.uei,
      cageCode: value.cageCode,
    });

    await applyIngestOutcome(
      db,
      campaignId,
      value,
      domain,
      stateCode,
      dedupeKey,
      identity,
    );
    switch (identity.kind) {
      case "exact":
        summary.resolvedExact += 1;
        break;
      case "probable":
        summary.probableReview += 1;
        break;
      case "none": {
        const becameCompany = domain !== null;
        if (becameCompany) summary.resolvedExact += 1;
        else summary.unresolved += 1;
        break;
      }
    }
    summary.created += 1;
  }
  return summary;
}

/** Persist one lead row plus its resolution artifacts atomically. */
async function applyIngestOutcome(
  db: Database,
  campaignId: string,
  value: z.output<typeof leadCandidateInputSchema>,
  domain: string | null,
  stateCode: string | null,
  dedupeKey: string,
  identity: IdentityResolution,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [lead] = await tx
      .insert(leads)
      .values({
        campaignId,
        rawName: value.rawName,
        context: {
          awardCount: value.awardCount,
          totalAwardValueUsd: value.totalAwardValueUsd,
          ...(value.freshestAwardDate === undefined
            ? {}
            : { freshestAwardDate: value.freshestAwardDate }),
          ...(value.naics === undefined ? {} : { naics: value.naics }),
          sourceLocator: value.sourceLocator,
          dedupeKey,
        },
        url: domain === null ? null : `https://${domain}`,
        possibleDomain: domain,
        possibleLocation:
          [value.city, value.state].filter((p) => p !== undefined).join(", ") || null,
        possibleIdentifiers: [
          ...(value.uei === undefined ? [] : [{ type: "uei", value: value.uei }]),
          ...(value.cageCode === undefined
            ? []
            : [{ type: "cage", value: value.cageCode }]),
        ],
        status: "new",
      })
      .returning({ id: leads.id });
    if (lead === undefined) {
      throw new Error(`lead insert returned no row for ${value.rawName}`);
    }

    if (identity.kind === "exact") {
      await tx.insert(identityMatchCandidates).values({
        leadId: lead.id,
        companyId: identity.hit.companyId,
        signalType: identity.hit.signalType,
        features: { matchedValue: identity.hit.matchedValue },
        confidence: "1.000",
        explanation: `Automatic exact ${identity.hit.signalType} match during lead ingestion.`,
        decision: "merged",
        decidedAt: new Date(),
      });
      await tx
        .update(leads)
        .set({ status: "resolved", resolvedCompanyId: identity.hit.companyId })
        .where(eq(leads.id, lead.id));
      return;
    }

    if (identity.kind === "probable") {
      await tx.insert(identityMatchCandidates).values({
        leadId: lead.id,
        companyId: identity.companyId,
        signalType: "name_trgm",
        features: {
          rule: "pg_trgm similarity >= 0.72 with US-state bonus",
          similarity: identity.confidence,
        },
        confidence: identity.confidence.toFixed(3),
        explanation:
          "Probable name match pending analyst review; NOT auto-merged.",
        decision: "pending",
      });
      await tx.update(leads).set({ status: "resolving" }).where(eq(leads.id, lead.id));
      return;
    }

    if (domain !== null) {
      try {
        const companyId = await createCompanyFromLead(tx, lead.id, {
          rawName: value.rawName,
          domain,
          stateCode,
          uei: value.uei,
          cageCode: value.cageCode,
          sourceLocator: value.sourceLocator,
        });
        await tx
          .update(leads)
          .set({
            status: "resolved",
            resolvedCompanyId: companyId,
            context: sql`${leads.context} || ${JSON.stringify({
              provenance: {
                canonicalCompanyCreated: true,
                companyId,
                createdFromSourceLocator: value.sourceLocator,
              },
            })}::jsonb`,
          })
          .where(eq(leads.id, lead.id));
        return;
      } catch (error) {
        if ((error as { code?: string }).code !== "23505") throw error;
        // Concurrent creation won the unique-domain race: exact hit instead.
        const winner = await findDomainOwner(tx, domain);
        if (winner === null) throw error;
        await tx
          .update(leads)
          .set({ status: "resolved", resolvedCompanyId: winner })
          .where(eq(leads.id, lead.id));
        return;
      }
    }
    // Otherwise the lead keeps its default terminal ingestion state.
    await tx.update(leads).set({ status: "unresolved_lead" }).where(eq(leads.id, lead.id));
  });
}


/**
 * Re-run ingestion from every `company`-type frontier item proposed for a
 * campaign so far. Deterministic payloads + dedupe keys make this safe to
 * call repeatedly (worker follow-up job, analyst re-run endpoint).
 */
export async function ingestCampaignLeadsFromFrontier(
  campaignId: string,
): Promise<LeadIngestSummary> {
  const db = getDatabase();
  const rows = await db
    .select({ payload: frontierItems.payload })
    .from(frontierItems)
    .where(
      and(eq(frontierItems.campaignId, campaignId), eq(frontierItems.itemType, "company")),
    )
    .orderBy(desc(frontierItems.createdAt));

  const candidates: LeadCandidateInput[] = [];
  for (const row of rows) {
    const parsed = frontierLeadPayloadSchema.safeParse(row.payload);
    if (!parsed.success) continue;
    candidates.push(parsed.data);
  }
  return ingestLeadCandidates(campaignId, candidates);
}

/**
 * Apply an analyst decision to a pending identity-match candidate.
 * `merged` resolves the lead onto the matched company; `rejected_merge`
 * moves the still-unresolved lead back to `unresolved_lead`; informational
 * decisions (`alias`, `parent_subsidiary`, `acquired_into`) only close the
 * match row.
 */
export async function applyIdentityMatchDecision(
  matchId: string,
  input: IdentityMatchDecisionInput,
): Promise<{
  matchId: string;
  leadId: string;
  companyId: string;
  decision: string;
  leadStatus: string;
}> {
  const db = getDatabase();
  return db.transaction(async (tx) => {
    const [match] = await tx
      .select()
      .from(identityMatchCandidates)
      .where(eq(identityMatchCandidates.id, matchId))
      .limit(1);
    if (match === undefined) {
      throw new IdentityMatchNotFoundError(matchId);
    }
    if (match.decision !== "pending") {
      throw new IdentityMatchAlreadyDecidedError(matchId, match.decision);
    }

    const now = new Date();
    await tx
      .update(identityMatchCandidates)
      .set({
        decision: input.decision,
        decidedBy: input.decidedBy,
        decidedAt: now,
        ...(input.note === undefined
          ? {}
          : {
              explanation:
                `${match.explanation ?? ""} Analyst note: ${input.note}`.trim(),
            }),
      })
      .where(eq(identityMatchCandidates.id, matchId));

    let leadStatus = "resolving";
    if (input.decision === "merged") {
      await tx
        .update(leads)
        .set({ status: "resolved", resolvedCompanyId: match.companyId, updatedAt: now })
        .where(eq(leads.id, match.leadId));
      leadStatus = "resolved";
    } else if (input.decision === "rejected_merge") {
      await tx
        .update(leads)
        .set({ status: "unresolved_lead", updatedAt: now })
        .where(and(eq(leads.id, match.leadId), eq(leads.status, "resolving")));
      leadStatus = "unresolved_lead";
    }
    return {
      matchId,
      leadId: match.leadId,
      companyId: match.companyId,
      decision: input.decision,
      leadStatus,
    };
  });
}

export class IdentityMatchNotFoundError extends Error {
  override readonly name = "IdentityMatchNotFoundError";
  constructor(matchId: string) {
    super(`identity match candidate ${matchId} not found`);
  }
}

export class IdentityMatchAlreadyDecidedError extends Error {
  override readonly name = "IdentityMatchAlreadyDecidedError";
  constructor(matchId: string, currentDecision: string) {
    super(
      `identity match candidate ${matchId} already decided (${currentDecision})`,
    );
  }
}
