/**
 * Verified-domain resolution for discovery leads (REDESIGN_PLAN §2).
 *
 * A lead carries a raw recipient name (plus USAspending award context) but NO
 * domain. This service turns one lead into a VERIFIED company/domain pair or
 * records honestly why it could not:
 *
 *   1. Candidate domains come from the injected judge's `proposeDomains`
 *      (LLM, ≤3); deterministic token-joined fallbacks are used ONLY when the
 *      model path is unavailable — never on top of it.
 *   2. Each candidate homepage is fetched through the injected `prober`
 *      (SSRF-safe fetch + HTML→identity-text in production wiring).
 *   3. Identity is checked WITHOUT the model first (legal-token overlap
 *      ≥ MIN_IDENTITY_OVERLAP); only ambiguous pages pay for a model judgment.
 *   4. ANTI-FABRICATION: a domain is attached only after a fetched-page
 *      identity verification. Every probe is journaled into
 *      `lead.context.domainVerification.attempts[]` — guess-only attachments
 *      are impossible by construction.
 *
 * Fetch/model capabilities are injected because @asi/database must not depend
 * on @asi/research (import cycle); production implementations are constructed
 * in the apps/web route layer where @asi/research IS importable.
 */

import { eq } from "drizzle-orm";

import type { Database } from "../client.js";
import { upsertCandidate } from "../candidates/storage.js";
import { normalizeDomain } from "../provenance.js";
import { auditEvents, companies, companyDomains, leads } from "../schema.js";

// ---------------------------------------------------------------------------
// Injected capability interfaces.
// ---------------------------------------------------------------------------

export interface DomainProbeSuccess {
  readonly ok: true;
  /** Identity-relevant page text (title/meta/h1/h2 style extraction upstream). */
  readonly text: string;
  /** URL after redirects — the verified identity evidence lives here. */
  readonly finalUrl: string;
}

export interface DomainProbeFailure {
  readonly ok: false;
  /** Machine-readable failure reason (dns_failed, timeout, http_error, …). */
  readonly error: string;
}

export type DomainProbeResult = DomainProbeSuccess | DomainProbeFailure;

/** SSRF-safe page fetcher + HTML→text extractor. */
export interface DomainProber {
  fetchText(url: string): Promise<DomainProbeResult>;
}

export interface IdentityJudgment {
  readonly matches: boolean;
  /** 0..1 self-reported confidence; gated by MIN_JUDGE_CONFIDENCE. */
  readonly confidence: number;
  readonly reason: string;
}

/**
 * Model-side identity reasoning. Doubles as the domain proposer; both methods
 * may fail (throw) — the service degrades deterministically and journals it.
 */
export interface DomainJudge {
  /** Plausible candidate domains for a lead name; may return any garbage. */
  proposeDomains(leadName: string, locationHint?: string | null): Promise<string[]>;
  judgeIdentity(leadName: string, pageText: string): Promise<IdentityJudgment>;
}

export interface ResolutionLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface LeadDomainDeps {
  readonly prober: DomainProber;
  readonly judge: DomainJudge;
  readonly logger?: ResolutionLogger;
}

// ---------------------------------------------------------------------------
// Result / journal shapes.
// ---------------------------------------------------------------------------

export type ResolutionOutcome =
  | "domain_verified"
  | "already_resolved"
  | "no_domain_found"
  | "identity_mismatch";

/** One journaled probe against one candidate domain. */
export interface DomainAttempt {
  readonly domain: string;
  readonly source: "llm" | "fallback";
  readonly outcome: "verified" | "unreachable" | "identity_mismatch" | "low_confidence";
  /** How identity was decided — absent when the page never loaded. */
  readonly method?: "text-overlap" | "model-judge";
  readonly confidence?: number;
  readonly detail?: string;
}

export interface ResolutionResult {
  readonly outcome: ResolutionOutcome;
  readonly leadId: string;
  readonly domain?: string;
  readonly companyId?: string;
  readonly candidateId?: string;
  readonly confidence?: number;
  readonly attempts: readonly DomainAttempt[];
}

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

export class LeadNotFoundError extends Error {
  constructor(leadId: string) {
    super(`lead ${leadId} not found`);
    this.name = "LeadNotFoundError";
  }
}

export class LeadNotResolvableError extends Error {
  constructor(
    leadId: string,
    readonly status: string,
  ) {
    super(`lead ${leadId} cannot be resolved from status '${status}'`);
    this.name = "LeadNotResolvableError";
  }
}

// ---------------------------------------------------------------------------
// Thresholds + pure helpers (unit-tested directly).
// ---------------------------------------------------------------------------

/**
 * Deterministic identity pass: fraction of lead tokens present on the page.
 * A page must clear this STRICTLY (>) to be accepted without the model —
 * a bare-threshold half-match ("York Precision" for YORK PRECISION
 * MACHINING AND HYDRAULICS, a DIFFERENT "York Precision Inc.") is exactly
 * the ambiguous case that must fall through to the model judge.
 */
export const MIN_IDENTITY_OVERLAP = 0.5;
/** Model judgments must clear this to count as a match. */
export const MIN_JUDGE_CONFIDENCE = 0.6;

const LEGAL_SUFFIXES = new Set([
  "llc",
  "ltd",
  "ltda",
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "co",
  "company",
  "lp",
  "llp",
  "pllc",
  "pc",
  "pa",
  "plc",
  "gmbh",
  "sa",
  "ag",
  "bv",
]);

const STOP_TOKENS = new Set(["and", "or", "the", "of", "a", "an", "at", "de"]);

/** Lowercase alphanumeric tokens of a legal name, minus legal suffixes/stopwords. */
export function leadNameTokens(name: string): string[] {
  const normalized = name.normalize("NFKC").toLocaleLowerCase("en-US");
  return normalized
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 0)
    .filter((token) => !LEGAL_SUFFIXES.has(token) && !STOP_TOKENS.has(token));
}
/** "YORK PRECISION MACHINING AND HYDRAULICS, LLC" → "York Precision Machining And Hydraulics, LLC". */
export function titleCaseName(rawName: string): string {
  return rawName
    .split(/(\s+)/u)
    .map((word) => {
      if (/^\s+$/u.test(word) || word.length === 0) return word;
      const bare = word.replace(/[^A-Za-z]/gu, "").toLocaleLowerCase("en-US");
      // Legal suffixes keep their written form (LLC, Inc., Co.) instead of
      // being mangled into "Llc".
      if (LEGAL_SUFFIXES.has(bare)) return word;
      return (
        word.charAt(0).toLocaleUpperCase("en-US") + word.slice(1).toLocaleLowerCase("en-US")
      );
    })
    .join("");
}

export function identityOverlapRatio(leadName: string, pageText: string): number {
  const tokens = leadNameTokens(leadName);
  if (tokens.length === 0) return 0;
  const haystack = pageText.normalize("NFKC").toLocaleLowerCase("en-US");
  const matched = tokens.filter((token) => haystack.includes(token));
  return matched.length / tokens.length;
}

/** Strip scheme/www, lowercase; null when nothing hostname-like remains. */
export function normalizeCandidateDomain(value: string): string | null {
  const host = value.trim().replace(/^https?:\/\//iu, "").replace(/\/.*$/u, "");
  if (host.length === 0) return null;
  return normalizeDomain(host);
}

/**
 * Deterministic fallback candidates used ONLY when the LLM proposer is
 * unavailable: token-joined name under .com/.net ("acme tooling llc" →
 * acmetooling.com, acmetooling.net).
 */
export function fallbackDomainsFor(leadName: string): string[] {
  const joined = leadNameTokens(leadName).join("");
  if (joined.length === 0) return [];
  return [`${joined}.com`, `${joined}.net`];
}


function dedupeDomains(values: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const domain = normalizeCandidateDomain(value);
    if (domain !== null) seen.add(domain);
  }
  return [...seen];
}

interface LeadContextShape {
  domainVerification?: unknown;
  discarded?: unknown;
  [key: string]: unknown;
}

function contextWith(
  context: Record<string, unknown>,
  patch: Partial<Pick<LeadContextShape, "domainVerification" | "discarded">>,
): Record<string, unknown> {
  return { ...context, ...patch };
}

// ---------------------------------------------------------------------------
// resolveLeadDomain.
// ---------------------------------------------------------------------------

export interface ResolveLeadDomainOptions {
  /** Maximum distinct candidate domains to probe. Default 3, hard cap 5. */
  readonly maxCandidates?: number;
  /**
   * Re-run resolution even when the lead is already `resolved` (re-verify +
   * attach; company/candidate writes stay idempotent by domain/company_id).
   */
  readonly force?: boolean;
}

export async function resolveLeadDomain(
  db: Database,
  leadId: string,
  deps: LeadDomainDeps,
  options: ResolveLeadDomainOptions = {},
): Promise<ResolutionResult> {
  const maxCandidates = Math.min(Math.max(1, Math.trunc(options.maxCandidates ?? 3)), 5);

  const leadRows = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
  const lead = leadRows[0];
  if (lead === undefined) throw new LeadNotFoundError(leadId);

  if (lead.status === "resolved") {
    if (options.force !== true) {
      return {
        outcome: "already_resolved",
        leadId,
        ...(lead.resolvedCompanyId === null ? {} : { companyId: lead.resolvedCompanyId }),
        attempts: [],
      };
    }
  } else if (lead.status !== "unresolved_lead" && lead.status !== "resolving") {
    throw new LeadNotResolvableError(leadId, lead.status);
  }

  const log = (level: "debug" | "warn" | "info", message: string, meta?: Record<string, unknown>) =>
    deps.logger?.[level](message, meta);

  // --- Candidate list: LLM-proposed, deterministic fallbacks only when the
  // model path is unusable.
  let candidates: { readonly domain: string; readonly source: "llm" | "fallback" }[] = [];
  try {
    const proposed = await deps.judge.proposeDomains(lead.rawName, lead.possibleLocation);
    candidates = dedupeDomains(proposed)
      .slice(0, maxCandidates)
      .map((domain) => ({ domain, source: "llm" as const }));
    if (candidates.length === 0) log("warn", "proposeDomains returned no usable domains");
  } catch (error) {
    log("warn", "proposeDomains failed; using deterministic fallbacks", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (candidates.length === 0) {
    candidates = fallbackDomainsFor(lead.rawName)
      .slice(0, maxCandidates)
      .map((domain) => ({ domain, source: "fallback" as const }));
  }

  // --- Probe + identity-check each candidate.
  const attempts: DomainAttempt[] = [];
  let sawReachablePage = false;

  for (const candidate of candidates) {
    const url = `https://${candidate.domain}`;
    let probe: DomainProbeResult;
    try {
      probe = await deps.prober.fetchText(url);
    } catch (error) {
      probe = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (!probe.ok) {
      attempts.push({
        domain: candidate.domain,
        source: candidate.source,
        outcome: "unreachable",
        detail: probe.error,
      });
      log("debug", "candidate unreachable", { domain: candidate.domain, error: probe.error });
      continue;
    }
    sawReachablePage = true;

    const overlap = identityOverlapRatio(lead.rawName, probe.text);
    let matches = overlap > MIN_IDENTITY_OVERLAP;
    let confidence = overlap;
    let method: DomainAttempt["method"] = "text-overlap";
    let reason = `deterministic token overlap ${(overlap * 100).toFixed(0)}%`;

    if (!matches) {
      method = "model-judge";
      try {
        const judgment = await deps.judge.judgeIdentity(lead.rawName, probe.text);
        matches = judgment.matches && judgment.confidence >= MIN_JUDGE_CONFIDENCE;
        confidence = judgment.confidence;
        reason = judgment.reason;
      } catch (error) {
        matches = false;
        confidence = 0;
        reason = `identity judge unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }

    if (matches) {
      attempts.push({
        domain: candidate.domain,
        source: candidate.source,
        outcome: "verified",
        method,
        confidence,
        detail: reason,
      });
      const committed = await commitVerifiedDomain(db, {
        lead,
        domain: candidate.domain,
        url: probe.finalUrl,
        confidence,
        method,
        attempts,
      });
      return {
        outcome: "domain_verified",
        leadId,
        domain: candidate.domain,
        companyId: committed.companyId,
        candidateId: committed.candidateId,
        confidence,
        attempts,
      };
    }

    attempts.push({
      domain: candidate.domain,
      source: candidate.source,
      outcome: judgmentOutcome(matches, confidence),
      method,
      confidence,
      detail: reason,
    });
    log("debug", "candidate rejected", { domain: candidate.domain, matches, confidence });
  }

  // --- Exhausted: journal attempts, leave the lead unresolved.
  await db
    .update(leads)
    .set({
      status: "unresolved_lead",
      context: contextWith(lead.context, {
        domainVerification: {
          checkedAt: new Date().toISOString(),
          attempts,
        },
      }),
    })
    .where(eq(leads.id, leadId));

  return {
    outcome: sawReachablePage ? "identity_mismatch" : "no_domain_found",
    leadId,
    attempts,
  };
}

function judgmentOutcome(matches: boolean, confidence: number): DomainAttempt["outcome"] {
  return matches && confidence < MIN_JUDGE_CONFIDENCE ? "low_confidence" : "identity_mismatch";
}

// ---------------------------------------------------------------------------
// Verified-commit path (transactional).
// ---------------------------------------------------------------------------

interface CommitInput {
  readonly lead: typeof leads.$inferSelect;
  readonly domain: string;
  readonly url: string;
  readonly confidence: number;
  readonly method: NonNullable<DomainAttempt["method"]>;
  readonly attempts: readonly DomainAttempt[];
}

async function commitVerifiedDomain(
  db: Database,
  input: CommitInput,
): Promise<{ companyId: string; candidateId: string }> {
  return db.transaction(async (tx) => {
    // create-or-get: an existing primary owner of this domain wins — the lead
    // merges onto the known company instead of minting a duplicate.
    const existingOwner = await tx
      .select({ companyId: companyDomains.companyId })
      .from(companyDomains)
      .where(eq(companyDomains.domain, input.domain))
      .limit(1);
    const existing = existingOwner[0];

    let companyId: string;
    if (existing !== undefined) {
      companyId = existing.companyId;
      // Refresh verification timestamp on the canonical domain row.
      await tx
        .update(companyDomains)
        .set({ verifiedAt: new Date() })
        .where(eq(companyDomains.domain, input.domain));
    } else {
      const inserted = await tx
        .insert(companies)
        .values({
          legalName: input.lead.rawName,
          displayName: titleCaseName(input.lead.rawName),
          websiteUrl: `https://${input.domain}`,
        })
        .returning({ id: companies.id });
      const company = inserted[0];
      if (company === undefined) {
        throw new Error(`company insert returned no row for lead ${input.lead.id}`);
      }
      companyId = company.id;
      await tx
        .insert(companyDomains)
        .values({
          companyId,
          domain: input.domain,
          isPrimary: true,
          verifiedAt: new Date(),
        })
        .onConflictDoNothing();
    }

    // Investment-free candidate shell (golden-seeder minimal path): routing
    // applied on first insert only, no computed scores yet.
    const seeded = await upsertCandidate(tx, {
      companyId,
      routedStatus: "queued_research",
      noveltyStatus: "unable_to_assess",
      noveltySnapshotIds: [],
      rationale: {
        whyInteresting: [awardSummaryFor(input.lead)],
        risks: [],
        unknowns: ["domain-verified, pending research"],
      },
      currentScores: {},
      researchPriority: null,
      partnerReviewPriority: null,
    });

    const context = contextWith(input.lead.context, {
      domainVerification: {
        verifiedAt: new Date().toISOString(),
        method: "homepage-identity",
        url: input.url,
        confidence: input.confidence,
        attempts: input.attempts,
      },
    });

    await tx
      .update(leads)
      .set({
        status: "resolved",
        possibleDomain: input.domain,
        resolvedCompanyId: companyId,
        context,
      })
      .where(eq(leads.id, input.lead.id));

    await tx.insert(auditEvents).values({
      // System action — no human actor.
      actorUserId: null,
      action: "lead.domain_resolved",
      entityType: "lead",
      entityId: input.lead.id,
      metadata: {
        domain: input.domain,
        url: input.url,
        confidence: input.confidence,
        identityMethod: input.method,
        companyId,
        companyCreated: existing === undefined,
        candidateId: seeded.id,
        attempts: input.attempts,
      },
    });

    return { companyId, candidateId: seeded.id };
  });
}

function awardSummaryFor(lead: typeof leads.$inferSelect): string {
  const sourceLocator =
    typeof lead.context["sourceLocator"] === "string" ? lead.context["sourceLocator"] : null;
  if (sourceLocator !== null) return `Discovered via federal awards: ${sourceLocator}`;
  const awardCount = typeof lead.context["awardCount"] === "number" ? lead.context["awardCount"] : null;
  if (awardCount !== null) return `Discovered via federal awards (${awardCount} awards)`;
  return `Discovered as an unresolved federal-award lead: ${lead.rawName}`;
}

// ---------------------------------------------------------------------------
// discardLead.
// ---------------------------------------------------------------------------

export interface DiscardOutcome {
  readonly leadId: string;
  readonly alreadyDiscarded: boolean;
}

/**
 * Analyst rejection of a lead: terminal `discarded` status, reason recorded
 * in context, audited. Idempotent — discarding a discarded lead is a no-op.
 */
export async function discardLead(
  db: Database,
  leadId: string,
  actorId: string,
  reason: string,
): Promise<DiscardOutcome> {
  const leadRows = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
  const lead = leadRows[0];
  if (lead === undefined) throw new LeadNotFoundError(leadId);

  if (lead.status === "discarded") {
    return { leadId, alreadyDiscarded: true };
  }

  await db
    .update(leads)
    .set({
      status: "discarded",
      context: contextWith(lead.context, {
        discarded: {
          reason,
          at: new Date().toISOString(),
          actorId,
        },
      }),
    })
    .where(eq(leads.id, leadId));

  await db.insert(auditEvents).values({
    actorUserId: actorId,
    action: "lead.discarded",
    entityType: "lead",
    entityId: leadId,
    before: { status: lead.status },
    after: { status: "discarded" },
    metadata: { reason },
  });

  return { leadId, alreadyDiscarded: false };
}
