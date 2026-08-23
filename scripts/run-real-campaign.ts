/**
 * Real bounded campaign runner (validation harness, orchestrator-owned).
 * Drives the full pipeline through library functions against a local DB:
 *   campaign → frontier → USAspending (live) → leads → identity resolution
 *   → candidate promotion with four-axis scores.
 *
 * Usage: DATABASE_URL=... npx tsx scripts/run-real-campaign.ts [maxIterations]
 * No OpenRouter calls; USAspending is a free public API bounded by the
 * strategy's maxPages-per-item cap.
 */
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  getDatabase,
  users,
  ingestCampaignLeadsFromFrontier,
} from "@asi/database";
import {
  createCampaign,
  planCampaign,
  applyLifecycleAction,
  processDueItems,
  UsaspendingDiscoveryStrategy,
} from "@asi/research";
import { promoteCompany } from "../apps/web/src/lib/candidate-scoring.js";

async function main(): Promise<void> {
  const maxIterations = Number(process.argv[2] ?? "6");
  const db = getDatabase();

  const [admin] = await db.select().from(users).limit(1);
  if (admin === undefined) throw new Error("No users in database");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const campaign = await createCampaign(
    {
      name: `usaspending-real-${stamp}`,
      objective:
        "Bounded live validation: discover small US aerospace component manufacturers via federal award recipients.",
      seeds: { sources: ["usaspending"] },
      budgetUsd: 0.25,
      concurrency: 2,
      maxDepth: 2,
    },
    { creator: admin.id },
  );
  console.log("campaign", { id: campaign.id, name: campaign.name });

  const planned = await planCampaign(campaign.id, {
    searchableSources: ["usaspending"],
  });
  console.log("planned", planned);

  const started = await applyLifecycleAction(campaign.id, "start");
  console.log("started", started.status);

  const strategy = new UsaspendingDiscoveryStrategy();
  for (let i = 0; i < maxIterations; i += 1) {
    const result = await processDueItems(campaign.id, {
      strategy,
      wallTimeMs: 90_000,
      maxConcurrent: 2,
    });
    console.log("processDueItems", result);
    if (result.stopReason !== "slice_complete") break;
  }

  const ingest = await ingestCampaignLeadsFromFrontier(campaign.id);
  console.log("ingest", ingest);

  // Promote every company this campaign produced or matched.
  const leadRows = await db.execute<{ resolved_company_id: string | null }>(
    sql`select resolved_company_id from leads where campaign_id = ${campaign.id} and resolved_company_id is not null`,
  );
  let promoted = 0;
  const promotedIds = new Set<string>();
  for (const row of leadRows.rows) {
    const companyId = row.resolved_company_id;
    if (companyId === null || promotedIds.has(companyId)) continue;
    promotedIds.add(companyId);
    try {
      const result = await promoteCompany(db, companyId);
      promoted += 1;
      console.log("promoted", {
        companyId,
        scores: result.candidate.currentScores,
        noveltyStatus: result.candidate.noveltyStatus,
        status: result.candidate.status,
      });
    } catch (error) {
      console.error("promote_failed", companyId, String(error));
    }
  }

  const summary = await db.execute<{
    leads: string;
    candidates_total: string;
    frontier_items: string;
  }>(sql`select
       (select count(*) from leads where campaign_id = ${campaign.id}) as leads,
       (select count(*) from candidates) as candidates_total,
       (select count(*) from frontier_items where campaign_id = ${campaign.id}) as frontier_items`);
  console.log("summary", { promoted, ...summary.rows[0] });

  await applyLifecycleAction(campaign.id, "pause").catch(() => undefined);
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
