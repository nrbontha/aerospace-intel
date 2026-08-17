# Aerospace Supplier Intelligence — Implementation Plan

## Status and fixed sequence

This is a design contract for an independent system. It must not import from, call, share a database or volume with, or reuse credentials from Saucer or Almanac. A heading is not a claim; the observed status below is.

**Observed 2026-08-17T13:17Z — keep local and Railway separate.** P0–P4 are implemented in this tree and have been exercised **locally** (Hitchiner research, review, canonical tracing, scoring, catalog, import/export). P5 is **not** complete: a shared object store and production restore/PITR remain open. Production research writes are **disabled** (`RESEARCH_SHARED_STORAGE=false`) because web and worker volumes do not share bytes. The production worker is **stopped** (0 replicas, GitHub disconnected) so a walkthrough cannot incur OpenRouter cost. Production is limited availability, not generally available. The demo is Postgres catalog data only. See `OPERATIONS.md`.

| Environment | `GET /api/v1/ops/status` | Catalog |
| --- | --- | --- |
| Railway production (GitHub `nrbontha/aerospace-intel@main` on web; worker stopped) | `drainable: true`, **`alerts: []`**, queue failed 0, `documentCount` 0; `POST /api/v1/research-runs` **409** | demo seed (`totalItems` 13). Local Hitchiner research was not copied. Worker is stopped for the walkthrough. No research job was enqueued, so document visibility across web/worker volumes was not tested. |
| Local only (`http://127.0.0.1:3000`) | `drainable: true`, **`queue_failed` (1 historical failed job)** | Hitchiner + import probe (`totalItems` 2), `documentCount` 1 |

The local `queue_failed` alert is **not** a Railway observation. Do not advertise planned integrations, replay guarantees, or a shared object store. The production catalog is a demo seed, not operational qualification evidence.

## Fixed platform

- npm workspaces, Node.js 22, strict ESM TypeScript.
- `apps/web`: Next.js 16 App Router, React 19, Tailwind 4, TanStack Table, Recharts.
- `apps/worker`: durable `pg-boss` consumers.
- `packages/contracts`: Zod 4 domain/API schemas and OpenAPI 3.1 inputs.
- `packages/database`: PostgreSQL 17, Drizzle ORM, `pg`; root `migrations/` is the migration history.
- `packages/research`: structured model gateway, safe tools, typed workflows, pure scoring/entity-resolution logic.
- `packages/config`: runtime environment parsing and client/server exposure boundary.
- `packages/ui`: reusable visual primitives, never domain rules.
- REST under `/api/v1`: success `{ "data": ..., "meta"?: ... }`; failure `{ "error": { "code": ..., "message": ..., "details"?: ... } }`.
- Durable documents under configurable `STORAGE_PATH`; no file bytes in ephemeral web storage.

## Cross-workstream interfaces

| Producer           | Consumer             | Contract                                                                                                              |
| ------------------ | -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `@asi/contracts`   | every workspace      | Versioned Zod schemas and enum tuples. Contracts never import database.                                               |
| `@asi/config`      | server workspaces    | Parsed typed environment. Secrets stay server-only; `OPENROUTER_API_KEY` is process-environment-only.                 |
| `@asi/database`    | web, worker          | Transactional repositories over UUID-keyed plural snake_case tables.                                                  |
| web API            | browser/clients      | `/api/v1`, validated bodies, common envelopes, stable error codes, OpenAPI 3.1.                                       |
| web                | worker               | Durable versioned job payload, idempotency key, actor/request context, persisted target IDs.                          |
| worker/research    | web                  | Persisted run/stage/attempt state; SSE is only a projection of database truth.                                        |
| tool catalog       | research executor    | Capability, input/output schemas, permissions, timeout, retry policy, handler identity; executor enforces all fields. |
| ingestion/research | review               | Immutable observations with source-document provenance; neither writes canonical values.                              |
| review             | canonical projection | Proposal plus append-only accept/reject event; acceptance advances a current pointer without deleting history.        |
| storage            | database             | Storage holds bytes; database holds a durable relative key, SHA-256 digest, media metadata, and provenance.           |

API, job, tool, and artifact payloads carry schema versions. Producers and consumers validate; unknown versions fail visibly.

## P0 — Contract and skeleton

1. Land the four architecture documents before feature implementation.
2. Establish the npm workspace, strict TypeScript base config, composable scripts, and exports for `@asi/web`, `@asi/worker`, `@asi/contracts`, `@asi/database`, `@asi/research`, `@asi/config`, and `@asi/ui`.
3. Define shared enum tuples and API envelopes before consumers; database may consume contract tuples, never vice versa.
4. Establish Drizzle schema and ordered migrations with UUIDs, explicit delete behavior, `timestamptz`, and numeric checks.
5. Establish environment parsing and server/browser separation.

**Exit evidence:** dependency direction is acyclic; clean migrations apply; contracts, database enums, and OpenAPI agree; docs label missing behavior as planned.

## P1 — Secure durable foundation

1. Implement users, roles (`admin`, `analyst`, `viewer`), Argon2id verification, random session tokens with only SHA-256 hashes persisted, expiry/revocation, and disabled-user fail-closed behavior.
2. Authenticate every route except `/login`, `/api/v1/auth/login`, and health checks. Enforce server-side roles and CSRF on mutations; use secure httpOnly sameSite=lax cookies.
3. Implement append-only audit, durable digest-verified storage, transactional queueing, idempotent job handlers, bounded retries, and durable terminal failures.
4. Implement foundational company/facility/taxonomy/source repositories and APIs.
5. Implement reversible entity merges with persisted events/snapshots. Fuzzy names may propose, never auto-merge.

**Exit evidence:** auth failure cases and roles fail closed; a job survives restart and duplicate delivery; documents survive restart and verify by digest; audit history cannot be updated/deleted through application paths.

## P2 — Sources, ingestion, evidence, review

1. Implement independent `data_sources` and immutable `source_documents`; a recurring source is not a retrieved/uploaded artifact and need not link to a company.
2. Permit bounded public HTTP(S) retrieval and authorized uploads only. Restricted/paywalled records remain metadata-only absent user-supplied authorized material.
3. On every redirect resolve DNS, reject loopback/private/link-local/reserved targets, and bound redirects, time, bytes, and media types.
4. Implement import batches with row validation, dry-run summary, idempotent commit, and durable errors.
5. Persist append-only observations with locators, bounded excerpts, raw values, confidence, asserted time, and extraction method.
6. Implement proposal → preview/diff → accepted/rejected review event → canonical fact/current pointer. Rejection/replacement preserves evidence and decisions.
7. Keep certifications separate from qualifications. Qualification granularity is Facility × Part × Platform/Variant × Subsystem × Customer × Time where known.

**Exit evidence:** an authorized document reaches observation, review, and canonical selection without evidence mutation/deletion; rejection is auditable; inaccessible content is never represented as searched.

## P3 — Bounded research orchestration

1. Implement one structured OpenRouter gateway for Zod output, model routing, budgets, timeout, retry classification, cost, and per-attempt provenance. Never log, persist, expose, or prompt with the API key.
2. Persist runtime-validated intent, plan, tool execution, proposal/synthesis, and presentation artifacts with versions, hashes, identities, timestamps, and durable attempt links. Types alone do not prove replayability.
3. Implement a declarative tool catalog whose executor enforces permissions, schemas, timeout, byte limits, and retries.
4. Search local reviewed evidence first, then optional attributed external sources; retain source and locator for every result.
5. Bound stages, tools, wall time, tokens/cost, and retries. Retry only transient 429/5xx/network/timeout failures, honor `Retry-After`, use capped jitter, and never retry quota exhaustion or policy/validation errors.
6. Treat fetched/model text as untrusted data. It cannot change policy, add tools, reveal secrets, or authorize access.
7. Research creates observations and proposals, never canonical writes; failed postconditions remain failures.

**Exit evidence:** a run resumes after worker restart, terminates durably under budget, preserves replay inputs/artifacts, resists instruction-bearing documents, and links each proposal to evidence.

## P4 — Analyst product

1. Implement search and detail views for companies, aliases, facilities, capabilities, customers, parts, platforms/variants, subsystems, certifications, qualifications, and evidence timelines.
2. Implement review queues, evidence diffs, reasons, canonical replacement, and reversible merges.
3. Expose source/document, import, research run/stage/attempt, and durable failure state by role.
4. Compute source and supplier scores from nullable dimensions. Missing dimensions remain `null` and reduce completeness; never coerce to zero.
5. Use only the fixed sole-source enum, default `not_assessed`, and always show scope/time/evidence; company claims remain identified as claims.
6. Add accessible tables, filters, pagination, charts, exports, and authenticated SSE backed by durable state.

**Exit evidence:** displayed canonical values trace to review event, observation, document locator, and source; qualification dimensions and unknowns remain visible; server permissions match roles.

## P5 — Production readiness

1. Deploy web and worker separately with PostgreSQL 17 and an independent persistent volume.
2. Define migration rollout/rollback, backups, restore rehearsal, storage/database reconciliation, and job draining.
3. Add correlated logs/metrics/alerts while redacting secrets, sessions, private contact data, and document content.
4. Exercise concurrency, at-least-once delivery, restart, exhaustion, storage failure, SSRF redirects, oversized input, malformed model output, and review conflicts.
5. Complete auth/CSRF/session/SSRF/upload/prompt-injection/privacy/retention reviews plus accessibility, performance, compatibility, and operations checks.
6. Roll out with explicit availability and known limitations; never advertise planned integrations or replay guarantees.

**Exit evidence:** restore/restart preserves documents, jobs, and evidence links; security/failure modes have observed verification; operators can diagnose durable failures without sensitive telemetry.

**Observed P5 gap:** local restore rehearsal (`npm run ops:rehearse`) and local security/failure-mode tests exist. The production worker is stopped (0 replicas, GitHub disconnected, restart policy `NEVER`) with `RESEARCH_SHARED_STORAGE=false`. Web and worker still do **not** share one object store. Do not set the flag true on split volumes. Production restore/PITR has not been observed. Do not mark P5 done until those are closed.

## Reference lessons, not dependencies

**Saucer:** adopt immutable canonical bytes plus SHA-256, predecessor/supersession lineage, read verification, idempotent retries, structured LLM attempts with budgets/provenance, durable at-least-once jobs, evidence-first search, and transient-only bounded retry. Do not copy process-local quota state or return nominal success after a final structured-output/postcondition failure. Enforce immutability in database/repositories, not prose.

**Almanac:** adopt intent → plan → execution → proposal/presentation artifacts, a tool catalog, and propose → preview → approve/reject → version/promote. Add runtime validation, durable populated hashes/cost/model fields, executor enforcement, actor/reason/content IDs, and append-only audit. Avoid mutable singleton registries, process-global traces, process-local stores, timestamp-only identities, and aspirational replay/telemetry claims.

A phase is done only when persistence, contracts, authorization, failures, and user path agree end to end. Scaffolds, types, empty fields, and roadmap prose are not completion evidence.
