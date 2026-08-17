"use client";

import type { SourceAccess, SourceIngestion } from "@asi/contracts";
import { Button, Input, Select } from "@asi/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { apiJson } from "@/components/csrf-client";

const accessChoices: ReadonlyArray<{
  value: SourceAccess;
  label: string;
  detail: string;
}> = [
  {
    value: "public",
    label: "Public",
    detail:
      "Publicly available material may be researched with controlled web fetching.",
  },
  {
    value: "authorized",
    label: "Authorized material",
    detail:
      "Material supplied or accessed through an approved organizational authorization.",
  },
  {
    value: "restricted_metadata_only",
    label: "Restricted metadata only",
    detail:
      "Store descriptive metadata and links only. Automatic research is disabled and the source is never represented as searched.",
  },
];
const ingestionChoices: ReadonlyArray<{
  value: SourceIngestion;
  label: string;
  allowed: readonly SourceAccess[];
}> = [
  {
    value: "manual",
    label: "Manual metadata entry",
    allowed: ["public", "authorized", "restricted_metadata_only"],
  },
  { value: "upload", label: "Authorized upload", allowed: ["authorized"] },
  {
    value: "web_fetch",
    label: "Controlled public web fetch",
    allowed: ["public"],
  },
  { value: "api", label: "Approved API", allowed: ["public", "authorized"] },
  {
    value: "import",
    label: "Controlled import",
    allowed: ["public", "authorized"],
  },
];

type CreatedSource = Readonly<{ id: string }>;

function optionalValue(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function validHttpUrl(value: string): boolean {
  if (value === "") return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export default function NewDataSourcePage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [homepageUrl, setHomepageUrl] = useState("");
  const [referenceUrls, setReferenceUrls] = useState("");
  const [access, setAccess] = useState<SourceAccess>("public");
  const [ingestionMethod, setIngestionMethod] =
    useState<SourceIngestion>("web_fetch");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  const availableIngestion = ingestionChoices.filter((choice) =>
    choice.allowed.includes(access),
  );

  function chooseAccess(next: SourceAccess): void {
    setAccess(next);
    if (
      !ingestionChoices.some(
        (choice) =>
          choice.value === ingestionMethod && choice.allowed.includes(next),
      )
    )
      setIngestionMethod("manual");
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(undefined);
    const primaryUrl = homepageUrl.trim();
    const extraUrls = referenceUrls
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (
      !validHttpUrl(primaryUrl) ||
      extraUrls.some((value) => !validHttpUrl(value))
    ) {
      setError("Source URLs must be complete HTTP or HTTPS addresses.");
      return;
    }
    setSubmitting(true);
    try {
      const created = await apiJson<CreatedSource>("/api/v1/sources", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          description: optionalValue(description),
          homepageUrl: optionalValue(primaryUrl),
          access,
          ingestionMethod:
            access === "restricted_metadata_only" ? "manual" : ingestionMethod,
          status: "active",
          metadata: extraUrls.length === 0 ? {} : { referenceUrls: extraUrls },
        }),
      });
      router.push(`/data-sources/${created.id}`);
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to create the source.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">Source register</p>
        <h1 className="asi-page-title">Add data source</h1>
        <p className="asi-page-description">
          Create the recurring source record first. Company relationships are
          optional and can be added only when evidence supports them.
        </p>
      </header>
      <form className="admin-panel" onSubmit={(event) => void submit(event)}>
        <div className="admin-form-grid">
          <div className="admin-field">
            <label className="admin-field__label" htmlFor="source-name">
              Source name
            </label>
            <Input
              id="source-name"
              autoFocus
              required
              maxLength={500}
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={submitting}
              style={{ inlineSize: "100%" }}
            />
          </div>
          <div className="admin-field">
            <label className="admin-field__label" htmlFor="source-homepage">
              Primary source URL{" "}
              <span className="asi-page-description">(optional)</span>
            </label>
            <Input
              id="source-homepage"
              type="url"
              inputMode="url"
              placeholder="https://example.gov/source"
              value={homepageUrl}
              onChange={(event) => setHomepageUrl(event.target.value)}
              disabled={submitting}
              style={{ inlineSize: "100%" }}
            />
          </div>
        </div>

        <fieldset
          style={{ border: 0, margin: "var(--asi-space-12) 0 0", padding: 0 }}
        >
          <legend
            className="admin-field__label"
            style={{ marginBlockEnd: "var(--asi-space-6)" }}
          >
            Access classification
          </legend>
          <div className="admin-stack">
            {accessChoices.map((choice) => (
              <label
                key={choice.value}
                className="admin-inline-control"
                style={{ alignItems: "flex-start" }}
              >
                <input
                  type="radio"
                  name="access"
                  value={choice.value}
                  checked={access === choice.value}
                  onChange={() => chooseAccess(choice.value)}
                  disabled={submitting}
                />
                <span>
                  <strong>{choice.label}</strong>
                  <br />
                  <span className="asi-page-description">{choice.detail}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div
          className="admin-form-grid"
          style={{ marginBlockStart: "var(--asi-space-12)" }}
        >
          <div className="admin-field">
            <label
              className="admin-field__label"
              htmlFor="source-ingestion-policy"
            >
              Ingestion policy
            </label>
            <Select
              id="source-ingestion-policy"
              value={
                access === "restricted_metadata_only"
                  ? "manual"
                  : ingestionMethod
              }
              onChange={(event) =>
                setIngestionMethod(event.target.value as SourceIngestion)
              }
              disabled={submitting || access === "restricted_metadata_only"}
              style={{ inlineSize: "100%" }}
            >
              {availableIngestion.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </Select>
            {access === "restricted_metadata_only" ? (
              <span className="asi-page-description">
                Metadata may be maintained manually; source content will not be
                fetched or researched.
              </span>
            ) : null}
          </div>
          <div className="admin-field">
            <label
              className="admin-field__label"
              htmlFor="source-reference-urls"
            >
              Additional metadata URLs{" "}
              <span className="asi-page-description">
                (optional, one per line)
              </span>
            </label>
            <textarea
              id="source-reference-urls"
              className="asi-input"
              rows={3}
              value={referenceUrls}
              onChange={(event) => setReferenceUrls(event.target.value)}
              disabled={submitting}
              style={{
                blockSize: "auto",
                inlineSize: "100%",
                paddingBlock: "var(--asi-space-4)",
              }}
            />
          </div>
        </div>

        <div
          className="admin-field"
          style={{ marginBlockStart: "var(--asi-space-12)" }}
        >
          <label className="admin-field__label" htmlFor="source-notes">
            Source notes{" "}
            <span className="asi-page-description">(optional)</span>
          </label>
          <textarea
            id="source-notes"
            className="asi-input"
            rows={5}
            maxLength={10000}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={submitting}
            style={{
              blockSize: "auto",
              inlineSize: "100%",
              paddingBlock: "var(--asi-space-4)",
            }}
          />
        </div>

        {error ? (
          <p
            className="admin-feedback"
            data-tone="error"
            role="alert"
            tabIndex={-1}
            ref={errorRef}
            style={{ marginBlockStart: "var(--asi-space-8)" }}
          >
            {error}
          </p>
        ) : null}
        <div className="admin-actions">
          <Button
            type="submit"
            isLoading={submitting}
            disabled={name.trim() === ""}
          >
            Create source
          </Button>
          <Link
            className="asi-button"
            data-size="medium"
            data-variant="ghost"
            href="/data-sources"
          >
            Cancel
          </Link>
        </div>
      </form>
    </>
  );
}
