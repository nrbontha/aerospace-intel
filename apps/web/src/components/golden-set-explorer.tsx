"use client";

import {
  buildToPrintRiskValues,
  goldenExampleTypeValues,
  labelScaleValues,
  reviewStatusValues,
  type BuildToPrintRisk,
  type GoldenExampleType,
  type LabelScale,
} from "@asi/contracts";
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
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  listGoldenExamples,
  reviewGoldenExample,
  type GoldenExampleRecord,
  type GoldenReviewPayload,
} from "@/lib/product-api";

type ScaleField =
  | "archetypeFit"
  | "currentActionability"
  | "businessModelFit"
  | "ownershipFit";

type LabelKey = ScaleField | "goldenExampleType" | "buildToPrintRisk";

const SCALE_FIELDS: readonly ScaleField[] = [
  "archetypeFit",
  "currentActionability",
  "businessModelFit",
  "ownershipFit",
];

const PANEL_FIELDS: readonly LabelKey[] = [
  ...SCALE_FIELDS,
  "goldenExampleType",
  "buildToPrintRisk",
];

const FIELD_LABELS: Readonly<Record<LabelKey, string>> = {
  archetypeFit: "Archetype fit",
  currentActionability: "Actionability",
  businessModelFit: "Business model",
  ownershipFit: "Ownership",
  goldenExampleType: "Example type",
  buildToPrintRisk: "Build-to-print risk",
};

const TYPE_LABELS: Readonly<Record<GoldenExampleType, string>> = {
  strong_positive: "Strong positive",
  positive_with_caveat: "Positive w/ caveat",
  borderline: "Borderline",
  negative_business_model: "Negative model",
  ideal_archetype_but_unactionable: "Ideal but unactionable",
  known_non_target: "Non-target",
  unclassified: "Unclassified",
};

const SCALE_LABELS: Readonly<Record<LabelScale, string>> = {
  strong_positive: "strong+",
  positive: "positive",
  neutral: "neutral",
  negative: "negative",
  unknown: "unknown",
};

const RISK_LABELS: Readonly<Record<BuildToPrintRisk, string>> = {
  none: "none",
  low: "low",
  medium: "medium",
  high: "high",
  unknown: "unknown",
};

function scaleTone(value: LabelScale): "success" | "info" | "danger" | "warning" | "neutral" {
  if (value === "strong_positive") return "success";
  if (value === "positive") return "info";
  if (value === "negative") return "danger";
  if (value === "unknown") return "warning";
  return "neutral";
}

function typeTone(value: GoldenExampleType): "success" | "info" | "danger" | "warning" | "neutral" {
  if (value === "strong_positive") return "success";
  if (value === "positive_with_caveat") return "info";
  if (value === "borderline") return "warning";
  if (value === "negative_business_model" || value === "known_non_target")
    return "danger";
  return "neutral";
}

function statusTone(status: GoldenExampleRecord["reviewStatus"]): "success" | "info" | "neutral" {
  if (status === "reviewed") return "success";
  if (status === "proposed") return "info";
  return "neutral";
}

function grataText(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" && typeof value !== "number") return "—";
  const text = String(value).trim();
  return text === "" ? "—" : text;
}

function revenueLabel(payload: Record<string, unknown>): string {
  const raw = payload["Estimated revenue"];
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value) || value <= 0) return "—";
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: 1,
    notation: "compact",
    style: "currency",
  }).format(value);
}

/** Proposed labels live in the embedded set; reviewed labels mirror them at
 *  the top level of the record, so both reads share the same key. */
function proposedOf(record: GoldenExampleRecord, field: LabelKey): string | null {
  const value = record.proposedLabels[field];
  return typeof value === "string" ? value : null;
}

function reviewedOf(record: GoldenExampleRecord, field: LabelKey): string | null {
  return record[field];
}

function disagrees(record: GoldenExampleRecord, field: LabelKey): boolean {
  if (record.reviewStatus !== "reviewed") return false;
  const proposed = proposedOf(record, field);
  const reviewed = reviewedOf(record, field);
  return proposed !== null && reviewed !== null && proposed !== reviewed;
}

function chipText(field: LabelKey, value: string): string {
  if (field === "goldenExampleType")
    return TYPE_LABELS[value as GoldenExampleType] ?? value;
  if (field === "buildToPrintRisk")
    return RISK_LABELS[value as BuildToPrintRisk] ?? value;
  return SCALE_LABELS[value as LabelScale] ?? value;
}

function chipTone(
  field: LabelKey,
  value: string,
): "success" | "info" | "danger" | "warning" | "neutral" {
  if (field === "goldenExampleType")
    return typeTone(value as GoldenExampleType);
  if (field === "buildToPrintRisk") return "warning";
  return scaleTone(value as LabelScale);
}

type FormState = Readonly<Record<LabelKey, string> & { rationale: string }>;

function initialForm(record: GoldenExampleRecord): FormState {
  const pick = (field: LabelKey): string =>
    reviewedOf(record, field) ?? proposedOf(record, field) ?? "";
  return {
    archetypeFit: pick("archetypeFit"),
    currentActionability: pick("currentActionability"),
    businessModelFit: pick("businessModelFit"),
    ownershipFit: pick("ownershipFit"),
    goldenExampleType: pick("goldenExampleType"),
    buildToPrintRisk: pick("buildToPrintRisk"),
    rationale: "",
  };
}

const chipRowStyle = {
  display: "inline-flex",
  flexWrap: "wrap",
  gap: "var(--asi-space-1)",
} as const;

/** Empty select value means "leave unchanged"; otherwise the option value is
 *  one of the contract enum members rendered into that select. */
function optionalEnum<T extends string>(value: string): T | undefined {
  return value === "" ? undefined : (value as T);
}

export function GoldenSetExplorer(props: { canReview: boolean }) {
  const { canReview } = props;
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const status = searchParams.get("status") ?? "";
  const type = searchParams.get("type") ?? "";
  const query = searchParams.get("q") ?? "";

  const [searchInput, setSearchInput] = useState(query);
  const [rows, setRows] = useState<GoldenExampleRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const rowRefs = useRef<Array<HTMLTableRowElement | null>>([]);

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
        const envelope = await listGoldenExamples(
          {
            goldenExampleType: type || undefined,
            query: query || undefined,
            reviewStatus: status || undefined,
          },
          controller.signal,
        );
        setRows(envelope.data);
      } catch (error) {
        if (!controller.signal.aborted)
          setLoadError(
            error instanceof Error ? error.message : "Unable to load examples.",
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [query, reloadKey, status, type]);

  const selected = useMemo(
    () => rows.find((row) => row.id === selectedId) ?? null,
    [rows, selectedId],
  );

  function moveCursor(next: number): void {
    const bounded = Math.max(0, Math.min(rows.length - 1, next));
    rowRefs.current[bounded]?.focus();
  }

  function openAt(index: number): void {
    const row = rows[index];
    if (row) {
      setSelectedId(row.id);
      setReviewError(undefined);
    }
  }

  async function submitReview(form: FormState): Promise<void> {
    if (!selected || submitting) return;
    const rationale = form.rationale.trim();
    if (rationale.length < 10) {
      setReviewError(
        "A review rationale of at least 10 characters is required.",
      );
      return;
    }
    const payload: GoldenReviewPayload = {
      archetypeFit: optionalEnum<LabelScale>(form.archetypeFit),
      currentActionability: optionalEnum<LabelScale>(
        form.currentActionability,
      ),
      businessModelFit: optionalEnum<LabelScale>(form.businessModelFit),
      ownershipFit: optionalEnum<LabelScale>(form.ownershipFit),
      goldenExampleType: optionalEnum<GoldenExampleType>(
        form.goldenExampleType,
      ),
      buildToPrintRisk: optionalEnum<BuildToPrintRisk>(
        form.buildToPrintRisk,
      ),
      rationale,
    };
    const previous = selected;
    // Optimistic: assume success locally, revert if the API rejects.
    applyPatch(previous.id, {
      archetypeFit: payload.archetypeFit ?? null,
      currentActionability: payload.currentActionability ?? null,
      businessModelFit: payload.businessModelFit ?? null,
      ownershipFit: payload.ownershipFit ?? null,
      goldenExampleType: payload.goldenExampleType ?? null,
      buildToPrintRisk: payload.buildToPrintRisk ?? null,
      reviewStatus: "reviewed",
    });
    setSubmitting(true);
    setReviewError(undefined);
    try {
      const updated = await reviewGoldenExample(previous.id, payload);
      applyPatch(updated.id, updated);
    } catch (error) {
      applyPatch(previous.id, previous);
      setReviewError(
        error instanceof Error ? error.message : "Review submission failed.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  /** Merge a partial patch into one row without touching the others. */
  function applyPatch(
    id: string,
    patch: Partial<GoldenExampleRecord>,
  ): void {
    setRows((current) =>
      current.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  }

  const hasFilters = Boolean(query || status || type);

  return (
    <section aria-labelledby="golden-set-heading">
      <div className="admin-panel">
        <div className="admin-panel__header">
          <h2 id="golden-set-heading">Golden examples</h2>
          <p className="asi-page-description">
            Arrow keys move between rows; Enter opens the review panel.
            Reviewed decisions require a rationale.
          </p>
        </div>
        <form
          className="admin-form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            replaceFilters({ q: searchInput.trim() });
          }}
          role="search"
        >
          <div className="admin-field">
            <label className="admin-field__label" htmlFor="golden-search">
              Search examples
            </label>
            <Input
              id="golden-search"
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Name or domain"
              style={{ inlineSize: "100%" }}
              value={searchInput}
            />
          </div>
          <div className="admin-field">
            <label className="admin-field__label" htmlFor="golden-status">
              Review status
            </label>
            <Select
              id="golden-status"
              onChange={(event) =>
                replaceFilters({ status: event.target.value })
              }
              style={{ inlineSize: "100%" }}
              value={status}
            >
              <option value="">All statuses</option>
              {reviewStatusValues.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </div>
          <div className="admin-field">
            <label className="admin-field__label" htmlFor="golden-type">
              Example type
            </label>
            <Select
              id="golden-type"
              onChange={(event) => replaceFilters({ type: event.target.value })}
              style={{ inlineSize: "100%" }}
              value={type}
            >
              <option value="">All types</option>
              {goldenExampleTypeValues.map((value) => (
                <option key={value} value={value}>
                  {TYPE_LABELS[value]}
                </option>
              ))}
            </Select>
          </div>
          <div className="admin-actions">
            <Button type="submit">Apply search</Button>
            {hasFilters ? (
              <Button
                onClick={() => {
                  setSearchInput("");
                  router.replace(pathname, { scroll: false });
                }}
                type="button"
                variant="ghost"
              >
                Clear filters
              </Button>
            ) : null}
          </div>
        </form>
      </div>
      <div
        style={{
          alignItems: "flex-start",
          display: "flex",
          flexWrap: "wrap",
          gap: "var(--asi-space-12)",
          marginBlockStart: "var(--asi-space-12)",
        }}
      >
        <div
          aria-busy={loading}
          aria-live="polite"
          style={{ flex: "2 1 44rem", minInlineSize: 0 }}
        >
          {loading ? (
            <div className="admin-panel" role="status">
              Loading golden examples…
            </div>
          ) : loadError ? (
            <div className="admin-panel">
              <p className="admin-feedback" data-tone="error" role="alert">
                {loadError}
              </p>
              <div className="admin-actions">
                <Button
                  onClick={() => setReloadKey((value) => value + 1)}
                  variant="secondary"
                >
                  Try again
                </Button>
              </div>
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              title={
                hasFilters
                  ? "No examples match these filters"
                  : "No golden examples imported"
              }
            />
          ) : (
            <Table>
              <TableCaption>
                {rows.length} example{rows.length === 1 ? "" : "s"} loaded.
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Company</TableHead>
                  <TableHead>HQ</TableHead>
                  <TableHead numeric>Revenue est.</TableHead>
                  <TableHead>Ownership</TableHead>
                  <TableHead>Proposed</TableHead>
                  <TableHead>Reviewed</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row, index) => (
                  <TableRow
                    aria-selected={selectedId === row.id || undefined}
                    data-selected={selectedId === row.id ? "true" : undefined}
                    key={row.id}
                    onClick={() => {
                      setSelectedId(row.id);
                      setReviewError(undefined);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        moveCursor(index + 1);
                      } else if (event.key === "ArrowUp") {
                        event.preventDefault();
                        moveCursor(index - 1);
                      } else if (event.key === "Enter") {
                        event.preventDefault();
                        openAt(index);
                      }
                    }}
                    ref={(node) => {
                      rowRefs.current[index] = node;
                    }}
                    style={{ cursor: "pointer" }}
                    tabIndex={0}
                  >
                    <TableCell>
                      <strong>{row.name}</strong>
                      <div>{row.domain ?? "—"}</div>
                    </TableCell>
                    <TableCell>{grataText(row.grataPayload, "HQ")}</TableCell>
                    <TableCell numeric>
                      {revenueLabel(row.grataPayload)}
                    </TableCell>
                    <TableCell>
                      {grataText(row.grataPayload, "Ownership")}
                    </TableCell>
                    <TableCell>
                      <ChipsCell
                        fields={["goldenExampleType", "currentActionability"]}
                        read={(field) => proposedOf(row, field)}
                      />
                    </TableCell>
                    <TableCell>
                      {row.reviewStatus === "reviewed" ? (
                        <ChipsCell
                          fields={["goldenExampleType", "currentActionability"]}
                          read={(field) => reviewedOf(row, field)}
                        />
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge tone={statusTone(row.reviewStatus)}>
                        {row.reviewStatus}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
        {selected ? (
          <DetailPanel
            canReview={canReview}
            record={selected}
            reviewError={reviewError}
            onClose={() => setSelectedId(null)}
            onSubmit={submitReview}
            submitting={submitting}
          />
        ) : null}
      </div>
    </section>
  );
}

function ChipsCell(props: {
  fields: readonly LabelKey[];
  read: (field: LabelKey) => string | null;
}) {
  const chips = props.fields
    .map((field) => ({ field, value: props.read(field) }))
    .filter((chip): chip is { field: LabelKey; value: string } =>
      Boolean(chip.value),
    );
  if (chips.length === 0) return <>—</>;
  return (
    <span style={chipRowStyle}>
      {chips.map(({ field, value }) => (
        <Badge key={field} tone={chipTone(field, value)}>
          {chipText(field, value)}
        </Badge>
      ))}
    </span>
  );
}

function DetailPanel(props: {
  canReview: boolean;
  record: GoldenExampleRecord;
  reviewError?: string | undefined;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (form: FormState) => Promise<void>;
}) {
  const { canReview, record, reviewError, submitting, onClose, onSubmit } =
    props;
  const [form, setForm] = useState<FormState>(() => initialForm(record));
  const disagreeStyle = {
    color: "var(--asi-danger)",
    fontWeight: "var(--asi-semibold)" as const,
  };

  function labelPair(field: LabelKey): { proposed: string; reviewed: string | null } {
    const proposed = proposedOf(record, field);
    return {
      proposed: proposed ? chipText(field, proposed) : "—",
      reviewed:
        record.reviewStatus === "reviewed"
          ? (reviewedOf(record, field) ?? "—")
          : null,
    };
  }

  return (
    <aside
      aria-label={`${record.name} details`}
      className="admin-panel"
      style={{ flex: "1 1 24rem", minInlineSize: 0 }}
    >
      <div className="admin-panel__header">
        <h3>{record.name}</h3>
        <p className="asi-page-description">
          {record.domain ?? "no domain"} · workbook row{" "}
          {record.workbookRow ?? "—"}
        </p>
      </div>
      <p>{record.descriptionRaw ?? "No raw description."}</p>
      <details>
        <summary>Grata payload</summary>
        <pre
          style={{
            fontSize: "var(--asi-text-xs)",
            fontFamily: "var(--asi-font-mono)",
            maxBlockSize: "18rem",
            overflow: "auto",
          }}
        >
          {JSON.stringify(record.grataPayload, null, 2)}
        </pre>
      </details>
      <div
        style={{
          display: "grid",
          gap: "var(--asi-space-8)",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          marginBlockStart: "var(--asi-space-8)",
        }}
      >
        <div>
          <h4>Proposed</h4>
          <dl style={{ marginBlock: 0 }}>
            {PANEL_FIELDS.map((field) => {
              const { proposed } = labelPair(field);
              return (
                <div key={field}>
                  <dt>{FIELD_LABELS[field]}</dt>
                  <dd
                    style={{
                      marginBlock: 0,
                      ...(disagrees(record, field) ? disagreeStyle : {}),
                    }}
                  >
                    {disagrees(record, field) ? "⚠ differs " : ""}
                    {proposed}
                  </dd>
                </div>
              );
            })}
          </dl>
          <p>Rationale: {record.proposedLabels.rationale ?? "—"}</p>
        </div>
        <div>
          <h4>Reviewed</h4>
          {record.reviewStatus === "reviewed" ? (
            <>
              <dl style={{ marginBlock: 0 }}>
                {PANEL_FIELDS.map((field) => {
                  const { reviewed } = labelPair(field);
                  return (
                    <div key={field}>
                      <dt>{FIELD_LABELS[field]}</dt>
                      <dd
                        style={{
                          marginBlock: 0,
                          ...(disagrees(record, field)
                            ? disagreeStyle
                            : {}),
                        }}
                      >
                        {disagrees(record, field) ? "⚠ differs " : ""}
                        {reviewed}
                      </dd>
                    </div>
                  );
                })}
              </dl>
              <p>Rationale: {record.reviewNotes ?? "—"}</p>
            </>
          ) : (
            <p>Not yet reviewed.</p>
          )}
        </div>
      </div>
      {canReview ? (
        <form
          aria-label={`Review ${record.name}`}
          className="admin-form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void onSubmit(form);
          }}
        >
          {PANEL_FIELDS.map((field) => (
            <div className="admin-field" key={field}>
              <label className="admin-field__label" htmlFor={`review-${field}`}>
                {FIELD_LABELS[field]}
              </label>
              <Select
                disabled={!canReview || submitting}
                id={`review-${field}`}
                onChange={(event) =>
                  setForm((state) => ({
                    ...state,
                    [field]: event.target.value,
                  }))
                }
                style={{ inlineSize: "100%" }}
                value={form[field]}
              >
                <option value="">—</option>
                {(field === "goldenExampleType"
                  ? goldenExampleTypeValues
                  : field === "buildToPrintRisk"
                    ? buildToPrintRiskValues
                    : labelScaleValues
                ).map((value) => (
                  <option key={value} value={value}>
                    {chipText(field, value)}
                  </option>
                ))}
              </Select>
            </div>
          ))}
          <div className="admin-field">
            <label className="admin-field__label" htmlFor="review-rationale">
              Review rationale (required, min 10 characters)
            </label>
            <textarea
              className="asi-input"
              disabled={!canReview || submitting}
              id="review-rationale"
              onChange={(event) =>
                setForm((state) => ({ ...state, rationale: event.target.value }))
              }
              rows={3}
              style={{ inlineSize: "100%" }}
              value={form.rationale}
            />
          </div>
          {reviewError ? (
            <p className="admin-feedback" data-tone="error" role="alert">
              {reviewError}
            </p>
          ) : null}
          <div className="admin-actions">
            <Button disabled={!canReview || submitting} type="submit">
              Submit review
            </Button>
          </div>
        </form>
      ) : (
        <p className="admin-feedback">Your role cannot submit reviews.</p>
      )}
      <div className="admin-actions">
        <Button onClick={onClose} type="button" variant="ghost">
          Close panel
        </Button>
      </div>
    </aside>
  );
}
