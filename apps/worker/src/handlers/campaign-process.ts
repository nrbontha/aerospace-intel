import { PgBoss } from "pg-boss";

import type { CampaignStatus } from "@asi/contracts";
import {
  CompositeDiscoveryStrategy,
  PassthroughStrategy,
  processDueItems,
  type CampaignProcessJobPayload,
  type DiscoveryStrategy,
} from "@asi/research";
import { getDatabase } from "@asi/database/client";
import { frontierItems, researchCampaigns } from "@asi/database";
import { and, eq, sql } from "drizzle-orm";

import type {
  QueueLogger,
  ResearchJobContext,
  ResearchJobHandler,
} from "../queue.js";

/** Wall time one handler invocation spends processing before re-enqueueing. */
const SLICE_WALL_TIME_MS = 55_000;
/** Delay bounds for the self re-enqueue heartbeat. */
const MIN_REENQUEUE_DELAY_S = 1;
const MAX_REENQUEUE_DELAY_S = 15 * 60;

export interface CampaignProcessHandlerOptions {
  queueName: string;
  logger: QueueLogger;
  /** Registered discovery strategies; defaults to the passthrough fallback. */
  strategies?: readonly DiscoveryStrategy[];
  databaseUrl?: string;
}

// ---------------------------------------------------------------------------
// Publisher singleton — pg-boss connection used only to re-enqueue
// campaign-process jobs (the heartbeat). Reused across job invocations.
// ---------------------------------------------------------------------------

let publisherPromise: Promise<PgBoss> | undefined;

function getCampaignPublisher(databaseUrl: string): Promise<PgBoss> {
  publisherPromise ??= (async () => {
    const boss = new PgBoss({
      application_name: "asi-worker-campaign-publisher",
      connectionString: databaseUrl,
    });
    await boss.start();
    return boss;
  })();
  return publisherPromise;
}

/** Stop the shared publisher pool; called on worker shutdown. */
export async function stopCampaignPublisher(): Promise<void> {
  if (publisherPromise === undefined) return;
  const publisher = await publisherPromise;
  publisherPromise = undefined;
  await publisher.stop({ close: true, graceful: false, timeout: 5_000 });
}

async function nextDueDelaySeconds(campaignId: string): Promise<number | null> {
  const result = await getDatabase().execute<{ seconds: number | null }>(sql`
    SELECT CASE
      WHEN COUNT(*) FILTER (WHERE status = 'in_progress') > 0 THEN 0
      WHEN COUNT(*) FILTER (WHERE status = 'pending') = 0 THEN NULL
      ELSE GREATEST(
        0,
        EXTRACT(EPOCH FROM (
          COALESCE(MIN(next_attempt_at), now()) - now()
        ))
      )
    END AS seconds
    FROM frontier_items
    WHERE campaign_id = ${campaignId}
      AND status IN ('pending', 'in_progress')
  `);
  const raw = result.rows[0]?.seconds;
  if (raw === null || raw === undefined) return null;
  return Math.min(
    MAX_REENQUEUE_DELAY_S,
    Math.max(MIN_REENQUEUE_DELAY_S, Math.ceil(raw)),
  );
}

async function campaignHasWorkDue(campaignId: string): Promise<boolean> {
  const rows = await getDatabase()
    .select({ id: frontierItems.id })
    .from(frontierItems)
    .where(
      and(
        eq(frontierItems.campaignId, campaignId),
        sql`${frontierItems.status} IN ('pending', 'in_progress')`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function loadCampaignStatus(
  campaignId: string,
): Promise<CampaignStatus | null> {
  const [row] = await getDatabase()
    .select({ status: researchCampaigns.status })
    .from(researchCampaigns)
    .where(eq(researchCampaigns.id, campaignId))
    .limit(1);
  return row?.status ?? null;
}

/**
 * campaign-process.v1 worker handler.
 *
 * Heartbeat pattern: each invocation processes a bounded wall-time slice of
 * due frontier items, then re-enqueues itself with a delay matched to the
 * earliest retry-due item while the campaign is running and work remains.
 * The loop terminates when the campaign leaves `running` (paused /
 * completed / frontier_exhausted / budget_exhausted / cancelled) or when no
 * pending/in_progress items remain. A SIGTERM mid-slice aborts processing
 * cooperatively (unclaimed items are released back to pending); the job
 * completes normally and continuation is guaranteed by the re-enqueue.
 */
export function createCampaignProcessHandler(
  options: CampaignProcessHandlerOptions,
): ResearchJobHandler<"campaign-process.v1"> {
  const strategies =
    options.strategies ?? [new PassthroughStrategy()];
  const strategy = new CompositeDiscoveryStrategy(strategies);

  return async function handleCampaignProcess(
    payload: CampaignProcessJobPayload,
    context: ResearchJobContext,
  ): Promise<void> {
    const status = await loadCampaignStatus(payload.campaignId);
    if (status === null) {
      options.logger("warn", "campaign.process_unknown_campaign", {
        campaignId: payload.campaignId,
      });
      return;
    }
    if (status !== "running") {
      options.logger("info", "campaign.process_skipped", {
        campaignId: payload.campaignId,
        status,
      });
      return;
    }

    const slice = await processDueItems(payload.campaignId, {
      strategy,
      signal: context.signal,
      wallTimeMs: SLICE_WALL_TIME_MS,
    });
    options.logger("info", "campaign.process_slice", {
      campaignId: payload.campaignId,
      ...slice,
    });

    const currentStatus = await loadCampaignStatus(payload.campaignId);
    if (currentStatus !== "running") return;
    if (!(await campaignHasWorkDue(payload.campaignId))) return;

    const delaySeconds = await nextDueDelaySeconds(payload.campaignId);
    if (delaySeconds === null) return;

    const databaseUrl =
      options.databaseUrl ?? process.env["DATABASE_URL"] ?? "";
    if (databaseUrl.length === 0) {
      options.logger("error", "campaign.reenqueue_no_database_url");
      return;
    }
    const publisher = await getCampaignPublisher(databaseUrl);
    await publisher.send(options.queueName, payload, {
      singletonKey: `campaign-process-${payload.campaignId}`,
      startAfter: delaySeconds,
      retryLimit: 0,
    });
  };
}
