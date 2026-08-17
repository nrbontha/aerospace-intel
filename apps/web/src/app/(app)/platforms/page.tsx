import { CatalogExplorer } from "@/components/catalog-explorer";

type PlatformRow = Readonly<{
  id: string;
  name: string;
  platformType: string | null;
  manufacturerName: string | null;
  variantCount: number;
  qualificationCount: number;
}>;

export default function PlatformsPage() {
  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">Taxonomy</p>
        <h1 className="asi-page-title">Platforms</h1>
        <p className="asi-page-description">
          Platforms and variants used to scope facility qualifications. A
          platform name is not a qualification.
        </p>
      </header>
      <CatalogExplorer<PlatformRow>
        title="Platforms"
        description="Persisted platform families, names, and qualification counts."
        endpoint="/api/v1/platforms"
        searchPlaceholder="Platform name"
        emptyTitle="No platforms recorded"
        emptyDescription="Platforms appear when taxonomy is imported or created from reviewed evidence."
        exportEntity="platforms"
        hrefFor={(row) => `/platforms/${row.id}`}
        columns={[
          { header: "Platform", cell: (row) => row.name },
          { header: "Type", cell: (row) => row.platformType ?? "Not recorded" },
          {
            header: "Manufacturer",
            cell: (row) => row.manufacturerName ?? "Unknown",
          },
          {
            header: "Variants",
            numeric: true,
            cell: (row) => row.variantCount.toLocaleString(),
          },
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
