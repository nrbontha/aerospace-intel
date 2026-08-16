# Aerospace Supplier Intelligence — Data Dictionary

## Status and conventions

This is the canonical planned vocabulary; it does not assert that every table exists. SQL uses plural snake_case, UUID primary keys, explicit foreign-key deletion, and timezone-aware `created_at`/`updated_at`; TypeScript uses camelCase. `null` means unknown/not supplied/not applicable and is never silently converted to zero, false, empty text, or `not_assessed`. JSONB is limited to raw values, model/tool payloads, replay artifacts, and structured metadata—not searchable business entities.

## Canonical datasets and entities

### Identity, organization, access

| Planned table            | Definition                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `users`                  | Human account, role, Argon2id password hash, disabled state.                                                   |
| `sessions`               | Session with only SHA-256 token hash, user, expiry/revocation, security metadata.                              |
| `rate_limits`            | Durable enforcement buckets; process memory is not authoritative.                                              |
| `companies`              | Canonical legal/operating organization. Supplier/customer is a relationship role, not a fixed company type.    |
| `company_aliases`        | Historical/trade/abbreviated name; useful for matching but never sufficient to auto-merge.                     |
| `company_domains`        | Normalized web/email domain with verification/evidence.                                                        |
| `company_identifiers`    | CAGE, DUNS, UEI, LEI, NAICS, SIC, ticker, or internal ID with issuer/scope/evidence.                           |
| `facilities`             | Physical operating site and normalized geography; headquarters is not a manufacturing location by implication. |
| `contacts`               | Minimized professional contact, company/facility, provenance, verification, visibility, staleness.             |
| `ownership_observations` | Append-only owner/parent claim, ownership type, percentage/range, effective time.                              |
| `financial_observations` | Append-only financial claim with period, metric, amount/range/currency, provenance.                            |
| `employee_observations`  | Append-only headcount claim with scope, as-of date/range, lower/upper bounds, provenance.                      |

### Capabilities, taxonomy, relationships

| Planned table             | Definition                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `capabilities`            | Controlled process/capability term; not proof of qualification.                                                                      |
| `company_capabilities`    | Company-level observed/claimed capability, evidence, time.                                                                           |
| `facility_capabilities`   | Facility-specific capability, preferred when site is known.                                                                          |
| `certifications`          | General organization/facility credential, issuer, scope, ID, issue/expiry, evidence. Never alone proves part/platform qualification. |
| `platform_families`       | Broad aerospace program/product family.                                                                                              |
| `platforms`               | Named aircraft, engine, spacecraft, weapon, or other program/product.                                                                |
| `platform_variants`       | Specific model/block/version.                                                                                                        |
| `subsystems`              | Controlled, optionally hierarchical functional breakdown.                                                                            |
| `parts`                   | Canonical part/component and normalized description.                                                                                 |
| `part_alternate_ids`      | Customer/manufacturer/legacy identifier with issuer/context.                                                                         |
| `facility_qualifications` | Evidence-backed qualification at the relationship grain below.                                                                       |
| `contracts`               | Buyer/customer–supplier award with identifier, scope, value/range/currency, period.                                                  |
| `procurements`            | Order/solicitation observation at the most specific facility/part/platform/customer/time grain available.                            |
| `saved_views`             | User-owned filter/sort/presentation; not canonical business data.                                                                    |
| `scoring_weights`         | Versioned score dimension configuration and effective time.                                                                          |

Customers use `companies` identities in customer roles; avoid unresolvable free-text duplicates.

### Sources and documents

| Planned table           | Definition                                                                                                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data_sources`          | Independent recurring publisher, registry, database, site, or API. May have zero company links. Stores access/ingestion/trust metadata, not retrieved content.                            |
| `source_documents`      | One immutable retrieved/uploaded/imported artifact: source, final URL/name, publication/retrieval time, media type, bytes, durable relative key, SHA-256, access basis, extraction state. |
| `company_source_links`  | Explicit typed association between company and source.                                                                                                                                    |
| `source_document_links` | Version, attachment, derived-from, supersedes, or duplicate relation between immutable documents.                                                                                         |

**Source versus document:** FAA Registry, SEC, a supplier website, or an authorized licensed database is a `data_source`; one filing, certificate PDF, page snapshot, spreadsheet, or API response is a `source_document`. Multiple documents may belong to one source.

### Evidence, observations, review, canonical facts

| Planned table        | Definition                                                                                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evidence`           | Addressable support inside a document: page/section/table/cell/selector locator, bounded excerpt/value, content hash, extraction method/status. It is not the interpreted claim. |
| `observations`       | Immutable assertion: typed subject/predicate, raw/normalized value or bounds, asserted/effective time, confidence, evidence, author/extraction method, conflict/review metadata. |
| `research_proposals` | Candidate fact/action/merge with supporting observations and previewable before/after; no canonical effect.                                                                      |
| `proposal_reviews`   | Append-only proposal, reviewer, accepted/rejected decision, reason, time, expected prior canonical version.                                                                      |
| `canonical_facts`    | Versioned accepted typed fact, effective time/range, review and observation links, predecessor/supersession, current-selection semantics.                                        |

Required lineage is `source_document → evidence → immutable observation → research_proposal → proposal_review → canonical_fact/current selection`. An observation records what a source asserted even if false, stale, conflicting, or rejected. Rejection/replacement never deletes any observation, proposal, review, or prior fact. Concurrent selection uses expected-current checks, never last-write-wins.

### Research, audit, auth, import

| Planned table/artifact | Definition                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `research_runs`        | Bounded workflow with typed target, initiator, contract/policy versions, budgets, input hash, status/progress/timing/error.                                                                |
| stage artifacts        | Runtime-validated, durable versioned intent, plan, execution, proposal/synthesis, and presentation artifacts with hashes and attempt links. Types/empty fields do not prove replayability. |
| `research_tool_calls`  | Catalogued tool/version, validated input/output refs and hashes, permissions, timing, bytes, retry link, status/error, created source documents.                                           |
| `model_usage`          | Provider/model, prompt/schema/tool-set hashes, tokens, cost/currency, timing, structured-output result, retry/error; never secrets.                                                        |
| `audit_events`         | Append-only actor/action/target/time/request/result with redacted metadata and no application update/delete path.                                                                          |
| `entity_merges`        | Reversible survivor/absorbed decision, actor/reason/evidence and before/after snapshot or inverse. Fuzzy matching only proposes.                                                           |
| `imports`              | Batch source/document, mapping version, initiator, digest/idempotency key, dry-run counts, status/timing/errors.                                                                           |
| `import_rows`          | Row key/number, raw value, normalized candidate, validation/error codes, target/action, commit result.                                                                                     |

Research writes observations/proposals only, never canonical facts directly.

## Relationship granularity

A `facility_qualifications` record has the grain:

`Facility × Part × Platform/Variant × Subsystem × Customer × Time`.

Every known dimension is an FK/typed time; unknowns stay `null` and are displayed as unknown. Family, platform, and variant are not interchangeable. Broader scope is valid only when evidence explicitly establishes it. The record also identifies qualification scope/state, sole-source/scarcity state, evidence/observations, reviewed fact where applicable, confidence, and validity dates. Certification, capability, contract history, or marketing text cannot fill missing qualification dimensions.

Ownership, supplier/customer, contract, and procurement relationships preserve direction, role, effective time, percentage/value ranges, and evidence; they are not undirected tags.

## Shared enums

Enum tuples belong to `@asi/contracts`; database enums consume them.

- Role: `admin`, `analyst`, `viewer`.
- Source access: `public`, `authorized`, `restricted_metadata_only`.
- Source ingestion: `manual`, `upload`, `web_fetch`, `api`, `import`.
- Company status: `active`, `inactive`, `acquired`, `defunct`, `unknown`.
- Record status: `draft`, `active`, `archived`.
- Ownership: `private`, `public`, `subsidiary`, `government`, `joint_venture`, `cooperative`, `unknown`.
- Identifier: `cage`, `duns`, `uei`, `lei`, `naics`, `sic`, `ticker`, `internal`.
- Contact verification: `unverified`, `source_verified`, `directly_verified`, `stale`, `invalid`.
- Sole-source/scarcity: `confirmed_sole_source`, `confirmed_constrained_source`, `likely_dominant_source`, `unverified_company_claim`, `multiple_qualified_sources`, `not_assessed`.
- Observation review: `pending`, `accepted`, `rejected`, `superseded`.
- Observation conflict: `none`, `potential`, `confirmed`, `resolved`.
- Research target: `company`, `facility`, `contact`, `platform`, `part`, `qualification`, `data_source`.
- Research run: `queued`, `running`, `succeeded`, `failed`, `cancelled`.
- Proposal: `pending`, `accepted`, `rejected`, `superseded`.
- Import: `queued`, `validating`, `ready`, `processing`, `completed`, `failed`, `cancelled`.
- Evidence extraction: `pending`, `processing`, `completed`, `failed`.

`not_assessed` is the default scarcity state and is not `multiple_qualified_sources`. `unverified_company_claim` remains visibly distinct. Sole-source state always has scope, effective time, and evidence; it is never an unqualified company label. Database-local enums may cover internal value/entity/merge/import mechanics but must not duplicate public values.

## Ranges, confidence, scores, time, money

Observations/facts identify a value type and compatible representation. Raw source text may accompany typed fields but not replace them. Ranges preserve nullable `lower`/`upper`, inclusivity, unit, and precision; never invent a midpoint.

- Confidence is numeric `[0,1]` and describes an assertion/interpretation, not source quality.
- Source and target scoring dimensions are nullable numeric `[0,100]`. Missing dimensions remain `null` and reduce computed completeness.
- Percentages name their unit and use checked numeric bounds. Counts use integer bounds.
- Calendar values use PostgreSQL `date`; events/retrievals/reviews use `timestamptz` and ISO 8601 instants.
- Effective values use open/closed `valid_from`/`valid_to`; missing bounds are unknown/open, not “now.” Approximate periods preserve precision (`year`, `quarter`, `month`, `day`, `instant`). `created_at` is not the asserted fact time.
- Money uses decimal/numeric exact amount or bounds plus uppercase ISO 4217 currency, never binary float. Preserve source currency. A conversion is a separate derived observation with rate source/date and rounding. Ceiling, obligated, awarded, annualized, and estimated amounts are distinct labeled metrics.

## Preservation

Evidence-bearing documents, evidence, observations, reviews, canonical facts, audit events, and merge history use preserve/restrict semantics plus append-only correction/supersession. Authorized privacy/legal removal uses an auditable redaction/tombstone and only policy-permitted minimized provenance; it must not silently rewrite conclusions.
