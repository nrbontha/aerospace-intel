"use client";

import { Badge, EmptyState } from "@asi/ui";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { EntityResearchAction } from "@/components/entity-research-action";

type PlatformDetail = Readonly<{
  id: string;
  name: string;
  platformType: string | null;
  description: string | null;
  manufacturerCompanyId: string | null;
  manufacturerName: string | null;
  familyName: string | null;
  qualificationCount: number;
  variants: readonly {
    id: string;
    name: string;
    designation: string | null;
    enteredServiceOn: string | null;
    retiredOn: string | null;
  }[];
}>;

export default function PlatformProfilePage() {
  const params = useParams<{ id: string }>();
  const [platform, setPlatform] = useState<PlatformDetail>();
  const [canQueue, setCanQueue] = useState(false);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError(undefined);
      try {
        const [response, me] = await Promise.all([
          fetch(`/api/v1/platforms/${params.id}`, {
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
        if (!response.ok) throw new Error("Platform not found");
        setPlatform((payload as { data: PlatformDetail }).data);
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
        setError(caught instanceof Error ? caught.message : "Unable to load platform");
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

  if (loading) return <p className="asi-page-description" role="status">Loading platform…</p>;
  if (error || !platform) {
    return (
      <EmptyState
        title={error ?? "Platform not found"}
        action={<Link href="/platforms">Back to platforms</Link>}
      />
    );
  }

  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">
          <Link href="/platforms">Platforms</Link> / profile
        </p>
        <h1 className="asi-page-title">{platform.name}</h1>
        <p className="asi-page-description">
          {platform.description ?? "No platform description recorded."}
        </p>
        <div className="admin-actions">
          {platform.platformType ? <Badge tone="neutral">{platform.platformType}</Badge> : null}
          {platform.manufacturerCompanyId ? (
            <Link href={`/companies/${platform.manufacturerCompanyId}`}>
              {platform.manufacturerName ?? "Manufacturer"}
            </Link>
          ) : (
            <span>Manufacturer unknown</span>
          )}
        </div>
      </header>

      <EntityResearchAction
        targetType="platform"
        targetId={platform.id}
        targetName={platform.name}
        canQueue={canQueue}
      />

      <section className="admin-panel">
        <header className="admin-panel__header">
          <h2>Variants</h2>
        </header>
        {platform.variants.length === 0 ? (
          <p className="asi-page-description">No variants recorded.</p>
        ) : (
          <ul>
            {platform.variants.map((variant) => (
              <li key={variant.id}>
                <strong>{variant.name}</strong>
                {variant.designation ? ` (${variant.designation})` : ""} —{" "}
                {variant.enteredServiceOn ?? "entered unknown"} to{" "}
                {variant.retiredOn ?? "current or unknown"}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
