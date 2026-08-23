import { and, eq, sql } from "drizzle-orm";

import type { Database } from "../client.js";
import {
  auditEvents,
  companies,
  companyDomains,
  companySourceLinks,
  dataSources,
  goldenExamples,
  type GoldenExample,
} from "../schema.js";
import { normalizeDomain, normalizeLegalName } from "../provenance.js";
import {
  getCandidateByCompanyId,
  setHumanTier,
  upsertCandidate,
} from "../candidates/storage.js";

/**
 * Golden-set → Targets-table seeding (REDESIGN_PLAN §2.1 decision).
 *
 * Every golden example with a linked-or-creatable company becomes a scored
 * candidate at tier_override='high_interest' (tier_source='human') carrying
 * the explicit caveat annotation: the golden set calibrates OUR archetype —
 * it says nothing about whether those companies know or want us. The
 * proposed-label rationale (including the public-subsidiary
 * `ideal_archetype_but_unactionable` wording) is carried verbatim into
 * `rationale.whyInteresting` so the annotation stays visible in the
 * Additional-context drawer.
 *
 * This is deliberately a direct packages/database storage path (NOT the web
 * scoring pipeline): scripts cannot import from apps/web, and the golden set
 * is calibration data, not engine output — no fit/novelty axes are computed.
 */

export const GOLDEN_SEED_PROVENANCE_NOTE = "golden-set reference import";

/** Data-source row backing company_source_links provenance for the seeder. */
const PROVENANCE_SOURCE_NAME = "Golden Set Reference Import";

export interface GoldenSeedRationale {
  whyInteresting: string[];
  risks: string[];
  unknowns: string[];
}

/**
 * Pure: builds the candidate rationale from stored example labels. Uses the
 * reviewed typed columns when present, falling back to the proposed labels.
 */
export function buildGoldenSeedRationale(example: {
  goldenExampleType: GoldenExample["goldenExampleType"];
  archetypeFit: GoldenExample["archetypeFit"];
  buildToPrintRisk: GoldenExample["buildToPrintRisk"];
  proposedLabels: Record<string, unknown>;
}): GoldenSeedRationale {
  const proposed = example.proposedLabels ?? {};
  const whyInteresting: string[] = [];

  // Verbatim rules rationale — this is what keeps the public-subsidiary
  // "ideal archetype but unactionable" annotation visible on the Targets row.
  if (typeof proposed.rationale === "string" && proposed.rationale.trim() !== "") {
    whyInteresting.push(proposed.rationale);
  }
  const type = example.goldenExampleType ?? proposed.goldenExampleType;
  const archetype = example.archetypeFit ?? proposed.archetypeFit;
  whyInteresting.push(
    `Golden-set member (${typeof type === "string" ? type : "unclassified"}` +
      `${typeof archetype === "string" ? `, archetype fit ${archetype}` : ""})` +
      " — reference company matching the qualifying parameters.",
  );

  const risks = ["reference example — interest not known mutual"];

  const unknowns: string[] = [];
  const btp = example.buildToPrintRisk ?? proposed.buildToPrintRisk;
  if (btp === "unknown") {
    unknowns.push("Build-to-print risk unclassified — no source signal yet.");
  }

  return { whyInteresting, risks, unknowns };
}

export type GoldenSeedCompanyAction = "created" | "matched" | "planned_create" | "planned_match";

export type GoldenSeedCandidateAction =
  | "seeded"
  | "skipped_existing"
  | "planned_seed"
  | "planned_skip";

export interface GoldenSeedItemResult {
  exampleId: string;
  name: string;
  domain: string | null;
  companyId: string | null;
  companyAction: GoldenSeedCompanyAction;
  candidateAction: GoldenSeedCandidateAction;
}

export interface GoldenSeedSummary {
  totalExamples: number;
  companiesCreated: number;
  companiesMatched: number;
  candidatesSeeded: number;
  candidatesSkippedExisting: number;
  items: GoldenSeedItemResult[];
}

interface ResolvedCompany {
  companyId: string | null;
  action: "created" | "matched" | "planned_create" | "planned_match";
}

function grataText(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function countryToIso2(country: string | null): string | null {
  if (country === null) return null;
  const normalized = country.trim().toLowerCase();
  if (
    ["united states", "usa", "us", "united states of america", "u.s."].includes(normalized)
  ) {
    return "US";
  }
  return /^[a-z]{2}$/.test(normalized) ? normalized.toUpperCase() : null;
}

function foundedYearOrNull(value: string | null): number | null {
  if (value === null) return null;
  const year = Number.parseInt(value, 10);
  return Number.isInteger(year) && year >= 1700 && year <= 2200 ? year : null;
}

async function findCompanyId(
  db: Database,
  domain: string | null,
  name: string,
): Promise<string | null> {
  // Primary key of resolution is the domain; fall back to the normalized
  // legal/display name so examples without a usable domain still match.
  const normalizedDomain = normalizeDomain(domain ?? "");
  if (normalizedDomain !== null) {
    const byDomain = await db.execute<{ id: string }>(sql`
      SELECT c.id
      FROM company_domains d
      JOIN companies c ON c.id = d.company_id
      WHERE lower(d.domain) = ${normalizedDomain}
      LIMIT 1
    `);
    if (byDomain.rows[0] !== undefined) return byDomain.rows[0].id;
  }
  const normalizedName = normalizeLegalName(name);
  const byName = await db.execute<{ id: string }>(sql`
    SELECT id FROM companies
    WHERE lower(legal_name) = ${normalizedName} OR lower(display_name) = ${normalizedName}
    LIMIT 1
  `);
  return byName.rows[0]?.id ?? null;
}

async function ensureProvenanceSource(db: Database): Promise<string> {
  const existing = await db
    .select({ id: dataSources.id })
    .from(dataSources)
    .where(sql`lower(${dataSources.name}) = ${PROVENANCE_SOURCE_NAME.toLowerCase()}`)
    .limit(1);
  const found = existing[0];
  if (found !== undefined) return found.id;

  const inserted = await db
    .insert(dataSources)
    .values({
      name: PROVENANCE_SOURCE_NAME,
      sourceType: "reference_import",
      access: "public",
      ingestion: "manual",
      publisher: "internal",
      notes:
        `${GOLDEN_SEED_PROVENANCE_NOTE}: companies created from the ADCO ` +
        "golden-set workbook for calibration, not discovered through research.",
    })
    .onConflictDoNothing()
    .returning({ id: dataSources.id });
  const row = inserted[0];
  if (row !== undefined) return row.id;
  const raced = await db
    .select({ id: dataSources.id })
    .from(dataSources)
    .where(sql`lower(${dataSources.name}) = ${PROVENANCE_SOURCE_NAME.toLowerCase()}`)
    .limit(1);
  const racedRow = raced[0];
  if (racedRow === undefined) throw new Error("could not ensure golden-seed provenance source");
  return racedRow.id;
}

async function resolveOrCreateCompany(
  db: Database,
  example: GoldenExample,
  dryRun: boolean,
): Promise<ResolvedCompany> {
  const matchedId = await findCompanyId(db, example.domain, example.name);
  if (matchedId !== null) {
    return { companyId: matchedId, action: dryRun ? "planned_match" : "matched" };
  }

  if (dryRun) return { companyId: null, action: "planned_create" };

  const payload = example.grataPayload ?? {};
  const domain = normalizeDomain(example.domain ?? "");
  const inserted = await db
    .insert(companies)
    .values({
      displayName: example.name,
      legalName: normalizeLegalName(example.name),
      description: grataText(payload, "Description"),
      headquartersCountryCode: countryToIso2(grataText(payload, "Country")),
      foundedYear: foundedYearOrNull(grataText(payload, "Year Founded")),
      websiteUrl: domain === null ? null : `https://${domain}`,
    })
    .returning({ id: companies.id });
  const company = inserted[0];
  if (company === undefined) throw new Error(`company insert returned no row for ${example.name}`);

  if (domain !== null) {
    await db
      .insert(companyDomains)
      .values({ companyId: company.id, domain, isPrimary: true, verifiedAt: new Date() })
      .onConflictDoNothing();
  }
  return { companyId: company.id, action: "created" };
}

function alreadySeededHighInterest(candidate: {
  tierOverride: string | null;
  tierSource: string;
}): boolean {
  return candidate.tierOverride === "high_interest" && candidate.tierSource === "human";
}

/**
 * Seed every golden example into the Targets table at High interest.
 * Idempotent by company domain/name: matched companies are reused, and a
 * candidate that already sits at human high_interest is skipped without
 * writing duplicate feedback/audit rows.
 */
export async function seedGoldenCandidates(
  db: Database,
  options: { actorId: string; dryRun?: boolean },
): Promise<GoldenSeedSummary> {
  const dryRun = options.dryRun === true;
  const examples = await db.select().from(goldenExamples).orderBy(goldenExamples.createdAt);

  const summary: GoldenSeedSummary = {
    totalExamples: examples.length,
    companiesCreated: 0,
    companiesMatched: 0,
    candidatesSeeded: 0,
    candidatesSkippedExisting: 0,
    items: [],
  };

  let provenanceSourceId: string | null = null;
  if (!dryRun && examples.length > 0) {
    provenanceSourceId = await ensureProvenanceSource(db);
  }

  for (const example of examples) {
    const company = await resolveOrCreateCompany(db, example, dryRun);

    if (!dryRun && company.companyId !== null) {
      // Link the example to its canonical company (idempotent refresh).
      if (example.companyId !== company.companyId) {
        await db
          .update(goldenExamples)
          .set({ companyId: company.companyId })
          .where(eq(goldenExamples.id, example.id));
      }
      if (provenanceSourceId !== null) {
        await db
          .insert(companySourceLinks)
          .values({
            dataSourceId: provenanceSourceId,
            companyId: company.companyId,
            relationship: GOLDEN_SEED_PROVENANCE_NOTE,
          })
          .onConflictDoNothing();
      }
    }

    let candidateAction: GoldenSeedCandidateAction;
    if (dryRun) {
      const existing =
        company.companyId === null
          ? null
          : await getCandidateByCompanyId(db, company.companyId);
      const plannedSkip = existing !== null && alreadySeededHighInterest(existing);
      candidateAction = plannedSkip ? "planned_skip" : "planned_seed";
    } else {
      candidateAction = await seedCandidateForExample(db, example, company.companyId, options.actorId);
    }

    if (candidateAction === "seeded") summary.candidatesSeeded += 1;
    if (candidateAction === "skipped_existing") summary.candidatesSkippedExisting += 1;
    if (company.action === "created") summary.companiesCreated += 1;
    if (company.action === "matched") summary.companiesMatched += 1;

    summary.items.push({
      exampleId: example.id,
      name: example.name,
      domain: example.domain,
      companyId: company.companyId,
      companyAction: company.action,
      candidateAction,
    });
  }

  return summary;
}


async function seedCandidateForExample(
  db: Database,
  example: GoldenExample,
  companyId: string | null,
  actorId: string,
): Promise<GoldenSeedCandidateAction> {
  if (companyId === null) {
    // resolveOrCreateCompany creates the company when nothing matches, so a
    // null id here means the caller bypassed it — refuse rather than
    // silently under-seeding.
    throw new Error(`golden example ${example.id} (${example.name}) has no resolvable company`);
  }

  const existing = await getCandidateByCompanyId(db, companyId);
  if (existing !== null && alreadySeededHighInterest(existing)) {
    return "skipped_existing";
  }

  const rationale = buildGoldenSeedRationale(example);

  // promoteCompany-equivalent via packages/database storage only: upsert the
  // candidate shell (idempotent by company_id), then apply the human High
  // interest override through setHumanTier — which records investment
  // feedback + 'candidate.tier_overridden' audit and survives re-routing.
  const seeded = await db.transaction(async (tx) =>
    upsertCandidate(tx, {
      companyId,
      routedStatus: "partner_review",
      noveltyStatus: "unable_to_assess",
      noveltySnapshotIds: [],
      rationale,
      currentScores: {},
      researchPriority: null,
      partnerReviewPriority: null,
    }),
  );

  await setHumanTier(db, {
    candidateId: seeded.id,
    tier: "high_interest",
    actorId,
    note: GOLDEN_SEED_PROVENANCE_NOTE,
  });

  await db.insert(auditEvents).values({
    actorUserId: actorId,
    action: "golden.candidate_seeded",
    entityType: "candidate",
    entityId: seeded.id,
    before: existing === null ? null : { status: existing.status, tierOverride: existing.tierOverride },
    after: { tierOverride: "high_interest", tierSource: "human" },
    metadata: {
      provenanceNote: GOLDEN_SEED_PROVENANCE_NOTE,
      goldenExampleId: example.id,
      goldenExampleType: example.goldenExampleType,
      companyId,
      candidateId: seeded.id,
    },
  });

  return "seeded";
}

/** Counted helper kept separate so skipped-without-company stays honest. */
export async function countGoldenSeedAuditRows(db: Database): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditEvents)
    .where(and(eq(auditEvents.entityType, "candidate"), eq(auditEvents.action, "golden.candidate_seeded")));
  return rows[0]?.n ?? 0;
}
