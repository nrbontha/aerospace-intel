"use client";

import type { CampaignStatus, FrontierItemStatus } from "@asi/contracts";
import type { BadgeTone } from "@asi/ui";
import { Badge } from "@asi/ui";

import { humanLabel } from "@/components/target-feed/candidate-bits";

// ---------------------------------------------------------------------------
// Status badge — budget_exhausted / frontier_exhausted get a distinct marker
// so the "stopped for economic reasons" states never read like plain failures.
// ---------------------------------------------------------------------------

function campaignStatusTone(status: CampaignStatus): BadgeTone {
  switch (status) {
    case "running":
      return "success";
    case "queued":
      return "info";
    case "paused":
      return "warning";
    case "failed":
      return "danger";
    case "budget_exhausted":
      return "warning";
    case "frontier_exhausted":
      return "danger";
    default:
      return "neutral";
  }
}

const EXHAUSTED_MARKERS: Readonly<Partial<Record<CampaignStatus, string>>> = {
  budget_exhausted: "$0",
  frontier_exhausted: "\u2205",
};

export function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
  const marker = EXHAUSTED_MARKERS[status];
  return (
    <Badge data-exhausted={marker === undefined ? undefined : status} tone={campaignStatusTone(status)}>
      {marker === undefined ? null : `${marker} `}
      {humanLabel(status)}
    </Badge>
  );
}

export function frontierStatusTone(status: string): BadgeTone {
  switch (status) {
    case "done":
      return "success";
    case "in_progress":
      return "info";
    case "failed":
      return "danger";
    case "blocked":
      return "warning";
    case "skipped":
      return "neutral";
    default:
      return "neutral";
  }
}

export function FrontierStatusChip({ status }: { status: FrontierItemStatus }) {
  return <Badge tone={frontierStatusTone(status)}>{humanLabel(status)}</Badge>;
}

/** Lifecycle buttons enabled per the server's transition table. */
const ACTIVE_STATUSES: readonly CampaignStatus[] = [
  "draft",
  "queued",
  "running",
  "paused",
];

export function lifecycleEnabled(
  status: CampaignStatus,
  action: "start" | "pause" | "resume" | "cancel",
): boolean {
  switch (action) {
    case "start":
      return status === "draft" || status === "queued";
    case "pause":
      return status === "running";
    case "resume":
      return status === "paused";
    case "cancel":
      return ACTIVE_STATUSES.includes(status);
  }
}

// ---------------------------------------------------------------------------
// Spend vs budget mini-bar
// ---------------------------------------------------------------------------

export function SpendMeter({
  spendUsd,
  budgetUsd,
  compact = false,
}: {
  spendUsd: number;
  budgetUsd: number | null;
  compact?: boolean;
}) {
  if (budgetUsd === null) {
    return (
      <span className="asi-muted">
        ${spendUsd.toFixed(2)} / no budget
      </span>
    );
  }
  const ratio = budgetUsd > 0 ? Math.min(spendUsd / budgetUsd, 1) : spendUsd > 0 ? 1 : 0;
  const overBudget = spendUsd > budgetUsd && budgetUsd > 0;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--asi-space-6, 6px)",
        minInlineSize: compact ? "8rem" : undefined,
      }}
      title={`$${spendUsd.toFixed(2)} spent of $${budgetUsd.toFixed(2)}`}
    >
      <span
        aria-hidden
        style={{
          background: "var(--asi-track, rgba(127,127,127,0.25))",
          borderRadius: "3px",
          display: "inline-block",
          flex: compact ? "1 1 auto" : "0 0 6rem",
          height: "6px",
          inlineSize: compact ? undefined : "6rem",
          overflow: "hidden",
        }}
      >
        <span
          style={{
            background: overBudget
              ? "var(--asi-danger, #c0392b)"
              : "var(--asi-accent, currentColor)",
            display: "block",
            height: "100%",
            inlineSize: `${Math.round(ratio * 100)}%`,
          }}
        />
      </span>
      <span style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
        ${spendUsd.toFixed(2)} / ${budgetUsd.toFixed(2)}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Frontier counts breakdown ("2 pending · 7 done · 1 failed")
// ---------------------------------------------------------------------------

const BREAKDOWN_ORDER: readonly string[] = [
  "pending",
  "in_progress",
  "done",
  "failed",
  "blocked",
  "skipped",
];

export function frontierBreakdownSummary(
  breakdown: Record<string, number>,
): string {
  const parts: string[] = [];
  for (const key of BREAKDOWN_ORDER) {
    const value = breakdown[key];
    if (value !== undefined && value > 0) parts.push(`${value} ${humanLabel(key)}`);
  }
  for (const [key, value] of Object.entries(breakdown)) {
    if (!BREAKDOWN_ORDER.includes(key) && value > 0) parts.push(`${value} ${key}`);
  }
  return parts.length === 0 ? "0 items" : parts.join(" \u00b7 ");
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function truncate(value: string, max = 60): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}\u2026`;
}

export function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toISOString().slice(0, 10);
}
