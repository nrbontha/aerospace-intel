"use client";

import { EmptyState, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@asi/ui";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

type CustomerDetail = Readonly<{
  id: string;
  displayName: string;
  legalName: string;
  description: string | null;
  headquartersCountryCode: string | null;
  websiteUrl: string | null;
  qualificationCount: number;
  contractCount: number;
  qualifications: readonly {
    id: string;
    facilityId: string;
    facilityName: string | null;
    partId: string;
    partNumber: string | null;
    platformId: string | null;
    subsystemId: string | null;
    subsystemName: string | null;
    scarcity: string;
    validFrom: string | null;
    validTo: string | null;
  }[];
  awardedContracts: readonly {
    id: string;
    contractNumber: string;
    title: string | null;
    supplierCompanyId: string | null;
    supplierName: string | null;
    status: string;
    startDate: string | null;
    endDate: string | null;
  }[];
}>;

function label(value: string) {
  return value.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

export default function CustomerProfilePage() {
  const params = useParams<{ id: string }>();
  const [record, setRecord] = useState<CustomerDetail>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        const response = await fetch(`/api/v1/customers/${params.id}`, {
          cache: "no-store",
          credentials: "same-origin",
          signal,
        });
        const payload = (await response.json()) as {
          data?: CustomerDetail;
          error?: { message?: string };
        };
        if (!response.ok || !payload.data) {
          throw new Error(payload.error?.message ?? `Unable to load customer (${response.status})`);
        }
        if (!signal.aborted) setRecord(payload.data);
      } catch (caught) {
        if (!signal.aborted) {
          setError(caught instanceof Error ? caught.message : "Unable to load customer");
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

  if (loading) return <p className="asi-page-description" role="status">Loading customer…</p>;
  if (error || !record) {
    return (
      <EmptyState
        title="Customer not found"
        description={error ?? "This company has no recorded customer role."}
      />
    );
  }

  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">
          <Link href="/customers">Customers</Link> / profile
        </p>
        <h1 className="asi-page-title">{record.displayName}</h1>
        <p className="asi-page-description">
          {record.description ?? "No customer description has been recorded."}
        </p>
        <p>
          <Link href={`/companies/${record.id}`}>Open company profile</Link>
        </p>
      </header>
      <section className="admin-panel" aria-labelledby="customer-qualifications">
        <header className="admin-panel__header">
          <h2 id="customer-qualifications">Qualifications as customer</h2>
        </header>
        {record.qualifications.length === 0 ? (
          <EmptyState
            title="No customer-scoped qualifications"
            description="A missing customer dimension stays unknown; it is not inferred from a contract."
          />
        ) : (
          <Table>
            <TableCaption>Qualifications that name this company as the customer.</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Facility</TableHead>
                <TableHead>Part</TableHead>
                <TableHead>Subsystem</TableHead>
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
                    {qualification.subsystemId ? (
                      <Link href={`/subsystems/${qualification.subsystemId}`}>
                        {qualification.subsystemName ?? "Subsystem"}
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
      <section className="admin-panel" aria-labelledby="customer-contracts">
        <header className="admin-panel__header">
          <h2 id="customer-contracts">Awarded contracts</h2>
        </header>
        {record.awardedContracts.length === 0 ? (
          <EmptyState
            title="No contracts recorded"
            description="Contracts are independent of qualifications and do not prove part eligibility."
          />
        ) : (
          <Table>
            <TableCaption>Contracts that name this company as the customer.</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Contract</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Dates</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {record.awardedContracts.map((contract) => (
                <TableRow key={contract.id}>
                  <TableCell>
                    {contract.title
                      ? `${contract.contractNumber} — ${contract.title}`
                      : contract.contractNumber}
                  </TableCell>
                  <TableCell>
                    {contract.supplierCompanyId ? (
                      <Link href={`/companies/${contract.supplierCompanyId}`}>
                        {contract.supplierName ?? "Supplier"}
                      </Link>
                    ) : (
                      "Unknown"
                    )}
                  </TableCell>
                  <TableCell>{label(contract.status)}</TableCell>
                  <TableCell>
                    {[contract.startDate, contract.endDate].filter(Boolean).join(" – ") ||
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
