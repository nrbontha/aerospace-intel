import { sql } from "drizzle-orm";

import { PgBoss } from "pg-boss";

import { getDatabase } from "@asi/database/client";

import type { QueueLogger } from "./queue.js";

/** How often the sweep looks for stalled campaigns. */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Running campaigns whose frontier still has pending or in-progress work but
 * whose campaign-process heartbeat job is gone (producer crash, redeploy,
 * pg-boss singleton debounce). Without revival they would sit `running`
 * forever.
 */
export async function findStalledCampaignIds(): Promise<string[]> {
  const result = await getDatabase().execute<{ id: string }>(sql`
    SELECT c.id
    FROM research_campaigns c
    WHERE c.status = 'running'
      AND EXISTS (
        SELECT 1 FROM frontier_items f
        WHERE f.campaign_id = c.id AND f.status IN ('pending', 'in_progress')
      )
      AND NOT EXISTS (
        SELECT 1 FROM pgboss.job j
        WHERE j.name = 'campaign-process.v1'
          AND j.state IN ('created', 'retry', 'active')
          AND j.data->>'campaignId' = c.id::text
      )
    LIMIT 32
  `);
  return result.rows.map((row) => row.id);
}

export interface CampaignSweepHandle {
  stop(): void;
}

/**
 * Periodically revive stalled campaign heartbeats by re-kicking the
 * campaign-process.v1 job. Storage-free by construction: it only reads two
 * Postgres tables and reuses the campaign publisher connection.
 */
export function startCampaignSweep(options: {
  publisher: () => Promise<PgBoss>;
  queueName: string;
  logger: QueueLogger;
  intervalMs?: number;
}): CampaignSweepHandle {
  const { publisher, queueName, logger } = options;
  const intervalMs = options.intervalMs ?? SWEEP_INTERVAL_MS;
  let stopped = false;

  const timer = setInterval(() => {
    void (async () => {
      try {
        const ids = await findStalledCampaignIds();
        if (ids.length === 0 || stopped) return;
        const boss = await publisher();
        for (const campaignId of ids) {
          await boss.send(
            queueName,
            { name: "campaign-process.v1", campaignId },
            { singletonKey: `campaign-process:${campaignId}` },
          );
        }
        logger("warn", "campaign.sweep_revived", { count: ids.length });
      } catch (error) {
        logger("error", "campaign.sweep_failed", {
          reason: error instanceof Error ? error.message : "unknown",
        });
      }
    })();
  }, intervalMs);
  timer.unref();

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}
