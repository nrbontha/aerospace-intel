import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";

const MAX_REDIRECTS = 3;
const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const ALLOWED_TYPES: Record<string, true> = {
  "text/html": true,
  "text/plain": true,
  "application/json": true,
};

export type SafeFetchErrorCode =
  | "invalid_url"
  | "blocked_destination"
  | "dns_failed"
  | "timeout"
  | "cancelled"
  | "too_many_redirects"
  | "http_error"
  | "unsupported_content_type"
  | "content_too_large"
  | "network_error";
export class SafeFetchError extends Error {
  constructor(readonly code: SafeFetchErrorCode) {
    super(
      {
        invalid_url: "Only credential-free HTTP(S) URLs are permitted",
        blocked_destination: "The URL destination is not publicly routable",
        dns_failed: "The URL destination could not be resolved safely",
        timeout: "URL retrieval timed out",
        cancelled: "URL retrieval was cancelled",
        too_many_redirects: "URL retrieval exceeded the redirect limit",
        http_error: "URL retrieval returned an unsuccessful response",
        unsupported_content_type: "URL response content type is not permitted",
        content_too_large: "URL response exceeded the byte limit",
        network_error: "URL retrieval failed",
      }[code],
    );
    this.name = "SafeFetchError";
  }
}
export interface SafeFetchHop {
  readonly url: string;
  readonly status: number;
  readonly resolvedAddresses: readonly string[];
}
export interface SafeFetchResult {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly contentType: "text/html" | "text/plain" | "application/json";
  readonly content: string;
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly retrievedAt: string;
  readonly durationMs: number;
  readonly redirects: readonly SafeFetchHop[];
}

export async function safeFetchUrl(
  url: string,
  options: {
    readonly signal?: AbortSignal;
    /** Override the default ASI-Research UA (browser-like fetches for WAF'd sites). */
    readonly userAgent?: string;
    /** Override the default Accept header value. */
    readonly accept?: string;
  } = {},
): Promise<SafeFetchResult> {
  const started = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TIMEOUT_MS);
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const requested = parseUrl(url);
    let current = requested;
    const redirects: SafeFetchHop[] = [];
    for (
      let redirectCount = 0;
      redirectCount <= MAX_REDIRECTS;
      redirectCount += 1
    ) {
      const addresses = await resolvePublic(current, controller.signal);
      const response = await makeRequest(current, addresses, controller.signal, options);
      if (isRedirect(response.statusCode)) {
        const location = response.headers.location;
        response.resume();
        if (location === undefined) throw new SafeFetchError("http_error");
        if (redirectCount === MAX_REDIRECTS)
          throw new SafeFetchError("too_many_redirects");
        redirects.push({
          url: current.toString(),
          status: response.statusCode ?? 0,
          resolvedAddresses: addresses.map(({ address }) => address),
        });
        current = parseUrl(new URL(location, current).toString());
        continue;
      }
      if (
        (response.statusCode ?? 0) < 200 ||
        (response.statusCode ?? 0) >= 300
      ) {
        response.resume();
        throw new SafeFetchError("http_error");
      }
      const type = normalizeContentType(response.headers["content-type"]);
      if (type === null) {
        response.resume();
        throw new SafeFetchError("unsupported_content_type");
      }
      const declaredLength = Number(response.headers["content-length"]);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) {
        response.destroy();
        throw new SafeFetchError("content_too_large");
      }
      const body = await readBody(response);
      return {
        requestedUrl: requested.toString(),
        finalUrl: current.toString(),
        contentType: type,
        content: body.toString("utf8"),
        byteLength: body.byteLength,
        contentSha256: createHash("sha256").update(body).digest("hex"),
        retrievedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        redirects,
      };
    }
    throw new SafeFetchError("too_many_redirects");
  } catch (error) {
    if (options.signal?.aborted === true) throw new SafeFetchError("cancelled");
    if (timedOut) throw new SafeFetchError("timeout");
    if (error instanceof SafeFetchError) throw error;
    throw new SafeFetchError("network_error");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

function parseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SafeFetchError("invalid_url");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.hostname.length === 0
  )
    throw new SafeFetchError("invalid_url");
  const hostname = bareHostname(url.hostname).toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  )
    throw new SafeFetchError("blocked_destination");
  return url;
}

async function resolvePublic(
  url: URL,
  signal: AbortSignal,
): Promise<readonly { address: string; family: 4 | 6 }[]> {
  const hostname = bareHostname(url.hostname);
  const literalFamily = isIP(hostname);
  let addresses: readonly { address: string; family: 4 | 6 }[];
  if (literalFamily !== 0)
    addresses = [{ address: hostname, family: literalFamily as 4 | 6 }];
  else {
    try {
      addresses = (await abortable(
        lookup(hostname, { all: true, verbatim: true }),
        signal,
      )) as readonly { address: string; family: 4 | 6 }[];
    } catch (error) {
      if (signal.aborted) throw error;
      throw new SafeFetchError("dns_failed");
    }
  }
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !isPublicAddress(address))
  )
    throw new SafeFetchError("blocked_destination");
  return addresses;
}

function makeRequest(
  url: URL,
  addresses: readonly { address: string; family: 4 | 6 }[],
  signal: AbortSignal,
  options: { readonly userAgent?: string; readonly accept?: string } = {},
): Promise<IncomingMessage> {
  const selected = addresses[0];
  if (selected === undefined) throw new SafeFetchError("dns_failed");
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all)
      callback(
        null,
        addresses.map(({ address, family }) => ({ address, family })),
      );
    else callback(null, selected.address, selected.family);
  };
  const { promise, resolve, reject } = Promise.withResolvers<IncomingMessage>();
  const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
  const req = requester(
    url,
    {
      method: "GET",
      lookup: pinnedLookup,
      signal,
      headers: {
        accept: options.accept ?? "text/html, text/plain, application/json",
        "user-agent": options.userAgent ?? "ASI-Research/1.0",
      },
    },
    resolve,
  );
  req.on("error", reject);
  req.end();
  return promise;
}

async function readBody(response: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const rawChunk of response) {
    const chunk = Buffer.isBuffer(rawChunk)
      ? rawChunk
      : Buffer.from(rawChunk as Uint8Array);
    length += chunk.byteLength;
    if (length > MAX_BYTES) {
      response.destroy();
      throw new SafeFetchError("content_too_large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

function normalizeContentType(
  value: string | string[] | undefined,
): SafeFetchResult["contentType"] | null {
  if (typeof value !== "string") return null;
  const type = value.split(";", 1)[0]?.trim().toLowerCase();
  return type !== undefined && ALLOWED_TYPES[type] === true
    ? (type as SafeFetchResult["contentType"])
    : null;
}
function isRedirect(status: number | undefined): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}
function bareHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}
function isPublicIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return false;
  const value =
    ((parts[0] ?? 0) * 2 ** 24 +
      ((parts[1] ?? 0) << 16) +
      ((parts[2] ?? 0) << 8) +
      (parts[3] ?? 0)) >>>
    0;
  return ![
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ].some(([network, prefix]) =>
    inIpv4Range(value, ipv4Number(network as string), prefix as number),
  );
}
function ipv4Number(address: string): number {
  const parts = address.split(".").map(Number);
  return (
    ((((parts[0] ?? 0) << 24) >>> 0) +
      ((parts[1] ?? 0) << 16) +
      ((parts[2] ?? 0) << 8) +
      (parts[3] ?? 0)) >>>
    0
  );
}
function inIpv4Range(value: number, network: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (network & mask);
}

function isPublicIpv6(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(address);
  if (mapped?.[1] !== undefined) return isPublicIpv4(mapped[1]);
  const value = ipv6Number(address);
  if (value === null) return false;
  const blocked: readonly [string, number][] = [
    ["::", 96],
    ["::ffff:0:0", 96],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8],
  ];
  return !blocked.some(([network, prefix]) => {
    const base = ipv6Number(network);
    return base === null || inIpv6Range(value, base, prefix);
  });
}
function ipv6Number(address: string): bigint | null {
  let source = address.toLowerCase();
  const ipv4Tail = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/u.exec(source)?.[1];
  if (ipv4Tail !== undefined) {
    const number = ipv4Number(ipv4Tail);
    source =
      source.slice(0, source.length - ipv4Tail.length) +
      `${((number >>> 16) & 0xffff).toString(16)}:${(number & 0xffff).toString(16)}`;
  }
  const halves = source.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] === "" ? [] : (halves[0]?.split(":") ?? []);
  const right =
    halves.length === 1 || halves[1] === ""
      ? []
      : (halves[1]?.split(":") ?? []);
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ];
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))
  )
    return null;
  return groups.reduce(
    (total, group) => (total << 16n) | BigInt(`0x${group}`),
    0n,
  );
}
function inIpv6Range(value: bigint, network: bigint, prefix: number): boolean {
  const shift = BigInt(128 - prefix);
  return value >> shift === network >> shift;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new SafeFetchError("cancelled"));
  const { promise: result, resolve, reject } = Promise.withResolvers<T>();
  const abort = () => reject(new SafeFetchError("cancelled"));
  signal.addEventListener("abort", abort, { once: true });
  promise
    .then(resolve, reject)
    .finally(() => signal.removeEventListener("abort", abort));
  return result;
}
