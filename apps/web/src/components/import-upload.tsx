"use client";

import { Button, Input, Select } from "@asi/ui";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { apiJson } from "@/components/csrf-client";

type ImportBatch = Readonly<{
  id: string;
  status: string;
  importedCount: number;
  rejectedCount: number;
  rowCount: number | null;
}>;

export function ImportUpload({ canImport }: Readonly<{ canImport: boolean }>) {
  const router = useRouter();
  const [entity, setEntity] = useState<"companies" | "facilities">("companies");
  const [dryRun, setDryRun] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<ImportBatch>();

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canImport) return;
    const form = event.currentTarget;
    const fileInput = form.elements.namedItem("file");
    if (!(fileInput instanceof HTMLInputElement) || !fileInput.files?.[0]) {
      setError("Choose a CSV file first.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const body = new FormData();
      body.set("entity", entity);
      body.set("dryRun", dryRun ? "true" : "false");
      body.set("file", fileInput.files[0]);
      const batch = await apiJson<ImportBatch>("/api/v1/imports", {
        method: "POST",
        body,
      });
      setResult(batch);
      router.push(`/imports/${batch.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="admin-panel" aria-labelledby="import-upload-heading">
      <header className="admin-panel__header">
        <h2 id="import-upload-heading">Authorized CSV upload</h2>
        <p className="asi-page-description">
          Files are stored by SHA-256. Dry-run validates rows without writing
          canonical entities. Commit is idempotent for the same digest.
        </p>
      </header>
      {canImport ? (
        <form className="admin-form-grid" onSubmit={(event) => void onSubmit(event)}>
          <label className="admin-field" htmlFor="import-entity">
            <span className="admin-field__label">Entity</span>
            <Select
              id="import-entity"
              value={entity}
              onChange={(event) =>
                setEntity(event.target.value === "facilities" ? "facilities" : "companies")
              }
            >
              <option value="companies">Companies</option>
              <option value="facilities">Facilities</option>
            </Select>
          </label>
          <label className="admin-field" htmlFor="import-file">
            <span className="admin-field__label">CSV file</span>
            <Input id="import-file" name="file" type="file" accept=".csv,text/csv" />
          </label>
          <label className="admin-inline-control" htmlFor="import-dry-run">
            <input
              id="import-dry-run"
              type="checkbox"
              checked={dryRun}
              onChange={(event) => setDryRun(event.target.checked)}
            />
            Dry-run only
          </label>
          <div className="admin-actions">
            <Button type="submit" isLoading={busy}>
              {dryRun ? "Validate file" : "Commit import"}
            </Button>
          </div>
        </form>
      ) : (
        <p className="asi-page-description">
          An analyst or administrator can upload an authorized CSV.
        </p>
      )}
      {error ? (
        <p className="admin-feedback" data-tone="error" role="alert">
          {error}
        </p>
      ) : null}
      {result ? (
        <p className="asi-page-description">
          Batch {result.status}: {result.importedCount} imported, {result.rejectedCount}{" "}
          rejected
          {result.rowCount === null ? "" : ` of ${result.rowCount}`}.
        </p>
      ) : null}
    </section>
  );
}
