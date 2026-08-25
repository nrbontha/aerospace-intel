"use client";

import type {
  CandidateDto,
  FeedbackDto,
  ResearchQuestionDto,
} from "@asi/contracts";
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Tab,
  TabPanel,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
} from "@asi/ui";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { apiJson } from "@/components/csrf-client";
import {
  CandidateSynthesisSection,
  type CompanySynthesisTrail,
} from "@/components/candidate-profile/synthesis-trail";

import {
  AxisChip,
  NoveltyBadge,
  StatusBadge,
  formatInstant,
  humanLabel,
} from "@/components/target-feed/candidate-bits";
import { RowStatusMenu } from "@/components/target-feed/target-feed";
import {
  createResearchQuestion,
  getCandidateDetail,
  getCompanyProfile,
  listFeedbackForCandidate,
  listResearchQuestions,
  type CandidateDetail,
  type CompanyProfile,
} from "@/lib/target-feed-api";

function ListSection({
  title,
  items,
  emptyText,
}: {
  title: string;
  items: readonly string[];
  emptyText: string;
}) {
  return (
    <div className="admin-stack">
      <h3>{title}</h3>
      {items.length === 0 ? (
        <p className="asi-page-description">{emptyText}</p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ScoreHistoryTimeline({ detail }: { detail: CandidateDetail }) {
  if (detail.scores.length === 0) {
    return (
      <EmptyState
        title="No score history yet"
        description="Score rows are appended each time the champion program scores this candidate."
      />
    );
  }
  return (
    <ol style={{ listStyle: "none", padding: 0, display: "grid", gap: "0.75rem" }}>
      {detail.scores.map((score) => (
        <li key={score.id}>
          <div className="admin-stack">
            <span>
              <strong>{humanLabel(score.axis)}</strong>{" "}
              {score.value === null ? "—" : Math.round(score.value)}{" "}
              <span className="asi-page-description">
                computed {formatInstant(score.computedAt)}
              </span>
            </span>
            <span className="asi-page-description">
              feature schema {score.featureSchemaVersion}
              {score.scoringProgramId === null
                ? ""
                : ` · scoring program ${score.scoringProgramId.slice(0, 8)}…`}
            </span>
            {Object.keys(score.details).length > 0 ? (
              <details>
                <summary>Computation details</summary>
                <pre style={{ overflowX: "auto", fontSize: "0.75rem", margin: "0.25rem 0" }}>
                  {JSON.stringify(score.details, null, 2)}
                </pre>
              </details>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function FeatureSnapshotViewer({ detail }: { detail: CandidateDetail }) {
  const snapshot = detail.featureSnapshot;
  if (snapshot === null) {
    return (
      <EmptyState
        title="No feature snapshot"
        description="A feature snapshot is captured when a company is scored; none exists for this candidate's company yet."
      />
    );
  }
  const features = snapshot.features as Record<string, unknown>;
  const revenueBand = features["revenue_band"];
  const ownershipType =
    (features["ownership"] as Record<string, unknown> | undefined)?.[
      "ownershipType"
    ] ?? features["ownership_type"];
  return (
    <div className="admin-stack">
      <p className="asi-page-description">
        Snapshot {snapshot.id.slice(0, 8)}… · schema {snapshot.schemaVersion} ·
        captured {formatInstant(snapshot.createdAt)} · sha256{" "}
        {snapshot.contentSha256.slice(0, 12)}…
      </p>
      <p>
        Revenue band:{" "}
        <Badge tone={revenueBand === "unknown" ? "neutral" : "info"}>
          {typeof revenueBand === "string" ? revenueBand : "—"}
        </Badge>{" "}
        Ownership:{" "}
        <Badge tone={ownershipType === "unknown" ? "neutral" : "info"}>
          {typeof ownershipType === "string" ? ownershipType : "—"}
        </Badge>
      </p>
      <details>
        <summary>Feature JSON</summary>
        <pre style={{ overflowX: "auto", fontSize: "0.75rem", margin: "0.25rem 0" }}>{JSON.stringify(features, null, 2)}</pre>
      </details>
    </div>
  );
}

function FeedbackHistory({ candidateId, reloadKey }: { candidateId: string; reloadKey: number }) {
  const [feedback, setFeedback] = useState<readonly FeedbackDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    listFeedbackForCandidate(candidateId, controller.signal)
      .then((page) => setFeedback(page.data))
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setError(
            caught instanceof Error ? caught.message : "Failed to load feedback.",
          );
        }
      });
    return () => controller.abort();
  }, [candidateId, reloadKey]);

  if (error !== null) {
    return (
      <p className="admin-feedback" data-tone="error" role="alert">
        {error}
      </p>
    );
  }
  if (feedback === null) {
    return <p className="asi-page-description">Loading feedback…</p>;
  }
  if (feedback.length === 0) {
    return (
      <EmptyState
        title="No feedback recorded"
        description="Analyst decisions and partner review outcomes appear here as they are recorded."
      />
    );
  }
  return (
    <Table>
      <TableCaption>
        {feedback.length.toLocaleString()} feedback record
        {feedback.length === 1 ? "" : "s"}
      </TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>When</TableHead>
          <TableHead>Channel</TableHead>
          <TableHead>Action</TableHead>
          <TableHead>Reason / note</TableHead>
          <TableHead>Actor</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {feedback.map((entry) => (
          <TableRow key={entry.id}>
            <TableCell>{formatInstant(entry.createdAt)}</TableCell>
            <TableCell>
              <Badge tone="neutral">{humanLabel(entry.channel)}</Badge>
            </TableCell>
            <TableCell>{humanLabel(entry.action)}</TableCell>
            <TableCell>
              {entry.reason ?? "—"}
              {entry.notes === null ? null : (
                <span className="asi-page-description">{entry.notes}</span>
              )}
            </TableCell>
            <TableCell>{entry.actor.slice(0, 8)}…</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ResearchQuestionsPanel({ candidateId }: { candidateId: string }) {
  const [questions, setQuestions] = useState<readonly ResearchQuestionDto[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      try {
        const page = await listResearchQuestions(candidateId, signal);
        setQuestions(page.data);
        setError(null);
      } catch (caught) {
        if (!signal.aborted) {
          setError(
            caught instanceof Error
              ? caught.message
              : "Failed to load questions.",
          );
        }
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [candidateId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function submit(): Promise<void> {
    const question = draft.trim();
    if (question === "") return;
    setSubmitting(true);
    setError(null);
    try {
      await createResearchQuestion({ candidateId, question });
      setDraft("");
      await load(new AbortController().signal);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not add the question.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="admin-stack">
      <form
        className="admin-form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="admin-field">
          <span className="admin-field__label">New research question</span>
          <Input
            maxLength={2000}
            placeholder="e.g. Confirm current ownership and any sponsor involvement"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <div className="admin-actions">
          <Button
            size="small"
            type="submit"
            disabled={submitting || draft.trim() === ""}
          >
            Add question
          </Button>
        </div>
      </form>
      {error !== null ? (
        <p className="admin-feedback" data-tone="error" role="alert">
          {error}
        </p>
      ) : null}
      {loading ? (
        <p className="asi-page-description">Loading questions…</p>
      ) : questions.length === 0 ? (
        <p className="asi-page-description">
          No research questions opened yet.
        </p>
      ) : (
        <ul>
          {questions.map((question) => (
            <li key={question.id}>
              {question.question}{" "}
              <span className="asi-page-description">
                ({humanLabel(question.status)}, opened{" "}
                {formatInstant(question.createdAt)})
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EvidenceSection({ company }: { company: CompanyProfile | null }) {
  if (company === null) {
    return (
      <EmptyState
        title="Evidence unavailable"
        description="The underlying company record could not be loaded, so evidence-backed observations cannot be shown."
      />
    );
  }
  if (company.observations.length === 0) {
    return (
      <EmptyState
        title="No observations recorded"
        description="This company has no evidence-backed observations in the catalog yet. Nothing is inferred or sampled here."
      />
    );
  }
  return (
    <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: "1rem" }}>
      {company.observations.slice(0, 50).map((observation) => (
        <li key={observation.id} className="admin-stack">
          <span>
            <strong>{observation.fieldKey}</strong>
            {observation.isCanonical ? (
              <>
                {" "}
                <Badge tone="success">canonical</Badge>
              </>
            ) : null}
            {observation.observedAt === null
              ? ""
              : ` · observed ${formatInstant(observation.observedAt)}`}
          </span>
          <pre style={{ overflowX: "auto", fontSize: "0.75rem", margin: "0.25rem 0" }}>{JSON.stringify(observation.value)}</pre>
          {observation.evidenceQuote === null ? null : (
            <blockquote>“{observation.evidenceQuote}”</blockquote>
          )}
          <span className="asi-page-description">
            {observation.dataSourceName ?? "Unknown source"}
            {observation.documentCanonicalUrl === null ? null : (
              <>
                {" · "}
                <a href={observation.documentCanonicalUrl}>source document</a>
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

interface CurrentSession {
  readonly user: {
    readonly role: string;
  };
}


function SynthesisPanel({ companyId }: { companyId: string }) {
  const [trail, setTrail] = useState<CompanySynthesisTrail | null>(null);
  const [role, setRole] = useState<"analyst" | "viewer">("viewer");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    Promise.all([
      apiJson<CompanySynthesisTrail>(
        `/api/v1/companies/${encodeURIComponent(companyId)}/synthesis`,
        { signal: controller.signal },
      ),
      apiJson<CurrentSession>("/api/v1/auth/me", {
        signal: controller.signal,
      }),
    ])
      .then(([loadedTrail, session]) => {
        setTrail(loadedTrail);
        setRole(
          session.user.role === "analyst" || session.user.role === "admin"
            ? "analyst"
            : "viewer",
        );
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setTrail(null);
          setError(
            caught instanceof Error
              ? caught.message
              : "Failed to load source-backed synthesis.",
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [companyId, reloadKey]);

  const review = useCallback(
    async (
      action: "accept" | "reject",
      sourceDocumentId: string,
      expectedObservationIds: readonly string[],
    ): Promise<void> => {
      setReviewing(true);
      setError(null);
      try {
        await apiJson(
          `/api/v1/companies/${encodeURIComponent(companyId)}/synthesis`,
          {
            method: "POST",
            body: JSON.stringify({
              action,
              sourceDocumentId,
              expectedObservationIds,
            }),
          },
        );
        setReloadKey((key) => key + 1);
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : `Failed to ${action} the source record.`,
        );
      } finally {
        setReviewing(false);
      }
    },
    [companyId],
  );

  return (
    <CandidateSynthesisSection
      trail={trail}
      loading={loading}
      error={error}
      role={role}
      reviewing={reviewing}
      onAccept={(sourceDocumentId, expectedObservationIds) =>
        void review("accept", sourceDocumentId, expectedObservationIds)
      }
      onReject={(sourceDocumentId, expectedObservationIds) =>
        void review("reject", sourceDocumentId, expectedObservationIds)
      }
    />
  );
}

const TAB_ITEMS = [
  ["history", "Score history"],
  ["features", "Feature snapshot"],
  ["feedback", "Feedback history"],
  ["questions", "Research questions"],
  ["evidence", "Evidence"],
  ["synthesis", "Synthesis trail"],
] as const;

type TabKey = (typeof TAB_ITEMS)[number][0];

export function CandidateProfile({ candidateId }: { candidateId: string }) {
  const [detail, setDetail] = useState<CandidateDetail | null>(null);
  const [company, setCompany] = useState<CompanyProfile | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>("history");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    getCandidateDetail(candidateId, controller.signal)
      .then((result) => {
        setDetail(result);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setError(
            caught instanceof Error
              ? caught.message
              : "Failed to load candidate.",
          );
        }
      });
    return () => controller.abort();
  }, [candidateId, reloadKey]);

  useEffect(() => {
    if (detail === null) return;
    const controller = new AbortController();
    getCompanyProfile(detail.candidate.companyId, controller.signal)
      .then(setCompany)
      .catch(() => setCompany(null));
    return () => controller.abort();
  }, [detail]);

  if (error !== null) {
    return (
      <EmptyState
        title="Candidate unavailable"
        description={error}
        action={<Link href="/feed">Back to Target Feed</Link>}
      />
    );
  }
  if (detail === null) {
    return (
      <p className="asi-page-description" role="status">
        Loading candidate…
      </p>
    );
  }

  const candidate: CandidateDto = detail.candidate;
  const scores = candidate.currentScores;
  const noveltySnapshots = candidate.noveltySnapshotIds;

  return (
    <section aria-labelledby="candidate-profile-title">
      <header className="asi-page-header admin-stack">
        <p className="asi-page-kicker">Candidate profile</p>
        <h1 className="asi-page-title" id="candidate-profile-title">
          {company?.name ?? "Candidate"}
        </h1>
        <p className="asi-page-description">
          {company?.legalName !== undefined &&
          company.legalName !== null &&
          company.legalName !== company.name
            ? `${company.legalName} · `
            : ""}
          {company?.domains[0] ?? "no domain recorded"} ·{" "}
          {company?.headquartersCountryCode ?? "HQ unknown"} ·{" "}
          <Link href={`/companies/${candidate.companyId}`}>
            Open full company record
          </Link>
        </p>
        <div className="admin-actions">
          <StatusBadge status={candidate.status} />
          <NoveltyBadge novelty={candidate.noveltyStatus} />
          <AxisChip axis="fit" value={scores.fit} />
          <AxisChip axis="novelty" value={scores.novelty} />
          <AxisChip axis="confidence" value={scores.confidence} />
          <AxisChip axis="actionability" value={scores.actionability} />
        </div>
        <p className="asi-page-description">
          Research priority {candidate.researchPriority?.toFixed(1) ?? "—"} ·
          Partner review priority{" "}
          {candidate.partnerReviewPriority?.toFixed(1) ?? "—"} · created{" "}
          {formatInstant(candidate.createdAt)} · updated{" "}
          {formatInstant(candidate.updatedAt)}
        </p>
      </header>

      <div className="admin-panel">
        <header className="admin-panel__header">
          <h2>Novelty verdict</h2>
        </header>
        <div className="admin-stack">
          <p>
            Verdict: <NoveltyBadge novelty={candidate.noveltyStatus} />
          </p>
          <p className="asi-page-description">
            Considered {noveltySnapshots.length} known-universe snapshot
            {noveltySnapshots.length === 1 ? "" : "s"}
            {noveltySnapshots.length === 0
              ? ": none recorded at scoring time."
              : ":"}
          </p>
          {noveltySnapshots.map((snapshotId) => (
            <Link key={snapshotId} href={`/known-universe/${snapshotId}`}>
              Snapshot {snapshotId.slice(0, 8)}…
            </Link>
          ))}
        </div>
      </div>

      <div className="admin-panel">
        <header className="admin-panel__header">
          <h2>Why this candidate</h2>
        </header>
        <ListSection
          title="Why interesting"
          items={candidate.rationale.whyInteresting}
          emptyText="Nothing recorded as interesting yet."
        />
        <ListSection
          title="Risks"
          items={candidate.rationale.risks}
          emptyText="No risks recorded."
        />
        <ListSection
          title="Unknowns"
          items={candidate.rationale.unknowns}
          emptyText="No explicit unknowns recorded."
        />
      </div>

      <div className="admin-panel">
        <header className="admin-panel__header">
          <h2>Status control</h2>
          <p className="asi-page-description">
            Manual transitions only; research-lifecycle statuses are
            engine-routed.
          </p>
        </header>
        <RowStatusMenu
          candidate={candidate}
          onUpdated={() => setReloadKey((key) => key + 1)}
        />
      </div>

      <Tabs aria-label="Candidate detail sections">
        {TAB_ITEMS.map(([key, label]) => (
          <Tab
            key={key}
            active={activeTab === key}
            onClick={() => setActiveTab(key)}
          >
            {label}
          </Tab>
        ))}
      </Tabs>
      <TabPanel active={activeTab === "history"}>
        <ScoreHistoryTimeline detail={detail} />
      </TabPanel>
      <TabPanel active={activeTab === "features"}>
        <FeatureSnapshotViewer detail={detail} />
      </TabPanel>
      <TabPanel active={activeTab === "feedback"}>
        <FeedbackHistory candidateId={candidateId} reloadKey={reloadKey} />
      </TabPanel>
      <TabPanel active={activeTab === "questions"}>
        <ResearchQuestionsPanel candidateId={candidateId} />
      </TabPanel>
      <TabPanel active={activeTab === "evidence"}>
        <EvidenceSection company={company} />
      </TabPanel>
      <TabPanel active={activeTab === "synthesis"}>
        <SynthesisPanel companyId={candidate.companyId} />
      </TabPanel>
    </section>
  );
}
