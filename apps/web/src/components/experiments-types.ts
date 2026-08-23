/** Client-side view types mirroring the experiments API DTOs. */

export type ProgramAxisView = "fit" | "actionability" | "novelty" | "confidence";
export type ProgramStatusView = "champion" | "challenger" | "archived" | "rejected";

export interface ScoringProgramView {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly axis: ProgramAxisView;
  readonly program: Record<string, unknown>;
  readonly complexity?: number;
  readonly status: ProgramStatusView;
  readonly isChampion: boolean;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

export interface RunResultEntry {
  readonly programId: string | null;
  readonly name: string;
  readonly role: "champion" | "challenger";
  readonly axis: string;
  readonly rank: number | null;
  readonly strongVsNegativeSeparation: number | null;
  readonly bootstrap: {
    readonly estimate: number;
    readonly lower: number;
    readonly upper: number;
  } | null;
  readonly loocv: { readonly maxRankMove: number } | null;
  readonly complexity: number | null;
  readonly holdoutSeparation: number | null;
  readonly vetoAudit: {
    readonly passed: boolean;
    readonly findings: ReadonlyArray<{
      readonly ruleKey: string;
      readonly status: string;
      readonly detail: string;
    }>;
  } | null;
  readonly leakedFields: readonly string[];
}

export interface ExperimentRunView {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly primaryMetricName?: string;
  readonly primaryMetricValue?: number;
  readonly result: Record<string, unknown>;
  readonly keep?: boolean;
  readonly decision?: string;
  readonly lineageParentId?: string;
  readonly campaignId?: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

export const RESEARCH_RUN_KINDS = [
  "research_policy",
  "enrichment_benchmark",
  "blind_discovery",
  "entity_resolution",
  "evidence_quality",
  "efficiency",
] as const;

export function runResultEntries(run: ExperimentRunView): RunResultEntry[] {
  const entries = run.result["entries"];
  return Array.isArray(entries) ? (entries as RunResultEntry[]) : [];
}
