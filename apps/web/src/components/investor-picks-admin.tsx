"use client";

import type {
  InvestorPickCreateInput,
  InvestorPickDto,
  InvestorPicksPageDto,
  InvestorPickUpdateInput,
  InvestorReferenceImportResultDto,
} from "@asi/contracts";
import { Badge, Button, EmptyState, Input } from "@asi/ui";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { apiJson } from "@/components/csrf-client";
import { GoldenBadge } from "@/components/golden-badge";

import type { SignalOverviewDto, SignalOverviewPageDto } from "@/lib/signal-analyst";

const SOURCE_SEARCH_LIMIT = 25;

type Feedback = Readonly<{
  tone: "error" | "success";
  message: string;
}>;

function sourceLabel(source: SignalOverviewDto): string {
  return source.signal.rawDomain
    ? `${source.signal.rawName} · ${source.signal.rawDomain}`
    : `${source.signal.rawName} · domain unknown`;
}

function mergePick(
  page: InvestorPicksPageDto | undefined,
  changed: InvestorPickDto,
): InvestorPicksPageDto | undefined {
  if (!page) return page;
  const existing = page.items.some((pick) => pick.id === changed.id);
  const items = existing
    ? page.items.map((pick) => (pick.id === changed.id ? changed : pick))
    : [changed, ...page.items];

  return {
    ...page,
    items,
    total: existing ? page.total : page.total + 1,
  };
}

function provenance(pick: InvestorPickDto): string {
  if (pick.origins.length === 0) return "No provenance label recorded.";
  return pick.origins
    .map((origin) => {
      if (origin.kind === "manual") return origin.label;
      return [
        origin.label,
        origin.snapshotKey,
        origin.sourceRow === null ? null : `row ${origin.sourceRow}`,
      ]
        .filter((value): value is string => value !== null && value !== "")
        .join(" · ");
    })
    .join("; ");
}

function identityDescription(pick: InvestorPickDto): string {
  const domain = pick.identityVerified
    ? pick.verifiedDomain
    : pick.domain;
  return `${pick.identityVerified ? "Verified identity" : "Candidate identity"} · ${domain ?? "domain not recorded"}`;
}

function ImportResult({
  result,
}: Readonly<{ result: InvestorReferenceImportResultDto }>) {
  return (
    <p className="admin-feedback" data-tone="success" role="status">
      Golden import completed: {result.memberCount} source members,{" "}
      {result.createdPicks} approvals added, {result.createdSignals} unverified
      source observations added, {result.alreadyImported} already represented,
      and {result.inactivePreserved} archived approvals preserved.
    </p>
  );
}

export function InvestorPicksAdmin() {
  const [page, setPage] = useState<InvestorPicksPageDto>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [feedback, setFeedback] = useState<Feedback>();
  const [importResult, setImportResult] = useState<InvestorReferenceImportResultDto>();
  const [pendingAction, setPendingAction] = useState<string>();
  const [sourceSearch, setSourceSearch] = useState("");
  const [sourceResults, setSourceResults] = useState<readonly SignalOverviewDto[]>([]);
  const [sourceSearchError, setSourceSearchError] = useState<string>();
  const [searchingSources, setSearchingSources] = useState(false);
  const [hasSearchedSources, setHasSearchedSources] = useState(false);
  const [selectedSource, setSelectedSource] = useState<SignalOverviewDto>();
  const [existingNote, setExistingNote] = useState("");
  const [manualName, setManualName] = useState("");
  const [manualDomain, setManualDomain] = useState("");
  const [manualNote, setManualNote] = useState("");
  const activeLoadRef = useRef<AbortController | null>(null);
  const loadGenerationRef = useRef(0);
  const loadingRef = useRef(true);
  const pendingActionRef = useRef<string | undefined>(undefined);
  const activeSourceSearchRef = useRef<AbortController | null>(null);
  const sourceSearchGenerationRef = useRef(0);

  const loadPicks = useCallback(
    async (allowDuringMutation = false): Promise<void> => {
      if (pendingActionRef.current !== undefined && !allowDuringMutation) return;

      activeLoadRef.current?.abort();
      const controller = new AbortController();
      const generation = ++loadGenerationRef.current;
      activeLoadRef.current = controller;
      loadingRef.current = true;
      setLoading(true);
      setLoadError(undefined);

      try {
        const activePage = await apiJson<InvestorPicksPageDto>(
          "/api/v1/investor-picks",
          { signal: controller.signal },
        );
        if (
          controller.signal.aborted ||
          generation !== loadGenerationRef.current
        ) {
          return;
        }
        if (!activePage.canManage) {
          setPage(activePage);
          return;
        }
        const result = await apiJson<InvestorPicksPageDto>(
          "/api/v1/investor-picks?includeInactive=true",
          { signal: controller.signal },
        );
        if (
          controller.signal.aborted ||
          generation !== loadGenerationRef.current
        ) {
          return;
        }
        setPage(result);
      } catch (caught) {
        if (
          controller.signal.aborted ||
          generation !== loadGenerationRef.current
        ) {
          return;
        }
        setLoadError(
          caught instanceof Error
            ? caught.message
            : "Unable to load Golden approvals.",
        );
      } finally {
        if (
          activeLoadRef.current === controller &&
          generation === loadGenerationRef.current
        ) {
          activeLoadRef.current = null;
          loadingRef.current = false;
          setLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    void loadPicks();
  }, [loadPicks]);

  useEffect(
    () => () => {
      loadGenerationRef.current += 1;
      activeLoadRef.current?.abort();
      sourceSearchGenerationRef.current += 1;
      activeSourceSearchRef.current?.abort();
    },
    [],
  );

  async function searchExistingSources(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const query = sourceSearch.trim();
    if (query === "") {
      sourceSearchGenerationRef.current += 1;
      activeSourceSearchRef.current?.abort();
      activeSourceSearchRef.current = null;
      setSourceResults([]);
      setSelectedSource(undefined);
      setSourceSearchError("Enter a source name or domain to search.");
      return;
    }

    activeSourceSearchRef.current?.abort();
    const controller = new AbortController();
    const generation = ++sourceSearchGenerationRef.current;
    activeSourceSearchRef.current = controller;
    setHasSearchedSources(true);
    setSearchingSources(true);
    setSourceSearchError(undefined);
    try {
      const result = await apiJson<SignalOverviewPageDto>(
        `/api/v1/signals?${new URLSearchParams({
          q: query,
          limit: String(SOURCE_SEARCH_LIMIT),
        }).toString()}`,
        { signal: controller.signal },
      );
      if (
        controller.signal.aborted ||
        generation !== sourceSearchGenerationRef.current
      ) {
        return;
      }
      setSourceResults(result.items);
      setSelectedSource((current) =>
        current && result.items.some((item) => item.signal.id === current.signal.id)
          ? current
          : undefined,
      );
    } catch (caught) {
      if (
        controller.signal.aborted ||
        generation !== sourceSearchGenerationRef.current
      ) {
        return;
      }
      setSourceSearchError(
        caught instanceof Error
          ? caught.message
          : "Unable to search source records.",
      );
    } finally {
      if (
        activeSourceSearchRef.current === controller &&
        generation === sourceSearchGenerationRef.current
      ) {
        activeSourceSearchRef.current = null;
        setSearchingSources(false);
      }
    }
  }

  function beginMutation(action: string): boolean {
    if (loadingRef.current || pendingActionRef.current !== undefined) {
      return false;
    }
    activeLoadRef.current?.abort();
    loadGenerationRef.current += 1;
    pendingActionRef.current = action;
    setPendingAction(action);
    return true;
  }

  function finishMutation(): void {
    pendingActionRef.current = undefined;
    setPendingAction(undefined);
  }

  async function createPick(
    input: InvestorPickCreateInput,
    successMessage: string,
  ): Promise<boolean> {
    if (!beginMutation("create")) return false;
    setFeedback(undefined);
    setImportResult(undefined);
    try {
      const changed = await apiJson<InvestorPickDto>("/api/v1/investor-picks", {
        method: "POST",
        body: JSON.stringify(input),
      });
      setPage((current) => mergePick(current, changed));
      setFeedback({ tone: "success", message: successMessage });
      return true;
    } catch (caught) {
      setFeedback({
        tone: "error",
        message:
          caught instanceof Error ? caught.message : "Unable to add Golden approval.",
      });
      return false;
    } finally {
      finishMutation();
    }
  }

  async function submitExistingPick(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (!selectedSource) {
      setFeedback({
        tone: "error",
        message: "Select a source record before adding it to Golden approvals.",
      });
      return;
    }

    const created = await createPick(
      {
        mode: "existing",
        sourceSignalId: selectedSource.signal.id,
        ...(existingNote.trim() === "" ? {} : { note: existingNote.trim() }),
      },
      "Existing source record added to Golden approvals.",
    );
    if (created) setExistingNote("");
  }

  async function submitManualPick(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const name = manualName.trim();
    if (name === "") return;

    const created = await createPick(
      {
        mode: "manual",
        name,
        ...(manualDomain.trim() === "" ? {} : { domain: manualDomain.trim() }),
        ...(manualNote.trim() === "" ? {} : { note: manualNote.trim() }),
      },
      "Manual candidate added to Golden approvals.",
    );
    if (created) {
      setManualName("");
      setManualDomain("");
      setManualNote("");
    }
  }

  async function updatePick(
    id: string,
    input: InvestorPickUpdateInput,
    successMessage: string,
  ): Promise<void> {
    if (!beginMutation(id)) return;
    setFeedback(undefined);
    setImportResult(undefined);
    try {
      const changed = await apiJson<InvestorPickDto>(
        `/api/v1/investor-picks/${id}`,
        { method: "PATCH", body: JSON.stringify(input) },
      );
      setPage((current) => mergePick(current, changed));
      setFeedback({ tone: "success", message: successMessage });
    } catch (caught) {
      setFeedback({
        tone: "error",
        message:
          caught instanceof Error ? caught.message : "Unable to update Golden approval.",
      });
    } finally {
      finishMutation();
    }
  }

  async function importGoldenCollection(): Promise<void> {
    if (!beginMutation("import:golden")) return;
    setFeedback(undefined);
    setImportResult(undefined);
    try {
      const result = await apiJson<InvestorReferenceImportResultDto>(
        "/api/v1/investor-picks/import",
        { method: "POST", body: JSON.stringify({ set: "golden" }) },
      );
      setImportResult(result);
      await loadPicks(true);
    } catch (caught) {
      setFeedback({
        tone: "error",
        message:
          caught instanceof Error
            ? caught.message
            : "Unable to import the stored Golden collection.",
      });
    } finally {
      finishMutation();
    }
  }

  if (loading && !page) {
    return <section className="admin-panel" role="status">Loading Golden approvals…</section>;
  }

  if (!page && loadError) {
    return (
      <EmptyState
        title="Golden approvals unavailable"
        description={<p>{loadError}</p>}
        action={<Button onClick={() => void loadPicks()}>Try again</Button>}
      />
    );
  }

  if (!page || !page.canManage) {
    return (
      <section
        className="admin-panel"
        aria-labelledby="investor-picks-access-heading"
      >
        <h2 id="investor-picks-access-heading">Golden approval management</h2>
        <p className="asi-page-description">
          Golden approval management requires administrator access. This account
          can view the investor research queue.
        </p>
        {loadError ? <p className="admin-feedback" data-tone="error" role="alert">{loadError}</p> : null}
        <Link href="/signals">View investor research queue</Link>
      </section>
    );
  }

  const goldenReferenceSet = page.referenceSets.find(
    (set) => set.key === "golden",
  );

  return (
    <div className="admin-stack" aria-busy={loading || pendingAction !== undefined}>
      {loadError ? (
        <div className="admin-error" role="alert">
          <span>{loadError} Existing approvals remain visible.</span>
          <Button
            disabled={loading || pendingAction !== undefined}
            onClick={() => void loadPicks()}
            size="small"
            variant="secondary"
          >
            Retry refresh
          </Button>
        </div>
      ) : null}
      {feedback ? (
        <p className="admin-feedback" data-tone={feedback.tone} role="status">
          {feedback.message}
        </p>
      ) : null}
      {importResult ? <ImportResult result={importResult} /> : null}

      <section className="admin-panel" aria-labelledby="golden-import-heading">
        <div className="admin-panel__header">
          <div>
            <h2 id="golden-import-heading">Golden approval collection</h2>
            <p>
              Import the combined stored Golden collection. Imports preserve
              archived approvals and administrator notes without changing
              research scores, scientific qualification, or source history.
            </p>
          </div>
        </div>
        {goldenReferenceSet ? (
          <article className="investor-picks-admin__reference-set">
            <div>
              <h3>{goldenReferenceSet.label}</h3>
              <p>
                {goldenReferenceSet.available
                  ? `${goldenReferenceSet.memberCount} stored members; ${goldenReferenceSet.importedMemberCount} member ${goldenReferenceSet.importedMemberCount === 1 ? "row" : "rows"} currently represented.`
                  : "The stored Golden snapshots are unavailable, so the collection cannot be imported."}
              </p>
              <details className="investor-picks-admin__provenance">
                <summary>Advanced provenance</summary>
                <p className="admin-user-meta">
                  Historical source snapshots:{" "}
                  {goldenReferenceSet.snapshotKeys.join(", ")}
                </p>
                <p className="admin-user-meta">
                  Snapshot labels record reference input lineage; they do not
                  independently qualify a company.
                </p>
              </details>
            </div>
            <Button
              disabled={
                !goldenReferenceSet.available ||
                loading ||
                pendingAction !== undefined
              }
              isLoading={pendingAction === "import:golden"}
              onClick={() => void importGoldenCollection()}
              variant="secondary"
            >
              Import Golden collection
            </Button>
          </article>
        ) : (
          <p>No stored Golden collection metadata is available.</p>
        )}
      </section>

      <div className="admin-grid">
        <section className="admin-panel" aria-labelledby="existing-source-heading">
          <div className="admin-panel__header">
            <div>
              <h2 id="existing-source-heading">Add an existing source approval</h2>
              <p>
                Select a real raw source observation to approve it for investors.
                This does not create a canonical company or change its research
                state.
              </p>
          </div>
          </div>
          <form className="admin-stack" onSubmit={searchExistingSources}>
            <label className="admin-field" htmlFor="investor-source-search">
              <span className="admin-field__label">Source name or domain</span>
              <Input
                id="investor-source-search"
                maxLength={200}
                onChange={(event) => {
                  sourceSearchGenerationRef.current += 1;
                  activeSourceSearchRef.current?.abort();
                  activeSourceSearchRef.current = null;
                  setSourceSearch(event.target.value);
                  setHasSearchedSources(false);
                  setSearchingSources(false);
                  setSourceResults([]);
                  setSelectedSource(undefined);
                  setSourceSearchError(undefined);
                }}
                placeholder="Search source records"
                type="search"
                value={sourceSearch}
              />
            </label>
            <div className="admin-actions">
              <Button isLoading={searchingSources} type="submit" variant="secondary">
                Search source records
              </Button>
            </div>
          </form>
          {sourceSearchError ? <p className="admin-feedback" data-tone="error" role="alert">{sourceSearchError}</p> : null}
          {sourceResults.length > 0 ? (
            <ul className="investor-picks-admin__source-results" aria-label="Matching source records">
              {sourceResults.map((source) => {
                const selected = selectedSource?.signal.id === source.signal.id;
                return (
                  <li key={source.signal.id}>
                    <Button
                      aria-pressed={selected}
                      onClick={() => setSelectedSource(source)}
                      size="small"
                      variant={selected ? "primary" : "ghost"}
                    >
                      {selected ? "Selected" : "Select"}
                    </Button>
                    <span>
                      <strong>{sourceLabel(source)}</strong>
                      <span className="admin-user-meta">
                        {source.signal.sourceKey} · {source.signal.sourceLocator}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {hasSearchedSources &&
          sourceResults.length === 0 &&
          !searchingSources &&
          !sourceSearchError ? (
            <p>No matching source records found.</p>
          ) : null}
          <form className="admin-stack" onSubmit={submitExistingPick}>
            <label className="admin-field" htmlFor="investor-existing-note">
              <span className="admin-field__label">Administrator note (optional)</span>
              <textarea
                className="investor-picks-textarea"
                id="investor-existing-note"
                maxLength={4000}
                onChange={(event) => setExistingNote(event.target.value)}
                rows={3}
                value={existingNote}
              />
            </label>
            <div className="admin-actions">
              <Button
                disabled={
                  !selectedSource ||
                  loading ||
                  pendingAction !== undefined
                }
                isLoading={pendingAction === "create"}
                type="submit"
              >
                Add selected source approval
              </Button>
              {selectedSource ? <span>Selected: {sourceLabel(selectedSource)}</span> : null}
            </div>
          </form>
        </section>

        <section className="admin-panel" aria-labelledby="manual-candidate-heading">
          <div className="admin-panel__header">
            <div>
              <h2 id="manual-candidate-heading">Add a manual approval</h2>
              <p>
                Use this when no appropriate source observation can be selected.
                A safely matching existing identity may be reused; otherwise this
                is stored as an unverified candidate identity.
              </p>
            </div>
          </div>
          <form className="admin-form-grid" onSubmit={submitManualPick}>
            <label className="admin-field" htmlFor="investor-manual-name">
              <span className="admin-field__label">Company name</span>
              <Input
                id="investor-manual-name"
                maxLength={500}
                onChange={(event) => setManualName(event.target.value)}
                required
                value={manualName}
              />
            </label>
            <label className="admin-field" htmlFor="investor-manual-domain">
              <span className="admin-field__label">Candidate domain (optional)</span>
              <Input
                id="investor-manual-domain"
                maxLength={253}
                onChange={(event) => setManualDomain(event.target.value)}
                placeholder="example.com"
                value={manualDomain}
              />
            </label>
            <label className="admin-field investor-picks-admin__full-width" htmlFor="investor-manual-note">
              <span className="admin-field__label">Administrator note (optional)</span>
              <textarea
                className="investor-picks-textarea"
                id="investor-manual-note"
                maxLength={4000}
                onChange={(event) => setManualNote(event.target.value)}
                rows={4}
                value={manualNote}
              />
            </label>
            <div className="admin-actions investor-picks-admin__full-width">
              <Button
                disabled={loading || pendingAction !== undefined}
                isLoading={pendingAction === "create"}
                type="submit"
              >
                Add manual approval
              </Button>
            </div>
          </form>
        </section>
      </div>

      <section className="admin-panel" aria-labelledby="current-picks-heading">
        <div className="admin-panel__header">
          <div>
            <h2 id="current-picks-heading">Managed Golden approvals</h2>
            <p>
              {page.total} active and archived approvals. Archiving removes
              investor approval without deleting its provenance.
            </p>
          </div>
          <Button
            disabled={loading || pendingAction !== undefined}
            onClick={() => void loadPicks()}
            size="small"
            variant="ghost"
          >
            Refresh
          </Button>
        </div>
        {page.items.length === 0 ? <p>No Golden approvals have been added.</p> : null}
        <div className="investor-picks-admin__list">
          {page.items.map((pick) => (
            <AdminPickCard
              busy={loading || pendingAction !== undefined}
              key={pick.id}
              pending={pendingAction === pick.id}
              pick={pick}
              onUpdate={updatePick}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function AdminPickCard({
  busy,
  onUpdate,
  pending,
  pick,
}: Readonly<{
  busy: boolean;
  onUpdate: (
    id: string,
    input: InvestorPickUpdateInput,
    successMessage: string,
  ) => Promise<void>;
  pending: boolean;
  pick: InvestorPickDto;
}>) {
  const [note, setNote] = useState(pick.note ?? "");

  useEffect(() => {
    setNote(pick.note ?? "");
  }, [pick.note]);

  return (
    <article className="investor-picks-admin__pick" data-active={pick.active}>
      <div className="investor-picks-admin__pick-header">
        <div>
          <h3>
            <Link href={`/signals/${pick.sourceSignalId}`}>{pick.name}</Link>
          </h3>
          <p className="admin-user-meta">{identityDescription(pick)}</p>
          <details className="investor-picks-admin__provenance">
            <summary>Advanced provenance</summary>
            <p className="admin-user-meta">{provenance(pick)}</p>
            <p className="admin-user-meta">
              Historical source labels explain how this approval was entered;
              they are not scientific qualification.
            </p>
          </details>
        </div>
        <div className="investor-picks-admin__pick-status">
          {pick.active ? <GoldenBadge /> : <Badge tone="neutral">Archived</Badge>}
          <span>
            {pick.active
              ? "Active investor approval"
              : "Archived: not currently investor approved"}
          </span>
          <span>
            {pick.researchScore === null
              ? "Scientific score unknown / unscored"
              : `Scientific score ${pick.researchScore}`}
          </span>
          <span>
            {pick.readiness.replaceAll("_", " ")} · Jev{" "}
            {pick.jevCurrent ? "current" : "not current"}
          </span>
          <span>Muse: {pick.museStatus ?? "no recorded current status"}</span>
        </div>
      </div>
      <form
        className="investor-picks-admin__note-form"
        onSubmit={(event) => {
          event.preventDefault();
          void onUpdate(
            pick.id,
            { note: note.trim() },
            "Investor approval note saved.",
          );
        }}
      >
        <label className="admin-field" htmlFor={`investor-pick-note-${pick.id}`}>
          <span className="admin-field__label">Administrator note</span>
          <textarea
            className="investor-picks-textarea"
            id={`investor-pick-note-${pick.id}`}
            maxLength={4000}
            onChange={(event) => setNote(event.target.value)}
            rows={3}
            value={note}
          />
        </label>
        <div className="admin-actions">
          <Button
            disabled={busy}
            isLoading={pending}
            size="small"
            type="submit"
            variant="secondary"
          >
            Save note
          </Button>
          <Button
            disabled={busy}
            isLoading={pending}
            onClick={() =>
              void onUpdate(
                pick.id,
                { active: !pick.active },
                pick.active
                  ? "Investor approval archived. Its provenance and note were retained."
                  : "Investor approval restored to the active Golden collection.",
              )
            }
            size="small"
            variant={pick.active ? "danger" : "primary"}
          >
            {pick.active ? "Archive approval" : "Restore approval"}
          </Button>
        </div>
      </form>
    </article>
  );
}
