import { describe, expect, it } from "vitest";

import {
  isPublicAddress,
  SafeFetchError,
  safeFetchUrl,
} from "./safe-fetch.js";

async function expectSafeFetchCode(
  url: string,
  code: SafeFetchError["code"],
): Promise<void> {
  await expect(safeFetchUrl(url)).rejects.toMatchObject({
    name: "SafeFetchError",
    code,
  });
}

describe("isPublicAddress", () => {
  it("allows ordinary public unicast addresses", () => {
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("1.1.1.1")).toBe(true);
    expect(isPublicAddress("2001:4860:4860::8888")).toBe(true);
  });

  it("rejects loopback, private, link-local, CGNAT, and documentation ranges", () => {
    const blocked = [
      "0.0.0.0",
      "127.0.0.1",
      "10.0.0.1",
      "10.255.255.255",
      "172.16.0.1",
      "172.31.255.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "192.0.2.1",
      "198.51.100.1",
      "203.0.113.1",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "::1",
      "::ffff:127.0.0.1",
      "fe80::1",
      "fc00::1",
      "2001:db8::1",
    ];
    for (const address of blocked) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("rejects malformed addresses", () => {
    expect(isPublicAddress("not-an-ip")).toBe(false);
    expect(isPublicAddress("127.0.0")).toBe(false);
    expect(isPublicAddress("999.1.1.1")).toBe(false);
  });
});

describe("safeFetchUrl destination policy", () => {
  it("rejects credentials, non-http schemes, and localhost names without connecting", async () => {
    await expectSafeFetchCode("ftp://example.com/", "invalid_url");
    await expectSafeFetchCode("http://user:pass@example.com/", "invalid_url");
    await expectSafeFetchCode("http://localhost/", "blocked_destination");
    await expectSafeFetchCode("http://foo.localhost/", "blocked_destination");
    await expectSafeFetchCode("http://intranet.local/", "blocked_destination");
  });

  it("rejects literal private, loopback, and metadata addresses before connect", async () => {
    await expectSafeFetchCode("http://127.0.0.1/", "blocked_destination");
    await expectSafeFetchCode("http://10.1.2.3/", "blocked_destination");
    await expectSafeFetchCode("http://192.168.0.20/", "blocked_destination");
    await expectSafeFetchCode("http://169.254.169.254/", "blocked_destination");
    await expectSafeFetchCode("http://[::1]/", "blocked_destination");
  });
});
