/** Build a contains-pattern for `ILIKE` without treating `%`/`_` as wildcards. */
export function searchContains(
  query: string | null | undefined,
): string | undefined {
  if (query === undefined || query === null) return undefined;
  const cleaned = query
    .trim()
    .replace(/[%_\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return undefined;
  return `%${cleaned}%`;
}

/** Lowercase HTTP(S) URL without a trailing slash, for source matching. */
export function normalizeComparableHttpUrl(url: string): string {
  return url.trim().toLowerCase().replace(/\/+$/, "");
}
