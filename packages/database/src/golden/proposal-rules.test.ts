import { describe, expect, it } from "vitest";

import { proposeLabels } from "./proposal-rules.js";

describe("proposeLabels — RULES ONLY", () => {
  it("flags Public Subsidiary ownership as ideal archetype but unactionable", () => {
    const labels = proposeLabels({
      ownership: "Public Subsidiary",
      ownerName: "TransDigm Group Incorporated",
    });
    expect(labels.goldenExampleType).toBe("ideal_archetype_but_unactionable");
    expect(labels.currentActionability).toBe("negative");
    expect(labels.ownershipFit).toBe("negative");
    // Rationale cites the public ownership.
    expect(labels.rationale).toMatch(/public/i);
    expect(labels.rationale).toContain("TransDigm Group Incorporated");
  });

  it("matches Public Subsidiary case-insensitively and without an owner", () => {
    const labels = proposeLabels({ ownership: "PUBLIC SUBSIDIARY" });
    expect(labels.goldenExampleType).toBe("ideal_archetype_but_unactionable");
    expect(labels.rationale).toMatch(/public/i);
  });

  it.each(["Private Equity Add-On", "Investor Backed"] as const)(
    "labels %s as positive with a sponsor caveat",
    (ownership) => {
      const labels = proposeLabels({ ownership });
      expect(labels.goldenExampleType).toBe("positive_with_caveat");
      expect(labels.currentActionability).toBe("neutral");
      expect(labels.ownershipFit).toBe("neutral");
      expect(labels.rationale).toMatch(/sponsor/i);
    },
  );

  it.each([
    "Bootstrapped",
    "Private",
    null,
  ])("labels %s ownership as strong positive", (ownership) => {
    const labels = proposeLabels({ ownership });
    expect(labels.goldenExampleType).toBe("strong_positive");
    expect(labels.currentActionability).toBe("positive");
    expect(labels.ownershipFit).toBe("positive");
  });

  it("never invents build-to-print risk", () => {
    for (const ownership of [
      "Public Subsidiary",
      "Private Equity Add-On",
      "Investor Backed",
      "Bootstrapped",
      null,
    ]) {
      expect(proposeLabels({ ownership }).buildToPrintRisk).toBe("unknown");
    }
  });

  it("keeps every label inside the contract enums", () => {
    const validTypes = new Set([
      "strong_positive",
      "positive_with_caveat",
      "borderline",
      "negative_business_model",
      "ideal_archetype_but_unactionable",
      "known_non_target",
      "unclassified",
    ]);
    const validScale = new Set([
      "strong_positive",
      "positive",
      "neutral",
      "negative",
      "unknown",
    ]);
    for (const ownership of [
      "Public Subsidiary",
      "Private Subsidiary",
      "Investor Backed",
      "Private Equity Add-On",
      "Bootstrapped",
      null,
    ]) {
      const labels = proposeLabels({ ownership });
      expect(validTypes.has(labels.goldenExampleType)).toBe(true);
      expect(validScale.has(labels.archetypeFit)).toBe(true);
      expect(validScale.has(labels.currentActionability)).toBe(true);
      expect(validScale.has(labels.businessModelFit)).toBe(true);
      expect(validScale.has(labels.ownershipFit)).toBe(true);
    }
  });

  it("reproduces the real workbook split: 4 public subs, 3 sponsor-backed, 11 strong positive", () => {
    // Ownership values exactly as they appear in the ADCO workbook's
    // standardized Grata 'Ownership' column, in sheet order.
    const workbookOwnership = [
      "Investor Backed", // ADPma, LLC
      "Bootstrapped", // Armstrong
      "Private Equity Add-On", // Fiber Dynamics
      "Private Subsidiary", // Tempest Aero
      "Bootstrapped", // Jay-Em
      "Bootstrapped", // Aerospace Manufacturing
      "Bootstrapped", // Skybolt
      "Bootstrapped", // ACMT
      "Bootstrapped", // The PDI Group
      "Bootstrapped", // Skylock
      "Investor Backed", // DAC Engineered Products
      "Bootstrapped", // McNeil
      "Bootstrapped", // Romco
      "Bootstrapped", // Cole Instrument
      "Public Subsidiary", // Rosen Aviation
      "Public Subsidiary", // Jet Parts Engineering
      "Public Subsidiary", // Southwest Antennas
      "Public Subsidiary", // Servotronics
    ];
    const counts: Record<string, number> = {};
    for (const ownership of workbookOwnership) {
      const type = proposeLabels({ ownership }).goldenExampleType;
      counts[type] = (counts[type] ?? 0) + 1;
    }
    expect(counts).toEqual({
      ideal_archetype_but_unactionable: 4,
      positive_with_caveat: 3,
      strong_positive: 11,
    });
  });
});
