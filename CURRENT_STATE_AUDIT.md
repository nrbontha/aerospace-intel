# Current State Audit

Audited 2026-08-22. Two independent read-only audits (repository code, Railway operations) plus dataset verification. This file is the authoritative pre-build baseline; keep synchronized with implementation.

## Verdict

The repository is a **solid, honest P0–P4 foundation** (auth/RBAC, append-only provenance chain, centralized OpenRouter gateway with enforced cost budgets, durable pg-boss pipeline, DB-backed UI with zero fake dashboard values). The **entire target-discovery product layer does not exist yet**: leads, candidates, four-axis scoring, known-universe snapshots, campaigns/frontier, labs/benchmarks, feedback channels, Target Feed UX.

## Stack (existing, preserved)

| Layer | Choice |
| --- | --- |
| Web | Next.js 16 App Router, React 19, route handlers under `/api/v1`, SSE |
| Auth | Server sessions, Argon2id (`@node-rs/argon2`), SHA-256 session-token hashes, CSRF, rate limiting, roles `admin/analyst/viewer` (`apps/web/src/lib/auth.ts`, `lib/rbac.ts`) |
| Data | PostgreSQL 18 (Railway plugin), Drizzle ORM 0.45, forward-only SQL migrations, custom runner (`packages/database/src/migrate.ts`) |
| Queue | pg-boss 12.27 (Postgres-backed), worker = plain Node process with `/health` server |
| Validation | Zod 4 everywhere (`@asi/contracts`, env schema in `@asi/config`) |
| Models | Single OpenRouter gateway (`packages/research/src/openrouter.ts`): fast/deep routing + fallback, Zod structured outputs, retry classification, per-attempt telemetry incl. `model_usage.cost_usd` |
| Safety | SSRF-guarded safe-fetch, tool manifests, append-only triggers on evidence/observations/usage/audit tables |

## What works (verified in code)

- Login/logout/admin user CRUD, RBAC fail-closed (e2e asserts 401/403 paths).
- Catalog domain: companies/aliases/domains/identifiers, facilities, contacts, capabilities, certifications, parts/platforms/variants/subsystems, facility qualifications, contracts/procurements — full CRUD + deep company profile page.
- Provenance chain: `data_sources → source_documents (sha256 uidx) → evidence → observations → proposals → proposal_reviews → canonical_facts`; merge/revert with snapshots (`entity_merges`).
- Research runs: enqueue → claim transactionally → tool-budgeted workflows (`company/source/discover/platform/part/refresh`) → cancel + SSE live progress; costs persisted and gated per-run/per-day.
- Imports/exports (CSV/JSON), analytics from real aggregates, saved views, audit events.
- Ops: backup/restore/rehearsal scripts with digest verification; docker-compose local stack with shared storage.

## What is missing vs the product spec (grep-verified zero hits)

1. **Raw leads** separate from canonical companies; identity-resolution *candidate* records (merges exist, resolution proposals do not).
2. **Known-universe snapshots** (dated, named) and membership/novelty relative to them.
3. **Golden set**: import, labels (fit vs actionability separate), review workflow, example types.
4. **Four axes** Fit/Novelty/Confidence/Actionability; separate research-priority vs partner-review-priority.
5. **Campaigns** (pause/resume/lifecycle) and **frontier items**; only single research runs exist.
6. **Scoring programs** (safe DSL), frozen feature snapshots, experiment journal, champion/challenger.
7. **Benchmarks**: enrichment-vs-Grata, blind discovery, entity resolution, evidence quality, efficiency.
8. **Feedback channels** (identity / investment / research-quality / source).
9. **Target Feed** as default post-login surface; partner-review queue UX; Qualifier Lab / Research Lab screens.
10. XLSX importers for golden-set workbook, Grata sheet, 246-company pipeline.

## Dataset interpretation (from workbook analysis, 2026-08-22)

- `ADCO-golden-set.xlsx`: sheets `Golden Set Targets` (criteria block + 18 companies), `Grata Data` (18×49 enrichment cols), `Database Sources` (5 nominations: OASIS, PRI/Nadcap, SAM, USAspending, Boeing IPC).
- Golden examples are **mixed types**: 4 public-subsidiary wish-list rows (Rosen, JPE, Southwest Antennas, Servotronics) are ideal-archetype-but-unactionable, not positives. Labels must be proposed + human-reviewed.
- `ADCO-pipeline.xlsx`: 246 targets × 24 cols. Priority filled on only 3 rows; Stage/Status columns entirely empty; **EBITDA is placeholder 18%-of-revenue in 50 of 54 rows** — never treat as real financials. Priority preserved as held-out diagnostic only; never a feature or label without explicit thesis-version change.
- Grata data is an 18-company enrichment reference, not a universe. Novelty language: `not_matched_to_current_known_universe` / `possible_known_universe_match` / `confirmed_known_company` / `unable_to_assess`.
- Domain overlap: 12 of 18 golden companies already present in the 246-row pipeline.

## Operations state (Railway project b7bca8ba, us-west2)

- web: Online at https://aero-intel.up.railway.app, GitHub auto-deploy `nrbontha/aerospace-intel@main`, healthcheck `/api/v1/health`, last deploy eda4739.
- worker: **Failed — no active deployment.** Root cause: only live deployment was platform-torn-down ~20 s after successful build+healthcheck (SIGTERM, deployment REMOVED, no replacement). Aggravators: `RESEARCH_SHARED_STORAGE=false` disables all research handlers on Railway (per-service volumes cannot share storage; web returns 409 for research writes by design), restartPolicyType regressed to NEVER. Fix = redeploy worker + restore restart policy; research-write enablement needs shared object storage or inline-document job payloads.
- Postgres 18.6 Online, internal-only. Contents: demo catalog seed (13 primes, platforms/parts/capabilities/facilities), 3 users, **zero** leads/research/evidence rows. Migration 0000 applied 2026-08-17.
- Env: `OPENROUTER_API_KEY` present on worker, absent on web (web makes no model calls — correct). Cost limits implemented under names `OPENROUTER_MAX_COST_PER_RUN_USD` / `_PER_DAY_USD` (spec's `*_MAX_DAILY_COST_USD` alias not required; documented here).
- **Backup taken 2026-08-22T23:47Z** (`backups/prod-20260822T234724Z/database.dump`, sha256 `4e2aa95e…61c1e07e`, 113 tables verified via pg_restore --list) prior to any new migrations. Prior rehearsal dirs proved the restore path.

## Known defects found

- `tests/e2e/catalog.spec.ts` fills label "Email address" but login form uses "Username" → spec cannot pass (fixed this audit round).
- Unit-test surface thin (~589 LOC) vs ~46k LOC app; nothing covers repositories/routes/workflows/handlers.
- Dockerfile runners copy devDependencies (bloat, not breakage).

## Build sequence adopted

1. Additive migration 0001 + Drizzle schema + Zod contracts for all missing domains (serial contract producer; tested against a prod-copy scratch DB).
2. Parallel wave: imports/snapshots, four-axis scoring + DSL + journal, campaigns/frontier + handlers, feedback channels, Target Feed/candidate-profile/golden-set UI.
3. Benchmarks + bounded real campaign (OpenRouter model `stealth/ox-alpha`, $1/day hard cap, free-tier pricing) + e2e expansion + Railway worker redeploy + queue-recovery validation.
4. Independent reviews (architecture, investment workflow, methodology, research quality, security, tests), fix high-value findings, final report.
