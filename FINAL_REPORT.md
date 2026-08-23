# Final Report — Autonomous Aerospace PE Target-Discovery Engine

Date: 2026-08-23 · Repository: `/Users/nrb/Projects/aerospace-supplier-intelligence` (GitHub `nrbontha/aerospace-intel@main`, HEAD `87979e1`) · Railway project `aerospace-supplier-intelligence` (b7bca8ba)

## Existing system discovered

Next.js 16 App Router / React 19 monorepo (`apps/web`, `apps/worker`; packages `database` Drizzle ORM, `research` OpenRouter gateway + workflows, `contracts` Zod, `config`, `ui`), PostgreSQL 18 on Railway, pg-boss durable queue, Argon2id session auth with admin/analyst/viewer RBAC. Preserved in full: login, domain, deployment path, existing catalog/provenance code, existing data (13-company demo catalog, users). No replacement, no wipes; all migrations additive and forward-only.

## What was built this session

1. **Data model** — migrations `0001_known_universe.sql` (snapshots, members append-only, golden examples, leads, identity-match candidates) and `0002_candidate_discovery.sql` (candidates, append-only candidate_scores + experiment_runs, feature snapshots, scoring programs, channel-discriminated feedback, research questions, campaigns, idempotency-keyed frontier items). Both tested against a restored production copy (row counts unchanged, re-run no-op) before landing; `0001`/`0002` applied live on Railway.
2. **Imports** — SheetJS parsers for both real ADCO workbooks (positional mapping incl. duplicate `Name` headers, Excel serial dates, Priority preserved verbatim in raw payloads); idempotent sha-keyed snapshot service; rule-based golden label proposals; five database-source nominations with honest access states; repeatable CLI + upload API + review API (audit-evented).
3. **Four-axis scoring engine** — strict leak-proof feature schema, safe JSON program DSL with severe vetoes (sponsor/public ownership caps actionability at 25; unknown revenue can never satisfy size gates; missing ownership ⇒ null actionability), novelty/confidence calculators, research-vs-partner routing, seeded mutation + gate-enforced promotion over the frozen 18-company fixture set.
4. **Durable research system** — campaigns (plan/start/pause/resume/cancel/budget-exhausted lifecycle), frontier runner proven restart-safe (stale-claim recovery inserts zero duplicate children across a simulated crash), atomic budget flip with daily cap, self-re-enqueueing worker slice, USAspending + SAM source adapters, lead ingestion with exact/trigram identity resolution (probables never auto-merge), candidate promotion → live company research workflow → evidence-backed rescore.
5. **Product surface** — Target Feed (default post-login), Partner Review queue, Candidate Profile (score timeline, feature snapshot viewer, rationale lists, feedback history), Golden Set review, Known Universe browser + novelty search, Campaigns UI, Qualifier/Research Lab, Sources upgrades, light/dark theme, CSV/JSONL export including candidates.
6. **Two-loop harness** — offline scorer evaluation (LOOCV, seeded bootstrap CI, veto audit, leakage scan, complexity), champion/challenger journal with server-side gate enforcement; enrichment / entity-resolution / blind-discovery benchmarks with journaled runs.

## Real validation (OpenRouter model `stealth/ox-alpha`, free tier)

| Metric | Result |
| --- | --- |
| Golden-set rows imported | 18 (proposals: 11 strong / 3 caveat / 4 ideal-but-unactionable) |
| Database-source records | 5 |
| Grata enrichment rows | 18 (benchmark reference only) |
| Pipeline snapshot members | 246, Priority verbatim, never trained on |
| Known-universe snapshots | 3 dated + versioned |
| Live campaign | `usaspending-real-2026-08-23`: 39 frontier items → **37 real raw leads** from actual federal award data |
| Resolved companies | 2 analyst-verified creations (Zephyr International — patented rescue-hoist GSE OEM, CAGE 3CAT3; York Precision Machining & Hydraulics, CAGE 81A16) |
| Confirmed known matches | golden↔pipeline overlap = 12 members |
| Novel candidates | both promoted at novelty 100 (`not_matched_to_current_known_universe`), routed honestly to research (confidence 0) |
| Deep research | Zephyr: 19 observations + evidence across 3 fetched pages, confidence 0→10, status `research_ready`, replay-deduped |
| Enrichment benchmark | 18/18 enriched; match rates: HQ city/state 100%, PMA mention 100%, manufactures 100%, services 87.5%, overall 75%; honest zero coverage on revenue/headcount (sites don't publish them); ownership 17% (registry-only fact) |
| Entity-resolution benchmark | 222 ground-truth cases @ threshold 0.72: probable precision **0.992**, recall 0.867, F1 0.925; required confusable pair (Zephyr Tool Group vs Zephyr International) safe |
| Blind-discovery benchmark | no name/domain queries; 2 knowns rediscovered via probable signals; 35 novel leads; honest structural finding: golden small-manufacturer archetype under-represented in federal recipient lists |
| Total model/tool spend | **≈ $0.0069** (caps: $0.50/run, $1/day enforced in code) |

## Verification

- `tsc -b` clean across all six workspaces.
- Unit/integration: **282 passed**, 46 env-gated skips; gated suites with healthy DB: **18/18** (imports idempotency + Priority preservation, champion flip/fallback, promotion-gate 409/pass flow, two-document provenance attribution, exports, live candidate research).
- E2E Playwright: **11 passed**, 1 env-gated skip (auth fail-closed, catalog, golden-set review, target feed, partner actions, campaigns lifecycle).
- Production build passes; migrations pass; web + worker services start; queue restart recovery proven (crash simulation + worker redeploy).
- Railway: web Online (GitHub auto-deploy, health 200, login POST verified), worker redeployed Online (health OK; research handlers intentionally disabled until shared object storage exists — `RESEARCH_SHARED_STORAGE=false` returns 409 by design), Postgres Online. Backup `backups/prod-20260822T234724Z` (sha256 `4e2aa95e…61c1e07e`) taken before first migration.

## Independent reviews (all findings addressed or dispositioned)

Six reviews (architecture, investment workflow, methodology, research quality, security, tests). Fixed: production scoring now resolves live champions (was hardcoded defaults — the critical find); scorer promotion runs decidePromotion gates server-side; keep-decisions restricted to evaluated axis; per-document evidence attribution with content-sha replay dedupe; proprietary evidence derived from canonical signals (never hardcoded none); restricted-source gate centralized + subject-workflow covered; untrusted-source delimiter neutralized at all five prompt sites; XLSX upload bounds; candidate export; real "needs more research" loop; novelty-search banner honesty.

## Local operation

```bash
cp .env.example .env.local   # then set OPENROUTER_API_KEY etc.
docker compose up -d database
DATABASE_URL=postgresql://asi:local-development-only@localhost:55440/aerospace_supplier_intelligence npx tsx scripts/import-datasets.ts --data-dir data
npm run dev:web            # http://localhost:3000 → Target Feed
npx tsx scripts/run-real-campaign.ts        # bounded live discovery
npx tsx scripts/deep-research-candidate.ts <companyId>
```

Required env: `DATABASE_URL`, `SESSION_SECRET`, `BOOTSTRAP_ADMIN_*`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL_{FAST,DEEP,FALLBACK}` (set to `stealth/ox-alpha`), `OPENROUTER_MAX_COST_PER_RUN_USD`/`_PER_DAY_USD`, `RESEARCH_SHARED_STORAGE=true` locally.

## Known limitations

1. Railway research execution stays disabled until web+worker share object storage (per-service volumes cannot); research runs today execute where storage is shared (local compose / single-process). Next step: S3-compatible volume or inline-document job payloads.
2. No search-provider keys: discovery is source-first through public APIs (USAspending/SAM); `search_web` tool remains unimplemented; consumer SERPs deliberately not scraped.
3. Blind-discovery capability/platform seeds have no expanding strategy yet (measured, not hidden).
4. Benchmark boolean fields are exempt from excerpt verification; identity-based (not host-based) restricted-source matching is a documented follow-up.
5. Priority diagnostic is honest but empty (only 3 Priority values exist pipeline-wide; zero overlapping scored candidates) — becomes meaningful as feedback accrues.
