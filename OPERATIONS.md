# Operations

This is the operator contract for Aerospace Supplier Intelligence. Local restore rehearsal and the Railway project named below have been observed; do not treat other environments as live without the same checks.

## Runtime topology

- `apps/web` serves App Router, `/api/v1`, and authenticated SSE.
- `apps/worker` consumes `pg-boss` jobs. Health is `/health` and `/ready` on `PORT`.
- PostgreSQL is authoritative for identities, facts, jobs, and audit. Local Compose is 17; the observed Railway plugin is 18.
- `STORAGE_PATH` is authoritative for document bytes. The database stores relative keys and SHA-256 digests.
- Web and worker must not share a process. They may share the PostgreSQL instance and the document volume.

## Environment

Copy `.env.example`. Secrets stay in the process environment or a gitignored `.env.local`. Never commit `OPENROUTER_API_KEY`, session secrets, or dumps.

Required outside tests: `DATABASE_URL`, `SESSION_SECRET`. Production also needs `APP_URL`, an **absolute** `STORAGE_PATH` on a persistent volume, and `OPENROUTER_API_KEY` for research workers. Relative `STORAGE_PATH` values are resolved from process cwd (`apps/web` for Next, repo root for `npm run ops:*`).

## Railway

Observed production project `aerospace-supplier-intelligence` (independent of Almanac):

- Web: `https://web-production-c1c69.up.railway.app` — `Dockerfile.web`, health `/api/v1/health`, start `npm run start:web` (migrate then Next). Volume `web-volume` at `/var/lib/asi/storage`.
- Worker: `Dockerfile.worker`, health `/health`, start `npm run start --workspace @asi/worker`. No migrations.
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
- Railway volumes attach to one service. Web holds `/var/lib/asi/storage`. The production worker is **stopped** until a shared object store exists; do not start it. Docker Compose still shares `uploaded-storage`.
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

## Limited availability rollout

Production is the Railway project above. It is **limited availability**, not generally available. Do not advertise replay, shared worker storage, a populated catalog, or planned integrations.

Observed 2026-08-17T03:55Z. **Do not mix the two ops snapshots.**

Railway production (`https://web-production-c1c69.up.railway.app`):

- Web deployment `0a156e0a` SUCCESS (redeploy of the tested fail-closed tree). Public health/ready 200; admin login 200 with `Origin` equal to `APP_URL`.
- `RESEARCH_SHARED_STORAGE=false` on web and worker. Research document writes require `RESEARCH_SHARED_STORAGE=true`; `NODE_ENV=production` is not enough.
- Worker is **stopped**. Latest worker deployments (`fb8f0a0a`, `a4a5e185`) are REMOVED; Railway reports the service Failed because there is **0** replica. Restart policy remains `NEVER`. Do not `railway up` or `railway redeploy` the worker.
- Authenticated `POST /api/v1/research-runs` returns **409** `conflict` (`Research is disabled until shared document storage is configured`).
- `GET /api/v1/ops/status`: `drainable: true`, **`alerts: []`**, queue failed 0. Catalog `GET /api/v1/companies?page=1&pageSize=1`: `totalItems` 0. Hitchiner and other local research data were not copied.

Local only (`http://127.0.0.1:3000`, not Railway):

- `GET /api/v1/ops/status`: `drainable: true`, alert **`queue_failed`** (`1 failed job(s) remain in pgboss.job`), queue completed 5 / failed 1, `documentCount` 1.
- Catalog includes Hitchiner (`36961bd5-64e9-4a36-b972-e3ac0723156e`) and the P4 import probe. That failed-job alert is local history; production has none.

`OPERATIONS.md` previously forbade rolling forward a worker that writes research documents before a shared object store exists. The `a4a5e185` worker image violated that rule and was taken down. Railway `scale …=0` is invalid (minimum 1 replica) and caused a same-image redeploy; keep the worker down with `railway down -s worker`. Do not treat a leftover FAILED deployment as a running worker.

Do not `railway up`, `railway redeploy`, or otherwise start the worker until:

1. Web and worker share a durable object store (not two independent volumes).
2. `RESEARCH_SHARED_STORAGE=true` is set on both services.
3. The worker image is the fail-closed build that refuses research handlers when that flag is absent.

Until then, production `POST /api/v1/research-runs` returns **409** `conflict`.

Research document writes are fail-closed:

- `NODE_ENV` is required and is **not** defaulted. `{ NODE_ENV: undefined, RESEARCH_SHARED_STORAGE: undefined }` fails env validation instead of becoming `development`.
- A non-loopback `APP_URL` requires `NODE_ENV=production`.
- Writes are allowed **only** when `RESEARCH_SHARED_STORAGE=true`. `NODE_ENV=development` or `test` does not open writes.
- Local Compose shares `uploaded-storage`; set `RESEARCH_SHARED_STORAGE=true` in gitignored `.env.local`. Production currently has `RESEARCH_SHARED_STORAGE=false`. Keep it false on Railway until a shared object store exists.

Checklist before calling the environment generally available:

1. `/api/v1/health` and `/api/v1/health/ready` return 200 on the public web URL.
2. Admin login succeeds with `Origin` equal to `APP_URL`.
3. Shared object storage exists; `RESEARCH_SHARED_STORAGE=true`; worker is SUCCESS and `/health` is 200.
4. `GET /api/v1/ops/status` as admin shows `drainable` and storage findings operators can act on.
5. Restore rehearsal (`npm run ops:rehearse`) has been run against a throwaway database after the last schema change.
6. Known limitations in this document are still accurate, especially web-only volumes, the stopped worker, Postgres 18 vs local 17, and the empty production catalog.
7. Production has operator-accepted catalog data, or an explicit decision to launch empty.
