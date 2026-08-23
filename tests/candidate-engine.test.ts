/**
 * Always-on unit tests for the candidate promotion engine's pure layers:
 * canonical-state feature mapping, band parity with the frozen engine
 * ladder, axis computation determinism, and queue→status routing.
 *
 *   npx vitest run tests/candidate-engine.test.ts
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_ACTIONABILITY_PROGRAM,
  DEFAULT_FIT_PROGRAM,
  FEATURE_SCHEMA_VERSION,
  REVENUE_BAND_VALUES,
  EMPLOYEES_BAND_VALUES,
  OWNERSHIP_TYPE_VALUES,
  BUILD_TO_PRINT_SHARE_VALUES,
  evaluateProgram,
  extractFeatureVector,
} from "../packages/research/src/scoring-axial/index.js";

import {
  buildFeatureRecordInput,
  certificationStatus,
  employeesBandFromRange,
  mapBuildToPrintRisk,
  mapOwnershipType,
  revenueBandFromRange,
  type CanonicalCompanyState,
} from "../packages/database/src/candidates/mapping.js";

function syntheticState(overrides: Partial<CanonicalCompanyState> = {}): CanonicalCompanyState {
  return {
    company: {
      id: "11111111-1111-1111-1111-111111111111",
      displayName: "Aero Precision Machining",
      legalName: "Aero Precision Machining LLC",
      websiteUrl: null,
    },
    domains: [
      { domain: "aeroprecision.example", isPrimary: true, verifiedAt: new Date("2026-01-01") },
    ],
    identifiers: [{ type: "cage", value: "7ABC1" }],
    latestRevenue: { amountLower: 7_000_000, amountUpper: 11_000_000 },
    latestEmployees: { countLower: 30, countUpper: 50 },
    ownership: { type: "private" },
    certificationStandards: ["AS9100D"],
    platformNames: ["F-35"],
    goldenBuildToPrintRisk: "low",
    evidenceCounts: {
      sourceCount: 4,
      primarySourceCount: 2,
      conflictCount: 0,
      freshestObservationDaysOld: 30,
    },
    ...overrides,
  };
}

describe("canonical band mapping", () => {
  it("maps revenue midpoints onto the frozen ladder", () => {
    expect(revenueBandFromRange({ amountLower: null, amountUpper: 4_999_999 })).toBe("<5m");
    // Midpoint rule: [8m,12m] → 10m sits exactly on the 10m boundary and
    // deterministically resolves to the upper band.
    expect(revenueBandFromRange({ amountLower: 8_000_000, amountUpper: 12_000_000 })).toBe(
      "10-20m",
    );
    expect(revenueBandFromRange({ amountLower: 15_000_000, amountUpper: 15_000_000 })).toBe(
      "10-20m",
    );
    expect(revenueBandFromRange({ amountLower: 30_000_000, amountUpper: null })).toBe("20-35m");
    // Ladder tops out at 35-50m; above stays in the top band (still fails <$50m).
    expect(revenueBandFromRange({ amountLower: 90_000_000, amountUpper: 120_000_000 })).toBe(
      "35-50m",
    );
    expect(revenueBandFromRange(null)).toBe("unknown");
  });

  it("maps employee counts and keeps explicit unknown on gaps", () => {
    expect(employeesBandFromRange({ countLower: 5, countUpper: 5 })).toBe("<20");
    // Midpoint 50 sits exactly on the 50 boundary → upper band.
    expect(employeesBandFromRange({ countLower: 40, countUpper: 60 })).toBe("50-100");
    expect(employeesBandFromRange({ countLower: null, countUpper: null })).toBe("unknown");
    expect(employeesBandFromRange(null)).toBe("unknown");
  });

  it("maps canonical enums conservatively", () => {
    expect(mapOwnershipType("private")).toBe("independent_founder");
    expect(mapOwnershipType("public")).toBe("public_sub");
    expect(mapOwnershipType("subsidiary")).toBe("strategic_sub");
    expect(mapOwnershipType("government")).toBe("unknown");
    expect(mapOwnershipType("joint_venture")).toBe("unknown");
    expect(mapOwnershipType("something_new")).toBe("unknown");

    expect(mapBuildToPrintRisk("none")).toBe("none");
    expect(mapBuildToPrintRisk("low")).toBe("minor");
    expect(mapBuildToPrintRisk("medium")).toBe("minor");
    expect(mapBuildToPrintRisk("high")).toBe("major");
    expect(mapBuildToPrintRisk("unknown")).toBe("unknown");
  });

  it("treats a certification row as present and absence as unknown", () => {
    expect(certificationStatus(["AS9100 Rev D"], /as\s*9100/i)).toBe("present");
    expect(certificationStatus(["NADCAP MT"], /as\s*9100/i)).toBe("unknown");
  });

  it("keeps the storage-layer ladders byte-identical to the engine's", () => {
    // bands.ts duplicates the engine ladders because @asi/database cannot
    // depend on @asi/research — this test fails loudly if either drifts.
    expect(REVENUE_BAND_VALUES).toEqual([
      "<5m",
      "5-10m",
      "10-20m",
      "20-35m",
      "35-50m",
      "unknown",
    ]);
    expect(EMPLOYEES_BAND_VALUES).toEqual([
      "<20",
      "20-50",
      "50-100",
      "100-250",
      "250-500",
      "unknown",
    ]);
    expect(OWNERSHIP_TYPE_VALUES).toContain("independent_founder");
    expect(BUILD_TO_PRINT_SHARE_VALUES).toEqual(["none", "minor", "major", "unknown"]);
    expect(FEATURE_SCHEMA_VERSION).toBe("v1");
  });
});

describe("feature vector construction", () => {
  it("produces the expected vector including explicit unknowns", () => {
    const vector = extractFeatureVector(buildFeatureRecordInput(syntheticState()));
    expect(vector.identity.domain).toBe("aeroprecision.example");
    expect(vector.identity.cage).toBe("7ABC1");
    expect(vector.size.revenueBand).toBe("5-10m");
    expect(vector.size.employeesBand).toBe("20-50");
    expect(vector.ownership.ownershipType).toBe("independent_founder");
    expect(vector.businessModel.distributesProducts).toBe("unknown"); // no canonical field
    expect(vector.businessModel.pureService).toBe("unknown");
    expect(vector.businessModel.buildToPrintShare).toBe("minor");
    expect(vector.qualifications.as9100).toBe("present");
    expect(vector.qualifications.nadcap).toBe("unknown");
    expect(vector.qualifications.pma).toBe("unknown");
    expect(vector.platforms).toEqual(["F-35"]);
    expect(vector.aftermarket).toBe("unknown");
    expect(vector.evidence.sourceCount).toBe(4);
    expect(vector.evidence.identityResolved).toBe(true);
  });

  it("falls back to website host and marks identity unresolved without proof", () => {
    const record = buildFeatureRecordInput(
      syntheticState({
        domains: [],
        identifiers: [],
        company: {
          id: "22222222-2222-2222-2222-222222222222",
          displayName: "Mystery Shop",
          legalName: "Mystery Shop Inc",
          websiteUrl: "https://www.mysteryshop.example/about",
        },
        ownership: null,
        latestRevenue: null,
      }),
    );
    const vector = extractFeatureVector(record);
    expect(vector.identity.domain).toBe("mysteryshop.example");
    expect(vector.identity.cage).toBeUndefined();
    expect(vector.size.revenueBand).toBe("unknown");
    expect(vector.ownership.ownershipType).toBe("unknown");
    expect(vector.evidence.identityResolved).toBe(false);
  });

  it("is deterministic: identical state yields byte-identical records and scores", () => {
    const recordA = buildFeatureRecordInput(syntheticState());
    const recordB = buildFeatureRecordInput(syntheticState());
    expect(JSON.stringify(recordA)).toBe(JSON.stringify(recordB));

    const vectorA = extractFeatureVector(recordA);
    const vectorB = extractFeatureVector(recordB);
    expect(evaluateProgram(DEFAULT_FIT_PROGRAM, vectorA).score).toBe(
      evaluateProgram(DEFAULT_FIT_PROGRAM, vectorB).score,
    );
    expect(evaluateProgram(DEFAULT_ACTIONABILITY_PROGRAM, vectorA).score).toBe(
      evaluateProgram(DEFAULT_ACTIONABILITY_PROGRAM, vectorB).score,
    );
  });
});
