"use client";

type CsrfConfiguration = Readonly<{
  cookieName: string;
  headerName: string;
}>;

type ApiErrorPayload = Readonly<{
  error?: Readonly<{
    message?: unknown;
  }>;
}>;

let csrfConfigurationRequest: Promise<CsrfConfiguration> | undefined;

export class ApiRequestError extends Error {
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

function apiErrorMessage(payload: unknown, status: number): string {
  if (typeof payload === "object" && payload !== null && "error" in payload) {
    const error = (payload as ApiErrorPayload).error;
    if (typeof error?.message === "string" && error.message.trim() !== "") {
      return error.message;
    }
  }

  return status === 0
    ? "The server returned an unreadable response."
    : `Request failed (${status}).`;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ApiRequestError(
      "The server returned an unreadable response.",
      response.status,
    );
  }
}

async function loadCsrfConfiguration(): Promise<CsrfConfiguration> {
  const response = await fetch("/api/v1/auth/me", {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  const payload = await readJson(response);

  if (!response.ok) {
    throw new ApiRequestError(
      apiErrorMessage(payload, response.status),
      response.status,
    );
  }

  if (
    typeof payload !== "object" ||
    payload === null ||
    !("data" in payload) ||
    typeof payload.data !== "object" ||
    payload.data === null ||
    !("csrf" in payload.data) ||
    typeof payload.data.csrf !== "object" ||
    payload.data.csrf === null ||
    !("cookieName" in payload.data.csrf) ||
    !("headerName" in payload.data.csrf) ||
    typeof payload.data.csrf.cookieName !== "string" ||
    typeof payload.data.csrf.headerName !== "string" ||
    payload.data.csrf.cookieName === "" ||
    payload.data.csrf.headerName === ""
  ) {
    throw new ApiRequestError(
      "The server returned invalid CSRF configuration.",
    );
  }

  return {
    cookieName: payload.data.csrf.cookieName,
    headerName: payload.data.csrf.headerName,
  };
}

function getCsrfConfiguration(): Promise<CsrfConfiguration> {
  csrfConfigurationRequest ??= loadCsrfConfiguration().catch(
    (error: unknown) => {
      csrfConfigurationRequest = undefined;
      throw error;
    },
  );
  return csrfConfigurationRequest;
}

function readCookie(name: string): string | undefined {
  for (const pair of document.cookie.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;

    try {
      const cookieName = decodeURIComponent(pair.slice(0, separator).trim());
      if (cookieName === name) {
        return decodeURIComponent(pair.slice(separator + 1));
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method !== undefined) return init.method.toUpperCase();
  if (input instanceof Request) return input.method.toUpperCase();
  return "GET";
}

function requestHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  const headers = new Headers(
    input instanceof Request ? input.headers : undefined,
  );
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));

  if (
    init?.body !== undefined &&
    !headers.has("content-type") &&
    typeof init.body === "string"
  ) {
    headers.set("content-type", "application/json");
  }
  if (!headers.has("accept")) headers.set("accept", "application/json");

  return headers;
}

export async function csrfFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const method = requestMethod(input, init);
  const headers = requestHeaders(input, init);

  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    const configuration = await getCsrfConfiguration();
    const token = readCookie(configuration.cookieName);
    if (token === undefined || token === "") {
      throw new ApiRequestError(
        "Your session is missing CSRF protection. Sign in again.",
        403,
      );
    }
    headers.set(configuration.headerName, token);
  }

  return fetch(input, {
    ...init,
    headers,
    cache: "no-store",
    credentials: "same-origin",
  });
}

export async function apiJson<T>(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<T> {
  const response = await csrfFetch(input, init);
  const payload = await readJson(response);

  if (!response.ok) {
    throw new ApiRequestError(
      apiErrorMessage(payload, response.status),
      response.status,
    );
  }
  if (typeof payload !== "object" || payload === null || !("data" in payload)) {
    throw new ApiRequestError(
      "The server returned an invalid response.",
      response.status,
    );
  }

  return payload.data as T;
}
