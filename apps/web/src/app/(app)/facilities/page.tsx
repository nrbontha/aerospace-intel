import { CatalogExplorer } from "@/components/catalog-explorer";

type FacilityRow = Readonly<{
  id: string;
  name: string;
  companyName: string | null;
  city: string | null;
  countryCode: string;
  status: string;
  qualificationCount: number;
}>;

export default function FacilitiesPage() {
  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">Known entities</p>
        <h1 className="asi-page-title">Facilities</h1>
        <p className="asi-page-description">
          Facility records stay scoped to a company when known. Qualifications
          attached here are not implied by company-wide certifications.
        </p>
      </header>
      <CatalogExplorer<FacilityRow>
        title="Facilities"
        description="Persisted manufacturing and operating sites."
        endpoint="/api/v1/facilities"
        searchPlaceholder="Facility or city"
        emptyTitle="No facilities recorded"
        emptyDescription="Facilities appear after research proposals are accepted or an authorized import lands."
        exportEntity="facilities"
        hrefFor={(row) => `/facilities/${row.id}`}
        columns={[
          { header: "Facility", cell: (row) => row.name },
          { header: "Company", cell: (row) => row.companyName ?? "Unlinked" },
          {
            header: "Location",
            cell: (row) =>
              [row.city, row.countryCode].filter(Boolean).join(", ") ||
              "Not recorded",
          },
          { header: "Status", cell: (row) => row.status },
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
