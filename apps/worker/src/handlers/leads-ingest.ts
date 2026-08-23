import type { LeadsIngestJobPayload } from "@asi/research";
import { ingestCampaignLeadsFromFrontier } from "@asi/database";

import type {
  QueueLogger,
  ResearchJobContext,
  ResearchJobHandler,
} from "../queue.js";

export interface LeadsIngestHandlerOptions {
  logger: QueueLogger;
}

/**
 * leads.ingest.v1 worker handler.
 *
 * Follow-up job enqueued by the campaign processor after a slice inserted
 * new frontier children: converts every `company`-type frontier item of the
 * campaign into lead rows and runs identity resolution
 * (`ingestCampaignLeadsFromFrontier`). Idempotent by construction — leads
 * dedupe on (campaignId, rawName, domain), so re-delivery or analyst
 * re-runs via POST /api/v1/leads/ingest converge to the same state.
 */
export function createLeadsIngestHandler(
  options: LeadsIngestHandlerOptions,
): ResearchJobHandler<"leads.ingest.v1"> {
  return async function handleLeadsIngest(
    payload: LeadsIngestJobPayload,
    _context: ResearchJobContext,
  ): Promise<void> {
    const summary = await ingestCampaignLeadsFromFrontier(payload.campaignId);
    options.logger("info", "leads.ingest_summary", {
      campaignId: payload.campaignId,
      ...summary,
    });
  };
}
