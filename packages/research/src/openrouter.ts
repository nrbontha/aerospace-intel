import { createHash } from "node:crypto";
import { z } from "zod";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export type OpenRouterModelRoute = "fast" | "deep";
export interface OpenRouterModelRouting {
  readonly fast: string;
  readonly deep: string;
  readonly fallback: string;
}
export type OpenRouterErrorCode =
  | "configuration_error"
  | "cancelled"
  | "timeout"
  | "rate_limited"
  | "provider_unavailable"
  | "network_error"
  | "request_rejected"
  | "invalid_structured_output";
export type OpenRouterAttemptStatus =
  "succeeded" | "transient_error" | "schema_error" | "failed" | "cancelled";

export interface OpenRouterAttemptTelemetry {
  readonly attempt: number;
  readonly model: string;
  readonly provider: string | null;
  readonly status: OpenRouterAttemptStatus;
  readonly httpStatus: number | null;
  readonly promptSha256: string;
  readonly responseSha256: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  readonly latencyMs: number;
  readonly retryDelayMs: number | null;
  readonly errorCode: OpenRouterErrorCode | null;
}
export interface OpenRouterTelemetry {
  readonly route: OpenRouterModelRoute;
  readonly schemaName: string;
  readonly schemaSha256: string;
  readonly promptSha256: string;
  readonly responseSha256: string;
  readonly model: string;
  readonly provider: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  readonly latencyMs: number;
  readonly attemptCount: number;
  readonly attempts: readonly OpenRouterAttemptTelemetry[];
}
export interface OpenRouterStructuredRequest<T> {
  readonly route: OpenRouterModelRoute;
  readonly models: OpenRouterModelRouting;
  readonly schemaName: string;
  readonly schema: z.ZodType<T>;
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly maxRetryDelayMs?: number;
  readonly signal?: AbortSignal;
  readonly validateResult?: (result: T) => boolean;
}
export interface OpenRouterStructuredResult<T> {
  readonly data: T;
  readonly telemetry: OpenRouterTelemetry;
}

export class OpenRouterClientError extends Error {
  constructor(
    readonly code: OpenRouterErrorCode,
    readonly retryable: boolean,
    readonly attempts: readonly OpenRouterAttemptTelemetry[] = [],
  ) {
    super(
      {
        configuration_error: "OpenRouter client configuration is invalid",
        cancelled: "OpenRouter request was cancelled",
        timeout: "OpenRouter request timed out",
        rate_limited: "OpenRouter request was rate limited",
        provider_unavailable: "OpenRouter provider is temporarily unavailable",
        network_error: "OpenRouter network request failed",
        request_rejected: "OpenRouter request was rejected",
        invalid_structured_output:
          "OpenRouter returned invalid structured output",
      }[code],
    );
    this.name = "OpenRouterClientError";
  }
}

const envelopeSchema = z.object({
  model: z.string().optional(),
  provider: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          parsed: z.unknown().optional(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().finite().nonnegative().optional(),
      completion_tokens: z.number().finite().nonnegative().optional(),
      total_tokens: z.number().finite().nonnegative().optional(),
      cost: z.number().finite().nonnegative().optional(),
    })
    .optional(),
});
type Envelope = z.infer<typeof envelopeSchema>;
interface Parsed<T> {
  valid: boolean;
  data?: T;
  responseSha256: string;
  model: string;
  provider: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
}

export class OpenRouterClient {
  readonly #apiKey: string;
  constructor(apiKey: string) {
    const key = apiKey.trim();
    if (key.length === 0 || /[\r\n]/u.test(key))
      throw new OpenRouterClientError("configuration_error", false);
    this.#apiKey = key;
  }

  async generateStructured<T>(
    request: OpenRouterStructuredRequest<T>,
  ): Promise<OpenRouterStructuredResult<T>> {
    validateRequest(request);
    const jsonSchema = z.toJSONSchema(request.schema, {
      target: "draft-07",
      unrepresentable: "throw",
    });
    const schemaJson = canonicalJson(jsonSchema);
    const schemaSha256 = sha256(schemaJson);
    const promptSha256 = sha256(
      `${request.systemPrompt}\u0000${request.prompt}\u0000${schemaJson}`,
    );
    if (
      [request.systemPrompt, request.prompt, schemaJson].some((value) =>
        value.includes(this.#apiKey),
      )
    ) {
      throw new OpenRouterClientError("configuration_error", false);
    }
    const attempts: OpenRouterAttemptTelemetry[] = [];
    const overallStarted = Date.now();
    const maxAttempts = request.maxAttempts ?? 3;
    const maxDelay = request.maxRetryDelayMs ?? 10_000;
    const fallback = request.models.fallback;
    let model = request.models[request.route];
    let schemaFallbackAttempted = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (request.signal?.aborted === true)
        throw new OpenRouterClientError("cancelled", false, attempts);
      const started = Date.now();
      let response: Response;
      try {
        response = await this.#fetch(model, request, jsonSchema);
      } catch (error) {
        const code: OpenRouterErrorCode = request.signal?.aborted
          ? "cancelled"
          : error instanceof OpenRouterClientError
            ? error.code
            : "network_error";
        const canRetry = code !== "cancelled" && attempt < maxAttempts;
        const retryDelayMs = canRetry ? jitter(attempt, maxDelay) : null;
        attempts.push(
          makeAttempt({
            attempt,
            model,
            status: code === "cancelled" ? "cancelled" : "transient_error",
            promptSha256,
            latencyMs: Date.now() - started,
            retryDelayMs,
            errorCode: code,
          }),
        );
        if (!canRetry)
          throw new OpenRouterClientError(code, code !== "cancelled", attempts);
        if (attempt === maxAttempts - 1) model = fallback;
        await wait(retryDelayMs ?? 0, request.signal);
        continue;
      }
      const latencyMs = Date.now() - started;
      if (!response.ok) {
        const code: OpenRouterErrorCode =
          response.status === 429
            ? "rate_limited"
            : response.status >= 500
              ? "provider_unavailable"
              : "request_rejected";
        const transient = response.status === 429 || response.status >= 500;
        const canRetry = transient && attempt < maxAttempts;
        const retryDelayMs = canRetry
          ? retryAfter(response.headers.get("retry-after"), attempt, maxDelay)
          : null;
        await response.body?.cancel().catch(() => undefined);
        attempts.push(
          makeAttempt({
            attempt,
            model,
            status: transient ? "transient_error" : "failed",
            httpStatus: response.status,
            promptSha256,
            latencyMs,
            retryDelayMs,
            errorCode: code,
          }),
        );
        if (!canRetry)
          throw new OpenRouterClientError(code, transient, attempts);
        if (attempt === maxAttempts - 1) model = fallback;
        await wait(retryDelayMs ?? 0, request.signal);
        continue;
      }
      const parsed = await parseResponse(
        response,
        request.schema,
        request.validateResult,
        this.#apiKey,
      );
      if (!parsed.valid || parsed.data === undefined) {
        const canRetry = attempt < maxAttempts && !schemaFallbackAttempted;
        attempts.push(
          makeAttempt({
            attempt,
            model,
            provider: parsed.provider,
            status: "schema_error",
            httpStatus: response.status,
            promptSha256,
            responseSha256: parsed.responseSha256,
            inputTokens: parsed.inputTokens,
            outputTokens: parsed.outputTokens,
            totalTokens: parsed.totalTokens,
            costUsd: parsed.costUsd,
            latencyMs,
            errorCode: "invalid_structured_output",
          }),
        );
        if (!canRetry)
          throw new OpenRouterClientError(
            "invalid_structured_output",
            false,
            attempts,
          );
        schemaFallbackAttempted = true;
        model = fallback;
        continue;
      }
      attempts.push(
        makeAttempt({
          attempt,
          model: parsed.model,
          provider: parsed.provider,
          status: "succeeded",
          httpStatus: response.status,
          promptSha256,
          responseSha256: parsed.responseSha256,
          inputTokens: parsed.inputTokens,
          outputTokens: parsed.outputTokens,
          totalTokens: parsed.totalTokens,
          costUsd: parsed.costUsd,
          latencyMs,
        }),
      );
      return {
        data: parsed.data,
        telemetry: {
          route: request.route,
          schemaName: request.schemaName,
          schemaSha256,
          promptSha256,
          responseSha256: parsed.responseSha256,
          model: parsed.model,
          provider: parsed.provider,
          inputTokens: sum(attempts, "inputTokens"),
          outputTokens: sum(attempts, "outputTokens"),
          totalTokens: sum(attempts, "totalTokens"),
          costUsd: sum(attempts, "costUsd"),
          latencyMs: Date.now() - overallStarted,
          attemptCount: attempts.length,
          attempts,
        },
      };
    }
    throw new OpenRouterClientError("provider_unavailable", true, attempts);
  }

  async #fetch<T>(
    model: string,
    request: OpenRouterStructuredRequest<T>,
    jsonSchema: object,
  ): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.timeoutMs ?? 30_000);
    const abort = () => controller.abort();
    request.signal?.addEventListener("abort", abort, { once: true });
    try {
      return await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: request.systemPrompt },
            { role: "user", content: request.prompt },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: request.schemaName,
              strict: true,
              schema: sanitizeJsonSchema(jsonSchema),
            },
          },
          max_tokens: request.maxOutputTokens ?? 4_096,
          temperature: request.temperature ?? 0,
        }),
        signal: controller.signal,
      });
    } catch {
      if (request.signal?.aborted === true)
        throw new OpenRouterClientError("cancelled", false);
      throw new OpenRouterClientError(
        timedOut ? "timeout" : "network_error",
        true,
      );
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
    }
  }
}


function sanitizeJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeJsonSchema);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (key === "$schema" || key === "$id") continue;
    if (key === "format") continue;
    next[key] = sanitizeJsonSchema(entry);
  }
  return next;
}

function validateRequest<T>(request: OpenRouterStructuredRequest<T>): void {
  const modelOk = [
    request.models.fast,
    request.models.deep,
    request.models.fallback,
  ].every((model) => /^[^\s/]+\/[^\s]+$/u.test(model));
  const integer = (value: number | undefined, min: number, max: number) =>
    value === undefined ||
    (Number.isInteger(value) && value >= min && value <= max);
  if (
    !modelOk ||
    !["fast", "deep"].includes(request.route) ||
    !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(request.schemaName) ||
    request.systemPrompt.length === 0 ||
    request.prompt.length === 0 ||
    !integer(request.maxOutputTokens, 1, 32_768) ||
    !integer(request.timeoutMs, 1_000, 120_000) ||
    !integer(request.maxAttempts, 1, 3) ||
    !integer(request.maxRetryDelayMs, 0, 30_000) ||
    (request.temperature !== undefined &&
      (!Number.isFinite(request.temperature) ||
        request.temperature < 0 ||
        request.temperature > 2))
  ) {
    throw new OpenRouterClientError("configuration_error", false);
  }
}

async function parseResponse<T>(
  response: Response,
  schema: z.ZodType<T>,
  validate: ((value: T) => boolean) | undefined,
  key: string,
): Promise<Parsed<T>> {
  let raw = "";
  try {
    raw = await readBounded(response);
    const envelope = envelopeSchema.parse(JSON.parse(raw));
    const message = envelope.choices[0]?.message;
    const value =
      message?.parsed !== undefined
        ? message.parsed
        : parseJson(message?.content ?? null);
    const output = canonicalJson(value);
    const details = responseDetails(envelope, sha256(output));
    if (raw.includes(key) || output.includes(key))
      return { valid: false, ...details };
    const parsed = schema.safeParse(value);
    if (!parsed.success || validate?.(parsed.data) === false)
      return { valid: false, ...details };
    return { valid: true, data: parsed.data, ...details };
  } catch {
    return {
      valid: false,
      responseSha256: sha256(raw),
      model: "unknown",
      provider: "openrouter",
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      costUsd: null,
    };
  }
}
function responseDetails(envelope: Envelope, responseSha256: string) {
  return {
    responseSha256,
    model: envelope.model ?? "unknown",
    provider: envelope.provider ?? "openrouter",
    inputTokens: envelope.usage?.prompt_tokens ?? null,
    outputTokens: envelope.usage?.completion_tokens ?? null,
    totalTokens: envelope.usage?.total_tokens ?? null,
    costUsd: envelope.usage?.cost ?? null,
  };
}
async function readBounded(response: Response): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("response_limit");
    }
    chunks.push(next.value);
  }
  const merged = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}
function makeAttempt(
  input: Partial<OpenRouterAttemptTelemetry> &
    Pick<
      OpenRouterAttemptTelemetry,
      "attempt" | "model" | "status" | "promptSha256" | "latencyMs"
    >,
): OpenRouterAttemptTelemetry {
  return {
    attempt: input.attempt,
    model: input.model,
    provider: input.provider ?? null,
    status: input.status,
    httpStatus: input.httpStatus ?? null,
    promptSha256: input.promptSha256,
    responseSha256: input.responseSha256 ?? null,
    inputTokens: input.inputTokens ?? null,
    outputTokens: input.outputTokens ?? null,
    totalTokens: input.totalTokens ?? null,
    costUsd: input.costUsd ?? null,
    latencyMs: input.latencyMs,
    retryDelayMs: input.retryDelayMs ?? null,
    errorCode: input.errorCode ?? null,
  };
}
function retryAfter(
  value: string | null,
  attempt: number,
  max: number,
): number {
  let requested: number | null = null;
  if (value !== null) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) requested = seconds * 1_000;
    else {
      const date = Date.parse(value);
      if (!Number.isNaN(date)) requested = Math.max(0, date - Date.now());
    }
  }
  return Math.floor(
    Math.min(
      max,
      (requested ?? 250 * 2 ** (attempt - 1)) + Math.random() * 500,
    ),
  );
}
function jitter(attempt: number, max: number): number {
  return Math.floor(
    Math.random() * (Math.min(max, 250 * 2 ** (attempt - 1)) + 1),
  );
}
async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  const abort = () => {
    clearTimeout(timer);
    reject(new OpenRouterClientError("cancelled", false));
  };
  if (signal?.aborted === true) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  await promise;
}
function sum(
  attempts: readonly OpenRouterAttemptTelemetry[],
  key: "inputTokens" | "outputTokens" | "totalTokens" | "costUsd",
): number | null {
  const values = attempts
    .map((attempt) => attempt[key])
    .filter((value): value is number => value !== null);
  return values.length === 0
    ? null
    : values.reduce((total, value) => total + value, 0);
}
function parseJson(value: string | null): unknown {
  if (value === null) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
