/**
 * Idempotent registry seeding for the qualification pipeline.
 * Called during supervisor startup; defaults are reconciled by stable key.
 */
import { researchAgents, type Database } from "@asi/database";

export interface DefaultAgentSeed {
  key: string;
  name: string;
  agentType:
    | "discover_source"
    | "enrich_candidate"
    | "monitor_ownership"
    | "refresh_stale"
    | "golden_neighbor"
    | "resolve_domain"
    | "qualify_award_lead";
  goal: string;
  cadenceSeconds: number;
  budgetSharePct: string;
  status: "running" | "paused";
}

export const DEFAULT_AGENT_SEEDS: readonly DefaultAgentSeed[] = [
  {
    key: "discover-usaspending",
    name: "USAspending Discoverer",
    agentType: "discover_source",
    goal: "Harvest strict federal aerospace award observations into quarantined source signals; never create leads directly.",
    cadenceSeconds: 3600,
    budgetSharePct: "10.00",
    status: "paused",
  },
  {
    key: "discover-sam",
    name: "SAM Entity Discoverer",
    agentType: "discover_source",
    goal: "Surface registered aerospace entities via SAM.gov entity search (requires SAM_API_KEY; idles without one).",
    cadenceSeconds: 7200,
    budgetSharePct: "5.00",
    status: "paused",
  },
  {
    key: "enrich-queue",
    name: "Candidate Enricher",
    agentType: "enrich_candidate",
    goal: "Deep-research queued candidates oldest-first until evidence supports a routing decision.",
    cadenceSeconds: 300,
    budgetSharePct: "25.00",
    status: "running",
  },
  {
    key: "monitor-ownership",
    name: "Ownership Monitor",
    agentType: "monitor_ownership",
    goal: "Re-verify ownership on high-interest, evaluate, shortlist, and watchlist candidates whose ownership observations are stale.",
    cadenceSeconds: 21600,
    budgetSharePct: "10.00",
    status: "running",
  },
  {
    key: "refresh-stale",
    name: "Evidence Refresher",
    agentType: "refresh_stale",
    goal: "Re-fetch evidence documents older than 30 days that back live candidate scores.",
    cadenceSeconds: 21600,
    budgetSharePct: "5.00",
    status: "running",
  },
  {
    key: "golden-neighbor",
    name: "Golden Neighbor Scout",
    agentType: "golden_neighbor",
    goal: "For positively-reviewed golden examples, find same-platform and same-qualification peers.",
    cadenceSeconds: 86400,
    budgetSharePct: "5.00",
    status: "paused",
  },
  {
    key: "resolve-domains",
    name: "Domain Resolver",
    agentType: "resolve_domain",
    goal: "Find and verify official websites for discovered leads lacking domains, then attach and promote them.",
    cadenceSeconds: 600,
    budgetSharePct: "15.00",
    status: "running",
  },
  {
    key: "qualify-award-leads",
    name: "Award Lead Qualifier",
    agentType: "qualify_award_lead",
    goal: "Verify source signals through Exa, official-site identity, manufacturing evidence, and actionability before creating leads.",
    cadenceSeconds: 600,
    budgetSharePct: "25.00",
    status: "paused",
  },
] as const;

export async function ensureDefaultAgents(db: Database): Promise<number> {
  let seeded = 0;
  for (const seed of DEFAULT_AGENT_SEEDS) {
    const result = await db
      .insert(researchAgents)
      .values({
        key: seed.key,
        name: seed.name,
        agentType: seed.agentType,
        goal: seed.goal,
        cadenceSeconds: seed.cadenceSeconds,
        budgetSharePct: seed.budgetSharePct,
        status: seed.status,
      })
      .onConflictDoUpdate({
        target: researchAgents.key,
        set: {
          name: seed.name,
          agentType: seed.agentType,
          goal: seed.goal,
          cadenceSeconds: seed.cadenceSeconds,
          budgetSharePct: seed.budgetSharePct,
          status: seed.status,
        },
      })
      .returning({ id: researchAgents.id });
    if (result.length > 0) seeded += 1;
  }
  return seeded;
}
