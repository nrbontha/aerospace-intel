import { CatalogExplorer } from "@/components/catalog-explorer";
type CapabilityRow = Readonly<{
  id: string;
  code: string;
  name: string;
  companyCount: number;
  facilityCount: number;
}>;

export default function CapabilitiesPage() {
  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">Taxonomy</p>
        <h1 className="asi-page-title">Capabilities</h1>
        <p className="asi-page-description">
          Process and manufacturing capabilities are not qualifications and are
          not treated as platform or part eligibility.
        </p>
      </header>
      <CatalogExplorer<CapabilityRow>
        title="Capability taxonomy"
        description="Named capabilities linked to companies or facilities."
        endpoint="/api/v1/capabilities"
        searchPlaceholder="Capability name or code"
        emptyTitle="No capabilities recorded"
        emptyDescription="Capabilities appear when research or an authorized import records them."
        hrefFor={(row) => `/capabilities/${row.id}`}
        columns={[
          { header: "Capability", cell: (row) => row.name },
          { header: "Code", cell: (row) => row.code },
          {
            header: "Companies",
            numeric: true,
            cell: (row) => row.companyCount.toLocaleString(),
          },
          {
            header: "Facilities",
            numeric: true,
            cell: (row) => row.facilityCount.toLocaleString(),
          },
        ]}
      />
    </>
  );
}
