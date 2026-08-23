/**
 * Unit tests for the blind-discovery benchmark's pure parts: seed
 * construction + identity-leak guard, and discovery verdict counting.
 */
import { describe, expect, it } from "vitest";

import {
  buildBlindSeeds,
  findIdentityLeaks,
} from "../packages/research/src/benchmarks/blind-discovery/seeds.js";
import {
  classifyDiscovery,
  leadIdentityKey,
  type AttributedLead,
} from "../packages/research/src/benchmarks/blind-discovery/verdict.js";

describe("blind seeds", () => {
  it("contains no company names or domains", () => {
    const seeds = buildBlindSeeds();
    const forbidden = [
      "Zephyr International LLC",
      "zephyrintl.com",
      "York Precision Machining & Hydraulics",
      "yorkpmh.com",
      "Hitchiner Manufacturing Co., Inc.",
      "hitchiner.com",
    ];
    expect(findIdentityLeaks(seeds, forbidden)).toEqual([]);
  });
  it("flags a leak when a seed embeds an identity phrase", () => {
    const bad = buildBlindSeeds();
    const leaky: typeof bad = {
      ...bad,
      capabilities: [
        ...bad.capabilities,
        "precision machining for Zephyr International programs",
      ],
    };
    const leaks = findIdentityLeaks(leaky, ["zephyr international llc"]);
    expect(leaks.length).toBeGreaterThan(0);
    expect(leaks[0]?.leakedToken).toBe("zephyr international");
  });

  it("does not flag shared single industry nouns", () => {
    const seeds = buildBlindSeeds();
    // "Minnesota Wire" / "American Metal Bearing" share only single generic
    // nouns with the capability seeds — that is not targeting.
    expect(findIdentityLeaks(seeds, ["Minnesota Wire", "American Metal Bearing (AMB)"])).toEqual([]);
  });

  it("flags a single-word identity used verbatim", () => {
    const bad = buildBlindSeeds();
    const leaky: typeof bad = {
      ...bad,
      capabilities: [...bad.capabilities, "precision machining for Zephyr"],
    };
    const leaks = findIdentityLeaks(leaky, ["Zephyr"]);
    expect(leaks.length).toBeGreaterThan(0);
    expect(leaks[0]?.leakedToken).toBe("zephyr");
  });
  it("always includes the usaspending source (only keyless adapter)", () => {
    const seeds = buildBlindSeeds();
    expect(seeds.sources).toEqual(["usaspending"]);
  });
});

describe("leadIdentityKey", () => {
  it("normalizes case and whitespace", () => {
    expect(leadIdentityKey("  ACME   AERO, INC. ", null)).toBe(
      leadIdentityKey("acme aero, inc.", null),
    );
  });

  it("distinguishes on domain", () => {
    expect(leadIdentityKey("Acme", "acme.com")).not.toBe(leadIdentityKey("Acme", null));
  });
});

describe("classifyDiscovery", () => {
  const prior = new Set(["xometry, inc.|", "zenith aviation, inc.|"]);

  function lead(partial: Partial<AttributedLead> & { rawName: string }): AttributedLead {
    return {
      domain: null,
      matchedCompanyId: null,
      matchKind: null,
      matchedMemberKey: null,
      ...partial,
    };
  }

  it("counts rediscoveries, novel leads, and cross-campaign duplicates", () => {
    const leads: AttributedLead[] = [
      lead({ rawName: "YORK PRECISION MACHINING AND HYDRAULICS, LLC", matchedCompanyId: "c-york", matchKind: "exact" }),
      lead({ rawName: "Servotronics Inc.", matchedMemberKey: "Golden Set v01:s1" }),
      lead({ rawName: "Brand New Widget Works LLC" }),
      lead({ rawName: "XOMETRY, INC." }), // duplicate of prior campaign
      lead({ rawName: "Zenith Aviation, Inc.", matchedCompanyId: "c-zenith-probable", matchKind: "probable" }),
    ];
    const verdict = classifyDiscovery(leads, prior);
    expect(verdict.producedLeads).toBe(5);
    expect(verdict.knownRediscoveries).toBe(3);
    expect(verdict.rediscoveredCompanies).toBe(2);
    expect(verdict.rediscoveredMembers).toBe(1);
    expect(verdict.novelLeads).toBe(2);
    expect(verdict.duplicatesOfPriorCampaigns).toBe(2);
    expect(verdict.duplicateRate).toBeCloseTo(0.4);
  });

  it("handles empty production gracefully", () => {
    const verdict = classifyDiscovery([], prior);
    expect(verdict.producedLeads).toBe(0);
    expect(verdict.knownRediscoveries).toBe(0);
    expect(verdict.duplicateRate).toBeNull();
  });

  it("never counts member attribution as a company rediscovery", () => {
    const verdict = classifyDiscovery(
      [lead({ rawName: "ValveTech", matchedMemberKey: "Pipeline v01:m1" })],
      new Set(),
    );
    expect(verdict.rediscoveredMembers).toBe(1);
    expect(verdict.rediscoveredCompanies).toBe(0);
  });
});
