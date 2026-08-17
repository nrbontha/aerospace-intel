# Operations

This is the operator contract for Aerospace Supplier Intelligence. Local restore rehearsal and the Railway project named below have been observed; do not treat other environments as live without the same checks.

## Runtime topology

- `apps/web` serves App Router, `/api/v1`, and authenticated SSE.
- `apps/worker` consumes `pg-boss` jobs. Health is `/health` and `/ready` on `PORT`.
- PostgreSQL is authoritative for identities, facts, jobs, and audit. Local Compose is 17; the observed Railway plugin is 18.
- `STORAGE_PATH` is authoritative for document bytes. The database stores relative keys and SHA-256 digests.
- Web and worker must not share a process. They share PostgreSQL. They may share a document volume only when the platform actually mounts the same store (local Compose does; Railway volumes do not).

## Environment

Copy `.env.example`. Secrets stay in the process environment or a gitignored `.env.local`. Never commit `OPENROUTER_API_KEY`, session secrets, or dumps.

Required outside tests: `DATABASE_URL`, `SESSION_SECRET`. Production also needs `APP_URL`, an **absolute** `STORAGE_PATH` on a persistent volume, and `OPENROUTER_API_KEY` for research workers. Relative `STORAGE_PATH` values are resolved from process cwd (`apps/web` for Next, repo root for `npm run ops:*`).

## Railway

Observed production project `aerospace-supplier-intelligence` (independent of Almanac):

- Web: `https://aero-intel.up.railway.app` — `Dockerfile.web`, health `/api/v1/health`, start `npm run start:web` (migrate then Next). Volume `web-volume` at `/var/lib/asi/storage`.
- Worker: `Dockerfile.worker`, health `/health`, start `npm run start --workspace @asi/worker`. Volume `worker-volume` at `/var/lib/asi/storage` (independent of `web-volume`). No migrations. With `RESEARCH_SHARED_STORAGE=false` the process is health-only (`/ready` 503).
- Database: Railway PostgreSQL plugin image `postgres-ssl:18` (local Compose remains `postgres:17-bookworm`). Same `DATABASE_URL` on web and worker.
- Bootstrap admin: create inside the web container with `railway ssh -s web -- npm run bootstrap:admin`. Credentials live in gitignored `.env.railway.local`, never in git or image layers.
- Dockerfile `VOLUME` is rejected by Railway; platform volumes replace it. `.dockerignore` excludes `.env*`, `storage/`, `backups/`, and `node_modules/`.

Rollout order: database → web (migrates on start) → worker. Drain the worker (`SIGTERM`, then wait until `/api/v1/ops/status` reports `drainable: true`) before a breaking schema change.

## Migrations

- Forward: `npm run db:migrate` (production web `start:web` already does this).
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
3. Proceed when `drainable` is true (`created + retry + active = 0`).
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
- Railway volumes attach to one service. Web has `web-volume` and the worker has `worker-volume`, both at `/var/lib/asi/storage`. They do not replicate. Catalog, jobs, and research metadata persist in PostgreSQL if the worker is stopped. Import/upload bytes persist on `web-volume`. Research document bytes would persist only on `worker-volume`, so production research writes stay disabled (`RESEARCH_SHARED_STORAGE=false`) until web and worker share one object store. Docker Compose still shares `uploaded-storage`. Web `GET /api/v1/ops/status` only sees the web volume.
- Qualification, certification, and sole-source claims remain review-gated; research writes observations/proposals only.
- Restore rehearsal requires `CREATEDB` on the backup role.

## Security and failure-mode reviews

Observed locally against the running stack (not a Railway claim):

| Area | Control | Evidence |
| --- | --- | --- |
| Auth | Argon2id, hashed sessions, CSRF on mutations, role fail-closed | Login 401 on bad password; viewer cannot POST research; CSRF mismatch 403 |
| Session | httpOnly, sameSite=lax, `SESSION_COOKIE_SECURE` in production | Cookie flags in `createSession`; production env must set secure true |
| SSRF | Credential-free HTTP(S) only; localhost/.local blocked; DNS then pin; private/link-local/reserved/docs ranges rejected; redirects re-resolved | `safeFetchUrl` unit tests; literal `127.0.0.1` / `169.254.169.254` / `10.0.0.1` blocked without connecting |
| Upload | 5 MB / 5000-row CSV caps; SHA-256 storage key; idempotent digest | `processImportBatch` throws before database on empty/oversize; completed digest replay returns existing batch |
| Storage | Traversal rejected; digest verified on read; no metadata rewrite on mismatch | `writeStoredDocument` tests; ops findings `missing_file` / `digest_mismatch` |
| Prompt injection | Fetched/model text cannot add tools or write canonical facts | Company research persists observations/proposals only |
| Privacy | Worker JSON redacts secrets, bearer tokens, Postgres URLs | Worker logger; do not log document content or private contacts |
| Retention | Append-only observations, reviews, audit; merge revert restores snapshot | Merge APIs; proposal accept is pointer-only |

## Restore rehearsal (local)

`npm run ops:rehearse` dumps via the PostgreSQL 17 container (host `pg_dump` 14 cannot dump 17), restores into a throwaway database, compares company/document counts, and drops the rehearsal database. Host-side `pg_dump` without the container client is not a valid 17 backup.

## Worker start and stop (Railway)

PostgreSQL holds identities, catalog, jobs, observations, proposals, and audit. Stopping the worker does not delete that data. Observed 2026-08-17T12:21Z: companies `totalItems` 13 and facilities 8 before `railway down -s worker`, while the worker was down, and after worker `cbe4d8ca` came back. Queue counts stayed `created/retry/active/completed/failed = 0` across that cycle because research enqueue was 409.

Production research writes stay **disabled**. `RESEARCH_SHARED_STORAGE=false` on web and worker. Per-service volumes are not a shared object store. Do not set the flag true until web and worker share one object store; otherwise worker-written `source_documents` bytes land on `worker-volume` while web ops/downloads read `web-volume` (`missing_file`).

The demo is Postgres catalog data only. Stop/start verified Postgres catalog and empty job-queue metadata, plus that each service volume remains attached. No research job was enqueued, so cross-service document retrieval was not tested and remains unresolved.

Stop (replica goes to 0; Postgres catalog remains):

```bash
railway down -s worker -y
```

`railway scale …=0` is invalid (minimum 1 replica) and can redeploy the same image. Restart policy is `ON_FAILURE` so a crash comes back; a `railway down` stays down until you start it again. Do not set `ALWAYS` if you want an intentional stop to stick.

Start:

```bash
railway up --service worker --detach -y
```

or `railway redeploy --service worker` when the current image is already the one you want. With `RESEARCH_SHARED_STORAGE=false`, worker `/health` is 200 and `/ready` is **503** (`queue: not_ready`, `researchHandlers=false`). That is the intended fail-closed state, not a reason to set the flag true.

## Limited availability rollout

Production is the Railway project above. It is **limited availability**, not generally available. Do not advertise replay, a shared object store, or planned integrations.

Observed 2026-08-17T12:36Z after connecting GitHub `main`. **Do not mix the two ops snapshots.**

Railway production (`https://aero-intel.up.railway.app`):

- GitHub source `nrbontha/aerospace-intel` branch `main` is connected on web and worker. Confirm `RAILWAY_GIT_COMMIT_SHA` against `origin/main`; do not treat a local `railway up` as the source of truth.
- Public health/ready 200; admin login 200 with `Origin` equal to `APP_URL`. Username or email is accepted at `/login`.
- Worker is **Online** on `worker-volume` at `/var/lib/asi/storage`. `/health` 200; `/ready` **503** (`database: not_ready`, `queue: not_ready`) because research handlers are not registered. Restart policy `ON_FAILURE`.
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
