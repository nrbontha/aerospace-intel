# Redesign Plan — Autonomous Research Agents + Three-Pillar IA

Status: PLAN (approved direction, no code changes yet)
Date: 2026-08-23
Depends on: existing stack (Next 16 web, worker + pg-boss, Drizzle/PG18, OpenRouter gateway, provenance chain, campaigns/frontier machinery)

---

## 0. Product thesis

One continuously-updated dataset of acquisition targets, maintained by autonomous research agents, surfaced through a single tiered table. Humans judge; agents work. Three top-level tabs — **Targets**, **Research**, **Universe** — plus a collapsed **Admin**. No more than four visible nav entries.

Runtime decision (approved): **evolve the in-house worker** (Node + pg-boss + our OpenRouter gateway). Postgres remains the agent's long-horizon memory; the LLM proposes, deterministic code verifies. Hermes stays a general platform, not the production sourcing runtime; OMP-style interactive harnesses are out of scope for unattended operation.

---

## 1. Agent runtime ("control plane")

### 1.1 Schema (migration `0003_agent_runtime.sql`, additive)

```
research_agents (
  id uuid pk,
  key text unique,                    -- stable slug, e.g. 'discover-usaspending'
  name text,
  agent_type agent_type NOT NULL,     -- enum: discover_source | enrich_candidate |
                                      --   monitor_ownership | refresh_stale | golden_neighbor
  goal text,                          -- human-readable mission statement
  seed_scope jsonb default '{}',      -- sources/platforms/geographies/candidate filters
  policy_version text,                -- ResearchPolicy linkage
  budget_share_pct numeric(5,2),      -- share of the daily global cap
  daily_budget_usd numeric(10,2),     -- absolute floor/ceiling option
  cadence_seconds int default 900,    -- min time between ticks
  status agent_status default 'idle', -- idle | running | paused | failed
  last_tick_at timestamptz,
  next_tick_at timestamptz,
  heartbeat_at timestamptz,
  lease_expires_at timestamptz,
  leased_by text,                     -- worker instance id
  consecutive_failures int default 0,
  spend_today_usd numeric(10,2) default 0,
  config jsonb default '{}',
  created_by uuid references users(id),
  created_at, updated_at
)

agent_ticks (
  id uuid pk,
  agent_id fk cascade,
  started_at, finished_at,
  outcome tick_outcome,               -- planned | executed | stuck | done |
                                      --   budget_exhausted | error | preempted
  plan jsonb,                         -- proposed action batch + reasoning summary
  actions_executed int,
  findings jsonb,                     -- {newLeads,newCandidates,newObservations,...}
  cost_usd numeric(10,6),
  error text
)
-- agent_ticks: keep last N per agent (bounded by scheduled cleanup job), not append-only
```

Reuse without duplication: frontier_items, leads, identity matching, observations→evidence→proposals, candidate_scores, model_usage telemetry, campaign budget helpers.

### 1.2 Supervisor (worker process, new `apps/worker/src/supervisor/`)

> **Status: implemented** — `apps/worker/src/supervisor/supervisor.ts` (lease/tick/heartbeat/takeover, budget gates) + `packages/database/src/agents/{registry,ticks}.ts`; DB integration coverage in `tests/supervisor.db.test.ts` and `tests/agent-budget.db.test.ts`.

Single long-lived loop inside the existing worker process:

```
every ~5s:
  due = SELECT * FROM research_agents
        WHERE status='running' AND (next_tick_at IS NULL OR next_tick_at <= now())
        ORDER BY next_tick_at FOR UPDATE SKIP LOCKED LIMIT maxConcurrentAgents
  for each: acquire lease (heartbeat_at=now(), lease_expires_at=now()+leaseSeconds,
            leased_by=instanceId) → run one tick (async, bounded wall time)
```

Tick lifecycle per agent:
1. **Precondition gates** — global daily spend vs cap, agent's own budget share, source-policy version, DB reachable. Fail ⇒ `budget_exhausted`/backoff, never crash.
2. **State read** — load goal + relevant durable state (e.g., for `enrich_candidate`: oldest queued_research candidate + its current feature vector + prior tick notes for THIS agent).
3. **Plan (LLM)** — small structured prompt: "Given goal G, state S, recent ticks R, propose the next batch of actions." Output validated against the agent-type action manifest (Zod). Invalid ⇒ one repair retry ⇒ `stuck` (recorded, retried next cadence).
4. **Execute** — deterministic executors run proposed actions through the existing tool catalog only (`fetch_url` via safe-fetch, `read_source_document`; `search_web` stays unimplemented until a provider exists). Every persisted fact goes through recordCompanyResearchArtifacts / lead ingest — full provenance, never direct canonical writes.
5. **Reflect** — deterministic post-checks: did the batch produce state changes? exhausted its work slice? repeated failure pattern? Outcome recorded; `next_tick_at` set by backoff or cadence.
6. **Heartbeat + release** — heartbeat during execution every 15s; lease released on completion.

**Self-healing:** if a worker dies mid-tick, `lease_expires_at` passes and any supervisor instance reclaims the agent (SKIP LOCKED + stale-lease predicate). Human intervention is never required to unstick; pause/kill exist for policy reasons, not recovery.

**Budgets:** global daily cap (env, default $1) checked before every model call (existing gate); each agent additionally capped by `budget_share_pct`. Spend attributed via model_usage rows tagged with agent_id.

### 1.3 Agent types v1 (all defined at launch)

> **Status: NOT implemented** — the five `agent_type` enum values and handler-registry slots exist, but the default registry seed rows and real per-type executors do not yet (`apps/worker/src/supervisor/handlers.ts` registers passthrough no-ops).


| Key | Type | Mission | Work source | Outputs |
| --- | --- | --- | --- | --- |
| `discover-usaspending` | discover_source | Find new candidate companies from federal award recipients | Frontier expansion (existing strategy) + lead ingest + auto-promote | leads, companies, queued candidates |
| `discover-sam` | discover_source | Same over SAM entity search (needs SAM_API_KEY; idles honestly without) | SAM client | leads |
| `enrich-queue` | enrich_candidate | Deep-research queued candidates oldest-first until evidence suffices | candidates WHERE status='queued_research' | observations, rescored axes, research_ready |
| `monitor-ownership` | monitor_ownership | Re-verify ownership on partner_review/shortlist/watchlist older than N days | staleness query | refreshed ownership observations, conflict flags |
| `refresh-stale` | refresh_stale | Re-fetch stale evidence documents (>30d) backing live scores | evidence age query | freshened docs, updated confidence |
| `golden-neighbor` | golden_neighbor | For positively-reviewed golden examples, find same-platform / same-qualification peers | reviewed golden labels + qualification graph | leads, candidates |

Each ships with a default registry row (seeded migration insert), paused=false except where keys are missing (`discover-sam` seeds paused). Creating NEW agent types later = adding a type enum value + executor manifest + registry row; the control plane renders it automatically.

### 1.4 Control-plane API

> **Status: implemented** — `apps/web/src/app/api/v1/agents/` (list, overview, detail, ticks, pause/resume/kill lifecycle, register, patch), audited and role-gated as specified.

```
GET    /api/v1/agents                  list + health/spend/finds aggregates
GET    /api/v1/agents/overview         one-call dashboard payload (counts, $ today, last finds)
GET    /api/v1/agents/:id              detail + recent ticks
GET    /api/v1/agents/:id/ticks        paginated tick log
POST   /api/v1/agents/:id/pause|resume (admin/analyst, audited)
POST   /api/v1/agents/:id/kill         (admin; aborts current tick, marks paused, reason required)
POST   /api/v1/agents                  (admin; register new agent of a known type)
PATCH  /api/v1/agents/:id              (admin; cadence/budget/seeds edits, audited)
```

---

## 2. Targets tab (the one big table)

### 2.1 Tier system

Engine-proposed, human-overridden, overrides audited (already supported mechanically; formalized):

| Tier | Engine source | Meaning |
| --- | --- | --- |
| **High interest** 🔴 | routing = partner_review **OR** human Strong Fit **OR** golden-set member | "you owe this a look" |
| **Evaluate** 🟡 | research_ready | agent done; awaiting human judgment |
| **Researching** 🔵 | in_research | agent actively working |
| **Needs research** ⚪ | queued_research | novel but thin evidence |
| **Low interest** ⚫ | rejected (with reason) | your feedback |
| **Watchlist** 👁 | watchlist / hold | great business, blocked |

Golden set members enter the big table as **High interest** with an explicit annotation chip: *"reference example — interest not known mutual"* (per decision; their `archetype_fit` labels remain separate calibration data).

Tier precedence: human override > engine route. Overrides write investment feedback + audit event; engine re-routes never clobber a human tier (existing preservation logic).

### 2.2 Confidence surfacing (replaces auto-accept question)

Every material field keeps provenance; we surface rather than relax:

- Table-level **Confidence chip** per row (axis score banded: strong/medium/weak/thin).
- Profile-level **field badges**: each fact shows source count, primary-vs-derived, freshness ("observed 12d ago"), and a LOW-CONFIDENCE flag when <2 independent sources or conflicting observations exist.
- "Additional context" drawer: whyInteresting / risks / unknowns lists (exists), plus per-field evidence links (exists).

No auto-accept in v1: facts stay behind the proposal queue. If triage volume becomes painful, a scoped fast-path (auto-accept non-sensitive fields WITH low-confidence flags) is a config flip designed but off by default.

### 2.3 Table spec

Columns: Tier · Company · Domain · HQ · Revenue band · Ownership · Novelty badge · Confidence · Last researched · Age of newest evidence · Source (discovery origin) · Actions (status menu incl. Needs-research).
Filters (URL-persisted): tier, novelty, confidence band, ownership, revenue band, campaign/source, has-low-confidence-fields.
Saved views: presets shipped — "Partner queue" (= High interest), "Needs research", "Watchlist", "Fresh finds (24h)".
Dissolved pages: Partner Review becomes a saved view; Research Queue page folds into Needs-research filter.

---

## 3. Research tab (agent control plane)

Layout:
- **Live strip** (always visible): running agents · $ today vs cap · open proposals · last find timestamp.
- **Agents table**: name/type · status dot (running/paused/failed/idle) · current activity ("enriching Zephyr International, page 2/3") · finds-since-last-look (links into Targets filtered by discovery origin) · spend today vs share · consecutive failures · cadence · controls (pause/resume/kill).
- **Tick drawer**: per-agent recent ticks with plan summaries, outcomes, findings deltas, cost.
- **Campaigns subsection**: compact legacy list (start/pause/resume/cancel) — campaigns remain available for deliberate bounded experiments; continuous agents are the always-on layer above them.

---

## 4. Universe tab (consolidation)

Secondary sub-tabs *within* the page (not left-nav):
1. **Companies** — merged known-universe browser + company catalog (today two overlapping views).
2. **Identity review** — probable-match queue + merges (from /merges).
3. **Golden Set** — reference examples + label review (calibration data).
4. **Sources** — registry with access states + unmined filter.
Catalog drill-downs (facilities, parts, platforms, qualifications, capabilities, customers) reachable from company profiles and Universe search, not as tabs.

## 5. Navigation (final)

```
Targets | Research | Universe | Admin ▾ (Experiments · Imports · Scoring programs · Users)
```

Removed left-nav entries become redirects: /dashboard→/, /partner-review→/feed?tier=high_interest, /research-queue→/feed?tier=needs_research, /data-sources→/universe/sources, /merges→/universe/identity-review, /golden-set→/universe/golden-set, /companies→/universe/companies, /campaigns→/research (agents view), /research-runs→/research/runs.

---

## 6. Delivery sequence (board tickets mirror this)

1. **M3 schema + contracts** (agent tables/enums) — tested on prod-copy scratch DB.
2. **Supervisor runtime** (lease/tick/heartbeat/takeover) + budget integration.
3. **Planner step + action manifests** (LLM propose → zod-validated → deterministic execute).
4. **Agent types 1–6** (registry seeds + executors; discover-usaspending and enrich-queue first — they close the autonomy loop end-to-end).
5. **Agents API** (overview aggregate + lifecycle + ticks).
6. **Targets tier engine + override audit**.
7. **Targets table rebuild** (tier column, confidence chips, saved views, dissolves Partner Review/Research Queue).
8. **Golden-set-as-High-interest seeding** with mutual-interest annotation.
9. **Research tab control-plane UI** (live strip, agents table, tick drawer).
10. **Universe consolidation + nav collapse + redirects.**
11. **Docs sync + e2e coverage** (agent lifecycle e2e: start → finds → tier change → export).

Sequencing note: 1–5 serial-ish (runtime core), 6–8 parallelizable after, 9–11 after 5. Old campaign machinery is NOT removed — agents sit beside it; deprecation is a future decision after agents prove out.

## 7. Explicit non-goals (v1)

- No arbitrary model-generated code execution (declarative action manifests only).
- No paid models by default; stronger planner slot reserved but unset.
- No multi-agent negotiation/delegation; each agent owns an independent goal.
- No auto-acceptance of sensitive fields (ownership/financial always human-reviewed).
