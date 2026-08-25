import { expect, it } from "vitest";

import { ExaSearchClient } from "./exa.js";

const runLiveSmoke =
  process.env.EXA_LIVE_SMOKE === "true" && process.env.EXA_API_KEY !== undefined;
const liveIt = runLiveSmoke ? it : it.skip;

liveIt("finds Zephyr International's official-domain proposal", async () => {
  const client = new ExaSearchClient({ apiKey: process.env.EXA_API_KEY });
  const candidates = await client.searchOfficialDomainCandidates({
    legalName: "Zephyr International",
  });

  expect(candidates.some(({ domain }) => domain === "zephyrintl.com")).toBe(true);
});
