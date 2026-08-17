"use client";

import { Badge, EmptyState, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@asi/ui";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

type FacilityDetail = Readonly<{
  id: string;
  name: string;
  companyId: string | null;
  companyName: string | null;
  facilityType: string | null;
  city: string | null;
  region: string | null;
  countryCode: string;
  status: string;
  addressLine1: string | null;
  postalCode: string | null;
  capabilities: readonly {
    id: string;
    name: string;
    code: string;
    status: string;
    confidence: string | null;
  }[];
  qualifications: readonly {
    id: string;
    partId: string;
    partNumber: string;
    platformId: string | null;
    platformName: string | null;
    customerName: string | null;
    scarcity: string;
    validFrom: string | null;
    validTo: string | null;
  }[];
}>;

function label(value: string) {
  return value.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

export default function FacilityProfilePage() {
  const params = useParams<{ id: string }>();
  const [facility, setFacility] = useState<FacilityDetail>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/v1/facilities/${params.id}`, {
        cache: "no-store",
        credentials: "same-origin",
        signal,
      });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error("Facility not found");
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("data" in payload)
      ) {
        throw new Error("Invalid facility response");
      }
      setFacility((payload as { data: FacilityDetail }).data);
    } catch (caught) {
      if (signal.aborted) return;
      setError(caught instanceof Error ? caught.message : "Unable to load facility");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [params.id]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (loading) return <p className="asi-page-description" role="status">Loading facility…</p>;
  if (error || !facility) {
    return (
      <EmptyState
        title={error ?? "Facility not found"}
        description="The facility repository did not return this record."
        action={<Link href="/facilities">Back to facilities</Link>}
      />
    );
  }

  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">
          <Link href="/facilities">Facilities</Link> / profile
        </p>
        <h1 className="asi-page-title">{facility.name}</h1>
        <p className="asi-page-description">
          {[facility.city, facility.region, facility.countryCode]
            .filter(Boolean)
            .join(", ") || "Location not recorded"}
        </p>
        <div className="admin-actions">
          <Badge tone={facility.status === "active" ? "success" : "neutral"}>
            {label(facility.status)}
          </Badge>
          {facility.companyId ? (
            <Link href={`/companies/${facility.companyId}`}>
              {facility.companyName ?? "Owning company"}
            </Link>
          ) : (
            <span>No owning company linked</span>
          )}
        </div>
      </header>

      <section className="admin-panel" aria-labelledby="capabilities-heading">
        <header className="admin-panel__header">
          <h2 id="capabilities-heading">Capabilities</h2>
          <p className="asi-page-description">
            Facility capabilities are not qualifications.
          </p>
        </header>
        {facility.capabilities.length === 0 ? (
          <p className="asi-page-description">No facility capabilities recorded.</p>
        ) : (
          <ul>
            {facility.capabilities.map((capability) => (
              <li key={capability.id}>
                <strong>{capability.name}</strong> ({capability.code}) — {label(capability.status)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="admin-panel" aria-labelledby="qualifications-heading">
        <header className="admin-panel__header">
          <h2 id="qualifications-heading">Qualifications</h2>
          <p className="asi-page-description">
            Scarcity defaults to not assessed. Missing platform, customer, or
            time bounds remain unknown.
          </p>
        </header>
        {facility.qualifications.length === 0 ? (
          <EmptyState
            title="No qualifications recorded"
            description="A facility capability or certification does not prove a part/platform qualification."
          />
        ) : (
          <Table>
            <TableCaption>
              {facility.qualifications.length} scoped qualification
              {facility.qualifications.length === 1 ? "" : "s"}
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Part</TableHead>
                <TableHead>Platform</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Scarcity</TableHead>
                <TableHead>Effective</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {facility.qualifications.map((qualification) => (
                <TableRow key={qualification.id}>
                  <TableCell>
                    <Link href={`/parts/${qualification.partId}`}>
                      {qualification.partNumber}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {qualification.platformId ? (
                      <Link href={`/platforms/${qualification.platformId}`}>
                        {qualification.platformName}
                      </Link>
                    ) : (
                      "Unknown"
                    )}
                  </TableCell>
                  <TableCell>{qualification.customerName ?? "Unknown"}</TableCell>
                  <TableCell>
                    <Badge
                      tone={
                        qualification.scarcity === "not_assessed"
                          ? "neutral"
                          : qualification.scarcity === "unverified_company_claim"
                            ? "warning"
                            : "info"
                      }
                    >
                      {label(qualification.scarcity)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {qualification.validFrom ?? "Open"} — {qualification.validTo ?? "Open"}
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
