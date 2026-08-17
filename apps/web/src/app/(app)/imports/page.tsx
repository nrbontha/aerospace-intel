import { CatalogExplorer } from "@/components/catalog-explorer";
import { ImportUpload } from "@/components/import-upload";
import { requireUser } from "@/lib/auth";

type ImportRow = Readonly<{
  id: string;
  fileName: string;
  status: string;
  rowCount: number | null;
  importedCount: number;
  rejectedCount: number;
  createdAt: string;
}>;

export default async function ImportsPage() {
  const user = await requireUser();
  const canImport = user.role === "analyst" || user.role === "admin";

  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">Ingestion</p>
        <h1 className="asi-page-title">Imports</h1>
        <p className="asi-page-description">
          Durable import batches and row outcomes. This list reflects persisted
          import records only; it does not imply a file was searched or
          accepted.
        </p>
      </header>
      <ImportUpload canImport={canImport} />
      <CatalogExplorer<ImportRow>
        title="Import batches"
        description="Queued, validated, and completed import jobs stored in PostgreSQL."
        endpoint="/api/v1/imports"
        searchPlaceholder="File name"
        emptyTitle="No import batches"
        emptyDescription="Authorized imports appear here after a batch is stored with a content digest."
        hrefFor={(row) => `/imports/${row.id}`}
        columns={[
          { header: "File", cell: (row) => row.fileName },
          { header: "Status", cell: (row) => row.status },
          {
            header: "Rows",
            numeric: true,
            cell: (row) => (row.rowCount ?? 0).toLocaleString(),
          },
          {
            header: "Accepted",
            numeric: true,
            cell: (row) => row.importedCount.toLocaleString(),
          },
          {
            header: "Rejected",
            numeric: true,
            cell: (row) => row.rejectedCount.toLocaleString(),
          },
        ]}
      />
    </>
  );
}
