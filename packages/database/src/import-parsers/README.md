# ADCO Workbook Import Parsers

Pure TypeScript parsers for the two real ADCO workbooks. Bytes in
(`ArrayBuffer` / `Uint8Array`), typed plain objects out — no DB, no env, no
`fs` at module level. Built on SheetJS (`xlsx@0.18.5`).

## Modules

| Module | Entry point | Parses |
|---|---|---|
| `golden-set.ts` | `parseGoldenSetTargets(bytes)` / `parseGoldenSetWorkbook(bytes)` | `Golden Set Targets` sheet (criteria + company table), optionally composing the other two sheets into one `ParsedGoldenSet` |
| `grata.ts` | `parseGrataData(bytes)` | `Grata Data` sheet (49-column Grata export) → `GoldenCompanyRow[]` |
| `database-sources.ts` | `parseDatabaseSources(bytes)` | `Database Sources` sheet → `DatabaseSourceRow[]` |
| `pipeline.ts` | `parsePipeline(bytes)` | `M&A Pipeline` sheet → `ParsedPipeline` |

Sheets are located by fuzzy name match (case/punctuation insensitive).
Header rows are detected dynamically — never by hard-coded row numbers —
so extra leading junk/blank rows are tolerated.

## Real workbook layouts

### ADCO-golden-set.xlsx

- **Golden Set Targets** — a criteria text block first: qualifying
  parameters, then the disqualifying sub-block (the real sheet contains the
  typo `Diqsualifying parameters`; block-title rows end in `parameters` and
  are captured in `criteria.raw` only). Below it, a company table whose
  header row contains `Company Name` and `Domain`, plus `Description`, `HQ`,
  `Estimated revenue`, `Ownership`, `Misc. details`. Criteria strings are
  captured verbatim, including embedded `\r\n` line breaks. 18 companies.
- **Grata Data** — range `B2:AX20`: 49 named columns starting `Grata Link`,
  `Company Id`, `Domain`, `Name`, … `Executive Email Deliverability`.
  Every non-empty column is preserved in `grataPayload` keyed verbatim by
  its header. 18 rows.
- **Database Sources** — header `Common Databases | Domain | Misc. details`;
  5 rows (OASIS / PRI / SAM / USAspending / Boeing IPC).

### ADCO-pipeline.xlsx — sheet `M&A Pipeline`

Title junk rows, then the header row (detected as the first row whose
column 0 is exactly `Name`), then ~246 data rows across 24 columns. The
header at **index 21 is a SECOND `Name` column** holding a contact first
name — distinct from the company name at index 0. Rows are mapped
**positionally** (see the table in `types.ts`):

- `rawPriority` (c5) is preserved **verbatim** as `string | null` — never
  coerced to number semantics (real data: sparse `1`/`2`/`3` + nulls).
- Only `revenue` (c7), `ebitda` (c8) and `employees` (c10) are parsed as
  `number | null` (39 null revenues in the real file).
- `situationUpdateDate` (c12, real header typo `Situate Update Date`) and
  `ndaSignedDate` (c15) hold Excel serials → converted to ISO `YYYY-MM-DD`
  via `excelSerialToIso` (epoch 1899-12-30, pure).

## Real data policy

The real workbooks live **outside git** (source: `~/Downloads/ADCO-*.xlsx`).
Copies for local verification belong in `<repo>/data/`, which is listed in
`.gitignore` — **never commit them and never place them under `fixtures/`**.

Committed unit tests (`parsers.test.ts`) build tiny **synthetic** xlsx files
in-test with SheetJS, reproducing both layouts (duplicate `Name` header,
serial dates, null revenue, criteria-above-table, off-by-one blank row).

An integration guard test runs only with `ASI_REAL_DATASETS=1` set and the
files present in `data/`:

```sh
ASI_REAL_DATASETS=1 npx vitest run packages/database/src/import-parsers
```

It asserts: 18 golden companies, 18 Grata rows, 240–250 pipeline rows, the
`Cathy Caris` contact row belongs to `Interface, Inc.`, and no thrown
errors.
