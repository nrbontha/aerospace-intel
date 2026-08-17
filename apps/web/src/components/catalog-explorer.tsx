"use client";

import {
  Badge,
  Button,
  EmptyState,
  Input,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@asi/ui";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";

import { CatalogExport } from "@/components/catalog-export";

type PageMeta = Readonly<{
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}>;

type Envelope<T> = Readonly<{ data: T[]; meta: PageMeta }>;

export type CatalogColumn<T> = Readonly<{
  header: string;
  numeric?: boolean;
  cell: (row: T) => ReactNode;
}>;

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
  return `Unable to load records (${status}).`;
}

export function CatalogExplorer<T extends { id: string }>({
  title,
  description,
  endpoint,
  columns,
  searchPlaceholder,
  emptyTitle,
  emptyDescription,
  hrefFor,
  exportEntity,
}: Readonly<{
  title: string;
  description: string;
  endpoint: string;
  columns: readonly CatalogColumn<T>[];
  searchPlaceholder: string;
  emptyTitle: string;
  emptyDescription: string;
  hrefFor: (row: T) => string;
  exportEntity?:
    | "companies"
    | "facilities"
    | "contacts"
    | "platforms"
    | "parts"
    | "qualifications"
    | "data_sources";
}>) {
  const [records, setRecords] = useState<T[]>([]);
  const [meta, setMeta] = useState<PageMeta>();
  const [draftQuery, setDraftQuery] = useState("");
  const [query, setQuery] = useState("");
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
      try {
        const response = await fetch(`${endpoint}?${params}`, {
          cache: "no-store",
          credentials: "same-origin",
          signal,
        });
        const payload: unknown = await response.json();
        if (!response.ok) throw new Error(errorMessage(payload, response.status));
        if (
          typeof payload !== "object" ||
          payload === null ||
          !("data" in payload) ||
          !("meta" in payload) ||
          !Array.isArray(payload.data)
        ) {
          throw new Error("The catalog service returned an invalid response.");
        }
        const result = payload as Envelope<T>;
        setRecords(result.data);
        setMeta(result.meta);
      } catch (caught) {
        if (signal.aborted) return;
        setRecords([]);
        setMeta(undefined);
        setError(
          caught instanceof Error ? caught.message : "Unable to load catalog.",
        );
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [endpoint, page, query, reloadKey],
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

  return (
    <section aria-labelledby="catalog-explorer-title">
      <div className="admin-panel">
        <header className="admin-panel__header">
          <h2 id="catalog-explorer-title">{title}</h2>
          <p className="asi-page-description">{description}</p>
        </header>
        <form className="admin-form-grid" onSubmit={search} role="search">
          <label className="admin-field" htmlFor="catalog-query">
            <span className="admin-field__label">Search</span>
            <Input
              id="catalog-query"
              maxLength={200}
              placeholder={searchPlaceholder}
              value={draftQuery}
              onChange={(event) => setDraftQuery(event.target.value)}
            />
          </label>
          <div className="admin-actions">
            <Button type="submit" disabled={loading}>
              Search
            </Button>
            {exportEntity ? (
              <CatalogExport entity={exportEntity} query={query} />
            ) : null}
            {query ? (
              <Button
                type="button"
                variant="ghost"
                disabled={loading}
                onClick={() => {
                  setDraftQuery("");
                  setQuery("");
                  setPage(1);
                }}
              >
                Clear
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
        <p className="asi-page-description" role="status">
          Loading catalog…
        </p>
      ) : null}
      {!loading && !error && records.length === 0 ? (
        <EmptyState title={emptyTitle} description={emptyDescription} />
      ) : null}
      {!loading && !error && records.length > 0 ? (
        <>
          <Table>
            <TableCaption>
              {meta
                ? `${meta.totalItems.toLocaleString()} record${meta.totalItems === 1 ? "" : "s"}; page ${meta.page} of ${meta.totalPages}`
                : title}
            </TableCaption>
            <TableHeader>
              <TableRow>
                {columns.map((column) => (
                  <TableHead
                    key={column.header}
                    {...(column.numeric ? { numeric: true } : {})}
                  >
                    {column.header}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.map((row) => (
                <TableRow key={row.id}>
                  {columns.map((column, index) => (
                    <TableCell
                      key={column.header}
                      {...(column.numeric ? { numeric: true } : {})}
                    >
                      {index === 0 ? (
                        <Link href={hrefFor(row)}>{column.cell(row)}</Link>
                      ) : (
                        column.cell(row)
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {meta && meta.totalPages > 1 ? (
            <div className="admin-actions">
              <Button
                variant="secondary"
                disabled={page <= 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
              >
                Previous
              </Button>
              <Badge tone="neutral">
                Page {meta.page} of {meta.totalPages}
              </Badge>
              <Button
                variant="secondary"
                disabled={page >= meta.totalPages}
                onClick={() => setPage((value) => value + 1)}
              >
                Next
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
