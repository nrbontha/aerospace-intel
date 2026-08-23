"use client";

import { Badge } from "@asi/ui";
import Link from "next/link";
import { useEffect, useState } from "react";

import {
  listCampaigns,
  type CampaignRecord,
} from "@/lib/campaigns-api";

const CAMPAIGN_TONES: Readonly<Record<string, "neutral" | "info" | "success" | "warning" | "danger">> = {
  draft: "neutral",
  planned: "info",
  running: "success",
  paused: "warning",
  completed: "info",
  cancelled: "danger",
};

type CampaignsStripProps = Readonly<{ refreshSignal: number }>;

/**
 * Compact campaigns subsection (REDESIGN_PLAN §3): the legacy bounded-experiment
 * list. Lifecycle actions (start/pause/resume/cancel) stay on each campaign's
 * detail page — this strip only lists and links, so it never duplicates a
 * second control surface for the same audited mutations.
 */
export function CampaignsStrip({ refreshSignal }: CampaignsStripProps) {
  const [campaigns, setCampaigns] = useState<readonly CampaignRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    listCampaigns(1, controller.signal)
      .then((page) => setCampaigns(page.data))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "Failed to load campaigns.");
      });
    return () => controller.abort();
  }, [refreshSignal]);

  return (
    <section
      className="admin-panel"
      aria-labelledby="research-campaigns-heading"
      data-testid="campaigns-strip"
    >
      <div className="admin-panel__header">
        <h3 id="research-campaigns-heading">Campaigns</h3>
        <p>
          Deliberate, bounded experiments. Continuous agents are the always-on
          layer above; start/pause/resume/cancel live on each campaign&apos;s page.
        </p>
      </div>
      {error !== null ? (
        <p className="admin-feedback" data-tone="error" role="alert">
          Could not load campaigns: {error}
        </p>
      ) : campaigns === null ? (
        <p className="asi-page-description" role="status" aria-live="polite">
          Loading campaigns…
        </p>
      ) : campaigns.length === 0 ? (
        <p className="asi-page-description" role="status">
          No campaigns exist yet.
        </p>
      ) : (
        <ul className="asi-timeline">
          {campaigns.map((campaign) => (
            <li key={campaign.id} data-testid="campaign-row">
              <Badge tone={CAMPAIGN_TONES[campaign.status] ?? "neutral"}>
                {campaign.status}
              </Badge>{" "}
              <Link href={`/campaigns/${campaign.id}`}>{campaign.name}</Link>{" "}
              <span className="admin-user-meta">
                {campaign.spendUsd > 0 ? `· spent $${campaign.spendUsd.toFixed(2)} ` : ""}
                {campaign.budgetUsd !== null ? `· budget $${campaign.budgetUsd.toFixed(2)} ` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
