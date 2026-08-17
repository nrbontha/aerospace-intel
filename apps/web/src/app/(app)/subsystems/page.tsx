import { CatalogExplorer } from "@/components/catalog-explorer";

type SubsystemRow = Readonly<{
  id: string;
  name: string;
  code: string | null;
  parentName: string | null;
  qualificationCount: number;
}>;

export default function SubsystemsPage() {
  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">Known entities</p>
        <h1 className="asi-page-title">Subsystems</h1>
        <p className="asi-page-description">
          Subsystems scope qualifications. A platform family is not a
          qualification, and a missing subsystem stays visible as unknown.
        </p>
      </header>
      <CatalogExplorer<SubsystemRow>
        title="Subsystems"
        description="Named subsystems referenced by facility qualifications."
        endpoint="/api/v1/subsystems"
        searchPlaceholder="Subsystem name or code"
        emptyTitle="No subsystems recorded"
        emptyDescription="Subsystems appear when a qualification records one or an authorized import lands."
        hrefFor={(row) => `/subsystems/${row.id}`}
        columns={[
          { header: "Subsystem", cell: (row) => row.name },
          { header: "Code", cell: (row) => row.code ?? "Not recorded" },
          { header: "Parent", cell: (row) => row.parentName ?? "None" },
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
