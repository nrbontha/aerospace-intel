import type {
  InvestorRanking,
  SourceSignalAnalystOverviewCursor,
} from "@asi/database";
import type { SignalAnalystMemo } from "@asi/research";

export type { InvestorRanking };
export type SignalOverviewCursorDto = SourceSignalAnalystOverviewCursor;

export type JsonRecord = Readonly<Record<string, unknown>>;

export interface SignalSourceDto {
  readonly id: string;
  readonly reviewRevision: number;
  readonly sourceKey: string;
  readonly sourceLocator: string;
  readonly sourceFingerprint: string;
  readonly rawName: string;
  readonly rawDomain: string | null;
  readonly uei: string | null;
  readonly cage: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly country: string | null;
  readonly awardCount: number | null;
  readonly awardValue: string | null;
  readonly freshestAward: string | null;
  readonly sourcePayload: JsonRecord;
  readonly status: string;
  readonly qualification: JsonRecord;
  readonly leadId: string | null;
  readonly companyId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly qualifiedAt: string | null;
  readonly rejectedAt: string | null;
}

export interface SignalReviewDto {
  readonly signalId: string;
  readonly sourceRevision: number;
  readonly phase: string;
  readonly inputHash: string | null;
  readonly inputManifest: JsonRecord | null;
  readonly researchEvidence: JsonRecord;
  readonly jevEvaluationId: string | null;
  readonly nextAttemptAt: string;
  readonly attemptCount: number;
  readonly lastError: string | null;
  readonly researchDueAt: string | null;
  readonly lastResearchOutcome: JsonRecord | null;
  readonly inputsCheckedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface JevSourceReferenceDto {
  readonly kind: "source_signal" | "source_document";
  readonly sourceKey?: string | null;
  readonly sourceLocator?: string | null;
  readonly sourceFingerprint?: string | null;
  readonly url?: string;
  readonly stage?: string;
  readonly title?: string;
  readonly quote?: string;
  readonly caveat?: string;
  readonly contentSha256?: string;
  readonly sourceKind?: string;
  readonly firstParty?: boolean;
  readonly retrievedAt?: string | null;
  readonly role?:
    | "support"
    | "checked_only"
    | "discovery_only"
    | "candidate_evidence";
}

export interface JevTriageDto {
  readonly version: "jev-triage-v1";
  readonly decision: "reject" | "research" | "high_priority";
  readonly confidence: number | null;
  readonly productFit:
    | "supported_product"
    | "plausible_supplier"
    | "process_or_service"
    | "unknown"
    | "outside_scope";
  readonly acquisitionReadiness: "ready" | "needs_research" | "blocked";
  readonly researchPriority: 1 | 2 | 3;
  readonly reasonCodes: readonly string[];
  readonly explanation: string;
  readonly observations: readonly {
    readonly rung: string;
    readonly kind: string;
    readonly field: string;
    readonly value: string | number | boolean | null;
    readonly confidence: number | null;
    readonly reasonCode: string;
    readonly explanation: string;
    readonly sourceReferences: readonly JevSourceReferenceDto[];
  }[];
  readonly gaps: readonly {
    readonly id: string;
    readonly field: string;
    readonly question: string;
    readonly priority: 1 | 2 | 3;
    readonly reason: string;
    readonly supportingSources: readonly JevSourceReferenceDto[];
    readonly conflictingSources: readonly JevSourceReferenceDto[];
  }[];
}

export interface SignalTriageEvaluationDto {
  readonly id: string;
  readonly inputHash: string | null;
  readonly decision: string | null;
  readonly confidence: number | null;
  readonly reason: string | null;
  readonly parsed: JevTriageDto;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SignalAnalystStepDto {
  readonly id: string;
  readonly caseId: string;
  readonly sequence: number;
  readonly kind: string;
  readonly request: JsonRecord;
  readonly requestHash: string;
  readonly status: string;
  readonly response: JsonRecord | null;
  readonly observedStatus: string | null;
  readonly error: string | null;
  readonly costKnown: boolean;
  readonly costUsd: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly lateObservedAt: string | null;
}

export interface SignalAnalystCaseDto {
  readonly case: {
    readonly id: string;
    readonly signalId: string;
    readonly sourceRevision: number;
    readonly policyVersion: string;
    readonly inputHash: string;
    readonly status: string;
    readonly limits: JsonRecord;
    readonly checkpoint: JsonRecord;
    readonly memo: JsonRecord | null;
    readonly nextAttemptAt: string | null;
    readonly stopReason: string | null;
    readonly completedAt: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly current: boolean;
  readonly episodeCurrent: boolean;
  readonly superseded: boolean;
  readonly memo: SignalAnalystMemo | null;
  readonly memoValid: boolean;
  readonly memoEvidenceCurrent: boolean;
  readonly memoCurrent: boolean;
  readonly steps: readonly SignalAnalystStepDto[];
  readonly hasMoreSteps: boolean;
  readonly providerUsage: readonly JsonRecord[];
  readonly providerSpend: {
    readonly knownActualCostUsd: string;
    readonly unknownEstimatedCostUsd: string;
    readonly receiptCount: number;
    readonly unknownReceiptCount: number;
  };
  readonly modelUsage: readonly JsonRecord[];
  readonly modelSpend: {
    readonly knownActualCostUsd: string;
    readonly receiptCount: number;
    readonly unknownReceiptCount: number;
  };
}

export interface SignalOverviewDto {
  readonly signal: SignalSourceDto;
  readonly investorApproved: boolean;
  readonly review: SignalReviewDto | null;
  readonly currentTriage: SignalTriageEvaluationDto | null;
  readonly currentCase: SignalAnalystCaseDto["case"] | null;
  readonly currentCaseProofCurrent: boolean;
  readonly ranking: InvestorRanking;
  readonly memoSummary: string | null;
  readonly memoEvidenceCurrent: boolean;
  readonly memoCurrent: boolean;
}

export interface SignalOverviewPageDto {
  readonly items: readonly SignalOverviewDto[];
  readonly nextCursor: SignalOverviewCursorDto | null;
}

export interface SignalDetailDto {
  readonly signal: SignalSourceDto;
  readonly investorApproved: boolean;
  readonly review: SignalReviewDto | null;
  readonly currentTriage: SignalTriageEvaluationDto | null;
  readonly ranking: InvestorRanking;
  readonly currentCase: SignalAnalystCaseDto | null;
  readonly history: readonly SignalAnalystCaseDto[];
  readonly historyLimit: number;
}

export function isNavigableHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
