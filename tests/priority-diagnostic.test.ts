/**
 * Unit suite for the Priority held-out diagnostic math
 * (packages/research/src/scoring-axial/diagnostics.ts). Pure functions,
 * no database required.
 */
import { describe, expect, it } from "vitest";

import {
  parsePriorityOrdinal,
  priorityDiagnostic,
  spearmanRankCorrelation,
  type PriorityDiagnosticEntry,
} from "../packages/research/src/scoring-axial/diagnostics.js";

function entry(
  companyId: string,
  priorityRaw: string | null,
  fitScore: number,
  stage?: string,
): PriorityDiagnosticEntry {
  return stage === undefined
    ? { companyId, priorityRaw, fitScore }
    : { companyId, priorityRaw, fitScore, stage };
}

describe("parsePriorityOrdinal", () => {
  it("parses verbatim workbook priorities 1..3", () => {
    expect(parsePriorityOrdinal("1")).toBe(1);
    expect(parsePriorityOrdinal("2")).toBe(2);
    expect(parsePriorityOrdinal("3")).toBe(3);
    expect(parsePriorityOrdinal(" 2 ")).toBe(2);
  });

  it("rejects null and unparsable text", () => {
    expect(parsePriorityOrdinal(null)).toBeNull();
    expect(parsePriorityOrdinal("")).toBeNull();
    expect(parsePriorityOrdinal("high")).toBeNull();
    expect(parsePriorityOrdinal("4")).toBeNull();
  });
});

describe("spearmanRankCorrelation", () => {
  it("returns ~1 for perfect monotone agreement", () => {
    const value = spearmanRankCorrelation([1, 2, 3, 4], [10, 20, 30, 40]);
    expect(value).not.toBeNull();
    expect(value!).toBeCloseTo(1, 10);
  });

  it("returns ~-1 for perfect anti-monotone ordering", () => {
    const value = spearmanRankCorrelation([1, 2, 3, 4], [40, 30, 20, 10]);
    expect(value).not.toBeNull();
    expect(value!).toBeCloseTo(-1, 10);
  });

  it("handles ties by average ranks", () => {
    // x-ranks become [1, 2.5, 2.5, 4]; ρ against y-ranks [1,2,3,4] is √0.9.
    const value = spearmanRankCorrelation([1, 2, 2, 3], [5, 6, 7, 8]);
    expect(value).not.toBeNull();
    expect(value!).toBeCloseTo(Math.sqrt(0.9), 10);
  });

  it("is degenerate (null) when a sample has zero variance", () => {
    expect(spearmanRankCorrelation([2, 2, 2], [1, 2, 3])).toBeNull();
    expect(spearmanRankCorrelation([], [])).toBeNull();
  });
});

describe("priorityDiagnostic", () => {
  it("reports +1 when fit scores rise with the Priority value (1<2<3)", () => {
    const result = priorityDiagnostic([
      entry("a", "1", 20),
      entry("b", "2", 60),
      entry("c", "3", 90),
    ]);
    expect(result.n).toBe(3);
    expect(result.spearman).toBeCloseTo(1, 10);
    expect(result.note).toBe(
      "diagnostic-only; Priority never used as feature or label",
    );
    expect(result.stages).toBeUndefined();
  });

  it("reports -1 when fit scores fall as the Priority value rises", () => {
    const result = priorityDiagnostic([
      entry("a", "1", 95),
      entry("b", "2", 50),
      entry("c", "3", 10),
    ]);
    expect(result.spearman).toBeCloseTo(-1, 10);
  });
  it("hovers near zero for unrelated orderings", () => {
    const result = priorityDiagnostic([
      entry("a", "1", 50),
      entry("b", "2", 90),
      entry("c", "3", 10),
    ]);
    expect(Math.abs(result.spearman ?? 0)).toBeLessThan(0.6);
  });

  it("counts ONLY companies with parsable priority AND finite score", () => {
    const result = priorityDiagnostic([
      entry("a", "1", 80),
      entry("b", null, 70), // no priority → excluded
      entry("c", "high", 60), // unparsable → excluded
      entry("d", "2", Number.NaN), // unscoreable → excluded
      entry("e", "3", 10),
    ]);
    expect(result.n).toBe(2);
    expect(result.spearman).toBeCloseTo(-1, 10);
  });

  it("produces a per-stage breakdown when stages are provided", () => {
    const result = priorityDiagnostic([
      entry("a", "1", 90, "IOI"),
      entry("b", "2", 60, "IOI"),
      entry("c", "1", 10, "NDA"),
      entry("d", "2", 80, "NDA"),
    ]);
    expect(result.stages).toHaveLength(2);
    const ioi = result.stages?.find((stage) => stage.stage === "IOI");
    const nda = result.stages?.find((stage) => stage.stage === "NDA");
    expect(ioi?.spearman).toBeCloseTo(-1, 10);
    expect(nda?.spearman).toBeCloseTo(1, 10);
  });

  it("stays honest (n=0, spearman=null) on empty input", () => {
    const result = priorityDiagnostic([]);
    expect(result.n).toBe(0);
    expect(result.spearman).toBeNull();
  });
});
