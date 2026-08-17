import { CatalogExplorer } from "@/components/catalog-explorer";

type PartRow = Readonly<{
  id: string;
  partNumber: string;
  name: string | null;
  manufacturerName: string | null;
  lifecycleStatus: string;
  qualificationCount: number;
}>;

export default function PartsPage() {
  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">Taxonomy</p>
        <h1 className="asi-page-title">Parts</h1>
        <p className="asi-page-description">
          Part numbers used to scope facility qualifications. A listed part is
          not evidence that a supplier is qualified.
        </p>
      </header>
      <CatalogExplorer<PartRow>
        title="Parts"
        description="Persisted part numbers, names, and qualification counts."
        endpoint="/api/v1/parts"
        searchPlaceholder="Part number or name"
        emptyTitle="No parts recorded"
        emptyDescription="Parts appear when taxonomy is imported or created from reviewed evidence."
        exportEntity="parts"
        hrefFor={(row) => `/parts/${row.id}`}
        columns={[
          { header: "Part number", cell: (row) => row.partNumber },
          { header: "Name", cell: (row) => row.name ?? "Not recorded" },
          {
            header: "Manufacturer",
            cell: (row) => row.manufacturerName ?? "Unknown",
          },
          { header: "Status", cell: (row) => row.lifecycleStatus },
          {
            header: "Qualifications",
            numeric: true,
            cell: (row) => row.qualificationCount.toLocaleString(),
          },
        ]}
      />
    </>
  );
}
