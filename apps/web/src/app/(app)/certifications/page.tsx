import { CatalogExplorer } from "@/components/catalog-explorer";

type CertificationRow = Readonly<{
  id: string;
  standard: string;
  certificateNumber: string | null;
  issuingBody: string | null;
  status: string;
  companyName: string | null;
  facilityName: string | null;
  expiresOn: string | null;
}>;

export default function CertificationsPage() {
  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">Evidence of process control</p>
        <h1 className="asi-page-title">Certifications</h1>
        <p className="asi-page-description">
          Certifications stay separate from qualifications. A certificate does
          not imply part, platform, or customer eligibility.
        </p>
      </header>
      <CatalogExplorer<CertificationRow>
        title="Certifications"
        description="Company or facility certificates with issuing body and validity when known."
        endpoint="/api/v1/certifications"
        searchPlaceholder="Standard, number, or issuer"
        emptyTitle="No certifications recorded"
        emptyDescription="Certificates appear after review or an authorized import."
        hrefFor={(row) => `/certifications/${row.id}`}
        columns={[
          { header: "Standard", cell: (row) => row.standard },
          { header: "Number", cell: (row) => row.certificateNumber ?? "Not recorded" },
          {
            header: "Holder",
            cell: (row) => row.facilityName ?? row.companyName ?? "Unknown",
          },
          { header: "Status", cell: (row) => row.status },
          { header: "Expires", cell: (row) => row.expiresOn ?? "Open or unknown" },
        ]}
      />
    </>
  );
}
