import { uuidSchema } from "@asi/contracts";
import { auditEvents, ingestCampaignLeadsFromFrontier } from "@asi/database";
import { getDatabase } from "@asi/database/client";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { jsonError, jsonSuccess } from "@/lib/api";
import { requireRole, verifyCsrfRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";

const ingestBodySchema = z.strictObject({ campaignId: uuidSchema });

// POST /api/v1/leads/ingest — analyst/admin re-run of lead ingestion for a
// campaign's proposed-but-uningested company frontier items. Idempotent:
// dedupe keys collapse already-ingested candidates into duplicateSkipped.
export async function POST(request: NextRequest): Promise<Response> {
  try {
    const actor = await requireRole("analyst", "admin");
    await verifyCsrfRequest(request);

    const body = ingestBodySchema.safeParse(await request.json());
    if (!body.success) {
      return jsonError(
        "validation_failed",
        "Invalid ingest payload",
        400,
        body.error.flatten(),
      );
    }

    const summary = await ingestCampaignLeadsFromFrontier(body.data.campaignId);
    await getDatabase().insert(auditEvents).values({
      actorUserId: actor.id,
      action: "leads.ingest_rerun",
      entityType: "research_campaign",
      entityId: body.data.campaignId,
      after: summary,
    });
    return jsonSuccess(summary);
  } catch {
    return jsonError("internal_error", "An internal error occurred", 500);
  }
}
