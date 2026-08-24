"use client";

import { Button, Input } from "@asi/ui";
import { useState } from "react";

import {
  discardLead,
  resolveLeadDomain,
  type LeadRow,
  type ResolveDomainResult,
} from "@/lib/leads-api";

/**
 * Per-lead action menu: [Resolve domain now] [Discard…]. Analyst/admin only —
 * the parent renders a read-only placeholder for viewers. Discard requires an
 * audited reason (≥4 chars, enforced here and again by the API).
 */
export function LeadRowActions({
  lead,
  busy,
  onResolved,
  onDiscarded,
  onFailed,
}: {
  lead: LeadRow;
  busy: boolean;
  onResolved: (leadId: string, result: ResolveDomainResult) => void;
  onDiscarded: (leadId: string) => void;
  onFailed: (leadId: string, message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);

  const reasonValid = reason.trim().length >= 4;

  async function resolve(): Promise<void> {
    setPending(true);
    try {
      onResolved(lead.id, await resolveLeadDomain(lead.id));
      setOpen(false);
    } catch (caught) {
      onFailed(
        lead.id,
        caught instanceof Error ? caught.message : "Resolve failed.",
      );
    } finally {
      setPending(false);
    }
  }

  async function discard(): Promise<void> {
    setPending(true);
    try {
      await discardLead(lead.id, reason.trim());
      onDiscarded(lead.id);
      setOpen(false);
      setReason("");
      setDiscarding(false);
    } catch (caught) {
      onFailed(
        lead.id,
        caught instanceof Error ? caught.message : "Discard failed.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <details
      open={open}
      onClick={(event) => event.stopPropagation()}
      onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
    >
      <summary aria-label={`Actions for ${lead.rawName}`}>Actions ▾</summary>
      <div
        style={{
          minWidth: "18rem",
          padding: "0.5rem",
          border: "1px solid var(--asi-border, currentColor)",
          borderRadius: "4px",
          background: "var(--asi-surface-muted, transparent)",
        }}
      >
        {discarding ? (
          <>
            <label className="admin-field">
              <span className="admin-field__label">
                Discard reason (audited, min 4 chars)
              </span>
              <Input
                maxLength={2000}
                minLength={4}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Why this lead leaves the pipeline"
                value={reason}
              />
            </label>
            <div className="admin-actions">
              <Button
                disabled={pending || !reasonValid}
                size="small"
                variant="danger" 
                onClick={() => void discard()}
              >
                Confirm discard
              </Button>
              <Button
                disabled={pending}
                size="small"
                variant="ghost"
                onClick={() => setDiscarding(false)}
              >
                Back
              </Button>
            </div>
          </>
        ) : (
          <div className="admin-actions">
            <Button
              disabled={busy || pending}
              size="small"
              variant="secondary"
              title="Fetch the homepage and verify the company identity before attaching a domain"
              onClick={() => void resolve()}
            >
              {busy ? "Resolving…" : "Resolve domain now"}
            </Button>
            <Button
              disabled={busy || pending}
              size="small"
              variant="ghost"
              onClick={() => setDiscarding(true)}
            >
              Discard…
            </Button>
          </div>
        )}
      </div>
    </details>
  );
}
