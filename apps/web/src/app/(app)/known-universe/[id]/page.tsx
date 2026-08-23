import type { Metadata } from "next";
import { Suspense } from "react";

import { KnownUniverseMembers } from "@/components/known-universe-members";

export const metadata: Metadata = { title: "Snapshot members | ASI" };

export default async function KnownUniverseSnapshotPage(props: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await props.params;

  return (
    <Suspense
      fallback={
        <div className="admin-panel" role="status">
          Loading snapshot members…
        </div>
      }
    >
      <KnownUniverseMembers snapshotId={id} />
    </Suspense>
  );
}
