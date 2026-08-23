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
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import {
  getSnapshotDetail,
  listSnapshots,
  searchKnownUniverse,
  type MatchBreakdown,
  type NoveltySearchResult,
  type SnapshotRecord,
} from "@/lib/product-api";

function matchTone(
  status: string,
): "success" | "warning" | "info" | "danger" | "neutral" {
  if (status === "exact") return "success";
  if (status === "probable") return "warning";
  if (status === "possible") return "info";
  if (status === "unresolved") return "danger";
  return "neutral";
}

/** Proportional exact/probable/none bar. Segments without hits collapse. */
function MiniBar(props: { breakdown: MatchBreakdown; total: number }) {
  const { breakdown, total } = props;
  if (total <= 0) return <span>—</span>;
  const segments = (
    [
      { color: "var(--asi-success)", count: breakdown["exact"] ?? 0 },
      { color: "var(--asi-warning)", count: breakdown["probable"] ?? 0 },
      { color: "var(--asi-border-strong)", count: breakdown["none"] ?? 0 },
    ] as const
  ).filter((segment) => segment.count > 0);
  return (
    <span
      aria-label={`exact ${breakdown["exact"] ?? 0}, probable ${breakdown["probable"] ?? 0}, none ${breakdown["none"] ?? 0}`}
      role="img"
      style={{
        display: "inline-flex",
        inlineSize: "9rem",
        blockSize: "0.5rem",
        overflow: "hidden",
        borderRadius: "var(--asi-radius-sm)",
        border: "var(--asi-border-width) solid var(--asi-border)",
      }}
    >
      {segments.map((segment) => (
        <span
          key={segment.color}
          style={{
            background: segment.color,
            inlineSize: `${(segment.count / total) * 100}%`,
          }}
        />
      ))}
    </span>
  );
}

function NoveltyResult(props: { result: NoveltySearchResult }) {
  const { result } = props;
  const companies = result.results.filter(
    (hit): hit is Extract<typeof hit, { kind: "company" }> =>
      hit.kind === "company",
  );
  const members = result.results.filter(
    (hit): hit is Extract<typeof hit, { kind: "known_universe_member" }> =>
      hit.kind === "known_universe_member",
  );
  return (
    <div style={{ display: "grid", gap: "var(--asi-space-8)" }}>
      {result.summary.novel ? (
        <div
          className="admin-panel"
          data-tone="success"
          style={{
            borderInlineStart:
              "0.25rem solid var(--asi-success)",
          }}
        >
          <strong>NOVEL</strong>
          <p className="asi-page-description">
            No member of any active snapshot and no canonical company matches{" "}
            “{result.query.q ?? result.query.domain}”.
          </p>
        </div>
      ) : null}
      {members.length > 0 ? (
        <div
          className="admin-panel"
          style={{
            borderInlineStart: "0.25rem solid var(--asi-warning)",
          }}
        >
          <strong>KNOWN IN SNAPSHOT({members.length === 1 ? "" : "S"})</strong>
          <ul style={{ marginBlockStart: "var(--asi-space-4)" }}>
            {members.map((member) => (
              <li key={member.memberId}>
                <code>{member.snapshotKey}</code> · {member.rawName}
                <Badge style={{ marginInlineStart: "var(--asi-space-2)" }} tone={matchTone(member.matchStatus)}>
                  {member.matchStatus}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {companies.length > 0 ? (
        <div className="admin-panel">
          <strong>CATALOG HIT{companies.length === 1 ? "" : "S"}</strong>
          <Table>
            <TableCaption>{companies.length} matching compan{companies.length === 1 ? "y" : "ies"} in the catalog.</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Company</TableHead>
                <TableHead>Legal name</TableHead>
                <TableHead>Domain</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {companies.map((company) => (
                <TableRow key={company.companyId}>
                  <TableCell>
                    <Link href={`/companies/${company.companyId}`}>
                      {company.displayName}
                    </Link>
                  </TableCell>
                  <TableCell>{company.legalName}</TableCell>
                  <TableCell>{company.domain ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </div>
  );
}

export function KnownUniverseSnapshots() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const noveltyQuery = searchParams.get("q") ?? "";
  const [searchInput, setSearchInput] = useState(noveltyQuery);
  const [snapshots, setSnapshots] = useState<SnapshotRecord[]>([]);
  const [breakdowns, setBreakdowns] = useState<
    Readonly<Record<string, MatchBreakdown>>
  >({});
  const [novelty, setNovelty] = useState<NoveltySearchResult>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();

  useEffect(() => setSearchInput(noveltyQuery), [noveltyQuery]);

  useEffect(() => {
    const controller = new AbortController();
    async function load(): Promise<void> {
      setLoading(true);
      setLoadError(undefined);
      try {
        const envelope = await listSnapshots(controller.signal);
        setSnapshots(envelope.data);
        const details = await Promise.all(
          envelope.data.map(async (snapshot) => {
            // Only the match breakdown is needed; page size 1 keeps it light.
            const detail = await getSnapshotDetail(
              snapshot.id,
              { pageSize: 1 },
              controller.signal,
            );
            return [snapshot.id, detail.matchBreakdown] as const;
          }),
        );
        setBreakdowns(Object.fromEntries(details));
      } catch (error) {
        if (!controller.signal.aborted)
          setLoadError(
            error instanceof Error ? error.message : "Unable to load snapshots.",
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (noveltyQuery.length < 2) {
      setNovelty(undefined);
      return;
    }
    const controller = new AbortController();
    searchKnownUniverse({ q: noveltyQuery }, controller.signal)
      .then(setNovelty)
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setLoadError(
            error instanceof Error ? error.message : "Novelty search failed.",
          );
      });
    return () => controller.abort();
  }, [noveltyQuery]);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const value = searchInput.trim();
    router.replace(value === "" ? pathname : `${pathname}?q=${encodeURIComponent(value)}`, {
      scroll: false,
    });
  }

  return (
    <>
      <div className="admin-panel">
        <div className="admin-panel__header">
          <h2 id="novelty-search-heading">Novelty search</h2>
          <p className="asi-page-description">
            Check one name against active snapshots and the canonical catalog.
          </p>
        </div>
        <form
          aria-labelledby="novelty-search-heading"
          className="admin-form-grid"
          onSubmit={submit}
          role="search"
        >
          <div className="admin-field">
            <label className="admin-field__label" htmlFor="novelty-search">
              Company name or domain
            </label>
            <Input
              id="novelty-search"
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="e.g. Skybolt Aerospace Fasteners"
              style={{ inlineSize: "100%" }}
              value={searchInput}
            />
          </div>
          <div className="admin-actions">
            <Button type="submit">Check</Button>
          </div>
        </form>
      </div>
      {novelty ? (
        <div style={{ marginBlockStart: "var(--asi-space-12)" }}>
          <NoveltyResult result={novelty} />
        </div>
      ) : null}
      <div aria-busy={loading} aria-live="polite" style={{ marginBlockStart: "var(--asi-space-12)" }}>
        {loading ? (
          <div className="admin-panel" role="status">
            Loading snapshots…
          </div>
        ) : loadError ? (
          <div className="admin-panel">
            <p className="admin-feedback" data-tone="error" role="alert">
              {loadError}
            </p>
          </div>
        ) : snapshots.length === 0 ? (
          <EmptyState
            description={
              <p>Import a workbook or pipeline export to build a snapshot.</p>
            }
            title="No known-universe snapshots"
          />
        ) : (
          <Table>
            <TableCaption>
              {snapshots.length} snapshot{snapshots.length === 1 ? "" : "s"}.
              Bar shows exact / probable / none member match shares.
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Effective</TableHead>
                <TableHead numeric>Rows</TableHead>
                <TableHead>Active</TableHead>
                <TableHead>Matches</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {snapshots.map((snapshot) => (
                <TableRow key={snapshot.id}>
                  <TableCell>
                    <Link href={`/known-universe/${snapshot.id}`}>
                      <code>{snapshot.key}</code>
                    </Link>
                  </TableCell>
                  <TableCell>{snapshot.name}</TableCell>
                  <TableCell>{snapshot.sourceType}</TableCell>
                  <TableCell>{snapshot.effectiveDate ?? "—"}</TableCell>
                  <TableCell numeric>{snapshot.rowCount}</TableCell>
                  <TableCell>
                    <Badge tone={snapshot.active ? "success" : "neutral"}>
                      {snapshot.active ? "active" : "inactive"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <MiniBar
                      breakdown={breakdowns[snapshot.id] ?? {}}
                      total={snapshot.rowCount}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </>
  );
}

