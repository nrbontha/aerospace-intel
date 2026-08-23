"use client";

import { campaignStatusValues } from "@asi/contracts";
import {
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  CampaignStatusBadge,
  SpendMeter,
  formatTimestamp,
  frontierBreakdownSummary,
  truncate,
} from "@/components/campaigns/campaign-bits";
import { NewCampaignDrawer } from "@/components/campaigns/new-campaign-drawer";
import { humanLabel } from "@/components/target-feed/candidate-bits";
import {
  type CampaignRecord,
  getCampaignDetail,
  listCampaigns,
} from "@/lib/campaigns-api";

type FrontierCounts = Record<string, number>;

export function CampaignsExplorer({ canOperate }: { canOperate: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const statusFilter = searchParams.get("status") ?? "";
  const nameQuery = searchParams.get("q") ?? "";
  const page = Number(searchParams.get("page") ?? "1") || 1;
  const queryString = searchParams.toString();

  const [rows, setRows] = useState<CampaignRecord[]>([]);
  const [counts, setCounts] = useState<Map<string, FrontierCounts>>(new Map());
  const [meta, setMeta] = useState<{ totalItems: number; totalPages: number }>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const rowRefs = useRef<Array<HTMLTableRowElement | null>>([]);

  const visibleRows = useMemo(() => {
    const query = nameQuery.trim().toLocaleLowerCase("en-US");
    if (query === "") return rows;
    return rows.filter((campaign) =>
      campaign.name.toLocaleLowerCase("en-US").includes(query),
    );
  }, [rows, nameQuery]);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const result = await listCampaigns(page, signal);
        if (signal.aborted) return;
        setRows(result.data);
        setMeta({
          totalItems: result.meta?.totalItems ?? result.data.length,
          totalPages: result.meta?.totalPages ?? 1,
        });
        // The list endpoint does not include frontier counts; hydrate them
        // per campaign in parallel so the breakdown column stays honest.
        const details = await Promise.allSettled(
          result.data.map((campaign) => getCampaignDetail(campaign.id, signal)),
        );
        if (signal.aborted) return;
        const nextCounts = new Map<string, FrontierCounts>();
        details.forEach((detail, index) => {
          const campaign = result.data[index];
          if (campaign === undefined) return;
          if (detail.status === "fulfilled") {
            nextCounts.set(
              campaign.id,
              detail.value.frontierBreakdown as FrontierCounts,
            );
          }
        });
        setCounts(nextCounts);
      } catch (caught) {
        if (signal.aborted) return;
        setRows([]);
        setMeta(undefined);
        setError(
          caught instanceof Error ? caught.message : "Unable to load campaigns.",
        );
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [page],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, reloadKey, queryString]);

  function replaceFilters(changes: Readonly<Record<string, string>>): void {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === "") params.delete(key);
      else params.set(key, value);
    }
    const serialized = params.toString();
    router.replace(
      serialized === "" ? pathname : `${pathname}?${serialized}`,
      { scroll: false },
    );
  }

  function moveCursor(next: number): void {
    const bounded = Math.max(0, Math.min(rows.length - 1, next));
    rowRefs.current[bounded]?.focus();
  }

  const hasFilters = statusFilter !== "" || page > 1;

  return (
    <section aria-labelledby="campaigns-heading">
      <div className="admin-panel">
        <header className="admin-panel__header">
          <h2 id="campaigns-heading">Research campaigns</h2>
          <p className="asi-page-description">
            Discovery frontiers and their lifecycle. j / k or the arrow keys
            move between rows; Enter opens the campaign.
          </p>
        </header>
        <form
          className="admin-form-grid"
          role="search"
          onSubmit={(event) => event.preventDefault()}
        >
          <label className="admin-field" htmlFor="campaign-status-filter">
            <span className="admin-field__label">Status</span>
            <Select
              id="campaign-status-filter"
              onChange={(event) =>
                replaceFilters({ status: event.target.value })
              }
              value={statusFilter}
            >
              <option value="">All statuses</option>
              {campaignStatusValues.map((value) => (
                <option key={value} value={value}>
                  {humanLabel(value)}
                </option>
              ))}
            </Select>
          </label>
          <label className="admin-field" htmlFor="campaign-search">
            <span className="admin-field__label">Filter by name (this page)</span>
            {/* The list API has no query parameter yet, so the name filter
                runs client-side over the current page. */}
            <Input
              id="campaign-search"
              maxLength={200}
              onChange={(event) => replaceFilters({ q: event.target.value })}
              placeholder="Campaign name"
              value={nameQuery}
            />
          </label>
          <div className="admin-actions">
            {canOperate ? (
              <Button onClick={() => setDrawerOpen(true)} type="button">
                New campaign
              </Button>
            ) : null}
            {hasFilters ? (
              <Button
                onClick={() => replaceFilters({ status: "", page: "" })}
                type="button"
                variant="ghost"
              >
                Clear filters
              </Button>
            ) : null}
          </div>
        </form>
      </div>

      {error !== null ? (
        <div className="admin-panel" style={{ marginBlockStart: "var(--asi-space-12)" }}>
          <p className="admin-feedback" data-tone="error" role="alert">
            {error}
          </p>
          <div className="admin-actions">
            <Button
              onClick={() => setReloadKey((key) => key + 1)}
              variant="secondary"
            >
              Try again
            </Button>
          </div>
        </div>
      ) : loading && rows.length === 0 ? (
        <div className="admin-panel" role="status" style={{ marginBlockStart: "var(--asi-space-12)" }}>
          Loading campaigns…
        </div>
      ) : visibleRows.length === 0 ? (
        <div style={{ marginBlockStart: "var(--asi-space-12)" }}>
          <EmptyState
            title={
              hasFilters
                ? "No campaigns match these filters"
                : "No research campaigns yet"
            }
          >
            {hasFilters || !canOperate
              ? null
              : "Create a campaign to start a discovery frontier."}
          </EmptyState>
        </div>
      ) : (
        <Table>
          <TableCaption>
            {visibleRows.length} campaign
            {visibleRows.length === 1 ? "" : "s"} loaded
            {meta ? ` · ${meta.totalItems} total` : ""}.
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Objective</TableHead>
              <TableHead>Versions</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Spend / budget</TableHead>
              <TableHead>Frontier</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleRows.map((campaign, index) => (
              <TableRow
                key={campaign.id}
                onKeyDown={(event) => {
                  if (event.key === "j" || event.key === "ArrowDown") {
                    event.preventDefault();
                    moveCursor(index + 1);
                  } else if (event.key === "k" || event.key === "ArrowUp") {
                    event.preventDefault();
                    moveCursor(index - 1);
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    router.push(`/campaigns/${campaign.id}`);
                  }
                }}
                ref={(node) => {
                  rowRefs.current[index] = node;
                }}
                style={{ cursor: "pointer" }}
                tabIndex={0}
              >
                <TableCell>
                  <Link href={`/campaigns/${campaign.id}`}>
                    <strong>{campaign.name}</strong>
                  </Link>
                </TableCell>
                <TableCell title={campaign.objective ?? undefined}>
                  {campaign.objective === null
                    ? "—"
                    : truncate(campaign.objective, 60)}
                </TableCell>
                <TableCell>
                  <span style={{ whiteSpace: "nowrap" }}>
                    {campaign.thesisVersion} · {campaign.policyVersion}
                  </span>
                </TableCell>
                <TableCell>
                  <CampaignStatusBadge status={campaign.status} />
                </TableCell>
                <TableCell>
                  <SpendMeter
                    budgetUsd={campaign.budgetUsd}
                    compact
                    spendUsd={campaign.spendUsd}
                  />
                </TableCell>
                <TableCell>
                  {counts.has(campaign.id)
                    ? frontierBreakdownSummary(counts.get(campaign.id) ?? {})
                    : "…"}
                </TableCell>
                <TableCell>{formatTimestamp(campaign.createdAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {meta !== undefined && meta.totalPages > 1 ? (
        <nav aria-label="Campaign pages" className="admin-actions">
          <Button
            disabled={page <= 1}
            onClick={() => replaceFilters({ page: String(page - 1) })}
            size="small"
            variant="secondary"
          >
            Previous
          </Button>
          <span className="asi-page-description">
            Page {page} of {meta.totalPages}
          </span>
          <Button
            disabled={page >= meta.totalPages}
            onClick={() => replaceFilters({ page: String(page + 1) })}
            size="small"
            variant="secondary"
          >
            Next
          </Button>
        </nav>
      ) : null}

      <NewCampaignDrawer
        onClose={() => setDrawerOpen(false)}
        onCreated={() => setReloadKey((key) => key + 1)}
        open={drawerOpen}
      />
    </section>
  );
}


