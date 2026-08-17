"use client";

import { Button, EmptyState, Input, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@asi/ui";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { apiJson } from "@/components/csrf-client";

type MergeRecord = Readonly<{
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  status: "applied" | "reverted";
  reason: string;
  mergedAt: string;
  revertedAt: string | null;
}>;

type CompanyMergeActionProps = Readonly<{
  companyId: string;
  companyName: string;
  canMerge: boolean;
  canRevert: boolean;
}>;

export function CompanyMergeAction({
  companyId,
  companyName,
  canMerge,
  canRevert,
}: CompanyMergeActionProps) {
  const [targetCompanyId, setTargetCompanyId] = useState("");
  const [reason, setReason] = useState("");
  const [revertReason, setRevertReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [merges, setMerges] = useState<MergeRecord[]>([]);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const response = await fetch(
        `/api/v1/merges?companyId=${encodeURIComponent(companyId)}&pageSize=25`,
        signal
          ? { cache: "no-store", credentials: "same-origin", signal }
          : { cache: "no-store", credentials: "same-origin" },
      );
      const payload = (await response.json()) as {
        data?: MergeRecord[];
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new Error(payload.error?.message ?? `Unable to load merges (${response.status})`);
      }
      setMerges(payload.data ?? []);
    },
    [companyId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch((caught: unknown) => {
      if (!controller.signal.aborted) {
        setError(caught instanceof Error ? caught.message : "Unable to load merges");
      }
    });
    return () => controller.abort();
  }, [load]);

  async function onMerge(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await apiJson<{ mergeId: string }>("/api/v1/merges", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceCompanyId: companyId,
          targetCompanyId: targetCompanyId.trim(),
          reason: reason.trim(),
        }),
      });
      setNotice(`Merge recorded (${result.mergeId}).`);
      setTargetCompanyId("");
      setReason("");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Merge failed");
    } finally {
      setBusy(false);
    }
  }

  async function onRevert(mergeId: string): Promise<void> {
    const note = revertReason.trim();
    if (note.length === 0) {
      setError("A revert reason is required.");
      return;
    }
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await apiJson(`/api/v1/merges/${mergeId}/revert`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: note }),
      });
      setNotice(`Merge ${mergeId} reverted.`);
      setRevertReason("");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Revert failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="admin-panel" aria-labelledby="company-merge-heading">
      <header className="admin-panel__header">
        <h2 id="company-merge-heading">Reversible merge</h2>
        <p className="asi-page-description">
          Fuzzy name matches never merge on their own. An analyst merge writes
          snapshots; only an admin revert restores the prior records.
        </p>
      </header>
      {canMerge ? (
        <form className="admin-form-grid" onSubmit={(event) => void onMerge(event)}>
          <label className="admin-field" htmlFor="merge-target-id">
            Keep this surviving company ID
            <Input
              id="merge-target-id"
              name="targetCompanyId"
              value={targetCompanyId}
              onChange={(event) => setTargetCompanyId(event.target.value)}
              required
            />
          </label>
          <label className="admin-field" htmlFor="merge-reason">
            Reason for merging {companyName}
            <Input
              id="merge-reason"
              name="reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              required
            />
          </label>
          <div className="admin-actions">
            <Button type="submit" disabled={busy}>
              Merge into surviving company
            </Button>
          </div>
        </form>
      ) : (
        <p className="asi-page-description">Viewers can inspect merge history but cannot apply one.</p>
      )}
      {canRevert ? (
        <label className="admin-field" htmlFor="merge-revert-reason">
          Revert reason
          <Input
            id="merge-revert-reason"
            name="revertReason"
            value={revertReason}
            onChange={(event) => setRevertReason(event.target.value)}
          />
        </label>
      ) : null}
      {error ? (
        <p className="admin-feedback" data-tone="error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="admin-feedback" data-tone="success" role="status">
          {notice}
        </p>
      ) : null}
      {merges.length === 0 ? (
        <EmptyState
          title="No merge events"
          description="Applied and reverted company merges for this record will appear here."
        />
      ) : (
        <Table>
          <TableCaption>Persisted merge events involving this company.</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Status</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Survivor</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>When</TableHead>
              <TableHead>Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {merges.map((merge) => (
              <TableRow key={merge.id}>
                <TableCell>{merge.status}</TableCell>
                <TableCell>
                  <Link href={`/companies/${merge.sourceEntityId}`}>{merge.sourceEntityId}</Link>
                </TableCell>
                <TableCell>
                  <Link href={`/companies/${merge.targetEntityId}`}>{merge.targetEntityId}</Link>
                </TableCell>
                <TableCell>{merge.reason}</TableCell>
                <TableCell>
                  {merge.status === "reverted" && merge.revertedAt
                    ? merge.revertedAt
                    : merge.mergedAt}
                </TableCell>
                <TableCell>
                  {canRevert && merge.status === "applied" ? (
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void onRevert(merge.id)}
                    >
                      Revert
                    </Button>
                  ) : (
                    "—"
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
