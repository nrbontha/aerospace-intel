# Operations

This is the operator contract for Aerospace Supplier Intelligence. Local restore rehearsal and the Railway project named below have been observed; do not treat other environments as live without the same checks.

## Runtime topology

- `apps/web` serves App Router, `/api/v1`, and authenticated SSE.
- `apps/worker` consumes `pg-boss` jobs. Health is `/health` and `/ready` on `PORT`.
- PostgreSQL is authoritative for identities, facts, jobs, and audit. Local Compose is 17; the observed Railway plugin is 18.
- `STORAGE_PATH` is authoritative for uploaded/ingested document bytes. Raw-signal investor research also stores database-only source references, bounded quotes, and frozen review evidence; those rows have no `storage_key` and are not full-page archives.
- Web and worker must not share a process. They share PostgreSQL. They may share a document volume only when the platform actually mounts the same store (local Compose does; Railway volumes do not).

## Environment

Copy `.env.example`. Secrets stay in the process environment or a gitignored `.env.local`. Never commit `OPENROUTER_API_KEY`, session secrets, or dumps.

Required outside tests: `DATABASE_URL`, `SESSION_SECRET`. Production also needs `APP_URL`, an **absolute** `STORAGE_PATH` on a persistent volume, and `OPENROUTER_API_KEY` for research workers. Relative `STORAGE_PATH` values are resolved from process cwd (`apps/web` for Next, repo root for `npm run ops:*`).

## Railway

Observed production project `aerospace-supplier-intelligence` (independent of Almanac):

- Web: `https://aero-intel.up.railway.app` — `Dockerfile.web`, health `/api/v1/health`, start `npm run start:web` (migrate then Next). Volume `web-volume` at `/var/lib/asi/storage`.
- Worker release configuration: `Dockerfile.worker`, health `/health`, start `npm run start:worker` (migrate then worker), restart `ON_FAILURE`, sleeping disabled. Volume `worker-volume` at `/var/lib/asi/storage` is independent of `web-volume`. The August walkthrough shutdown below is historical, not the September operating state. Verify the actual Railway service configuration; checked-in settings alone do not prove the deployed settings match.
- Database: Railway PostgreSQL plugin image `postgres-ssl:18` (local Compose remains `postgres:17-bookworm`). Same `DATABASE_URL` on web and worker.
- Bootstrap admin: create inside the web container with `railway ssh -s web -- npm run bootstrap:admin`. Credentials live in gitignored `.env.railway.local`, never in git or image layers.
- Dockerfile `VOLUME` is rejected by Railway; platform volumes replace it. `.dockerignore` excludes `.env*`, `storage/`, `backups/`, `data/`, `exports/`, and `node_modules/`. Private workbook inputs, evidence freezes, exports, and database dumps must not enter this public repository or image layers.

Rollout order: verified backup → stop/drain the old worker → merge/deploy web (migrates on start) → deploy the matching worker → verify database progress. Stop the old worker **before merging main**: the web service auto-deploys from main, and migration `0012_signal_review_state.sql` replaces the old three-column evaluation conflict key with the input-hashed key. The old writer is not compatible with that index. A code-only rollback to the old worker is not safe; rollback requires a coordinated database restore and matching application revision.

## Migrations

- Forward: `npm run db:migrate`; both `start:web` and `start:worker` run it before starting the application. Preserve already-applied migration bytes, including `0011_eval_updated_at.sql`; new changes belong in subsequent migrations.
- Rollback: restore the previous database dump. Drizzle history in `migrations/` is forward-only; do not hand-edit applied SQL.
- After restore, run storage extraction from the matching backup so digests still verify.

## Backups

```bash
npm run ops:backup
```

Writes `backups/<utc-stamp>/{database.dump,storage.tar.gz,manifest.json}` with SHA-256 digests. The directory is gitignored.

Restore, only with an explicit confirm:

```bash
CONFIRM=yes npm run ops:restore -- backups/<utc-stamp>
```

Restore rehearsal against a throwaway database (does not replace the live `asi` database):

```bash
npm run ops:rehearse
```

## Job drain

1. Stop the worker (`SIGTERM`; the process already stops `pg-boss` gracefully).
2. `npm run ops:status` or `GET /api/v1/ops/status` as admin.
3. For queue work, require `drainable` (`created + retry + active = 0`). The investor scheduler is independent of `pg-boss`: also stop its process and check active `signal_review_state` leases before maintenance. Expired leases can be reclaimed; never treat a health response or an empty job queue as proof that model work has drained.
4. Failed jobs stay in `pgboss.job` for diagnosis; do not delete them to force a green drain.

## Storage reconciliation

`GET /api/v1/ops/status` compares `source_documents.storage_key` to files under `STORAGE_PATH`. Findings:

- `missing_file` — database locator without bytes
- `orphan_file` — bytes without a locator
- `digest_mismatch` / `size_mismatch` — bytes do not match the stored digest or length

Do not rewrite `source_documents` metadata to hide a mismatch. Restore the matching backup or re-ingest authorized material.

## Logging

Worker logs are JSON with secret-like keys, bearer tokens, and Postgres URLs redacted. Do not log session cookies, passwords, OpenRouter keys, private contact fields, or document content. Correlate with `requestId` on mutating APIs when the client sends `x-request-id`.

## Known limitations

- Railway Postgres plugin is 18; local Compose is 17. SQL used here is valid on both.
- Railway volumes attach to one service and do not replicate. Upload/document-byte research still requires genuinely shared storage; keep `RESEARCH_SHARED_STORAGE=false` until that exists. Campaign discovery and the database-backed raw-signal investor scheduler do not require shared files. Their source URLs, hashes, quotes, evidence links and model inputs live in PostgreSQL. Web storage reconciliation checks rows with a `storage_key`; it does not certify a complete archive of database-only website sources.
- Qualification, certification, and sole-source claims remain review-gated; research writes observations/proposals only.
- Restore rehearsal requires `CREATEDB` on the backup role.

## Security and failure-mode reviews

Observed locally against the running stack (not a Railway claim):

| Area             | Control                                                                                                                                       | Evidence                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Auth             | Argon2id, hashed sessions, CSRF on mutations, role fail-closed                                                                                | Login 401 on bad password; viewer cannot POST research; CSRF mismatch 403                                     |
| Session          | httpOnly, sameSite=lax, `SESSION_COOKIE_SECURE` in production                                                                                 | Cookie flags in `createSession`; production env must set secure true                                          |
| SSRF             | Credential-free HTTP(S) only; localhost/.local blocked; DNS then pin; private/link-local/reserved/docs ranges rejected; redirects re-resolved | `safeFetchUrl` unit tests; literal `127.0.0.1` / `169.254.169.254` / `10.0.0.1` blocked without connecting    |
| Upload           | 5 MB / 5000-row CSV caps; SHA-256 storage key; idempotent digest                                                                              | `processImportBatch` throws before database on empty/oversize; completed digest replay returns existing batch |
| Storage          | Traversal rejected; digest verified on read; no metadata rewrite on mismatch                                                                  | `writeStoredDocument` tests; ops findings `missing_file` / `digest_mismatch`                                  |
| Prompt injection | Fetched/model text cannot add tools or write canonical facts                                                                                  | Company research persists observations/proposals only                                                         |
| Privacy          | Worker JSON redacts secrets, bearer tokens, Postgres URLs                                                                                     | Worker logger; do not log document content or private contacts                                                |
| Retention        | Append-only observations, reviews, audit; merge revert restores snapshot                                                                      | Merge APIs; proposal accept is pointer-only                                                                   |

## Restore rehearsal (local)

`npm run ops:rehearse` dumps via the PostgreSQL 17 container (host `pg_dump` 14 cannot dump 17), restores into a throwaway database, compares company/document counts, and drops the rehearsal database. Host-side `pg_dump` without the container client is not a valid 17 backup.

## Worker start and stop (Railway)

PostgreSQL holds identities, catalog, jobs, observations, proposals, signal review state, and audit. Stopping the worker does not delete these records. The 2026-08-17 walkthrough deliberately stopped the worker and disabled paid research; that is a dated operational event, not a current safety mechanism. The 2026-09-28 baseline instead observed an active, healthy worker whose legacy selection was idle.

Stop the current worker deployment without removing its database or volume:

```bash
railway down --service worker --yes
```

Deploy the verified main revision:

```bash
railway up --service worker --environment production --detach
```

Use the matching `railway.worker.json` settings, including `npm run start:worker`, `ON_FAILURE`, and sleeping disabled. `/health` and `/ready` can be healthy with `RESEARCH_SHARED_STORAGE=false`; document-byte handlers remain disabled, while database-only discovery and investor review may run. Inspect scheduler logs, durable review phases, linked evaluations and source evidence—not only HTTP health.

## Investor signal review

The automatic path is raw source → official-site identity and evidence research → Jev ladder → same-input Muse verification/audit → current projection → evidence-gated lead promotion. It does not create a canonical company merely to save source evidence. `signal_review_state` provides per-signal leases, source-revision fencing, input hashes, retry timing, and exact evaluation linkage.

- Provider/configuration failures are not company verdicts. Missing keys and budget deferrals remain distinguishable from candidate failures.
- Evidence refresh with unchanged semantic input and current policy reuses settled work. Changed source facts or the review contract invalidate the old decision. Hashless historical evaluations remain history, never promotion proof.
- Acquisition readiness requires source-backed identity, own named products, affirmative independence, revenue below $50m, US headquarters, and compatible Jev/Muse results on the same input. FAA aircraft applicability is not a supplier product catalog; award counts are not part counts. Unknown diligence stays explicit.
- Product-fit research prospects can remain in `evaluate` without being acquisition-ready. Existing human decisions and mixed curated/reference attention are preserved; stale machine-only readiness, priority, product and size flags are cleared or replaced.
- Curated/candidate rationale survives FAA refreshes. Exported readiness also holds conflicting target, source, or linked-company domains; a legacy tier or curated rationale alone is not same-input model completion.
- The Targets UI is candidate-based. A research prospect in `unified_targets` is not automatically an approved Target.
- Manual populate/promote/export callers must supply `currentFaaReviewInputContract()`. Exports are read-only and label missing/incompatible current policy rather than triggering paid review.
- Live ensemble CLI work uses durable claims. Legacy status/source/sample/known-name/failed-only selectors are dry-run-only; they cannot bypass the claim lifecycle.

Explicit backfill controls (set on the worker; use the same model/policy values for manual commands):

| Variable                                                          | Purpose                                                                       |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `EXA_DAILY_BUDGET_USD`, `EXA_SPEND_STATE_PATH`                    | Research-provider recorded-spend threshold and persistent worker counter      |
| `OPENROUTER_MAX_COST_PER_DAY_USD`                                 | Recorded model-spend threshold across generic usage and FAA response receipts |
| `SIGNAL_EVIDENCE_LIMIT`, `SIGNAL_EVIDENCE_CONCURRENCY`            | Bounded raw-evidence batch and parallelism                                    |
| `ENSEMBLE_BATCH_LIMIT`, `JEV_LADDER_CONCURRENCY`                  | Jev claim batch and parallelism                                               |
| `VERIFY_BATCH_LIMIT`, `ENSEMBLE_CONCURRENCY`, `ENSEMBLE_DELAY_MS` | Muse batch, parallelism, and spacing                                          |
| `JEV_FAST_INTERVAL_MS`, `ENSEMBLE_SCHEDULE_MINUTES`               | Independent fast and maintenance cadence                                      |
| `JEV_AUDIT_SAMPLE_RATE`                                           | Deterministic additional Muse audit fraction, from 0 to 1                     |

Model spending is accounted over explicit UTC calendar-day bounds from `model_usage` and `faa_review_model_usage`. Each returned Jev rung records an independent receipt before later processing or verdict publication. A logical Muse call records its known aggregate attempt charges even when its responses fail schema validation; that failure remains retryable and publishes no verdict. Unknown cost stays null, not a fabricated zero. A later rung failure or stale-input fence does not erase an observed charge.

Migration `0014_review_model_usage.sql` backfills previously recorded evaluation costs once. Migration `0015_review_usage_precision.sql` preserves their exact PostgreSQL numeric values, including charges below eight decimal places, without changing source links or observation times. Evaluation cost columns remain diagnostic and are not counted again. Source deletion leaves the receipt with a null source link.

Jev checks before each paid rung; Muse checks before its call. An exhausted or unreadable budget defers the claim without consuming a candidate retry or publishing a verdict. Deterministic zero-cost decisions can continue. This is a recorded-spend gate, not an atomic reservation or a complete provider invoice: concurrent/in-flight calls, failed responses without returned cost telemetry, and failed receipt persistence can exceed it. Exa's counter is worker-file-backed; put `EXA_SPEND_STATE_PATH` on the persistent worker volume and do not claim a shared multi-replica reservation.

The provider's key/account limit is separate from the application budget. OpenRouter HTTP 402 and structured quota-exhaustion HTTP 403 responses defer reviews without incrementing candidate attempts or publishing judgments; known charges from earlier attempts remain recorded. A non-resetting exhausted key requires an account owner to raise its limit or replace the Railway credential. Raising `OPENROUTER_MAX_COST_PER_DAY_USD` alone cannot restore provider capacity. Ordinary 403 refusals are not classified as quota exhaustion, and response-body digits cannot turn a terminal failure into a transient retry.

Monitor phase counts and due/leased rows, retrieval failures, same-input Jev/Muse linkage, current outcomes, source-document/evidence counts, and actual spending. A backlog of repeated retrieval errors or all-unknown reviews is not successful screening coverage.

Validation separates sourced historical golden references, synthetic controls, and the repeatedly tuned investor sample. `scripts/jev-ladder-bakeoff.mts` uses the production ladder and fact extractor, but supplied reference domains are an explicit identity premise. It does not prove identity discovery, persistence, Muse, promotion, or current acquisition truth. Report false promotions, false rejects, abstentions, coverage and errors; zero false promotions with zero decisive coverage is not a passing quality result. The frozen old autoresearch harness belongs to its old segment and must not be used to claim comparable new metrics.

Prior-list membership is provenance, not approval. Sources include the original golden workbook, preliminary pipeline workbook, sampled priorities, and investor feedback. A read-only production audit on 2026-09-28 also found the existing `ma-pipeline-20260926` snapshot: 303 recorded members, created before this repair. Its original input file is not present locally, but its persisted membership rows are available. The separate 36-name fixture remains a sample, not a substitute for that snapshot. Exports name the matching snapshot and row/hash provenance; “no match” means no match in available snapshots, not proven novelty.

For a coordinated policy cutover, stop the old worker before applying the review-state migrations and replacing stale machine projections. Run `npx tsx scripts/reconcile-stale-reviews.mts` with the deployment's database and model/policy environment to drain observable source-revision and input-contract changes without provider calls. It does not bootstrap unrelated sources, and fails rather than claiming a complete drain if it cannot make progress or reaches its pass limit. Preserve primary source documents, historical evaluations, and human decisions.

## Campaign discovery pipeline

- `campaign-process.v1` / `leads.ingest.v1` are storage-free (Postgres plus
  public no-auth APIs only) and register regardless of
  `RESEARCH_SHARED_STORAGE`; document-dependent research handlers stay
  gated behind it.
- Web `POST /api/v1/campaigns/[id]/{start,resume}` enqueues the heartbeat;
  a 60s worker sweep re-kicks running campaigns whose heartbeat died.
  `campaign.sweep_revived` in worker logs means exactly that happened.
- USAspending walks paginate with an explicit `Recipient Name asc` sort,
  advance via self-requeued query items (`payload.resumePage` +
  `cursorSortValue`/`cursorUniqueId`), and treat a partial page as the only
  in-stream exhaustion signal — the API's `hasNext` flips false at its
  internal 10k-record window while deeper pages still serve data, and its
  final page reports null cursor fields. Sustained crawling can trip
  temporary source-side throttling: month walks fail together with
  transient errors, back off exponentially (15m base), and resume
  automatically. `MAX_ITEM_ATTEMPTS` (5) is the point where a month is
  abandoned; re-running plan/start on the campaign restarts unfinished
  months from their stored cursors.

Enabling/disabling:

- On by default. Set `AGENT_SUPERVISOR_ENABLED=false` in the worker environment to skip starting it (`apps/worker/src/index.ts`); a restart is required for the change to apply.
- The supervisor uses `OPENROUTER_MAX_COST_PER_DAY_USD` (default $1 when unset at this gate) over recorded generic and FAA review spending for the UTC day, plus each agent's `budget_share_pct` / `daily_budget_usd` floor. An agent that crosses its cap is parked with outcome `budget_exhausted` until just past UTC midnight; it resumes automatically. If daily spend cannot be read, the supervisor fails safe and parks agents rather than spending blind. The separate investor scheduler defers only the affected paid review claims; provider-free maintenance is not stopped.

Pause/kill (audited control plane, `apps/web/src/app/api/v1/agents/`):

```bash
# pause/resume: analyst or admin, CSRF required
curl -X POST "$APP_URL/api/v1/agents/$AGENT_ID/pause"   # or /resume

# kill: admin only; aborts the current tick, marks paused, reason required
curl -X POST "$APP_URL/api/v1/agents/$AGENT_ID/kill"
```

A paused agent is never claimed until resumed. Kill is for policy reasons, not recovery.

Stale leases are self-healing: if the worker dies mid-tick, the 90s lease expires and any live supervisor instance reclaims the agent on its next poll. Human intervention is never required to unstick an agent; do not hand-edit `leased_by`/`lease_expires_at`.

Observe state as an authenticated user via `GET /api/v1/agents/overview` (running count, $ today vs cap, last finds) or `GET /api/v1/agents/:id/ticks` for the per-agent tick journal.

## Limited availability rollout

Production is the Railway project above. It is **limited availability**, not generally available. Do not advertise replay, a shared object store, or planned integrations.

Observed 2026-08-17T13:17Z. **Do not mix the two ops snapshots.**

Railway production (`https://aero-intel.up.railway.app`):

- GitHub source `nrbontha/aerospace-intel` branch `main` is connected on **web only**. The worker source is disconnected so a web deploy cannot start OpenRouter. Confirm web `RAILWAY_GIT_COMMIT_SHA` against `origin/main`.
- Public health/ready 200; admin login 200 with `Origin` equal to `APP_URL`. Username or email is accepted at `/login`. The sticky header has a single **Sign out** control (`POST /api/v1/auth/logout` with CSRF).
- Worker is **stopped** (0 running replicas). Restart policy `NEVER`. `worker-volume` remains attached. Do not treat a leftover FAILED historical deployment as a running worker.
- `RESEARCH_SHARED_STORAGE=false` on web and worker. Authenticated `POST /api/v1/research-runs` returns **409** `conflict` (`Research is disabled until shared document storage is configured`).
- Demo catalog loaded from `scripts/demo-catalog.sql` (idempotent). Companies `totalItems` 13; facilities 8. Rows are labeled as demo catalog context, not operational qualification assertions. This is **Postgres catalog data only**; production has `documentCount` 0.
- `GET /api/v1/ops/status`: `drainable: true`, **`alerts: []`**, queue failed 0, `documentCount` 0. Web ops only sees `web-volume`.
- Persistence verified: Postgres catalog and empty job-queue metadata across worker stop/start, plus that each service volume stays attached. No research job was enqueued, so cross-service document retrieval was not tested and remains unresolved.

Local only (`http://127.0.0.1:3000`, not Railway):

- `GET /api/v1/ops/status`: `drainable: true`, alert **`queue_failed`** (`1 failed job(s) remain in pgboss.job`), queue completed 5 / failed 1, `documentCount` 1.
- Catalog includes Hitchiner (`36961bd5-64e9-4a36-b972-e3ac0723156e`) and the P4 import probe. That failed-job alert is local history; production has none.

Research document writes are fail-closed:

- `NODE_ENV` is required and is **not** defaulted. `{ NODE_ENV: undefined, RESEARCH_SHARED_STORAGE: undefined }` fails env validation instead of becoming `development`.
- A non-loopback `APP_URL` requires `NODE_ENV=production`.
- Writes are allowed **only** when `RESEARCH_SHARED_STORAGE=true`. `NODE_ENV=development` or `test` does not open writes.
- Local Compose shares `uploaded-storage`; set `RESEARCH_SHARED_STORAGE=true` in gitignored `.env.local`.
- Production must keep `RESEARCH_SHARED_STORAGE=false` until web and worker share one object store. A worker-only volume does **not** count. Setting the flag true on split volumes would make worker-written evidence invisible to web (`missing_file`).

Checklist before calling the environment generally available:

1. `/api/v1/health` and `/api/v1/health/ready` return 200 on the public web URL.
2. Admin login succeeds with `Origin` equal to `APP_URL`.
3. Shared object storage exists (not two independent volumes); `RESEARCH_SHARED_STORAGE=true` on web and worker; worker is SUCCESS, `/health` is 200, and `/ready` reports `queue: ready`. Split volumes are not an acceptable substitute.
4. `GET /api/v1/ops/status` as admin shows `drainable` and storage findings operators can act on.
5. Restore rehearsal (`npm run ops:rehearse`) has been run against a throwaway database after the last schema change. Production PITR remains open.
6. Known limitations in this document are still accurate, especially split volumes, Postgres 18 vs local 17, and demo-only catalog claims.
7. Production catalog is operator-accepted (the current demo seed is for walkthroughs, not qualification decisions).
