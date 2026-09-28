/**
 * Minimal client for the OpenRouter Decisions API (JEv).
 *
 * JEv is a System One decision model, not a chat model: state in, typed
 * probabilities out. No reasoning text, no JSON parsing, no repair loops.
 */
import { z } from "zod";
import {
  classifyOpenRouterHttpFailure,
  OpenRouterClientError,
} from "../openrouter.js";

export const JEV_MODEL = "typesafe/jev-1.13";
const JEV_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";

const jevAnswerSchema = z.object({
  type: z.string(),
  choice: z.string().optional(),
  confidence: z.number().optional(),
  probabilities: z.record(z.string(), z.number()).optional(),
  noul: z.number().optional(),
  score: z.number().optional(),
});

const jevResponseSchema = z.object({
  model: z.string().optional(),
  answers: z.record(z.string(), jevAnswerSchema),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cost: z.number().optional(),
    })
    .optional(),
});

export type JevAnswers = Record<string, z.infer<typeof jevAnswerSchema>>;

export interface JevCallResult {
  readonly answers: JevAnswers;
  readonly costUsd: number | null;
  readonly model: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function callJev(
  apiKey: string,
  state: Record<string, unknown>,
  questions: Record<string, unknown>,
  opts?: { model?: string; timeoutMs?: number; maxRetries?: number },
): Promise<JevCallResult> {
  const model = opts?.model ?? JEV_MODEL;
  const timeoutMs = opts?.timeoutMs ?? 60_000;
  const maxRetries = opts?.maxRetries ?? 4;
  let delayMs = 2_000;
  let retries = 0;
  // oxlint-disable-next-line no-constant-condition
  for (;;) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let response: Response;
    try {
      try {
        response = await fetch(JEV_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model, state, questions }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      if (retries >= maxRetries) {
        throw new OpenRouterClientError(
          timedOut ? "timeout" : "network_error",
          true,
        );
      }
      retries += 1;
      await sleep(delayMs);
      delayMs = Math.min(30_000, delayMs * 2);
      continue;
    }
    if (!response.ok) {
      const body =
        response.status === 403 ? await response.text().catch(() => "") : "";
      const failure = classifyOpenRouterHttpFailure(response.status, body);
      if (response.status !== 403) {
        await response.body?.cancel().catch(() => undefined);
      }
      if (!failure.retryable || retries >= maxRetries) {
        throw new OpenRouterClientError(failure.code, failure.retryable);
      }
      retries += 1;
      await sleep(delayMs);
      delayMs = Math.min(30_000, delayMs * 2);
      continue;
    }
    const parsed = jevResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error("JEv returned an unparseable response envelope");
    }
    return {
      answers: parsed.data.answers,
      costUsd: parsed.data.usage?.cost ?? null,
      model: parsed.data.model ?? null,
    };
  }
}
