/**
 * Analyst-in-the-loop step of the validation campaign: two leads were
 * verified via public web research (official sites + CAGE directories):
 *   - Zephyr International LLC  — zephyrintl.com, CAGE 3CAT3, Conway SC
 *   - York Precision Machining & Hydraulics LLC — yorkpmh.com, CAGE 81A16
 * Creates canonical companies with provenance notes, resolves the leads,
 * records identity-match decisions, and promotes both to scored candidates.
 *
 * Usage: DATABASE_URL=... npx tsx scripts/promote-verified-leads.ts <campaignId>
 */
import { and, eq, sql } from "drizzle-orm";
import {
  getDatabase,
  users,
  companies,
  companyDomains,
  companyIdentifiers,
  leads,
  identityMatchCandidates,
} from "@asi/database";
import { normalizeLegalName } from "@asi/database";
import { promoteCompany } from "../apps/web/src/lib/candidate-scoring.js";

interface VerifiedLead {
  leadName: string;
  displayName: string;
  legalName: string;
  domain: string;
  websiteUrl: string;
  cage?: string;
  state?: string;
  sourceUrls: string[];
}

const VERIFIED: VerifiedLead[] = [
  {
    leadName: "ZEPHYR INTERNATIONAL LLC",
    displayName: "Zephyr International",
    legalName: "Zephyr International LLC",
    domain: "zephyrintl.com",
    websiteUrl: "https://zephyrintl.com/",
    cage: "3CAT3",
    state: "SC",
    sourceUrls: ["https://zephyrintl.com/who-we-are/", "https://govtribe.com/vendors/zephyr-international-llc-3cat3"],
  },
  {
    leadName: "YORK PRECISION MACHINING AND HYDRAULICS, LLC",
    displayName: "York Precision Machining & Hydraulics",
    legalName: "York Precision Machining and Hydraulics, LLC",
    domain: "yorkpmh.com",
    websiteUrl: "https://yorkpmh.com/",
    cage: "81A16",
    state: "PA",
    sourceUrls: ["https://yorkpmh.com/", "https://govtribe.com/vendors/york-precision-machining-and-hydraulics-llc-81a16"],
  },
];

async function main(): Promise<void> {
  const campaignId = process.argv[2];
  if (campaignId === undefined) throw new Error("usage: promote-verified-leads.ts <campaignId>");
  const db = getDatabase();

  const [admin] = await db.select().from(users).limit(1);
  if (admin === undefined) throw new Error("No users");

  for (const v of VERIFIED) {
    // 1. Canonical company with primary domain + CAGE identifier.
    const [company] = await db
      .insert(companies)
      .values({
        displayName: v.displayName,
        legalName: normalizeLegalName(v.legalName),
        websiteUrl: v.websiteUrl,
      })
      .onConflictDoNothing()
      .returning();
    let companyId = company?.id;
    if (companyId === undefined) {
      const found = await db.execute<{ id: string }>(
        sql`select id from companies where lower(legal_name) = ${v.legalName.toLowerCase()} limit 1`,
      );
      companyId = found.rows[0]?.id;
    }
    if (companyId === undefined) throw new Error(`could not create ${v.displayName}`);
    console.log("company", { companyId, name: v.displayName });

    await db
      .insert(companyDomains)
      .values({ companyId, domain: v.domain, isPrimary: true, verifiedAt: new Date() })
      .onConflictDoNothing();
    if (v.cage !== undefined) {
      await db
        .insert(companyIdentifiers)
        .values({ companyId, type: "cage", value: v.cage })
        .onConflictDoNothing();
    }

    // 2. Resolve the lead with an auditable identity-match decision.
    const [lead] = await db
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.campaignId, campaignId), eq(leads.rawName, v.leadName)))
      .limit(1);
    if (lead === undefined) {
      console.error("lead_not_found", v.leadName);
      continue;
    }
    await db.insert(identityMatchCandidates).values({
      leadId: lead.id,
      companyId,
      signalType: "analyst_verified_web",
      features: { sourceUrls: v.sourceUrls, method: "orchestrator web research" },
      confidence: "0.950",
      explanation: `Domain and CAGE verified against official site and public CAGE directory during validation research: ${v.sourceUrls.join(", ")}`,
      decision: "merged",
      decidedBy: admin.id,
      decidedAt: new Date(),
    });
    await db
      .update(leads)
      .set({ status: "resolved", resolvedCompanyId: companyId, updatedAt: new Date() })
      .where(eq(leads.id, lead.id));

    // 3. Promote to a scored, routed candidate.
    const result = await promoteCompany(db, companyId);
    console.log("candidate", {
      companyId,
      noveltyStatus: result.candidate.noveltyStatus,
      status: result.candidate.status,
      currentScores: result.candidate.currentScores,
    });
  }

  const counts = await db.execute<{ candidates_total: string; resolved_leads: string }>(
    sql`select (select count(*) from candidates) as candidates_total,
               (select count(*) from leads where campaign_id = ${campaignId} and status = 'resolved') as resolved_leads`,
  );
  console.log("summary", counts.rows[0]);
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
