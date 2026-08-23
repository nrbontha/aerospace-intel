"use client";

import type { CandidateStatus, EffectiveTier, NoveltyStatus } from "@asi/contracts";
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
  high_interest: "High interest",
  evaluate: "Evaluate",
  researching: "Researching",
  needs_research: "Needs research",
  low_interest: "Low interest",
};

// ---------------------------------------------------------------------------
// Tier chip (REDESIGN_PLAN §2.1)
// ---------------------------------------------------------------------------

const TIER_META: Record<
  EffectiveTier,
  Readonly<{ emoji: string; tone: BadgeTone }>
> = {
  high_interest: { emoji: "🔴", tone: "danger" },
  evaluate: { emoji: "🟡", tone: "warning" },
  researching: { emoji: "🔵", tone: "info" },
  needs_research: { emoji: "⚪", tone: "neutral" },
  low_interest: { emoji: "⚫", tone: "neutral" },
  watchlist: { emoji: "👁️", tone: "info" },
};

/** Colored effective-tier chip. `pinned` marks a human tier_override that
 * engine re-routing will not clobber. */
export function TierChip({
  tier,
  pinned = false,
}: {
  tier: EffectiveTier;
  pinned?: boolean;
}) {
  const meta = TIER_META[tier];
  return (
    <span
      className="asi-badge"
      data-tone={meta.tone}
      title={
        pinned
          ? `${humanLabel(tier)} — human override (pinned; engine routing will not change it)`
          : humanLabel(tier)
      }
    >
      <span aria-hidden="true">{meta.emoji}</span>{" "}
      {humanLabel(tier)}
      {pinned ? <span style={{ opacity: 0.7 }}> · pinned</span> : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Confidence banding (REDESIGN_PLAN §2.2)
// ---------------------------------------------------------------------------

export type ConfidenceBand = "strong" | "medium" | "weak" | "thin";

/** Axis score → banded verdict. Frozen thresholds mirror the router's
 * low-confidence gate (50): ≥70 strong, ≥50 medium, ≥25 weak, else thin. */
export function confidenceBand(
  value: number | null | undefined,
): ConfidenceBand | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value >= 70) return "strong";
  if (value >= 50) return "medium";
  if (value >= 25) return "weak";
  return "thin";
}

const CONFIDENCE_BAND_TONE: Record<ConfidenceBand, BadgeTone> = {
  strong: "success",
  medium: "info",
  weak: "warning",
  thin: "danger",
};

export function ConfidenceChip({
  value,
}: {
  value: number | null | undefined;
}) {
  const band = confidenceBand(value);
  return (
    <span
      className="asi-badge"
      data-tone={band === null ? undefined : CONFIDENCE_BAND_TONE[band]}
      title={
        band === null
          ? "Confidence score not available"
          : `Confidence band: ${band} (score ${Math.round(value as number)})`
      }
    >
      {band === null
        ? "Conf —"
        : `Conf ${band} ${Math.round(value as number)}`}
    </span>
  );
}

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
