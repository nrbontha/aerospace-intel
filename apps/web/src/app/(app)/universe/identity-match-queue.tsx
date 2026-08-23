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
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { ApiRequestError, apiJson } from "@/components/csrf-client";

type MatchRecord = Readonly<{
  id: string;
  leadId: string;
  companyId: string;
  leadRawName: string;
  leadStatus: string;
  companyDisplayName: string;
  signalType: string;
  confidence: number | string;
  explanation: string | null;
  decision: string;
  createdAt: string;
}>;

type PageMeta = Readonly<{
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}>;

type Envelope = Readonly<{ data: MatchRecord[]; meta: PageMeta }>;

const decisions = [
  { value: "merged", label: "Merge" },
  { value: "alias", label: "Alias" },
  { value: "parent_subsidiary", label: "Parent / subsidiary" },
  { value: "acquired_into", label: "Acquired into" },
  { value: "rejected_merge", label: "Reject" },
] as const;

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
  return `Unable to load the match queue (${status}).`;
}

/**
 * Probable-match review queue (GET /api/v1/identity-matches defaults to the
 * pending decision state). Analyst/admin decisions PATCH
 * /api/v1/identity-matches/[id]; viewers get a read-only list.
 */
export function IdentityMatchQueue(props: { canDecide: boolean }) {
  const [records, setRecords] = useState<MatchRecord[]>([]);
  const [meta, setMeta] = useState<PageMeta>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [decidingId, setDecidingId] = useState<string>();
  const [actionError, setActionError] = useState<string>();

  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch(
        "/api/v1/identity-matches?pageSize=50",
        { cache: "no-store", signal },
      );
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(errorMessage(payload, response.status));
      const envelope = payload as Envelope;
      setRecords(envelope.data ?? []);
      setMeta(envelope.meta);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : "Unable to load queue");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const decide = useCallback(
    async (record: MatchRecord, decision: string) => {
      setDecidingId(record.id);
      setActionError(undefined);
      try {
        await apiJson(`/api/v1/identity-matches/${record.id}`, {
          body: JSON.stringify({ decision }),
          headers: { "Content-Type": "application/json" },
          method: "PATCH",
        });
        setRecords((rows) => rows.filter((row) => row.id !== record.id));
        setMeta((currentMeta) =>
          currentMeta === undefined
            ? undefined
            : { ...currentMeta, totalItems: Math.max(0, currentMeta.totalItems - 1) },
        );
      } catch (cause) {
        setActionError(
          cause instanceof ApiRequestError
            ? cause.message
            : `Unable to record decision (${String(decision)}).`,
        );
      } finally {
        setDecidingId(undefined);
      }
    },
    [],
  );

  if (loading) {
    return (
      <div className="admin-panel" role="status">
        Loading probable matches…
      </div>
    );
  }

  if (error !== undefined) {
    return (
      <div className="admin-panel" role="alert">
        {error}
      </div>
    );
  }

  return (
    <section aria-labelledby="identity-review-heading" className="admin-panel">
      <header className="admin-panel__header">
        <h2 id="identity-review-heading">Probable-match queue</h2>
      </header>
      <p>
        Leads whose identity signals matched an existing company. “Merge”
        resolves the lead onto the matched company; every other decision only
        closes the review.
      </p>
      {actionError !== undefined ? (
        <p role="alert">{actionError}</p>
      ) : null}
      <Table>
        <TableCaption>
          {meta === undefined
            ? `${records.length} pending match${records.length === 1 ? "" : "es"}.`
            : `${meta.totalItems} pending match${
                meta.totalItems === 1 ? "" : "es"
              }. Decisions are audited.`}
        </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Lead</TableHead>
            <TableHead scope="col">Matched company</TableHead>
            <TableHead scope="col">Signal</TableHead>
            <TableHead scope="col">Confidence</TableHead>
            <TableHead scope="col">Explanation</TableHead>
            {props.canDecide ? (
              <TableHead scope="col">Actions</TableHead>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {records.map((record) => (
            <TableRow key={record.id}>
              <TableCell>{record.leadRawName}</TableCell>
              <TableCell>
                <Link href={`/companies/${record.companyId}`}>
                  {record.companyDisplayName}
                </Link>
              </TableCell>
              <TableCell>
                <Badge tone="info">{record.signalType}</Badge>
              </TableCell>
              <TableCell>
                {Number(record.confidence).toFixed(2)}
              </TableCell>
              <TableCell>{record.explanation ?? "—"}</TableCell>
              {props.canDecide ? (
                <TableCell>
                  {decisions.map((decision) => (
                    <Button
                      data-size="small"
                      data-variant={
                        decision.value === "merged" ? "primary" : "ghost"
                      }
                      disabled={decidingId !== undefined}
                      key={decision.value}
                      onClick={() => void decide(record, decision.value)}
                      type="button"
                    >
                      {decision.label}
                    </Button>
                  ))}
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {records.length === 0 ? (
        <EmptyState
          description="New probable matches appear here when lead ingest finds signals against known companies."
          title="No pending identity matches"
        />
      ) : null}
    </section>
  );
}
