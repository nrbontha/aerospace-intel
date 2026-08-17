import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  readStoredDocument,
  writeStoredDocument,
} from "./provenance.js";

const payload = new TextEncoder().encode("asi-storage-fixture");
const digest = createHash("sha256").update(payload).digest("hex");

describe("stored document bytes", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "asi-storage-"));
    vi.stubEnv("STORAGE_PATH", root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes once, verifies the digest, and is idempotent for the same bytes", async () => {
    const first = await writeStoredDocument("docs/fixture.txt", payload, digest);
    expect(first.contentSha256).toBe(digest);
    const second = await writeStoredDocument("docs/fixture.txt", payload, digest);
    expect(second.contentSha256).toBe(digest);
    const read = await readStoredDocument("docs/fixture.txt", digest);
    expect(Buffer.from(read)).toEqual(Buffer.from(payload));
  });

  it("rejects path traversal and digest mismatches without writing outside the root", async () => {
    await expect(
      writeStoredDocument("../outside.bin", payload),
    ).rejects.toThrow(/traversal/i);
    await expect(
      writeStoredDocument("docs/fixture.txt", payload, "ab".repeat(32)),
    ).rejects.toThrow(/digest mismatch/i);
    await expect(
      readStoredDocument("missing.bin", digest),
    ).rejects.toThrow();
  });
});
