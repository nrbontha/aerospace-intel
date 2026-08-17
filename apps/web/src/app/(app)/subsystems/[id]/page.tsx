"use client";

import { EmptyState, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@asi/ui";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

type SubsystemDetail = Readonly<{
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  parentId: string | null;
  parentName: string | null;
  qualificationCount: number;
  qualifications: readonly {
    id: string;
    facilityId: string;
    facilityName: string | null;
    partId: string;
    partNumber: string | null;
    platformId: string | null;
    customerCompanyId: string | null;
    customerName: string | null;
    scarcity: string;
    validFrom: string | null;
    validTo: string | null;
  }[];
}>;

function label(value: string) {
  return value.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

export default function SubsystemProfilePage() {
  const params = useParams<{ id: string }>();
  const [record, setRecord] = useState<SubsystemDetail>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        const response = await fetch(`/api/v1/subsystems/${params.id}`, {
          cache: "no-store",
          credentials: "same-origin",
          signal,
        });
        const payload = (await response.json()) as { data?: SubsystemDetail; error?: { message?: string } };
        if (!response.ok || !payload.data) {
          throw new Error(payload.error?.message ?? `Unable to load subsystem (${response.status})`);
        }
        if (!signal.aborted) setRecord(payload.data);
      } catch (caught) {
        if (!signal.aborted) {
          setError(caught instanceof Error ? caught.message : "Unable to load subsystem");
        }
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [params.id],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (loading) return <p className="asi-page-description" role="status">Loading subsystem…</p>;
  if (error || !record) {
    return (
      <EmptyState
        title="Subsystem not found"
        description={error ?? "This subsystem is not in the catalog."}
      />
    );
  }

  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">
          <Link href="/subsystems">Subsystems</Link> / profile
        </p>
        <h1 className="asi-page-title">{record.name}</h1>
        <p className="asi-page-description">
          {record.description ?? "No subsystem description has been recorded."}
        </p>
      </header>
      <dl className="asi-definition-list">
        <div>
          <dt>Code</dt>
          <dd>{record.code ?? "Not recorded"}</dd>
        </div>
        <div>
          <dt>Parent</dt>
          <dd>
            {record.parentId && record.parentName ? (
              <Link href={`/subsystems/${record.parentId}`}>{record.parentName}</Link>
            ) : (
              "None"
            )}
          </dd>
        </div>
        <div>
          <dt>Qualifications</dt>
          <dd>{record.qualificationCount.toLocaleString()}</dd>
        </div>
      </dl>
      <section className="admin-panel" aria-labelledby="subsystem-qualifications">
        <header className="admin-panel__header">
          <h2 id="subsystem-qualifications">Qualifications</h2>
        </header>
        {record.qualifications.length === 0 ? (
          <EmptyState
            title="No qualifications scoped here"
            description="A subsystem without qualifications is still a catalog record, not an eligibility claim."
          />
        ) : (
          <Table>
            <TableCaption>Facility qualifications that name this subsystem.</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Facility</TableHead>
                <TableHead>Part</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Scarcity</TableHead>
                <TableHead>Valid</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {record.qualifications.map((qualification) => (
                <TableRow key={qualification.id}>
                  <TableCell>
                    <Link href={`/facilities/${qualification.facilityId}`}>
                      {qualification.facilityName ?? qualification.facilityId}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link href={`/parts/${qualification.partId}`}>
                      {qualification.partNumber ?? qualification.partId}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {qualification.customerCompanyId ? (
                      <Link href={`/customers/${qualification.customerCompanyId}`}>
                        {qualification.customerName ?? "Customer"}
                      </Link>
                    ) : (
                      "Unknown"
                    )}
                  </TableCell>
                  <TableCell>{label(qualification.scarcity)}</TableCell>
                  <TableCell>
                    {[qualification.validFrom, qualification.validTo].filter(Boolean).join(" – ") ||
                      "Not recorded"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </>
  );
}
