"use client";

import type { CandidateStatus, NoveltyStatus } from "@asi/contracts";
import type { BadgeTone } from "@asi/ui";
import { Badge } from "@asi/ui";

// ---------------------------------------------------------------------------
// Shared labels
// ---------------------------------------------------------------------------

const LABELS: Record<string, string> = {
  queued_research: "Queued research",
  in_research: "In research",
  research_ready: "Research ready",
  partner_review: "Partner review",
  shortlist: "Shortlist",
  hold: "Hold",
  rejected: "Rejected",
  watchlist: "Watchlist",
  archived: "Archived",
  not_matched_to_current_known_universe: "Not matched",
  possible_known_universe_match: "Possible match",
  confirmed_known_company: "Confirmed known",
  unable_to_assess: "Unable to assess",
};

export function humanLabel(value: string): string {
  return LABELS[value] ?? value.replaceAll("_", " ");
}

function statusTone(status: CandidateStatus): BadgeTone {
  if (status === "shortlist") return "success";
  if (status === "rejected" || status === "archived") return "danger";
  if (status === "hold") return "warning";
  if (status === "partner_review") return "info";
  return "neutral";
}

export function StatusBadge({ status }: { status: CandidateStatus }) {
  return <Badge tone={statusTone(status)}>{humanLabel(status)}</Badge>;
}

/**
 * Novelty verdict colors: not_matched=green, possible=amber,
 * confirmed=gray, unable=hollow (the default badge chrome).
 */
function noveltyTone(novelty: NoveltyStatus): BadgeTone {
  if (novelty === "not_matched_to_current_known_universe") return "success";
  if (novelty === "possible_known_universe_match") return "warning";
  if (novelty === "confirmed_known_company") return "neutral";
  return "neutral";
}

export function NoveltyBadge({ novelty }: { novelty: NoveltyStatus }) {
  const hollow = novelty === "unable_to_assess";
  return (
    <span
      className="asi-badge"
      data-tone={hollow ? undefined : noveltyTone(novelty)}
      title={novelty}
    >
      {humanLabel(novelty)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Score chips
// ---------------------------------------------------------------------------

const AXIS_LABELS: Record<string, string> = {
  fit: "Fit",
  novelty: "Novelty",
  confidence: "Conf",
  actionability: "Act",
};

export function AxisChip({
  axis,
  value,
}: {
  axis: "fit" | "novelty" | "confidence" | "actionability";
  value: number | null | undefined;
}) {
  return (
    <span
      title={`${AXIS_LABELS[axis]} score`}
      style={{
        display: "inline-flex",
        alignItems: "baseline",
        gap: "0.2rem",
        border: "1px solid var(--asi-border, currentColor)",
        borderRadius: "4px",
        padding: "0 0.3rem",
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
      }}
    >
      <span
        aria-hidden="true"
        style={{ fontSize: "0.7rem", opacity: 0.7 }}
      >
        {AXIS_LABELS[axis]}
      </span>
      <span>
        {typeof value === "number" && Number.isFinite(value)
          ? Math.round(value)
          : "—"}
      </span>
    </span>
  );
}

export function formatInstant(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toISOString().slice(0, 10);
}
