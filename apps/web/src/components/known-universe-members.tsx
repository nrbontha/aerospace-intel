"use client";

import type { SnapshotMemberMatchStatus } from "@asi/contracts";
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
import { useCallback, useEffect, useState } from "react";

import {
  getSnapshotDetail,
  type SnapshotDetail,
} from "@/lib/product-api";

const MATCH_STATUSES: readonly SnapshotMemberMatchStatus[] = [
  "exact",
  "probable",
  "possible",
  "none",
  "unresolved",
];

function matchTone(
  status: SnapshotMemberMatchStatus,
): "success" | "warning" | "info" | "danger" | "neutral" {
  if (status === "exact") return "success";
  if (status === "probable") return "warning";
  if (status === "possible") return "info";
  if (status === "unresolved") return "danger";
  return "neutral";
}

export function KnownUniverseMembers(props: { snapshotId: string }) {
  const { snapshotId } = props;
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const page = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);
  const matchStatus = searchParams.get("match") ?? "";
  const query = searchParams.get("q") ?? "";

  const [searchInput, setSearchInput] = useState(query);
  const [detail, setDetail] = useState<SnapshotDetail>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();

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
        setDetail(
          await getSnapshotDetail(
            snapshotId,
            {
              matchStatus: matchStatus || undefined,
              page,
              pageSize: 25,
              query: query || undefined,
            },
            controller.signal,
          ),
        );
      } catch (error) {
        if (!controller.signal.aborted)
          setLoadError(
            error instanceof Error ? error.message : "Unable to load members.",
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [matchStatus, page, query, snapshotId]);

  if (!detail && loading) {
    return (
      <div className="admin-panel" role="status">
        Loading snapshot members…
      </div>
    );
  }
  if (loadError && !detail) {
    return (
      <div className="admin-panel">
        <p className="admin-feedback" data-tone="error" role="alert">
          {loadError}
        </p>
        <div className="admin-actions">
          <Button onClick={() => replaceFilters({})} variant="secondary">
            Try again
          </Button>
          <Link className="asi-button" data-variant="secondary" href="/known-universe">
            All snapshots
          </Link>
        </div>
      </div>
    );
  }

  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">Known Universe snapshot</p>
        <h1 className="asi-page-title">{detail?.snapshot.name ?? "Members"}</h1>
        <p className="asi-page-description">
          <code>{detail?.snapshot.key}</code> · {detail?.snapshot.sourceType} ·
          effective {detail?.snapshot.effectiveDate ?? "—"} ·{" "}
          {detail?.totalMembers ?? 0} member rows ·{" "}
          {detail?.snapshot.active ? "active" : "inactive"}
        </p>
      </header>
      <div className="admin-panel">
        <form
          className="admin-form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            replaceFilters({ page: "1", q: searchInput.trim() });
          }}
          role="search"
        >
          <div className="admin-field">
            <label className="admin-field__label" htmlFor="member-search">
              Search members
            </label>
            <Input
              id="member-search"
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Raw name or domain"
              style={{ inlineSize: "100%" }}
              value={searchInput}
            />
          </div>
          <div className="admin-field">
            <label className="admin-field__label" htmlFor="member-match">
              Match status
            </label>
            <Select
              id="member-match"
              onChange={(event) =>
                replaceFilters({
                  match: event.target.value,
                  page: "1",
                })
              }
              style={{ inlineSize: "100%" }}
              value={matchStatus}
            >
              <option value="">All matches</option>
              {MATCH_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </div>
          <div className="admin-actions">
            <Button type="submit">Apply search</Button>
            <Link
              className="asi-button"
              data-size="medium"
              data-variant="ghost"
              href="/known-universe"
            >
              All snapshots
            </Link>
          </div>
        </form>
      </div>
      <div aria-busy={loading} aria-live="polite" style={{ marginBlockStart: "var(--asi-space-12)" }}>
        {detail === undefined ? null : detail.members.length === 0 ? (
          <EmptyState title="No members match these filters" />
        ) : (
          <Table>
            <TableCaption>
              Page {detail.membersPage.page} of{" "}
              {Math.max(1, detail.membersPage.totalPages)} ·{" "}
              {detail.membersPage.totalItems} members
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Raw name</TableHead>
                <TableHead>Domain</TableHead>
                <TableHead>Match</TableHead>
                <TableHead>Matched company</TableHead>
                <TableHead>Payload</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.members.map((member) => (
                <TableRow key={member.id}>
                  <TableCell>
                    <strong>{member.rawName}</strong>
                  </TableCell>
                  <TableCell>{member.rawDomain ?? "—"}</TableCell>
                  <TableCell>
                    <Badge tone={matchTone(member.matchStatus)}>
                      {member.matchStatus}
                      {member.matchConfidence !== null
                        ? ` ${Math.round(member.matchConfidence * 100)}%`
                        : ""}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {member.matchedCompanyId ? (
                      <Link href={`/companies/${member.matchedCompanyId}`}>
                        Open company
                      </Link>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    <details>
                      <summary>raw_payload</summary>
                      <pre
                        style={{
                          fontSize: "var(--asi-text-xs)",
                          fontFamily: "var(--asi-font-mono)",
                          maxBlockSize: "16rem",
                          maxInlineSize: "36rem",
                          overflow: "auto",
                        }}
                      >
                        {JSON.stringify(member.rawPayload, null, 2)}
                      </pre>
                    </details>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {detail === undefined ? null : (
          <div className="admin-actions" style={{ marginBlockStart: "var(--asi-space-8)" }}>
            <Button
              disabled={page <= 1 || loading}
              onClick={() => replaceFilters({ page: String(page - 1) })}
              variant="secondary"
            >
              Previous page
            </Button>
            <Button
              disabled={
                loading ||
                detail.membersPage.totalPages === 0 ||
                page >= detail.membersPage.totalPages
              }
              onClick={() => replaceFilters({ page: String(page + 1) })}
              variant="secondary"
            >
              Next page
            </Button>
          </div>
        )}
      </div>
    </>
  );
}
