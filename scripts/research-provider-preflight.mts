import { readFile } from "node:fs/promises";

import { uuidSchema } from "@asi/contracts";
import {
  readResearchProviderBudgetScope,
  type Database,
  type ResearchProviderBudgetScopeView,
} from "@asi/database";
import { sql } from "drizzle-orm";

const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u;
const DEFAULT_FAA_MODEL_DAILY_USD = "1";
const JEV_COHORT_COVERAGE_BLOCKER =
  "FAA_JEV_SOURCE_SIGNAL_IDS excludes one or more sealed paid targets; admitted evidence cannot finish its Jev recheck";
const SUPPORTED_PROVIDERS = ["exa", "openrouter"] as const;
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];
const FUNDED_JEV_MODEL = "typesafe/jev-1.13";
const FUNDED_MUSE_MODEL = "meta/muse-spark-1.3-contributor";

type EnvSource = Readonly<Record<string, string | undefined>>;

export interface ResearchProviderPreflightInput {
  readonly database: () => Database;
  readonly scopeId: string;
  readonly provider?: SupportedProvider;
  readonly expectedDatabaseHost: string;
  readonly expectedDatabaseName: string;
  readonly env?: EnvSource;
  readonly now?: Date;
}

interface DatabaseTarget {
  readonly host: string | null;
  readonly name: string | null;
  readonly valid: boolean;
}

function normalizeHost(value: string): string {
  return value.trim().replace(/^\[|\]$/gu, "").replace(/\.$/u, "").toLowerCase();
}

function safeExpectedHost(value: string): string | null {
  const normalized = normalizeHost(value);
  return normalized !== "" && /^[a-z0-9._:-]+$/u.test(normalized)
    ? normalized
    : null;
}

function safeExpectedDatabaseName(value: string): string | null {
  const normalized = value.trim();
  return normalized !== "" && /^[A-Za-z0-9_.-]+$/u.test(normalized)
    ? normalized
    : null;
}

function configuredDatabaseTarget(databaseUrl: string | undefined): DatabaseTarget {
  if (databaseUrl === undefined || databaseUrl.trim() === "") {
    return { host: null, name: null, valid: false };
  }
  try {
    const parsed = new URL(databaseUrl);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      return { host: null, name: null, valid: false };
    }
    const name = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
    if (parsed.hostname === "" || name === "" || name.includes("/")) {
      return { host: null, name: null, valid: false };
    }
    return {
      host: normalizeHost(parsed.hostname),
      name,
      valid: true,
    };
  } catch {
    return { host: null, name: null, valid: false };
  }
}

function isPresent(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

function exaDailyBudgetState(
  raw: string | undefined,
): { configured: boolean; valid: boolean; effectiveUsd: string } {
  const value = raw?.trim();
  if (value === undefined || value === "") {
    return { configured: false, valid: true, effectiveUsd: "0" };
  }
  const valid = DECIMAL_PATTERN.test(value);
  return {
    configured: true,
    valid,
    effectiveUsd: valid ? value : "0",
  };
}

function modelDailyBudgetState(
  raw: string | undefined,
): { configured: boolean; valid: boolean; effectiveUsd: string | null } {
  if (raw === undefined || raw.trim() === "") {
    return {
      configured: false,
      valid: true,
      effectiveUsd: DEFAULT_FAA_MODEL_DAILY_USD,
    };
  }
  const parsed = Number(raw);
  const valid = Number.isFinite(parsed) && parsed > 0;
  return {
    configured: true,
    valid,
    effectiveUsd: valid ? String(parsed) : null,
  };
}

function isPositiveDecimal(value: string): boolean {
  return DECIMAL_PATTERN.test(value) && /[1-9]/u.test(value);
}

export interface ConfiguredJevCohort {
  readonly configured: boolean;
  readonly valid: boolean;
  readonly sourceSignalIds: readonly string[];
}

export function configuredJevCohort(
  raw: string | undefined,
): ConfiguredJevCohort {
  if (raw === undefined) {
    return { configured: false, valid: true, sourceSignalIds: [] };
  }
  if (raw.trim() === "") {
    return { configured: true, valid: true, sourceSignalIds: [] };
  }
  const values = raw.split(",").map((value) => value.trim());
  const parsed = values.map((value) => uuidSchema.safeParse(value));
  if (parsed.some((value) => !value.success)) {
    return { configured: true, valid: false, sourceSignalIds: [] };
  }
  const sourceSignalIds = parsed.map((value) =>
    value.success ? value.data : "",
  );
  return {
    configured: true,
    valid: new Set(sourceSignalIds).size === sourceSignalIds.length,
    sourceSignalIds,
  };
}

function canonicalizeUuidCoverage(
  sourceSignalIds: readonly string[],
): ReadonlySet<string> {
  return new Set(
    sourceSignalIds.map((sourceSignalId) => sourceSignalId.toLowerCase()),
  );
}

export function cohortCoversPaidTargets(
  cohort: ConfiguredJevCohort,
  paidSourceSignalIds: readonly string[],
): boolean {
  if (!cohort.valid) return false;
  if (!cohort.configured) return true;
  const screened = canonicalizeUuidCoverage(cohort.sourceSignalIds);
  return paidSourceSignalIds.every((sourceSignalId) =>
    screened.has(sourceSignalId.toLowerCase()),
  );
}


function scopeReport(view: ResearchProviderBudgetScopeView) {
  return {
    id: view.scope.id,
    provider: view.scope.provider,
    startsAt: view.scope.startsAt,
    sealed: view.scope.sealedAt !== null,
    sealedAt: view.scope.sealedAt,
    membership: {
      count: view.allowlistedSourceSignalIds.length,
      sourceSignalIds: view.allowlistedSourceSignalIds,
    },
    totalCapUsd: view.scope.totalCapUsd,
    knownActualCostUsd: view.knownActualCostUsd,
    reservedOrUnknownEstimatedCostUsd: view.unknownEstimatedCostUsd,
    committedCostUsd: view.committedCostUsd,
    remainingBeforeFloorUsd: view.remainingBeforeFloorUsd,
    remainingCostUsd: view.remainingCostUsd,
    permit: view.scope.permitStatus,
    operationalStatus: view.status,
    providerCooldown: view.providerCooldown,
  };
}

export async function readSourceSignalIdFile(filePath: string): Promise<string[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw new Error(
      "--source-signal-ids-file must name a readable JSON UUID-array file",
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("source signal ID file must contain a non-empty JSON array");
  }
  const validated = parsed.map((value) => {
    if (typeof value !== "string") {
      throw new Error("source signal ID file entries must be UUID strings");
    }
    return uuidSchema.parse(value.trim()).toLowerCase();
  });
  return [...new Set(validated)];
}

export async function resolveSourceSignalIds(
  repeatedSourceSignalIds: readonly string[] | undefined,
  sourceSignalIdsFile: string | undefined,
): Promise<string[]> {
  if (
    repeatedSourceSignalIds !== undefined &&
    sourceSignalIdsFile !== undefined
  ) {
    throw new Error(
      "--source-signal-id and --source-signal-ids-file are mutually exclusive",
    );
  }
  if (
    (repeatedSourceSignalIds === undefined ||
      repeatedSourceSignalIds.length === 0) &&
    sourceSignalIdsFile === undefined
  ) {
    throw new Error(
      "one or more --source-signal-id values or --source-signal-ids-file is required",
    );
  }
  if (sourceSignalIdsFile !== undefined) {
    if (sourceSignalIdsFile.trim() === "") {
      throw new Error("--source-signal-ids-file is required");
    }
    return readSourceSignalIdFile(sourceSignalIdsFile.trim());
  }
  return repeatedSourceSignalIds!.map((value) =>
    uuidSchema.parse(value.trim()),
  );
}

export async function runResearchProviderPreflight(
  input: ResearchProviderPreflightInput,
) {
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  const blockers: string[] = [];
  const warnings: string[] = [];
  const provider = input.provider ?? "exa";
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    blockers.push("--provider must be exa or openrouter");
  }
  const scopeEnv =
    provider === "openrouter"
      ? "OPENROUTER_BUDGET_SCOPE_ID"
      : "EXA_BUDGET_SCOPE_ID";
  const expectedHost = safeExpectedHost(input.expectedDatabaseHost);
  const expectedName = safeExpectedDatabaseName(input.expectedDatabaseName);
  const target = configuredDatabaseTarget(env.DATABASE_URL);

  if (expectedHost === null) {
    blockers.push("expected database host must be a hostname or IP address");
  }
  if (expectedName === null) {
    blockers.push("expected database name contains unsupported characters");
  }
  if (!target.valid) {
    blockers.push("DATABASE_URL is missing or is not a valid PostgreSQL target");
  } else {
    if (expectedHost !== null && target.host !== expectedHost) {
      blockers.push("configured database host does not match --expected-database-host");
    }
    if (expectedName !== null && target.name !== expectedName) {
      blockers.push("configured database name does not match --expected-database-name");
    }
  }

  const rawAnalystMode = env.FAA_ANALYST_MODE?.trim() || "disabled";
  const analystMode =
    rawAnalystMode === "disabled" ||
    rawAnalystMode === "free_only" ||
    rawAnalystMode === "bounded_paid"
      ? rawAnalystMode
      : "INVALID";
  const configuredScopeId = env[scopeEnv]?.trim() || null;
  const cohort = configuredJevCohort(env.FAA_JEV_SOURCE_SIGNAL_IDS);
  const exaDaily = exaDailyBudgetState(env.EXA_DAILY_BUDGET_USD);
  const openRouterDaily = modelDailyBudgetState(
    env.OPENROUTER_MAX_COST_PER_DAY_USD,
  );
  const keyPresence = {
    EXA_API_KEY: isPresent(env.EXA_API_KEY) ? "PRESENT" : "MISSING",
    OPENROUTER_API_KEY: isPresent(env.OPENROUTER_API_KEY)
      ? "PRESENT"
      : "MISSING",
  } as const;
  const modelPolicy = {
    jev: env.FAA_JEV_MODEL?.trim() || FUNDED_JEV_MODEL,
    muse: env.FAA_MODEL_A?.trim() || FUNDED_MUSE_MODEL,
    requiredJev: FUNDED_JEV_MODEL,
    requiredMuse: FUNDED_MUSE_MODEL,
  } as const;

  if (analystMode !== "bounded_paid") {
    blockers.push("FAA_ANALYST_MODE must be bounded_paid for a funded provider run");
  }
  if (configuredScopeId === null) {
    blockers.push(`${scopeEnv} is not configured`);
  } else if (configuredScopeId !== input.scopeId) {
    blockers.push(`${scopeEnv} does not match the requested scope`);
  }
  if (!cohort.valid) {
    blockers.push(
      "FAA_JEV_SOURCE_SIGNAL_IDS is not accepted by the runtime UUID-list parser",
    );
  }
  if (
    cohort.configured &&
    cohort.valid &&
    cohort.sourceSignalIds.length === 0
  ) {
    blockers.push(JEV_COHORT_COVERAGE_BLOCKER);
  }
  if (keyPresence.EXA_API_KEY === "MISSING") {
    blockers.push("EXA_API_KEY is missing");
  }
  if (keyPresence.OPENROUTER_API_KEY === "MISSING") {
    blockers.push("OPENROUTER_API_KEY is missing");
  }
  if (modelPolicy.jev !== FUNDED_JEV_MODEL) {
    blockers.push(`FAA_JEV_MODEL must be ${FUNDED_JEV_MODEL}`);
  }
  if (modelPolicy.muse !== FUNDED_MUSE_MODEL) {
    blockers.push(`FAA_MODEL_A must be ${FUNDED_MUSE_MODEL}`);
  }
  if (
    provider === "exa" &&
    (!exaDaily.configured ||
      !exaDaily.valid ||
      !isPositiveDecimal(exaDaily.effectiveUsd))
  ) {
    blockers.push(
      "EXA_DAILY_BUDGET_USD must be explicitly set to a positive decimal",
    );
  }
  if (
    provider === "openrouter" &&
    (!openRouterDaily.configured ||
      !openRouterDaily.valid ||
      openRouterDaily.effectiveUsd === null ||
      !isPositiveDecimal(openRouterDaily.effectiveUsd))
  ) {
    blockers.push(
      "OPENROUTER_MAX_COST_PER_DAY_USD must be explicitly set to a positive finite number",
    );
  }

  let connectedName: string | null = null;
  let scopeReadCompleted = false;
  let view: ResearchProviderBudgetScopeView | null = null;
  const targetMatches =
    target.valid &&
    expectedHost !== null &&
    expectedName !== null &&
    target.host === expectedHost &&
    target.name === expectedName;
  if (targetMatches) {
    try {
      const db = input.database();
      const identity = await db.execute<{ database_name: string }>(sql`
        SELECT current_database()::text AS database_name
      `);
      connectedName = identity.rows[0]?.database_name ?? null;
      if (connectedName !== expectedName) {
        blockers.push(
          "connected database name does not match --expected-database-name",
        );
      } else {
        view = await readResearchProviderBudgetScope(db, input.scopeId, now);
        scopeReadCompleted = true;
      }
    } catch {
      blockers.push(
        "database identity/scope read failed; verify connectivity, migration state, and credentials",
      );
    }
  }

  if (targetMatches && connectedName === expectedName && scopeReadCompleted) {
    if (view === null) {
      blockers.push("requested provider budget scope does not exist");
    } else {
      if (view.scope.provider !== provider) {
        blockers.push(`scope provider must be ${provider}`);
      }
      if (view.scope.sealedAt === null) {
        blockers.push("scope membership is not sealed");
      }
      if (view.allowlistedSourceSignalIds.length === 0) {
        blockers.push("scope has no sealed source-signal membership");
      }
      if (view.scope.permitStatus === "closed" || view.status === "closed") {
        blockers.push("scope is closed and cannot be reopened");
      }
      if (
        view.status === "exhausted" ||
        !isPositiveDecimal(view.remainingCostUsd)
      ) {
        blockers.push("scope has no remaining provider exposure");
      }
      if (view.scope.permitStatus === "active") {
        blockers.push("scope is already active; pause it before staged preflight");
      }
      if (
        !cohortCoversPaidTargets(cohort, view.allowlistedSourceSignalIds)
      ) {
        blockers.push(JEV_COHORT_COVERAGE_BLOCKER);
      }
      if (view.scope.startsAt > now) {
        warnings.push("scope start time is in the future");
      }
      if (view.providerCooldown !== null) {
        warnings.push("provider cooldown is currently recorded; paid work will defer");
      }
    }
  }

  const uniqueBlockers = [...new Set(blockers)];

  return {
    command: "preflight",
    readOnly: true,
    providerCalls: "NONE",
    checkedAt: now,
    database: {
      expectedHost,
      expectedName,
      configuredHost: target.host,
      configuredName: target.name,
      connectedName,
      matched: targetMatches && connectedName === expectedName,
    },
    scope: view === null ? null : scopeReport(view),
    requiredKeyPresence: keyPresence,
    runtime: {
      analystMode,
      scope: {
        provider,
        environmentVariable: scopeEnv,
        configured: configuredScopeId !== null,
        matchesRequestedScope: configuredScopeId === input.scopeId,
      },
      cohort: {
        mode: cohort.configured ? "allowlist" : "full",
        configured: cohort.configured,
        valid: cohort.valid,
        count: cohort.sourceSignalIds.length,
        coversSealedMembership:
          view !== null &&
          cohortCoversPaidTargets(cohort, view.allowlistedSourceSignalIds),
      },
      modelPolicy,
      providerControls:
        provider === "exa"
          ? {
              operation: "auto_search_and_text_contents",
              maxSearchResults: 5,
              maxContentsUrls: 3,
              textOnly: true,
            }
          : {
              jev: {
                model: FUNDED_JEV_MODEL,
                maxRetries: 0,
                structuredMaxAttempts: 1,
                reservePerAttemptUsd: "0.0014",
                maxPrice: { prompt: "0.042", completion: "0", request: "0" },
              },
              muse: {
                model: FUNDED_MUSE_MODEL,
                maxRetries: 0,
                structuredMaxAttempts: 1,
                reservePerAttemptUsd: "0.106",
                maxPrice: { prompt: "0.10", completion: "0.20", request: "0" },
              },
              scopedGuardRequiredOnWebAndWorker: true,
            },
      dailyGuards: {
        exaProviderExposure: exaDaily,
        openRouterObservedLegacySpend: {
          ...openRouterDaily,
          enforcement:
            "OBSERVED LEGACY SPEND THRESHOLD; scoped reservations are reported separately",
        },
        openRouterScopedReservation: {
          ...openRouterDaily,
          enforcement:
            "ATOMIC UTC-DAY ADMISSION CAP FOR OPENROUTER_BUDGET_SCOPE_ID REQUESTS ONLY",
        },
      },
      storage:
        env.RESEARCH_SHARED_STORAGE?.trim().toLowerCase() === "true"
          ? "shared_document_storage"
          : "database_raw_source_pipeline_supported",
    },
    providerFunding: {
      status: "NOT VERIFIED",
      reason: "No paid or network provider call was made",
      requiredBeforeActivation:
        "Confirm Exa and OpenRouter account funding and limits with their account owners; do not substitute one provider key for another",
    },
    localChecks: uniqueBlockers.length === 0 ? "PASS" : "BLOCKED",
    blockers: uniqueBlockers,
    warnings,
  };
}
