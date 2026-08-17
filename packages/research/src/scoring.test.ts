import { describe, expect, it } from "vitest";

import {
  aggregateScorecard,
  freshnessFromAgeDays,
  scoreSource,
  scoreSupplier,
} from "./scoring.js";

describe("aggregateScorecard", () => {
  it("keeps overall null when every dimension is missing", () => {
    const card = aggregateScorecard({
      subjectType: "company",
      subjectId: "c1",
      dimensions: [
        { key: "a", label: "A", value: null, method: "unassessed" },
        { key: "b", label: "B", value: null, method: "unassessed" },
      ],
    });
    expect(card.overall).toBeNull();
    expect(card.completeness).toBe(0);
    expect(card.presentCount).toBe(0);
    expect(card.missingCount).toBe(2);
  });

  it("averages only present dimensions and does not coerce missing to zero", () => {
    const card = aggregateScorecard({
      subjectType: "company",
      subjectId: "c1",
      dimensions: [
        { key: "a", label: "A", value: 80, method: "derived" },
        { key: "b", label: "B", value: null, method: "unassessed" },
      ],
    });
    expect(card.overall).toBe(80);
    expect(card.completeness).toBe(0.5);
    expect(card.missingCount).toBe(1);
  });

  it("renormalizes weights across present dimensions", () => {
    const card = aggregateScorecard({
      subjectType: "data_source",
      subjectId: "s1",
      weights: { a: 3, b: 1, c: 1 },
      dimensions: [
        { key: "a", label: "A", value: 100, method: "derived" },
        { key: "b", label: "B", value: 0, method: "derived" },
        { key: "c", label: "C", value: null, method: "unassessed" },
      ],
    });
    expect(card.overall).toBe(75);
    expect(card.completeness).toBeCloseTo(2 / 3);
  });
});

describe("freshnessFromAgeDays", () => {
  it("scores recent documents high and old documents low without hitting zero immediately", () => {
    expect(freshnessFromAgeDays(0)).toBe(100);
    expect(freshnessFromAgeDays(30)).toBeGreaterThan(90);
    expect(freshnessFromAgeDays(365)).toBeGreaterThan(45);
    expect(freshnessFromAgeDays(2000)).toBeGreaterThan(0);
    expect(freshnessFromAgeDays(2000)).toBeLessThan(20);
  });
});

describe("scoreSource", () => {
  it("leaves freshness and reliability null when the source was never retrieved", () => {
    const card = scoreSource({
      subjectId: "s1",
      access: "public",
      hasPublisher: false,
      documentCount: 0,
      evidenceCount: 0,
      acceptedObservationCount: 0,
      rejectedObservationCount: 0,
      latestRetrievedAt: null,
      persistedReliability: null,
      persistedFreshness: null,
      persistedAuthority: null,
    });
    expect(card.overall).toBeNull();
    expect(card.completeness).toBe(0);
    expect(card.dimensions.every((dimension) => dimension.value === null)).toBe(
      true,
    );
  });

  it("does not treat restricted metadata-only access as a zero authority score", () => {
    const card = scoreSource({
      subjectId: "s1",
      access: "restricted_metadata_only",
      hasPublisher: true,
      documentCount: 0,
      evidenceCount: 0,
      acceptedObservationCount: 0,
      rejectedObservationCount: 0,
      latestRetrievedAt: null,
      persistedReliability: null,
      persistedFreshness: null,
      persistedAuthority: null,
    });
    const authority = card.dimensions.find(
      (dimension) => dimension.key === "authority",
    );
    expect(authority?.value).toBeNull();
    expect(authority?.method).toBe("unassessed_restricted_metadata");
  });

  it("uses recorded assessments when present", () => {
    const card = scoreSource({
      subjectId: "s1",
      access: "public",
      hasPublisher: true,
      documentCount: 0,
      evidenceCount: 0,
      acceptedObservationCount: 0,
      rejectedObservationCount: 0,
      latestRetrievedAt: null,
      persistedReliability: 70,
      persistedFreshness: 40,
      persistedAuthority: 90,
    });
    expect(card.overall).toBe(66.67);
    expect(card.completeness).toBe(1);
  });
});

describe("scoreSupplier", () => {
  it("scores identity from recorded fields and leaves research dimensions null until research exists", () => {
    const card = scoreSupplier({
      subjectId: "c1",
      hasLegalName: true,
      hasWebsite: true,
      hasCountry: false,
      hasDomain: false,
      observationCount: 0,
      canonicalFactCount: 0,
      evidenceCount: 0,
      qualificationCount: 0,
      qualificationsWithPlatform: 0,
      qualificationsWithCustomer: 0,
      latestObservationAt: null,
      hasCompletedResearch: false,
    });
    expect(card.presentCount).toBe(1);
    expect(card.missingCount).toBe(4);
    const identity = card.dimensions.find(
      (dimension) => dimension.key === "identity_completeness",
    );
    expect(identity?.value).toBe(50);
    expect(
      card.dimensions
        .filter((dimension) => dimension.key !== "identity_completeness")
        .every((dimension) => dimension.value === null),
    ).toBe(true);
    expect(card.overall).toBe(50);
  });

  it("computes review completeness only from existing observations", () => {
    const card = scoreSupplier({
      subjectId: "c1",
      hasLegalName: true,
      hasWebsite: true,
      hasCountry: true,
      hasDomain: true,
      observationCount: 4,
      canonicalFactCount: 2,
      evidenceCount: 4,
      qualificationCount: 2,
      qualificationsWithPlatform: 1,
      qualificationsWithCustomer: 1,
      latestObservationAt: new Date("2026-08-01T00:00:00.000Z"),
      hasCompletedResearch: true,
      now: new Date("2026-08-16T00:00:00.000Z"),
    });
    const review = card.dimensions.find(
      (dimension) => dimension.key === "review_completeness",
    );
    expect(review?.value).toBe(50);
    expect(card.missingCount).toBe(0);
    expect(card.overall).not.toBeNull();
  });
});
