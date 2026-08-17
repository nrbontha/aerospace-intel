import { describe, expect, it } from "vitest";
import {
  assertExpectedResearchRunStatus,
  mapDataSourceInput,
  mapResearchRunInput,
  mergeResearchRunInput,
  normalizePagination,
  RepositoryConflictError,
} from "./repositories.js";

describe("repository pure mappings", () => {
  it("normalizes and caps pagination", () => {
    expect(normalizePagination({})).toEqual({
      page: 1,
      pageSize: 25,
      offset: 0,
    });
    expect(normalizePagination({ page: 3, pageSize: 500 })).toEqual({
      page: 3,
      pageSize: 100,
      offset: 200,
    });
  });

  it("maps public source input without requiring a company", () => {
    expect(
      mapDataSourceInput({
        name: " Registry ",
        access: "public",
        ingestionMethod: "manual",
        description: "A source",
        homepageUrl: "https://example.com",
        metadata: {
          source_type: "registry",
          publisher: " FAA ",
          jurisdiction: 42,
        },
      }),
    ).toEqual({
      name: "Registry",
      sourceType: "registry",
      baseUrl: "https://example.com",
      access: "public",
      ingestion: "manual",
      publisher: "FAA",
      jurisdiction: null,
      notes: "A source",
    });
  });

  it("maps replayable research input and preserves replay metadata", () => {
    expect(
      mapResearchRunInput({
        targetType: "data_source",
        targetId: "source-id",
        objective: "Research",
        metadata: { trace: true },
      }),
    ).toMatchObject({
      targetType: "data_source",
      targetId: "source-id",
      promptVersion: "source-research-v1",
      input: { maxAttempts: 3, metadata: { trace: true } },
    });
    expect(
      mapResearchRunInput({
        targetType: "company",
        targetId: "company-id",
        objective: "Research a company",
      }),
    ).toMatchObject({
      targetType: "company",
      targetId: "company-id",
      promptVersion: "company-research-v1",
    });
    expect(
      mergeResearchRunInput(
        { metadata: { replay: { jobId: "one" } } },
        { replay: { attempt: 2 } },
      ),
    ).toEqual({
      metadata: { replay: { jobId: "one", attempt: 2 } },
    });
  });

  it("throws a repository conflict when compare-and-set status is stale", () => {
    expect(() => assertExpectedResearchRunStatus("running", "queued")).toThrow(
      RepositoryConflictError,
    );
    expect(() =>
      assertExpectedResearchRunStatus("queued", "queued"),
    ).not.toThrow();
  });
});
