import { describe, expect, it, vi } from "vitest";

import {
  EXA_SEARCH_QUERY_MAX_LENGTH,
  EXA_SEARCH_RESULT_LIMIT,
  EXA_SEARCH_TEXT_MAX_CHARACTERS,
  EXA_SEARCH_TIMEOUT_MS,
  ExaApiKeyMissingError,
  ExaSearchClient,
  ExaSearchError,
  isSuppressedDirectoryDomain,
  OFFICIAL_CANDIDATE_BLOCKED_DOMAIN_SUFFIXES,
  searchOfficialDomainCandidates,
} from "./exa.js";

function exaResponse(results: unknown[]): Response {
  return new Response(JSON.stringify({ results }), { status: 200 });
}

const validResult = {
  title: "Zephyr International",
  url: "https://zephyrintl.com/about",
  text: "Precision aerospace components.",
  score: 0.94,
};

describe("ExaSearchClient", () => {
  it("fails closed before making a network request when the API key is absent", async () => {
    let called = false;
    const client = new ExaSearchClient({
      fetch: async () => {
        called = true;
        return exaResponse([]);
      },
    });

    await expect(client.search("Zephyr International")).rejects.toBeInstanceOf(
      ExaApiKeyMissingError,
    );
    expect(called).toBe(false);
  });

  it("sends one bounded POST with the Exa authentication header", async () => {
    const calls: Array<{
      input: RequestInfo | URL;
      init: RequestInit | undefined;
    }> = [];
    const client = new ExaSearchClient({
      apiKey: "test-exa-key",
      fetch: async (input, init) => {
        calls.push({ input, init });
        return exaResponse([validResult]);
      },
    });

    await expect(client.search("  Zephyr   International  ")).resolves.toEqual([
      validResult,
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      input: "https://api.exa.ai/search",
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "test-exa-key",
        },
      },
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      query: "Zephyr International",
      numResults: EXA_SEARCH_RESULT_LIMIT,
      contents: { text: { maxCharacters: EXA_SEARCH_TEXT_MAX_CHARACTERS } },
    });
  });

  it("rejects malformed API payloads rather than accepting partial results", async () => {
    const client = new ExaSearchClient({
      apiKey: "test-exa-key",
      fetch: async () =>
        exaResponse([
          { ...validResult, text: null },
        ]),
    });

    await expect(client.search("Zephyr International")).rejects.toMatchObject({
      name: "ExaSearchError",
      code: "invalid_response",
      transient: false,
    });
  });

  it("assigns a neutral score when Exa omits a relevance score", async () => {
    const resultWithoutScore = {
      title: validResult.title,
      url: validResult.url,
      text: validResult.text,
    };
    const client = new ExaSearchClient({
      apiKey: "test-exa-key",
      fetch: async () => exaResponse([resultWithoutScore]),
    });

    await expect(client.search("Zephyr International")).resolves.toEqual([
      { ...resultWithoutScore, score: 0 },
    ]);
  });

  it("classifies retryable provider responses as transient", async () => {
    const client = new ExaSearchClient({
      apiKey: "test-exa-key",
      fetch: async () => new Response(null, { status: 503 }),
    });

    await expect(client.search("Zephyr International")).rejects.toMatchObject({
      name: "ExaSearchError",
      code: "provider_unavailable",
      transient: true,
      status: 503,
    });
  });

  it("rejects queries beyond the fixed request budget before networking", async () => {
    let called = false;
    const client = new ExaSearchClient({
      apiKey: "test-exa-key",
      fetch: async () => {
        called = true;
        return exaResponse([]);
      },
    });

    await expect(client.search("x".repeat(EXA_SEARCH_QUERY_MAX_LENGTH + 1))).rejects.toMatchObject({
      name: "ExaSearchError",
      code: "invalid_request",
      transient: false,
    });
    expect(called).toBe(false);
  });

  it("times out requests after the fixed 15-second deadline", async () => {
    vi.useFakeTimers();
    try {
      const client = new ExaSearchClient({
        apiKey: "test-exa-key",
        fetch: async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal as AbortSignal;
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          }),
      });

      const search = expect(
        client.search("Zephyr International"),
      ).rejects.toMatchObject({
        name: "ExaSearchError",
        code: "timeout",
        transient: true,
      });
      await vi.advanceTimersByTimeAsync(EXA_SEARCH_TIMEOUT_MS);
      await search;
    } finally {
      vi.useRealTimers();
    }
  });

  it("never puts the API key in error messages", async () => {
    const apiKey = "exa-key-that-must-never-appear";
    const client = new ExaSearchClient({
      apiKey,
      fetch: async () => new Response(null, { status: 500 }),
    });

    const error = await client.search("Zephyr International").catch((reason) => reason);
    expect(error).toBeInstanceOf(ExaSearchError);
    expect(String(error)).not.toContain(apiKey);
    expect(error.message).not.toContain(apiKey);
  });
});

describe("searchOfficialDomainCandidates", () => {
  it("deduplicates normalized domains and suppresses directories and social sites", async () => {
    const client = new ExaSearchClient({

      apiKey: "test-exa-key",
      fetch: async () =>
        exaResponse([
          validResult,
          { ...validResult, url: "https://www.zephyrintl.com/contact" },
          {
            ...validResult,
            title: "LinkedIn",
            url: "https://www.linkedin.com/company/zephyr-international",
          },
          {
            ...validResult,
            title: "GovTribe",
            url: "https://govtribe.com/vendors/zephyr-international",
          },
          {
            ...validResult,
            title: "Another proposal",
            url: "https://example-aerospace.test/",
            score: 0.7,
          },
        ]),
    });

    await expect(
      searchOfficialDomainCandidates(
        {
          legalName: "Zephyr International",
          city: "Zephyrhills",
          state: "FL",
          uei: "ABC123",
          cage: "1A2B3",
        },
        client,
      ),
    ).resolves.toEqual([
      {
        url: "https://zephyrintl.com/about",
        domain: "zephyrintl.com",
        title: "Zephyr International",
        textSnippet: "Precision aerospace components.",
        score: 0.94,
      },
      {
        url: "https://example-aerospace.test/",
        domain: "example-aerospace.test",
        title: "Another proposal",
        textSnippet: "Precision aerospace components.",
        score: 0.7,
      },
    ]);
  });
  it("exports the suffix-safe official-candidate directory blocklist", () => {
    const required = [
      "highergov.com",
      "govtribe.com",
      "cage.report",
      "sam.gov",
      "usaspending.gov",
      "dnb.com",
      "zoominfo.com",
      "rocketreach.co",
      "opencorporates.com",
      "linkedin.com",
      "crunchbase.com",
      "bloomberg.com",
      "pitchbook.com",
      "manta.com",
      "bbb.org",
      "chamberofcommerce.com",
      "mapquest.com",
      "lead411.com",
      "signalhire.com",
      "inknowvation.com",
    ];
    expect([...OFFICIAL_CANDIDATE_BLOCKED_DOMAIN_SUFFIXES]).toEqual(
      expect.arrayContaining(required),
    );
    for (const domain of required) {
      expect(isSuppressedDirectoryDomain(domain), domain).toBe(true);
      expect(isSuppressedDirectoryDomain(`profiles.${domain}`), `profiles.${domain}`).toBe(true);
      expect(isSuppressedDirectoryDomain(`not-${domain}`), `not-${domain}`).toBe(false);
    }
  });
  it("makes one identity-specific official-site query", async () => {
    const queries: string[] = [];
    const client: Pick<ExaSearchClient, "search"> = {
      search: async (query) => {
        queries.push(query);
        return [];
      },
    };

    await searchOfficialDomainCandidates(
      {
        legalName: "Zephyr International",
        city: "Zephyrhills",
        state: "FL",
        uei: "ABC123",
        cage: "1A2B3",
      },
      client,
    );

    expect(queries).toEqual([
      'official website "Zephyr International" Zephyrhills FL UEI ABC123 CAGE 1A2B3',
    ]);
  });

  it("rejects non-HTTP URLs from the official candidate list", async () => {
    const client: Pick<ExaSearchClient, "search"> = {
      search: async () => [
        { ...validResult, url: "ftp://zephyrintl.com/document" },
      ],
    };

    await expect(
      searchOfficialDomainCandidates(
        { legalName: "Zephyr International" },
        client,
      ),
    ).resolves.toEqual([]);
  });
});
