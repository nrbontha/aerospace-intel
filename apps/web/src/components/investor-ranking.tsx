import { Badge } from "@asi/ui";

import type { InvestorRanking } from "@/lib/signal-analyst";

function formatTime(value: string | null): string {
  if (value === null) return "Not scored yet";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString();
}

function statusTone(
  status: InvestorRanking["status"],
): "success" | "warning" | "danger" {
  if (status === "ranked") return "success";
  if (status === "excluded") return "danger";
  return "warning";
}

function statusLabel(status: InvestorRanking["status"]): string {
  if (status === "ranked") return "Ranked for research";
  if (status === "excluded") return "Factually excluded";
  return "Unknown / unscored";
}

function basisLabel(
  basis: InvestorRanking["breakdown"][number]["basis"],
): string {
  switch (basis) {
    case "source":
      return "Source-backed";
    case "hypothesis":
      return "Provisional hypothesis";
    case "verified_review":
      return "Verified final review";
    case "unresolved":
      return "Unknown / unresolved";
  }
}

function basisTone(
  basis: InvestorRanking["breakdown"][number]["basis"],
): "success" | "warning" | "info" | "neutral" {
  switch (basis) {
    case "source":
    case "verified_review":
      return "success";
    case "hypothesis":
      return "warning";
    case "unresolved":
      return "neutral";
  }
}

function scoreText(ranking: InvestorRanking): string {
  if (ranking.status === "unscored" || ranking.score === null) {
    return "Unscored — not zero";
  }
  if (ranking.status === "excluded") return "Excluded · 0 / 100";
  return `${ranking.score} / 100`;
}

export function InvestorRankingDisplay({
  ranking,
  compact = false,
}: Readonly<{
  ranking: InvestorRanking;
  compact?: boolean;
}>) {
  const subtotal = ranking.breakdown.reduce(
    (sum, item) => sum + item.points,
    0,
  );
  const hypothesisPoints = ranking.breakdown.reduce(
    (sum, item) =>
      item.basis === "hypothesis" ? sum + item.points : sum,
    0,
  );
  const unresolvedCount = ranking.breakdown.filter(
    (item) => item.basis === "unresolved",
  ).length;

  if (compact) {
    return (
      <div
        className="investor-ranking investor-ranking--compact"
        data-status={ranking.status}
        aria-label={`Investor research priority: ${scoreText(ranking)}`}
      >
        <strong className="investor-ranking__score">{scoreText(ranking)}</strong>
        <Badge tone={statusTone(ranking.status)}>{statusLabel(ranking.status)}</Badge>
        {ranking.status === "unscored" ? (
          <span className="investor-ranking__note">
            No current policy-valid score; unknown is not rejection.
          </span>
        ) : null}
        {ranking.status === "excluded" ? (
          <span className="investor-ranking__note investor-ranking__note--danger">
            {ranking.blockers[0] ?? "A current source-backed blocker applies."}
          </span>
        ) : null}
        {hypothesisPoints > 0 ? (
          <span className="investor-ranking__note investor-ranking__note--hypothesis">
            Includes {hypothesisPoints} provisional hypothesis point
            {hypothesisPoints === 1 ? "" : "s"}.
          </span>
        ) : null}
        {unresolvedCount > 0 ? (
          <span className="investor-ranking__note">
            {unresolvedCount} unresolved score factor
            {unresolvedCount === 1 ? "" : "s"}.
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <section
      className="admin-panel admin-stack investor-ranking"
      data-status={ranking.status}
      aria-labelledby="investor-ranking-heading"
    >
      <div className="signal-section-heading">
        <div>
          <p className="asi-page-kicker">Investor research priority</p>
          <h2 id="investor-ranking-heading" className="investor-ranking__score">
            {scoreText(ranking)}
          </h2>
        </div>
        <Badge tone={statusTone(ranking.status)}>{statusLabel(ranking.status)}</Badge>
      </div>
      <p className="investor-ranking__guardrail">
        This score orders research work only. It is not investment quality,
        probability, a qualification decision, or automatic investment approval.
      </p>
      <dl className="signal-facts signal-facts--compact">
        <div className="signal-fact">
          <dt>Scoring policy</dt>
          <dd>{ranking.policyVersion}</dd>
        </div>
        <div className="signal-fact">
          <dt>Score updated</dt>
          <dd>{formatTime(ranking.updatedAt)}</dd>
        </div>
      </dl>

      {ranking.status === "unscored" ? (
        <div className="investor-ranking__callout" data-tone="warning">
          <strong>Unknown is not zero and is not a rejection.</strong>
          <span>
            A current same-source-revision, policy-valid Jev result is not
            available, so this record cannot be ranked yet.
          </span>
        </div>
      ) : null}

      {ranking.status === "excluded" ? (
        <div className="investor-ranking__callout" data-tone="danger">
          <strong>A current source-backed exclusion overrides the subtotal.</strong>
          <span>
            The evidence breakdown totals {subtotal} / 100, but the displayed
            research-priority score is 0 while this blocker is current.
          </span>
          <ul>
            {ranking.blockers.length > 0 ? (
              ranking.blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))
            ) : (
              <li>A current source-backed blocker applies.</li>
            )}
          </ul>
        </div>
      ) : null}

      <div>
        <h3>Score reasons</h3>
        {ranking.breakdown.length === 0 ? (
          <p className="asi-page-description">
            No score breakdown is available until a current result can be scored.
          </p>
        ) : (
          <ol className="investor-ranking__breakdown">
            {ranking.breakdown.map((item) => (
              <li key={item.key} data-basis={item.basis}>
                <div className="signal-section-heading">
                  <strong>{item.label}</strong>
                  <span className="investor-ranking__points">
                    {item.points} / {item.maxPoints} points
                  </span>
                </div>
                <p>{item.reason}</p>
                <Badge tone={basisTone(item.basis)}>{basisLabel(item.basis)}</Badge>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
