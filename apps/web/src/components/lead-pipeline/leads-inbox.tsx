"use client";

import {
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
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { formatFederalUsd, LeadStatusChip } from "@/components/lead-pipeline/lead-bits";
import { LeadDrawer } from "@/components/lead-pipeline/lead-drawer";
import { LeadRowActions } from "@/components/lead-pipeline/lead-row-actions";
import { formatRelativeTime } from "@/components/research-control/format";
import {
  listLeads,
  type LeadRow,
  type ResolveDomainResult,
} from "@/lib/leads-api";

// ---------------------------------------------------------------------------
// Discovery inbox: server-paginated leads list with status chips, text search,
// manual refresh + 60s auto-poll. URL params are namespaced (leadQ /
// leadStatus / leadPage) because /feed shares its URL with the Targets table's
// saved views below — un-namespaced q/page would leak into those filters.
// ---------------------------------------------------------------------------

const PAGE_SIZE = 25;
const POLL_MS = 60_000;

/** Chip label → API status value ("All" clears the filter). */
const STATUS_FILTERS = [
  { label: "All", value: "" },
  { label: "Unresolved", value: "unresolved_lead" },
  { label: "Resolved", value: "resolved" },
  { label: "Discarded", value: "discarded" },
] as const;

type RowNote = Readonly<{ tone: "info" | "warning" | "success"; message: string }>;

export function LeadsInbox({ canOperate }: { canOperate: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const statusFilter = searchParams.get("leadStatus") ?? "";
  const textQuery = searchParams.get("leadQ") ?? "";
  const page = Number(searchParams.get("leadPage") ?? "1") || 1;

  const [rows, setRows] = useState<readonly LeadRow[]>([]);
  const [meta, setMeta] = useState<{
    totalItems: number;
    totalPages: number;
  }>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [notes, setNotes] = useState<ReadonlyMap<string, RowNote>>(new Map());
  const [drawerLeadId, setDrawerLeadId] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState(textQuery);

  const queryString = searchParams.toString();

  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const result = await listLeads(
          {
            page,
            pageSize: PAGE_SIZE,
            ...(statusFilter === ""
              ? {}
              : {
                  status: statusFilter as "unresolved_lead" | "resolved" | "discarded",
                }),
            ...(textQuery.trim() === "" ? {} : { q: textQuery }),
          },
          signal,
        );
        if (signal.aborted) return;
        setRows(result.data);
        setMeta({
          totalItems: result.meta?.totalItems ?? result.data.length,
          totalPages: result.meta?.totalPages ?? 1,
        });
      } catch (caught) {
        if (signal.aborted) return;
        setRows([]);
        setMeta(undefined);
        setError(
          caught instanceof Error ? caught.message : "Unable to load leads.",
        );
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [page, statusFilter, textQuery],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, reloadKey, queryString]);

  // Auto-poll: refresh the inbox every minute; pause while hidden.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible")
        setReloadKey((key) => key + 1);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, []);

  function patchParams(mutate: (params: URLSearchParams) => void): void {
    const params = new URLSearchParams(queryString);
    mutate(params);
    if ((params.get("leadStatus") ?? "") === "") params.delete("leadStatus");
    if ((params.get("leadQ") ?? "") === "") params.delete("leadQ");
    params.delete("leadPage");
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  function setStatusFilter(value: string): void {
    patchParams((params) => {
      if (value === "") params.delete("leadStatus");
      else params.set("leadStatus", value);
    });
  }

  function submitSearch(event: React.FormEvent): void {
    event.preventDefault();
    patchParams((params) => {
      if (searchDraft.trim() === "") params.delete("leadQ");
      else params.set("leadQ", searchDraft.trim());
    });
  }

  function setBusy(leadId: string, busy: boolean): void {
    setBusyIds((current) => {
      const next = new Set(current);
      if (busy) next.add(leadId);
      else next.delete(leadId);
      return next;
    });
  }

  function note(leadId: string, entry: RowNote | null): void {
    setNotes((current) => {
      const next = new Map(current);
      if (entry === null) next.delete(leadId);
      else next.set(leadId, entry);
      return next;
    });
  }

  /** Optimistic in-place patch; a background refetch confirms server truth. */
  function patchRow(leadId: string, mutate: (row: LeadRow) => LeadRow): void {
    setRows((current) =>
      current.map((row) => (row.id === leadId ? mutate(row) : row)),
    );
  }

  function handleResolved(leadId: string, result: ResolveDomainResult): void {
    setBusy(leadId, false);
    if (
      result.outcome === "domain_verified" ||
      result.outcome === "already_resolved"
    ) {
      patchRow(leadId, (row) => ({
        ...row,
        status: "resolved",
        possibleDomain:
          result.domain !== undefined ? result.domain : row.possibleDomain,
        resolvedCompanyId:
          result.companyId !== undefined ? result.companyId : row.resolvedCompanyId,
      }));
      note(leadId, {
        tone: "success",
        message:
          result.outcome === "already_resolved"
            ? `Already resolved${result.domain !== undefined ? ` → ${result.domain}` : ""}.`
            : `Verified ${result.domain ?? "domain"} — candidate queued for research.`,
      });
    } else if (result.outcome === "no_domain_found") {
      note(leadId, {
        tone: "info",
        message: `No verifiable site found (${result.attempts?.length ?? 0} attempt${
          (result.attempts?.length ?? 0) === 1 ? "" : "s"
        }).`,
      });
    } else {
      note(leadId, {
        tone: "warning",
        message: `Candidate sites found but none matched the identity (${result.attempts?.length ?? 0} attempt${
          (result.attempts?.length ?? 0) === 1 ? "" : "s"
        }).`,
      });
    }
    setReloadKey((key) => key + 1);
  }

  function handleDiscarded(leadId: string): void {
    setBusy(leadId, false);
    patchRow(leadId, (row) => ({ ...row, status: "discarded" }));
    note(leadId, { tone: "success", message: "Lead discarded." });
    setReloadKey((key) => key + 1);
  }

  function handleFailed(leadId: string, message: string): void {
    setBusy(leadId, false);
    note(leadId, { tone: "warning", message });
  }

  const drawerLead =
    drawerLeadId !== null
      ? rows.find((row) => row.id === drawerLeadId) ?? null
      : null;
  const refreshing = loading && rows.length > 0;
  const anyFilter = statusFilter !== "" || textQuery !== "";

  return (
    <section aria-label="Discovery inbox">
      <div className="admin-panel">
        <header className="admin-panel__header">
          <h2>Discovery inbox</h2>
          <p className="asi-page-description">
            Raw leads from discovery agents (USAspending and friends). Resolving
            a domain verifies the company identity and seeds a target candidate
            automatically.
          </p>
        </header>
        <div className="admin-actions" role="group" aria-label="Lead status filter">
          {STATUS_FILTERS.map((filter) => (
            <Button
              key={filter.label}
              aria-pressed={statusFilter === filter.value}
              size="small"
              variant={
                statusFilter === filter.value ||
                (filter.value === "" && statusFilter === "")
                  ? "secondary"
                  : "ghost"
              }
              onClick={() => setStatusFilter(filter.value)}
            >
              {filter.label}
            </Button>
          ))}
          <form role="search" onSubmit={submitSearch} style={{ display: "inline-flex", gap: "0.5rem" }}>
            <label className="admin-field" htmlFor="lead-search">
              <span className="admin-field__label">Search</span>
              <Input
                id="lead-search"
                maxLength={200}
                onChange={(event) => setSearchDraft(event.target.value)}
                placeholder="Company name"
                value={searchDraft}
              />
            </label>
            <Button size="small" type="submit" variant="secondary">
              Search
            </Button>
          </form>
          <Button
            aria-label="Refresh leads"
            disabled={refreshing}
            size="small"
            variant="ghost"
            onClick={() => setReloadKey((key) => key + 1)}
          >
            {refreshing ? "Refreshing…" : "↻ Refresh"}
          </Button>
        </div>
      </div>

      {error !== null ? (
        <div className="admin-feedback" data-tone="error" role="alert">
          <p>{error}</p>
          <Button
            size="small"
            variant="secondary"
            onClick={() => setReloadKey((key) => key + 1)}
          >
            Try again
          </Button>
        </div>
      ) : null}

      {!loading && rows.length === 0 ? (
        <EmptyState
          description={
            anyFilter
              ? "Clear or change the filters to see other leads."
              : "Discovery agents populate this inbox — no fake or sample rows are shown."
          }
          title={anyFilter ? "No leads match this filter" : "No leads yet"}
        />
      ) : null}

      {rows.length > 0 ? (
        <>
          <Table>
            <TableCaption>
              {meta
                ? `${meta.totalItems.toLocaleString()} lead${
                    meta.totalItems === 1 ? "" : "s"
                  }; page ${page} of ${Math.max(meta.totalPages, 1)}`
                : "Discovered leads"}
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Company</TableHead>
                <TableHead numeric>Federal $</TableHead>
                <TableHead numeric>Awards</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Discovered</TableHead>
                {canOperate ? <TableHead>Actions</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((lead) => {
                const busy = busyIds.has(lead.id);
                const rowNote = notes.get(lead.id);
                return (
                  <TableRow
                    key={lead.id}
                    aria-label={`Open ${lead.rawName} detail`}
                    style={{ cursor: "pointer" }}
                    onClick={() => setDrawerLeadId(lead.id)}
                  >
                    <TableCell>
                      <strong>{lead.rawName}</strong>
                      {rowNote !== undefined ? (
                        <span
                          className="asi-page-description"
                          data-tone={rowNote.tone}
                          role="status"
                          style={{ display: "block" }}
                        >
                          {rowNote.message}
                        </span>
                      ) : null}
                      {busy ? (
                        <span className="asi-page-description" role="status">
                          Resolving…
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell numeric>
                      {formatFederalUsd(
                        typeof lead.context.totalAwardValueUsd === "number"
                          ? lead.context.totalAwardValueUsd
                          : null,
                      )}
                    </TableCell>
                    <TableCell numeric>
                      {typeof lead.context.awardCount === "number"
                        ? String(lead.context.awardCount)
                        : "—"}
                    </TableCell>
                    <TableCell>
                      <LeadStatusChip row={lead} />
                    </TableCell>
                    <TableCell>{formatRelativeTime(lead.createdAt)}</TableCell>
                    {canOperate ? (
                      <TableCell onClick={(event) => event.stopPropagation()}>
                        <LeadRowActions
                          busy={busy}
                          lead={lead}
                          onDiscarded={handleDiscarded}
                          onFailed={handleFailed}
                          onResolved={handleResolved}
                        />
                      </TableCell>
                    ) : null}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <nav className="admin-actions" aria-label="Lead pagination">
            <Button
              size="small"
              variant="secondary"
              disabled={page <= 1}
              onClick={() =>
                patchParams((params) =>
                  params.set("leadPage", String(Math.max(1, page - 1))),
                )
              }
            >
              Previous
            </Button>
            <span className="asi-page-description" aria-live="polite">
              Page {page} of {Math.max(meta?.totalPages ?? 1, 1)}
            </span>
            <Button
              size="small"
              variant="secondary"
              disabled={!meta || page >= meta.totalPages}
              onClick={() =>
                patchParams((params) =>
                  params.set("leadPage", String(page + 1)),
                )
              }
            >
              Next
            </Button>
          </nav>
        </>
      ) : null}

      {drawerLead !== null ? (
        <LeadDrawer
          busy={busyIds.has(drawerLead.id)}
          canOperate={canOperate}
          lead={drawerLead}
          onClose={() => setDrawerLeadId(null)}
          onDiscarded={handleDiscarded}
          onFailed={handleFailed}
          onResolved={handleResolved}
        />
      ) : null}
    </section>
  );
}
