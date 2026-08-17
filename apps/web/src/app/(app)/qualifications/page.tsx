import { CatalogExplorer } from "@/components/catalog-explorer";

type QualificationRow = Readonly<{
  id: string;
  facilityName: string;
  companyName: string | null;
  partNumber: string;
  platformName: string | null;
  customerName: string | null;
  scarcity: string;
  validFrom: string | null;
  validTo: string | null;
}>;

function label(value: string) {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export default function QualificationsPage() {
  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">Evidence-scoped relationships</p>
        <h1 className="asi-page-title">Qualifications</h1>
        <p className="asi-page-description">
          Qualification granularity is Facility × Part × Platform/Variant ×
          Subsystem × Customer × Time where known. Default scarcity is not
          assessed.
        </p>
      </header>
      <CatalogExplorer<QualificationRow>
        title="Qualifications"
        description="Persisted scoped qualifications. Missing dimensions stay visible as unknown."
        endpoint="/api/v1/qualifications"
        searchPlaceholder="Facility, part, or platform"
        emptyTitle="No qualifications recorded"
        emptyDescription="Qualifications are created from reviewed evidence, never inferred from certifications."
        exportEntity="qualifications"
        hrefFor={(row) => `/qualifications/${row.id}`}
        columns={[
          { header: "Facility", cell: (row) => row.facilityName },
          { header: "Part", cell: (row) => row.partNumber },
          { header: "Platform", cell: (row) => row.platformName ?? "Unknown" },
          { header: "Customer", cell: (row) => row.customerName ?? "Unknown" },
          { header: "Scarcity", cell: (row) => label(row.scarcity) },
          {
            header: "Effective",
            cell: (row) => `${row.validFrom ?? "Open"} – ${row.validTo ?? "Open"}`,
          },
        ]}
      />
    </>
  );
}
