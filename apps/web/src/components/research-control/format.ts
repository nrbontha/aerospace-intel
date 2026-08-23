// Formatting helpers for the Research control plane (REDESIGN_PLAN §3).
// All display-only; no business decisions live here.

/** $1.5 → "$1.50"; sub-cent spends keep four decimals so activity is visible. */
export function formatUsd(amount: number): string {
  if (amount > 0 && amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

/** 900 → "15m"; 7200 → "2h"; 45 → "45s". */
export function formatCadence(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** Compact relative age ("3m ago", "just now"); ISO or Date input. */
export function formatRelativeTime(value: string | Date | null): string {
  if (value === null) return "never";
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (Number.isNaN(time)) return "unknown";
  const seconds = Math.round((Date.now() - time) / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Absolute timestamp for tick journals ("2026-08-23 14:02:11"). */
export function formatTimestamp(value: string | null): string {
  if (value === null) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** First `max` characters plus an ellipsis when truncated. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * The plan journal stores the planner envelope ({ reasoning, actions, … });
 * extract a human sentence without trusting the shape.
 */
export function planReasoning(plan: Record<string, unknown> | null | undefined): string | null {
  if (
    typeof plan === "object" &&
    plan !== null &&
    "reasoning" in plan &&
    typeof plan.reasoning === "string" &&
    plan.reasoning.trim().length > 0
  ) {
    return plan.reasoning;
  }
  return null;
}

const FINDING_KEYS = ["newLeads", "newCandidates", "newObservations"] as const;

/** Findings deltas worth surfacing, as label/count pairs in stable order. */
export function findingsDeltas(
  findings: Record<string, unknown>,
): ReadonlyArray<readonly [string, number]> {
  const deltas: Array<readonly [string, number]> = [];
  for (const key of FINDING_KEYS) {
    const value = findings[key];
    if (typeof value === "number" && value > 0) deltas.push([key, value]);
  }
  // Any other numeric finding keys the executor records stay honest-visible.
  for (const [key, value] of Object.entries(findings)) {
    if ((FINDING_KEYS as readonly string[]).includes(key)) continue;
    if (typeof value === "number" && value > 0 && Number.isFinite(value)) {
      deltas.push([key, value]);
    }
  }
  return deltas;
}
