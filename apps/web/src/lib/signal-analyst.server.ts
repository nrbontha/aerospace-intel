import {
  type faaEnsembleEvaluations,
  getDatabase,
  listSourceSignalAnalystOverviews,
  listSourceSignalAnalystOverviewsInSnapshot,
  parseSignalOverviewCursor,
  readCurrentSignalAnalystCase,
  readSignalAnalystCaseHistory,
  type SignalAnalystCaseView,
  type SignalOverviewReadiness,
  type SignalOverviewSort,
  type SourceSignalAnalystOverviewCursor,
} from "@asi/database";
import {
  currentFaaReviewInputContract,
  signalAnalystMemoSchema,
} from "@asi/research";

import { jsonValue } from "@/lib/api";
import type {
  JevTriageDto,
  SignalAnalystCaseDto,
  SignalDetailDto,
  SignalOverviewPageDto,
  SignalTriageEvaluationDto,
} from "@/lib/signal-analyst";

export const SIGNAL_PAGE_LIMIT_MAX = 100;
export const SIGNAL_HISTORY_LIMIT_MAX = 20;
export const SIGNAL_STEP_LIMIT_MAX = 100;

export { parseSignalOverviewCursor };
export type {
  SignalOverviewReadiness,
  SignalOverviewSort,
  SourceSignalAnalystOverviewCursor,
};

function isJevTriage(value: unknown): value is JevTriageDto {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const triage = value as Record<string, unknown>;
  return (
    triage["version"] === "jev-triage-v1" &&
    typeof triage["decision"] === "string" &&
    typeof triage["productFit"] === "string" &&
    typeof triage["acquisitionReadiness"] === "string" &&
    (triage["researchPriority"] === 1 ||
      triage["researchPriority"] === 2 ||
      triage["researchPriority"] === 3) &&
    Array.isArray(triage["reasonCodes"]) &&
    typeof triage["explanation"] === "string" &&
    Array.isArray(triage["observations"]) &&
    Array.isArray(triage["gaps"])
  );
}

function serializeTriageEvaluation(
  evaluation: typeof faaEnsembleEvaluations.$inferSelect | null | undefined,
): SignalTriageEvaluationDto | null {
  if (evaluation === null || evaluation === undefined || !isJevTriage(evaluation.parsed)) {
    return null;
  }
  return jsonValue({
    id: evaluation.id,
    inputHash: evaluation.inputHash,
    decision: evaluation.decision,
    confidence: evaluation.confidence,
    reason: evaluation.reason,
    parsed: evaluation.parsed,
    createdAt: evaluation.createdAt,
    updatedAt: evaluation.updatedAt,
  }) as SignalTriageEvaluationDto;
}

function serializeCaseView(view: SignalAnalystCaseView): SignalAnalystCaseDto {
  const parsedMemo = signalAnalystMemoSchema.safeParse(view.case.memo);
  const memo = parsedMemo.success ? parsedMemo.data : null;
  const memoCurrent =
    view.current &&
    view.case.status === "completed" &&
    memo !== null &&
    memo.inputHash === view.case.inputHash;
  return jsonValue({
    ...view,
    memo,
    memoValid: parsedMemo.success,
    memoCurrent,
  }) as SignalAnalystCaseDto;
}

export async function listSignalAnalystOverviews(input: {
  readonly limit: number;
  readonly sort?: SignalOverviewSort;
  readonly q?: string;
  readonly readiness?: SignalOverviewReadiness;
  readonly after?: SourceSignalAnalystOverviewCursor;
}): Promise<SignalOverviewPageDto> {
  const expectedReviewInputContract = currentFaaReviewInputContract();
  const page = await listSourceSignalAnalystOverviews(getDatabase(), {
    expectedReviewInputContract,
    limit: input.limit,
    ...(input.sort === undefined ? {} : { sort: input.sort }),
    ...(input.q === undefined ? {} : { q: input.q }),
    ...(input.readiness === undefined
      ? {}
      : { readiness: input.readiness }),
    ...(input.after === undefined ? {} : { after: input.after }),
  });
  return jsonValue({
    items: page.items.map((item) => {
      const parsedMemo = signalAnalystMemoSchema.safeParse(item.currentCase?.memo);
      return {
        ...item,
        currentTriage: serializeTriageEvaluation(item.currentTriage),
        memoCurrent:
          item.currentCaseProofCurrent &&
          item.currentCase?.status === "completed" &&
          parsedMemo.success &&
          parsedMemo.data.inputHash === item.currentCase.inputHash,
      };
    }),
    nextCursor: page.nextCursor,
  }) as SignalOverviewPageDto;
}

export async function readSignalAnalystDetail(
  signalId: string,
  input: { readonly caseLimit: number; readonly stepLimit: number },
): Promise<SignalDetailDto | null> {
  const db = getDatabase();
  const expectedReviewInputContract = currentFaaReviewInputContract();
  return db.transaction(
    async (tx) => {
      const overview = await listSourceSignalAnalystOverviewsInSnapshot(tx, {
        expectedReviewInputContract,
        limit: 1,
        sourceSignalIds: [signalId],
      });
      const selected = overview.items[0];
      if (selected === undefined) return null;

      const [currentCase, history] = await Promise.all([
        readCurrentSignalAnalystCase(tx, signalId, {
          expectedReviewInputContract,
          stepLimit: input.stepLimit,
        }),
        readSignalAnalystCaseHistory(tx, signalId, {
          expectedReviewInputContract,
          caseLimit: input.caseLimit,
          stepLimitPerCase: input.stepLimit,
        }),
      ]);

      return jsonValue({
        signal: selected.signal,
        review: selected.review,
        currentTriage: serializeTriageEvaluation(selected.currentTriage),
        currentCase: currentCase === null ? null : serializeCaseView(currentCase),
        history: history.map(serializeCaseView),
        historyLimit: input.caseLimit,
        ranking: selected.ranking,
      }) as SignalDetailDto;
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
