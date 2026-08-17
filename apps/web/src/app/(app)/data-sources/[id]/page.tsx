"use client";

import type { Role, SourceAccess, SourceIngestion } from "@asi/contracts";
import { Badge, Button, EmptyState, Metric, StatusDot } from "@asi/ui";
import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";

import { apiJson } from "@/components/csrf-client";
import {
  sourceAccessLabel,
  sourceIngestionLabel,
} from "@/components/data-source-explorer";
import { SourceResearchAction } from "@/components/source-research-action";
import { ScorecardPanel, type Scorecard } from "@/components/scorecard-panel";

type SourceRecord = Readonly<{
  id: string;
  name: string;
  sourceType: string;
  description?: string | null;
  homepageUrl?: string | null;
  access: SourceAccess;
  ingestionMethod: SourceIngestion;
  status: string;
  publisher?: string | null;
  jurisdiction?: string | null;
  metadata?: Record<string, unknown>;
  linkedCompanyCount: number;
  documentCount: number;
  researchRunCount: number;
  pendingProposalCount: number;
  latestResearchStatus?: string | null;
  createdAt: string;
  updatedAt: string;
  scorecard?: Scorecard | null;
  documents?: readonly {
    id: string;
    title: string | null;
    canonicalUrl: string | null;
    documentType: string | null;
    retrievedAt: string;
    contentSha256: string | null;
    mimeType: string | null;
    byteLength: number | null;
  }[];
}>;
type CurrentSession = Readonly<{ user: { role: Role } }>;

function statusTone(status: string): "info" | "success" | "warning" | "danger" {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "cancelled") return "danger";
  if (status === "queued" || status === "running") return "info";
  return "warning";
}
function metadataText(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
function isNavigableHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function sourceUrls(source: SourceRecord): string[] {
  const candidates: unknown[] = [
    source.homepageUrl,
    ...(Array.isArray(source.metadata?.referenceUrls)
      ? source.metadata.referenceUrls
      : []),
  ];
  return [
    ...new Set(candidates.filter(isNavigableHttpUrl).map((url) => url.trim())),
  ];
}

export default function DataSourceProfilePage({
  params,
}: Readonly<{ params: Promise<{ id: string }> }>) {
  const { id } = use(params);
  const [source, setSource] = useState<SourceRecord>();
  const [role, setRole] = useState<Role>("viewer");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [record, session] = await Promise.all([
        apiJson<SourceRecord>(`/api/v1/sources/${encodeURIComponent(id)}`),
        apiJson<CurrentSession>("/api/v1/auth/me"),
      ]);
      setSource(record);
      setRole(session.user.role);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to load this source.",
      );
    } finally {
      setLoading(false);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  if (loading)
    return (
      <div className="admin-panel" role="status">
        Loading source profile…
      </div>
    );
  if (error || !source)
    return (
      <EmptyState
        title="Source unavailable"
        description={
          <p>{error ?? "The requested source could not be found."}</p>
        }
        action={
          <div className="admin-actions">
            <Button
              variant="secondary"
              onClick={() => setReloadKey((value) => value + 1)}
            >
              Try again
            </Button>
            <Link href="/data-sources">Back to sources</Link>
          </div>
        }
      />
    );

  const restricted = source.access === "restricted_metadata_only";
  const researchStatus = restricted
    ? "Never searched"
    : (source.latestResearchStatus ?? "Not queued");
  const urls = sourceUrls(source);
  const notes = source.description ?? metadataText(source.metadata, "notes");
  const visitUrl = isNavigableHttpUrl(source.homepageUrl)
    ? source.homepageUrl
    : undefined;
  const sourceType =
    source.sourceType ||
    metadataText(source.metadata, "sourceType") ||
    "Unspecified";

  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">
          <Link href="/data-sources">Data sources</Link> / Profile
        </p>
        <h1 className="asi-page-title">{source.name}</h1>
        <div className="admin-actions">
          <Badge
            tone={
              restricted
                ? "warning"
                : source.access === "public"
                  ? "success"
                  : "info"
            }
          >
            {sourceAccessLabel(source.access)}
          </Badge>
          <Badge>{source.status}</Badge>
          {visitUrl ? (
            <a
              className="asi-button"
              data-size="medium"
              data-variant="secondary"
              href={visitUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              Visit source <span aria-hidden="true">↗</span>
            </a>
          ) : null}
        </div>
      </header>

      {restricted ? (
        <section
          className="admin-panel"
          aria-labelledby="restricted-heading"
          style={{ marginBlockEnd: "var(--asi-space-12)" }}
        >
          <div className="admin-panel__header">
            <h2 id="restricted-heading">Restricted metadata only</h2>
            <StatusDot label="Never searched" tone="warning" />
          </div>
          <p className="asi-page-description">
            This record is maintained for metadata navigation only. Automatic
            research is disabled; its linked content has not been searched by
            this system.
          </p>
        </section>
      ) : null}

      <section className="admin-panel" aria-labelledby="source-summary-heading">
        <div className="admin-panel__header">
          <h2 id="source-summary-heading">Source summary</h2>
          <StatusDot
            label={researchStatus}
            tone={
              restricted
                ? "warning"
                : statusTone(source.latestResearchStatus ?? "not_queued")
            }
          />
        </div>
        <div className="admin-grid">
          <Metric
            label="Linked companies"
            value={source.linkedCompanyCount}
            detail={
              source.linkedCompanyCount === 0
                ? "Source remains independent"
                : "Explicit source links"
            }
          />
          <Metric
            label="Source documents"
            value={source.documentCount}
            detail="Retrieved or uploaded artifacts"
          />
          <Metric
            label="Research runs"
            value={source.researchRunCount}
            detail={researchStatus}
          />
          <Metric
            label="Pending proposals"
            value={source.pendingProposalCount}
            detail="Awaiting analyst review"
          />
        </div>
        <dl
          className="admin-form-grid"
          style={{ marginBlockStart: "var(--asi-space-12)" }}
        >
          <div>
            <dt className="asi-page-description">Access</dt>
            <dd style={{ margin: 0 }}>{sourceAccessLabel(source.access)}</dd>
          </div>
          <div>
            <dt className="asi-page-description">Ingestion policy</dt>
            <dd style={{ margin: 0 }}>
              {sourceIngestionLabel(source.ingestionMethod)}
            </dd>
          </div>
          <div>
            <dt className="asi-page-description">Source type</dt>
            <dd style={{ margin: 0 }}>{sourceType}</dd>
          </div>
          <div>
            <dt className="asi-page-description">Publisher</dt>
            <dd style={{ margin: 0 }}>
              {source.publisher ??
                metadataText(source.metadata, "publisher") ??
                "Not recorded"}
            </dd>
          </div>
          <div>
            <dt className="asi-page-description">Jurisdiction</dt>
            <dd style={{ margin: 0 }}>
              {source.jurisdiction ??
                metadataText(source.metadata, "jurisdiction") ??
                "Not recorded"}
            </dd>
          </div>
          <div>
            <dt className="asi-page-description">Last updated</dt>
            <dd style={{ margin: 0 }}>
              {new Date(source.updatedAt).toLocaleString()}
            </dd>
          </div>
        </dl>
      </section>

      <div
        className="admin-grid"
        style={{ marginBlockStart: "var(--asi-space-12)" }}
      >
        <section className="admin-panel" aria-labelledby="source-urls-heading">
          <div className="admin-panel__header">
            <h2 id="source-urls-heading">Source URLs</h2>
          </div>
          {urls.length === 0 ? (
            <p className="asi-page-description">No metadata URL recorded.</p>
          ) : (
            <ul
              style={{ margin: 0, paddingInlineStart: "var(--asi-space-12)" }}
            >
              {urls.map((url) => (
                <li key={url}>
                  <a href={url} target="_blank" rel="noreferrer noopener">
                    {url}{" "}
                    <span className="asi-page-description">
                      (opens externally)
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="admin-panel" aria-labelledby="source-notes-heading">
          <div className="admin-panel__header">
            <h2 id="source-notes-heading">Notes</h2>
          </div>
          <p
            className="asi-page-description"
            style={{ whiteSpace: "pre-wrap" }}
          >
            {notes ?? "No source notes recorded."}
          </p>
        </section>
      </div>

      <section
        className="admin-panel"
        aria-labelledby="source-documents-heading"
        style={{ marginBlockStart: "var(--asi-space-12)" }}
      >
        <div className="admin-panel__header">
          <h2 id="source-documents-heading">Retrieved documents</h2>
        </div>
        {(source.documents ?? []).length === 0 ? (
          <p className="asi-page-description">
            No retrieved documents are linked to this source yet.
          </p>
        ) : (
          <ul style={{ margin: 0, paddingInlineStart: "var(--asi-space-12)" }}>
            {(source.documents ?? []).map((document) => (
              <li key={document.id} style={{ marginBlockEnd: "0.75rem" }}>
                <strong>{document.title ?? "Untitled document"}</strong>
                {document.canonicalUrl ? (
                  <div>
                    <a
                      href={document.canonicalUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {document.canonicalUrl}
                    </a>
                  </div>
                ) : (
                  <div className="asi-page-description">No public URL</div>
                )}
                <div className="asi-page-description">
                  {document.documentType ?? "unspecified type"}
                  {" · "}
                  retrieved {new Date(document.retrievedAt).toLocaleString()}
                  {document.byteLength
                    ? ` · ${document.byteLength.toLocaleString()} bytes`
                    : ""}
                  {document.contentSha256
                    ? ` · sha256 ${document.contentSha256.slice(0, 12)}…`
                    : ""}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div style={{ marginBlockStart: "var(--asi-space-12)" }}>
        <SourceResearchAction
          sourceId={source.id}
          sourceName={source.name}
          access={source.access}
          canQueue={role === "analyst" || role === "admin"}
          {...(source.latestResearchStatus === undefined
            ? {}
            : { latestStatus: source.latestResearchStatus })}
          onQueued={(run) =>
            setSource((current) =>
              current
                ? {
                    ...current,
                    latestResearchStatus: run.status,
                    researchRunCount: current.researchRunCount + 1,
                  }
                : current,
            )
          }
        />
      </div>
      <ScorecardPanel scorecard={source.scorecard} title="Source scorecard" />
    </>
  );
}
