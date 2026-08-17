"use client";

import type { CompanyStatus } from "@asi/contracts";
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Select,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@asi/ui";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";

const statuses: readonly CompanyStatus[] = [
  "active",
  "inactive",
  "acquired",
  "defunct",
  "unknown",
];

type CompanyRecord = Readonly<{
  id: string;
  legalName: string;
  displayName: string;
  status: CompanyStatus;
  headquartersCountryCode: string | null;
  headquartersCountry: string | null;
  sourceCount: number;
  evidenceCount: number;
  observationCount: number;
  canonicalFactCount: number;
  pendingProposalCount: number;
}>;
type PageMeta = Readonly<{
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}>;
type Envelope = Readonly<{ data: CompanyRecord[]; meta: PageMeta }>;

function label(value: string) {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
function tone(status: CompanyStatus) {
  if (status === "active") return "success" as const;
  if (status === "defunct") return "danger" as const;
  if (status === "unknown") return "neutral" as const;
  return "warning" as const;
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
  return `Unable to load companies (${status}).`;
}

export function CompanyExplorer() {
  const [records, setRecords] = useState<CompanyRecord[]>([]);
  const [meta, setMeta] = useState<PageMeta>();
  const [draftQuery, setDraftQuery] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<CompanyStatus | "">("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError(undefined);
      const params = new URLSearchParams({
        page: String(page),
        pageSize: "25",
      });
      if (query) params.set("query", query);
      if (status) params.set("status", status);
      try {
        const response = await fetch(`/api/v1/companies?${params}`, {
          cache: "no-store",
          credentials: "same-origin",
          signal,
        });
        const payload: unknown = await response.json();
        if (!response.ok)
          throw new Error(errorMessage(payload, response.status));
        if (
          typeof payload !== "object" ||
          payload === null ||
          !("data" in payload) ||
          !("meta" in payload) ||
          !Array.isArray(payload.data)
        )
          throw new Error("The company service returned an invalid response.");
        const result = payload as Envelope;
        setRecords(result.data);
        setMeta(result.meta);
      } catch (caught) {
        if (signal.aborted) return;
        setRecords([]);
        setMeta(undefined);
        setError(
          caught instanceof Error
            ? caught.message
            : "Unable to load companies.",
        );
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [page, query, reloadKey, status],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setQuery(draftQuery.trim());
  }
  function clear() {
    setDraftQuery("");
    setQuery("");
    setStatus("");
    setPage(1);
  }
  const filtered = query !== "" || status !== "";

  return (
    <section aria-labelledby="company-explorer-title">
      <div className="admin-panel">
        <header className="admin-panel__header">
          <h2 id="company-explorer-title">Known companies explorer</h2>
          <p className="asi-page-description">
            Evidence and canonical counts reflect persisted provenance, not
            inferred company relationships.
          </p>
        </header>
        <form className="admin-form-grid" onSubmit={search} role="search">
          <label className="admin-field" htmlFor="company-query">
            <span className="admin-field__label">Search known companies</span>
            <Input
              id="company-query"
              maxLength={200}
              placeholder="Legal name, display name, or alias"
              value={draftQuery}
              onChange={(event) => setDraftQuery(event.target.value)}
            />
          </label>
          <label className="admin-field" htmlFor="company-status">
            <span className="admin-field__label">Company status</span>
            <Select
              id="company-status"
              value={status}
              onChange={(event) => {
                setPage(1);
                setStatus(event.target.value as CompanyStatus | "");
              }}
            >
              <option value="">All statuses</option>
              {statuses.map((value) => (
                <option key={value} value={value}>
                  {label(value)}
                </option>
              ))}
            </Select>
          </label>
          <div className="admin-actions">
            <Button type="submit" disabled={loading}>
              Search
            </Button>
            {filtered ? (
              <Button
                type="button"
                variant="ghost"
                disabled={loading}
                onClick={clear}
              >
                Clear filters
              </Button>
            ) : null}
          </div>
        </form>
      </div>

      {error ? (
        <div className="admin-feedback" data-tone="error" role="alert">
          <p>{error}</p>
          <Button
            size="small"
            variant="secondary"
            onClick={() => setReloadKey((value) => value + 1)}
          >
            Try again
          </Button>
        </div>
      ) : null}
      {loading ? (
        <p className="asi-page-description" role="status" aria-live="polite">
          Loading known companies…
        </p>
      ) : null}
      {!loading && !error && records.length === 0 ? (
        <EmptyState
          title={
            filtered
              ? "No companies match these filters"
              : "No known companies yet"
          }
          description={
            filtered
              ? "Clear or change the search criteria to inspect other entities."
              : "Companies extracted from source research appear here when proposals are generated; review their evidence before accepting canonical facts."
          }
          action={
            filtered ? (
              <Button variant="secondary" onClick={clear}>
                Show all companies
              </Button>
            ) : (
              <Link href="/data-sources">Register a research source</Link>
            )
          }
        />
      ) : null}

      {!loading && !error && records.length > 0 ? (
        <>
          <Table>
            <TableCaption>
              {meta
                ? `${meta.totalItems.toLocaleString()} known compan${meta.totalItems === 1 ? "y" : "ies"}; page ${meta.page} of ${meta.totalPages}`
                : "Known companies"}
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Company</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Location</TableHead>
                <TableHead numeric>Sources</TableHead>
                <TableHead>Evidence trail</TableHead>
                <TableHead>Canonical state</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.map((company) => (
                <TableRow key={company.id}>
                  <TableCell>
                    <div className="admin-stack">
                      <Link href={`/companies/${company.id}`}>
                        <strong>{company.displayName}</strong>
                      </Link>
                      {company.legalName !== company.displayName ? (
                        <span className="asi-page-description">
                          {company.legalName}
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge tone={tone(company.status)}>
                      {label(company.status)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {company.headquartersCountry ??
                      company.headquartersCountryCode ??
                      "Not recorded"}
                  </TableCell>
                  <TableCell numeric>
                    {company.sourceCount.toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <div className="admin-stack">
                      <span>
                        {company.evidenceCount.toLocaleString()} evidence items
                      </span>
                      <span className="asi-page-description">
                        {company.observationCount.toLocaleString()} observations
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="admin-stack">
                      <Badge
                        tone={
                          company.canonicalFactCount > 0 ? "success" : "neutral"
                        }
                      >
                        {company.canonicalFactCount.toLocaleString()} canonical
                      </Badge>
                      {company.pendingProposalCount > 0 ? (
                        <Badge tone="warning">
                          {company.pendingProposalCount.toLocaleString()}{" "}
                          pending review
                        </Badge>
                      ) : (
                        <span className="asi-page-description">
                          No pending proposals
                        </span>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <nav className="admin-actions" aria-label="Company list pagination">
            <Button
              variant="secondary"
              size="small"
              disabled={page <= 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              Previous
            </Button>
            <span className="asi-page-description" aria-live="polite">
              Page {meta?.page ?? page} of {meta?.totalPages ?? 1}
            </span>
            <Button
              variant="secondary"
              size="small"
              disabled={!meta || page >= meta.totalPages}
              onClick={() => setPage((value) => value + 1)}
            >
              Next
            </Button>
          </nav>
        </>
      ) : null}
    </section>
  );
}
