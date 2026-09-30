import { Buffer } from "node:buffer";

import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "./client.js";
import {
  evidence,
  faaEnsembleEvaluations,
  faaEnsembleResults,
  faaReviewModelUsage,
  researchProviderUsage,
  signalAnalystCases,
  signalAnalystSteps,
  sourceDocuments,
  sourceSignalEvidenceLinks,
  sourceSignals,
} from "./schema.js";

const CURSOR_VERSION = 1;
const DEFAULT_LIMIT = 50;
export const SIGNAL_TIMELINE_LIMIT_MAX = 100;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SENSITIVE_DETAIL_KEY =
  /(?:api[_-]?key|authorization|secret|password|cookie|credential)/iu;
const PROMPT_DETAIL_KEY = /prompt(?:$|[_-])/iu;

export type SignalTimelineSourceRole =
  "support" | "discovery_only" | "checked_failure";

export interface SignalTimelineSource {
  readonly url: string;
  readonly title?: string;
  readonly quote?: string;
  /** How the retained event may use this locator; discovery is not evidence. */
  readonly role?: SignalTimelineSourceRole;
  /** Retained source representation, such as publisher text or an Exa snippet. */
  readonly representation?: string;
}

export interface SignalTimelineEvent {
  readonly id: string;
  readonly occurredAt: string;
  readonly endedAt: string | null;
  readonly actor: "Source" | "Jev" | "Muse" | "System";
  readonly kind: string;
  readonly title: string;
  readonly status: string | null;
  readonly summary: string | null;
  readonly modelId: string | null;
  readonly promptVersion: string | null;
  readonly inputHash: string | null;
  readonly caseId: string | null;
  readonly costUsd: string | null;
  readonly costKnown: boolean | null;
  readonly sources: readonly SignalTimelineSource[];
  readonly details: Record<string, unknown>;
}

export interface SignalTimelineCursor {
  readonly version: typeof CURSOR_VERSION;
  readonly sourceSignalId: string;
  readonly occurredAt: string;
  readonly eventId: string;
}

export interface ReadSourceSignalTimelineOptions {
  readonly limit?: number;
  readonly after?: string;
}

export interface SignalTimelinePage {
  readonly items: readonly SignalTimelineEvent[];
  readonly nextCursor: string | null;
}

type TimelineKind =
  | "source_observation"
  | "source_evidence"
  | "faa_evaluation"
  | "faa_result"
  | "model_receipt"
  | "muse_episode"
  | "muse_step"
  | "provider_usage";

type TimelineKey = {
  kind: TimelineKind;
  id: string;
  cursorAt: string;
};

function timestamp(value: Date): string {
  return value.toISOString();
}

function optionalTimestamp(value: Date | null): string | null {
  return value === null ? null : timestamp(value);
}

function requireLimit(limit: number | undefined): number {
  const value = limit ?? DEFAULT_LIMIT;
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > SIGNAL_TIMELINE_LIMIT_MAX
  ) {
    throw new TypeError(
      `timeline limit must be an integer from 1 to ${SIGNAL_TIMELINE_LIMIT_MAX}`,
    );
  }
  return value;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(value)
  ) {
    return false;
  }
  const parsed = new Date(value);
  return (
    !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === value.slice(0, 10)
  );
}

/** Parse a versioned, source-bound opaque timeline cursor. */
export function parseSignalTimelineCursor(
  value: unknown,
): SignalTimelineCursor | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024)
    return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return null;
    const record = parsed as Record<string, unknown>;
    if (
      record["v"] !== CURSOR_VERSION ||
      typeof record["s"] !== "string" ||
      !UUID_PATTERN.test(record["s"]) ||
      !isCanonicalTimestamp(record["t"]) ||
      typeof record["i"] !== "string" ||
      record["i"].length === 0 ||
      record["i"].length > 256
    ) {
      return null;
    }
    const cursor: SignalTimelineCursor = {
      version: CURSOR_VERSION,
      sourceSignalId: record["s"],
      occurredAt: record["t"],
      eventId: record["i"],
    };
    return encodeSignalTimelineCursor(cursor) === value ? cursor : null;
  } catch {
    return null;
  }
}

export function encodeSignalTimelineCursor(
  cursor: SignalTimelineCursor,
): string {
  return Buffer.from(
    JSON.stringify({
      v: cursor.version,
      s: cursor.sourceSignalId,
      t: cursor.occurredAt,
      i: cursor.eventId,
    }),
    "utf8",
  ).toString("base64url");
}

const SENSITIVE_QUERY_PARAMETER =
  /(?:^|[_-])(?:access[_-]?token|api[_-]?key|auth(?:orization)?|credential|password|secret|signature|sig|token)(?:$|[_-])/iu;
const KNOWN_LOCATION_DETAIL_KEY =
  /^(?:canonical(?:_|)?url|final(?:_|)?url|locator|source(?:_|)?(?:locator|url)|url|urls)$/iu;
const REDACTED_CREDENTIAL_URL = "[redacted: credential-bearing URL]";

function hasCredentialMaterial(url: URL): boolean {
  return (
    url.username !== "" ||
    url.password !== "" ||
    [...url.searchParams.keys()].some((name) =>
      SENSITIVE_QUERY_PARAMETER.test(name),
    )
  );
}

function redactKnownLocation(value: unknown): {
  value: unknown;
  redacted: boolean;
} {
  if (Array.isArray(value)) {
    const locations = value.map((item) => redactKnownLocation(item));
    return {
      value: locations.map((location) => location.value),
      redacted: locations.some((location) => location.redacted),
    };
  }
  if (typeof value !== "string") return { value, redacted: false };
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      hasCredentialMaterial(parsed)
    ) {
      return { value: REDACTED_CREDENTIAL_URL, redacted: true };
    }
  } catch {
    // Non-URL locators are retained verbatim.
  }
  return { value, redacted: false };
}

function safeSource(
  url: string | null,
  title?: string | null,
  quote?: string | null,
  metadata: Pick<SignalTimelineSource, "role" | "representation"> = {},
): SignalTimelineSource[] {
  if (url === null) return [];
  try {
    const parsed = new URL(url);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      hasCredentialMaterial(parsed)
    ) {
      return [];
    }
    return [
      {
        url: parsed.toString(),
        ...(title === null || title === undefined || title.trim() === ""
          ? {}
          : { title: title.slice(0, 300) }),
        ...(quote === null || quote === undefined || quote.trim() === ""
          ? {}
          : { quote: quote.slice(0, 1_000) }),
        ...(metadata.role === undefined ? {} : { role: metadata.role }),
        ...(metadata.representation === undefined ||
        metadata.representation.trim() === ""
          ? {}
          : { representation: metadata.representation.slice(0, 160) }),
      },
    ];
  } catch {
    return [];
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringAt(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function sourceRoleFromAnalystObservation(
  observation: Record<string, unknown>,
  reference: Record<string, unknown>,
): SignalTimelineSourceRole {
  if (
    observation["supportRole"] === "candidate_evidence" &&
    observation["failure"] === null &&
    observation["accessLimit"] === null &&
    reference["representation"] !== "checked_failure"
  ) {
    return "support";
  }
  return observation["supportRole"] === "discovery_only"
    ? "discovery_only"
    : "checked_failure";
}

function analystObservationSources(
  observation: Record<string, unknown>,
): readonly SignalTimelineSource[] {
  const references = observation["sourceReferences"];
  if (!Array.isArray(references)) return [];
  const captions = new Map<
    string,
    { title: string | null; quote: string | null }
  >();
  const rememberCaption = (
    value: unknown,
    titleKey: string,
    quoteKey: string,
  ) => {
    const record = asRecord(value);
    const url = record === null ? null : stringAt(record, "url");
    if (record === null || url === null) return;
    captions.set(url, {
      title: stringAt(record, titleKey),
      quote: stringAt(record, quoteKey),
    });
  };
  if (Array.isArray(observation["results"])) {
    for (const result of observation["results"]) {
      rememberCaption(result, "title", "textSnippet");
    }
  }
  if (Array.isArray(observation["pages"])) {
    for (const page of observation["pages"]) {
      rememberCaption(page, "title", "extractedText");
    }
  }

  const sources: SignalTimelineSource[] = [];
  for (const value of references) {
    const reference = asRecord(value);
    if (reference === null) continue;
    const locator = stringAt(reference, "locator");
    const finalUrl = stringAt(reference, "finalUrl");
    const url = finalUrl ?? locator;
    if (url === null) continue;
    const caption = captions.get(finalUrl ?? locator!);
    const representation = stringAt(reference, "representation");
    sources.push(
      ...safeSource(url, caption?.title, caption?.quote, {
        role: sourceRoleFromAnalystObservation(observation, reference),
        ...(representation === null ? {} : { representation }),
      }),
    );
  }
  return sources;
}

function jevReferenceSources(value: unknown): readonly SignalTimelineSource[] {
  const reference = asRecord(value);
  if (reference === null) return [];
  if (reference["kind"] === "source_document") {
    const url = stringAt(reference, "url");
    if (url === null) return [];
    return safeSource(
      url,
      stringAt(reference, "title"),
      stringAt(reference, "quote"),
      {
        role: reference["role"] === "support" ? "support" : "checked_failure",
        representation: stringAt(reference, "sourceKind") ?? "source_document",
      },
    );
  }
  if (reference["kind"] === "source_signal") {
    return safeSource(stringAt(reference, "sourceLocator"), null, null, {
      role: "discovery_only",
      representation: "source_signal",
    });
  }
  return [];
}

function jevParsedSources(
  parsed: Record<string, unknown>,
): readonly SignalTimelineSource[] {
  const sources: SignalTimelineSource[] = [];
  const addReferences = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const reference of value)
      sources.push(...jevReferenceSources(reference));
  };
  const observation = asRecord(parsed["observation"]);
  if (observation !== null) addReferences(observation["sourceReferences"]);
  if (Array.isArray(parsed["observations"])) {
    for (const value of parsed["observations"]) {
      const rungObservation = asRecord(value);
      if (rungObservation !== null)
        addReferences(rungObservation["sourceReferences"]);
    }
  }
  if (Array.isArray(parsed["gaps"])) {
    for (const value of parsed["gaps"]) {
      const gap = asRecord(value);
      if (gap === null) continue;
      addReferences(gap["supportingSources"]);
      addReferences(gap["conflictingSources"]);
    }
  }
  return sources;
}

function structuredSources(value: unknown): readonly SignalTimelineSource[] {
  const record = asRecord(value);
  if (record === null) return [];
  const directObservation =
    typeof record["tool"] === "string" ? record : asRecord(record["response"]);
  return directObservation !== null &&
    typeof directObservation["tool"] === "string"
    ? analystObservationSources(directObservation)
    : jevParsedSources(record);
}

function preview(
  value: unknown,
  depth = 0,
): { value: unknown; truncated: boolean; redacted: boolean } {
  if (value === null || typeof value === "boolean") {
    return { value, truncated: false, redacted: false };
  }
  if (typeof value === "number") {
    return {
      value: Number.isFinite(value) ? value : null,
      truncated: false,
      redacted: false,
    };
  }
  if (typeof value === "string") {
    return {
      value: value.slice(0, 4_000),
      truncated: value.length > 4_000,
      redacted: false,
    };
  }
  if (depth >= 4) {
    return { value: "[depth limit]", truncated: true, redacted: false };
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, 40).map((item) => preview(item, depth + 1));
    return {
      value: items.map((item) => item.value),
      truncated: value.length > 40 || items.some((item) => item.truncated),
      redacted: items.some((item) => item.redacted),
    };
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.entries(record).slice(0, 40);
    const previewed: Record<string, unknown> = {};
    let truncated = Object.keys(record).length > 40;
    let redacted = false;
    for (const [key, item] of entries) {
      if (SENSITIVE_DETAIL_KEY.test(key)) {
        previewed[key] = "[redacted]";
        redacted = true;
      } else if (PROMPT_DETAIL_KEY.test(key)) {
        previewed[key] = "[withheld: prompt content is not exposed]";
        redacted = true;
      } else if (KNOWN_LOCATION_DETAIL_KEY.test(key)) {
        const location = redactKnownLocation(item);
        const child = preview(location.value, depth + 1);
        previewed[key] = child.value;
        truncated ||= child.truncated;
        redacted ||= location.redacted || child.redacted;
      } else {
        const child = preview(item, depth + 1);
        previewed[key] = child.value;
        truncated ||= child.truncated;
        redacted ||= child.redacted;
      }
    }
    return { value: previewed, truncated, redacted };
  }
  return { value: String(value), truncated: false, redacted: false };
}

function previewDetail(value: unknown): Record<string, unknown> {
  const result = preview(value);
  return {
    value: result.value,
    truncated: result.truncated,
    redacted: result.redacted,
  };
}

function actorForEvaluation(
  evaluation: typeof faaEnsembleEvaluations.$inferSelect,
  receipt: typeof faaReviewModelUsage.$inferSelect | undefined,
): SignalTimelineEvent["actor"] {
  if (receipt?.phase === "jev") return "Jev";
  if (receipt?.phase === "muse") return "Muse";
  const policy = evaluation.inputManifest?.["policy"];
  if (typeof policy === "object" && policy !== null && !Array.isArray(policy)) {
    const record = policy as Record<string, unknown>;
    if (record["jevModel"] === evaluation.modelId) return "Jev";
    if (record["museModel"] === evaluation.modelId) return "Muse";
  }
  return evaluation.parsed?.["version"] === "jev-triage-v1" ? "Jev" : "System";
}

function keysOf(keys: readonly TimelineKey[], kind: TimelineKind): string[] {
  return keys.filter((key) => key.kind === kind).map((key) => key.id);
}

/**
 * Page only retained event keys in PostgreSQL, then hydrate the selected rows.
 * Linked receipts are folded into their evaluation/action, so one real charge
 * is never represented by duplicate timeline events.
 */
export async function readSourceSignalTimeline(
  db: Database,
  signalId: string,
  options: ReadSourceSignalTimelineOptions = {},
): Promise<SignalTimelinePage> {
  const limit = requireLimit(options.limit);
  const cursor =
    options.after === undefined
      ? null
      : parseSignalTimelineCursor(options.after);
  if (options.after !== undefined && cursor === null)
    throw new TypeError("invalid signal timeline cursor");
  if (cursor !== null && cursor.sourceSignalId !== signalId) {
    throw new TypeError(
      "signal timeline cursor belongs to another source signal",
    );
  }

  const cursorClause =
    cursor === null
      ? sql``
      : sql`WHERE (occurred_at, event_id) < (${cursor.occurredAt}::timestamptz, ${cursor.eventId})`;
  const pageRows = await db.execute<{
    kind: TimelineKind;
    id: string;
    occurred_key: string;
  }>(sql`
    WITH timeline AS (
      SELECT 'source_observation'::text AS kind, s.id::text AS id, s.created_at AS occurred_at,
        'source_observation:' || s.id::text AS event_id
      FROM source_signals s WHERE s.id = ${signalId}::uuid
      UNION ALL
      SELECT 'source_evidence', l.evidence_id::text, l.created_at,
        'source_evidence:' || l.evidence_id::text
      FROM source_signal_evidence_links l WHERE l.signal_id = ${signalId}::uuid
      UNION ALL
      SELECT 'faa_evaluation', e.id::text, e.created_at, 'faa_evaluation:' || e.id::text
      FROM faa_ensemble_evaluations e
      WHERE e.signal_id = ${signalId}::uuid
      UNION ALL
      SELECT 'faa_result', r.id::text, r.created_at, 'faa_result:' || r.id::text
      FROM faa_ensemble_results r WHERE r.signal_id = ${signalId}::uuid
      UNION ALL
      SELECT 'model_receipt', u.id::text, u.observed_at, 'model_receipt:' || u.id::text
      FROM faa_review_model_usage u
      WHERE u.source_signal_id = ${signalId}::uuid
        AND u.legacy_evaluation_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM signal_analyst_steps s WHERE s.model_usage_receipt_id = u.id
        )
      UNION ALL
      SELECT 'muse_episode', c.id::text, c.created_at, 'muse_episode:' || c.id::text
      FROM signal_analyst_cases c WHERE c.signal_id = ${signalId}::uuid
      UNION ALL
      SELECT 'muse_step', s.id::text, s.started_at, 'muse_step:' || s.id::text
      FROM signal_analyst_steps s
      JOIN signal_analyst_cases c ON c.id = s.case_id
      WHERE c.signal_id = ${signalId}::uuid
      UNION ALL
      SELECT 'provider_usage', u.id::text, u.created_at, 'provider_usage:' || u.id::text
      FROM research_provider_usage u
      WHERE u.source_signal_id = ${signalId}::uuid
        AND u.analyst_step_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM faa_review_model_usage m WHERE m.id = u.id
        )
    )
    SELECT kind, id,
      to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_key
    FROM timeline
    ${cursorClause}
    ORDER BY occurred_at DESC, event_id DESC
    LIMIT ${limit + 1}
  `);
  const keyed: TimelineKey[] = pageRows.rows.map((row) => ({
    kind: row.kind,
    id: row.id,
    cursorAt: row.occurred_key,
  }));
  const selectedKeys = keyed.slice(0, limit);
  const sourceIds = keysOf(selectedKeys, "source_observation");
  const evidenceIds = keysOf(selectedKeys, "source_evidence");
  const evaluationIds = keysOf(selectedKeys, "faa_evaluation");
  const resultIds = keysOf(selectedKeys, "faa_result");
  const receiptIds = keysOf(selectedKeys, "model_receipt");
  const caseIds = keysOf(selectedKeys, "muse_episode");
  const stepIds = keysOf(selectedKeys, "muse_step");
  const usageIds = keysOf(selectedKeys, "provider_usage");

  const [
    signals,
    evidenceRows,
    evaluations,
    results,
    receipts,
    cases,
    steps,
    standaloneUsage,
  ] = await Promise.all([
    sourceIds.length === 0
      ? Promise.resolve([])
      : db
          .select()
          .from(sourceSignals)
          .where(inArray(sourceSignals.id, sourceIds)),
    evidenceIds.length === 0
      ? Promise.resolve([])
      : db
          .select({
            link: sourceSignalEvidenceLinks,
            evidence,
            document: sourceDocuments,
          })
          .from(sourceSignalEvidenceLinks)
          .innerJoin(
            evidence,
            eq(evidence.id, sourceSignalEvidenceLinks.evidenceId),
          )
          .innerJoin(
            sourceDocuments,
            eq(sourceDocuments.id, evidence.sourceDocumentId),
          )
          .where(
            and(
              inArray(sourceSignalEvidenceLinks.evidenceId, evidenceIds),
              eq(sourceSignalEvidenceLinks.signalId, signalId),
            ),
          ),
    evaluationIds.length === 0
      ? Promise.resolve([])
      : db
          .select()
          .from(faaEnsembleEvaluations)
          .where(inArray(faaEnsembleEvaluations.id, evaluationIds)),
    resultIds.length === 0
      ? Promise.resolve([])
      : db
          .select()
          .from(faaEnsembleResults)
          .where(inArray(faaEnsembleResults.id, resultIds)),
    receiptIds.length === 0
      ? Promise.resolve([])
      : db
          .select()
          .from(faaReviewModelUsage)
          .where(inArray(faaReviewModelUsage.id, receiptIds)),
    caseIds.length === 0
      ? Promise.resolve([])
      : db
          .select()
          .from(signalAnalystCases)
          .where(inArray(signalAnalystCases.id, caseIds)),
    stepIds.length === 0
      ? Promise.resolve([])
      : db
          .select({ step: signalAnalystSteps, receipt: faaReviewModelUsage })
          .from(signalAnalystSteps)
          .leftJoin(
            faaReviewModelUsage,
            eq(faaReviewModelUsage.id, signalAnalystSteps.modelUsageReceiptId),
          )
          .where(inArray(signalAnalystSteps.id, stepIds)),
    usageIds.length === 0
      ? Promise.resolve([])
      : db
          .select()
          .from(researchProviderUsage)
          .where(inArray(researchProviderUsage.id, usageIds)),
  ]);
  const linkedEvaluationReceipts =
    evaluationIds.length === 0
      ? []
      : await db
          .select()
          .from(faaReviewModelUsage)
          .where(
            inArray(faaReviewModelUsage.legacyEvaluationId, evaluationIds),
          );
  const receiptIdsForProviderUsage = [
    ...new Set([
      ...receipts.map((receipt) => receipt.id),
      ...linkedEvaluationReceipts.map((receipt) => receipt.id),
      ...steps.flatMap((row) => (row.receipt === null ? [] : [row.receipt.id])),
    ]),
  ];
  const [linkedStepUsage, receiptStepLinks, providerUsageForReceipts] =
    await Promise.all([
      stepIds.length === 0
        ? Promise.resolve([])
        : db
            .select()
            .from(researchProviderUsage)
            .where(inArray(researchProviderUsage.analystStepId, stepIds)),
      receiptIdsForProviderUsage.length === 0
        ? Promise.resolve([])
        : db
            .select({
              receiptId: signalAnalystSteps.modelUsageReceiptId,
              stepId: signalAnalystSteps.id,
            })
            .from(signalAnalystSteps)
            .innerJoin(
              signalAnalystCases,
              eq(signalAnalystCases.id, signalAnalystSteps.caseId),
            )
            .where(
              and(
                eq(signalAnalystCases.signalId, signalId),
                inArray(
                  signalAnalystSteps.modelUsageReceiptId,
                  receiptIdsForProviderUsage,
                ),
              ),
            )
            .orderBy(signalAnalystSteps.startedAt, signalAnalystSteps.id),
      receiptIdsForProviderUsage.length === 0
        ? Promise.resolve([])
        : db
            .select()
            .from(researchProviderUsage)
            .where(
              inArray(researchProviderUsage.id, receiptIdsForProviderUsage),
            ),
    ]);

  const byId = <T extends { id: string }>(rows: readonly T[]) =>
    new Map(rows.map((row) => [row.id, row]));
  const signalsById = byId(signals);
  const evidenceById = new Map(
    evidenceRows.map((row) => [row.evidence.id, row]),
  );
  const evaluationsById = byId(evaluations);
  const resultsById = byId(results);
  const receiptsById = byId(receipts);
  const casesById = byId(cases);
  const stepsById = new Map(steps.map((row) => [row.step.id, row]));
  const usageById = byId(standaloneUsage);
  const receiptByEvaluationId = new Map(
    linkedEvaluationReceipts
      .filter((receipt) => receipt.legacyEvaluationId !== null)
      .map((receipt) => [receipt.legacyEvaluationId!, receipt]),
  );
  const usageByStepId = new Map(
    linkedStepUsage.map((usage) => [usage.analystStepId!, usage]),
  );
  const usageByReceiptId = byId(providerUsageForReceipts);
  const billingStepIdByReceipt = new Map<string, string>();
  for (const row of receiptStepLinks) {
    if (row.receiptId !== null && !billingStepIdByReceipt.has(row.receiptId)) {
      billingStepIdByReceipt.set(row.receiptId, row.stepId);
    }
  }

  const events = selectedKeys.flatMap((key): SignalTimelineEvent[] => {
    if (key.kind === "source_observation") {
      const signal = signalsById.get(key.id);
      if (signal === undefined) return [];
      const sourceLocator = redactKnownLocation(signal.sourceLocator);
      return [
        {
          id: `source_observation:${signal.id}`,
          occurredAt: key.cursorAt,
          endedAt: null,
          actor: "Source",
          kind: "source_observation",
          title: `Source observation: ${signal.rawName}`,
          status: null,
          summary: `Retained ${signal.sourceKey} observation.`,
          modelId: null,
          promptVersion: null,
          inputHash: null,
          caseId: null,
          costUsd: null,
          costKnown: null,
          sources: safeSource(signal.sourceLocator, signal.rawName, null, {
            role: "discovery_only",
            representation: signal.sourceKey,
          }),
          details: {
            sourceKey: signal.sourceKey,
            sourceLocator: sourceLocator.value,
            sourceLocatorRedacted: sourceLocator.redacted,
            sourceFingerprint: signal.sourceFingerprint,
            rawName: signal.rawName,
            sourcePayload: previewDetail(signal.sourcePayload),
            qualification: previewDetail(signal.qualification),
          },
        },
      ];
    }
    if (key.kind === "source_evidence") {
      const row = evidenceById.get(key.id);
      if (row === undefined) return [];
      const locator = redactKnownLocation(row.evidence.locator);
      return [
        {
          id: `source_evidence:${row.evidence.id}`,
          occurredAt: key.cursorAt,
          endedAt: null,
          actor: "Source",
          kind: "source_evidence",
          title: row.document.title ?? "Retained research evidence",
          status: row.evidence.extractionStatus,
          summary: typeof locator.value === "string" ? locator.value : null,
          modelId: null,
          promptVersion: null,
          inputHash: null,
          caseId: null,
          costUsd: null,
          costKnown: null,
          sources: safeSource(
            row.document.canonicalUrl,
            row.document.title,
            row.evidence.quote,
          ),
          details: {
            stage: row.link.stage,
            researchRevision: row.link.researchRevision,
            extractionMethod: row.evidence.extractionMethod,
            locator: locator.value,
            locatorRedacted: locator.redacted,
            metadata: previewDetail(row.evidence.metadata),
          },
        },
      ];
    }
    if (key.kind === "faa_evaluation") {
      const evaluation = evaluationsById.get(key.id);
      if (evaluation === undefined) return [];
      const receipt = receiptByEvaluationId.get(evaluation.id);
      const providerUsage =
        receipt === undefined ? undefined : usageByReceiptId.get(receipt.id);
      const receiptIsBilledByMuseStep =
        receipt !== undefined && billingStepIdByReceipt.has(receipt.id);
      // Evaluation cost is a diagnostic aggregate; only receipts/usage bill.
      const settledCostUsd =
        receipt?.costUsd ?? providerUsage?.actualCostUsd ?? null;
      const costUsd = receiptIsBilledByMuseStep ? null : settledCostUsd;
      return [
        {
          id: `faa_evaluation:${evaluation.id}`,
          occurredAt: key.cursorAt,
          endedAt:
            evaluation.updatedAt.getTime() === evaluation.createdAt.getTime()
              ? null
              : timestamp(evaluation.updatedAt),
          actor: actorForEvaluation(evaluation, receipt),
          kind: "faa_evaluation",
          title: `FAA evaluation: ${evaluation.modelId}`,
          status:
            evaluation.error === null
              ? (evaluation.decision ?? "recorded")
              : "error",
          summary: evaluation.error ?? evaluation.reason,
          modelId:
            receipt?.returnedModel ??
            receipt?.configuredModel ??
            evaluation.modelId,
          promptVersion: evaluation.promptVersion,
          inputHash: evaluation.inputHash,
          caseId: null,
          costUsd,
          costKnown:
            receiptIsBilledByMuseStep || receipt === undefined
              ? null
              : costUsd !== null,
          sources: structuredSources(evaluation.parsed),
          details: {
            confidence: evaluation.confidence,
            decision: evaluation.decision,
            retryCount: evaluation.retryCount,
            reason: evaluation.reason,
            error: evaluation.error,
            tokens: previewDetail(evaluation.tokens),
            parsed: previewDetail(evaluation.parsed),
            rawResponse: previewDetail(evaluation.rawResponse),
            inputManifest: previewDetail(evaluation.inputManifest),
            diagnosticEvaluationCostUsd: evaluation.costUsd,
            receipt:
              receipt === undefined
                ? null
                : {
                    id: receipt.id,
                    phase: receipt.phase,
                    rung: receipt.rung,
                    costUsd: receipt.costUsd,
                    billedByMuseStep: receiptIsBilledByMuseStep,
                  },
            providerUsage:
              providerUsage === undefined
                ? null
                : {
                    id: providerUsage.id,
                    provider: providerUsage.provider,
                    operation: providerUsage.operation,
                    status: providerUsage.status,
                    actualCostUsd: providerUsage.actualCostUsd,
                    error: providerUsage.error,
                  },
          },
        },
      ];
    }
    if (key.kind === "faa_result") {
      const result = resultsById.get(key.id);
      if (result === undefined) return [];
      return [
        {
          id: `faa_result:${result.id}`,
          occurredAt: key.cursorAt,
          endedAt:
            result.updatedAt.getTime() === result.createdAt.getTime()
              ? null
              : timestamp(result.updatedAt),
          actor: "System",
          kind: "faa_result",
          title: "FAA evaluation outcome",
          status: result.finalDecision,
          summary: result.reason,
          modelId: result.adjudicatorModel,
          promptVersion:
            result.adjudicatorPromptVersion ?? result.promptVersion,
          inputHash: result.inputHash,
          caseId: null,
          costUsd: null,
          costKnown: null,
          sources: [],
          details: {
            jevEvaluationId: result.jevEvaluationId,
            museEvaluationId: result.museEvaluationId,
            modelAId: result.modelAId,
            modelBId: result.modelBId,
            modelADecision: result.modelADecision,
            modelBDecision: result.modelBDecision,
            agreed: result.agreed,
            adjudicationRequired: result.adjudicationRequired,
            adjudicatorOutput: previewDetail(result.adjudicatorOutput),
          },
        },
      ];
    }
    if (key.kind === "model_receipt") {
      const receipt = receiptsById.get(key.id);
      if (receipt === undefined) return [];
      const providerUsage = usageByReceiptId.get(receipt.id);
      const costUsd = receipt.costUsd ?? providerUsage?.actualCostUsd ?? null;
      return [
        {
          id: `model_receipt:${receipt.id}`,
          occurredAt: key.cursorAt,
          endedAt: null,
          actor:
            receipt.phase === "jev"
              ? "Jev"
              : receipt.phase === "muse"
                ? "Muse"
                : "System",
          kind: "model_receipt",
          title: "Unlinked model receipt",
          status: costUsd === null ? "cost_unknown" : "observed",
          summary: receipt.returnedModel ?? receipt.configuredModel,
          modelId: receipt.returnedModel ?? receipt.configuredModel,
          promptVersion: receipt.promptVersion,
          inputHash: receipt.inputHash,
          caseId: null,
          costUsd,
          costKnown: costUsd !== null,
          sources: [],
          details: {
            phase: receipt.phase,
            rung: receipt.rung,
            configuredModel: receipt.configuredModel,
            returnedModel: receipt.returnedModel,
            legacyEvaluationId: receipt.legacyEvaluationId,
            providerUsage:
              providerUsage === undefined
                ? null
                : {
                    id: providerUsage.id,
                    provider: providerUsage.provider,
                    operation: providerUsage.operation,
                    status: providerUsage.status,
                    actualCostUsd: providerUsage.actualCostUsd,
                    error: providerUsage.error,
                  },
          },
        },
      ];
    }
    if (key.kind === "muse_episode") {
      const analystCase = casesById.get(key.id);
      if (analystCase === undefined) return [];
      return [
        {
          id: `muse_episode:${analystCase.id}`,
          occurredAt: key.cursorAt,
          endedAt: optionalTimestamp(analystCase.completedAt),
          actor: "Muse",
          kind: "muse_episode",
          title: "Muse research episode",
          status: analystCase.status,
          summary: analystCase.stopReason,
          modelId: null,
          promptVersion: analystCase.policyVersion,
          inputHash: analystCase.inputHash,
          caseId: analystCase.id,
          costUsd: null,
          costKnown: null,
          sources: [],
          details: {
            sourceRevision: analystCase.sourceRevision,
            limits: previewDetail(analystCase.limits),
            checkpoint: previewDetail(analystCase.checkpoint),
            memo: previewDetail(analystCase.memo),
            nextAttemptAt: optionalTimestamp(analystCase.nextAttemptAt),
            stopReason: analystCase.stopReason,
          },
        },
      ];
    }
    if (key.kind === "muse_step") {
      const row = stepsById.get(key.id);
      if (row === undefined) return [];
      const receipt = row.receipt;
      const usage =
        usageByStepId.get(row.step.id) ??
        (receipt === null ? undefined : usageByReceiptId.get(receipt.id));
      const receiptBillingStepId =
        receipt === null ? undefined : billingStepIdByReceipt.get(receipt.id);
      const costIsBilledByAnotherStep =
        receiptBillingStepId !== undefined &&
        receiptBillingStepId !== row.step.id;
      const settledCostUsd =
        receipt?.costUsd ?? usage?.actualCostUsd ?? row.step.costUsd;
      const costUsd = costIsBilledByAnotherStep ? null : settledCostUsd;
      const costKnown = costIsBilledByAnotherStep
        ? null
        : (receipt !== null && receipt.costUsd !== null) ||
          (usage !== undefined && usage.actualCostUsd !== null) ||
          row.step.costKnown;
      return [
        {
          id: `muse_step:${row.step.id}`,
          occurredAt: key.cursorAt,
          endedAt:
            row.step.status === "late_result"
              ? optionalTimestamp(row.step.lateObservedAt)
              : optionalTimestamp(row.step.finishedAt),
          actor: "Muse",
          kind: "muse_step",
          title: `Muse action: ${row.step.kind}`,
          status: row.step.status,
          summary: row.step.error,
          modelId: receipt?.returnedModel ?? receipt?.configuredModel ?? null,
          promptVersion: receipt?.promptVersion ?? null,
          inputHash: row.step.claimInputHash,
          caseId: row.step.caseId,
          costUsd,
          costKnown,
          sources: structuredSources(row.step.response),
          details: {
            sequence: row.step.sequence,
            stage: row.step.claimPhase,
            requestHash: row.step.requestHash,
            request: previewDetail(row.step.request),
            response: previewDetail(row.step.response),
            observedStatus: row.step.observedStatus,
            error: row.step.error,
            receipt:
              receipt === null
                ? null
                : {
                    id: receipt.id,
                    phase: receipt.phase,
                    rung: receipt.rung,
                    costUsd: receipt.costUsd,
                    billedByAnotherMuseStep: costIsBilledByAnotherStep,
                  },
            providerUsage:
              usage === undefined
                ? null
                : {
                    id: usage.id,
                    provider: usage.provider,
                    operation: usage.operation,
                    status: usage.status,
                    estimatedCostUsd: usage.estimatedCostUsd,
                    actualCostUsd: usage.actualCostUsd,
                    error: usage.error,
                  },
          },
        },
      ];
    }
    const usage = usageById.get(key.id);
    if (usage === undefined) return [];
    return [
      {
        id: `provider_usage:${usage.id}`,
        occurredAt: key.cursorAt,
        endedAt: optionalTimestamp(usage.observedAt),
        actor: "System",
        kind: "provider_usage",
        title: `${usage.provider} ${usage.operation} resource receipt`,
        status: usage.status,
        summary: usage.error,
        modelId: null,
        promptVersion: null,
        inputHash: null,
        caseId: null,
        costUsd: usage.actualCostUsd,
        costKnown: usage.actualCostUsd !== null,
        sources: [],
        details: {
          stage: "resource",
          provider: usage.provider,
          operation: usage.operation,
          budgetScopeId: usage.budgetScopeId,
          requestHash: usage.requestHash,
          usageDay: usage.usageDay,
          estimatedCostUsd: usage.estimatedCostUsd,
          actualCostUsd: usage.actualCostUsd,
          error: usage.error,
          providerCooldownRetryAt: optionalTimestamp(
            usage.providerCooldownRetryAt,
          ),
          providerCooldownReason: usage.providerCooldownReason,
        },
      },
    ];
  });
  const lastSelected = selectedKeys.at(-1);
  return {
    items: events,
    nextCursor:
      lastSelected === undefined || keyed.length <= limit
        ? null
        : encodeSignalTimelineCursor({
            version: CURSOR_VERSION,
            sourceSignalId: signalId,
            occurredAt: lastSelected.cursorAt,
            eventId: `${lastSelected.kind}:${lastSelected.id}`,
          }),
  };
}
