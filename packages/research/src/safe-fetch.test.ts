import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  ClientRequest,
  IncomingHttpHeaders,
  IncomingMessage,
  RequestOptions,
} from "node:http";
import { Readable } from "node:stream";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  isPublicAddress,
  isRetryableSafeFetchError,
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

function incomingResponse(
  status: number,
  headers: IncomingHttpHeaders = {},
  body: Buffer | readonly Buffer[] = Buffer.alloc(0),
): IncomingMessage {
  const chunks = Buffer.isBuffer(body) ? [body] : body;
  const response = Readable.from(chunks) as unknown as IncomingMessage;
  response.statusCode = status;
  response.headers = headers;
  return response;
}

function requestForResponse(
  status: number,
  headers: IncomingHttpHeaders = {},
  body: Buffer | readonly Buffer[] = Buffer.alloc(0),
): (
  url: URL,
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest {
  return (_url, _options, callback) => {
    const request = new EventEmitter() as EventEmitter & { end: () => void };
    request.end = () => callback(incomingResponse(status, headers, body));
    return request as unknown as ClientRequest;
  };
}

describe("safe fetch error retryability", () => {
  it.each([
    { status: 400, retryable: false },
    { status: 404, retryable: false },
    { status: 408, retryable: true },
    { status: 429, retryable: true },
    { status: 503, retryable: true },
  ])(
    "retains HTTP $status and classifies its retry boundary",
    async ({ status, retryable }) => {
      const error: unknown = await safeFetchUrl("http://8.8.8.8/", {
        request: requestForResponse(status),
      }).then(
        () => new Error("Expected safeFetchUrl to reject"),
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(SafeFetchError);
      expect(error).toMatchObject({ code: "http_error", status });
      expect(isRetryableSafeFetchError(error)).toBe(retryable);
    },
  );

  it("retains the response status for a redirect without a location", async () => {
    const error: unknown = await safeFetchUrl("http://8.8.8.8/", {
      request: requestForResponse(302),
    }).then(
      () => new Error("Expected safeFetchUrl to reject"),
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(SafeFetchError);
    expect(error).toMatchObject({ code: "http_error", status: 302 });
    expect(isRetryableSafeFetchError(error)).toBe(false);
  });

  it("retries transient transport failures but not destination or response policy failures", () => {
    expect(isRetryableSafeFetchError(new Error("socket reset"))).toBe(true);
    expect(isRetryableSafeFetchError(new SafeFetchError("dns_failed"))).toBe(
      true,
    );
    expect(isRetryableSafeFetchError(new SafeFetchError("timeout"))).toBe(true);
    expect(
      isRetryableSafeFetchError(new SafeFetchError("blocked_destination")),
    ).toBe(false);
    expect(
      isRetryableSafeFetchError(new SafeFetchError("too_many_redirects")),
    ).toBe(false);
    expect(
      isRetryableSafeFetchError(new SafeFetchError("unsupported_content_type")),
    ).toBe(false);
    expect(
      isRetryableSafeFetchError(
        new SafeFetchError("unsupported_content_encoding"),
      ),
    ).toBe(false);
    expect(
      isRetryableSafeFetchError(new SafeFetchError("invalid_content")),
    ).toBe(false);
  });
});

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

describe("safeFetchUrl transport decoding", () => {
  const html = "<!doctype html><html><body>Compressed café</body></html>";
  const decodedBytes = Buffer.from(html, "utf8");

  it.each([
    ["gzip", gzipSync],
    ["deflate", deflateSync],
    ["br", brotliCompressSync],
  ] as const)(
    "decodes %s HTML and reports decoded entity byte semantics",
    async (encoding, compress) => {
      const result = await safeFetchUrl("http://8.8.8.8/page", {
        request: requestForResponse(
          200,
          {
            "content-type": "text/html; charset=utf-8",
            "content-encoding": encoding,
          },
          compress(decodedBytes),
        ),
      });

      expect(result.content).toBe(html);
      expect(result.byteLength).toBe(decodedBytes.byteLength);
      expect(result.contentSha256).toBe(
        createHash("sha256").update(decodedBytes).digest("hex"),
      );
    },
  );

  it("fails closed on malformed compressed content", async () => {
    await expect(
      safeFetchUrl("http://8.8.8.8/", {
        request: requestForResponse(
          200,
          {
            "content-type": "text/html",
            "content-encoding": "gzip",
          },
          Buffer.from("<html>not gzipped</html>"),
        ),
      }),
    ).rejects.toMatchObject({
      name: "SafeFetchError",
      code: "invalid_content",
    });
  });

  it("fails closed on an unsupported content encoding", async () => {
    await expect(
      safeFetchUrl("http://8.8.8.8/", {
        request: requestForResponse(200, {
          "content-type": "text/html",
          "content-encoding": "compress",
        }),
      }),
    ).rejects.toMatchObject({
      name: "SafeFetchError",
      code: "unsupported_content_encoding",
    });
  });

  it("rejects a decoded entity that exceeds the byte limit", async () => {
    const compressed = gzipSync(Buffer.alloc(5 * 1024 * 1024 + 1, "a"));

    await expect(
      safeFetchUrl("http://8.8.8.8/", {
        request: requestForResponse(
          200,
          {
            "content-type": "text/plain",
            "content-encoding": "gzip",
          },
          compressed,
        ),
      }),
    ).rejects.toMatchObject({
      name: "SafeFetchError",
      code: "content_too_large",
    });
  });

  it("still rejects a wire entity that exceeds the byte limit", async () => {
    const chunk = Buffer.alloc(64 * 1024, "a");
    const chunks = Array<Buffer>(81).fill(chunk);

    await expect(
      safeFetchUrl("http://8.8.8.8/", {
        request: requestForResponse(
          200,
          { "content-type": "text/plain" },
          chunks,
        ),
      }),
    ).rejects.toMatchObject({
      name: "SafeFetchError",
      code: "content_too_large",
    });
  });

  it.each([
    ["NUL bytes", Buffer.from("<html>\0</html>")],
    ["malformed UTF-8", Buffer.from([0xc3, 0x28])],
  ])("rejects nontext content containing %s", async (_description, body) => {
    await expect(
      safeFetchUrl("http://8.8.8.8/", {
        request: requestForResponse(200, { "content-type": "text/html" }, body),
      }),
    ).rejects.toMatchObject({
      name: "SafeFetchError",
      code: "invalid_content",
    });
  });
});
