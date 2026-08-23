/**
 * Pure helpers for known-universe snapshot imports.
 *
 * Name/domain normalization REUSES the canonical implementations from
 * provenance.ts (`normalizeDomain`, `normalizeLegalName`) so member identity
 * matches the rest of the platform. Only snapshot-specific pure logic lives
 * here; everything is side-effect free so the decisions feeding the
 * append-only `known_universe_members` table are unit-testable.
 */
import { createHash } from "node:crypto";

export {
  normalizeDomain,
  normalizeLegalName as normalizeName,
} from "../provenance.js";

/** Identity key used for within-file dedupe and cross-snapshot joins. */
export function memberIdentityKey(
  normalizedDomain: string | null,
  normalizedName: string,
): string {
  return normalizedDomain === null
    ? `n:${normalizedName}`
    : `d:${normalizedDomain}|n:${normalizedName}`;
}

/**
 * Extract a two-letter US state code from workbook HQ text such as
 * `"USA - TN"`. Returns uppercase code or `null` when nothing plausible is
 * present.
 */
export function parseUsStateCode(hq: string | null | undefined): string | null {
  if (hq === null || hq === undefined) return null;
  const codes = [...String(hq).matchAll(/(?:^|[^A-Za-z])([A-Za-z]{2})(?![A-Za-z])/g)]
    .map((match) => match[1]?.toUpperCase())
    .filter((code): code is string => code !== undefined);
  return codes.at(-1) ?? null;
}

/** SHA-256 of raw bytes, hex-encoded — the snapshot idempotency content. */
export function sha256Hex(bytes: ArrayBuffer | Uint8Array): string {
  const view =
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.slice(0));
  return createHash("sha256").update(view).digest("hex");
}
