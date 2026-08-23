import { Suspense } from "react";

import { TargetFeed } from "@/components/target-feed/target-feed";

export const metadata = {
  title: "Targets",
  description: "The single tiered table of acquisition-target candidates.",
};

export default function FeedPage() {
  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">Discovery</p>
        <h1 className="asi-page-title">Targets</h1>
        <p className="asi-page-description">
          The default working surface: every scored supplier candidate in one
          tiered table — engine-proposed tiers, human overrides (audited),
          confidence bands, and saved views.
        </p>
      </header>
      <Suspense
        fallback={
          <p className="asi-page-description" role="status" aria-live="polite">
            Loading candidates…
          </p>
        }
      >
        <TargetFeed />
      </Suspense>
    </>
  );
}
