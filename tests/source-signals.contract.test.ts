import { describe, expect, it } from "vitest";

import {
  agentTypeSchema,
  sourceSignalDtoSchema,
  sourceSignalListQuerySchema,
  sourceSignalQualificationDecisionSchema,
} from "@asi/contracts";

const id = "123e4567-e89b-12d3-a456-426614174000";
const instant = "2026-08-24T12:00:00.000Z";

const sourceSignal = {
  id,
  sourceKey: "usaspending",
  sourceLocator: "recipient:ACME-123",
  sourceFingerprint: "usaspending:recipient:ACME-123",
  agentId: null,
  rawName: "Acme Precision Components, LLC",
  rawDomain: null,
  uei: null,
  cage: null,
  city: "Wichita",
  state: "KS",
  country: "US",
  awardCount: 3,
  awardValue: 1_250_000,
  freshestAward: instant,
  sourcePayload: { recipientId: "ACME-123" },
  status: "queued_qualification",
  qualification: {},
  leadId: null,
  companyId: null,
  createdAt: instant,
  updatedAt: instant,
  qualifiedAt: null,
  rejectedAt: null,
};

const qualificationDecision = {
  decision: "qualified",
  reason: "Independent sources confirm a component manufacturer serving aerospace.",
  evidenceUrls: ["https://example.com/capabilities"],
  manufacturerEvidence: true,
  aerospaceEvidence: true,
  ownershipRisk: "low",
  confidence: 0.92,
};


describe("source signal contracts", () => {
  it("validates raw observations without treating them as leads", () => {
    expect(sourceSignalDtoSchema.safeParse(sourceSignal).success).toBe(true);
    expect(
      sourceSignalDtoSchema.safeParse({ ...sourceSignal, unexpected: true }).success,
    ).toBe(false);
  });

  it("validates strict filters and qualification decisions", () => {
    expect(
      sourceSignalListQuerySchema.parse({
        status: "qualifying",
        sourceKey: "usaspending",
        city: "Wichita",
        state: "KS",
        minAwardValue: "100000",
        q: "precision",
      }),
    ).toMatchObject({ minAwardValue: 100_000, page: 1, pageSize: 25 });
    expect(sourceSignalListQuerySchema.safeParse({ q: "acme", extra: true }).success).toBe(
      false,
    );

    expect(
      sourceSignalQualificationDecisionSchema.safeParse(qualificationDecision).success,
    ).toBe(true);
    expect(
      sourceSignalQualificationDecisionSchema.safeParse({
        ...qualificationDecision,
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      sourceSignalQualificationDecisionSchema.safeParse({
        decision: "qualified",
        reason: "missing confidence",
        evidenceUrls: [],
        manufacturerEvidence: true,
        aerospaceEvidence: true,
        ownershipRisk: "low",
        confidence: 1.1,
      }).success,
    ).toBe(false);
  });

  it("exposes the qualification agent type", () => {
    expect(agentTypeSchema.safeParse("qualify_award_lead").success).toBe(true);
  });
});
