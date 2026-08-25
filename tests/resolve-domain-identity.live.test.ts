import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildDomainDeps } from "../apps/web/src/app/api/v1/leads/[id]/resolve-domain/route.js";

const LIVE_ENABLED = process.env.ASI_LIVE_DOMAIN_TESTS === "1";

function loadEnvironment(): void {
  if (process.env.OPENROUTER_API_KEY) return;
  for (const candidate of [path.join(process.cwd(), ".env.local"), path.join(process.cwd(), ".env")]) {
    if (!existsSync(candidate)) continue;
    for (const line of readFileSync(candidate, "utf8").split("\n")) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match?.[1] && match[2] && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2];
      }
    }
  }
}

describe.skipIf(!LIVE_ENABLED)("resolve-domain route identity dependencies (LIVE)", () => {
  it("rejects Romanian ZITEC, accepts the Niceville defense site, and identifies Yulista as parent-brand", { timeout: 180_000 }, async () => {
    loadEnvironment();
    const deps = buildDomainDeps();
    expect(deps, "OPENROUTER_API_KEY must be configured for this live test").not.toBeNull();

    const wrong = await deps!.prober.fetchText("https://zitec.com");
    expect(wrong.ok, "zitec.com must be fetchable through the route prober").toBe(true);
    if (!wrong.ok) return;
    const wrongJudgment = await deps!.judge.judgeIdentity("ZITEC, INC", wrong.text, {
      location: "Niceville, FL",
      uei: null,
      cage: "1R9V9",
    });
    expect(wrongJudgment.matches).toBe(false);
    expect(wrongJudgment.locationMatches).toBe(false);
    expect(wrongJudgment.relationship).toBe("mismatch");

    const correct = await deps!.prober.fetchText("https://www.zitecusa.com/about.html");
    expect(correct.ok, "zitecusa.com must be fetchable through the route prober").toBe(true);
    if (!correct.ok) return;
    const correctJudgment = await deps!.judge.judgeIdentity("ZITEC, INC", correct.text, {
      location: "Niceville, FL",
      uei: null,
      cage: "1R9V9",
    });
    expect(correctJudgment.matches).toBe(true);
    expect(correctJudgment.locationMatches === true || correctJudgment.identifierMatches === true).toBe(true);
    expect(correctJudgment.relationship).toBe("exact");

    const yulista = await deps!.prober.fetchText("https://yulista.com");
    expect(yulista.ok, "yulista.com must be fetchable through the route prober").toBe(true);
    if (!yulista.ok) return;
    const yulistaJudgment = await deps!.judge.judgeIdentity(
      "YULISTA AVIATION, INC",
      yulista.text,
      { location: "Huntsville, AL", uei: null, cage: null },
    );
    expect(yulistaJudgment.matches).toBe(true);
    expect(yulistaJudgment.relationship).toBe("parent_brand");
  });
});
