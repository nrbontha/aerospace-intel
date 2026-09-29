"use client";

import type {
  InvestorPickDto,
  InvestorPicksPageDto,
  InvestorReferenceSetDto,
} from "@asi/contracts";
import { Badge, Button, EmptyState } from "@asi/ui";
import Link from "next/link";
import { useEffect, useState } from "react";

import { apiJson } from "@/components/csrf-client";

const COMPACT_PICK_COUNT = 6;

type InvestorPicksProps = Readonly<{
  refreshToken: number;
}>;

function setSummary(
  referenceSets: readonly InvestorReferenceSetDto[],
  key: "golden" | "booie",
): string {
  const set = referenceSets.find((entry) => entry.key === key);
  const fallback = key === "golden" ? "18-company" : "29-member";
  const label = key === "golden" ? "Golden" : "Booie";

  if (!set) return `${label} ${fallback} reference set status is unavailable.`;
  if (!set.available) return `${set.label} reference snapshot is unavailable.`;

  return `${set.label}: ${set.memberCount}-member stored reference set; ${set.importedMemberCount} member ${set.importedMemberCount === 1 ? "row is" : "rows are"} represented in the shortlist.`;
}

function readinessTone(
  readiness: InvestorPickDto["readiness"],
): "success" | "warning" | "danger" | "neutral" {
  if (readiness === "ready") return "success";
  if (readiness === "blocked") return "danger";
  if (readiness === "unknown") return "neutral";
  return "warning";
}

function readinessDescription(pick: InvestorPickDto): string {
  if (pick.readiness === "blocked") {
    return "Blocked: this pick remains visible, but current research does not support readiness.";
  }
  if (pick.readiness === "needs_research") {
    return "Needs research before readiness can be assessed.";
  }
  if (pick.readiness === "unknown") {
    return "Unknown: no current research readiness is available.";
  }
  return "Current research reports readiness; it is not an investment approval.";
}

function provenanceTone(
  kind: InvestorPickDto["origins"][number]["kind"],
): "info" | "warning" | "neutral" {
  if (kind === "golden") return "info";
  if (kind === "booie") return "warning";
  return "neutral";
}

function sourceIdentity(pick: InvestorPickDto): string {
  if (pick.identityVerified) {
    return pick.verifiedDomain
      ? `Verified identity · ${pick.verifiedDomain}`
      : "Verified identity · domain not recorded";
  }
  return pick.domain
    ? `Candidate identity · ${pick.domain}`
    : "Candidate identity · domain not recorded";
}

function InvestorPickCard({ pick }: Readonly<{ pick: InvestorPickDto }>) {
  return (
    <article className="investor-pick-card">
      <div className="investor-pick-card__header">
        <div>
          <h3>
            <Link href={`/signals/${pick.sourceSignalId}`}>{pick.name}</Link>
          </h3>
          <p className="investor-pick-card__identity">{sourceIdentity(pick)}</p>
        </div>
        <strong className="investor-pick-card__score">
          {pick.researchScore === null
            ? "Score unknown / unscored"
            : `Research score ${pick.researchScore}`}
        </strong>
      </div>

      <div className="investor-pick-card__badges" aria-label="Pick provenance">
        {pick.origins.map((origin, index) => (
          <Badge
            key={`${origin.kind}:${origin.memberId ?? index}`}
            tone={provenanceTone(origin.kind)}
          >
            {origin.kind === "golden"
              ? "Golden"
              : origin.kind === "booie"
                ? "Booie"
                : "Manual"}
          </Badge>
        ))}
      </div>
      <p className="investor-pick-card__provenance">
        {pick.origins.length > 0
          ? pick.origins
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
              .join("; ")
          : "No provenance label recorded."}
      </p>

      <div className="investor-pick-card__research">
        <Badge tone={readinessTone(pick.readiness)}>
          {pick.readiness.replaceAll("_", " ")}
        </Badge>
        <span>{readinessDescription(pick)}</span>
        <span>
          <strong>Jev:</strong> {pick.jevCurrent ? "current" : "not current"}
        </span>
        <span>
          <strong>Muse:</strong> {pick.museStatus ?? "no recorded current status"}
        </span>
      </div>

      {pick.note ? <p className="investor-pick-card__note">{pick.note}</p> : null}
    </article>
  );
}

export function InvestorPicks({ refreshToken }: InvestorPicksProps) {
  const [page, setPage] = useState<InvestorPicksPageDto>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [retryVersion, setRetryVersion] = useState(0);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);

    void apiJson<InvestorPicksPageDto>("/api/v1/investor-picks", {
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        setPage(result);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          caught instanceof Error
            ? caught.message
            : "Unable to load investor picks.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [refreshToken, retryVersion]);

  const picks = page?.items ?? [];
  const visiblePicks = showAll ? picks : picks.slice(0, COMPACT_PICK_COUNT);
  const hiddenCount = Math.max(0, picks.length - COMPACT_PICK_COUNT);

  return (
    <section
      className="investor-picks admin-panel"
      aria-labelledby="investor-picks-heading"
    >
      <div className="investor-picks__header">
        <div>
          <p className="asi-page-kicker">Admin-managed shortlist</p>
          <h2 id="investor-picks-heading">Investor picks</h2>
          <p>
            Golden is the authoritative 18-company reference set; Booie is the
            separate 29-member feedback set. Provenance records preference and
            source context, not investment approval or a score change.
          </p>
        </div>
        {page?.canManage ? (
          <Link className="investor-picks__manage-link" href="/admin/investor-picks">
            Manage investor picks
          </Link>
        ) : null}
      </div>

      {page ? (
        <div className="investor-picks__set-status" aria-label="Reference set status">
          <span>{setSummary(page.referenceSets, "golden")}</span>
          <span>{setSummary(page.referenceSets, "booie")}</span>
        </div>
      ) : null}

      {loading && !page ? <p role="status">Loading investor picks…</p> : null}
      {!loading && !page && error ? (
        <EmptyState
          title="Investor picks unavailable"
          description={<p>{error}</p>}
          action={
            <Button onClick={() => setRetryVersion((version) => version + 1)}>
              Try again
            </Button>
          }
        />
      ) : null}
      {page && picks.length === 0 ? (
        <EmptyState
          title="No active investor picks"
          description={
            <p>
              The shortlist is empty. The research queue below is unchanged and
              remains available for evidence-based review.
            </p>
          }
        />
      ) : null}
      {page && picks.length > 0 ? (
        <>
          <div className="investor-picks__grid" id="investor-picks-list">
            {visiblePicks.map((pick) => (
              <InvestorPickCard key={pick.id} pick={pick} />
            ))}
          </div>
          {hiddenCount > 0 || showAll ? (
            <div className="investor-picks__actions">
              <Button
                aria-controls="investor-picks-list"
                aria-expanded={showAll}
                onClick={() => setShowAll((value) => !value)}
                size="small"
                variant="secondary"
              >
                {showAll ? "Show fewer picks" : `Show all ${picks.length} picks`}
              </Button>
              {!showAll ? <span>{hiddenCount} more picks remain available.</span> : null}
            </div>
          ) : null}
        </>
      ) : null}
      {page && error ? (
        <div className="investor-picks__error" role="alert">
          <span>{error} Existing picks remain visible.</span>
          <Button
            onClick={() => setRetryVersion((version) => version + 1)}
            size="small"
            variant="secondary"
          >
            Retry refresh
          </Button>
        </div>
      ) : null}
    </section>
  );
}
