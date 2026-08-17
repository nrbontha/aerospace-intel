"use client";

import type { CompanyStatus } from "@asi/contracts";
import {
  Badge,
  Button,
  EmptyState,
  EvidenceConfidence,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@asi/ui";
import Link from "next/link";

import { CompanyAliasAction } from "@/components/company-alias-action";
import { CompanyMergeAction } from "@/components/company-merge-action";
import { CompanyResearchAction } from "@/components/company-research-action";
import { ScorecardPanel, type Scorecard } from "@/components/scorecard-panel";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

type Domain = Readonly<{
  id: string;
  domain: string;
  isPrimary: boolean;
  verifiedAt: string | null;
}>;
type Identifier = Readonly<{
  id: string;
  type: string;
  value: string;
  issuingCountryCode: string | null;
}>;
type LinkedSource = Readonly<{
  dataSourceId: string;
  name: string;
  description: string | null;
  homepageUrl: string | null;
  access: string;
  ingestionMethod: string;
  status: string;
  relationship: string;
  externalKey: string | null;
}>;
type Observation = Readonly<{
  id: string;
  fieldKey: string;
  valueKind: string;
  value: unknown;
  normalizedText: string | null;
  unit: string | null;
  validFrom: string | null;
  validTo: string | null;
  observedAt: string;
  confidence: number | string;
  reviewStatus: string;
  conflictStatus: string;
  evidenceId: string;
  evidenceQuote: string | null;
  evidenceLocator: string | null;
  evidencePageNumber: number | null;
  documentId: string;
  documentTitle: string;
  documentCanonicalUrl: string | null;
  dataSourceId: string;
  dataSourceName: string;
  isCanonical: boolean;
  createdAt?: string;
  canonicalFactId?: string;
  acceptedProposalId?: string;
  reviewEventId?: string;
  reviewDecision?: string;
  reviewReason?: string;
  reviewedAt?: string;
}>;
type CompanyDetail = Readonly<{
  id: string;
  legalName: string;
  displayName: string;
  commonName: string | null;
  description: string | null;
  status: CompanyStatus;
  headquartersCountryCode: string | null;
  headquartersCountry: string | null;
  websiteUrl: string | null;
  foundedYear: number | null;
  createdAt: string;
  updatedAt: string;
  sourceCount: number;
  evidenceCount: number;
  observationCount: number;
  canonicalFactCount: number;
  pendingProposalCount: number;
  domains: Domain[];
  identifiers: Identifier[];
  linkedSources: LinkedSource[];
  observations: Observation[];
  researchGaps: string[];
  aliases?: readonly {
    id: string;
    alias: string;
    aliasType: string;
    isPrimary: boolean;
  }[];
  contacts?: readonly {
    id: string;
    fullName: string;
    title: string | null;
    email: string | null;
    verificationStatus: string;
  }[];
  capabilities?: readonly {
    id: string;
    name?: string;
    code?: string;
    status: string;
  }[];
  certifications?: readonly {
    id: string;
    standard: string;
    certificateNumber: string | null;
    issuingBody: string | null;
    status: string;
    issuedOn: string | null;
    expiresOn: string | null;
    facilityId: string | null;
    facilityName?: string | null;
  }[];
  facilities?: readonly {
    id: string;
    name: string;
    city: string | null;
    countryCode: string;
    status: string;
  }[];
  qualificationLinks?: readonly {
    qualification: {
      id: string;
      partId: string;
      platformId: string | null;
      scarcity: string;
      validFrom: string | null;
      validTo: string | null;
    };
    facility: { id: string; name: string };
  }[];
  scorecard?: Scorecard | null;
}>;
type Envelope = Readonly<{ data: CompanyDetail }>;

function label(value: string) {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
function displayValue(value: unknown) {
  if (value === null || value === undefined) return "Not recorded";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "Structured value";
  }
}
function errorMessage(payload: unknown, status: number) {
  if (typeof payload === "object" && payload !== null && "error" in payload) {
    const error = payload.error;
    if (
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof error.message === "string"
    )
      return error.message;
  }
  return status === 404
    ? "Company not found."
    : `Unable to load company (${status}).`;
}

export default function CompanyProfilePage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [company, setCompany] = useState<CompanyDetail>();
  const [canQueue, setCanQueue] = useState(false);
  const [canRevert, setCanRevert] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError(undefined);
      try {
        const [response, meResponse] = await Promise.all([
          fetch(`/api/v1/companies/${encodeURIComponent(id)}`, {
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
        if (!response.ok)
          throw new Error(errorMessage(payload, response.status));
        if (
          typeof payload !== "object" ||
          payload === null ||
          !("data" in payload) ||
          typeof payload.data !== "object" ||
          payload.data === null
        )
          throw new Error("The company service returned an invalid response.");
        setCompany((payload as Envelope).data);
        if (meResponse.ok) {
          const mePayload: unknown = await meResponse.json();
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
          setCanRevert(role === "admin");
        }
      } catch (caught) {
        if (signal.aborted) return;
        setCompany(undefined);
        setError(
          caught instanceof Error ? caught.message : "Unable to load company.",
        );
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [id, reloadKey],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (loading)
    return (
      <p className="asi-page-description" role="status">
        Loading company evidence profile…
      </p>
    );
  if (error)
    return (
      <EmptyState
        title={error}
        description="The profile could not be read from the company repository."
        action={
          <div className="admin-actions">
            <Button
              variant="secondary"
              onClick={() => setReloadKey((value) => value + 1)}
            >
              Try again
            </Button>
            <Link href="/companies">Back to companies</Link>
          </div>
        }
      />
    );
  if (!company) return null;

  const canonical = company.observations.filter(
    (observation) => observation.isCanonical,
  );

  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">
          <Link href="/companies">Known companies</Link> / profile
        </p>
        <h1 className="asi-page-title">{company.displayName}</h1>
        <p className="asi-page-description">
          {company.description ?? "No company description has been recorded."}
        </p>
        <div className="admin-actions">
          <Badge tone={company.status === "active" ? "success" : "neutral"}>
            {label(company.status)}
          </Badge>
          <Badge
            tone={company.pendingProposalCount > 0 ? "warning" : "neutral"}
          >
            {company.pendingProposalCount.toLocaleString()} pending proposals
          </Badge>
          {company.websiteUrl ? (
            <a href={company.websiteUrl} rel="noreferrer" target="_blank">
              Company website
            </a>
          ) : null}
        </div>
      </header>

      <CompanyResearchAction
        companyId={company.id}
        companyName={company.displayName}
        canQueue={canQueue}
      />
      <CompanyMergeAction
        companyId={company.id}
        companyName={company.displayName}
        canMerge={canQueue}
        canRevert={canRevert}
      />

      <section className="admin-panel" aria-labelledby="provenance-flow">
        <header className="admin-panel__header">
          <h2 id="provenance-flow">How this profile is built</h2>
          <p className="asi-page-description">
            Canonical fields are never inferred directly from a company record
            or source link.
          </p>
        </header>
        <ol>
          <li>
            <strong>Company</strong> — the stable entity that observations
            describe.
          </li>
          <li>
            <strong>Evidence observations</strong> — immutable claims tied to a
            retrieved source document and evidence location.
          </li>
          <li>
            <strong>Canonical fields</strong> — observations explicitly accepted
            through proposal review and selected as current.
          </li>
        </ol>
      </section>

      <div className="admin-grid">
        <section className="admin-panel" aria-labelledby="identity-heading">
          <header className="admin-panel__header">
            <h2 id="identity-heading">Recorded identity</h2>
          </header>
          <dl>
            <dt>Legal name</dt>
            <dd>{company.legalName}</dd>
            <dt>Headquarters</dt>
            <dd>
              {company.headquartersCountry ??
                company.headquartersCountryCode ??
                "Not recorded"}
            </dd>
            <dt>Founded</dt>
            <dd>{company.foundedYear ?? "Not recorded"}</dd>
            <dt>Domains</dt>
            <dd>
              {company.domains.length
                ? company.domains.map((domain) => domain.domain).join(", ")
                : "None recorded"}
            </dd>
            <dt>Identifiers</dt>
            <dd>
              {company.identifiers.length
                ? company.identifiers
                    .map(
                      (identifier) =>
                        `${label(identifier.type)} ${identifier.value}`,
                    )
                    .join(", ")
                : "None recorded"}
            </dd>
            <dt>Aliases</dt>
            <dd>
              {(company.aliases ?? []).length
                ? (company.aliases ?? [])
                    .map((alias) => alias.alias)
                    .join(", ")
                : "None recorded"}
            </dd>
          </dl>
          <CompanyAliasAction
            companyId={company.id}
            canEdit={canQueue}
            onCreated={() => setReloadKey((value) => value + 1)}
          />
        </section>
        <section className="admin-panel" aria-labelledby="coverage-heading">
          <header className="admin-panel__header">
            <h2 id="coverage-heading">Provenance coverage</h2>
          </header>
          <dl>
            <dt>Linked sources</dt>
            <dd>{company.sourceCount.toLocaleString()}</dd>
            <dt>Evidence items</dt>
            <dd>{company.evidenceCount.toLocaleString()}</dd>
            <dt>Observations</dt>
            <dd>{company.observationCount.toLocaleString()}</dd>
            <dt>Canonical fields</dt>
            <dd>{company.canonicalFactCount.toLocaleString()}</dd>
          </dl>
        </section>
      </div>

      <section className="admin-panel" aria-labelledby="canonical-heading">
        <header className="admin-panel__header">
          <h2 id="canonical-heading">Canonical fields</h2>
          <p className="asi-page-description">
            Only reviewed observations selected as current are shown here.
          </p>
        </header>
        {canonical.length === 0 ? (
          <EmptyState
            title="No canonical fields yet"
            description="Review is still required; the evidence observations below remain available without being presented as fact."
          />
        ) : (
          <Table>
            <TableCaption>
              {canonical.length} reviewed current field
              {canonical.length === 1 ? "" : "s"}
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Field</TableHead>
                <TableHead>Current value</TableHead>
                <TableHead>Confidence</TableHead>
                <TableHead>Provenance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {canonical.map((observation) => (
                <TableRow key={observation.id}>
                  <TableCell>
                    <strong>{label(observation.fieldKey)}</strong>
                  </TableCell>
                  <TableCell>
                    {displayValue(observation.value)}
                    {observation.unit ? ` ${observation.unit}` : ""}
                  </TableCell>
                  <TableCell>
                    <EvidenceConfidence
                      value={Number(observation.confidence)}
                    />
                  </TableCell>
                  <TableCell>
                    <dl className="admin-stack">
                      <div>
                        <dt>Observation</dt>
                        <dd style={{ fontFamily: "var(--asi-font-mono)" }}>
                          {observation.id}
                        </dd>
                      </div>
                      <div>
                        <dt>Review event</dt>
                        <dd style={{ fontFamily: "var(--asi-font-mono)" }}>
                          {observation.reviewEventId ??
                            "No accept event recorded"}
                        </dd>
                      </div>
                      <div>
                        <dt>Locator</dt>
                        <dd>
                          {observation.evidenceLocator ??
                            observation.evidenceQuote ??
                            "No document locator recorded"}
                        </dd>
                      </div>
                      <div>
                        <dt>Source</dt>
                        <dd>
                          {observation.documentCanonicalUrl ? (
                            <a
                              href={observation.documentCanonicalUrl}
                              rel="noreferrer"
                              target="_blank"
                            >
                              {observation.dataSourceName}
                            </a>
                          ) : (
                            observation.dataSourceName
                          )}
                        </dd>
                      </div>
                    </dl>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section className="admin-panel" aria-labelledby="observations-heading">
        <header className="admin-panel__header">
          <h2 id="observations-heading">Evidence observations</h2>
          <p className="asi-page-description">
            Each row preserves the extracted claim, review state, and actual
            evidence link.
          </p>
        </header>
        {company.observations.length === 0 ? (
          <EmptyState
            title="No observations recorded"
            description="Research has not produced evidence-backed observations for this company."
          />
        ) : (
          <Table>
            <TableCaption>
              {company.observations.length} evidence-backed observation
              {company.observations.length === 1 ? "" : "s"}
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Field and value</TableHead>
                <TableHead>Review</TableHead>
                <TableHead>Evidence</TableHead>
                <TableHead>Source document</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {company.observations.map((observation) => (
                <TableRow key={observation.id}>
                  <TableCell>
                    <div className="admin-stack">
                      <strong>{label(observation.fieldKey)}</strong>
                      <span>{displayValue(observation.value)}</span>
                      <EvidenceConfidence
                        value={Number(observation.confidence)}
                      />
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="admin-stack">
                      <Badge
                        tone={
                          observation.isCanonical
                            ? "success"
                            : observation.reviewStatus === "pending"
                              ? "warning"
                              : "neutral"
                        }
                      >
                        {observation.isCanonical
                          ? "Canonical"
                          : label(observation.reviewStatus)}
                      </Badge>
                      {observation.conflictStatus !== "none" ? (
                        <Badge tone="warning">
                          {label(observation.conflictStatus)} conflict
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <blockquote>
                      {observation.evidenceQuote ??
                        observation.evidenceLocator ??
                        "Evidence location recorded without display text"}
                    </blockquote>
                  </TableCell>
                  <TableCell>
                    {observation.documentCanonicalUrl ? (
                      <a
                        href={observation.documentCanonicalUrl}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {observation.documentTitle}
                      </a>
                    ) : (
                      observation.documentTitle
                    )}
                    <p className="asi-page-description">
                      {observation.dataSourceName}
                    </p>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <div className="admin-grid">
        <section className="admin-panel" aria-labelledby="sources-heading">
          <header className="admin-panel__header">
            <h2 id="sources-heading">Linked sources</h2>
            <p className="asi-page-description">
              Only explicit company-source links are shown.
            </p>
          </header>
          {company.linkedSources.length === 0 ? (
            <p className="asi-page-description">
              No data source is explicitly linked to this company.
            </p>
          ) : (
            <ul>
              {company.linkedSources.map((source) => (
                <li key={`${source.dataSourceId}-${source.relationship}`}>
                  <strong>
                    {source.homepageUrl ? (
                      <a
                        href={source.homepageUrl}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {source.name}
                      </a>
                    ) : (
                      source.name
                    )}
                  </strong>{" "}
                  — {label(source.relationship)}{" "}
                  <Badge
                    tone={
                      source.access === "restricted_metadata_only"
                        ? "warning"
                        : "neutral"
                    }
                  >
                    {label(source.access)}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="admin-panel" aria-labelledby="gaps-heading">
          <header className="admin-panel__header">
            <h2 id="gaps-heading">Research gaps</h2>
            <p className="asi-page-description">
              Repository-derived gaps indicate missing coverage, not negative
              findings.
            </p>
          </header>
          {company.researchGaps.length === 0 ? (
            <p className="asi-page-description">
              No current research gaps were returned.
            </p>
          ) : (
            <ul>
              {company.researchGaps.map((gap) => (
                <li key={gap}>{gap}</li>
              ))}
            </ul>
          )}
        </section>
      </div>


      <section className="admin-panel" aria-labelledby="timeline-heading">
        <header className="admin-panel__header">
          <h2 id="timeline-heading">Evidence timeline</h2>
          <p className="asi-page-description">
            Chronological observations with source locators. Canonical selection
            does not delete earlier evidence.
          </p>
        </header>
        {company.observations.length === 0 ? (
          <p className="asi-page-description">No dated observations are recorded.</p>
        ) : (
          <ol className="asi-timeline">
            {[...company.observations]
              .sort((left, right) => {
                const a = left.observedAt ?? left.createdAt ?? "";
                const b = right.observedAt ?? right.createdAt ?? "";
                return a < b ? 1 : a > b ? -1 : 0;
              })
              .map((observation) => (
                <li key={`timeline-${observation.id}`}>
                  <time dateTime={observation.observedAt ?? observation.createdAt}>
                    {(observation.observedAt ?? observation.createdAt ?? "Unknown time").slice(0, 10)}
                  </time>
                  <strong>{label(observation.fieldKey)}</strong>
                  {": "}
                  {displayValue(observation.value)}
                  {" — "}
                  {observation.dataSourceName}
                  {observation.isCanonical ? " (canonical)" : ""}
                </li>
              ))}
          </ol>
        )}
      </section>

      <section className="admin-panel" aria-labelledby="capabilities-heading">
        <header className="admin-panel__header">
          <h2 id="capabilities-heading">Capabilities</h2>
          <p className="asi-page-description">
            Capabilities are not qualifications or platform eligibility.
          </p>
        </header>
        {(company.capabilities ?? []).length === 0 ? (
          <p className="asi-page-description">No company capabilities recorded.</p>
        ) : (
          <ul>
            {(company.capabilities ?? []).map((capability) => (
              <li key={capability.id}>
                {capability.name ?? capability.code ?? capability.id}
                {" — "}
                {label(capability.status)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="admin-panel" aria-labelledby="certifications-heading">
        <header className="admin-panel__header">
          <h2 id="certifications-heading">Certifications</h2>
          <p className="asi-page-description">
            Kept separate from Facility × Part × Platform qualifications.
          </p>
        </header>
        {(company.certifications ?? []).length === 0 ? (
          <p className="asi-page-description">No certifications recorded.</p>
        ) : (
          <ul>
            {(company.certifications ?? []).map((certification) => (
              <li key={certification.id}>
                <Link href={`/certifications/${certification.id}`}>
                  {certification.standard}
                </Link>
                {certification.certificateNumber
                  ? ` (${certification.certificateNumber})`
                  : ""}
                {certification.facilityName ? ` — ${certification.facilityName}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="admin-panel" aria-labelledby="contacts-heading">
        <header className="admin-panel__header">
          <h2 id="contacts-heading">Contacts</h2>
        </header>
        {(company.contacts ?? []).length === 0 ? (
          <p className="asi-page-description">No contacts recorded.</p>
        ) : (
          <ul>
            {(company.contacts ?? []).map((contact) => (
              <li key={contact.id}>
                {contact.fullName}
                {contact.title ? ` — ${contact.title}` : ""}
                {" · "}
                {label(contact.verificationStatus)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <ScorecardPanel scorecard={company.scorecard} title="Supplier scorecard" />

      <section className="admin-panel" aria-labelledby="facilities-heading">
        <header className="admin-panel__header">
          <h2 id="facilities-heading">Facilities</h2>
        </header>
        {(company.facilities ?? []).length === 0 ? (
          <p className="asi-page-description">No facilities are recorded.</p>
        ) : (
          <ul>
            {(company.facilities ?? []).map((facility) => (
              <li key={facility.id}>
                <Link href={`/facilities/${facility.id}`}>{facility.name}</Link>
                {" — "}
                {[facility.city, facility.countryCode].filter(Boolean).join(", ") ||
                  "Location not recorded"}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="admin-panel" aria-labelledby="qualifications-heading">
        <header className="admin-panel__header">
          <h2 id="qualifications-heading">Qualifications</h2>
          <p className="asi-page-description">
            Facility × part/platform/customer/time. Scarcity stays not assessed
            until evidence supports a more specific state.
          </p>
        </header>
        {(company.qualificationLinks ?? []).length === 0 ? (
          <p className="asi-page-description">
            No qualification links are recorded. Capabilities are not
            qualifications.
          </p>
        ) : (
          <ul>
            {(company.qualificationLinks ?? []).map((link) => (
              <li key={link.qualification.id}>
                <Link href={`/facilities/${link.facility.id}`}>
                  {link.facility.name}
                </Link>
                {" · "}
                <Link href={`/qualifications/${link.qualification.id}`}>
                  {label(link.qualification.scarcity)}
                </Link>
                {" · "}
                {link.qualification.validFrom ?? "open"}–
                {link.qualification.validTo ?? "open"}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
