import { describe, expect, it } from "vitest";

import {
  allowsResearchDocumentWrites,
  getPublicEnv,
  getServerEnv,
} from "./index.js";

const requiredRuntime = {
  DATABASE_URL: "postgresql://asi:asi@127.0.0.1:54329/asi",
  SESSION_SECRET: "x".repeat(32),
} as const;

const unsetResearchRuntime = {
  ...requiredRuntime,
  NODE_ENV: undefined,
  RESEARCH_SHARED_STORAGE: undefined,
} as const;

describe("getServerEnv", () => {
  it("applies bounded research and runtime defaults in tests", () => {
    const env = getServerEnv({ NODE_ENV: "test" });

    expect(env).toMatchObject({
      OPENROUTER_MODEL_FAST: "openai/gpt-5.4-mini",
      OPENROUTER_MODEL_DEEP: "anthropic/claude-sonnet-5",
      OPENROUTER_MODEL_FALLBACK: "google/gemini-3.7-flash",
      OPENROUTER_MAX_COST_PER_RUN_USD: 2,
      OPENROUTER_MAX_COST_PER_DAY_USD: 15,
      RESEARCH_MAX_TOOL_CALLS: 50,
      RESEARCH_CONCURRENCY: 5,
      PORT: 3000,
      APP_URL: "http://localhost:3000",
      STORAGE_PATH: "./storage",
      SESSION_COOKIE_NAME: "asi_session",
      SESSION_COOKIE_SECURE: false,
      RESEARCH_QUEUE_NAME: "research-jobs",
    });
  });

  it("rejects { NODE_ENV: undefined, RESEARCH_SHARED_STORAGE: undefined }", () => {
    expect(() => getServerEnv(unsetResearchRuntime)).toThrow(/NODE_ENV/);
    expect(() =>
      getServerEnv({ ...requiredRuntime, NODE_ENV: "" }),
    ).toThrow(/NODE_ENV/);
  });

  it("requires production NODE_ENV when APP_URL is not loopback", () => {
    expect(() =>
      getServerEnv({
        ...requiredRuntime,
        NODE_ENV: "development",
        APP_URL: "https://example.up.railway.app",
      }),
    ).toThrow(/NODE_ENV must be production/);
  });

  it.each([
    ["OPENROUTER_MAX_COST_PER_RUN_USD", "0"],
    ["OPENROUTER_MAX_COST_PER_DAY_USD", "not-a-number"],
    ["RESEARCH_MAX_TOOL_CALLS", "2.5"],
    ["RESEARCH_CONCURRENCY", "101"],
  ])("rejects malformed or unsafe %s", (name, value) => {
    expect(() =>
      getServerEnv({
        NODE_ENV: "test",
        [name]: value,
      }),
    ).toThrow();
  });

  it("keeps EXA_API_KEY optional and trims a configured value", () => {
    expect(getServerEnv({ NODE_ENV: "test" }).EXA_API_KEY).toBeUndefined();
    expect(
      getServerEnv({ NODE_ENV: "test", EXA_API_KEY: "  test-exa-key  " })
        .EXA_API_KEY,
    ).toBe("test-exa-key");
  });

  it("keeps SAM_API_KEY server-only, optional, and trimmed", () => {
    expect(getServerEnv({ NODE_ENV: "test" }).SAM_API_KEY).toBeUndefined();
    expect(
      getServerEnv({ NODE_ENV: "test", SAM_API_KEY: "  test-sam-key  " })
        .SAM_API_KEY,
    ).toBe("test-sam-key");
    expect(
      getPublicEnv({
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
        SAM_API_KEY: "must-not-be-public",
      }),
    ).not.toHaveProperty("SAM_API_KEY");
  });

  it.each([
    [{ BOOTSTRAP_ADMIN_EMAIL: "nobody@example.invalid" }],
    [{ BOOTSTRAP_ADMIN_PASSWORD: "x".repeat(12) }],
  ])("rejects an unpaired bootstrap credential", (bootstrapEnv) => {
    expect(() =>
      getServerEnv({
        NODE_ENV: "test",
        ...bootstrapEnv,
      }),
    ).toThrow(/must be provided together/);
  });
});

describe("allowsResearchDocumentWrites", () => {
  it("does not open writes for { NODE_ENV: undefined, RESEARCH_SHARED_STORAGE: undefined }", () => {
    expect(() =>
      allowsResearchDocumentWrites(getServerEnv(unsetResearchRuntime)),
    ).toThrow(/NODE_ENV/);
  });

  it("requires RESEARCH_SHARED_STORAGE=true even for development and test", () => {
    expect(
      allowsResearchDocumentWrites(getServerEnv({ NODE_ENV: "test" })),
    ).toBe(false);
    expect(
      allowsResearchDocumentWrites(
        getServerEnv({
          ...requiredRuntime,
          NODE_ENV: "development",
        }),
      ),
    ).toBe(false);
    expect(
      allowsResearchDocumentWrites(
        getServerEnv({
          NODE_ENV: "test",
          RESEARCH_SHARED_STORAGE: "true",
        }),
      ),
    ).toBe(true);
  });

  it("blocks production unless RESEARCH_SHARED_STORAGE is true", () => {
    const production = {
      ...requiredRuntime,
      NODE_ENV: "production",
    } as const;

    expect(allowsResearchDocumentWrites(getServerEnv(production))).toBe(false);
    expect(
      allowsResearchDocumentWrites(
        getServerEnv({ ...production, RESEARCH_SHARED_STORAGE: "false" }),
      ),
    ).toBe(false);
    expect(
      allowsResearchDocumentWrites(
        getServerEnv({ ...production, RESEARCH_SHARED_STORAGE: "true" }),
      ),
    ).toBe(true);
  });

  it("blocks a hosted APP_URL without shared storage even if research is requested", () => {
    const hosted = getServerEnv({
      ...requiredRuntime,
      NODE_ENV: "production",
      APP_URL: "https://example.up.railway.app",
    });
    expect(allowsResearchDocumentWrites(hosted)).toBe(false);
    expect(
      allowsResearchDocumentWrites(
        getServerEnv({
          ...requiredRuntime,
          NODE_ENV: "production",
          APP_URL: "https://example.up.railway.app",
          RESEARCH_SHARED_STORAGE: "true",
        }),
      ),
    ).toBe(true);
  });
});

describe("getPublicEnv", () => {
  it("returns only browser-safe values when server secrets are present", () => {
    const env = getPublicEnv({
      NEXT_PUBLIC_APP_URL: "https://app.example.test",
      DATABASE_URL: "not-exported",
      SESSION_SECRET: "not-exported",
      OPENROUTER_API_KEY: "not-exported",
      EXA_API_KEY: "not-exported",
      BOOTSTRAP_ADMIN_PASSWORD: "not-exported",
    });

    expect(env).toEqual({
      NEXT_PUBLIC_APP_URL: "https://app.example.test",
    });
    expect(env).not.toHaveProperty("DATABASE_URL");
    expect(env).not.toHaveProperty("SESSION_SECRET");
    expect(env).not.toHaveProperty("OPENROUTER_API_KEY");
    expect(env).not.toHaveProperty("EXA_API_KEY");
    expect(env).not.toHaveProperty("BOOTSTRAP_ADMIN_PASSWORD");
  });
});
