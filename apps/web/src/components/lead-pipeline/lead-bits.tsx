"use client";

import { Badge } from "@asi/ui";
import Link from "next/link";
import { leadDomainVerification, type LeadRow } from "@/lib/leads-api";

// ---------------------------------------------------------------------------
// Display helpers for the discovery inbox (lead pipeline §2).
// ---------------------------------------------------------------------------

/** Federal award total → compact "$x.xM" / "$x.xK"; null renders honestly. */
export function formatFederalUsd(value: number | null): string {
  if (value === null) return "—";
  if (Math.abs(value) >= 1_000_000)
    return `$${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

/**
 * Pipeline status chip:
 * ⚪ new/unresolved/resolving — awaiting identity work
 * ⚡ domain-verified — resolved domain, no company link yet
 * ✓ resolved — linked to the canonical company profile
 */
export function LeadStatusChip({ row }: { row: LeadRow }) {
  if (row.status === "discarded") {
    return <Badge tone="neutral">Discarded</Badge>;
  }
  if (row.status === "resolved") {
    if (row.resolvedCompanyId !== null) {
      return (
        <Link
          href={`/companies/${row.resolvedCompanyId}`}
          onClick={(event) => event.stopPropagation()}
          title="Open resolved company profile"
        >
          <Badge tone="success">✓ Resolved</Badge>
        </Link>
      );
    }
    if (leadDomainVerification(row.context) !== null || row.possibleDomain !== null) {
      return (
        <Badge tone="info" title={row.possibleDomain ?? undefined}>
          ⚡ Verified
        </Badge>
      );
    }
    return <Badge tone="success">Resolved</Badge>;
  }
  if (row.status === "resolving") {
    return <Badge tone="warning">⚪ Resolving</Badge>;
  }
  return <Badge tone="neutral">⚪ New</Badge>;
}
