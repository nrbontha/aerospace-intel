/**
 * Unit tests for the candidate-research vertical slice:
 *   - OpenRouterClient markdown-fence repair fallback (stealth/ox-alpha quirk)
 *   - collectCandidatePageLinks anchor parsing (≤2 same-host subpages)
 *   - runCandidateResearchWorkflow bounded multi-page fetch + fact aggregation
 *
 * No DB; global fetch is stubbed for the client tests, safe-fetch for the
 * workflow tests.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const safeFetchMock = vi.hoisted(() =>
  vi.fn(async (url: string) => fakeFetchResult(url)),
);

function fakeFetchResult(url: string) {
  const content = url.includes("/about")
    ? "<html><body><p>headquartered in Wellington, Florida</p></body></html>"
    : `<html><body>
        <p>Zephyr International LLC provides precision machining for aerospace.</p>
        <a href="/about">About</a>
        <a href="https://evil.example.com/about">Not ours</a>
      </body></html>`;
  return {
    requestedUrl: url,
    finalUrl: url,
    contentType: "text/html" as const,
    content,
    byteLength: content.length,
    contentSha256: `sha-${url}`,
    retrievedAt: new Date(0).toISOString(),
    durationMs: 1,
    redirects: [],
  };
}

vi.mock("../packages/research/src/safe-fetch.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    safeFetchUrl: (url: string) => safeFetchMock(url),
  };
});

import {
  collectCandidatePageLinks,
  runCandidateResearchWorkflow,
} from "../packages/research/src/campaigns/candidate-research.js";
import { OpenRouterClient } from "../packages/research/src/openrouter.js";
import type {
  CompanyResearchInput,
} from "../packages/research/src/company-workflow.js";
import type {
  OpenRouterClient as OpenRouterClientType,
} from "../packages/research/src/openrouter.js";

function openRouterEnvelope(content: string): unknown {
  return {
    model: "stealth/ox-alpha",
    provider: "openrouter",
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0 },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const simpleSchema = z.strictObject({ answer: z.number() });
const models = { fast: "m/fast", deep: "m/deep", fallback: "m/fb" };

describe("OpenRouterClient structured-output repair", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses plain JSON content without repair (compliant-model path)", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(openRouterEnvelope('{"answer": 42}')),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new OpenRouterClient("test-key");
    const result = await client.generateStructured({
      route: "fast",
      models,
      schemaName: "simple",
      schema: simpleSchema,
      systemPrompt: "s",
      prompt: "p",
    });
    expect(result.data).toEqual({ answer: 42 });
    const requestInit = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[0]!.content).toContain("Output contract:");
  });

  it("repairs markdown-fenced JSON when response_format is ignored", async () => {
    const fenced =
      "```json\n{\n  \"facts\": []\n}\n```\nI extracted nothing further.";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(openRouterEnvelope(fenced))),
    );
    const client = new OpenRouterClient("test-key");
    const result = await client.generateStructured({
      route: "fast",
      models,
      schemaName: "company_research_v1",
      schema: z.strictObject({
        facts: z.array(
          z.strictObject({
            fieldKey: z.string(),
            value: z.string(),
            evidenceExcerpt: z.string(),
            confidence: z.number(),
          }),
        ),
      }),
      systemPrompt: "s",
      prompt: "p",
    });
    expect(result.data).toEqual({ facts: [] });
  });

  it("still fails honestly on prose with no recoverable JSON object", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(openRouterEnvelope("Sorry, I cannot help with that.")),
      ),
    );
    const client = new OpenRouterClient("test-key");
    await expect(
      client.generateStructured({
        route: "fast",
        models,
        schemaName: "simple",
        schema: simpleSchema,
        systemPrompt: "s",
        prompt: "p",
        maxAttempts: 1,
      }),
    ).rejects.toThrowError();
  });
});

describe("collectCandidatePageLinks", () => {
  const html = `
    <a href="/about-us">About</a>
    <a href="https://zephyrintl.com/products/aero">Products</a>
    <a href="//cdn.example.com/logo.png">Logo</a>
    <a href="#capabilities">Capabilities</a>
    <a href="https://other-site.com/about">Other</a>
    <a href="/contact.html">Contact</a>
  `;

  it("collects only same-host http(s) anchors matching about/product patterns", () => {
    const links = collectCandidatePageLinks(html, "https://zephyrintl.com/", 3);
    expect(links).toEqual([
      "https://zephyrintl.com/about-us",
      "https://zephyrintl.com/products/aero",
      "https://zephyrintl.com/contact.html",
    ]);
  });

  it("respects the limit and never returns the base URL itself", () => {
    const links = collectCandidatePageLinks(html, "https://zephyrintl.com/", 2);
    expect(links).toHaveLength(2);
    expect(links).not.toContain("https://zephyrintl.com/");
  });
});

describe("runCandidateResearchWorkflow", () => {
  const company: CompanyResearchInput = {
    id: "company-1",
    legalName: "Zephyr International LLC",
    displayName: "Zephyr International",
    description: null,
    websiteUrl: "https://zephyrintl.test/",
    headquartersCountryCode: null,
    domains: [{ domain: "zephyrintl.test", isPrimary: true }],
    knownFacts: [
      {
        fieldKey: "website_url",
        value: "https://zephyrintl.test/",
        status: "canonical",
      },
    ],
    linkedSources: [],
  };

  interface FakeFact {
    readonly fieldKey: string;
    readonly value: string;
    readonly evidenceExcerpt: string;
    readonly confidence: number;
  }

  function makeClient(
    factsPerCall: ReadonlyArray<ReadonlyArray<FakeFact>>,
  ): OpenRouterClientType {
    let call = 0;
    return {
      generateStructured: vi.fn(async () => {
        const facts = factsPerCall[Math.min(call, factsPerCall.length - 1)] ?? [];
        call += 1;
        return {
          data: { facts },
          telemetry: {
            route: "fast" as const,
            schemaName: "company_research_v1",
            schemaSha256: "schema",
            responseSha256: `resp-${call}`,
            model: "stealth/ox-alpha",
            provider: "openrouter",
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
            costUsd: 0,
            latencyMs: 5,
            attemptCount: 1,
            attempts: [
              {
                attempt: call,
                model: "stealth/ox-alpha",
                provider: "openrouter",
                status: "succeeded" as const,
                httpStatus: 200,
                promptSha256: "p",
                responseSha256: `resp-${call}`,
                inputTokens: 100,
                outputTokens: 20,
                totalTokens: 120,
                costUsd: 0,
                latencyMs: 5,
                retryDelayMs: null,
                errorCode: null,
              },
            ],
          },
        };
      }),
    } as unknown as OpenRouterClientType;
  }
  it("fetches homepage + parsed subpage within budget and aggregates deduped facts", async () => {
    safeFetchMock.mockClear();
    const outcome = await runCandidateResearchWorkflow({
      client: makeClient([
        [
          {
            fieldKey: "description",
            value: "precision machining for aerospace",
            evidenceExcerpt:
              "Zephyr International LLC provides precision machining for aerospace.",
            confidence: 0.9,
          },
          {
            fieldKey: "made_up_field",
            value: "unsupported",
            evidenceExcerpt: "not in any document",
            confidence: 0.5,
          },
        ],
        [
          {
            fieldKey: "headquarters_location",
            value: "Wellington, Florida",
            evidenceExcerpt: "headquartered in Wellington, Florida",
            confidence: 0.8,
          },
        ],
      ]),
      models,
      company,
    });
    expect(safeFetchMock).toHaveBeenCalledTimes(2);
    expect(outcome.status).toBe("completed");
    expect(outcome.fetchedUrls).toHaveLength(2);
    const fieldKeys = outcome.facts.map((fact) => fact.fieldKey).sort();
    expect(fieldKeys).toEqual(["description", "headquarters_location"]);
    // Known website_url fact is never re-reported; excerpts must be in-document.
    expect(outcome.facts.every((fact) => fact.fieldKey !== "website_url")).toBe(true);
    expect(outcome.skippedFactCount).toBe(1);
    expect(outcome.totalTokens).toBe(240);
  });

  it("throws an honest failure when the company has no fetchable URL", async () => {
    const noSite: CompanyResearchInput = {
      ...company,
      websiteUrl: null,
      domains: [],
      knownFacts: [],
    };
    await expect(
      runCandidateResearchWorkflow({
        client: makeClient([[]]),
        models,
        company: noSite,
      }),
    ).rejects.toThrow(/missing_url/u);
  });
});
