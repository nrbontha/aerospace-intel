/**
 * Local copies of the frozen engine band ladders (packages/research
 * scoring-axial features.ts v1). Duplicated because @asi/database must not
 * depend on @asi/research; parity is asserted by unit test so a silent
 * engine bump cannot drift the storage-layer mapping.
 */
export const REVENUE_BAND_VALUES = [
  "<5m",
  "5-10m",
  "10-20m",
  "20-35m",
  "35-50m",
  "unknown",
] as const;
export const EMPLOYEES_BAND_VALUES = [
  "<20",
  "20-50",
  "50-100",
  "100-250",
  "250-500",
  "unknown",
] as const;
export const OWNERSHIP_TYPE_VALUES = [
  "independent_founder",
  "independent_family",
  "pe_owned",
  "strategic_sub",
  "public_sub",
  "unknown",
] as const;
export const BUILD_TO_PRINT_SHARE_VALUES = [
  "none",
  "minor",
  "major",
  "unknown",
] as const;
