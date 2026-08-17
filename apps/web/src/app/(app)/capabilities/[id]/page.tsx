"use client";

import { EmptyState } from "@asi/ui";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

type CapabilityDetail = Readonly<{
  id: string;
  code: string;
  name: string;
  description: string | null;
  companies: readonly { id: string; name: string; status: string }[];
  facilities: readonly { id: string; name: string; status: string }[];
}>;

export default function CapabilityProfilePage() {
  const params = useParams<{ id: string }>();
  const [record, setRecord] = useState<CapabilityDetail>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        const response = await fetch(`/api/v1/capabilities/${params.id}`, {
          cache: "no-store",
          credentials: "same-origin",
          signal,
        });
        const payload: unknown = await response.json();
        if (!response.ok) throw new Error("Capability not found");
        setRecord((payload as { data: CapabilityDetail }).data);
      } catch (caught) {
        if (signal.aborted) return;
        setError(caught instanceof Error ? caught.message : "Unable to load capability");
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

  if (loading) return <p className="asi-page-description" role="status">Loading capability…</p>;
  if (error || !record) {
    return (
      <EmptyState
        title={error ?? "Capability not found"}
        action={<Link href="/capabilities">Back to capabilities</Link>}
      />
    );
  }

  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">
          <Link href="/capabilities">Capabilities</Link> / profile
        </p>
        <h1 className="asi-page-title">{record.name}</h1>
        <p className="asi-page-description">{record.description ?? record.code}</p>
      </header>
      <section className="admin-panel">
        <h2>Companies</h2>
        {record.companies.length === 0 ? (
          <p className="asi-page-description">No company links recorded.</p>
        ) : (
          <ul>
            {record.companies.map((company) => (
              <li key={company.id}>
                <Link href={`/companies/${company.id}`}>{company.name}</Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="admin-panel">
        <h2>Facilities</h2>
        {record.facilities.length === 0 ? (
          <p className="asi-page-description">No facility links recorded.</p>
        ) : (
          <ul>
            {record.facilities.map((facility) => (
              <li key={facility.id}>
                <Link href={`/facilities/${facility.id}`}>{facility.name}</Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
