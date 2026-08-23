import { Suspense } from "react";

import { TargetFeed } from "@/components/target-feed/target-feed";

export const metadata = {
  title: "Target Feed",
  description: "Scored discovery candidates ranked by partner review priority.",
};

export default function FeedPage() {
  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">Discovery</p>
        <h1 className="asi-page-title">Target Feed</h1>
        <p className="asi-page-description">
          The default working surface: every scored supplier candidate, ranked
          by partner-review priority, with novelty verdicts and axis scores.
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
