import type { Metadata } from "next";
import { Suspense } from "react";

import { KnownUniverseSnapshots } from "@/components/known-universe-snapshots";

export const metadata: Metadata = { title: "Known Universe | ASI" };

export default function KnownUniversePage() {
  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">Universe coverage</p>
        <h1 className="asi-page-title">Known Universe</h1>
        <p className="asi-page-description">
          Browse imported universe snapshots and their members, then test any
          name against the active snapshots and the canonical catalog.
        </p>
      </header>
      <Suspense
        fallback={
          <div className="admin-panel" role="status">
            Loading snapshots…
          </div>
        }
      >
        <KnownUniverseSnapshots />
      </Suspense>
    </>
  );
}
