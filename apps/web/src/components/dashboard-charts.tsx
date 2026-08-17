"use client";

import { EmptyState } from "@asi/ui";
import { useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type SeriesPoint = Readonly<{
  day: string;
  succeededRuns: number;
  failedRuns: number;
  proposalCount: number;
  spendUsd: number;
}>;

export function DashboardCharts() {
  const [series, setSeries] = useState<SeriesPoint[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/v1/analytics/series", {
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        });
        const payload: unknown = await response.json();
        if (!response.ok) throw new Error("Unable to load analytics series");
        if (
          typeof payload !== "object" ||
          payload === null ||
          !("data" in payload) ||
          !Array.isArray(payload.data)
        ) {
          throw new Error("Invalid analytics series");
        }
        setSeries(payload.data as SeriesPoint[]);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : "Unable to load charts");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  if (loading) {
    return (
      <p className="asi-page-description" role="status">
        Loading 30-day activity…
      </p>
    );
  }
  if (error) {
    return (
      <EmptyState title="Charts unavailable" description={error} />
    );
  }
  if (series.length === 0) {
    return (
      <EmptyState
        title="No activity in the last 30 days"
        description="Research runs, proposals, and model spend will plot here once recorded."
      />
    );
  }

  return (
    <div className="admin-grid">
      <section className="admin-panel" aria-labelledby="run-chart-heading">
        <header className="admin-panel__header">
          <h2 id="run-chart-heading">Research outcomes (30 days)</h2>
        </header>
        <div className="asi-chart" role="img" aria-label="Succeeded and failed research runs by day">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={[...series]}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="day" tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend />
              <Bar dataKey="succeededRuns" name="Succeeded" fill="var(--asi-success)" />
              <Bar dataKey="failedRuns" name="Failed" fill="var(--asi-danger)" />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <table className="asi-chart-table">
          <caption>Same research outcome data as the chart</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Succeeded</th>
              <th scope="col">Failed</th>
            </tr>
          </thead>
          <tbody>
            {series.map((point) => (
              <tr key={`runs-${point.day}`}>
                <td>{point.day}</td>
                <td>{point.succeededRuns}</td>
                <td>{point.failedRuns}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="admin-panel" aria-labelledby="spend-chart-heading">
        <header className="admin-panel__header">
          <h2 id="spend-chart-heading">Proposals and model spend</h2>
        </header>
        <div className="asi-chart" role="img" aria-label="Proposal count and model spend by day">
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={[...series]}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="day" tick={{ fontSize: 11 }} />
              <YAxis yAxisId="left" allowDecimals={false} tick={{ fontSize: 11 }} />
              <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend />
              <Line
                yAxisId="left"
                type="monotone"
                dataKey="proposalCount"
                name="Proposals"
                stroke="var(--asi-accent)"
                dot={false}
              />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="spendUsd"
                name="Spend USD"
                stroke="var(--asi-warning)"
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <table className="asi-chart-table">
          <caption>Same proposal and spend data as the chart</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Proposals</th>
              <th scope="col">Spend USD</th>
            </tr>
          </thead>
          <tbody>
            {series.map((point) => (
              <tr key={`spend-${point.day}`}>
                <td>{point.day}</td>
                <td>{point.proposalCount}</td>
                <td>{point.spendUsd.toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
