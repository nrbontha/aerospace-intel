"use client";
import { Metric } from "@asi/ui";
import Link from "next/link";

import type { AgentsOverview } from "@/lib/agents-api";

import { formatRelativeTime, formatUsd } from "./format";

type LiveStripProps = Readonly<{
  loading: boolean;
  overview: AgentsOverview | null;
  error: string | null;
}>;

/**
 * Live strip (REDESIGN_PLAN §3): running agents · $ today vs cap · open
 * proposals · last find timestamp. Every value comes straight from
 * /api/v1/agents/overview; loading and failure are shown, never papered over.
 */
export function LiveStrip({ loading, overview, error }: LiveStripProps) {
  if (error !== null && overview === null) {
    return (
      <p className="admin-feedback" data-tone="error" role="alert">
        Live strip unavailable: {error}
      </p>
    );
  }
  if (overview === null) {
    return (
      <p className="asi-page-description" role="status" aria-live="polite">
        {loading ? "Loading live status…" : "No live status available."}
      </p>
    );
  }

  const { counts, spendTodayUsd, dailyCapUsd } = overview;
  const spentPct = dailyCapUsd > 0 ? Math.min(100, (spendTodayUsd / dailyCapUsd) * 100) : 100;
  const budgetTone =
    spentPct >= 100 ? "danger" : spentPct >= 80 ? "warning" : undefined;

  return (
    <div
      className="admin-panel"
      data-testid="research-live-strip"
      aria-label="Agent control plane live status"
    >
      <div className="admin-form-grid">
        <Metric
          label="Running agents"
          value={`${counts.running} of ${counts.total}`}
          detail={`idle ${counts.idle} · paused ${counts.paused} · failed ${counts.failed}`}
        />
        <Metric
          label="Spend today vs cap"
          value={
            <>
              {formatUsd(spendTodayUsd)}{" "}
              <span aria-hidden="true">/</span> {formatUsd(dailyCapUsd)}
            </>
          }
          detail={
            <>
              <span
                role="progressbar"
                aria-valuenow={Math.round(spentPct)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Daily model spend against global cap"
                style={{
                  display: "block",
                  height: "6px",
                  borderRadius: "3px",
                  background: "var(--asi-border, #d4d4d8)",
                  overflow: "hidden",
                }}
              >
                <span
                  style={{
                    display: "block",
                    width: `${spentPct}%`,
                    height: "100%",
                    background:
                      budgetTone === "danger"
                        ? "var(--asi-danger, #dc2626)"
                        : budgetTone === "warning"
                          ? "var(--asi-warning, #d97706)"
                          : "var(--asi-accent, #2563eb)",
                  }}
                />
              </span>
              {budgetTone === undefined ? null : (
                <span role="status">
                  {spentPct >= 100
                    ? "Daily cap reached — agents will idle honestly."
                    : "Approaching the daily cap."}
                </span>
              )}
            </>
          }
        />
        <Metric
          label="Open proposals"
          value={overview.openProposals}
          detail={
            overview.openProposals > 0
              ? "Awaiting human review in the Universe tab."
              : "Nothing waiting on a human."
          }
        />
        <Metric
          label="Last find"
          value={formatRelativeTime(overview.lastFind?.at ?? null)}
          detail={
            overview.lastFind === null
              ? "No agent has produced a find yet."
              : `by ${overview.lastFind.agentName} (${overview.lastFind.agentKey})`
          }
        />
        <Metric
          label="Source signals"
          value={`${overview.sourceSignals.queuedQualification} queued · ${overview.sourceSignals.qualifying} qualifying`}
          detail={
            <>
              <span>
                Qualified today: <Link href="/feed">{overview.sourceSignals.qualifiedToday}</Link>
              </span>
              <span> · Rejected today: {overview.sourceSignals.rejectedToday}</span>
              <span> · Quarantined legacy: {overview.sourceSignals.quarantined}</span>
              <span>
                {" "}
                · Weak signals are not Targets until official-site qualification
                passes.
              </span>
              {overview.sourceSignals.latestQualification === null ? null : (
                <span>
                  {" "}
                  · Latest qualification{" "}
                  {formatRelativeTime(overview.sourceSignals.latestQualification)}
                </span>
              )}
            </>
          }
        />
      </div>
      {error !== null ? (
        <p className="admin-feedback" data-tone="error" role="alert">
          Last refresh failed ({error}) — showing the values above from the
          previous successful poll.
        </p>
      ) : null}
    </div>
  );
}
