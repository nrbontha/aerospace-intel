import { Suspense } from "react";

import { TargetFeedQueue } from "@/components/target-feed/target-feed";

export const metadata = {
  title: "Partner Review",
  description:
    "Candidates awaiting a partner review decision, ordered by priority.",
};

export default function PartnerReviewPage() {
  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">Discovery</p>
        <h1 className="asi-page-title">Partner Review</h1>
        <p className="asi-page-description">
          Candidates routed to partner review, highest partner-review priority
          first. Each decision records investment feedback and transitions the
          candidate.
        </p>
      </header>
      <Suspense
        fallback={
          <p className="asi-page-description" role="status" aria-live="polite">
            Loading partner review queue…
          </p>
        }
      >
        <TargetFeedQueue />
      </Suspense>
    </>
  );
}
