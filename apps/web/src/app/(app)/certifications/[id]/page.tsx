"use client";

import { Badge, EmptyState } from "@asi/ui";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

type CertificationDetail = Readonly<{
  id: string;
  standard: string;
  certificateNumber: string | null;
  issuingBody: string | null;
  status: string;
  issuedOn: string | null;
  expiresOn: string | null;
  companyId: string | null;
  companyName: string | null;
  facilityId: string | null;
  facilityName: string | null;
}>;

export default function CertificationProfilePage() {
  const params = useParams<{ id: string }>();
  const [record, setRecord] = useState<CertificationDetail>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        const response = await fetch(`/api/v1/certifications/${params.id}`, {
          cache: "no-store",
          credentials: "same-origin",
          signal,
        });
        const payload: unknown = await response.json();
        if (!response.ok) throw new Error("Certification not found");
        setRecord((payload as { data: CertificationDetail }).data);
      } catch (caught) {
        if (signal.aborted) return;
        setError(
          caught instanceof Error ? caught.message : "Unable to load certification",
        );
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

  if (loading) {
    return <p className="asi-page-description" role="status">Loading certification…</p>;
  }
  if (error || !record) {
    return (
      <EmptyState
        title={error ?? "Certification not found"}
        action={<Link href="/certifications">Back to certifications</Link>}
      />
    );
  }

  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">
          <Link href="/certifications">Certifications</Link> / profile
        </p>
        <h1 className="asi-page-title">{record.standard}</h1>
        <Badge tone={record.status === "active" ? "success" : "neutral"}>
          {record.status}
        </Badge>
      </header>
      <section className="admin-panel">
        <dl>
          <dt>Certificate number</dt>
          <dd>{record.certificateNumber ?? "Not recorded"}</dd>
          <dt>Issuing body</dt>
          <dd>{record.issuingBody ?? "Not recorded"}</dd>
          <dt>Company</dt>
          <dd>
            {record.companyId ? (
              <Link href={`/companies/${record.companyId}`}>
                {record.companyName ?? "Company"}
              </Link>
            ) : (
              "Not a company certificate"
            )}
          </dd>
          <dt>Facility</dt>
          <dd>
            {record.facilityId ? (
              <Link href={`/facilities/${record.facilityId}`}>
                {record.facilityName ?? "Facility"}
              </Link>
            ) : (
              "Not a facility certificate"
            )}
          </dd>
          <dt>Issued</dt>
          <dd>{record.issuedOn ?? "Unknown"}</dd>
          <dt>Expires</dt>
          <dd>{record.expiresOn ?? "Open or unknown"}</dd>
        </dl>
      </section>
    </>
  );
}
