/**
 * Minimal client for the OpenRouter Decisions API (JEv).
 *
 * JEv is a System One decision model, not a chat model: state in, typed
 * probabilities out. No reasoning text, no JSON parsing, no repair loops.
 */
import { z } from "zod";
import {
  JEV_OPENROUTER_ESTIMATED_COST_USD,
  OpenRouterAccountingError,
  OpenRouterBudgetDeferredError,
  executeAccountedOpenRouterRequest,
  openRouterBudgetScopeConfigured,
  openRouterFailureAccounting,
  openRouterKeyFingerprint,
  type OpenRouterAccountingContext,
  type OpenRouterRequestAccounting,
} from "../openrouter-budget.js";
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
      cost: z
        .union([
          z.number().finite().nonnegative(),
          z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u),
        ])
        .optional(),
    })
    .optional(),
});

export type JevAnswers = Record<string, z.infer<typeof jevAnswerSchema>>;

export interface JevCallResult {
  readonly answers: JevAnswers;
  readonly costUsd: number | null;
  readonly model: string | null;
  /** Durable OpenRouter reservation for a scoped decision request. */
  readonly accounting?: OpenRouterRequestAccounting;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function callJev(
  apiKey: string,
  state: Record<string, unknown>,
  questions: Record<string, unknown>,
  opts?: {
    model?: string;
    timeoutMs?: number;
    maxRetries?: number;
    accounting?: OpenRouterAccountingContext;
  },
): Promise<JevCallResult> {
  const model = opts?.model ?? JEV_MODEL;
  const scoped = openRouterBudgetScopeConfigured();
  if (scoped) {
    if (opts?.accounting === undefined) {
      throw new OpenRouterBudgetDeferredError("missing_accounting_context", null);
    }
    if (model !== JEV_MODEL || opts?.maxRetries !== 0) {
      throw new OpenRouterClientError("configuration_error", false);
    }
  }
  const timeoutMs = opts?.timeoutMs ?? 60_000;
  const maxRetries = scoped ? 0 : (opts?.maxRetries ?? 4);
  const body = {
    model,
    state,
    questions,
    ...(scoped
      ? {
          provider: {
            max_price: {
              prompt: "0.042",
              completion: "0",
              request: "0",
            },
            allow_fallbacks: false,
          },
        }
      : {}),
  };
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
    let responseBody: string | undefined;
    let accounting: OpenRouterRequestAccounting | undefined;
    try {
      try {
        if (scoped) {
          const accounted = await executeAccountedOpenRouterRequest(
            {
              context: opts!.accounting!,
              providerKeyFingerprint: openRouterKeyFingerprint(apiKey),
              operation: "openrouter_jev_decision",
              requestBody: body,
              prompt: JSON.stringify({ state, questions }),
              estimatedCostUsd: JEV_OPENROUTER_ESTIMATED_COST_USD,
            },
            () =>
              fetch(JEV_ENDPOINT, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${apiKey}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
                signal: controller.signal,
              }),
            async (accountedResponse) => accountedResponse.text(),
          );
          response = accounted.response;
          responseBody = accounted.body;
          accounting = accounted.accounting;
        } else {
          response = await fetch(JEV_ENDPOINT, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      if (
        error instanceof OpenRouterAccountingError ||
        error instanceof OpenRouterBudgetDeferredError
      ) {
        throw error;
      }
      const failureAccounting = openRouterFailureAccounting(error);
      if (retries >= maxRetries) {
        if (error instanceof OpenRouterClientError) {
          throw new OpenRouterClientError(
            error.code,
            error.retryable,
            error.attempts,
            failureAccounting ?? error.accounting,
          );
        }
        throw new OpenRouterClientError(
          timedOut ? "timeout" : "network_error",
          true,
          [],
          failureAccounting ?? undefined,
        );
      }
      retries += 1;
      await sleep(delayMs);
      delayMs = Math.min(30_000, delayMs * 2);
      continue;
    }
    if (!response.ok) {
      const responseErrorBody =
        responseBody ??
        (response.status === 403 ? await response.text().catch(() => "") : "");
      const failure = classifyOpenRouterHttpFailure(
        response.status,
        responseErrorBody,
      );
      if (responseBody === undefined && response.status !== 403) {
        await response.body?.cancel().catch(() => undefined);
      }
      if (!failure.retryable || retries >= maxRetries) {
        throw new OpenRouterClientError(
          failure.code,
          failure.retryable,
          [],
          accounting,
        );
      }
      retries += 1;
      await sleep(delayMs);
      delayMs = Math.min(30_000, delayMs * 2);
      continue;
    }
    let parsed;
    try {
      parsed = jevResponseSchema.safeParse(
        JSON.parse(responseBody ?? (await response.text())),
      );
    } catch {
      parsed = { success: false } as const;
    }
    if (!parsed.success) {
      if (!scoped) {
        throw new Error("JEv returned an unparseable response envelope");
      }
      throw new OpenRouterClientError(
        "invalid_structured_output",
        false,
        [],
        accounting,
      );
    }
    const providerCost = parsed.data.usage?.cost;
    return {
      answers: parsed.data.answers,
      costUsd:
        providerCost === undefined
          ? null
          : typeof providerCost === "number"
            ? providerCost
            : Number(providerCost),
      model: parsed.data.model ?? null,
      ...(accounting === undefined ? {} : { accounting }),
    };
  }
}
