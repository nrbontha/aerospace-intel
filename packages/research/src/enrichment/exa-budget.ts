import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Shared Exa spend gate (Agent OwnNewsCheck owns this module; website
 * enrichment imports the budget check from here — never a second counter).
 *
 * Day-bucketed cumulative USD counter for Exa search/contents calls, behind
 * EXA_DAILY_BUDGET_USD (default 2.00). Persisted to a small JSON file so
 * spend survives worker restarts; the path is overridable via
 * EXA_SPEND_STATE_PATH (tests). All file I/O is best-effort and never
 * throws — worst case the in-memory bucket still caps the current tick.
 *
 * Cost basis: Exa search ~$0.005/call, contents ~$0.005–0.01/call. Actuals
 * are recorded when the API reports usage; otherwise callers record these
 * conservative estimates (see comments at the call sites).
 */

export const EXA_DAILY_BUDGET_ENV = "EXA_DAILY_BUDGET_USD";
export const EXA_SPEND_STATE_PATH_ENV = "EXA_SPEND_STATE_PATH";
export const DEFAULT_EXA_DAILY_BUDGET_USD = 2.0;

/** Conservative per-call estimate when the API reports no usage actual. */
export const EXA_SEARCH_COST_USD = 0.005;
/** Conservative per-call estimate when the API reports no usage actual. */
export const EXA_CONTENTS_COST_USD = 0.01;

function spendStatePath(): string {
  const raw = process.env[EXA_SPEND_STATE_PATH_ENV];
  if (raw !== undefined && raw.trim().length > 0) return raw.trim();
  return join(tmpdir(), "asi-exa-spend.json");
}

export function exaDailyBudgetCapUsd(): number {
  const raw = process.env[EXA_DAILY_BUDGET_ENV];
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_EXA_DAILY_BUDGET_USD;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_EXA_DAILY_BUDGET_USD;
}

/** UTC calendar day key: "YYYY-MM-DD". */
export function exaDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

type SpendLedger = Record<string, number>;

let ledgerCache: SpendLedger | null = null;

function loadLedger(): SpendLedger {
  if (ledgerCache !== null) return ledgerCache;
  let ledger: SpendLedger = {};
  try {
    const raw = readFileSync(spendStatePath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [day, total] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof total === "number" && Number.isFinite(total) && total >= 0) {
          ledger[day] = total;
        }
      }
    }
  } catch {
    ledger = {};
  }
  ledgerCache = ledger;
  return ledger;
}

function flushLedger(): void {
  if (ledgerCache === null) return;
  try {
    const path = spendStatePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(ledgerCache), "utf8");
  } catch {
    // Best-effort persistence; the in-memory bucket still caps this process.
  }
}

/** Cumulative Exa spend recorded for the UTC day. Never throws. */
export function getExaDailySpendUsd(now: Date = new Date()): number {
  try {
    return loadLedger()[exaDayKey(now)] ?? 0;
  } catch {
    return 0;
  }
}

/** True when spending `costUsd` more keeps the day under the cap. */
export function canSpendExa(costUsd: number, now: Date = new Date()): boolean {
  if (!Number.isFinite(costUsd) || costUsd < 0) return false;
  return getExaDailySpendUsd(now) + costUsd <= exaDailyBudgetCapUsd();
}

/**
 * Add `costUsd` to today's bucket and persist. Returns the new day total.
 * Never throws (persistence is best-effort).
 */
export function recordExaSpendUsd(costUsd: number, now: Date = new Date()): number {
  if (!Number.isFinite(costUsd) || costUsd < 0) {
    return getExaDailySpendUsd(now);
  }
  const ledger = loadLedger();
  const day = exaDayKey(now);
  const total = (ledger[day] ?? 0) + costUsd;
  ledger[day] = total;
  flushLedger();
  return total;
}
