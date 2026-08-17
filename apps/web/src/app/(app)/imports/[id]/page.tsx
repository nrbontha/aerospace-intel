"use client";

import { Badge, EmptyState, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@asi/ui";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

type ImportDetail = Readonly<{
  id: string;
  fileName: string;
  status: string;
  storageKey: string;
  contentSha256: string;
  rowCount: number | null;
  importedCount: number;
  rejectedCount: number;
  error: unknown;
  createdAt: string;
  rows: readonly {
    id: string;
    rowNumber: number;
    status: string;
    targetEntityType: string | null;
    targetEntityId: string | null;
    errors: unknown;
  }[];
}>;

export default function ImportDetailPage() {
  const params = useParams<{ id: string }>();
  const [record, setRecord] = useState<ImportDetail>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      try {
        const response = await fetch(`/api/v1/imports/${params.id}`, {
          cache: "no-store",
          credentials: "same-origin",
          signal,
        });
        const payload: unknown = await response.json();
        if (!response.ok) throw new Error("Import not found");
        setRecord((payload as { data: ImportDetail }).data);
      } catch (caught) {
        if (signal.aborted) return;
        setError(caught instanceof Error ? caught.message : "Unable to load import");
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [params.id],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (loading) return <p className="asi-page-description" role="status">Loading import…</p>;
  if (error || !record) {
    return (
      <EmptyState
        title={error ?? "Import not found"}
        action={<Link href="/imports">Back to imports</Link>}
      />
    );
  }

  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">
          <Link href="/imports">Imports</Link> / batch
        </p>
        <h1 className="asi-page-title">{record.fileName}</h1>
        <Badge tone={record.status === "completed" ? "success" : "neutral"}>
          {record.status}
        </Badge>
      </header>
      <section className="admin-panel">
        <dl>
          <dt>SHA-256</dt>
          <dd>
            <code>{record.contentSha256}</code>
          </dd>
          <dt>Storage key</dt>
          <dd>
            <code>{record.storageKey}</code>
          </dd>
          <dt>Accepted / rejected</dt>
          <dd>
            {record.importedCount} / {record.rejectedCount}
          </dd>
        </dl>
      </section>
      <section className="admin-panel">
        <header className="admin-panel__header">
          <h2>Rows</h2>
        </header>
        {record.rows.length === 0 ? (
          <p className="asi-page-description">No row outcomes stored for this batch.</p>
        ) : (
          <Table>
            <TableCaption>{record.rows.length} stored rows</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Row</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Target</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {record.rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell numeric>{row.rowNumber}</TableCell>
                  <TableCell>{row.status}</TableCell>
                  <TableCell>
                    {row.targetEntityType
                      ? `${row.targetEntityType} ${row.targetEntityId ?? ""}`
                      : "None"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </>
  );
}
