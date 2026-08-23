"use client";

import { Button } from "@asi/ui";
import { useState } from "react";

type CatalogExportProps = Readonly<{
  entity:
    | "companies"
    | "facilities"
    | "contacts"
    | "platforms"
    | "parts"
    | "qualifications"
    | "data_sources"
    | "candidates";
  query?: string;
}>;

export function CatalogExport({ entity, query }: CatalogExportProps) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function download(format: "csv" | "jsonl"): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const params = new URLSearchParams({ entity, format });
      if (query) params.set("query", query);
      const response = await fetch(`/api/v1/exports?${params}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) {
        throw new Error(`Export failed (${response.status})`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const disposition = response.headers.get("content-disposition");
      const matched = disposition?.match(/filename="([^"]+)"/);
      link.href = url;
      link.download = matched?.[1] ?? `${entity}.${format}`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Export failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-actions">
      <Button
        type="button"
        variant="secondary"
        disabled={busy}
        onClick={() => void download("csv")}
      >
        Export CSV
      </Button>
      <Button
        type="button"
        variant="ghost"
        disabled={busy}
        onClick={() => void download("jsonl")}
      >
        Export JSONL
      </Button>
      {error ? (
        <p className="admin-feedback" data-tone="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
