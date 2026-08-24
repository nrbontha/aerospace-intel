"use client";

import { Button } from "@asi/ui";
import Link from "next/link";

import {
  leadAwardContext,
  leadDiscardRecord,
  leadDomainVerification,
  type LeadRow,
  type ResolveDomainResult,
} from "@/lib/leads-api";
import { formatFederalUsd, LeadStatusChip } from "@/components/lead-pipeline/lead-bits";
import { LeadRowActions } from "@/components/lead-pipeline/lead-row-actions";
import {
  formatRelativeTime,
  formatTimestamp,
} from "@/components/research-control/format";

/**
 * Everything known about one discovered lead: award context, identifiers,
 * location, the verification-attempts journal, and (for analysts) the same
 * resolve/discard actions as the row menu.
 */
export function LeadDrawer({
  lead,
  canOperate,
  busy,
  onClose,
  onResolved,
  onDiscarded,
  onFailed,
}: {
  lead: LeadRow;
  canOperate: boolean;
  busy: boolean;
  onClose: () => void;
  onResolved: (leadId: string, result: ResolveDomainResult) => void;
  onDiscarded: (leadId: string) => void;
  onFailed: (leadId: string, message: string) => void;
}) {
  const awards = leadAwardContext(lead.context);
  const verification = leadDomainVerification(lead.context);
  const discarded = leadDiscardRecord(lead.context);
  const attempts = verification?.attempts ?? [];

  return (
    <div
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
      style={{
        alignItems: "stretch",
        background: "color-mix(in srgb, black 45%, transparent)",
        display: "flex",
        inset: 0,
        justifyContent: "flex-end",
        overflowY: "auto",
        padding: "var(--asi-space-12)",
        position: "fixed",
        zIndex: 60,
      }}
    >
      <aside
        aria-label={`Lead detail: ${lead.rawName}`}
        className="admin-panel"
        role="dialog"
        style={{
          background: "var(--asi-bg)",
          inlineSize: "100%",
          maxInlineSize: "40rem",
        }}
      >
        <header className="admin-panel__header">
          <h2>{lead.rawName}</h2>
          <Button size="small" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </header>

        <p className="asi-page-description">
          <LeadStatusChip row={lead} /> · discovered{" "}
          {formatTimestamp(lead.createdAt)} (
          {formatRelativeTime(lead.createdAt)})
          {lead.updatedAt === undefined
            ? null
            : ` · updated ${formatRelativeTime(lead.updatedAt)}`}
        </p>

        {lead.status === "resolved" && lead.resolvedCompanyId !== null ? (
          <p>
            <Link href={`/companies/${lead.resolvedCompanyId}`}>
              Open resolved company profile →
            </Link>
          </p>
        ) : null}
        {lead.possibleDomain !== null ? (
          <p>
            Domain:{" "}
            {verification?.url ?? `https://${lead.possibleDomain}`}{" "}
            {verification?.confidence !== undefined
              ? `(identity confidence ${verification.confidence.toFixed(2)})`
              : null}
          </p>
        ) : null}

        <h3>Award context</h3>
        {awards.awardCount === null && awards.totalAwardValueUsd === null ? (
          <p className="asi-page-description">No award context recorded.</p>
        ) : (
          <ul>
            <li>
              Federal total: {formatFederalUsd(awards.totalAwardValueUsd)}
              {awards.totalAwardValueUsd !== null
                ? ` ($${awards.totalAwardValueUsd.toLocaleString("en-US")})`
                : ""}
            </li>
            <li>
              Awards:{" "}
              {awards.awardCount === null
                ? "unknown"
                : String(awards.awardCount)}
            </li>
            <li>Freshest award date: {awards.freshestAwardDate ?? "—"}</li>
            <li style={{ wordBreak: "break-all" }}>
              Source locator: {awards.sourceLocator ?? "—"}
            </li>
          </ul>
        )}

        <h3>Identity signals</h3>
        <ul>
          <li>Location: {lead.possibleLocation ?? "—"}</li>
          <li>Guessed domain: {lead.possibleDomain ?? "—"}</li>
          <li>
            Identifiers:{" "}
            {lead.possibleIdentifiers.length === 0 ? (
              "none recorded"
            ) : (
              <pre style={{ fontSize: "0.75rem", margin: "0.25rem 0", overflowX: "auto" }}>
                {JSON.stringify(lead.possibleIdentifiers, null, 2)}
              </pre>
            )}
          </li>
        </ul>

        <h3>Verification journal</h3>
        {attempts.length === 0 ? (
          <p className="asi-page-description">
            No resolution attempts recorded yet.
          </p>
        ) : (
          <table>
            <caption className="asi-page-description">
              Homepage identity probes from resolve-domain runs
              {verification?.verifiedAt !== undefined
                ? ` — verified ${formatTimestamp(verification.verifiedAt)}`
                : ""}
            </caption>
            <thead>
              <tr>
                <th scope="col">Domain</th>
                <th scope="col">Outcome</th>
                <th scope="col">Reason</th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((attempt, index) => (
                // Journal entries are append-only and may repeat a domain.
                // eslint-disable-next-line react/no-array-index-key
                <tr key={`${attempt.domain}:${index}`}>
                  <td>{attempt.domain}</td>
                  <td>{attempt.outcome}</td>
                  <td>{attempt.reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {discarded !== null ? (
          <>
            <h3>Discard record</h3>
            <p className="asi-page-description">
              Discarded {formatTimestamp(discarded.at)} — reason:{" "}
              {discarded.reason}
            </p>
          </>
        ) : null}

        {canOperate ? (
          <div className="admin-actions">
            <LeadRowActions
              busy={busy}
              lead={lead}
              onDiscarded={onDiscarded}
              onFailed={onFailed}
              onResolved={onResolved}
            />
          </div>
        ) : (
          <p className="asi-page-description">
            Viewers cannot run pipeline actions.
          </p>
        )}
      </aside>
    </div>
  );
}
