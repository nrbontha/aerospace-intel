import { ResearchRunsTable } from "@/components/research-runs-table";

export default function ResearchRunsPage() {
  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">Research operations</p>
        <h1 className="asi-page-title">Research runs</h1>
        <p className="asi-page-description">
          Inspect queued and completed source research with recorded progress,
          model usage, cost, proposals, and failures.
        </p>
      </header>

      <ResearchRunsTable />
    </>
  );
}
