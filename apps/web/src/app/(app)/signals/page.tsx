import { SignalExplorer } from "@/components/signal-explorer";

export const metadata = {
  title: "Investor research queue",
  description:
    "Live, read-only investor research priorities for raw source signals with current Jev and Muse evidence.",
};

export default function SignalsPage() {
  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">Read-only evidence prioritization</p>
        <h1 className="asi-page-title">Investor research queue</h1>
        <p className="asi-page-description">
          Rank and filter raw source observations by current research priority,
          then inspect the source-backed reasons, unknowns, exclusions, Jev
          triage, and persistent Muse progress. Scores prioritize research only;
          they do not rate investment quality, change qualification gates, or
          create canonical companies.
        </p>
      </header>
      <SignalExplorer />
    </>
  );
}
