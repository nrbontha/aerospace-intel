import { describe, expect, it } from "vitest";

import {
  SIGNAL_ANALYST_CHECKPOINT_VERSION,
  buildGroundedSignalAnalystMemo,
  signalAnalystCheckpointSchema,
  type SignalAnalystGap,
} from "../packages/research/src/faa-ensemble/analyst-protocol.js";

const inputHash = "a".repeat(64);
const gaps: readonly SignalAnalystGap[] = [
  {
    id: "ownership.current_control",
    field: "ownership",
    question: "Who currently controls the company?",
    priority: 1,
    reason: "Current ownership is unknown.",
  },
  {
    id: "revenue.annual_below_50m",
    field: "revenue",
    question: "What establishes current annual revenue?",
    priority: 1,
    reason: "Current annual revenue is unknown.",
  },
];

describe("signal analyst memo grounding", () => {
  it("does not launder a model answer through unrelated historical evidence", () => {
    const memo = buildGroundedSignalAnalystMemo({
      inputHash,
      createdAt: new Date("2026-09-28T12:00:00.000Z"),
      summary: "Model analysis remains subordinate to admitted facts.",
      gaps,
      currentGapIds: new Set(gaps.map((gap) => gap.id)),
      factsByField: {
        ownership: {
          status: "answered",
          answer: "Independent",
          evidenceIds: ["valid-but-unrelated-historical-reference"],
        },
        revenue: {
          status: "unresolved",
          answer: null,
          evidenceIds: [],
        },
      },
      unresolvedQuestions: [],
      nextActions: [],
    });

    expect(memo.answers).toEqual([
      expect.objectContaining({
        gapId: "ownership.current_control",
        status: "unresolved",
        evidenceIds: [],
      }),
      expect.objectContaining({
        gapId: "revenue.annual_below_50m",
        status: "unresolved",
        evidenceIds: [],
      }),
    ]);
  });

  it("answers a resolved episode gap only from the active field support", () => {
    const memo = buildGroundedSignalAnalystMemo({
      inputHash,
      createdAt: new Date("2026-09-28T12:00:00.000Z"),
      summary: "The active evidence supports current independent ownership.",
      gaps,
      currentGapIds: new Set(["revenue.annual_below_50m"]),
      factsByField: {
        ownership: {
          status: "answered",
          answer: "Current ownership assessment: independent",
          evidenceIds: ["ownership-active-1"],
        },
        revenue: {
          status: "unresolved",
          answer: null,
          evidenceIds: [],
        },
      },
      unresolvedQuestions: ["What establishes current annual revenue?"],
      nextActions: ["Retrieve attributable current financial disclosure."],
    });

    expect(memo.summary.label).toBe("model_analysis");
    expect(memo.answers[0]).toEqual({
      gapId: "ownership.current_control",
      field: "ownership",
      status: "answered",
      answer: "Current ownership assessment: independent",
      evidenceIds: ["ownership-active-1"],
    });
  });
});

describe("signal analyst checkpoint boundaries", () => {
  it("reads pre-turn checkpoints with no pending model identity", () => {
    const checkpoint = signalAnalystCheckpointSchema.parse({
      version: SIGNAL_ANALYST_CHECKPOINT_VERSION,
      gapCatalog: [],
      pendingAction: null,
      processedObservationStepIds: [],
      accessLimits: [],
      lastAnalysisSummary: null,
      blockedCapability: null,
    });

    expect(checkpoint.pendingModelTurn).toBeNull();
  });
});
