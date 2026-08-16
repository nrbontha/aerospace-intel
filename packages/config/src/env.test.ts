import { describe, expect, it } from "vitest";

import { getPublicEnv, getServerEnv } from "./index.js";

describe("getServerEnv", () => {
  it("applies bounded research and runtime defaults in tests", () => {
    const env = getServerEnv({ NODE_ENV: "test" });

    expect(env).toMatchObject({
      OPENROUTER_MODEL_FAST: "openai/gpt-4.1-mini",
      OPENROUTER_MODEL_DEEP: "anthropic/claude-sonnet-4",
      OPENROUTER_MODEL_FALLBACK: "google/gemini-2.5-flash",
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

describe("getPublicEnv", () => {
  it("returns only browser-safe values when server secrets are present", () => {
    const env = getPublicEnv({
      NEXT_PUBLIC_APP_URL: "https://app.example.test",
      DATABASE_URL: "not-exported",
      SESSION_SECRET: "not-exported",
      OPENROUTER_API_KEY: "not-exported",
      BOOTSTRAP_ADMIN_PASSWORD: "not-exported",
    });

    expect(env).toEqual({
      NEXT_PUBLIC_APP_URL: "https://app.example.test",
    });
    expect(env).not.toHaveProperty("DATABASE_URL");
    expect(env).not.toHaveProperty("SESSION_SECRET");
    expect(env).not.toHaveProperty("OPENROUTER_API_KEY");
    expect(env).not.toHaveProperty("BOOTSTRAP_ADMIN_PASSWORD");
  });
});
