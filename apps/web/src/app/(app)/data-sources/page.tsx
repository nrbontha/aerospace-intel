import Link from "next/link";
import { Suspense } from "react";

import { CatalogExport } from "@/components/catalog-export";
import { DataSourceExplorer } from "@/components/data-source-explorer";

export default function DataSourcesPage() {
  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">Evidence operations</p>
        <h1 className="asi-page-title">Data sources</h1>
        <p className="asi-page-description">
          Register where evidence originates, how it may be accessed, and how it
          can be ingested. Sources remain valid with zero company links.
        </p>
        <div className="admin-actions">
          <CatalogExport entity="data_sources" />
          <Link
            className="asi-button"
            data-size="medium"
            data-variant="primary"
            href="/data-sources/new"
          >
            Add source
          </Link>
        </div>
      </header>
      <Suspense
        fallback={
          <div className="admin-panel" role="status">
            Loading source filters…
          </div>
        }
      >
        <DataSourceExplorer />
      </Suspense>
    </>
  );
}
