# Source and Evidence Policy

## Status, purpose, and scope

This policy is the planned enforcement contract for every manual entry, upload, import, web/API retrieval, and model/tool-assisted research path. It does not claim ingestion or review is implemented. A capability may be described as available only when application and database enforcement plus an observed check exist.

The objective is traceable supplier intelligence without overstating access, certainty, identity, qualification, scarcity, or model capability. Saucer and Almanac are design references only; no data, secrets, runtime, databases, or volumes are shared.

## Permitted ingestion

Content may enter only through:

1. **Manual analyst entry** with an identified source, observation author, asserted/effective time, and evidence locator or an explicit declaration that the entry is analyst-supplied.
2. **Authorized upload** by an authenticated user who affirms authority to use the material. The system records uploader, time, filename/media metadata, SHA-256, access class, and durable relative object key.
3. **Public web retrieval** over policy-limited HTTP(S) from a publicly accessible URL, subject to source terms and legal/organizational policy.
4. **Authorized API retrieval** using a separately approved integration whose credentials stay server-only and whose terms permit the use.
5. **Structured import** from a permitted source document with mapping/schema version, dry-run validation, row outcomes, and idempotent commit.

The following are not permitted: bypassing authentication, paywalls, CAPTCHAs, robots/access controls, or license controls; using leaked/stolen credentials; scraping private portals without authorization; covert collection of personal data; executing document code/macros; or allowing model/tool text to authorize another source. Browser availability does not itself grant ingestion rights.

All retrieved/uploaded bytes are bounded by configured size/type policy, stored durably rather than in ephemeral web storage, addressed/verified by SHA-256, and linked to their source and access basis. Duplicates are idempotent; a new version is a new immutable `source_document`, not an overwrite.

## Honest source access

A `data_source` describes a recurring publisher, database, registry, website, or origin. A `source_document` is one specific retrieved/uploaded artifact. A source may exist without a company link. Search and coverage statements are computed from actual persisted documents/tool attempts, not from a catalog of source names.

Access classes are:

- `public`: content actually reachable through a permitted public method.
- `authorized`: material supplied or accessed under a user's/organization's authorization; the access basis is recorded and disclosure follows that authorization.
- `restricted_metadata_only`: the system may store bibliographic/source metadata and an external reference but has not accessed content.

Restricted, licensed, or paywalled sources are **metadata-only unless a user supplies authorized material or an approved authorized integration retrieves it**. The product must say “identified but not accessed” or equivalent. It must never say or imply that restricted contents were searched, reviewed, absent, corroborated, or contradicted. Snippets or third-party descriptions do not establish access to the underlying work.

A failed/blocked/partial retrieval remains a durable failed/partial attempt. It is not silently counted as a searched source. Redirect final URL, retrieval instant, content digest, and access method describe what was actually observed.

## Evidence records and locators

Every material observation should link to a `source_document` and an addressable `evidence` record. Evidence stores:

- source/document IDs and immutable content digest;
- a stable locator appropriate to format: final URL plus heading/selector, PDF page and section/table, spreadsheet sheet/cell/range, API endpoint plus response item key, transcript timestamp, or import row key;
- publication/as-of date when present and actual retrieval/upload time;
- a bounded verbatim excerpt or structured cell/value sufficient to review the assertion;
- extraction method (`manual`, deterministic parser/tool and version, or model/provider/model and attempt), content/excerpt hash, and extraction status;
- language/translation and OCR status when relevant.

Locators must let an authorized reviewer find the support without storing unnecessary copyrighted or private content. Excerpts are the minimum needed to support/contest a claim; do not copy whole restricted works into excerpts, prompts, logs, or exports. Paraphrase is labeled and never represented as quotation. If a source changes or disappears, retain the authorized immutable document and original locator/digest subject to retention/legal policy.

A citation to a homepage, search result, or document without a precise locator is insufficient when a precise location is available. Model prose is not a source. A model/tool output may identify evidence but cannot become accepted evidence without the durable underlying document and locator.

## Append-only observations

An observation records “source S asserted value V about subject X at time T,” not that V is true. Important uncertain values enter as append-only observations with:

- typed subject and predicate;
- raw and normalized value or lower/upper range plus unit;
- asserted/effective time and precision;
- evidence/document/source links;
- extraction author/method/attempt;
- confidence in the extraction/interpretation;
- conflict/review status without rewriting the assertion.

Observations are immutable after creation. Corrections create a successor observation and lineage. Rejection, contradiction, supersession, merge, or replacement never deletes or edits the original observation. Database constraints/repository APIs must enforce this rather than relying on UI convention.

Privacy or legal removal is exceptional: authorized staff records a redaction/tombstone event, reason, actor, and affected fields; only a minimized non-sensitive digest/lineage may remain where permitted. This must not silently alter historical review outcomes.

## Proposal, review, and canonical selection

Ingestion and research do not write canonical facts directly. The workflow is:

1. observations support a proposal with typed candidate value, scope, evidence, and previewable difference from current state;
2. an authorized reviewer inspects the source, locator, conflicts, and relationship granularity;
3. an append-only review event records `accepted` or `rejected`, actor, time, reason, and expected current version;
4. acceptance creates/selects a versioned canonical fact and advances its current pointer transactionally;
5. replacement creates successor lineage; observations, proposal, review, and prior fact remain intact.

A reviewer must not accept their inability to access a cited restricted document as verification. Conflicting observations remain visible. Stale concurrent reviews fail with a conflict and require reconsideration; last-write-wins is prohibited. Rejection is not deletion and does not reduce the historical source record.

Canonical output must distinguish: reviewed current fact; attributed source/company claim; pending proposal; conflicting/stale observation; and unknown/not assessed. Presentation and exports retain canonical fact/review/evidence IDs sufficient for traceability.

## Qualification and sole-source restraint

A general certification or capability does not prove a specific part/platform qualification. Qualification evidence is scoped to Facility × Part × Platform/Variant × Subsystem × Customer × Time wherever known. Missing dimensions remain unknown and are not filled from marketing text, company-wide credentials, contract history, or fuzzy matches.

Sole-source/scarcity state is exactly one of:

- `confirmed_sole_source`
- `confirmed_constrained_source`
- `likely_dominant_source`
- `unverified_company_claim`
- `multiple_qualified_sources`
- `not_assessed`

Default is `not_assessed`; it does not mean multiple sources exist. `unverified_company_claim` must be used for attributed company/marketing assertions absent adequate independent support. `confirmed_sole_source` requires strong, current, scoped evidence that the relevant customer/program/part relationship has one qualified source; failure to find alternatives is not confirmation. `likely_dominant_source` is not sole-source. Every displayed state includes scope, effective/as-of time, evidence, review state, and known limitations. Broad labels such as “the company is sole source” are prohibited.

## Contact privacy and sensitive data

Collect only professional contact data necessary for supplier-intelligence work and allowed by the source/access basis: business name, role, organization/facility, business email/phone, provenance, verification status, and last-verified time. Prefer published role-based business contacts.

Do not intentionally collect personal/home addresses, personal email/phone, family details, government identifiers, credentials, financial account data, health data, protected-class inferences, precise non-business location, or unrelated social profiles. Do not infer personal emails from naming patterns. Public availability does not eliminate privacy obligations.

Contact records require provenance, purpose-limited visibility, verification (`unverified`, `source_verified`, `directly_verified`, `stale`, `invalid`), and staleness review. Exports, prompts, logs, and model calls minimize or omit contact data by default. Access and mutations are role-controlled and audited. Correction, suppression, and policy/legal deletion requests use an auditable workflow; suppressed data must not be re-ingested from the same material without review.

## Prompt injection and untrusted content

All fetched, uploaded, OCR, tool, and model text is untrusted data. Statements resembling instructions—such as requests to ignore policy, disclose secrets, run tools, follow links, approve facts, or alter budgets—are evidence content only and remain in the data channel.

Untrusted content cannot:

- modify system/developer policy, tool catalog, permissions, budgets, retry limits, or review requirements;
- supply or request secrets, credentials, cookies, local paths, private URLs, or network authorization;
- cause tool execution except through a validated plan using a registered tool and server-enforced policy;
- mark an observation/canonical fact accepted or assert successful source coverage.

Tools validate inputs and outputs at runtime and enforce permission, timeout, redirect, DNS, byte, and content-type policy. URL tools resolve every redirect and reject localhost, loopback, private, link-local, multicast/reserved destinations. Tool/model output is schema-validated; validation/postcondition failure is a failure, not a best-effort success. Prompts and logs must not contain `OPENROUTER_API_KEY`, session material, or unnecessary contact/document content.

## Research attempts, retry, and audit

Research is bounded, queued, replayable only to the extent its durable artifacts demonstrate: prompt/model/tool/schema hashes, attempt inputs/outputs or durable references, costs, times, status/progress/errors, and source documents. Empty optional fields or TypeScript types do not justify a replayability claim.

Only transient 429/5xx/network/timeout failures may retry. Honor `Retry-After`, apply capped jitter, and cap attempts, wall time, tokens/cost, tools, redirects, and bytes. Do not retry exhausted quota, access denial, policy violations, invalid inputs, or final schema/postcondition failure. Durable jobs use stable idempotency keys and at-least-once semantics; duplicate delivery cannot duplicate observations/documents/canonical effects.

`audit_events` append actor, action, target, time, request correlation, decision/result, and redacted metadata for ingestion, review, canonical selection, merge, import, contact access changes, and administrative research actions. Audit records never contain plaintext tokens/passwords/API keys or unnecessary source excerpts/contact data and have no ordinary update/delete path.

## Source quality, uncertainty, and claims

Source quality and target scoring dimensions are nullable `[0,100]`; confidence is `[0,1]`. Missing values remain `null` and lower evidence completeness. They never become zero. A source score does not automatically settle an individual claim; reviewers consider recency, directness, independence, scope, and conflicts.

Every statement visible to a user must be supportable as one of: accepted canonical fact with evidence; attributed observation/claim; pending proposal; system-derived value with named method/inputs; or explicitly unknown. The product must not claim full source coverage, verified replay, successful search, independent confirmation, or implemented controls unless durable records and observed enforcement support that claim.
