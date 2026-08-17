import { CatalogExport } from "@/components/catalog-export";
import { CompanyExplorer } from "@/components/company-explorer";

export default function CompaniesPage() {
  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">Known entities</p>
        <h1 className="asi-page-title">Companies</h1>
        <p className="asi-page-description">
          Find supplier entities created by research and inspect how source
          evidence becomes reviewed canonical intelligence.
        </p>
      </header>

      <CatalogExport entity="companies" />
      <CompanyExplorer />
    </>
  );
}
