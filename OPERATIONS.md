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

## Investor access onboarding

There is no public registration. An admin creates each investor at `/admin/users`; keep the default `viewer` role unless broader duties are explicitly approved. Use a strong, unique password of at least 12 characters and deliver it through a private channel. The investor signs in at the public `/login` page and lands on `/signals`. Viewer GET browsing, filtering, detail views and exports are read-only and never start research.

Password reset changes the credential for future logins but does **not** revoke existing sessions. When invalidating credentials or offboarding, also use **Revoke sessions** in `/admin/users` (the audited control is `DELETE /api/v1/admin/users/{id}/sessions`). Disabling a user blocks access, but reenabling can make an otherwise-valid old session usable again; revoke sessions before or while disabling when old tokens must stay invalid. Do not claim onboarding or revocation succeeded until the actual public login/session behavior has been exercised.

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

The automatic path is raw source → cheap Jev triage → mode/cohort-gated persistent Muse research → fresh Jev whenever admitted evidence changes → same-input Muse final verification → current projection → evidence-gated lead promotion. It does not create a canonical company merely to save source evidence. `signal_review_state` provides per-signal leases, source-revision fencing, input hashes, retry timing, and exact evaluation linkage. `signal_analyst_cases` and `signal_analyst_steps` retain the episode, gap catalog, model/resource actions, observations, limits, memo and retry history.

- Provider/configuration failures are not company verdicts. Missing keys and budget deferrals remain distinguishable from candidate failures.
- Evidence refresh with unchanged semantic input and current policy reuses settled work. Changed source facts or the review contract invalidate the old decision. Hashless historical evaluations remain history, never promotion proof.
- Acquisition readiness requires source-backed identity, own named products, affirmative independence, revenue below $50m, US headquarters, and compatible Jev/Muse results on the same input. FAA aircraft applicability is not a supplier product catalog; award counts are not part counts. Unknown diligence stays explicit.
- Product-fit research prospects can remain in `evaluate` without being acquisition-ready. Existing human decisions and mixed curated/reference attention are preserved; stale machine-only readiness, priority, product and size flags are cleared or replaced.
- Curated/candidate rationale survives FAA refreshes. Exported readiness also holds conflicting target, source, or linked-company domains; a legacy tier or curated rationale alone is not same-input model completion.
- The Targets UI is candidate-based. A research prospect in `unified_targets` is not automatically an approved Target.
- Manual populate/promote/export callers must supply `currentFaaReviewInputContract()`. Exports are read-only and label missing/incompatible current policy rather than triggering paid review.
- Live ensemble CLI work uses durable claims. Legacy status/source/sample/known-name/failed-only selectors are dry-run-only; they cannot bypass the claim lifecycle.
- `/signals`, `/signals/[id]` and their authenticated `/api/v1/signals` read APIs expose raw/unpromoted signals, current Jev fit/readiness/priority/gaps, case history, citations, action attempts and access limits. CSV omits full raw payloads; explicit JSON and the detail view retain raw observations. Neither export initiates research or promotion.
- Resource permission is separate from model spending: `free_only` permits bounded public-page and already-imported primary-record research but still incurs Muse model costs. It does not authorize Exa, private portals or paid/licensed sources. `disabled` leaves cheap Jev progress independent of Muse.
- An exhausted analyst episode may settle with an unresolved memo and no Muse evaluation/result. Count these bounded unverified holds separately from current verified finals. A completed tool request, model turn or terminal Jev triage is not completed acquisition diligence.
- The host enforces cumulative persisted limits and reserves the last model slot for finalization. Resuming the same case does not replenish limits or repeat recorded successful requests. Late recorded results remain reusable only under the appropriate input identity; uncertain interrupted calls remain explicitly uncertain.

### Investor ranking and live queue

Authenticated sign-in defaults to `/signals`, the read-only investor research queue. `/feed` retains the reviewed-target workflow. Existing viewer accounts can browse signal detail and download exports; research mutations still require a write-authorized role.

`investor-research-priority-v1` is an explainable **research-ordering score**, not investment quality, a probability, an acquisition verdict or human approval:

| Current evidence or review state | Points |
| --- | ---: |
| Own named-product support | 50 |
| Plausible product hypothesis, only when own named-product support is absent | 15 |
| Verified identity | 10 |
| Source-backed US headquarters | 10 |
| Affirmative independent ownership | 10 |
| Annual revenue below $50m | 10 |
| Matching current high-priority Jev and completed Muse final verification | 10 |

Missing or stale current Jev triage is **unscored**, not zero. A source-backed current ownership, headquarters or revenue exclusion is **0 / excluded**; its factor breakdown remains visible. The final-verification bonus requires the current source revision, input hash, model contract, exact evaluation/result linkage and a completed durable final-verifier action with matching model usage and response. A completed research memo alone cannot earn it. Evidence changes can therefore remove a score or bonus while retaining prior reviews and memos as history.

Ranking and filters execute over the whole matching dataset before page limits, not just loaded rows. Default ordering is ranked research prospects, then unscored records, then exclusions, with exact database timestamps and source IDs resolving ties. Search, readiness filters and newest-first ordering are URL-addressable. Opaque cursors bind the scoring policy, sort and filter selection; clients must restart pagination when those change rather than reuse an old cursor. CSV and JSON exports use the same ordering over **all** matching records, irrespective of how many rows the browser has loaded.

The queue loads 100 records at a time. Queue and detail views automatically refresh approximately every 30 seconds while visible, preserve loaded queue depth, and expose pause/resume and manual refresh controls. These are authenticated read requests: viewing, sorting, exporting or refreshing does not initiate paid research or promotion. Historical or input-mismatched results remain labeled separately from current evidence and research progress. Prior Booie, Golden or pipeline membership is provenance, not a score bonus or approval.

Explicit backfill controls (use the same model/policy values for manual commands):

| Variable                                                          | Purpose                                                                       |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `OPENROUTER_BUDGET_SCOPE_ID`                                      | Explicit durable model allowance identity on **web and worker** before funded activation |
| `EXA_BUDGET_SCOPE_ID`                                             | Explicit durable Exa allowance identity on the funded worker only |
| `EXA_DAILY_BUDGET_USD`, `OPENROUTER_MAX_COST_PER_DAY_USD`         | Additional UTC-day constraints, never a replacement for either durable total |
| `FAA_ANALYST_MODE`                                              | `disabled` starts no FAA scheduler stages—Jev, Muse, refresh, or promotion—and logs `ensemble.scheduler_disabled`; `free_only` or `bounded_paid` enables them, with paid mode also requiring active allowances |
| `ENSEMBLE_BATCH_LIMIT`, `JEV_LADDER_CONCURRENCY`                  | Jev claim batch and parallelism                                               |
| `FAA_JEV_SOURCE_SIGNAL_IDS`                                    | Optional cheap-screening UUID allowlist; an explicit empty list claims nothing |
| `VERIFY_BATCH_LIMIT`, `ENSEMBLE_CONCURRENCY`                     | Muse claim batch and bounded parallelism                                      |
| `JEV_FAST_INTERVAL_MS`, `ENSEMBLE_SCHEDULE_MINUTES`               | Independent fast and maintenance cadence                                      |

The OpenRouter low-level guard applies only when `OPENROUTER_BUDGET_SCOPE_ID`
is set: every scoped request needs its matching accounting context and
unsupported routes fail closed. Legacy non-scoped consumers retain their
existing contract. Set the scope ID on **both web and worker** before funded
activation; a scoped worker alone is not sufficient.

`OPENROUTER_MAX_COST_PER_DAY_USD` is one shared configured value with two
separate meanings: it remains the observed UTC-day threshold for legacy model
receipts, while the scoped OpenRouter path uses the same value as an atomic
UTC-day reservation admission cap. Neither calculation substitutes a daily
reset for a durable scope total.

Model spending is accounted over explicit UTC calendar-day bounds from `model_usage` and `faa_review_model_usage`. Each returned Jev rung records an independent receipt before later processing or verdict publication. A logical Muse call records its known aggregate attempt charges even when its responses fail schema validation; that failure remains retryable and publishes no verdict. Unknown cost stays null, not a fabricated zero. A later rung failure or stale-input fence does not erase an observed charge.

Migration `0014_review_model_usage.sql` backfills previously recorded evaluation costs once. Migration `0015_review_usage_precision.sql` preserves their exact PostgreSQL numeric values, including charges below eight decimal places, without changing source links or observation times. Evaluation cost columns remain diagnostic and are not counted again. Source deletion leaves the receipt with a null source link.

Migration `0016_signal_analyst_research.sql` adds analyst journals, provider allowances, immutable source allowlists, reservations/receipts and provider cooldowns. It does not reset primary sources, human decisions or prior model receipts. Each allowance is sealed with a fixed start, total cap and source set; creating it again with the identical definition is idempotent, not a new allowance. `remainingCostUsd` is the floor at zero for admission; `remainingBeforeFloorUsd` exposes an observed overage without rewriting a receipt.

Scoped model requests reserve before dispatch and make one HTTP attempt, with
provider fallback disabled. The reviewed wire policy is:

| Operation | Request restrictions | Reservation per attempt |
| --- | --- | --- |
| Jev | `typesafe/jev-1.13`; maximum prompt price `$0.042`/million tokens; completion and request price zero | `$0.0014` |
| Muse | `meta/muse-spark-1.3-contributor`; 4,096 completion tokens; prompt/completion prices at most `$0.10`/`$0.20` per million tokens; request price zero | `$0.106` |
| Exa search | Explicit `auto`, at most five results, text only; no generated summaries | `$0.007` |
| Exa contents | At most three URLs, text only | `$0.01` |

The model bounds cover the reviewed endpoint context windows, not an average
request. Review [OpenRouter routing constraints](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request)
and [Exa pricing](https://exa.ai/pricing) before changing models or request
features. An observed charge above its reservation pauses that scope even when
the total cap has not yet been reached; it never rewrites the charge to fit.
This is atomic application admission accounting, not a provider invoice limit.

The scoped Muse deadline includes response-body consumption after headers.
A timeout or missing cost retains the full reservation across process restarts
and UTC-day changes. Invalid structured output still preserves a returned
charge. Scoped OpenRouter reservations and their FAA usage projections share
receipt IDs: use the provider ledger for scope exposure and the existing model
usage ledgers for observed model spending; do not add both copies together.

### Funded provider run staging

Treat a funded run as an explicit paid cohort, not as “all available sources.” Build a private JSON file containing only the approved paid source-signal UUID array, retain the cohort name and selection rationale with the operating record, and keep private inputs out of this repository and image. `create` accepts either repeated `--source-signal-id` values or one `--source-signal-ids-file`, never both. The file form validates UUIDs and removes duplicate entries before the same immutable creation contract is applied. An omitted or empty paid list is an error; there is no implicit paid enrollment. A scope admits at most 50,000 explicit members and stores them in 1,000-row transactional chunks.

Keep the worker stopped throughout staging. A stopped Railway service has no container to SSH into, and `railway run` executes on the operator's machine, where `postgres.railway.internal` is not reachable. Run database commands inside the running `web` container instead; its image contains the repository at `/app` and it shares Railway's private network. Selecting `web` for command transport does not move paid configuration onto web or start research.

Use a scope ID that identifies the approved paid cohort and run window. Before any Railway command, set the actual approved selectors and local private-file path in the operator shell; the guards below stop an incomplete command before it opens SSH:

```bash
: "${SCOPE_ID:?set the approved paid-cohort scope ID}"
: "${STARTS_AT:?set the approved scope start instant}"
: "${TOTAL_CAP_USD:?set the approved total Exa cap}"
: "${COHORT_UUID_FILE:?set the local approved UUID-array file path}"
: "${EXPECTED_DATABASE_HOST:?set the expected Railway database host}"
: "${EXPECTED_DATABASE_NAME:?set the expected Railway database name}"
```

Creation is always paused and reissuing the identical command is idempotent. This command passes the scalar selectors as quoted positional arguments, streams the local private file over SSH standard input to a protected temporary **remote** file, invokes the script by its remote path, and removes the file on exit:

```bash
railway ssh --service web --environment production -- \
  sh -lc '
      set -eu
      umask 077
      cohort_file="$(mktemp /tmp/asi-funded-cohort.XXXXXX)"
      trap '"'"'rm -f "$cohort_file"'"'"' EXIT
      trap '"'"'exit 1'"'"' HUP INT TERM
      cat >"$cohort_file"
      cd /app
      npx tsx /app/scripts/research-provider-scope.mts create \
        --id "$1" \
        --starts-at "$2" \
        --total-cap-usd "$3" \
        --source-signal-ids-file "$cohort_file" \
        --provider exa
    ' sh "$SCOPE_ID" "$STARTS_AT" "$TOTAL_CAP_USD" <"$COHORT_UUID_FILE"
```

Do not create a replacement scope, recreate a funded database, delete receipts, or import a lower estimate to recover allowance. Existing committed and reserved/unknown exposure, histories, memberships, and scope identities are durable. For the one authorized $5 cutover path only, keep the old scope, calculate the floor from its exact known plus unknown commitment, and use a new fixed ID:

```bash
npx tsx scripts/research-provider-scope.mts cutover \
  --old-id "$OLD_SCOPE_ID" --id "$REMAINING_SCOPE_ID" \
  --starts-at "$STARTS_AT" --authorized-cap-usd 5 --provider exa \
  --source-signal-ids-file "$COHORT_UUID_FILE" \
  >"$PRIVATE_CUTOVER_MANIFEST"
```

The command atomically closes the old scope, creates the new one paused with `max(5 - known - unknown, 0)`, and writes no carried-exposure field or copied receipt. Keep the JSON manifest private with the cohort evidence. Daily caps and process restarts never reset this calculation. `import-legacy-estimate` is only for an evidenced carry-forward during a quiesced cutover; it is not a reset.

Do not close the old scope separately before the first `cutover`: the command
closes it atomically. Once closed, it can replay only an already-existing target
with the same immutable definition; a different target cannot mint another
remainder.

Record the actual authorization timestamp and reconcile all charges within
that authorization before creating an allowance. If model calls already ran
without a provider scope, subtract their evidenced known and unresolved
exposure from the new model cap and retain the opening reconciliation privately.
Do not copy old receipts or silently classify older, separately authorized
experiments as part of a new run. A restart is not a new authorization.

Before a code rollback, stop the worker and pause both scopes. Older images
without this transport guard must not receive the funded model credential.
The read-only web service can remain disabled without that credential.
Retain post-cutover receipts; restoring an older database without reconciling
later charges would replenish allowance incorrectly.

Keep the read-only web service at `FAA_ANALYST_MODE=disabled`, with `OPENROUTER_BUDGET_SCOPE_ID` installed for its scoped guard but without an Exa credential or paid scheduler configuration. Configure the funded worker with both `EXA_BUDGET_SCOPE_ID` and `OPENROUTER_BUDGET_SCOPE_ID`, intentional positive `EXA_DAILY_BUDGET_USD` and `OPENROUTER_MAX_COST_PER_DAY_USD`, `FAA_ANALYST_MODE=bounded_paid`, Exa and OpenRouter credentials, and the exact funded models. The OpenRouter scoped guard fails closed for unsupported configured-scope consumers; do not copy or substitute credentials between services. `FAA_JEV_SOURCE_SIGNAL_IDS` is independent cheap-screening scope: leave it absent for the full cheap backlog, or set a runtime-valid UUID list that includes every sealed paid target. The explicit list may include additional cheap Jev targets, but that never adds them to the immutable paid scope; the provider ledger still rejects every source outside the sealed membership. Keep the worker `FAA_ANALYST_MODE=disabled` until preflight passes.

Run the read-only preflight for each provider before activation (`--provider exa` and `--provider openrouter`). Both expected database guards are required. It checks the configured URL host before connecting, checks the connected database name, then reports sealed membership, total cap, known actual cost, reserved/unknown estimated exposure, committed cost, floored and unfloored remaining exposure, permit, required-key **presence only**, exact funded model policy, provider controls, and daily guards. It prints neither keys nor credential-bearing URLs, makes no provider API call or funding probe, and performs no database mutation.

Native/local smoke syntax (not production evidence) uses the current shell environment directly and does not source `.env.local`:

```bash
npx tsx scripts/research-provider-scope.mts preflight \
  --id "$SCOPE_ID" \
  --expected-database-host localhost \
  --expected-database-name aerospace_supplier_intelligence
```

For production, use the locally set selectors above. `railway run` starts the first Node process on the operator machine with the selected stopped worker configuration; it only serializes that configuration into SSH standard input and cannot connect to Railway's private PostgreSQL host. The receiving Node process runs `/app/scripts/research-provider-scope.mts` inside `web`, combines web's private `DATABASE_URL` with that selected worker configuration in memory, and never persists or displays the transport payload:

```bash
railway run --service worker --environment production -- \
  node -e '
    const [scopeId, expectedHost, expectedName] = process.argv.slice(1);
    const names = [
      "FAA_ANALYST_MODE",
      "FAA_JEV_SOURCE_SIGNAL_IDS",
      "EXA_BUDGET_SCOPE_ID",
      "OPENROUTER_BUDGET_SCOPE_ID",
      "EXA_DAILY_BUDGET_USD",
      "OPENROUTER_MAX_COST_PER_DAY_USD",
      "EXA_API_KEY",
      "OPENROUTER_API_KEY",
    ];
    const selectedWorkerEnv = Object.fromEntries(
      names.flatMap((name) =>
        process.env[name] === undefined ? [] : [[name, process.env[name]]],
      ),
    );
    const invocation = { scopeId, expectedHost, expectedName };
    process.stdout.write(
      Buffer.from(
        JSON.stringify({ selectedNames: names, selectedWorkerEnv, invocation }),
      ).toString("base64"),
    );
  ' "$SCOPE_ID" "$EXPECTED_DATABASE_HOST" "$EXPECTED_DATABASE_NAME" |
  railway ssh --service web --environment production -- \
    node -e '
      const { spawnSync } = require("node:child_process");
      let encoded = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { encoded += chunk; });
      process.stdin.on("end", () => {
        try {
          const payload = JSON.parse(
            Buffer.from(encoded.trim(), "base64").toString("utf8"),
          );
          const { scopeId, expectedHost, expectedName } = payload.invocation;
          if (![scopeId, expectedHost, expectedName].every(
            (value) => typeof value === "string" && value.length > 0,
          )) {
            throw new Error("local scope and expected database selectors are required");
          }
          const childEnv = { ...process.env };
          for (const name of payload.selectedNames) delete childEnv[name];
          Object.assign(childEnv, payload.selectedWorkerEnv);
          const result = spawnSync(
            "npx",
            [
              "tsx",
              "/app/scripts/research-provider-scope.mts",
              "preflight",
              "--id",
              scopeId,
              "--expected-database-host",
              expectedHost,
              "--expected-database-name",
              expectedName,
            ],
            {
              cwd: "/app",
              env: childEnv,
              stdio: ["ignore", "inherit", "inherit"],
            },
          );
          process.exit(result.status ?? 1);
        } catch (error) {
          process.stderr.write(`preflight transport failed: ${
            error instanceof Error ? error.message : "unknown error"
          }\n`);
          process.exit(1);
        }
      });
    '
```

The direct remote TypeScript invocation does not use the `ops:research-scope` npm launcher and therefore cannot source `.env.local`. A blocked preflight exits nonzero and identifies configuration/scope mismatches. It fails safe for a missing, wrong-provider, unsealed, closed, exhausted, already-active, Jev-excluded, or wrong-database scope. Missing `FAA_JEV_SOURCE_SIGNAL_IDS` is intentionally full cheap triage, not a paid-scope expansion. A blank or absent `OPENROUTER_MAX_COST_PER_DAY_USD` passes the startup parser, but the FAA model-spend gate reads the raw environment and therefore applies its effective $1 default; malformed, non-finite, zero, or negative values prevent the worker configuration from starting and block preflight rather than being reported as an effective fallback. Provider account funding is always reported **NOT VERIFIED**: an account owner must separately confirm provider funding and limits without making a probe call from this command.

After passing production read-only preflights and separate account-owner confirmation, activate both durable permits inside the private-network web container. `SCOPE_ID` identifies Exa and `MODEL_SCOPE_ID` identifies OpenRouter; neither activation starts the worker:

```bash
: "${MODEL_SCOPE_ID:?set the approved OpenRouter scope ID}"
railway ssh --service web --environment production -- \
  sh -lc 'cd /app && exec npx tsx /app/scripts/research-provider-scope.mts activate --id "$1"' \
  sh "$SCOPE_ID"
railway ssh --service web --environment production -- \
  sh -lc 'cd /app && exec npx tsx /app/scripts/research-provider-scope.mts activate --id "$1"' \
  sh "$MODEL_SCOPE_ID"
railway up --service worker --environment production --detach
```

The worker deployment is the run switch. Railway variables and a successful preflight do not prove the deployed process loaded them. Verify the deployed worker revision, actual replica state, startup log fields (`analystMode`, Exa/key/scope presence, and Jev scope), scheduler activity, durable claims/receipts, and expected paid IDs after startup. `/health` or `/ready` alone is not proof that the funded scheduler is running with the intended scope. The public web service remains an independently deployed, read-only investor surface: sign-in, queue browsing, filtering, refresh, detail views and exports do not start research.

For a planned pause, pause both scopes through the web container first to deny new paid reservations, then stop the worker to stop provider-free loops as well:

```bash
: "${MODEL_SCOPE_ID:?set the approved OpenRouter scope ID}"
railway ssh --service web --environment production -- \
  sh -lc 'cd /app && exec npx tsx /app/scripts/research-provider-scope.mts pause --id "$1"' \
  sh "$SCOPE_ID"
railway ssh --service web --environment production -- \
  sh -lc 'cd /app && exec npx tsx /app/scripts/research-provider-scope.mts pause --id "$1"' \
  sh "$MODEL_SCOPE_ID"
railway down --service worker --yes
```

Pausing does not cancel an already dispatched provider request and does not reset reservations, receipts, daily accounting, cases, or membership. It also does not stop provider-free work, which is why a full stop includes the independent worker. Run `close --id` for each scope through the same `railway ssh --service web` contract when an irreversible stop is intended; a closed scope cannot resume. To resume, keep the worker down, repeat both selected-worker read-only preflights and account-limit confirmation, activate the same two scopes through web, then deploy and repeat runtime verification. Funding added later never activates a scope or starts a worker automatically.

Jev checks before each paid rung; Muse checks before each model call. An exhausted or unreadable model budget defers the claim without consuming a candidate retry or publishing a verdict. Deterministic zero-cost decisions can continue. Scoped OpenRouter and Exa requests reserve exposure durably before dispatch, require an active total allowance and source membership, and retain unknown charges conservatively across restarts and UTC rollover. Without an OpenRouter scope, the legacy `OPENROUTER_MAX_COST_PER_DAY_USD` check is only a threshold over observed receipts, not an atomic reservation or provider account cap; it is not sufficient for this funded run. Preserve the former `EXA_SPEND_STATE_PATH` file for estimated baseline import; it is not a competing active spending authority.

Provider key/account limits are independent of application guards. OpenRouter HTTP 402 and structured quota-exhaustion HTTP 403 responses defer reviews without incrementing candidate attempts or publishing judgments; known charges from earlier attempts remain recorded. A non-resetting exhausted key requires its account owner to raise the provider limit or intentionally replace that provider's Railway credential. Raising `OPENROUTER_MAX_COST_PER_DAY_USD` alone cannot restore provider capacity. Ordinary 403 refusals are not classified as quota exhaustion, and response-body digits cannot turn a terminal failure into a transient retry.

Monitor phase counts and due/leased rows, retrieval failures, same-input Jev/Muse linkage, current outcomes, source-document/evidence counts, durable Exa committed/reserved exposure, application-observed model spending, and provider-account limits separately. A backlog of repeated retrieval errors or all-unknown reviews is not successful screening coverage.

Validation separates sourced historical golden references, synthetic controls, and the repeatedly tuned investor sample. `scripts/jev-ladder-bakeoff.mts` uses the production ladder and fact extractor, but supplied reference domains are an explicit identity premise. It does not prove identity discovery, persistence, Muse, promotion, or current acquisition truth. Report false promotions, false rejects, abstentions, coverage and errors; zero false promotions with zero decisive coverage is not a passing quality result. The frozen old autoresearch harness belongs to its old segment and must not be used to claim comparable new metrics.

Prior-list membership is provenance, not approval. Sources include the original golden workbook, preliminary pipeline workbook, sampled priorities, and investor feedback. A read-only production audit on 2026-09-28 also found the existing `ma-pipeline-20260926` snapshot: 303 recorded members, created before this repair. Its original input file is not present locally, but its persisted membership rows are available. The separate 36-name fixture remains a sample, not a substitute for that snapshot. Exports name the matching snapshot and row/hash provenance; “no match” means no match in available snapshots, not proven novelty.

For a coordinated policy cutover, quiesce old worker and web policy writers and verify a fresh backup before migrations and deployment. Run `npx tsx scripts/reconcile-stale-reviews.mts` with the deployment's database and model/policy environment to drain observable source-revision and input-contract changes without provider calls. Cheap intake may bootstrap eligible raw signals without doing paid discovery; an explicitly scoped run must retain its source allowlist. Reconciliation fails rather than claiming a complete drain if it cannot make progress or reaches its pass limit. Preserve primary source documents, historical evaluations, analyst action/cost history, human decisions and existing budget-scope identities.

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

- The agent supervisor is disabled unless `AGENT_SUPERVISOR_ENABLED=true` is explicitly set. A worker restart is required for a change to apply. This flag does not stop the separate campaign sweep or investor scheduler; pause their provider-capable work with the corresponding research mode, cohort and storage controls.
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

## Historical limited-availability snapshot (2026-08-17)

The following section is historical evidence only, not current Railway verification or an activation checklist. Production is the Railway project named above and remains limited availability, not generally available. Do not advertise replay, a shared object store, or planned integrations.

Observed 2026-08-17T13:17Z. **Do not mix this snapshot with later operating state or treat it as current.**

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
