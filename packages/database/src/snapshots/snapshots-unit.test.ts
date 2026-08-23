import { describe, expect, it } from "vitest";

import { resolveSnapshotAction } from "./create-snapshot.js";
import {
  memberIdentityKey,
  parseUsStateCode,
  sha256Hex,
} from "./normalize.js";
import { normalizeDomain, normalizeLegalName } from "../provenance.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

describe("snapshot identity normalization", () => {
  it("normalizes bare domains, URLs, www prefixes, ports, and case", () => {
    expect(normalizeDomain("adpma.com")).toBe("adpma.com");
    expect(normalizeDomain("HTTPS://IAQG.org/tools/oasis/")).toBe("iaqg.org");
    expect(normalizeDomain("www.skybolt.com")).toBe("skybolt.com");
    expect(normalizeDomain("example.com:8080/path?x=1#y")).toBe("example.com");
    expect(normalizeDomain("  JetPartsEngineering.COM  ")).toBe(
      "jetpartsengineering.com",
    );
    expect(normalizeDomain("https://user@example.com")).toBe("example.com");
    // Canonical provenance behavior: scheme-less junk like "n/a" parses to
    // its leading token — callers only pass real Domain-column strings.
    expect(normalizeDomain("n/a")).toBe("n");
  });

  it("returns null for blank domain cells", () => {
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain("   ")).toBeNull();
  });

  it("normalizes company names conservatively", () => {
    expect(normalizeLegalName("ADPma, LLC")).toBe("adpma, llc");
    expect(normalizeLegalName("  Jay- Em   Aerospace Corporation ")).toBe(
      "jay- em aerospace corporation",
    );
  });
});

describe("parseUsStateCode", () => {
  it('extracts the state from "USA - TN" style HQ text', () => {
    expect(parseUsStateCode("USA - TN")).toBe("TN");
    expect(parseUsStateCode("USA-CA")).toBe("CA");
    expect(parseUsStateCode("United States - NY")).toBe("NY");
    expect(parseUsStateCode("USA - OR")).toBe("OR");
  });

  it("returns null when no two-letter code is present", () => {
    expect(parseUsStateCode(null)).toBeNull();
    expect(parseUsStateCode("")).toBeNull();
    expect(parseUsStateCode("Germany")).toBeNull();
  });
});

describe("memberIdentityKey", () => {
  it("prefers domain+name and falls back to name only", () => {
    expect(memberIdentityKey("acmt-usa.com", "acmt")).toBe(
      "d:acmt-usa.com|n:acmt",
    );
    expect(memberIdentityKey(null, "aero-glide")).toBe("n:aero-glide");
  });
});

describe("sha256Hex", () => {
  it("hashes bytes deterministically as hex", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(sha256Hex(bytes)).toMatch(/^[a-f0-9]{64}$/);
    expect(sha256Hex(bytes)).toBe(sha256Hex(new Uint8Array([1, 2, 3])));
    expect(sha256Hex(bytes)).not.toBe(sha256Hex(new Uint8Array([1, 2, 4])));
  });
});

describe("resolveSnapshotAction (key idempotency)", () => {
  it("creates when no snapshot exists for the key", () => {
    expect(resolveSnapshotAction(undefined, SHA_A)).toBe("create");
  });

  it("skips when the stored sha matches the incoming sha", () => {
    expect(resolveSnapshotAction({ contentSha256: SHA_A }, SHA_A)).toBe("skip");
  });

  it("trims CHAR(64) padding before comparing", () => {
    expect(resolveSnapshotAction({ contentSha256: ` ${SHA_A} ` }, SHA_A)).toBe(
      "skip",
    );
    expect(resolveSnapshotAction({ contentSha256: SHA_A }, `  ${SHA_A}\n`)).toBe(
      "skip",
    );
  });

  it("conflicts on same key with a different sha", () => {
    expect(resolveSnapshotAction({ contentSha256: SHA_B }, SHA_A)).toBe(
      "conflict",
    );
    expect(resolveSnapshotAction({ contentSha256: null }, SHA_A)).toBe(
      "conflict",
    );
  });
});
