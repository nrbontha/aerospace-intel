"use client";

import { Badge, Button, EmptyState } from "@asi/ui";
import Link from "next/link";
import {
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { apiJson } from "@/components/csrf-client";
import { InvestorRankingDisplay } from "@/components/investor-ranking";
import {
  isNavigableHttpUrl,
  type JevSourceReferenceDto,
  type JsonRecord,
  type SignalAnalystCaseDto,
  type SignalAnalystStepDto,
  type SignalDetailDto,
} from "@/lib/signal-analyst";

const REFRESH_INTERVAL_MS = 30_000;

function recordValue(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "Not recorded";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString();
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "Unknown";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function LabeledValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="signal-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function SafeLocator({ value, label }: { value: string; label?: string }) {
  return isNavigableHttpUrl(value) ? (
    <a href={value} rel="noreferrer" target="_blank">
      {label ?? value}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  ) : (
    <span>{value}</span>
  );
}

function SourceReferences({ references }: { references: readonly JevSourceReferenceDto[] }) {
  if (references.length === 0) return <span>No source reference recorded</span>;
  return (
    <ul className="signal-citations">
      {references.map((reference, index) => {
        const locator = reference.url ?? reference.sourceLocator ?? null;
        return (
          <li key={`${reference.kind}-${locator ?? "unknown"}-${index}`}>
            <strong>
              {reference.kind === "source_document"
                ? reference.title || reference.sourceKind || "Source document"
                : reference.sourceKey || "Source signal"}
            </strong>
            {locator ? (
              <>
                {" — "}
                <SafeLocator value={locator} />
              </>
            ) : null}
            {reference.quote ? <blockquote>{reference.quote}</blockquote> : null}
            {reference.caveat ? (
              <span className="signal-citation__meta">
                Representation caveat: {reference.caveat}
              </span>
            ) : null}
            <span className="signal-citation__meta">
              {reference.role ? `${reference.role}; ` : ""}
              {reference.firstParty === true ? "first party; " : ""}
              {reference.contentSha256
                ? `sha256:${reference.contentSha256}; `
                : ""}
              {reference.retrievedAt
                ? `retrieved ${formatTime(reference.retrievedAt)}`
                : "retrieval time unknown"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

type EvidenceReference = Readonly<{
  evidenceId: string;
  stage: string | null;
  role: string | null;
  url: string | null;
  quote: string | null;
  firstParty: boolean | null;
}>;

function evidenceReferences(researchEvidence: JsonRecord | null): EvidenceReference[] {
  const raw = researchEvidence?.["evidenceRefs"];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const reference = recordValue(item);
    const evidenceId = textValue(reference?.["evidenceId"]);
    if (reference === null || evidenceId === null) return [];
    return [
      {
        evidenceId,
        stage: textValue(reference["stage"]),
        role: textValue(reference["role"]),
        url: textValue(reference["url"]),
        quote: textValue(reference["quote"]),
        firstParty:
          typeof reference["firstParty"] === "boolean"
            ? reference["firstParty"]
            : null,
      },
    ];
  });
}

function MemoEvidence({ ids, evidence }: { ids: readonly string[]; evidence: readonly EvidenceReference[] }) {
  if (ids.length === 0) {
    return <p className="asi-page-description">No evidence IDs cited.</p>;
  }
  return (
    <ul className="signal-citations">
      {ids.map((id) => {
        const reference = evidence.find((candidate) => candidate.evidenceId === id);
        return (
          <li key={id}>
            <code>{id}</code>
            {reference === undefined ? (
              <span className="signal-citation__meta">
                No matching active admitted citation was found for this ID.
              </span>
            ) : (
              <>
                <span className="signal-citation__meta">
                  {reference.stage ?? "stage unknown"} · {reference.role ?? "role unknown"}
                  {reference.firstParty === true ? " · first party" : ""}
                </span>
                {reference.url ? (
                  <SafeLocator value={reference.url} label={reference.url} />
                ) : (
                  <span>URL not recorded</span>
                )}
                {reference.quote ? <blockquote>{reference.quote}</blockquote> : null}
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function collectResourceReferences(
  value: unknown,
  depth = 0,
  inheritedRole?: JevSourceReferenceDto["role"],
): JevSourceReferenceDto[] {
  if (depth > 5 || value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      collectResourceReferences(item, depth + 1, inheritedRole),
    );
  }
  const record = value as Record<string, unknown>;
  const rawRole = textValue(record["supportRole"]);
  const localRole: JevSourceReferenceDto["role"] =
    rawRole === "discovery_only" ||
    rawRole === "candidate_evidence" ||
    rawRole === "checked_only"
      ? rawRole
      : inheritedRole;
  const references = record["sourceReferences"];
  const direct = Array.isArray(references)
    ? references.flatMap((item) => {
        const reference = recordValue(item);
        const locator = textValue(reference?.["locator"]);
        const finalUrl = textValue(reference?.["finalUrl"]);
        const resourceUrl = finalUrl ?? locator;
        if (reference === null || resourceUrl === null) return [];
        const replayCaveat = textValue(reference["replayCaveat"]);
        const contentSha256 = textValue(reference["contentSha256"]);
        const role: JevSourceReferenceDto["role"] =
          reference["representation"] === "checked_failure"
            ? "checked_only"
            : localRole;
        return [
          {
            kind: "source_document" as const,
            url: resourceUrl,
            title:
              textValue(reference["representation"]) ?? "Resource observation",
            ...(replayCaveat === null ? {} : { caveat: replayCaveat }),
            ...(contentSha256 === null ? {} : { contentSha256 }),
            retrievedAt: textValue(reference["retrievedAt"]),
            ...(role === undefined ? {} : { role }),
          },
        ];
      })
    : [];
  return [
    ...direct,
    ...Object.entries(record).flatMap(([key, child]) =>
      key === "sourceReferences"
        ? []
        : collectResourceReferences(child, depth + 1, localRole),
    ),
  ].slice(0, 100);
}

function findTextByKey(value: unknown, key: string, depth = 0): string | null {
  if (depth > 5 || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findTextByKey(child, key, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  const direct = textValue(record[key]);
  if (direct !== null) return direct;
  for (const child of Object.values(record)) {
    const found = findTextByKey(child, key, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function findRecordByKey(
  value: unknown,
  key: string,
  depth = 0,
): JsonRecord | null {
  if (depth > 5 || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findRecordByKey(child, key, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  const record = value as JsonRecord;
  const direct = recordValue(record[key]);
  if (direct !== null) return direct;
  for (const child of Object.values(record)) {
    const found = findRecordByKey(child, key, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function ResearchStep({ step }: { step: SignalAnalystStepDto }) {
  const references = collectResourceReferences(step.response);
  const accessLimit = findTextByKey(step.response, "accessLimit");
  const failureMessage = textValue(
    findRecordByKey(step.response, "failure")?.["message"],
  );
  return (
    <li className="signal-step">
      <div className="signal-step__heading">
        <strong>
          #{step.sequence} {step.kind}
        </strong>
        <Badge>{step.status}</Badge>
      </div>
      <dl className="signal-facts signal-facts--compact">
        <LabeledValue label="Started">{formatTime(step.startedAt)}</LabeledValue>
        <LabeledValue label="Finished">{formatTime(step.finishedAt)}</LabeledValue>
        <LabeledValue label="Cost">
          {step.costKnown && step.costUsd !== null
            ? `$${step.costUsd} known actual`
            : "Unknown — no known actual charge was recorded"}
        </LabeledValue>
        <LabeledValue label="Request hash">
          <code>{step.requestHash}</code>
        </LabeledValue>
      </dl>
      {step.status === "late_result" ? (
        <p className="admin-feedback" data-tone="error">
          Late result observed {formatTime(step.lateObservedAt)}; retained as an
          observation, not completed current work.
        </p>
      ) : null}
      {accessLimit ? (
        <p className="admin-feedback" data-tone="error">
          Access limit: {accessLimit}
        </p>
      ) : null}
      {step.error || failureMessage ? (
        <p className="admin-feedback" data-tone="error">
          {step.error ?? failureMessage}
        </p>
      ) : null}
      <h4>Resource citations</h4>
      <SourceReferences references={references} />
      <details>
        <summary>Request and retained observation</summary>
        <h5>Request</h5>
        <pre className="signal-json">{JSON.stringify(step.request, null, 2)}</pre>
        <h5>Observation</h5>
        <pre className="signal-json">
          {step.response === null
            ? "No response retained"
            : JSON.stringify(step.response, null, 2)}
        </pre>
      </details>
    </li>
  );
}

function SpendSummary({ analystCase }: { analystCase: SignalAnalystCaseDto }) {
  const provider = analystCase.providerSpend;
  const model = analystCase.modelSpend;
  return (
    <div className="admin-stack">
      <dl className="signal-facts">
        <LabeledValue label="Provider known actual">
          ${provider.knownActualCostUsd} across {provider.receiptCount} receipt(s)
        </LabeledValue>
        <LabeledValue label="Provider unknown">
          {provider.unknownReceiptCount > 0
            ? `$${provider.unknownEstimatedCostUsd} reserved estimate across ${provider.unknownReceiptCount} receipt(s); actual charge unknown`
            : "No unknown provider receipts"}
        </LabeledValue>
        <LabeledValue label="Model known actual">
          ${model.knownActualCostUsd} across {model.receiptCount} receipt(s)
        </LabeledValue>
        <LabeledValue label="Model unknown">
          {model.unknownReceiptCount > 0
            ? `${model.unknownReceiptCount} receipt(s) have unknown actual model cost`
            : "No unknown model receipts"}
        </LabeledValue>
      </dl>
      {analystCase.providerUsage.length > 0 ? (
        <details>
          <summary>Visible provider receipts</summary>
          <ul className="signal-citations">
            {analystCase.providerUsage.map((receipt, index) => {
              const id = textValue(receipt["id"]) ?? `receipt-${index}`;
              const actual = textValue(receipt["actualCostUsd"]);
              return (
                <li key={id}>
                  <strong>
                    {displayValue(receipt["provider"])} ·{" "}
                    {displayValue(receipt["operation"])}
                  </strong>
                  <span className="signal-citation__meta">
                    {displayValue(receipt["status"])} ·{" "}
                    {actual === null
                      ? `actual unknown; reserved estimate $${displayValue(receipt["estimatedCostUsd"])}`
                      : `known actual $${actual}`}
                  </span>
                  {textValue(receipt["error"]) ? (
                    <span>{textValue(receipt["error"])}</span>
                  ) : null}
                  {textValue(receipt["providerCooldownRetryAt"]) ? (
                    <span className="signal-citation__meta">
                      Retry after{" "}
                      {formatTime(textValue(receipt["providerCooldownRetryAt"]))}:{" "}
                      {displayValue(receipt["providerCooldownReason"])}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function MemoPanel({
  analystCase,
  evidence,
  title,
}: {
  analystCase: SignalAnalystCaseDto;
  evidence: readonly EvidenceReference[];
  title: string;
}) {
  const memo = analystCase.memo;
  const applicableEvidence =
    analystCase.current && memo?.inputHash === analystCase.case.inputHash
      ? evidence
      : [];
  return (
    <section className="admin-panel admin-stack">
      <div className="signal-section-heading">
        <h3>{title}</h3>
        <Badge tone={analystCase.memoCurrent ? "success" : "warning"}>
          {analystCase.memoCurrent ? "current research memo" : "draft / historical"}
        </Badge>
      </div>
      <dl className="signal-facts">
        <LabeledValue label="Case status">{analystCase.case.status}</LabeledValue>
        <LabeledValue label="Case input hash">
          <code>{analystCase.case.inputHash}</code>
        </LabeledValue>
        <LabeledValue label="Memo input hash">
          {memo ? <code>{memo.inputHash}</code> : "No validated memo"}
        </LabeledValue>
        <LabeledValue label="Current proof">
          {analystCase.current ? "Matches current Jev proof" : "Does not match current Jev proof"}
        </LabeledValue>
        <LabeledValue label="Next retry">
          {formatTime(analystCase.case.nextAttemptAt)}
        </LabeledValue>
        <LabeledValue label="Stop reason">
          {analystCase.case.stopReason ?? "Not recorded"}
        </LabeledValue>
      </dl>
      {memo ? (
        <>
          <div>
            <h4>Model analysis summary</h4>
            <p>{memo.summary.text}</p>
          </div>
          <div>
            <h4>Answers and unresolved questions</h4>
            {memo.answers.length === 0 ? (
              <p className="asi-page-description">No memo answers recorded.</p>
            ) : (
              <ol className="signal-answer-list">
                {memo.answers.map((answer) => (
                  <li key={`${answer.gapId}-${answer.field}`}>
                    <div className="signal-section-heading">
                      <strong>{answer.field}</strong>
                      <Badge
                        tone={answer.status === "answered" ? "success" : "warning"}
                      >
                        {answer.status}
                      </Badge>
                    </div>
                    <p>
                      <code>{answer.gapId}</code>: {answer.answer || "No answer; remains unresolved."}
                    </p>
                    <MemoEvidence
                      ids={answer.evidenceIds}
                      evidence={applicableEvidence}
                    />
                  </li>
                ))}
              </ol>
            )}
          </div>
          <div>
            <h4>Next actions</h4>
            {memo.nextActions.length > 0 ? (
              <ul>
                {memo.nextActions.map((action) => (
                  <li key={action}>{action}</li>
                ))}
              </ul>
            ) : (
              <p className="asi-page-description">No next action recorded.</p>
            )}
          </div>
        </>
      ) : analystCase.case.memo ? (
        <details>
          <summary>Unrecognized historical memo payload</summary>
          <p className="asi-page-description">
            This stored payload did not validate against signal-analyst-memo-v1
            and is not a current research memo.
          </p>
          <pre className="signal-json">
            {JSON.stringify(analystCase.case.memo, null, 2)}
          </pre>
        </details>
      ) : (
        <p className="asi-page-description">No memo has been stored for this case.</p>
      )}
      <div>
        <h4>Case-wide spend</h4>
        <SpendSummary analystCase={analystCase} />
      </div>
      <div>
        <h4>Resource and model attempts</h4>
        {analystCase.steps.length === 0 ? (
          <p className="asi-page-description">No retained attempts.</p>
        ) : (
          <ol className="signal-step-list">
            {analystCase.steps.map((step) => (
              <ResearchStep key={step.id} step={step} />
            ))}
          </ol>
        )}
        {analystCase.hasMoreSteps ? (
          <p className="asi-page-description">
            Only the newest bounded step page is shown. Case-wide spend above
            includes all steps, not only visible attempts.
          </p>
        ) : null}
      </div>
    </section>
  );
}

export function SignalDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [detail, setDetail] = useState<SignalDetailDto>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefreshPaused, setAutoRefreshPaused] = useState(false);
  const [lastSuccessfulRefresh, setLastSuccessfulRefresh] = useState<Date>();
  const [error, setError] = useState<string>();
  const activeRequestRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);

  const load = useCallback(
    (showInitialLoading: boolean): AbortController | null => {
      const activeRequest = activeRequestRef.current;
      if (activeRequest !== null && !activeRequest.signal.aborted) return null;

      const controller = new AbortController();
      const generation = ++generationRef.current;
      activeRequestRef.current = controller;
      if (showInitialLoading) setLoading(true);
      else setRefreshing(true);
      setError(undefined);

      void apiJson<SignalDetailDto>(
        `/api/v1/signals/${encodeURIComponent(id)}?caseLimit=10&stepLimit=25`,
        { signal: controller.signal },
      )
        .then((nextDetail) => {
          if (
            controller.signal.aborted ||
            generation !== generationRef.current
          ) {
            return;
          }
          setDetail(nextDetail);
          setLastSuccessfulRefresh(new Date());
        })
        .catch((caught: unknown) => {
          if (
            controller.signal.aborted ||
            generation !== generationRef.current
          ) {
            return;
          }
          setError(
            caught instanceof Error
              ? caught.message
              : "Unable to load this signal.",
          );
        })
        .finally(() => {
          if (
            activeRequestRef.current !== controller ||
            generation !== generationRef.current
          ) {
            return;
          }
          activeRequestRef.current = null;
          setLoading(false);
          setRefreshing(false);
        });

      return controller;
    },
    [id],
  );

  useEffect(() => {
    activeRequestRef.current?.abort();
    activeRequestRef.current = null;
    generationRef.current += 1;
    setDetail(undefined);
    const controller = load(true);
    return () => controller?.abort();
  }, [id, load]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      activeRequestRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    const refreshForVisibility = () => {
      if (
        document.visibilityState === "visible" &&
        !autoRefreshPaused
      ) {
        load(false);
      }
    };
    const timer = autoRefreshPaused
      ? undefined
      : window.setInterval(() => {
          if (document.visibilityState === "visible") load(false);
        }, REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", refreshForVisibility);
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshForVisibility);
    };
  }, [autoRefreshPaused, load]);

  if (loading || (detail !== undefined && detail.signal.id !== id)) {
    return <div className="admin-panel" role="status">Loading source signal…</div>;
  }
  if (detail === undefined) {
    return (
      <EmptyState
        title="Signal unavailable"
        description={<p>{error ?? "The requested signal could not be found."}</p>}
        action={
          <div className="admin-actions">
            <Button onClick={() => load(true)}>Try again</Button>
            <Link href="/signals">Back to research queue</Link>
          </div>
        }
      />
    );
  }

  const { signal, review, currentTriage, currentCase } = detail;
  const research = recordValue(review?.researchEvidence) ?? {};
  const evidenceRevisionCurrent =
    review !== null && review.sourceRevision === signal.reviewRevision;
  const identity = recordValue(research["identity"]);
  const evidence = evidenceReferences(research);
  const triage = currentTriage?.parsed;
  const historicalCases = detail.history.filter(
    (item) => item.case.id !== currentCase?.case.id,
  );

  return (
    <div className="admin-stack" aria-busy={refreshing}>
      <header className="asi-page-header">
        <p className="asi-page-kicker">
          <Link href="/signals">Investor research queue</Link> / Raw observation
        </p>
        <h1 className="asi-page-title">{signal.rawName}</h1>
        <p className="asi-page-description">
          Read-only pre-promotion analysis. Raw source identity and verified
          evidence remain separate; this record is not presented as a canonical
          company.
        </p>
        <div className="admin-actions">
          <Badge>{signal.status}</Badge>
          <Badge tone={signal.companyId ? "info" : "neutral"}>
            {signal.companyId ? "linked projection exists" : "unpromoted raw signal"}
          </Badge>
        </div>
      </header>

      <section className="admin-panel signal-refresh-bar" aria-label="Live refresh">
        <div aria-live="polite">
          <strong>
            {autoRefreshPaused ? "Automatic refresh paused" : "Live detail refresh on"}
          </strong>
          <span className="signal-refresh-bar__meta">
            Approximately every 30 seconds while this tab is visible · Last
            successful refresh:{" "}
            {lastSuccessfulRefresh
              ? lastSuccessfulRefresh.toLocaleString()
              : "Not yet"}
          </span>
        </div>
        <div className="admin-actions">
          <Button
            type="button"
            variant="secondary"
            disabled={refreshing}
            onClick={() => load(false)}
          >
            {refreshing ? "Refreshing…" : "Refresh now"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            aria-pressed={autoRefreshPaused}
            onClick={() => setAutoRefreshPaused((paused) => !paused)}
          >
            {autoRefreshPaused ? "Resume automatic refresh" : "Pause automatic refresh"}
          </Button>
        </div>
      </section>

      {error ? (
        <div className="signal-refresh-error" role="alert">
          <p className="admin-feedback" data-tone="error">
            {error} The last successful detail remains visible.
          </p>
          <Button
            type="button"
            variant="secondary"
            disabled={refreshing}
            onClick={() => load(false)}
          >
            Retry refresh
          </Button>
        </div>
      ) : null}

      <div className="signal-card-grid signal-ranking-grid">
        <InvestorRankingDisplay ranking={detail.ranking} />
        <section className="admin-panel admin-stack">
          <div className="signal-section-heading">
            <h2>Current research progress</h2>
            <Badge tone={triage ? "success" : "warning"}>
              {triage ? "Jev current" : "Jev not current"}
            </Badge>
          </div>
          <p className="asi-page-description">
            Acquisition readiness and research progress are evidence state, not
            an investment approval.
          </p>
          <dl className="signal-facts signal-facts--compact">
            <LabeledValue label="Acquisition readiness">
              {triage ? (
                <Badge
                  tone={
                    triage.acquisitionReadiness === "ready"
                      ? "success"
                      : triage.acquisitionReadiness === "blocked"
                        ? "danger"
                        : "warning"
                  }
                >
                  {triage.acquisitionReadiness.replaceAll("_", " ")}
                </Badge>
              ) : (
                <>
                  <Badge tone="warning">unknown / unscored</Badge>{" "}
                  No current-policy Jev result
                </>
              )}
            </LabeledValue>
            <LabeledValue label="Open research gaps">
              {triage
                ? `${triage.gaps.length} unresolved`
                : "Unknown until current triage"}
            </LabeledValue>
            <LabeledValue label="Jev product fit">
              {triage
                ? triage.productFit.replaceAll("_", " ")
                : "No current proof"}
            </LabeledValue>
            <LabeledValue label="Muse case">
              {currentCase
                ? `${currentCase.case.status} · ${
                    currentCase.current ? "current proof" : "historical proof"
                  }`
                : "No current-policy case"}
            </LabeledValue>
            <LabeledValue label="Muse research memo">
              {currentCase?.memoCurrent
                ? "Current research memo"
                : currentCase?.memo
                  ? "Draft or historical memo"
                  : "Not available"}
            </LabeledValue>
            <LabeledValue label="Review stage">
              {review?.phase ?? "Not started"}
            </LabeledValue>
          </dl>
        </section>
      </div>

      <div className="signal-card-grid">
        <section className="admin-panel admin-stack">
          <h2>Raw source identity</h2>
          <dl className="signal-facts">
            <LabeledValue label="Raw name">{signal.rawName}</LabeledValue>
            <LabeledValue label="Raw domain">{signal.rawDomain ?? "Unknown"}</LabeledValue>
            <LabeledValue label="UEI">{signal.uei ?? "Unknown"}</LabeledValue>
            <LabeledValue label="CAGE">{signal.cage ?? "Unknown"}</LabeledValue>
            <LabeledValue label="Location">
              {[signal.city, signal.state, signal.country].filter(Boolean).join(", ") || "Unknown"}
            </LabeledValue>
            <LabeledValue label="Source">
              {signal.sourceKey} · <SafeLocator value={signal.sourceLocator} />
            </LabeledValue>
            <LabeledValue label="Fingerprint">
              <code>{signal.sourceFingerprint}</code>
            </LabeledValue>
          </dl>
        </section>
        <section className="admin-panel admin-stack">
          <h2>Verified identity evidence</h2>
          <dl className="signal-facts">
            <LabeledValue label="Identity status">
              {review === null
                ? "No review evidence"
                : evidenceRevisionCurrent
                  ? displayValue(identity?.["status"])
                  : `${displayValue(identity?.["status"])} (historical source revision)`}
            </LabeledValue>
            <LabeledValue label="Verified domain">
              {displayValue(identity?.["verifiedDomain"])}
            </LabeledValue>
            <LabeledValue label="Canonical company">
              {signal.companyId ? (
                <Link href={`/companies/${signal.companyId}`}>{signal.companyId}</Link>
              ) : (
                "None — no company is created for this view"
              )}
            </LabeledValue>
            <LabeledValue label="Lead ID">{signal.leadId ?? "None"}</LabeledValue>
          </dl>
        </section>
        <section className="admin-panel admin-stack">
          <h2>Current lifecycle</h2>
          <dl className="signal-facts">
            <LabeledValue label="Stage">{review?.phase ?? "Not started"}</LabeledValue>
            <LabeledValue label="Signal revision">{signal.reviewRevision}</LabeledValue>
            <LabeledValue label="Review-state revision">
              {review?.sourceRevision ?? "None"}
              {review !== null && !evidenceRevisionCurrent ? " (historical)" : ""}
            </LabeledValue>
            <LabeledValue label="Review input hash">
              {review?.inputHash ? <code>{review.inputHash}</code> : "None"}
            </LabeledValue>
            <LabeledValue label="Next review attempt">
              {formatTime(review?.nextAttemptAt)}
            </LabeledValue>
            <LabeledValue label="Research retry">
              {formatTime(review?.researchDueAt)}
            </LabeledValue>
            <LabeledValue label="Last error">{review?.lastError ?? "None"}</LabeledValue>
          </dl>
        </section>
      </div>

      <section className="admin-panel admin-stack">
        <div className="signal-section-heading">
          <h2>Current Jev triage</h2>
          <Badge tone={triage ? "success" : "warning"}>
            {triage ? "current proof" : "not current"}
          </Badge>
        </div>
        {triage ? (
          <>
            <dl className="signal-facts">
              <LabeledValue label="Disposition">{triage.decision}</LabeledValue>
              <LabeledValue label="Product fit">
                {triage.productFit.replaceAll("_", " ")}
              </LabeledValue>
              <LabeledValue label="Acquisition readiness">
                {triage.acquisitionReadiness.replaceAll("_", " ")}
              </LabeledValue>
              <LabeledValue label="Research priority">
                {triage.researchPriority} (1 is highest)
              </LabeledValue>
            </dl>
            <p>{triage.explanation}</p>
            <div>
              <h3>Reason codes</h3>
              <ul className="signal-inline-list">
                {triage.reasonCodes.map((code) => <li key={code}><code>{code}</code></li>)}
              </ul>
            </div>
            <div>
              <h3>Research gaps</h3>
              {triage.gaps.length === 0 ? (
                <p className="asi-page-description">No triage gaps recorded.</p>
              ) : (
                <ol className="signal-answer-list">
                  {triage.gaps.map((gap) => (
                    <li key={gap.id}>
                      <div className="signal-section-heading">
                        <strong>{gap.question}</strong>
                        <Badge>priority {gap.priority}</Badge>
                      </div>
                      <p>{gap.reason}</p>
                      <code>{gap.id}</code>
                      <h4>Supporting sources</h4>
                      <SourceReferences references={gap.supportingSources} />
                      {gap.conflictingSources.length > 0 ? (
                        <>
                          <h4>Conflicting sources</h4>
                          <SourceReferences references={gap.conflictingSources} />
                        </>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
            </div>
            <div>
              <h3>Rung observations</h3>
              <ol className="signal-answer-list">
                {triage.observations.map((observation, index) => (
                  <li key={`${observation.rung}-${observation.field}-${index}`}>
                    <div className="signal-section-heading">
                      <strong>{observation.field}: {displayValue(observation.value)}</strong>
                      <Badge>{observation.kind.replaceAll("_", " ")}</Badge>
                    </div>
                    <p>{observation.explanation}</p>
                    <SourceReferences references={observation.sourceReferences} />
                  </li>
                ))}
              </ol>
            </div>
          </>
        ) : (
          <p className="asi-page-description">
            No Jev result matches this signal revision, input hash, evaluation
            pointer, and current model/policy contract. Older evidence is not
            labelled current.
          </p>
        )}
      </section>

      <section className="admin-stack" aria-labelledby="current-research-heading">
        <h2 id="current-research-heading">Persistent Muse research</h2>
        {currentCase ? (
          <MemoPanel analystCase={currentCase} evidence={evidence} title="Current-policy case" />
        ) : (
          <div className="admin-panel">
            <p className="asi-page-description">
              No source-revision and analyst-policy current case exists.
            </p>
          </div>
        )}
      </section>

      <section className="admin-stack" aria-labelledby="history-heading">
        <h2 id="history-heading">Historical cases and drafts</h2>
        <p className="asi-page-description">
          Showing up to {detail.historyLimit} newest cases. Historical and draft
          memos are never labelled as current research answers.
        </p>
        {historicalCases.length === 0 ? (
          <div className="admin-panel">
            <p className="asi-page-description">No additional case history.</p>
          </div>
        ) : (
          historicalCases.map((analystCase) => (
            <MemoPanel
              key={analystCase.case.id}
              analystCase={analystCase}
              evidence={evidence}
              title={`Case from ${formatTime(analystCase.case.createdAt)}`}
            />
          ))
        )}
      </section>

      <details className="admin-panel">
        <summary>Raw source payload and qualification metadata</summary>
        <p className="asi-page-description">
          Imported source content is displayed as text and is not trusted HTML.
        </p>
        <h3>Source payload</h3>
        <pre className="signal-json">{JSON.stringify(signal.sourcePayload, null, 2)}</pre>
        <h3>Qualification metadata</h3>
        <pre className="signal-json">{JSON.stringify(signal.qualification, null, 2)}</pre>
      </details>
    </div>
  );
}
