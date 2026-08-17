import { describe, expect, it } from "vitest";

import { buildOperationsAlerts, diffStoredDocuments } from "./ops.js";

describe("storage reconciliation", () => {
  it("keeps matching digest-backed documents quiet", () => {
    expect(
      diffStoredDocuments({
        documents: [
          {
            id: "doc-1",
            storageKey: "sha256/abc",
            contentSha256: "aa".repeat(32),
            byteLength: 4,
          },
        ],
        files: [
          {
            storageKey: "/sha256/abc",
            sha256: "AA".repeat(32),
            byteLength: 4,
          },
        ],
      }).findings,
    ).toEqual([]);
  });

  it("reports missing files, orphans, digest and size mismatches", () => {
    const result = diffStoredDocuments({
      documents: [
        {
          id: "missing",
          storageKey: "gone.bin",
          contentSha256: "11".repeat(32),
          byteLength: 2,
        },
        {
          id: "mismatch",
          storageKey: "changed.bin",
          contentSha256: "22".repeat(32),
          byteLength: 8,
        },
      ],
      files: [
        {
          storageKey: "changed.bin",
          sha256: "33".repeat(32),
          byteLength: 9,
        },
        {
          storageKey: "orphan.bin",
          sha256: "44".repeat(32),
          byteLength: 1,
        },
      ],
    });
    expect(result.documentCount).toBe(2);
    expect(result.fileCount).toBe(2);
    expect(result.findings.map((finding) => finding.kind).sort()).toEqual([
      "digest_mismatch",
      "missing_file",
      "orphan_file",
      "size_mismatch",
    ]);
  });
});

describe("operations alerts", () => {
  const quietQueue = {
    created: 0,
    retry: 0,
    active: 0,
    completed: 4,
    cancelled: 0,
    failed: 0,
  };

  it("stays quiet when the queue is drainable and storage matches", () => {
    expect(
      buildOperationsAlerts({
        queue: quietQueue,
        drainable: true,
        storage: { documentCount: 1, fileCount: 1, findings: [] },
      }),
    ).toEqual([]);
  });

  it("raises failed jobs and storage findings without exposing bytes", () => {
    const alerts = buildOperationsAlerts({
      queue: { ...quietQueue, failed: 2, active: 1 },
      drainable: false,
      storage: {
        documentCount: 2,
        fileCount: 2,
        findings: [
          { kind: "missing_file", storageKey: "gone.bin" },
          { kind: "orphan_file", storageKey: "extra.bin" },
        ],
      },
    });
    expect(alerts.map((alert) => alert.code)).toEqual([
      "queue_failed",
      "queue_not_drainable",
      "storage_inconsistent",
      "storage_orphans",
    ]);
  });
});
