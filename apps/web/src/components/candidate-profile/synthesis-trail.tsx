"use client";

import {
  Badge,
  Button,
  EmptyState,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@asi/ui";
import type { ReactNode } from "react";

export type SynthesisFactStatus =
  | "canonical"
  | "pending"
  | "conflict"
  | "unknown";

export interface SynthesisFact {
  id: string;
  label: string;
  value: string;
  status: SynthesisFactStatus;
  authority?: string | null;
  officialUrl?: string | null;
  excerpt?: string | null;
  locator?: string | null;
  freshness?: string | null;
}

export interface SynthesisFacility {
  id: string;
  name: string;
  address?: string | null;
  status: SynthesisFactStatus;
  authority?: string | null;
  officialUrl?: string | null;
  excerpt?: string | null;
  locator?: string | null;
  freshness?: string | null;
}

export interface SynthesisSourceRecord {
  id: string;
  sourceKey: string;
  locator: string;
  authority: string;
  status: string;
  facts: readonly SynthesisFact[];
  evidenceUrls: readonly string[];
  expectedObservationIds: readonly string[];
  freshness?: string | null;
}

export interface FaaPmaQualification {
  id: string;
  holderNumber: string;
  status: string;
  part: {
    number: string;
    name: string;
    replacementFor?: string | null;
  };
  make: string;
  models: readonly string[];
  approvalBasis?: string | null;
  supplement?: string | null;
  facility?: {
    id?: string | null;
    name: string;
    address?: string | null;
  } | null;
  materializationStatus: "draft" | "active";
  authority?: string | null;
  officialUrl?: string | null;
  locator?: string | null;
  freshness?: string | null;
}

export interface SynthesisConflict {
  id: string;
  field: string;
  summary: string;
  facts: readonly SynthesisFact[];
}

export interface SynthesisResearchGap {
  id: string;
  question: string;
  reason: string;
  priority?: "low" | "medium" | "high" | null;
}

export interface CompanySynthesisTrail {
  company: {
    id: string;
    name: string;
    domain?: string | null;
  };
  identifiers: readonly SynthesisFact[];
  facilities: readonly SynthesisFacility[];
  sourceRecords: readonly SynthesisSourceRecord[];
  qualifications: readonly FaaPmaQualification[];
  conflicts: readonly SynthesisConflict[];
  gaps: readonly SynthesisResearchGap[];
  confidence: {
    sourceCount: number;
    primarySourceCount: number;
    conflictCount: number;
    score?: number | null;
  };
}

export interface ConfirmedScarcityInput {
  confirmed: boolean;
  statement: string;
  authority: string;
  officialUrl: string;
  confirmedAt: string;
}

export interface SynthesisTrailProps {
  trail: CompanySynthesisTrail | null;
  loading?: boolean;
  error?: string | null;
  role?: "analyst" | "viewer";
  confirmedScarcity?: ConfirmedScarcityInput | null;
  onAcceptSourceRecord?: (
    id: string,
    expectedObservationIds: readonly string[],
  ) => void;
  onReject?: (
    id: string,
    expectedObservationIds: readonly string[],
  ) => void;
}

const STATUS_TONES = {
  canonical: "success",
  pending: "warning",
  conflict: "danger",
  unknown: "neutral",
} as const;

function StatusBadge({ status }: { status: SynthesisFactStatus }) {
  return <Badge tone={STATUS_TONES[status]}>{status}</Badge>;
}

function OfficialLink({ url }: { url?: string | null }) {
  if (!url) return <span>Not recorded</span>;
  return (
    <a href={url} rel="noreferrer" target="_blank">
      Official record
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function EvidenceDetail({
  excerpt,
  locator,
}: {
  excerpt?: string | null;
  locator?: string | null;
}) {
  if (!excerpt && !locator) return <span>Not recorded</span>;
  return (
    <span>
      {excerpt ? <q>{excerpt}</q> : null}
      {excerpt && locator ? <br /> : null}
      {locator ? <span className="asi-page-description">Locator: {locator}</span> : null}
    </span>
  );
}

function FactTable({
  caption,
  facts,
  fallbackAuthority,
  fallbackOfficialUrl,
  fallbackLocator,
  fallbackFreshness,
  emptyText,
}: {
  caption: string;
  facts: readonly SynthesisFact[];
  fallbackAuthority?: string | null;
  fallbackOfficialUrl?: string | null;
  fallbackLocator?: string | null;
  fallbackFreshness?: string | null;
  emptyText: string;
}) {
  if (facts.length === 0) {
    return <p className="asi-page-description">{emptyText}</p>;
  }

  return (
    <Table className="synthesis-trail__dense-table">
      <TableCaption>{caption}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Fact</TableHead>
          <TableHead scope="col">Value</TableHead>
          <TableHead scope="col">Status</TableHead>
          <TableHead scope="col">Source authority</TableHead>
          <TableHead scope="col">Official URL</TableHead>
          <TableHead scope="col">Excerpt / locator</TableHead>
          <TableHead scope="col">Freshness</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {facts.map((fact) => (
          <TableRow key={fact.id}>
            <TableHead scope="row">{fact.label}</TableHead>
            <TableCell>{fact.value || "Unknown"}</TableCell>
            <TableCell>
              <StatusBadge status={fact.status} />
            </TableCell>
            <TableCell>
              {fact.authority || fallbackAuthority || "Unknown authority"}
            </TableCell>
            <TableCell>
              <OfficialLink url={fact.officialUrl ?? fallbackOfficialUrl ?? null} />
            </TableCell>
            <TableCell>
              <EvidenceDetail
                excerpt={fact.excerpt ?? null}
                locator={fact.locator ?? fallbackLocator ?? null}
              />
            </TableCell>
            <TableCell>
              {fact.freshness || fallbackFreshness || "Unknown"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="admin-stack" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

function FacilitiesSection({ facilities }: { facilities: readonly SynthesisFacility[] }) {
  if (facilities.length === 0) {
    return (
      <p className="asi-page-description">
        No facility evidence has been materialized. A company address is not inferred from its domain.
      </p>
    );
  }

  return (
    <Table className="synthesis-trail__dense-table">
      <TableCaption>Evidence-backed company facilities</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Facility</TableHead>
          <TableHead scope="col">Address</TableHead>
          <TableHead scope="col">Status</TableHead>
          <TableHead scope="col">Source authority</TableHead>
          <TableHead scope="col">Official URL</TableHead>
          <TableHead scope="col">Excerpt / locator</TableHead>
          <TableHead scope="col">Freshness</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {facilities.map((facility) => (
          <TableRow key={facility.id}>
            <TableHead scope="row">{facility.name}</TableHead>
            <TableCell>{facility.address || "Unknown"}</TableCell>
            <TableCell>
              <StatusBadge status={facility.status} />
            </TableCell>
            <TableCell>{facility.authority || "Unknown authority"}</TableCell>
            <TableCell>
              <OfficialLink url={facility.officialUrl ?? null} />
            </TableCell>
            <TableCell>
              <EvidenceDetail
                excerpt={facility.excerpt ?? null}
                locator={facility.locator ?? null}
              />
            </TableCell>
            <TableCell>{facility.freshness || "Unknown"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function SourceRecordsSection({
  records,
  role,
  onAcceptSourceRecord,
  onReject,
}: {
  records: readonly SynthesisSourceRecord[];
  role: "analyst" | "viewer";
  onAcceptSourceRecord?: SynthesisTrailProps["onAcceptSourceRecord"];
  onReject?: SynthesisTrailProps["onReject"];
}) {
  if (records.length === 0) {
    return (
      <p className="asi-page-description">
        No source records are available. There are no observations to accept or reject.
      </p>
    );
  }

  const viewer = role === "viewer";
  return (
    <div className="admin-stack">
      {records.map((record) => {
        const officialUrl = record.evidenceUrls[0] ?? null;
        const statusTone =
          record.status === "accepted" || record.status === "active"
            ? "success"
            : record.status === "pending"
              ? "warning"
              : record.status === "conflict" || record.status === "rejected"
                ? "danger"
                : "neutral";
        return (
          <article className="admin-stack" key={record.id} aria-labelledby={`source-${record.id}`}>
            <header>
              <h3 id={`source-${record.id}`}>{record.sourceKey}</h3>
              <p className="asi-page-description">
                {record.authority} · <Badge tone={statusTone}>{record.status}</Badge> · Locator:{" "}
                {record.locator}
                {record.freshness ? ` · Freshness: ${record.freshness}` : " · Freshness: Unknown"}
              </p>
              {record.evidenceUrls.length > 0 ? (
                <ul aria-label={`${record.sourceKey} evidence URLs`}>
                  {record.evidenceUrls.map((url, index) => (
                    <li key={url}>
                      <a href={url} rel="noreferrer" target="_blank">
                        Official evidence {index + 1}
                        <span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="asi-page-description">No official evidence URL was recorded.</p>
              )}
            </header>
            <FactTable
              caption={`Facts observed in ${record.sourceKey}`}
              facts={record.facts}
              fallbackAuthority={record.authority}
              fallbackOfficialUrl={officialUrl}
              fallbackLocator={record.locator}
              fallbackFreshness={record.freshness ?? null}
              emptyText="This source record contains no materialized facts."
            />
            <div aria-label={`Review ${record.sourceKey}`}>
              <Button
                disabled={viewer || !onAcceptSourceRecord}
                onClick={() => onAcceptSourceRecord?.(record.id, record.expectedObservationIds)}
                size="small"
              >
                Accept source record
              </Button>{" "}
              <Button
                disabled={viewer || !onReject}
                onClick={() => onReject?.(record.id, record.expectedObservationIds)}
                size="small"
                variant="danger"
              >
                Reject source record
              </Button>
              {viewer ? (
                <span className="asi-page-description"> Viewer access is read-only.</span>
              ) : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function FaaQualificationsSection({
  companyName,
  qualifications,
}: {
  companyName: string;
  qualifications: readonly FaaPmaQualification[];
}) {
  if (qualifications.length === 0) {
    return (
      <p className="asi-page-description">
        No FAA PMA qualifications are recorded. No approval is inferred from other company evidence.
      </p>
    );
  }

  return (
    <div className="admin-stack">
      <p className="asi-page-description">
        FAA PMA records qualify approved replacement parts; they do not establish broader company capabilities.
      </p>
      <ol
        aria-label="FAA PMA Company to Facility to Part to Make and Model graph"
        style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "1rem" }}
      >
        {qualifications.map((qualification) => (
          <li className="admin-stack" key={qualification.id}>
            <article aria-labelledby={`pma-${qualification.id}`}>
              <header>
                <h3 id={`pma-${qualification.id}`}>
                  PMA {qualification.holderNumber} · {qualification.part.number}
                </h3>
                <p>
                  <Badge tone={qualification.materializationStatus === "active" ? "success" : "warning"}>
                    {qualification.materializationStatus}
                  </Badge>{" "}
                  <Badge tone="info">{qualification.status}</Badge>
                </p>
              </header>
              <ol aria-label={`Qualification path for ${qualification.part.number}`}>
                <li>
                  Company: <strong>{companyName}</strong>
                  <ol>
                    <li>
                      Facility: <strong>{qualification.facility?.name || "Unknown facility"}</strong>
                      {qualification.facility?.address ? ` · ${qualification.facility.address}` : null}
                      <ol>
                        <li>
                          PMA part: <strong>{qualification.part.number}</strong> · {qualification.part.name}
                          <br />
                          Replaces: {qualification.part.replacementFor || "Not recorded"}
                          <ol>
                            <li>
                              Make: <strong>{qualification.make || "Unknown"}</strong>
                              <ul>
                                {qualification.models.length > 0 ? (
                                  qualification.models.map((model) => <li key={model}>Model: {model}</li>)
                                ) : (
                                  <li>Model: Not recorded</li>
                                )}
                              </ul>
                            </li>
                          </ol>
                        </li>
                      </ol>
                    </li>
                  </ol>
                </li>
              </ol>
              <dl>
                <dt>PMA holder number</dt>
                <dd>{qualification.holderNumber}</dd>
                <dt>Approval basis</dt>
                <dd>{qualification.approvalBasis || "Not recorded"}</dd>
                <dt>Supplement</dt>
                <dd>{qualification.supplement || "Not recorded"}</dd>
                <dt>Source authority</dt>
                <dd>{qualification.authority || "FAA"}</dd>
                <dt>Official URL</dt>
                <dd>
                  <OfficialLink url={qualification.officialUrl ?? null} />
                </dd>
                <dt>Excerpt / locator</dt>
                <dd>
                  <EvidenceDetail locator={qualification.locator ?? null} />
                </dd>
                <dt>Freshness</dt>
                <dd>{qualification.freshness || "Unknown"}</dd>
              </dl>
            </article>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ConflictsSection({ conflicts }: { conflicts: readonly SynthesisConflict[] }) {
  if (conflicts.length === 0) {
    return <p className="asi-page-description">No unresolved conflicts are recorded.</p>;
  }
  return (
    <div className="admin-stack">
      {conflicts.map((conflict) => (
        <article className="admin-stack" key={conflict.id} aria-labelledby={`conflict-${conflict.id}`}>
          <header>
            <h3 id={`conflict-${conflict.id}`}>
              {conflict.field} <Badge tone="danger">conflict</Badge>
            </h3>
            <p>{conflict.summary}</p>
          </header>
          <FactTable
            caption={`Conflicting observations for ${conflict.field}`}
            facts={conflict.facts}
            emptyText="The conflict has no supporting observations."
          />
        </article>
      ))}
    </div>
  );
}

function GapsSection({ gaps }: { gaps: readonly SynthesisResearchGap[] }) {
  if (gaps.length === 0) {
    return <p className="asi-page-description">No open research gaps are recorded.</p>;
  }
  return (
    <Table className="synthesis-trail__dense-table">
      <TableCaption>Questions that available evidence does not answer</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Question</TableHead>
          <TableHead scope="col">Why this remains open</TableHead>
          <TableHead scope="col">Priority</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {gaps.map((gap) => (
          <TableRow key={gap.id}>
            <TableHead scope="row">{gap.question}</TableHead>
            <TableCell>{gap.reason}</TableCell>
            <TableCell>{gap.priority || "Not prioritized"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ConfidenceSection({ confidence }: { confidence: CompanySynthesisTrail["confidence"] }) {
  return (
    <Table className="synthesis-trail__dense-table">
      <TableCaption>Inputs used to assess synthesis confidence</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Input</TableHead>
          <TableHead scope="col" numeric>Value</TableHead>
          <TableHead scope="col">Interpretation</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableHead scope="row">Source records</TableHead>
          <TableCell numeric>{confidence.sourceCount}</TableCell>
          <TableCell>All materialized sources contributing evidence.</TableCell>
        </TableRow>
        <TableRow>
          <TableHead scope="row">Primary sources</TableHead>
          <TableCell numeric>{confidence.primarySourceCount}</TableCell>
          <TableCell>Government or first-party records in the synthesis.</TableCell>
        </TableRow>
        <TableRow>
          <TableHead scope="row">Unresolved conflicts</TableHead>
          <TableCell numeric>{confidence.conflictCount}</TableCell>
          <TableCell>Conflicting observations that still require analyst resolution.</TableCell>
        </TableRow>
        <TableRow>
          <TableHead scope="row">Computed confidence score</TableHead>
          <TableCell numeric>{confidence.score ?? "Not computed"}</TableCell>
          <TableCell>The stored score, when the synthesis process produced one.</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}

export function SynthesisTrail({
  trail,
  loading = false,
  error = null,
  role = "viewer",
  confirmedScarcity = null,
  onAcceptSourceRecord,
  onReject,
}: SynthesisTrailProps) {
  if (loading) {
    return (
      <section aria-busy="true" aria-live="polite" className="admin-stack">
        <h2>Company synthesis trail</h2>
        <p>Loading source-backed synthesis…</p>
      </section>
    );
  }

  if (error) {
    return (
      <EmptyState
        role="alert"
        title="Synthesis trail unavailable"
        description={`The source-backed synthesis could not be loaded: ${error}`}
      />
    );
  }

  if (!trail) {
    return (
      <EmptyState
        title="No synthesis trail"
        description="No source records have been materialized for this company. Unknown values remain unknown."
      />
    );
  }

  return (
    <div className="admin-stack" aria-label={`Synthesis trail for ${trail.company.name}`}>
      <header>
        <h1>{trail.company.name} synthesis trail</h1>
        <p className="asi-page-description">
          {trail.company.domain ? (
            <>
              Domain: <a href={`https://${trail.company.domain}`}>{trail.company.domain}</a>
            </>
          ) : (
            "No canonical company domain is recorded."
          )}
        </p>
      </header>

      <Section id="synthesis-identity" title="Identity consensus">
        <FactTable
          caption="Evidence-backed company identifiers"
          facts={trail.identifiers}
          emptyText="No identifiers have reached the synthesis trail. Company identity is unresolved."
        />
      </Section>

      <Section id="synthesis-facilities" title="Facilities">
        <FacilitiesSection facilities={trail.facilities} />
      </Section>

      <Section id="synthesis-source-records" title="Source records">
        <SourceRecordsSection
          records={trail.sourceRecords}
          role={role}
          onAcceptSourceRecord={onAcceptSourceRecord}
          onReject={onReject}
        />
      </Section>

      <Section id="synthesis-faa-pma" title="FAA PMA qualification graph">
        <FaaQualificationsSection
          companyName={trail.company.name}
          qualifications={trail.qualifications}
        />
      </Section>

      <Section id="synthesis-conflicts" title="Conflicts">
        <ConflictsSection conflicts={trail.conflicts} />
      </Section>

      <Section id="synthesis-gaps" title="Research gaps">
        <GapsSection gaps={trail.gaps} />
      </Section>

      <Section id="synthesis-confidence" title="Confidence inputs">
        <ConfidenceSection confidence={trail.confidence} />
      </Section>

      {confirmedScarcity?.confirmed ? (
        <section aria-labelledby="synthesis-scarcity" className="admin-stack">
          <h2 id="synthesis-scarcity">Confirmed source scarcity</h2>
          <p>
            <Badge tone="warning">Confirmed sole source</Badge> {confirmedScarcity.statement}
          </p>
          <p className="asi-page-description">
            {confirmedScarcity.authority} · confirmed {confirmedScarcity.confirmedAt} ·{" "}
            <a href={confirmedScarcity.officialUrl} rel="noreferrer" target="_blank">
              Official confirmation
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </p>
        </section>
      ) : null}
    </div>
  );
}
