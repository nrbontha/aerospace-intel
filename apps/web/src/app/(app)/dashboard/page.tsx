import { DashboardCharts } from "@/components/dashboard-charts";
import { DashboardMetrics } from "@/components/dashboard-metrics";

export default function DashboardPage() {
  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">Intelligence operations</p>
        <h1 className="asi-page-title">Dashboard</h1>
        <p className="asi-page-description">
          Database-backed coverage, review workload, and research execution at a
          glance. Counts update as sources are mined and proposals reviewed.
        </p>
      </header>

      <DashboardMetrics />
      <DashboardCharts />
    </>
  );
}
