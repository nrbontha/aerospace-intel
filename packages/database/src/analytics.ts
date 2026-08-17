import { getCatalogCoverageCounts } from "./scores.js";
import { and, count, desc, eq, inArray, sql, sum } from "drizzle-orm";

import { getDatabase } from "./client.js";
import {
  RepositoryConflictError,
  RepositoryNotFoundError,
} from "./repositories.js";
import {
  inferObservationValueKind,
  isEditedProposalValue,
} from "./provenance.js";
import {
  auditEvents,
  canonicalFacts,
  companies,
  dataSources,
  evidence,
  modelUsage,
  observations,
  proposalReviews,
  researchProposals,
  researchRuns,
  sourceDocuments,
} from "./schema.js";

export interface ResearchProposalRecord {
  readonly id: string;
  readonly status: "pending" | "accepted" | "rejected" | "superseded";
  readonly researchRunId: string;
  readonly observationId: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly fieldKey: string;
  readonly proposedValue: unknown;
  readonly currentValue: unknown;
  readonly rationale: string | null;
  readonly confidence: string;
  readonly conflictStatus: string;
  readonly evidence: {
    readonly quote: string | null;
    readonly locator: string | null;
    readonly documentTitle: string | null;
    readonly canonicalUrl: string | null;
    readonly dataSourceName: string;
  };
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly reviewedAt: Date | null;
}
export interface ListResearchProposalRecordsInput {
  readonly status?: "pending" | "accepted" | "rejected" | "superseded";
  readonly page?: number;
  readonly pageSize?: number;
}

function proposalSelection() {
  return {
    id: researchProposals.id,
    status: researchProposals.status,
    researchRunId: researchProposals.researchRunId,
    observationId: researchProposals.observationId,
    subjectType: researchProposals.subjectType,
    subjectId: researchProposals.subjectId,
    fieldKey: researchProposals.fieldKey,
    proposedValue: observations.value,
    currentValue: sql`(
      select o.value
      from canonical_facts cf
      inner join observations o on o.id = cf.current_observation_id
      where cf.subject_type = ${researchProposals.subjectType}
        and cf.subject_id = ${researchProposals.subjectId}
        and cf.field_key = ${researchProposals.fieldKey}
      limit 1
    )`,
    rationale: researchProposals.rationale,
    confidence: observations.confidence,
    conflictStatus: observations.conflictStatus,
    quote: evidence.quote,
    locator: evidence.locator,
    documentTitle: sourceDocuments.title,
    canonicalUrl: sourceDocuments.canonicalUrl,
    dataSourceName: dataSources.name,
    createdAt: researchProposals.createdAt,
    updatedAt: researchProposals.updatedAt,
    reviewedAt: sql<Date | null>`(select max(pr.created_at) from proposal_reviews pr where pr.proposal_id = ${researchProposals.id})`,
  };
}
function shapeProposal(
  row: ReturnType<typeof proposalSelection> extends never
    ? never
    : Record<string, unknown>,
): ResearchProposalRecord {
  const value = row as {
    id: string;
    status: ResearchProposalRecord["status"];
    researchRunId: string;
    observationId: string;
    subjectType: string;
    subjectId: string;
    fieldKey: string;
    proposedValue: unknown;
    currentValue: unknown;
    rationale: string | null;
    confidence: string;
    conflictStatus: string;
    quote: string | null;
    locator: string | null;
    documentTitle: string | null;
    canonicalUrl: string | null;
    dataSourceName: string;
    createdAt: Date;
    updatedAt: Date;
    reviewedAt: Date | null;
  };
  return {
    id: value.id,
    status: value.status,
    researchRunId: value.researchRunId,
    observationId: value.observationId,
    subjectType: value.subjectType,
    subjectId: value.subjectId,
    fieldKey: value.fieldKey,
    proposedValue: value.proposedValue,
    currentValue: value.currentValue,
    rationale: value.rationale,
    confidence: value.confidence,
    conflictStatus: value.conflictStatus,
    evidence: {
      quote: value.quote,
      locator: value.locator,
      documentTitle: value.documentTitle,
      canonicalUrl: value.canonicalUrl,
      dataSourceName: value.dataSourceName,
    },
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    reviewedAt: value.reviewedAt,
  };
}
export async function getResearchProposalRecord(
  id: string,
): Promise<ResearchProposalRecord | null> {
  const [row] = await getDatabase()
    .select(proposalSelection())
    .from(researchProposals)
    .innerJoin(
      observations,
      eq(observations.id, researchProposals.observationId),
    )
    .innerJoin(evidence, eq(evidence.id, observations.evidenceId))
    .innerJoin(
      sourceDocuments,
      eq(sourceDocuments.id, evidence.sourceDocumentId),
    )
    .innerJoin(dataSources, eq(dataSources.id, sourceDocuments.dataSourceId))
    .where(eq(researchProposals.id, id))
    .limit(1);
  return row ? shapeProposal(row) : null;
}
export async function listResearchProposalRecords(
  input: ListResearchProposalRecordsInput = {},
): Promise<{
  records: ResearchProposalRecord[];
  page: number;
  pageSize: number;
  total: number;
}> {
  const page = Math.max(1, input.page ?? 1),
    pageSize = Math.min(100, Math.max(1, input.pageSize ?? 25));
  const condition = input.status
    ? eq(researchProposals.status, input.status)
    : undefined;
  const [totalRow] = await getDatabase()
    .select({ value: count() })
    .from(researchProposals)
    .where(condition);
  const rows = await getDatabase()
    .select(proposalSelection())
    .from(researchProposals)
    .innerJoin(
      observations,
      eq(observations.id, researchProposals.observationId),
    )
    .innerJoin(evidence, eq(evidence.id, observations.evidenceId))
    .innerJoin(
      sourceDocuments,
      eq(sourceDocuments.id, evidence.sourceDocumentId),
    )
    .innerJoin(dataSources, eq(dataSources.id, sourceDocuments.dataSourceId))
    .where(condition)
    .orderBy(desc(researchProposals.createdAt), desc(researchProposals.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return {
    records: rows.map(shapeProposal),
    page,
    pageSize,
    total: totalRow?.value ?? 0,
  };
}

export interface ReviewResearchProposalInput {
  readonly reviewerUserId: string;
  readonly decision: "accepted" | "rejected";
  readonly reason?: string;
  readonly editedValue?: unknown;
  readonly requestId?: string;
}
export async function reviewResearchProposalRecord(
  proposalId: string,
  input: ReviewResearchProposalInput,
): Promise<{
  proposal: ResearchProposalRecord;
  replacementProposal: ResearchProposalRecord | null;
}> {
  let replacementId: string | null = null;
  await getDatabase().transaction(async (tx) => {
    const [proposal] = await tx
      .select()
      .from(researchProposals)
      .where(eq(researchProposals.id, proposalId))
      .for("update");
    if (!proposal) throw new RepositoryNotFoundError("proposal", proposalId);
    if (proposal.status !== "pending")
      throw new RepositoryConflictError(
        "Only pending proposals can be reviewed",
      );
    const [observation] = await tx
      .select()
      .from(observations)
      .where(eq(observations.id, proposal.observationId))
      .for("update");
    if (!observation)
      throw new RepositoryNotFoundError("observation", proposal.observationId);
    const edited = isEditedProposalValue(input.editedValue);
    const finalStatus = edited ? ("superseded" as const) : input.decision;
    await tx
      .update(researchProposals)
      .set({ status: finalStatus, updatedAt: new Date() })
      .where(eq(researchProposals.id, proposal.id));
    await tx
      .insert(proposalReviews)
      .values({
        proposalId: proposal.id,
        reviewerUserId: input.reviewerUserId,
        decision: finalStatus,
        reason: input.reason,
      });
    let acceptedObservationId = observation.id,
      acceptedProposalId = proposal.id;
    if (edited) {
      const [replacementObservation] = await tx
        .insert(observations)
        .values({
          subjectType: observation.subjectType,
          subjectId: observation.subjectId,
          fieldKey: observation.fieldKey,
          valueKind: inferObservationValueKind(input.editedValue),
          value: input.editedValue,
          normalizedText:
            typeof input.editedValue === "string"
              ? input.editedValue.normalize("NFKC").trim().replace(/\s+/gu, " ")
              : null,
          unit: observation.unit,
          validFrom: observation.validFrom,
          validTo: observation.validTo,
          observedAt: new Date(),
          confidence: observation.confidence,
          evidenceId: observation.evidenceId,
          reviewStatus: "accepted",
          conflictStatus: observation.conflictStatus,
          createdByUserId: input.reviewerUserId,
        })
        .returning({ id: observations.id });
      if (!replacementObservation)
        throw new Error("Unable to append replacement observation");
      const [replacement] = await tx
        .insert(researchProposals)
        .values({
          researchRunId: proposal.researchRunId,
          observationId: replacementObservation.id,
          subjectType: proposal.subjectType,
          subjectId: proposal.subjectId,
          fieldKey: proposal.fieldKey,
          status: "accepted",
          rationale: input.reason ?? proposal.rationale,
          proposedByModelUsageId: proposal.proposedByModelUsageId,
        })
        .returning({ id: researchProposals.id });
      if (!replacement)
        throw new Error("Unable to append replacement proposal");
      replacementId = replacement.id;
      acceptedObservationId = replacementObservation.id;
      acceptedProposalId = replacement.id;
      await tx
        .insert(proposalReviews)
        .values({
          proposalId: replacement.id,
          reviewerUserId: input.reviewerUserId,
          decision: "accepted",
          reason: input.reason,
        });
    }
    if (input.decision === "accepted") {
      const [current] = await tx
        .select()
        .from(canonicalFacts)
        .where(
          and(
            eq(canonicalFacts.subjectType, proposal.subjectType),
            eq(canonicalFacts.subjectId, proposal.subjectId),
            eq(canonicalFacts.fieldKey, proposal.fieldKey),
          ),
        )
        .for("update");
      if (current)
        await tx
          .update(canonicalFacts)
          .set({
            currentObservationId: acceptedObservationId,
            acceptedProposalId,
            supersededObservationId: current.currentObservationId,
            effectiveFrom: new Date(),
            updatedByUserId: input.reviewerUserId,
            updatedAt: new Date(),
          })
          .where(eq(canonicalFacts.id, current.id));
      else
        await tx
          .insert(canonicalFacts)
          .values({
            subjectType: proposal.subjectType,
            subjectId: proposal.subjectId,
            fieldKey: proposal.fieldKey,
            currentObservationId: acceptedObservationId,
            acceptedProposalId,
            updatedByUserId: input.reviewerUserId,
          });
    }
    await tx
      .insert(auditEvents)
      .values({
        actorUserId: input.reviewerUserId,
        action: edited
          ? "proposal.edit_and_accept"
          : `proposal.${input.decision}`,
        entityType: "research_proposal",
        entityId: proposal.id,
        requestId: input.requestId,
        before: {
          status: proposal.status,
          observationId: proposal.observationId,
        },
        after: {
          status: finalStatus,
          acceptedObservationId,
          replacementProposalId: replacementId,
        },
        metadata: { reason: input.reason ?? null },
      });
  });
  const reviewed = await getResearchProposalRecord(proposalId);
  if (!reviewed) throw new RepositoryNotFoundError("proposal", proposalId);
  const replacement = replacementId ? await getResearchProposalRecord(replacementId) : null;
  return { proposal: reviewed, replacementProposal: replacement };
}

export interface DashboardMetrics {
  companyCount: number;
  dataSourceCount: number;
  unminedDataSourceCount: number;
  restrictedDataSourceCount: number;
  sourceDocumentCount: number;
  evidenceCount: number;
  observationCount: number;
  canonicalFactCount: number;
  pendingProposalCount: number;
  activeResearchRunCount: number;
  failedResearchRunCount: number;
  succeededResearchRunCount: number;
  facilityCount: number;
  platformCount: number;
  partCount: number;
  qualificationCount: number;
  importCount: number;
  capabilityCount: number;
  certificationCount: number;
  subsystemCount: number;
  customerCount: number;
  totalSpendUsd: string;
  todaySpendUsd: string;
  inputTokens: number;
  outputTokens: number;
}
export async function getDashboardMetrics(): Promise<DashboardMetrics> {
  const db = getDatabase();
  const [
    company,
    source,
    unmined,
    restricted,
    documents,
    evidenceRows,
    observation,
    canonical,
    pending,
    active,
    failed,
    succeeded,
    usage,
  ] = await Promise.all([
    db.select({ value: count() }).from(companies),
    db.select({ value: count() }).from(dataSources),
    db
      .select({ value: count() })
      .from(dataSources)
      .leftJoin(
        sourceDocuments,
        eq(sourceDocuments.dataSourceId, dataSources.id),
      )
      .where(sql`${sourceDocuments.id} is null`),
    db
      .select({ value: count() })
      .from(dataSources)
      .where(eq(dataSources.access, "restricted_metadata_only")),
    db.select({ value: count() }).from(sourceDocuments),
    db.select({ value: count() }).from(evidence),
    db.select({ value: count() }).from(observations),
    db.select({ value: count() }).from(canonicalFacts),
    db
      .select({ value: count() })
      .from(researchProposals)
      .where(eq(researchProposals.status, "pending")),
    db
      .select({ value: count() })
      .from(researchRuns)
      .where(inArray(researchRuns.status, ["queued", "running"])),
    db
      .select({ value: count() })
      .from(researchRuns)
      .where(eq(researchRuns.status, "failed")),
    db
      .select({ value: count() })
      .from(researchRuns)
      .where(eq(researchRuns.status, "succeeded")),
    db
      .select({
        totalSpendUsd: sum(modelUsage.costUsd),
        todaySpendUsd: sql<string>`coalesce(sum(${modelUsage.costUsd}) filter (where ${modelUsage.createdAt} >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'), 0)`,
        inputTokens: sql<number>`coalesce(sum(${modelUsage.inputTokens}), 0)::integer`,
        outputTokens: sql<number>`coalesce(sum(${modelUsage.outputTokens}), 0)::integer`,
      })
      .from(modelUsage),
  ]);
  const coverage = await getCatalogCoverageCounts();
  const u = usage[0];
  return {
    companyCount: company[0]?.value ?? 0,
    dataSourceCount: source[0]?.value ?? 0,
    unminedDataSourceCount: unmined[0]?.value ?? 0,
    restrictedDataSourceCount: restricted[0]?.value ?? 0,
    sourceDocumentCount: documents[0]?.value ?? 0,
    evidenceCount: evidenceRows[0]?.value ?? 0,
    observationCount: observation[0]?.value ?? 0,
    canonicalFactCount: canonical[0]?.value ?? 0,
    pendingProposalCount: pending[0]?.value ?? 0,
    activeResearchRunCount: active[0]?.value ?? 0,
    failedResearchRunCount: failed[0]?.value ?? 0,
    succeededResearchRunCount: succeeded[0]?.value ?? 0,
    facilityCount: coverage.facilityCount,
    platformCount: coverage.platformCount,
    partCount: coverage.partCount,
    qualificationCount: coverage.qualificationCount,
    importCount: coverage.importCount,
    capabilityCount: coverage.capabilityCount,
    certificationCount: coverage.certificationCount,
    subsystemCount: coverage.subsystemCount,
    customerCount: coverage.customerCount,
    totalSpendUsd: u?.totalSpendUsd ?? "0",
    todaySpendUsd: u?.todaySpendUsd ?? "0",
    inputTokens: u?.inputTokens ?? 0,
    outputTokens: u?.outputTokens ?? 0,
  };
}


export interface DashboardSeriesPoint {
  readonly day: string;
  readonly succeededRuns: number;
  readonly failedRuns: number;
  readonly proposalCount: number;
  readonly spendUsd: number;
}

export async function getDashboardSeries(
  days = 30,
): Promise<readonly DashboardSeriesPoint[]> {
  const windowDays = Number.isInteger(days) && days > 0 ? Math.min(days, 90) : 30;
  const db = getDatabase();
  const since = sql`now() - make_interval(days => ${windowDays})`;
  const [runRows, proposalRows, spendRows] = await Promise.all([
    db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${researchRuns.createdAt} at time zone 'utc'), 'YYYY-MM-DD')`,
        succeededRuns: sql<number>`count(*) filter (where ${researchRuns.status} = 'succeeded')`,
        failedRuns: sql<number>`count(*) filter (where ${researchRuns.status} = 'failed')`,
      })
      .from(researchRuns)
      .where(sql`${researchRuns.createdAt} >= ${since}`)
      .groupBy(sql`date_trunc('day', ${researchRuns.createdAt} at time zone 'utc')`),
    db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${researchProposals.createdAt} at time zone 'utc'), 'YYYY-MM-DD')`,
        proposalCount: sql<number>`count(*)`,
      })
      .from(researchProposals)
      .where(sql`${researchProposals.createdAt} >= ${since}`)
      .groupBy(sql`date_trunc('day', ${researchProposals.createdAt} at time zone 'utc')`),
    db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${modelUsage.createdAt} at time zone 'utc'), 'YYYY-MM-DD')`,
        spendUsd: sql<string>`coalesce(sum(${modelUsage.costUsd}), 0)`,
      })
      .from(modelUsage)
      .where(sql`${modelUsage.createdAt} >= ${since}`)
      .groupBy(sql`date_trunc('day', ${modelUsage.createdAt} at time zone 'utc')`),
  ]);

  const byDay = new Map<string, DashboardSeriesPoint>();
  const today = new Date();
  for (let offset = windowDays - 1; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - offset));
    const day = date.toISOString().slice(0, 10);
    byDay.set(day, {
      day,
      succeededRuns: 0,
      failedRuns: 0,
      proposalCount: 0,
      spendUsd: 0,
    });
  }
  for (const row of runRows) {
    const current = byDay.get(row.day);
    if (!current) continue;
    byDay.set(row.day, {
      ...current,
      succeededRuns: Number(row.succeededRuns) || 0,
      failedRuns: Number(row.failedRuns) || 0,
    });
  }
  for (const row of proposalRows) {
    const current = byDay.get(row.day);
    if (!current) continue;
    byDay.set(row.day, {
      ...current,
      proposalCount: Number(row.proposalCount) || 0,
    });
  }
  for (const row of spendRows) {
    const current = byDay.get(row.day);
    if (!current) continue;
    byDay.set(row.day, {
      ...current,
      spendUsd: Number(row.spendUsd) || 0,
    });
  }
  return [...byDay.values()];
}
