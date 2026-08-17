"use client";

import { Badge, EmptyState, Metric } from "@asi/ui";

type ScoreDimension = Readonly<{
  key: string;
  label: string;
  value: number | null;
  method: string;
}>;

export type Scorecard = Readonly<{
  subjectType: string;
  subjectId: string;
  overall: number | null;
  completeness: number;
  presentCount: number;
  missingCount: number;
  dimensions: ScoreDimension[];
}>;

function formatScore(value: number | null): string {
  return value === null ? "Not assessed" : value.toFixed(1);
}

export function ScorecardPanel({
  scorecard,
  title = "Derived scorecard",
}: Readonly<{ scorecard: Scorecard | null | undefined; title?: string }>) {
  if (!scorecard) {
    return (
      <section className="admin-panel" aria-labelledby="scorecard-heading">
        <header className="admin-panel__header">
          <h2 id="scorecard-heading">{title}</h2>
        </header>
        <EmptyState
          title="No scorecard available"
          description="Scores are derived from persisted evidence. Missing dimensions stay unassessed rather than zero."
        />
      </section>
    );
  }

  return (
    <section className="admin-panel" aria-labelledby="scorecard-heading">
      <header className="admin-panel__header">
        <h2 id="scorecard-heading">{title}</h2>
        <p className="asi-page-description">
          Missing dimensions remain null and reduce completeness. They are never
          coerced to zero.
        </p>
      </header>
      <div className="admin-form-grid">
        <Metric
          label="Overall"
          value={formatScore(scorecard.overall)}
          detail={
            scorecard.overall === null
              ? "No assessed dimensions yet"
              : `${scorecard.presentCount} assessed dimension${scorecard.presentCount === 1 ? "" : "s"}`
          }
        />
        <Metric
          label="Completeness"
          value={`${Math.round(scorecard.completeness * 100)}%`}
          detail={`${scorecard.missingCount} unassessed`}
        />
      </div>
      <ul className="admin-stack" style={{ marginBlockStart: "var(--asi-space-12)" }}>
        {scorecard.dimensions.map((dimension) => (
          <li key={dimension.key}>
            <strong>{dimension.label}</strong>
            {": "}
            {dimension.value === null ? (
              <Badge tone="neutral">Not assessed</Badge>
            ) : (
              dimension.value.toFixed(1)
            )}
            <p className="asi-page-description">{dimension.method.replaceAll("_", " ")}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
