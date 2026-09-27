/**
 * Minimal client for the OpenRouter Decisions API (JEv).
 *
 * JEv is a System One decision model, not a chat model: state in, typed
 * probabilities out. No reasoning text, no JSON parsing, no repair loops.
 */
import { z } from "zod";

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
  let attempt = 0;
  // oxlint-disable-next-line no-constant-condition
  for (;;) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
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
      if (response.status === 429 || response.status >= 500) {
        throw new Error(`jev_transient_http_${response.status}`);
      }
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `JEv request was rejected (${response.status}): ${body.slice(0, 200)}`,
        );
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
    } catch (error) {
      attempt += 1;
      const message = error instanceof Error ? error.message : String(error);
      const transient =
        /transient|429|5\d\d|abort|ECONNRESET|ETIMEDOUT|fetch failed/i.test(
          message,
        );
      if (!transient || attempt > maxRetries) throw error;
      await sleep(delayMs);
      delayMs = Math.min(30_000, delayMs * 2);
    }
  }
}
