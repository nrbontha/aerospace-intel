import Link from "next/link";

import { EmptyState, StatusDot } from "@asi/ui";

export default function DashboardPage() {
  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">Intelligence workspace</p>
        <h1 className="asi-page-title">Dashboard</h1>
        <p className="asi-page-description">
          Review evidence-backed supplier coverage and research activity after
          source records have been ingested.
        </p>
      </header>

      <div className="asi-dashboard-empty">
        <StatusDot
          className="asi-dashboard-empty__status"
          label="Awaiting source data"
          tone="warning"
        />
        <EmptyState
          className="asi-dashboard-empty__body"
          title="No intelligence data has been loaded"
          description={
            <p>
              This workspace intentionally shows no supplier metrics until
              traceable source records are imported and reviewed.
            </p>
          }
          action={
            <ul className="asi-dashboard-empty__next">
              <li>
                Register traceable source metadata in{" "}
                <Link href="/data-sources">Data Sources</Link>.
              </li>
              <li>
                Begin a controlled load in <Link href="/imports">Imports</Link>.
              </li>
            </ul>
          }
        />
      </div>
    </>
  );
}
