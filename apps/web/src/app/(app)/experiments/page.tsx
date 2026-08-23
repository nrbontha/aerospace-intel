import { ExperimentsLab } from "@/components/experiments-lab";

export default function ExperimentsPage() {
  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">Research operations</p>
        <h1 className="asi-page-title">Experiments</h1>
        <p className="asi-page-description">
          Qualifier Lab: champion/challenger scoring-program evaluation over
          the frozen golden set with journaled promotion decisions. Research
          Lab: read-only experiment journal for policy, enrichment, and other
          research runs.
        </p>
      </header>

      <ExperimentsLab />
    </>
  );
}
