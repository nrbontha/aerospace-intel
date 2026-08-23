"use client";

import type { SourceAccess, SourceIngestion } from "@asi/contracts";
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
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";

const accessOptions: ReadonlyArray<{ label: string; value: SourceAccess }> = [
  { label: "Public", value: "public" },
  { label: "Authorized material", value: "authorized" },
  { label: "Restricted metadata only", value: "restricted_metadata_only" },
];
const ingestionOptions: ReadonlyArray<{
  label: string;
  value: SourceIngestion;
}> = [
  { label: "Manual", value: "manual" },
  { label: "Authorized upload", value: "upload" },
  { label: "Controlled web fetch", value: "web_fetch" },
  { label: "Approved API", value: "api" },
  { label: "Import", value: "import" },
];

type SourceRecord = Readonly<{
  id: string;
  name: string;
  description?: string | null;
  homepageUrl?: string | null;
  access: SourceAccess;
  ingestionMethod: SourceIngestion;
  status: string;
  linkedCompanyCount: number;
  documentCount: number;
  createdAt: string;
  updatedAt: string;
}>;
type PageMeta = Readonly<{
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}>;
type SourceEnvelope = Readonly<{ data: SourceRecord[]; meta?: PageMeta }>;

export function sourceAccessLabel(value: SourceAccess): string {
  return accessOptions.find((option) => option.value === value)?.label ?? value;
}
export function sourceIngestionLabel(value: SourceIngestion): string {
  return (
    ingestionOptions.find((option) => option.value === value)?.label ?? value
  );
}
function accessTone(value: SourceAccess): "info" | "success" | "warning" {
  if (value === "public") return "success";
  if (value === "authorized") return "info";
  return "warning";
}
function companyCount(source: SourceRecord): number {
  return Number.isFinite(source.linkedCompanyCount) &&
    source.linkedCompanyCount > 0
    ? Math.floor(source.linkedCompanyCount)
    : 0;
}
function documentCount(source: SourceRecord): number {
  return Number.isFinite(source.documentCount) && source.documentCount > 0
    ? Math.floor(source.documentCount)
    : 0;
}
/** A source is unmined when nothing has been linked from it yet. */
function isUnmined(source: SourceRecord): boolean {
  return companyCount(source) === 0 && documentCount(source) === 0;
}
/** Imported sources record their model-processing policy in the notes text. */
function modelProcessingLabel(source: SourceRecord): string | null {
  const match = /Model processing:\s*([^\n.]+)/i.exec(source.description ?? "");
  if (match === null) return null;
  const label = match[1]?.trim() ?? "";
  return label === "" ? null : label;
}
function errorMessage(payload: unknown, fallback: string): string {
  if (typeof payload !== "object" || payload === null || !("error" in payload))
    return fallback;
  const error = payload.error;
  return typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : fallback;
}
async function requestPage(
  params: URLSearchParams,
  signal: AbortSignal,
): Promise<SourceEnvelope> {
  const response = await fetch(`/api/v1/sources?${params.toString()}`, {
    cache: "no-store",
    credentials: "same-origin",
    signal,
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("The source service returned an unreadable response.");
  }
  if (!response.ok)
    throw new Error(
      errorMessage(payload, `Unable to load sources (${response.status}).`),
    );
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("data" in payload) ||
    !Array.isArray(payload.data)
  )
    throw new Error("The source service returned an invalid response.");
  return payload as SourceEnvelope;
}

export function DataSourceExplorer() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const query = searchParams.get("q") ?? "";
  const access = searchParams.get("access") ?? "";
  const ingestion = searchParams.get("ingestion") ?? "";
  const companies = searchParams.get("companies") ?? "";
  const unminedOnly = searchParams.get("unmined") === "1";
  const [searchInput, setSearchInput] = useState(query);
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => setSearchInput(query), [query]);
  const replaceFilters = useCallback(
    (changes: Readonly<Record<string, string>>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(changes)) {
        if (value === "") next.delete(key);
        else next.set(key, value);
      }
      const serialized = next.toString();
      router.replace(
        serialized === "" ? pathname : `${pathname}?${serialized}`,
        { scroll: false },
      );
    },
    [pathname, router, searchParams],
  );

  useEffect(() => {
    const controller = new AbortController();
    async function load(): Promise<void> {
      setLoading(true);
      setLoadError(undefined);
      try {
        const request = new URLSearchParams({ page: "1", pageSize: "100" });
        if (query) request.set("query", query);
        if (access) request.set("access", access);
        if (ingestion) request.set("ingestionMethod", ingestion);
        const first = await requestPage(request, controller.signal);
        const rest = await Promise.all(
          Array.from(
            { length: Math.max(1, first.meta?.totalPages ?? 1) - 1 },
            (_, index) => {
              const next = new URLSearchParams(request);
              next.set("page", String(index + 2));
              return requestPage(next, controller.signal);
            },
          ),
        );
        setSources([...first.data, ...rest.flatMap((page) => page.data)]);
      } catch (error) {
        if (!controller.signal.aborted)
          setLoadError(
            error instanceof Error ? error.message : "Unable to load sources.",
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [access, ingestion, query, reloadKey]);

  const visible = useMemo(() => {
    let filtered = sources;
    if (companies === "zero")
      filtered = filtered.filter((source) => companyCount(source) === 0);
    if (unminedOnly) filtered = filtered.filter(isUnmined);
    return filtered;
  }, [companies, sources, unminedOnly]);
  const hasFilters = Boolean(
    query || access || ingestion || companies || unminedOnly,
  );
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    replaceFilters({ q: searchInput.trim() });
  }
  function clear() {
    setSearchInput("");
    router.replace(pathname, { scroll: false });
  }

  return (
    <section aria-labelledby="source-explorer-heading">
      <div className="admin-panel">
        <div className="admin-panel__header">
          <h2 id="source-explorer-heading">Source register</h2>
          <p className="asi-page-description">
            Filter recurring sources independently of company links. Counts show
            explicit links only; zero is a valid source state.
          </p>
        </div>
        <form className="admin-form-grid" onSubmit={submit} role="search">
          <div className="admin-field">
            <label className="admin-field__label" htmlFor="source-search">
              Search sources
            </label>
            <Input
              id="source-search"
              placeholder="Name, publisher, or URL"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              style={{ inlineSize: "100%" }}
            />
          </div>
          <div className="admin-field">
            <label className="admin-field__label" htmlFor="source-access">
              Access
            </label>
            <Select
              id="source-access"
              value={access}
              onChange={(event) =>
                replaceFilters({ access: event.target.value })
              }
              style={{ inlineSize: "100%" }}
            >
              <option value="">All access levels</option>
              {accessOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="admin-field">
            <label className="admin-field__label" htmlFor="source-ingestion">
              Ingestion policy
            </label>
            <Select
              id="source-ingestion"
              value={ingestion}
              onChange={(event) =>
                replaceFilters({ ingestion: event.target.value })
              }
              style={{ inlineSize: "100%" }}
            >
              <option value="">All ingestion policies</option>
              {ingestionOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="admin-field">
            <label className="admin-field__label" htmlFor="source-companies">
              Company links
            </label>
            <Select
              id="source-companies"
              value={companies}
              onChange={(event) =>
                replaceFilters({ companies: event.target.value })
              }
              style={{ inlineSize: "100%" }}
            >
              <option value="">Any link count</option>
              <option value="zero">Zero linked companies</option>
            </Select>
          </div>
          <div className="admin-field">
            <label className="admin-field__label" htmlFor="source-unmined">
              Unmined
            </label>
            <label
              style={{
                alignItems: "center",
                display: "inline-flex",
                gap: "var(--asi-space-2)",
              }}
            >
              <input
                checked={unminedOnly}
                id="source-unmined"
                onChange={(event) =>
                  replaceFilters({ unmined: event.target.checked ? "1" : "" })
                }
                type="checkbox"
              />
              Zero companies and documents
            </label>
          </div>
          <div className="admin-actions">
            <Button type="submit">Apply search</Button>
            {hasFilters ? (
              <Button type="button" variant="ghost" onClick={clear}>
                Clear filters
              </Button>
            ) : null}
          </div>
        </form>
      </div>
      <div
        aria-busy={loading || undefined}
        aria-live="polite"
        style={{ marginBlockStart: "var(--asi-space-12)" }}
      >
        {loading ? (
          <div className="admin-panel" role="status">
            Loading source register…
          </div>
        ) : loadError ? (
          <div className="admin-panel">
            <p className="admin-feedback" data-tone="error" role="alert">
              {loadError}
            </p>
            <div className="admin-actions">
              <Button
                variant="secondary"
                onClick={() => setReloadKey((value) => value + 1)}
              >
                Try again
              </Button>
            </div>
          </div>
        ) : visible.length === 0 ? (
          <EmptyState
            title={
              hasFilters
                ? "No sources match these filters"
                : "No sources registered"
            }
            description={
              <p>
                {hasFilters
                  ? "Clear a filter or broaden the source search."
                  : "Register source metadata first. A source does not need a company link."}
              </p>
            }
            action={
              hasFilters ? (
                <Button variant="secondary" onClick={clear}>
                  Clear filters
                </Button>
              ) : (
                <Link
                  className="asi-button"
                  data-size="medium"
                  data-variant="primary"
                  href="/data-sources/new"
                >
                  Add source
                </Link>
              )
            }
          />
        ) : (
          <Table>
            <TableCaption>
              Showing {visible.length} source{visible.length === 1 ? "" : "s"}
              {companies === "zero" ? " with zero company links" : ""}
              {unminedOnly ? " that are unmined" : ""}.
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Source</TableHead>
                <TableHead>Access</TableHead>
                <TableHead>Ingestion</TableHead>
                <TableHead>Model processing</TableHead>
                <TableHead>Status</TableHead>
                <TableHead numeric>Companies</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((source) => (
                <TableRow key={source.id}>
                  <TableCell>
                    <div className="admin-user-meta">
                      <Link href={`/data-sources/${source.id}`}>
                        <strong>{source.name}</strong>
                      </Link>
                      {source.description ? (
                        <span>{source.description}</span>
                      ) : null}
                      {source.homepageUrl ? (
                        <a
                          href={source.homepageUrl}
                          rel="noopener noreferrer"
                          target="_blank"
                        >
                          {source.homepageUrl}
                        </a>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge tone={accessTone(source.access)}>
                      {sourceAccessLabel(source.access)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge tone="info">
                      {sourceIngestionLabel(source.ingestionMethod)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {modelProcessingLabel(source) === null ? (
                      "—"
                    ) : (
                      <Badge
                        tone={modelProcessingLabel(source)
                          ?.startsWith("disabled")
                          ? "danger"
                          : "success"}
                      >
                        Model processing: {modelProcessingLabel(source)}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge>{source.status}</Badge>
                  </TableCell>
                  <TableCell numeric>{companyCount(source)}</TableCell>
                  <TableCell>
                    {new Date(source.updatedAt).toLocaleDateString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </section>
  );
}
