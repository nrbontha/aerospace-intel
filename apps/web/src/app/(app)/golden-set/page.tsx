import type { Metadata } from "next";
import { Suspense } from "react";

import { GoldenSetExplorer } from "@/components/golden-set-explorer";
import { requireUser } from "@/lib/auth";

export const metadata: Metadata = { title: "Golden Set | ASI" };

export default async function GoldenSetPage() {
  const user = await requireUser();
  const canReview = user.role === "analyst" || user.role === "admin";

  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">Classification ground truth</p>
        <h1 className="asi-page-title">Golden Set</h1>
        <p className="asi-page-description">
          Review the workbook examples that define supplier classification
          labels. Proposed labels come from import; reviewed labels are analyst
          decisions and require a rationale.
        </p>
      </header>
      <Suspense
        fallback={
          <div className="admin-panel" role="status">
            Loading golden set…
          </div>
        }
      >
        <GoldenSetExplorer canReview={canReview} />
      </Suspense>
    </>
  );
}
