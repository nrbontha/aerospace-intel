"use client";

import { Badge, EmptyState } from "@asi/ui";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { EntityResearchAction } from "@/components/entity-research-action";

type PartDetail = Readonly<{
  id: string;
  partNumber: string;
  name: string | null;
  description: string | null;
  lifecycleStatus: string;
  manufacturerCompanyId: string | null;
  manufacturerName: string | null;
  qualifications: readonly {
    id: string;
    facilityId: string;
    facilityName: string;
    platformId: string | null;
    platformName: string | null;
    customerName: string | null;
    scarcity: string;
    validFrom: string | null;
    validTo: string | null;
  }[];
}>;

function label(value: string) {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export default function PartProfilePage() {
  const params = useParams<{ id: string }>();
  const [part, setPart] = useState<PartDetail>();
  const [canQueue, setCanQueue] = useState(false);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError(undefined);
      try {
        const [response, me] = await Promise.all([
          fetch(`/api/v1/parts/${params.id}`, {
            cache: "no-store",
            credentials: "same-origin",
            signal,
          }),
          fetch("/api/v1/auth/me", {
            cache: "no-store",
            credentials: "same-origin",
            signal,
          }),
        ]);
        const payload: unknown = await response.json();
        if (!response.ok) throw new Error("Part not found");
        setPart((payload as { data: PartDetail }).data);
        if (me.ok) {
          const mePayload: unknown = await me.json();
          const role =
            typeof mePayload === "object" &&
            mePayload !== null &&
            "data" in mePayload &&
            typeof mePayload.data === "object" &&
            mePayload.data !== null &&
            "user" in mePayload.data &&
            typeof mePayload.data.user === "object" &&
            mePayload.data.user !== null &&
            "role" in mePayload.data.user &&
            typeof mePayload.data.user.role === "string"
              ? mePayload.data.user.role
              : undefined;
          setCanQueue(role === "admin" || role === "analyst");
        }
      } catch (caught) {
        if (signal.aborted) return;
        setError(caught instanceof Error ? caught.message : "Unable to load part");
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

  if (loading) return <p className="asi-page-description" role="status">Loading part…</p>;
  if (error || !part) {
    return (
      <EmptyState
        title={error ?? "Part not found"}
        action={<Link href="/parts">Back to parts</Link>}
      />
    );
  }

  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">
          <Link href="/parts">Parts</Link> / profile
        </p>
        <h1 className="asi-page-title">{part.partNumber}</h1>
        <p className="asi-page-description">
          {part.name ?? part.description ?? "No part name recorded."}
        </p>
        <div className="admin-actions">
          <Badge tone="neutral">{label(part.lifecycleStatus)}</Badge>
          {part.manufacturerCompanyId ? (
            <Link href={`/companies/${part.manufacturerCompanyId}`}>
              {part.manufacturerName ?? "Manufacturer"}
            </Link>
          ) : null}
        </div>
      </header>

      <EntityResearchAction
        targetType="part"
        targetId={part.id}
        targetName={part.name ?? part.partNumber}
        canQueue={canQueue}
      />

      <section className="admin-panel">
        <header className="admin-panel__header">
          <h2>Facility qualifications</h2>
          <p className="asi-page-description">
            Each row is Facility × Part × Platform/Customer/Time where known.
          </p>
        </header>
        {part.qualifications.length === 0 ? (
          <p className="asi-page-description">No qualifications recorded for this part.</p>
        ) : (
          <ul>
            {part.qualifications.map((qualification) => (
              <li key={qualification.id}>
                <Link href={`/facilities/${qualification.facilityId}`}>
                  {qualification.facilityName}
                </Link>
                {" · "}
                {qualification.platformName ?? "platform unknown"}
                {" · "}
                {label(qualification.scarcity)}
                {" · "}
                {qualification.validFrom ?? "open"}–{qualification.validTo ?? "open"}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
