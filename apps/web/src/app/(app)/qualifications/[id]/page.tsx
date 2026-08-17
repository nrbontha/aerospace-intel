"use client";

import { Badge, EmptyState } from "@asi/ui";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

type QualificationDetail = Readonly<{
  id: string;
  facilityId: string;
  facilityName: string;
  companyId: string | null;
  companyName: string | null;
  partId: string;
  partNumber: string;
  partName: string | null;
  platformId: string | null;
  platformName: string | null;
  platformVariantName: string | null;
  subsystemName: string | null;
  customerCompanyId: string | null;
  customerName: string | null;
  qualificationReference: string | null;
  scarcity: string;
  validFrom: string | null;
  validTo: string | null;
  confidence: string | null;
}>;

function label(value: string) {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export default function QualificationProfilePage() {
  const params = useParams<{ id: string }>();
  const [record, setRecord] = useState<QualificationDetail>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      try {
        const response = await fetch(`/api/v1/qualifications/${params.id}`, {
          cache: "no-store",
          credentials: "same-origin",
          signal,
        });
        const payload: unknown = await response.json();
        if (!response.ok) throw new Error("Qualification not found");
        setRecord((payload as { data: QualificationDetail }).data);
      } catch (caught) {
        if (signal.aborted) return;
        setError(caught instanceof Error ? caught.message : "Unable to load qualification");
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

  if (loading) return <p className="asi-page-description" role="status">Loading qualification…</p>;
  if (error || !record) {
    return (
      <EmptyState
        title={error ?? "Qualification not found"}
        action={<Link href="/qualifications">Back to qualifications</Link>}
      />
    );
  }

  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">
          <Link href="/qualifications">Qualifications</Link> / profile
        </p>
        <h1 className="asi-page-title">
          {record.facilityName} / {record.partNumber}
        </h1>
        <p className="asi-page-description">
          Scope remains visible even when a dimension is unknown.
        </p>
        <Badge
          tone={
            record.scarcity === "not_assessed"
              ? "neutral"
              : record.scarcity === "unverified_company_claim"
                ? "warning"
                : "info"
          }
        >
          {label(record.scarcity)}
        </Badge>
      </header>
      <section className="admin-panel">
        <dl>
          <dt>Facility</dt>
          <dd>
            <Link href={`/facilities/${record.facilityId}`}>{record.facilityName}</Link>
          </dd>
          <dt>Company</dt>
          <dd>
            {record.companyId ? (
              <Link href={`/companies/${record.companyId}`}>
                {record.companyName ?? "Company"}
              </Link>
            ) : (
              "Unknown"
            )}
          </dd>
          <dt>Part</dt>
          <dd>
            <Link href={`/parts/${record.partId}`}>
              {record.partNumber}
              {record.partName ? ` — ${record.partName}` : ""}
            </Link>
          </dd>
          <dt>Platform</dt>
          <dd>
            {record.platformId ? (
              <Link href={`/platforms/${record.platformId}`}>
                {record.platformName}
                {record.platformVariantName ? ` / ${record.platformVariantName}` : ""}
              </Link>
            ) : (
              "Unknown"
            )}
          </dd>
          <dt>Subsystem</dt>
          <dd>{record.subsystemName ?? "Unknown"}</dd>
          <dt>Customer</dt>
          <dd>
            {record.customerCompanyId ? (
              <Link href={`/companies/${record.customerCompanyId}`}>
                {record.customerName ?? "Customer"}
              </Link>
            ) : (
              "Unknown"
            )}
          </dd>
          <dt>Effective window</dt>
          <dd>
            {record.validFrom ?? "Open"} – {record.validTo ?? "Open"}
          </dd>
          <dt>Reference</dt>
          <dd>{record.qualificationReference ?? "Not recorded"}</dd>
          <dt>Confidence</dt>
          <dd>{record.confidence ?? "Not assessed"}</dd>
        </dl>
      </section>
    </>
  );
}
