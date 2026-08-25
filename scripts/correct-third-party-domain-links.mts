import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  auditEvents,
  candidates,
  closeDatabase,
  companies,
  companyDomains,
  getDatabase,
  identityMatchCandidates,
  leads,
  type Database,
} from "@asi/database";
import { eq, inArray, or } from "drizzle-orm";

export const THIRD_PARTY_DOMAINS_TO_CORRECT = [
  "highergov.com",
  "inknowvation.com",
] as const;
export const THIRD_PARTY_DOMAIN_CORRECTION_VERSION = "2026-08-24";

export interface ThirdPartyDomainCorrectionReport {
  readonly leads: ReadonlyArray<{
    readonly id: string;
    readonly rawName: string;
    readonly status: string;
    readonly possibleDomain: string | null;
    readonly resolvedCompanyId: string | null;
    readonly context: Record<string, unknown>;
    readonly blockedDomains: readonly string[];
  }>;
  readonly companies: ReadonlyArray<{
    readonly id: string;
    readonly legalName: string;
    readonly websiteUrl: string | null;
    readonly blockedDomains: readonly string[];
  }>;
  readonly candidates: ReadonlyArray<{
    readonly id: string;
    readonly companyId: string;
    readonly status: string;
    readonly rationale: {
      whyInteresting: string[];
      risks: string[];
      unknowns: string[];
    };
    readonly blockedDomains: readonly string[];
  }>;
  readonly domainRelations: ReadonlyArray<{
    readonly id: string;
    readonly companyId: string;
    readonly domain: string;
    readonly blockedDomain: string;
  }>;
  readonly countsByDomain: Readonly<Record<string, number>>;
}

function hostnameFromDomainOrUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname.toLocaleLowerCase("en-US").replace(/^www\./u, "").replace(/\.$/u, "");
  } catch {
    return null;
  }
}

export function blockedThirdPartyDomain(value: string | null): string | null {
  if (value === null) return null;
  const hostname = hostnameFromDomainOrUrl(value);
  if (hostname === null) return null;
  for (const blocked of THIRD_PARTY_DOMAINS_TO_CORRECT) {
    if (hostname === blocked || hostname.endsWith(`.${blocked}`)) return blocked;
  }
  return null;
}

function addDomain(map: Map<string, Set<string>>, id: string, domain: string): void {
  const domains = map.get(id) ?? new Set<string>();
  domains.add(domain);
  map.set(id, domains);
}

/**
 * Selects the complete attachment closure: direct blocked domain relations and
 * website URLs, leads carrying a blocked possible_domain or resolved to an
 * affected company, and every candidate owned by an affected company.
 */
export async function selectThirdPartyDomainCorrections(
  db: Database,
  scope: {
    /** Test-only safety narrowing; the production CLI supplies no scope. */
    readonly leadIds?: readonly string[];
    /** Test-only safety narrowing; the production CLI supplies no scope. */
    readonly companyIds?: readonly string[];
  } = {},
): Promise<ThirdPartyDomainCorrectionReport> {
  const [allDomainRelations, companyRows, leadRows] = await Promise.all([
    db
      .select({
        id: companyDomains.id,
        companyId: companyDomains.companyId,
        domain: companyDomains.domain,
      })
      .from(companyDomains),
    db
      .select({
        id: companies.id,
        legalName: companies.legalName,
        websiteUrl: companies.websiteUrl,
      })
      .from(companies),
    db
      .select({
        id: leads.id,
        rawName: leads.rawName,
        status: leads.status,
        possibleDomain: leads.possibleDomain,
        resolvedCompanyId: leads.resolvedCompanyId,
        context: leads.context,
      })
      .from(leads),
  ]);

  const scopedCompanyIds = scope.companyIds === undefined ? null : new Set(scope.companyIds);
  const scopedLeadIds = scope.leadIds === undefined ? null : new Set(scope.leadIds);
  const effectiveScopedCompanyIds =
    scopedCompanyIds === null && scopedLeadIds === null
      ? null
      : new Set([
          ...(scopedCompanyIds ?? []),
          ...leadRows.flatMap((lead) =>
            scopedLeadIds?.has(lead.id) && lead.resolvedCompanyId !== null
              ? [lead.resolvedCompanyId]
              : [],
          ),
        ]);
  const directCompanyDomains = new Map<string, Set<string>>();
  const domainRelations = allDomainRelations.flatMap((relation) => {
    const blockedDomain = blockedThirdPartyDomain(relation.domain);
    if (
      blockedDomain === null ||
      (effectiveScopedCompanyIds !== null && !effectiveScopedCompanyIds.has(relation.companyId))
    ) {
      return [];
    }
    addDomain(directCompanyDomains, relation.companyId, blockedDomain);
    return [{ ...relation, blockedDomain }];
  });
  for (const company of companyRows) {
    const blockedDomain = blockedThirdPartyDomain(company.websiteUrl);
    if (
      blockedDomain !== null &&
      (effectiveScopedCompanyIds === null || effectiveScopedCompanyIds.has(company.id))
    ) {
      addDomain(directCompanyDomains, company.id, blockedDomain);
    }
  }

  const selectedLeadIds = new Set<string>();
  const affectedCompanyIds = new Set(directCompanyDomains.keys());
  const leadDomains = new Map<string, Set<string>>();
  for (const lead of leadRows) {
    const blockedDomain = blockedThirdPartyDomain(lead.possibleDomain);
    const explicitlyScoped = scopedLeadIds?.has(lead.id) ?? false;
    if (blockedDomain !== null && (scopedLeadIds === null || explicitlyScoped)) {
      selectedLeadIds.add(lead.id);
      addDomain(leadDomains, lead.id, blockedDomain);
      if (lead.resolvedCompanyId !== null) affectedCompanyIds.add(lead.resolvedCompanyId);
    }
  }
  for (const lead of leadRows) {
    if (
      lead.resolvedCompanyId !== null &&
      affectedCompanyIds.has(lead.resolvedCompanyId) &&
      (scopedLeadIds === null || scopedLeadIds.has(lead.id) || scopedCompanyIds?.has(lead.resolvedCompanyId))
    ) {
      selectedLeadIds.add(lead.id);
      for (const domain of directCompanyDomains.get(lead.resolvedCompanyId) ?? []) {
        addDomain(leadDomains, lead.id, domain);
      }
    }
  }

  const companyDomainsById = new Map<string, Set<string>>();
  for (const [companyId, domains] of directCompanyDomains) {
    for (const domain of domains) addDomain(companyDomainsById, companyId, domain);
  }
  for (const lead of leadRows) {
    if (!selectedLeadIds.has(lead.id) || lead.resolvedCompanyId === null) continue;
    for (const domain of leadDomains.get(lead.id) ?? []) {
      addDomain(companyDomainsById, lead.resolvedCompanyId, domain);
    }
  }

  const selectedCompanies = companyRows
    .filter((company) => affectedCompanyIds.has(company.id))
    .map((company) => ({
      ...company,
      blockedDomains: [...(companyDomainsById.get(company.id) ?? [])].sort(),
    }));
  const selectedLeads = leadRows
    .filter((lead) => selectedLeadIds.has(lead.id))
    .map((lead) => ({
      ...lead,
      blockedDomains: [...(leadDomains.get(lead.id) ?? [])].sort(),
    }));
  const candidateRows =
    affectedCompanyIds.size === 0
      ? []
      : await db
          .select({
            id: candidates.id,
            companyId: candidates.companyId,
            status: candidates.status,
            rationale: candidates.rationale,
          })
          .from(candidates)
          .where(inArray(candidates.companyId, [...affectedCompanyIds]));
  const selectedCandidates = candidateRows.map((candidate) => ({
    ...candidate,
    blockedDomains: [...(companyDomainsById.get(candidate.companyId) ?? [])].sort(),
  }));

  const countsByDomain: Record<string, number> = {};
  for (const domain of THIRD_PARTY_DOMAINS_TO_CORRECT) {
    const rowIds = new Set<string>();
    for (const lead of selectedLeads) {
      if (lead.blockedDomains.includes(domain)) rowIds.add(`lead:${lead.id}`);
    }
    for (const company of selectedCompanies) {
      if (company.blockedDomains.includes(domain)) rowIds.add(`company:${company.id}`);
    }
    for (const candidate of selectedCandidates) {
      if (candidate.blockedDomains.includes(domain)) rowIds.add(`candidate:${candidate.id}`);
    }
    for (const relation of domainRelations) {
      if (relation.blockedDomain === domain) rowIds.add(`domain:${relation.id}`);
    }
    countsByDomain[domain] = rowIds.size;
  }

  return {
    leads: selectedLeads,
    companies: selectedCompanies,
    candidates: selectedCandidates,
    domainRelations,
    countsByDomain,
  };
}

export async function correctThirdPartyDomainLinks(
  db: Database,
  options: {
    readonly apply: boolean;
    readonly at?: Date;
    /** Test-only safety narrowing; the production CLI supplies no scope. */
    readonly leadIds?: readonly string[];
    /** Test-only safety narrowing; the production CLI supplies no scope. */
    readonly companyIds?: readonly string[];
  } = { apply: false },
): Promise<ThirdPartyDomainCorrectionReport> {
  const report = await selectThirdPartyDomainCorrections(db, {
    ...(options.leadIds === undefined ? {} : { leadIds: options.leadIds }),
    ...(options.companyIds === undefined ? {} : { companyIds: options.companyIds }),
  });
  const selectedCount =
    report.leads.length +
    report.companies.length +
    report.candidates.length +
    report.domainRelations.length;
  if (!options.apply || selectedCount === 0) return report;

  const at = options.at ?? new Date();
  const atIso = at.toISOString();
  await db.transaction(async (tx) => {
    for (const lead of report.leads) {
      const correction = {
        reason: "identity mismatch: third-party directory is not the target's official domain",
        blockedDomains: lead.blockedDomains,
        previousPossibleDomain: lead.possibleDomain,
        previousResolvedCompanyId: lead.resolvedCompanyId,
        at: atIso,
        scriptVersion: THIRD_PARTY_DOMAIN_CORRECTION_VERSION,
      };
      await tx
        .update(leads)
        .set({
          status: "unresolved_lead",
          possibleDomain: null,
          resolvedCompanyId: null,
          context: { ...lead.context, thirdPartyDomainCorrection: correction },
          updatedAt: at,
        })
        .where(eq(leads.id, lead.id));
      await tx.insert(auditEvents).values({
        actorUserId: null,
        action: "lead.third_party_domain_detached",
        entityType: "lead",
        entityId: lead.id,
        before: {
          status: lead.status,
          possibleDomain: lead.possibleDomain,
          resolvedCompanyId: lead.resolvedCompanyId,
        },
        after: { status: "unresolved_lead", possibleDomain: null, resolvedCompanyId: null },
        metadata: correction,
      });
    }

    for (const company of report.companies) {
      const websiteBlockedDomain = blockedThirdPartyDomain(company.websiteUrl);
      if (websiteBlockedDomain !== null) {
        await tx
          .update(companies)
          .set({ websiteUrl: null, updatedAt: at })
          .where(eq(companies.id, company.id));
      }
      await tx.insert(auditEvents).values({
        actorUserId: null,
        action: "company.third_party_domain_detached",
        entityType: "company",
        entityId: company.id,
        before: { websiteUrl: company.websiteUrl },
        after: { websiteUrl: websiteBlockedDomain === null ? company.websiteUrl : null },
        metadata: {
          reason: "third-party directory is not the company's official domain",
          blockedDomains: company.blockedDomains,
          scriptVersion: THIRD_PARTY_DOMAIN_CORRECTION_VERSION,
        },
      });
    }

    for (const candidate of report.candidates) {
      const risk = `identity mismatch: third-party directory domain (${candidate.blockedDomains.join(", ")})`;
      const risks = Array.isArray(candidate.rationale.risks) ? candidate.rationale.risks : [];
      await tx
        .update(candidates)
        .set({
          status: "rejected",
          rationale: {
            ...candidate.rationale,
            risks: [...new Set([...risks, risk])],
          },
          updatedAt: at,
        })
        .where(eq(candidates.id, candidate.id));
      await tx.insert(auditEvents).values({
        actorUserId: null,
        action: "candidate.third_party_identity_rejected",
        entityType: "candidate",
        entityId: candidate.id,
        before: { status: candidate.status, rationale: candidate.rationale },
        after: { status: "rejected", identityMismatch: true },
        metadata: {
          reason: risk,
          blockedDomains: candidate.blockedDomains,
          scriptVersion: THIRD_PARTY_DOMAIN_CORRECTION_VERSION,
        },
      });
    }

    const leadIds = report.leads.map((lead) => lead.id);
    const companyIds = report.companies.map((company) => company.id);
    if (leadIds.length > 0 || companyIds.length > 0) {
      const matchRows = await tx
        .select({
          id: identityMatchCandidates.id,
          leadId: identityMatchCandidates.leadId,
          companyId: identityMatchCandidates.companyId,
          decision: identityMatchCandidates.decision,
        })
        .from(identityMatchCandidates)
        .where(
          leadIds.length === 0
            ? inArray(identityMatchCandidates.companyId, companyIds)
            : companyIds.length === 0
              ? inArray(identityMatchCandidates.leadId, leadIds)
              : or(
                  inArray(identityMatchCandidates.leadId, leadIds),
                  inArray(identityMatchCandidates.companyId, companyIds),
                )!,
        );
      for (const match of matchRows) {
        const explanation = "identity mismatch: third-party directory is not the target's official domain";
        await tx
          .update(identityMatchCandidates)
          .set({ decision: "rejected_merge", explanation, decidedAt: at })
          .where(eq(identityMatchCandidates.id, match.id));
        await tx.insert(auditEvents).values({
          actorUserId: null,
          action: "identity_match.third_party_domain_rejected",
          entityType: "identity_match_candidate",
          entityId: match.id,
          before: { decision: match.decision },
          after: { decision: "rejected_merge", explanation },
          metadata: {
            leadId: match.leadId,
            companyId: match.companyId,
            scriptVersion: THIRD_PARTY_DOMAIN_CORRECTION_VERSION,
          },
        });
      }
    }

    for (const relation of report.domainRelations) {
      await tx.insert(auditEvents).values({
        actorUserId: null,
        action: "company_domain.third_party_relation_removed",
        entityType: "company_domain",
        entityId: relation.id,
        before: { companyId: relation.companyId, domain: relation.domain },
        after: null,
        metadata: {
          blockedDomain: relation.blockedDomain,
          reason: "third-party directory relation removed",
          scriptVersion: THIRD_PARTY_DOMAIN_CORRECTION_VERSION,
        },
      });
    }
    if (report.domainRelations.length > 0) {
      await tx
        .delete(companyDomains)
        .where(inArray(companyDomains.id, report.domainRelations.map((relation) => relation.id)));
    }

    await tx.insert(auditEvents).values({
      actorUserId: null,
      action: "remediation.third_party_domain_links_applied",
      entityType: "remediation",
      entityId: null,
      before: null,
      after: {
        leadsReset: report.leads.length,
        companiesDetached: report.companies.length,
        candidatesRejected: report.candidates.length,
        domainRelationsRemoved: report.domainRelations.length,
      },
      metadata: {
        countsByDomain: report.countsByDomain,
        blockedDomains: THIRD_PARTY_DOMAINS_TO_CORRECT,
        appliedAt: atIso,
        scriptVersion: THIRD_PARTY_DOMAIN_CORRECTION_VERSION,
      },
    });
  });
  return report;
}

function loadDatabaseUrl(): void {
  if (process.env.DATABASE_URL) return;
  for (const candidate of [path.join(process.cwd(), ".env.local"), path.join(process.cwd(), ".env")]) {
    if (!existsSync(candidate)) continue;
    const match = readFileSync(candidate, "utf8").match(/^DATABASE_URL=(.*)$/m);
    if (match?.[1]) {
      process.env.DATABASE_URL = match[1].trim();
      return;
    }
  }
}

function printReport(report: ThirdPartyDomainCorrectionReport, apply: boolean): void {
  console.log(
    `${apply ? "applied" : "dry-run"}: ${report.leads.length} lead(s), ` +
      `${report.companies.length} company(s), ${report.candidates.length} candidate(s), ` +
      `${report.domainRelations.length} domain relation(s)`,
  );
  console.log(`by domain: ${JSON.stringify(report.countsByDomain)}`);
  for (const lead of report.leads) {
    console.log(
      `lead ${lead.id} ${lead.rawName}: ${lead.status}/${lead.possibleDomain ?? "null"}/` +
        `${lead.resolvedCompanyId ?? "null"} -> unresolved_lead/null/null ` +
        `[${lead.blockedDomains.join(", ")}]`,
    );
  }
  for (const company of report.companies) {
    console.log(
      `company ${company.id} ${company.legalName}: website=${company.websiteUrl ?? "null"} ` +
        `[${company.blockedDomains.join(", ")}]`,
    );
  }
  for (const candidate of report.candidates) {
    console.log(
      `candidate ${candidate.id} company=${candidate.companyId}: ${candidate.status} -> rejected ` +
        `[${candidate.blockedDomains.join(", ")}]`,
    );
  }
  for (const relation of report.domainRelations) {
    console.log(
      `company_domain ${relation.id} company=${relation.companyId}: remove ${relation.domain}`,
    );
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  loadDatabaseUrl();
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required (.env.local or environment)");
  const report = await correctThirdPartyDomainLinks(getDatabase(), { apply });
  printReport(report, apply);
  await closeDatabase();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
