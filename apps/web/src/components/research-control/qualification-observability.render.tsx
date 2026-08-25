import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { AgentListItem, AgentsOverview } from "@/lib/agents-api";

import { LiveStrip } from "./live-strip.js";
import { QualificationLadder } from "./qualification-ladder.js";

// tsx honors the web tsconfig's JSX-preserve setting; emulate Next's JSX runtime.
Reflect.set(globalThis, "React", React);

function overview(sourceSignals: AgentsOverview["sourceSignals"]): AgentsOverview {
  return {
    counts: { total: 1, running: 0, idle: 0, paused: 1, failed: 0 },
    findsToday: 0,
    spendTodayUsd: 0,
    dailyCapUsd: 1,
    openProposals: 0,
    sourceSignals,
    lastFind: null,
  };
}

function qualificationAgent(status: AgentListItem["status"]): AgentListItem {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    key: "qualify-award-lead",
    name: "Award lead qualifier",
    agentType: "qualify_award_lead",
    goal: "Qualify source signals",
    status,
    cadenceSeconds: 300,
    budgetSharePct: null,
    dailyBudgetUsd: null,
    nextTickAt: null,
    lastTickAt: null,
    consecutiveFailures: 0,
    spendTodayUsd: 0,
    ticksToday: 0,
    lastTickOutcome: null,
    lastTickFinishedAt: null,
    errorsLast24h: 0,
    findsToday: 0,
  };
}

const zeroState = renderToStaticMarkup(
  createElement(LiveStrip, {
    loading: false,
    error: null,
    overview: overview({
      queuedQualification: 0,
      qualifying: 0,
      qualifiedToday: 0,
      rejectedToday: 0,
      quarantined: 0,
      latestQualification: null,
    }),
  }),
);
assert.match(zeroState, /Source signals/);
assert.match(zeroState, /Qualified today: <a href="\/feed">0<\/a>/);
assert.match(zeroState, /Rejected today: 0/);
assert.match(zeroState, /Quarantined legacy: 0/);
assert.match(zeroState, /Weak signals are not Targets until official-site qualification passes\./);
assert.doesNotMatch(zeroState, /\/leads/);

const nonzeroState = renderToStaticMarkup(
  createElement(LiveStrip, {
    loading: false,
    error: null,
    overview: overview({
      queuedQualification: 7,
      qualifying: 2,
      qualifiedToday: 3,
      rejectedToday: 4,
      quarantined: 5,
      latestQualification: "2026-08-24T11:30:00.000Z",
    }),
  }),
);
assert.match(nonzeroState, /7 queued · 2 qualifying/);
assert.match(nonzeroState, /Qualified today: <a href="\/feed">3<\/a>/);
assert.match(nonzeroState, /Latest qualification/);

const pausedLadder = renderToStaticMarkup(
  createElement(QualificationLadder, { agents: [qualificationAgent("paused")] }),
);
assert.match(pausedLadder, /Qualification ladder/);
assert.match(pausedLadder, /Qualification agent: <strong data-testid="qualification-agent-state">Paused<\/strong>/);
assert.match(pausedLadder, /USAspending creates a quarantined source signal\./);
assert.match(pausedLadder, /Exa proposes the company&#x27;s official domain\./);
assert.match(pausedLadder, /Official site, location, and CAGE or UEI verify the identity\./);
assert.match(
  pausedLadder,
  /Official-site URL and excerpt evidence verify manufacturing and aerospace relevance\./,
);
assert.match(pausedLadder, /Ownership and actionability screening determines whether it can proceed\./);
assert.match(pausedLadder, /Only a passing, evidence-backed manufacturer creates a Lead\./);
assert.doesNotMatch(pausedLadder, /<table/);

const runningLadder = renderToStaticMarkup(
  createElement(QualificationLadder, { agents: [qualificationAgent("running")] }),
);
assert.match(runningLadder, /Qualification agent: <strong data-testid="qualification-agent-state">Running<\/strong>/);
