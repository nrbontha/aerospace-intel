import {
  faaPmaRecordSchema,
  faaPmaScrapeQuerySchema,
  faaPmaScrapeResultSchema,
  type FaaPmaRecord,
  type FaaPmaScrapeQuery,
  type FaaPmaScrapeResult,
} from "@asi/contracts";

import { SourceFetchError } from "./types.js";

export const FAA_DRS_PUBLIC_PMA_URL =
  "https://drs.faa.gov/browse/PMA/doctypeDetails";
export const FAA_DRS_RECORD_PATH_PREFIX =
  "/browse/excelExternalWindow/DRSDOCID";
export const FAA_DRS_MAX_RECORDS = 25;
export const FAA_DRS_NAVIGATION_TIMEOUT_MS = 30_000;
export const FAA_DRS_QUERY_TIMEOUT_MS = 60_000;
export const FAA_DRS_MIN_QUERY_INTERVAL_MS = 1_000;
export const FAA_DRS_MAX_RETRIES = 3;

const RESULT_ANCHOR_SELECTOR =
  `a[href^='${FAA_DRS_RECORD_PATH_PREFIX}']`;
const APPLY_FILTERS_SELECTOR = "#apply-filters-btn";
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

const FILTER_SELECTORS = {
  holderName: "input[name='PMA Holder Name']",
  holderNumber: "input[name='PMA Holder Number']",
  partNumber: "input[name='PMA Part Number']",
  make: "input[name='Make']",
  model: "input[name='Model']",
} as const;

type FaaDrsFilterName = keyof typeof FILTER_SELECTORS;
type Sleep = (milliseconds: number) => Promise<void>;

export type FaaDrsAccessReason =
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "captcha"
  | "authentication_required";

export class FaaDrsAccessError extends SourceFetchError {
  override readonly name = "FaaDrsAccessError";
  readonly reason: FaaDrsAccessReason;

  constructor(reason: FaaDrsAccessReason, status?: 401 | 403 | 429) {
    const descriptions: Record<FaaDrsAccessReason, string> = {
      unauthorized: "FAA DRS rejected guest browser access with HTTP 401",
      forbidden: "FAA DRS rejected guest browser access with HTTP 403",
      rate_limited: "FAA DRS rate-limited the guest browser with HTTP 429",
      captcha: "FAA DRS presented a CAPTCHA; unattended scraping stopped",
      authentication_required:
        "FAA DRS required authentication; guest-browser scraping stopped",
    };
    super(descriptions[reason], {
      transient: reason === "rate_limited",
      ...(status === undefined ? {} : { status }),
    });
    this.reason = reason;
  }
}

export class FaaDrsProtocolError extends SourceFetchError {
  override readonly name = "FaaDrsProtocolError";

  constructor(message: string, cause?: unknown) {
    super(message, {
      transient: false,
      ...(cause === undefined ? {} : { cause }),
    });
  }
}
export class FaaDrsStaleResultsError extends SourceFetchError {
  override readonly name = "FaaDrsStaleResultsError";
  readonly filter: FaaDrsFilterName;
  readonly expectedValue: string;

  constructor(filter: FaaDrsFilterName, expectedValue: string) {
    super(
      `FAA DRS returned cards that do not match ${filter}=${JSON.stringify(expectedValue)}; refusing stale default results`,
      { transient: true },
    );
    this.filter = filter;
    this.expectedValue = expectedValue;
  }
}


export interface FaaDrsDomCard {
  readonly href: string;
  /** Verbatim browser innerText for the rendered result card. */
  readonly renderedText: string;
}

export interface FaaDrsNavigationResult {
  readonly url: string;
  readonly status: number | null;
}

/** Narrow guest-browser seam. It intentionally exposes no cookies or request client. */
export interface FaaDrsBrowserPage {
  navigate(url: string, timeoutMs: number): Promise<FaaDrsNavigationResult>;
  fill(selector: string, value: string): Promise<void>;
  press(selector: string, key: "Enter"): Promise<void>;
  click(selector: string): Promise<void>;
  waitForResults(timeoutMs: number): Promise<void>;
  bodyText(): Promise<string>;
  blockedStatus(): 401 | 403 | 429 | null;
  cards(maxRecords: number): Promise<readonly FaaDrsDomCard[]>;
  close(): Promise<void>;
}

export interface FaaDrsBrowserFactory {
  open(options: {
    readonly executablePath?: string;
    readonly userAgent: string;
    readonly queryTimeoutMs: number;
  }): Promise<FaaDrsBrowserPage>;
}
interface BrowserDomElement {
  readonly innerText?: string;
  readonly parentElement: BrowserDomElement | null;
  readonly textContent: string | null;
  closest(selector: string): BrowserDomElement | null;
  getAttribute(name: string): string | null;
}

interface BrowserDomDocument {
  readonly body: { readonly innerText: string } | null;
  querySelectorAll(selector: string): readonly BrowserDomElement[];
}

interface BrowserDomGlobal {
  readonly document: BrowserDomDocument;
}


export interface FaaDrsBrowserClientOptions {
  readonly browserFactory?: FaaDrsBrowserFactory;
  readonly chromiumPath?: string;
  readonly navigationTimeoutMs?: number;
  readonly queryTimeoutMs?: number;
  readonly queryIntervalMs?: number;
  readonly maxRetries?: number;
  readonly sleep?: Sleep;
  readonly now?: () => Date;
  readonly nowMs?: () => number;
}

export class FaaDrsBrowserClient {
  readonly #browserFactory: FaaDrsBrowserFactory;
  readonly #chromiumPath: string | undefined;
  readonly #navigationTimeoutMs: number;
  readonly #queryTimeoutMs: number;
  readonly #queryIntervalMs: number;
  readonly #maxRetries: number;
  readonly #sleep: Sleep;
  readonly #now: () => Date;
  readonly #nowMs: () => number;
  #lastAttemptStartedAt = 0;

  constructor(options: FaaDrsBrowserClientOptions = {}) {
    this.#browserFactory = options.browserFactory ?? new PlaywrightFaaDrsBrowserFactory();
    this.#chromiumPath = resolveChromiumPath(options.chromiumPath);
    this.#navigationTimeoutMs = positiveInteger(
      options.navigationTimeoutMs,
      FAA_DRS_NAVIGATION_TIMEOUT_MS,
    );
    this.#queryTimeoutMs = positiveInteger(
      options.queryTimeoutMs,
      FAA_DRS_QUERY_TIMEOUT_MS,
    );
    this.#queryIntervalMs = Math.max(
      FAA_DRS_MIN_QUERY_INTERVAL_MS,
      positiveInteger(options.queryIntervalMs, FAA_DRS_MIN_QUERY_INTERVAL_MS),
    );
    this.#maxRetries = boundedInteger(
      options.maxRetries,
      FAA_DRS_MAX_RETRIES,
      FAA_DRS_MAX_RETRIES,
    );
    this.#sleep = options.sleep ?? sleep;
    this.#now = options.now ?? (() => new Date());
    this.#nowMs = options.nowMs ?? Date.now;
  }

  async search(queryInput: unknown): Promise<FaaPmaScrapeResult> {
    const query = faaPmaScrapeQuerySchema.parse(queryInput);
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      await this.#paceAttempt();
      try {
        return await this.#runAttempt(query);
      } catch (cause) {
        const error = normalizeBrowserError(cause);
        if (error instanceof FaaDrsAccessError || !error.transient) throw error;
        lastError = error;
        if (attempt === this.#maxRetries) throw error;
        await this.#sleep(Math.max(this.#queryIntervalMs, 2 ** attempt * 1_000));
      }
    }

    throw normalizeBrowserError(lastError);
  }

  async #runAttempt(query: FaaPmaScrapeQuery): Promise<FaaPmaScrapeResult> {
    const page = await this.#browserFactory.open({
      ...(this.#chromiumPath === undefined
        ? {}
        : { executablePath: this.#chromiumPath }),
      userAgent: BROWSER_USER_AGENT,
      queryTimeoutMs: this.#queryTimeoutMs,
    });

    try {
      const navigation = await page.navigate(
        FAA_DRS_PUBLIC_PMA_URL,
        this.#navigationTimeoutMs,
      );
      assertAllowedNavigation(navigation.url);
      throwForBlockedAccess(navigation.status, await page.bodyText());

      const filter = queryFilter(query);
      const selector = FILTER_SELECTORS[filter.name];
      await page.fill(selector, filter.value);
      await page.press(selector, "Enter");
      await page.click(APPLY_FILTERS_SELECTOR);
      await page.waitForResults(this.#queryTimeoutMs);
      throwForBlockedAccess(page.blockedStatus(), await page.bodyText());

      const cards = await page.cards(query.maxRecords);
      const records = parseFaaPmaCards(cards, query.maxRecords);
      assertRecordsMatchFilter(records, filter);
      return faaPmaScrapeResultSchema.parse({
        query,
        records,
        source: {
          publicUrl: FAA_DRS_PUBLIC_PMA_URL,
          scrapedAt: this.#now().toISOString(),
          retrievalMethod: "guest_browser_dom",
        },
      });
    } finally {
      await page.close();
    }
  }

  async #paceAttempt(): Promise<void> {
    const now = this.#nowMs();
    const remaining =
      this.#lastAttemptStartedAt + this.#queryIntervalMs - now;
    if (remaining > 0) await this.#sleep(remaining);
    this.#lastAttemptStartedAt = this.#nowMs();
  }
}

class PlaywrightFaaDrsBrowserFactory implements FaaDrsBrowserFactory {
  async open(options: {
    readonly executablePath?: string;
    readonly userAgent: string;
    readonly queryTimeoutMs: number;
  }): Promise<FaaDrsBrowserPage> {
    // Runtime-only loading keeps the optional browser out of non-FAA worker startup.
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({
      headless: true,
      ...(options.executablePath === undefined
        ? {}
        : { executablePath: options.executablePath }),
    });

    try {
      const context = await browser.newContext({ userAgent: options.userAgent });
      const page = await context.newPage();
      let blockedStatus: 401 | 403 | 429 | null = null;
      let activeFilterValue = "";
      let firstRecordBeforeApply = "";
      let firstRecordMatchedFilter = false;
      page.on("response", (response) => {
        const status = response.status();
        const resourceType = response.request().resourceType();
        if (
          (status === 401 || status === 403 || status === 429) &&
          (resourceType === "document" ||
            resourceType === "xhr" ||
            resourceType === "fetch")
        ) {
          blockedStatus = status;
        }
      });
      const readResultSignature = async (): Promise<string> =>
        await page.evaluate((anchorSelector) => {
          const browserGlobal = globalThis as unknown as BrowserDomGlobal;
          return Array.from(
            browserGlobal.document.querySelectorAll(anchorSelector),
          )
            .map((anchor) => anchor.getAttribute("href") ?? "")
            .join("|");
        }, RESULT_ANCHOR_SELECTOR);

      return {
        async navigate(url, timeoutMs) {
          const deadline = Date.now() + timeoutMs;
          const response = await page.goto(url, {
            timeout: timeoutMs,
            waitUntil: "domcontentloaded",
          });
          const status = response?.status() ?? null;
          if (status !== 401 && status !== 403 && status !== 429) {
            const remaining = Math.max(1, deadline - Date.now());
            await page
              .locator(RESULT_ANCHOR_SELECTOR)
              .first()
              .waitFor({ state: "attached", timeout: remaining });
            const settleTime = Math.min(750, Math.max(0, deadline - Date.now()));
            if (settleTime > 0) await page.waitForTimeout(settleTime);
          }
          return { url: page.url(), status };
        },
        async fill(selector, value) {
          activeFilterValue = value;
          await page.locator(selector).fill(value);
        },
        async press(selector, key) {
          await page.locator(selector).focus();
          await page.keyboard.press(key);
        },
        async click(selector) {
          if (selector === APPLY_FILTERS_SELECTOR) {
            await page.waitForFunction(
              ({ expectedValue }) => {
                const browserGlobal =
                  globalThis as unknown as BrowserDomGlobal;
                const selectedOptions = Array.from(
                  browserGlobal.document.querySelectorAll(
                    "[role='option'][aria-selected='true']",
                  ),
                );
                return selectedOptions.some(
                  (option) =>
                    option.getAttribute("aria-label")?.trim() ===
                      expectedValue ||
                    option.textContent?.trim() === expectedValue,
                );
              },
              { expectedValue: activeFilterValue },
              { timeout: options.queryTimeoutMs },
            );
            const priorResult = await page.evaluate(
              ({ anchorSelector, expectedValue }) => {
                const browserGlobal =
                  globalThis as unknown as BrowserDomGlobal;
                const firstAnchor = Array.from(
                  browserGlobal.document.querySelectorAll(anchorSelector),
                )[0];
                if (firstAnchor === undefined) {
                  return { href: "", matchedFilter: false };
                }
                const container =
                  firstAnchor.closest(".result-content, li") ?? firstAnchor;
                const renderedText =
                  typeof container.innerText === "string"
                    ? container.innerText
                    : (container.textContent ?? "");
                const normalizedText = renderedText
                  .toLocaleLowerCase("en-US")
                  .replace(/\s+/gu, " ");
                const normalizedExpected = expectedValue
                  .toLocaleLowerCase("en-US")
                  .replace(/\s+/gu, " ")
                  .trim();
                return {
                  href: firstAnchor.getAttribute("href") ?? "",
                  matchedFilter: normalizedText.includes(normalizedExpected),
                };
              },
              {
                anchorSelector: RESULT_ANCHOR_SELECTOR,
                expectedValue: activeFilterValue,
              },
            );
            firstRecordBeforeApply = priorResult.href;
            firstRecordMatchedFilter = priorResult.matchedFilter;
            // Ignore expected guest-session probes from initial page bootstrap;
            // only the targeted Apply operation may block this scrape.
            blockedStatus = null;
          }
          await page.locator(selector).click();
        },
        async waitForResults(timeoutMs) {
          const deadline = Date.now() + timeoutMs;
          await page.waitForFunction(
            ({
              anchorSelector,
              expectedValue,
              previousFirstRecord,
              previousFirstMatched,
            }) => {
              const browserGlobal = globalThis as unknown as BrowserDomGlobal;
              const browserDocument = browserGlobal.document;
              const selectedOptions = Array.from(
                browserDocument.querySelectorAll(
                  "[role='option'][aria-selected='true']",
                ),
              );
              const filterIsActive = selectedOptions.some(
                (option) =>
                  option.getAttribute("aria-label")?.trim() === expectedValue ||
                  option.textContent?.trim() === expectedValue,
              );
              const body =
                browserDocument.body?.innerText.toLowerCase() ?? "";
              if (
                body.includes("captcha") ||
                body.includes("too many requests") ||
                body.includes("sign in required") ||
                body.includes("login required")
              ) {
                return true;
              }
              if (!filterIsActive) return false;
              if (
                body.includes("no records found") ||
                body.includes("no results found") ||
                body.includes("no matching records")
              ) {
                return true;
              }
              const firstAnchor = Array.from(
                browserDocument.querySelectorAll(anchorSelector),
              )[0];
              if (firstAnchor === undefined) return false;
              const currentFirstRecord =
                firstAnchor.getAttribute("href") ?? "";
              return (
                previousFirstMatched ||
                currentFirstRecord !== previousFirstRecord
              );
            },
            {
              anchorSelector: RESULT_ANCHOR_SELECTOR,
              expectedValue: activeFilterValue,
              previousFirstRecord: firstRecordBeforeApply,
              previousFirstMatched: firstRecordMatchedFilter,
            },
            { timeout: timeoutMs },
          );
          let previousSignature = await readResultSignature();
          let stableIntervals = 0;
          while (Date.now() + 250 <= deadline) {
            await page.waitForTimeout(250);
            const currentSignature = await readResultSignature();
            if (currentSignature === previousSignature) {
              stableIntervals += 1;
              if (stableIntervals === 2) return;
            } else {
              previousSignature = currentSignature;
              stableIntervals = 0;
            }
          }
          throw new Error("FAA DRS result cards did not stabilize before timeout");
        },
        async bodyText() {
          return await page.locator("body").innerText();
        },
        blockedStatus() {
          return blockedStatus;
        },
        async cards(maxRecords) {
          return await page.evaluate(
            ({ anchorSelector, limit }) => {
              const browserGlobal = globalThis as unknown as BrowserDomGlobal;
              const anchors = Array.from(
                browserGlobal.document.querySelectorAll(anchorSelector),
              ).slice(0, limit);
              return anchors.map((element) => {
                const container =
                  element.closest(
                    "mat-card, .card, .result-content, [role='article'], li, tr",
                  ) ??
                  element.parentElement?.parentElement ??
                  element.parentElement ??
                  element;
                const renderedText =
                  typeof container.innerText === "string"
                    ? container.innerText
                    : (container.textContent ?? "");
                return {
                  href: element.getAttribute("href") ?? "",
                  renderedText,
                };
              });
            },
            { anchorSelector: RESULT_ANCHOR_SELECTOR, limit: maxRecords },
          );
        },
        async close() {
          await browser.close();
        },
      };
    } catch (cause) {
      await browser.close();
      throw cause;
    }
  }
}

export function parseFaaPmaCards(
  cards: readonly FaaDrsDomCard[],
  maxRecords = FAA_DRS_MAX_RECORDS,
): FaaPmaRecord[] {
  const limit = boundedInteger(maxRecords, FAA_DRS_MAX_RECORDS, FAA_DRS_MAX_RECORDS);
  const seenUrls = new Set<string>();
  const records: FaaPmaRecord[] = [];

  for (const card of cards.slice(0, limit)) {
    const record = parseFaaPmaCard(card);
    if (seenUrls.has(record.guidUrl)) continue;
    seenUrls.add(record.guidUrl);
    records.push(record);
  }
  return records;
}

export function parseFaaPmaCard(card: FaaDrsDomCard): FaaPmaRecord {
  if (card.renderedText.length === 0) {
    throw new FaaDrsProtocolError("FAA DRS result card had no rendered text");
  }
  const { recordId, guidUrl } = normalizeRecordUrl(card.href);
  const fields = parseRenderedFields(card.renderedText);
  const record = {
    recordId,
    guidUrl,
    status: scalarField(fields, "status"),
    subStatus: scalarField(fields, "subStatus"),
    holderName: scalarField(fields, "holderName"),
    holderNumber: scalarField(fields, "holderNumber"),
    fullAddress: multilineField(fields, "fullAddress"),
    pmaPartNumber: scalarField(fields, "pmaPartNumber"),
    partName: scalarField(fields, "partName"),
    replacementPartNumber: scalarField(fields, "replacementPartNumber"),
    make: scalarField(fields, "make"),
    models: listField(fields, "models"),
    supplementNumber: scalarField(fields, "supplementNumber"),
    supplementDate: normalizeDate(scalarField(fields, "supplementDate")),
    approvalBasis: scalarField(fields, "approvalBasis"),
    serviceOffice: scalarField(fields, "serviceOffice"),
    opr: scalarField(fields, "opr"),
    cfrReferences: listField(fields, "cfrReferences"),
    comments: multilineField(fields, "comments"),
    renderedSourceText: card.renderedText,
  };
  return faaPmaRecordSchema.parse(record);
}

type ParsedField =
  | "status"
  | "subStatus"
  | "holderName"
  | "holderNumber"
  | "fullAddress"
  | "pmaPartNumber"
  | "partName"
  | "replacementPartNumber"
  | "make"
  | "models"
  | "supplementNumber"
  | "supplementDate"
  | "approvalBasis"
  | "serviceOffice"
  | "opr"
  | "cfrReferences"
  | "comments";

const LABELS: ReadonlyArray<readonly [string, ParsedField]> = [
  ["PMA Holder Name", "holderName"],
  ["PMA Holder Number", "holderNumber"],
  ["PMA Holder Physical Address", "fullAddress"],
  ["PMA Holder Address", "fullAddress"],
  ["Holder Address", "fullAddress"],
  ["Full Address", "fullAddress"],
  ["Approved Replacement for Part Number", "replacementPartNumber"],
  ["Replacement Part Number", "replacementPartNumber"],
  ["Replacement For", "replacementPartNumber"],
  ["PMA Part Number", "pmaPartNumber"],
  ["Part Name", "partName"],
  ["PMA Supplement Number", "supplementNumber"],
  ["Supplement Number", "supplementNumber"],
  ["Supplement Date", "supplementDate"],
  ["FAA Approval Basis", "approvalBasis"],
  ["Approval Basis", "approvalBasis"],
  ["Responsible Service Office", "serviceOffice"],
  ["Service/Office", "serviceOffice"],
  ["Service Office", "serviceOffice"],
  ["Office of Primary Responsibility", "opr"],
  ["CFR Subpart/Appendix Reference", "cfrReferences"],
  ["CFR Section Reference", "cfrReferences"],
  ["CFR Part Reference", "cfrReferences"],
  ["14 CFR References", "cfrReferences"],
  ["CFR References", "cfrReferences"],
  ["Sub-Status", "subStatus"],
  ["Sub Status", "subStatus"],
  ["PMA Status", "status"],
  ["Status", "status"],
  ["Models", "models"],
  ["Model", "models"],
  ["Make", "make"],
  ["OPR", "opr"],
  ["Comments", "comments"],
  ["Address", "fullAddress"],
];

const labelPatternSource = LABELS.map(([label]) =>
  label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
)
  .sort((left, right) => right.length - left.length)
  .join("|");
const LABEL_PATTERN = new RegExp(
  `(${labelPatternSource})\\s*:\\s*`,
  "giu",
);

function parseRenderedFields(text: string): Map<ParsedField, string[]> {
  const fields = new Map<ParsedField, string[]>();
  const matches = [...text.matchAll(LABEL_PATTERN)];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const label = match[1];
    if (label === undefined || match.index === undefined) continue;
    const nextMatch = matches[index + 1];
    const valueEnd = nextMatch?.index ?? text.length;
    const rawValue = text.slice(match.index + match[0].length, valueEnd);
    const value = rawValue
      .trim()
      .replace(/\s*(?:\.{3})?Show more\s*$/iu, "")
      .replace(
        /\s*(?:View|Open|Download)\s+(?:Document|Record)\s*$/iu,
        "",
      )
      .trim();
    if (value.length === 0) continue;
    appendField(fields, fieldForLabel(label), value);
  }
  return fields;
}

function fieldForLabel(label: string): ParsedField {
  const normalized = label.toLocaleLowerCase("en-US");
  const entry = LABELS.find(
    ([candidate]) => candidate.toLocaleLowerCase("en-US") === normalized,
  );
  if (entry === undefined) {
    throw new FaaDrsProtocolError(`Unrecognized FAA DRS card label: ${label}`);
  }
  return entry[1];
}

function appendField(
  fields: Map<ParsedField, string[]>,
  field: ParsedField,
  value: string,
): void {
  const values = fields.get(field);
  if (values === undefined) fields.set(field, [value]);
  else values.push(value);
}

function scalarField(
  fields: ReadonlyMap<ParsedField, readonly string[]>,
  field: ParsedField,
): string | null {
  const value = fields.get(field)?.join(" ").trim();
  return value === undefined || value.length === 0 ? null : value;
}

function multilineField(
  fields: ReadonlyMap<ParsedField, readonly string[]>,
  field: ParsedField,
): string | null {
  const value = fields.get(field)?.join("\n").trim();
  return value === undefined || value.length === 0 ? null : value;
}

function listField(
  fields: ReadonlyMap<ParsedField, readonly string[]>,
  field: ParsedField,
): string[] {
  const values = fields.get(field) ?? [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of values.flatMap((value) => value.split(/[,;|\n]/u))) {
    const normalized = item.trim();
    const key = normalized.toLocaleLowerCase("en-US");
    if (normalized.length === 0 || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function normalizeDate(value: string | null): string | null {
  if (value === null || /^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u);
  if (match === null) return value;
  return `${match[3]}-${match[1]!.padStart(2, "0")}-${match[2]!.padStart(2, "0")}`;
}

function normalizeRecordUrl(href: string): {
  readonly recordId: string;
  readonly guidUrl: string;
} {
  let url: URL;
  try {
    url = new URL(href, FAA_DRS_PUBLIC_PMA_URL);
  } catch (cause) {
    throw new FaaDrsProtocolError("FAA DRS result contained an invalid record URL", cause);
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "drs.faa.gov" ||
    !url.pathname.startsWith(FAA_DRS_RECORD_PATH_PREFIX)
  ) {
    throw new FaaDrsProtocolError(
      "FAA DRS result URL was not a public document-card link",
    );
  }
  const suffix = url.pathname
    .slice(FAA_DRS_RECORD_PATH_PREFIX.length)
    .replace(/^[/=:]+/u, "");
  if (suffix.length === 0) {
    throw new FaaDrsProtocolError("FAA DRS result URL had no document record id");
  }
  return { recordId: decodeURIComponent(suffix), guidUrl: url.toString() };
}

function queryFilter(query: FaaPmaScrapeQuery): {
  readonly name: FaaDrsFilterName;
  readonly value: string;
} {
  for (const name of Object.keys(FILTER_SELECTORS) as FaaDrsFilterName[]) {
    const value = query[name];
    if (typeof value === "string") return { name, value };
  }
  throw new FaaDrsProtocolError("FAA DRS query contained no supported filter");
}
function assertRecordsMatchFilter(
  records: readonly FaaPmaRecord[],
  filter: { readonly name: FaaDrsFilterName; readonly value: string },
): void {
  const expected = normalizeFilterValue(filter.value);
  for (const record of records) {
    let matches: boolean;
    switch (filter.name) {
      case "holderName":
        matches =
          record.holderName !== null &&
          normalizeFilterValue(record.holderName).includes(expected);
        break;
      case "holderNumber":
        matches =
          record.holderNumber !== null &&
          normalizeFilterValue(record.holderNumber) === expected;
        break;
      case "partNumber":
        matches =
          record.pmaPartNumber !== null &&
          normalizeFilterValue(record.pmaPartNumber) === expected;
        break;
      case "make":
        matches =
          record.make !== null &&
          normalizeFilterValue(record.make).includes(expected);
        break;
      case "model":
        matches = record.models.some((model) =>
          normalizeFilterValue(model).includes(expected),
        );
        break;
    }
    if (!matches) {
      throw new FaaDrsStaleResultsError(filter.name, filter.value);
    }
  }
}

function normalizeFilterValue(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ")
    .trim();
}


function assertAllowedNavigation(location: string): void {
  let url: URL;
  try {
    url = new URL(location);
  } catch (cause) {
    throw new FaaDrsProtocolError("FAA DRS browser navigated to an invalid URL", cause);
  }
  if (/captcha/iu.test(url.href)) throw new FaaDrsAccessError("captcha");
  if (/login|log-in|signin|sign-in|auth/iu.test(url.pathname)) {
    throw new FaaDrsAccessError("authentication_required");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "drs.faa.gov" ||
    url.pathname !== new URL(FAA_DRS_PUBLIC_PMA_URL).pathname
  ) {
    throw new FaaDrsProtocolError(
      "FAA DRS browser left the public PMA document page",
    );
  }
}

function throwForBlockedAccess(status: number | null, bodyText: string): void {
  if (status === 401) throw new FaaDrsAccessError("unauthorized", 401);
  if (status === 403) throw new FaaDrsAccessError("forbidden", 403);
  if (status === 429) throw new FaaDrsAccessError("rate_limited", 429);
  if (/captcha|verify\s+(?:that\s+)?you\s+are\s+human/iu.test(bodyText)) {
    throw new FaaDrsAccessError("captcha");
  }
  if (/\b(?:sign\s*in|log\s*in)\b.*\b(?:required|continue|access)\b/isu.test(bodyText)) {
    throw new FaaDrsAccessError("authentication_required");
  }
}

function resolveChromiumPath(configuredPath: string | undefined): string | undefined {
  const explicit = configuredPath?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const fromEnvironment = process.env.FAA_DRS_CHROMIUM_PATH?.trim();
  if (fromEnvironment !== undefined && fromEnvironment.length > 0) {
    return fromEnvironment;
  }
  return process.platform === "linux" ? "/usr/bin/chromium" : undefined;
}

function normalizeBrowserError(cause: unknown): SourceFetchError {
  if (cause instanceof SourceFetchError) return cause;
  return new SourceFetchError("FAA DRS guest-browser query failed", {
    transient: true,
    cause,
  });
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value > 0
    ? value
    : fallback;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`Expected an integer between 0 and ${maximum}`);
  }
  return value;
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
