import { CatalogExplorer } from "@/components/catalog-explorer";

type CustomerRow = Readonly<{
  id: string;
  displayName: string;
  legalName: string;
  headquartersCountryCode: string | null;
  qualificationCount: number;
  contractCount: number;
}>;

export default function CustomersPage() {
  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">Known entities</p>
        <h1 className="asi-page-title">Customers</h1>
        <p className="asi-page-description">
          Customers are companies that appear as the buyer on a qualification or
          contract. Company identity stays on the company profile.
        </p>
      </header>
      <CatalogExplorer<CustomerRow>
        title="Customers"
        description="Companies in a customer role, not a separate canonical entity type."
        endpoint="/api/v1/customers"
        searchPlaceholder="Customer name"
        emptyTitle="No customers recorded"
        emptyDescription="Customers appear when a qualification or contract names a buying company."
        hrefFor={(row) => `/customers/${row.id}`}
        columns={[
          { header: "Customer", cell: (row) => row.displayName },
          { header: "Legal name", cell: (row) => row.legalName },
          {
            header: "Country",
            cell: (row) => row.headquartersCountryCode ?? "Not recorded",
          },
          {
            header: "Qualifications",
            numeric: true,
            cell: (row) => row.qualificationCount.toLocaleString(),
          },
          {
            header: "Contracts",
            numeric: true,
            cell: (row) => row.contractCount.toLocaleString(),
          },
        ]}
      />
    </>
  );
}
