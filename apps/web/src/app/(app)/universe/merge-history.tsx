"use client";

import { CatalogExplorer } from "@/components/catalog-explorer";

type MergeRow = Readonly<{
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  sourceLegalName: string | null;
  targetLegalName: string | null;
  status: string;
  reason: string;
  mergedAt: string;
  revertedAt: string | null;
}>;

/**
 * Merge history as mounted on the Universe identity-review tab. Client
 * wrapper because CatalogExplorer takes render-function column props, which
 * cannot cross the server/client boundary directly.
 */
export function MergeHistory() {
  return (
    <CatalogExplorer<MergeRow>
      title="Merge events"
      description="Persisted company merge and revert history."
      endpoint="/api/v1/merges"
      searchPlaceholder="Company name or reason"
      emptyTitle="No company merges recorded"
      emptyDescription="Merges appear after an analyst combines two company records."
      hrefFor={(row) => `/companies/${row.targetEntityId}`}
      columns={[
        {
          header: "Source",
          cell: (row) => row.sourceLegalName ?? row.sourceEntityId,
        },
        {
          header: "Survivor",
          cell: (row) => row.targetLegalName ?? row.targetEntityId,
        },
        { header: "Status", cell: (row) => row.status },
        { header: "Reason", cell: (row) => row.reason },
        {
          header: "Merged",
          cell: (row) => new Date(row.mergedAt).toLocaleString(),
        },
      ]}
    />
  );
}
