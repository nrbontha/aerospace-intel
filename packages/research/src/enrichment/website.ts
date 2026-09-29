/**
 * Website-content evidence for FAA ensemble screening.
 *
 * Reuses safely retrieved identity pages, follows same-site HTML navigation to
 * product/catalog, named hardware/technology, and about/company pages, and
 * keeps at most three evidence pages. Direct requests are independently capped
 * at three; guessed /products and /about paths are fallbacks only when matching
 * navigation is absent.
 * Derived signals include:
 * - websiteOffering: products_menu (product-oriented navigation or a
 *   substantive product/technology page) vs capabilities_only
 *   (services/capabilities pages, no products menu) vs unknown (nothing
 *   fetched or nothing conclusive).
 * - ownershipHints / sizeHints: short excerpts backing ownership and scale
 *   questions (founded/family-owned/subsidiary/acquired; headcount/facility).
 *
 * Exa /contents is a paid fallback only for successfully retrieved pages with
 * no usable server-rendered text. The daily gate covers only those URLs, and
 * spend is recorded for every result returned even when final domain filtering
 * excludes it. The Exa key is supplied by callers and is never logged.
 *
 * Fetch results retain each bounded page's actual text, retrieval time and
 * content hash. Configuration, provider, retryable, budget, and no-content
 * outcomes are explicit. Legacy scheduler persistence writes the content hash
 * and propagates database failures rather than reporting a false success.
 */
import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import { getDatabase, type Database } from "@asi/database/client";
import { normalizeUnifiedName } from "@asi/database";

import {
  exaBudgetScopeId,
  executeAccountedExaContents,
  type ExaAccountingContext,
} from "./exa-budget.js";
import { resolveDocumentId, resolveExaSourceId } from "./exa-persist.js";
import {
  EXA_CONTENTS_URL_LIMIT,
  ExaApiKeyMissingError,
  ExaSearchClient,
  ExaSearchError,
  type ExaSearchErrorCode,
} from "../search/exa.js";
import {
  isRetryableSafeFetchError,
  safeFetchUrl,
  type SafeFetchResult,
} from "../safe-fetch.js";
import type { WebsiteOffering } from "../scoring-axial/features.js";

export type { WebsiteOffering };

/** extraction_method prefix contract: MUST stay "exa_..."-prefixed. */
export const WEBSITE_EVIDENCE_EXTRACTION_METHOD = "exa_website_content_v1";

/** Evidence-metadata keys the runner lookup reads back. */
export const WEBSITE_EVIDENCE_METADATA_KEYS = {
  offering: "website_offering",
  excerpts: "website_excerpts",
  ownershipHints: "ownership_hints",
  sizeHints: "size_hints",
  productHints: "product_hints",
} as const;

/** Total excerpt budget: excerpts are capped to 2,000 chars combined. */
export const WEBSITE_EXCERPTS_MAX_CHARS = 2_000;
const MAX_HINTS_PER_KIND = 6;
/** A product or catalog page must contain more than navigation boilerplate. */
const PRODUCTS_PAGE_MIN_CHARS = 300;
/** A fetched page shorter than this is not useful standalone evidence. */
const PAGE_TEXT_MIN_CHARS = 24;
/** Direct retrieval is bounded separately from the three selected pages. */
const MAX_DIRECT_FETCH_ATTEMPTS = 3;
const MAX_PAGE_TEXT_CHARS = 8_000;
const MAX_PAGES = EXA_CONTENTS_URL_LIMIT;

export interface WebsiteEvidence {
  readonly websiteOffering: WebsiteOffering;
  /** Combined excerpt text, capped at WEBSITE_EXCERPTS_MAX_CHARS. */
  readonly excerpts: string;
  readonly ownershipHints: readonly string[];
  readonly sizeHints: readonly string[];
  readonly productHints: readonly string[];
}
export type WebsiteFetchOutcome =
  | "success"
  | "no_content"
  | "budget_limited"
  | "configuration_error"
  | "retryable_error"
  | "provider_error";

export interface WebsiteFetchedPage {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly textChars: number;
  readonly excerpt: string;
  readonly contentSha256: string;
  readonly retrievedAt: string;
}

export interface WebsiteFetchResult extends WebsiteEvidence {
  readonly outcome: WebsiteFetchOutcome;
  readonly errorCode: ExaSearchErrorCode | null;
  /** Provider-reported cost when known; zero does not assert a free request. */
  readonly costUsd: number;
  readonly fetchesAttempted: number;
  readonly fetchesSucceeded: number;
  /** Compatibility field; prefer outcome === "budget_limited". */
  readonly budgetLimited: boolean;
  /** Actual bounded source text and its content hash, suitable for evidence. */
  readonly pages: readonly WebsiteFetchedPage[];
}

export const EMPTY_WEBSITE_EVIDENCE: WebsiteEvidence = {
  websiteOffering: "unknown",
  excerpts: "",
  ownershipHints: [],
  sizeHints: [],
  productHints: [],
};

export interface FetchWebsiteEvidenceOptions {
  readonly client?:
    | Pick<ExaSearchClient, "fetchContentsWithMetadata">
    | undefined;
  readonly accounting?: ExaAccountingContext | undefined;
  readonly fetch?: typeof fetch | undefined;
  /** Already-safe first-party pages from official-site identity retrieval. */
  readonly sourcePages?: readonly SafeFetchResult[] | undefined;
  /** Injectable direct retrieval boundary; defaults to safeFetchUrl. */
  readonly fetchUrl?: typeof safeFetchUrl | undefined;
}

/**
 * Normalize a bare domain or full URL to an https origin. Returns null when
 * no usable host can be derived.
 */
export function normalizeWebsiteOrigin(domainOrUrl: string): string | null {
  const trimmed = domainOrUrl.trim();
  if (trimmed === "") return null;
  const withScheme =
    trimmed.startsWith("http://") || trimmed.startsWith("https://")
      ? trimmed
      : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return null;
    }
    const host = url.hostname.trim().toLowerCase();
    if (host === "" || host.includes(" ")) return null;
    return `https://${host}`;
  } catch {
    return null;
  }
}

function websitePageBelongsToDomain(
  urlValue: string,
  domainOrUrl: string,
): boolean {
  try {
    const normalizedOrigin = normalizeWebsiteOrigin(domainOrUrl);
    if (normalizedOrigin === null) return false;
    const expected = new URL(normalizedOrigin).hostname
      .toLowerCase()
      .replace(/^www\./u, "");
    const url = new URL(urlValue);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return false;
    }
    const actual = url.hostname.toLowerCase().replace(/^www\./u, "");
    return actual === expected || actual.endsWith(`.${expected}`);
  } catch {
    return false;
  }
}

/** Bounded homepage/product/about fallbacks used only when navigation is absent. */
export function buildWebsitePageUrls(domainOrUrl: string): string[] {
  const origin = normalizeWebsiteOrigin(domainOrUrl);
  if (origin === null) return [];
  return [`${origin}/`, `${origin}/products`, `${origin}/about`].slice(
    0,
    MAX_PAGES,
  );
}

const PRODUCTS_MENU_PATTERN =
  /product\s*(catalog|categories|lines?|overview|menu|families)|air\s+filter\s+catalog|find\s+your\s+(?:air\s+)?filter|our products|shop\s+(all|products)|view\s+(all\s+)?products|featured products|product finder/iu;
const PRODUCT_PAGE_PATTERN =
  /(?:^|[/_.?&=\-\s])(?:catalog|products?|product[\s_-]*(?:catalog|finder|lines?)|parts?|filters?|find[\s_-]*(?:a|your)?[\s_-]*(?:air[\s_-]*)?filter)(?:$|[/_.?&=\-\s])/iu;
const PRODUCT_TECHNOLOGY_PAGE_PATTERN =
  /(?:^|[/_.?&=\-\s])(?:technolog(?:y|ies)|hardware|equipment|pumps?|valves?|actuators?|sensors?|controllers?|filters?|fasteners?|bearings?|motors?|mounts?|fittings?|transducers?)(?:$|[/_.?&=\-\s])/iu;
const ABOUT_PAGE_PATTERN =
  /(?:^|[/_.?&=\-\s])(?:about(?:[\s_-]+us)?|company|history|our[\s_-]+(?:company|story)|who[\s_-]+we[\s_-]+are)(?:$|[/_.?&=\-\s])/iu;
const UNSUPPORTED_NAVIGATION_FILE_PATTERN =
  /\.(?:avif|bmp|csv|docx?|gif|jpe?g|pdf|png|pptx?|svg|tiff?|webp|xlsx?|zip)$/iu;
const NON_VISIBLE_HTML_PATTERN =
  /<!--[\s\S]*?(?:-->|$)|<(script|style|noscript|template)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/giu;
const HTML_TEXT_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  copy: "©",
  gt: ">",
  hellip: "…",
  ldquo: "“",
  lsquo: "‘",
  mdash: "—",
  nbsp: " ",
  ndash: "–",
  quot: '"',
  rdquo: "”",
  rsquo: "’",
};
const CAPABILITIES_PATTERN =
  /capabilit|our services|what we do|contract manufacturing|build.to.print|precision machining services|repair (services|station|capabilit)/iu;
const OWNERSHIP_SENTENCE_PATTERN =
  /founded|family.owned|privately held|subsidiary|division of|acquired by|acquisition|parent compan|a\s+\S+\s+compan(y|ies)\b|owned by|holding compan|private equit|portfolio compan/iu;
const SIZE_SENTENCE_PATTERN =
  /\d[\d,]*\s*(employees|associates|team members|staff|people)|square\s+feet|sq\.?\s*ft\.?|\d+\s*acre|manufacturing (plant|facilit)|facilit(ies|y)\s+(in|across|totaling)|headcount|employees\s+(in|across|worldwide)|(?:revenue|annual sales|sales of)[^.!?]{0,80}\$[\d,.]+\s*(?:m|million|b|billion)\b/iu;
const PRODUCT_CERTIFICATION_PATTERN =
  /\b(?:ISO\s*:?\s*\d{3,5}(?::\d{2,4})?|AS\s*:?\s*\d{3,5}[A-Z]?|EN\s*:?\s*\d{3,5}|NADCAP|(?:FAA[\s-]*)?PMA|STC|TSO)\b|certificate of registration|aerospace quality standard/giu;
const PRODUCT_SENTENCE_PATTERN =
  /patented|patent\s+(pending|no\.)|product\s+(line|catalog|family|series|finder|updates?)|trademark|part\s+number|\bSKU\b|introduces?\s+(the|our|new)|\b(?:we|our)\b[^.!?\n]{0,240}\b(?:actuators?|assembl(?:y|ies)|bearings?|controllers?|couplers?|displays?|filters?|gauges?|instruments?|lighting|load cells?|motors?|pumps?|sensors?|systems?|transducers?|valves?)\b|\b(?:designs?|develops?|engineers?|manufactures?|builds?|produces?|offers?|provides?)\b[^.!?\n]{0,240}\b(?:actuators?|assembl(?:y|ies)|bearings?|controllers?|couplers?|displays?|filters?|gauges?|instruments?|lighting|load cells?|motors?|pumps?|sensors?|systems?|transducers?|valves?)\b|\b(?:actuators?|assembl(?:y|ies)|bearings?|controllers?|couplers?|displays?|filters?|gauges?|instruments?|lighting|load cells?|motors?|pumps?|sensors?|systems?|transducers?|valves?)\b[^.!?\n]{0,160}\b(?:features?|includes?|uses?|delivers?)\b|\b[A-Z]{2,5}(?:-[A-Z]{1,5})?-\d{1,4}(?:-\d{1,4})?[A-Z]?\b/iu;
const OWN_PRODUCT_ACTION_PATTERN =
  /\b(?:we|[A-Z][A-Za-z0-9&.'-]*(?:\s+[A-Z][A-Za-z0-9&.'-]*){0,4})\s+(?:proudly\s+)?(?:designs?|develops?|engineers?|manufactures?|builds?|produces?|introduces?)\b|\bour\b[^.!?\n]{0,120}\b(?:product|system|actuator|assembly|controller|filter|gauge|instrument|sensor|transducer|valve)s?\b/iu;
const PRODUCT_DESCRIPTION_PATTERN =
  /\b(?:features?|includes?|uses?|delivers?|product\s+(?:line|family|series|updates?))\b/iu;
const THIRD_PARTY_SPEAKER_CONTEXT_PATTERN =
  /\b(?:customers?|clients?|partners?|suppliers?)\b[^.!?]{0,100}\b(?:spotlight|story|testimonial|case study|says?|states?|reports?|quote)\b/iu;

/** Split evidence without detaching a legal abbreviation from its predicate. */
export function splitEvidenceSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (const boundary of text.matchAll(/[.!?](?:["”’])?\s+|\n+/gu)) {
    const index = boundary.index;
    const punctuation = text[index] !== "\n";
    const closingQuote =
      punctuation && /["”’]/u.test(text[index + 1] ?? "") ? 1 : 0;
    const end = index + (punctuation ? 1 + closingQuote : 0);
    const next = index + boundary[0].length;
    if (
      text[index] === "." &&
      !boundary[0].includes("\n") &&
      /\b(?:inc|corp|co|ltd|llc|llp)\.$/iu.test(
        text.slice(Math.max(start, index - 5), end),
      ) &&
      /[a-z]/u.test(text.charAt(next))
    ) {
      continue;
    }
    const sentence = text.slice(start, end).trim();
    if (sentence !== "") sentences.push(sentence);
    start = next;
  }
  const remainder = text.slice(start).trim();
  if (remainder !== "") sentences.push(remainder);
  return sentences;
}

function opensSpeakerQuotation(sentence: string, index: number): boolean {
  const preceding = sentence.slice(0, index);
  const following = sentence.slice(index + 1);
  return (
    /\b(?:says?|states?|reports?|explains?|notes?|writes?|(?:customer|client)\s+(?:quote|testimonial))\b\s*:?\s*$/iu.test(
      preceding,
    ) || /^\s*(?:i|my|our|we)\b/iu.test(following)
  );
}

export interface ScopedEvidenceStatement {
  readonly text: string;
  readonly quoted: boolean;
}

/**
 * Split evidence while retaining quotation scope across sentence boundaries.
 * Markdown blockquote scope applies to the full physical line; straight and
 * curly quotation marks remain active until their matching close.
 */
export function splitScopedEvidenceStatements(
  text: string,
): ScopedEvidenceStatement[] {
  const statements: ScopedEvidenceStatement[] = [];
  let straightQuoteOpen = false;
  let curlyDoubleQuoteOpen = false;
  let curlySingleQuoteOpen = false;
  for (const line of text.split(/\n/gu)) {
    const markdownQuote = /^\s*>/u.test(line);
    for (const sentence of splitEvidenceSentences(line)) {
      const startsQuoted =
        straightQuoteOpen || curlyDoubleQuoteOpen || curlySingleQuoteOpen;
      let containsQuoteBoundary = false;
      for (let index = 0; index < sentence.length; index += 1) {
        const character = sentence[index];
        if (character === "“") {
          if (opensSpeakerQuotation(sentence, index)) {
            curlyDoubleQuoteOpen = true;
            containsQuoteBoundary = true;
          }
        } else if (character === "”" && curlyDoubleQuoteOpen) {
          curlyDoubleQuoteOpen = false;
          containsQuoteBoundary = true;
        } else if (character === "‘") {
          if (opensSpeakerQuotation(sentence, index)) {
            curlySingleQuoteOpen = true;
            containsQuoteBoundary = true;
          }
        } else if (
          character === "’" &&
          curlySingleQuoteOpen &&
          !/[A-Za-z0-9]/u.test(sentence[index + 1] ?? "")
        ) {
          curlySingleQuoteOpen = false;
          containsQuoteBoundary = true;
        } else if (
          character === '"' &&
          sentence[index - 1] !== "\\" &&
          !/\d/u.test(sentence[index - 1] ?? "")
        ) {
          if (straightQuoteOpen) {
            straightQuoteOpen = false;
            containsQuoteBoundary = true;
          } else if (opensSpeakerQuotation(sentence, index)) {
            straightQuoteOpen = true;
            containsQuoteBoundary = true;
          }
        }
      }
      statements.push({
        text: sentence,
        quoted: markdownQuote || startsQuoted || containsQuoteBoundary,
      });
    }
  }
  return statements;
}

function scopedHintAt(
  statements: readonly ScopedEvidenceStatement[],
  index: number,
): string {
  const statement = statements[index] as ScopedEvidenceStatement;
  const preceding = statements[index - 1]?.text;
  const preservesSpeakerContext =
    preceding !== undefined &&
    preceding.length <= 600 &&
    THIRD_PARTY_SPEAKER_CONTEXT_PATTERN.test(preceding) &&
    /^\s*(?:>|["“‘])?\s*(?:we|our)\b/iu.test(statement.text);
  const scopedSentence =
    statement.quoted && !/^\s*>/u.test(statement.text)
      ? `> ${statement.text}`
      : statement.text;
  return preservesSpeakerContext
    ? `${preceding}\n${scopedSentence}`
    : scopedSentence;
}

function pickHintSentences(text: string, pattern: RegExp): string[] {
  const out: string[] = [];
  const textForHints = text
    .replace(/[ \t]+/gu, " ")
    .replace(/\s*#{1,6}\s*/gu, "\n");
  const statements = splitScopedEvidenceStatements(textForHints);
  for (const [index, statement] of statements.entries()) {
    const sentence = statement.text;
    if (sentence.length < 24 || sentence.length > 600) continue;
    pattern.lastIndex = 0;
    if (!pattern.test(sentence)) continue;
    const hint = scopedHintAt(statements, index);
    if (!out.includes(hint)) out.push(hint);
    if (out.length >= MAX_HINTS_PER_KIND) break;
  }
  return out;
}

function productHintScore(sentence: string): number {
  const withoutCertification = sentence
    .replace(PRODUCT_CERTIFICATION_PATTERN, " ")
    .replace(/\s+/gu, " ")
    .trim();
  PRODUCT_SENTENCE_PATTERN.lastIndex = 0;
  if (!PRODUCT_SENTENCE_PATTERN.test(withoutCertification)) return 0;
  OWN_PRODUCT_ACTION_PATTERN.lastIndex = 0;
  if (OWN_PRODUCT_ACTION_PATTERN.test(withoutCertification)) return 3;
  PRODUCT_DESCRIPTION_PATTERN.lastIndex = 0;
  return PRODUCT_DESCRIPTION_PATTERN.test(withoutCertification) ? 2 : 1;
}

function pickProductHintSentences(text: string): string[] {
  const textForHints = text
    .replace(/[ \t]+/gu, " ")
    .replace(/\s*#{1,6}\s*/gu, "\n");
  const statements = splitScopedEvidenceStatements(textForHints);
  const candidates: Array<{ hint: string; score: number; order: number }> = [];
  const seenHints = new Set<string>();
  for (const [index, statement] of statements.entries()) {
    if (statement.text.length < 24 || statement.text.length > 600) continue;
    const score = productHintScore(statement.text);
    if (score === 0) continue;
    const hint = scopedHintAt(statements, index);
    if (!seenHints.has(hint)) {
      candidates.push({ hint, score, order: index });
      seenHints.add(hint);
    }
  }
  candidates.sort(
    (left, right) => right.score - left.score || left.order - right.order,
  );
  return candidates
    .slice(0, MAX_HINTS_PER_KIND)
    .map((candidate) => candidate.hint);
}

function joinBoundedHints(hints: readonly string[]): string {
  let excerpts = "";
  const included = new Set<string>();
  for (const hint of hints) {
    if (included.has(hint)) continue;
    const separator = excerpts === "" ? "" : "\n";
    if (
      excerpts.length + separator.length + hint.length >
      WEBSITE_EXCERPTS_MAX_CHARS
    ) {
      continue;
    }
    excerpts += `${separator}${hint}`;
    included.add(hint);
  }
  return excerpts;
}

interface PreferredWebsiteNavigation {
  readonly productUrl: string | null;
  readonly aboutUrl: string | null;
}

interface WebsiteNavigationPage {
  readonly finalUrl: string;
  readonly visibleHtml: string;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&([a-z]+);/giu, (entity, rawName: string) => {
      const decoded = HTML_TEXT_ENTITIES[rawName.toLocaleLowerCase("en-US")];
      return decoded ?? entity;
    })
    .replace(
      /&#(?:x([0-9a-f]+)|([0-9]+));/giu,
      (_entity, rawHex: string | undefined, rawDecimal: string | undefined) => {
        const codePoint = Number.parseInt(
          rawHex ?? rawDecimal ?? "",
          rawHex === undefined ? 10 : 16,
        );
        if (
          !Number.isFinite(codePoint) ||
          codePoint === 0 ||
          codePoint < 0 ||
          codePoint > 0x10ffff ||
          (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ) {
          return "\u{fffd}";
        }
        return String.fromCodePoint(codePoint);
      },
    );
}

const BLOCKQUOTE_OPEN = "\u{e000}";
const BLOCKQUOTE_CLOSE = "\u{e001}";
const HTML_LINE_BREAK_ELEMENTS: Readonly<Record<string, true>> = {
  address: true,
  article: true,
  aside: true,
  br: true,
  dd: true,
  div: true,
  dt: true,
  figcaption: true,
  footer: true,
  form: true,
  h1: true,
  h2: true,
  h3: true,
  h4: true,
  h5: true,
  h6: true,
  header: true,
  li: true,
  main: true,
  nav: true,
  option: true,
  p: true,
  section: true,
  table: true,
  td: true,
  th: true,
  tr: true,
};
const HIDDEN_HTML_END_PATTERNS: Readonly<Record<string, RegExp>> = {
  noscript: /<\/noscript\s*>/giu,
  script: /<\/script\s*>/giu,
  style: /<\/style\s*>/giu,
  template: /<\/template\s*>/giu,
};

function visibleHtmlText(content: string): string {
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const tagStart = content.indexOf("<", cursor);
    if (tagStart === -1) {
      chunks.push(content.slice(cursor));
      break;
    }
    if (tagStart > cursor) chunks.push(content.slice(cursor, tagStart));
    if (content.startsWith("<!--", tagStart)) {
      const commentEnd = content.indexOf("-->", tagStart + 4);
      cursor = commentEnd === -1 ? content.length : commentEnd + 3;
      continue;
    }
    const firstTagCharacter = content[tagStart + 1] ?? "";
    const declaration = firstTagCharacter === "!" || firstTagCharacter === "?";
    const closing = firstTagCharacter === "/";
    let tagNameStart = tagStart + (closing ? 2 : 1);
    while (/\s/u.test(content[tagNameStart] ?? "")) tagNameStart += 1;
    if (!declaration && !/[A-Za-z]/u.test(content[tagNameStart] ?? "")) {
      chunks.push("<");
      cursor = tagStart + 1;
      continue;
    }

    let quote = "";
    let tagEnd = tagNameStart;
    for (; tagEnd < content.length; tagEnd += 1) {
      const character = content[tagEnd] as string;
      if (quote !== "") {
        if (character === quote) quote = "";
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        break;
      }
    }
    if (tagEnd >= content.length) {
      chunks.push(content.slice(tagStart));
      break;
    }
    if (declaration) {
      cursor = tagEnd + 1;
      continue;
    }

    let tagNameEnd = tagNameStart;
    while (/[A-Za-z0-9:-]/u.test(content[tagNameEnd] ?? "")) {
      tagNameEnd += 1;
    }
    const tagName = content
      .slice(tagNameStart, tagNameEnd)
      .toLocaleLowerCase("en-US");
    let closingMarker = tagEnd - 1;
    while (/\s/u.test(content[closingMarker] ?? "")) closingMarker -= 1;
    if (!closing && content[closingMarker] !== "/") {
      const hiddenEndPattern = HIDDEN_HTML_END_PATTERNS[tagName];
      if (hiddenEndPattern !== undefined) {
        hiddenEndPattern.lastIndex = tagEnd + 1;
        const hiddenEnd = hiddenEndPattern.exec(content);
        cursor =
          hiddenEnd === null ? content.length : hiddenEndPattern.lastIndex;
        continue;
      }
    }
    if (tagName === "blockquote") {
      chunks.push(
        closing ? `\n${BLOCKQUOTE_CLOSE}\n` : `\n${BLOCKQUOTE_OPEN}\n`,
      );
    } else if (HTML_LINE_BREAK_ELEMENTS[tagName] === true) {
      chunks.push("\n");
    }
    cursor = tagEnd + 1;
  }
  return chunks.join("");
}

function markBlockquoteLines(value: string): string {
  const lines: string[] = [];
  let blockquoteDepth = 0;
  for (const rawLine of value.split("\n")) {
    const line = rawLine.trim();
    if (line === BLOCKQUOTE_OPEN) {
      blockquoteDepth += 1;
      continue;
    }
    if (line === BLOCKQUOTE_CLOSE) {
      blockquoteDepth = Math.max(0, blockquoteDepth - 1);
      continue;
    }
    if (line === "") {
      lines.push("");
      continue;
    }
    lines.push(
      blockquoteDepth > 0 && !line.startsWith(">") ? `> ${line}` : line,
    );
  }
  return lines.join("\n");
}

/** Normalize visible page text while preserving every HTML blockquote line. */
export function normalizeEvidencePageText(content: string): string {
  return markBlockquoteLines(
    decodeHtmlEntities(visibleHtmlText(content))
      .replace(/\r\n?/gu, "\n")
      .replace(/[^\S\n]+/gu, " ")
      .replace(/ *\n */gu, "\n")
      .replace(/\n{3,}/gu, "\n\n")
      .trim(),
  ).trim();
}

function boundEvidenceText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const prefix = trimmed.slice(0, maxChars);
  let boundary = 0;
  for (const match of prefix.matchAll(/\n|[.!?](?:["”’])?(?=\s|$)/gu)) {
    boundary = (match.index ?? 0) + match[0].length;
  }
  if (boundary >= Math.floor(maxChars * 0.75)) {
    return prefix.slice(0, boundary).trimEnd();
  }
  const whitespace = prefix.lastIndexOf(" ");
  return prefix
    .slice(0, whitespace >= Math.floor(maxChars * 0.75) ? whitespace : maxChars)
    .trimEnd();
}

function safePageText(result: SafeFetchResult, visibleContent: string): string {
  const content =
    result.contentType === "text/html"
      ? normalizeEvidencePageText(visibleContent)
      : visibleContent
          .replace(/\r\n?/gu, "\n")
          .replace(/[^\S\n]+/gu, " ")
          .replace(/ *\n */gu, "\n")
          .replace(/\n{3,}/gu, "\n\n")
          .trim();
  return boundEvidenceText(content, MAX_PAGE_TEXT_CHARS);
}

function websitePageFromSafeFetch(
  result: SafeFetchResult,
  visibleContent: string,
): WebsiteFetchedPage | null {
  const text = safePageText(result, visibleContent);
  if (text.length < PAGE_TEXT_MIN_CHARS) return null;
  const rawTitle =
    result.contentType === "text/html"
      ? /<title\b[^>]*>([\s\S]*?)<\/title>/iu.exec(visibleContent)?.[1]
      : undefined;
  const title =
    rawTitle === undefined
      ? ""
      : decodeHtmlEntities(rawTitle.replace(/<[^>]+>/gu, " "))
          .replace(/\s+/gu, " ")
          .trim()
          .slice(0, 240);
  return {
    url: result.finalUrl,
    title,
    text,
    textChars: text.length,
    excerpt: boundEvidenceText(text, 500).replace(/\s+/gu, " ").trim(),
    contentSha256: result.contentSha256,
    retrievedAt: result.retrievedAt,
  };
}

function canonicalWebsiteUrl(urlValue: string): string | null {
  try {
    const url = new URL(urlValue);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return null;
    }
    url.hash = "";
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/u, "");
    return url.href;
  } catch {
    return null;
  }
}

function websitePageKind(
  page: Pick<WebsiteFetchedPage, "url" | "title">,
): "home" | "product" | "about" | "other" {
  try {
    const url = new URL(page.url);
    if (
      url.pathname === "/" ||
      /(?:^|\/)(?:index|home)(?:\.(?:aspx?|cfm|html?|php))?\/?$/iu.test(
        url.pathname,
      )
    ) {
      return "home";
    }
    const descriptor = `${url.pathname} ${url.search} ${page.title}`;
    if (
      PRODUCT_PAGE_PATTERN.test(descriptor) ||
      PRODUCT_TECHNOLOGY_PAGE_PATTERN.test(descriptor)
    ) {
      return "product";
    }
    if (ABOUT_PAGE_PATTERN.test(descriptor)) return "about";
  } catch {
    // Invalid page URLs are filtered before selection.
  }
  return "other";
}

function discoverPreferredNavigation(
  pages: readonly WebsiteNavigationPage[],
  domainOrUrl: string,
): PreferredWebsiteNavigation {
  const productLinks: Array<{ url: string; score: number; order: number }> = [];
  const aboutLinks: Array<{ url: string; score: number; order: number }> = [];
  let order = 0;
  const anchors =
    /<a\b([^>]*?)\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))([^>]*)>([\s\S]*?)<\/a\s*>/giu;
  for (const page of pages) {
    let base: URL;
    try {
      base = new URL(page.finalUrl);
    } catch {
      continue;
    }
    for (const match of page.visibleHtml.matchAll(anchors)) {
      const rawHref = match[2] ?? match[3] ?? match[4];
      if (rawHref === undefined || rawHref.trim() === "") continue;
      let url: URL;
      try {
        url = new URL(decodeHtmlEntities(rawHref), base);
      } catch {
        continue;
      }
      url.hash = "";
      if (
        !websitePageBelongsToDomain(url.href, domainOrUrl) ||
        UNSUPPORTED_NAVIGATION_FILE_PATTERN.test(url.pathname)
      ) {
        continue;
      }
      const attributes = `${match[1] ?? ""} ${match[5] ?? ""}`;
      const rawTitle =
        /\btitle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/iu.exec(attributes);
      const linkText = decodeHtmlEntities(
        (match[6] ?? "").replace(/<[^>]+>/gu, " "),
      )
        .replace(/\s+/gu, " ")
        .trim();
      const title = decodeHtmlEntities(
        rawTitle?.[1] ?? rawTitle?.[2] ?? rawTitle?.[3] ?? "",
      );
      const descriptor = `${url.pathname} ${url.search} ${linkText} ${title}`;
      const canonical = canonicalWebsiteUrl(url.href);
      if (canonical === null) continue;
      if (
        PRODUCT_PAGE_PATTERN.test(descriptor) ||
        PRODUCT_TECHNOLOGY_PAGE_PATTERN.test(descriptor)
      ) {
        productLinks.push({
          url: canonical,
          score: /catalog/iu.test(descriptor)
            ? 4
            : /find[\s_-]*(?:a|your)?[\s_-]*(?:air[\s_-]*)?filter/iu.test(
                  descriptor,
                )
              ? 3
              : PRODUCT_PAGE_PATTERN.test(descriptor)
                ? 2
                : 1,
          order,
        });
      } else if (ABOUT_PAGE_PATTERN.test(descriptor)) {
        aboutLinks.push({ url: canonical, score: 1, order });
      }
      order += 1;
    }
  }
  productLinks.sort(
    (left, right) => right.score - left.score || left.order - right.order,
  );
  aboutLinks.sort(
    (left, right) => right.score - left.score || left.order - right.order,
  );
  return {
    productUrl: productLinks[0]?.url ?? null,
    aboutUrl: aboutLinks[0]?.url ?? null,
  };
}

function selectWebsitePages(
  pages: readonly WebsiteFetchedPage[],
  sourcePageKeys: ReadonlySet<string>,
): WebsiteFetchedPage[] {
  const selected: WebsiteFetchedPage[] = [];
  const selectedKeys = new Set<string>();
  const add = (page: WebsiteFetchedPage | undefined): void => {
    if (page === undefined || selected.length >= MAX_PAGES) return;
    const key = canonicalWebsiteUrl(page.url);
    if (key === null || selectedKeys.has(key)) return;
    selectedKeys.add(key);
    selected.push(page);
  };
  const sourcePages = pages.filter((page) => {
    const key = canonicalWebsiteUrl(page.url);
    return key !== null && sourcePageKeys.has(key);
  });
  add(
    sourcePages.find((page) => websitePageKind(page) === "home") ??
      sourcePages[0] ??
      pages.find((page) => websitePageKind(page) === "home") ??
      pages[0],
  );
  add(pages.find((page) => websitePageKind(page) === "product"));
  add(pages.find((page) => websitePageKind(page) === "about"));
  for (const page of pages) add(page);
  return selected;
}

/**
 * Pure classifier over fetched page texts (keyed by URL). Exported for the
 * scheduler persistence step and tests.
 */
export function classifyWebsiteEvidence(
  pages: readonly {
    readonly url: string;
    readonly text: string;
    readonly title?: string;
  }[],
): WebsiteEvidence {
  const combined = pages.map((p) => p.text).join("\n\n");
  const productsPage = pages.find(
    (page) =>
      websitePageKind({ url: page.url, title: page.title ?? "" }) === "product",
  );
  const productsPageSubstantive =
    productsPage !== undefined &&
    productsPage.text.trim().length >= PRODUCTS_PAGE_MIN_CHARS;
  PRODUCTS_MENU_PATTERN.lastIndex = 0;
  const hasProductsMenu =
    productsPageSubstantive || PRODUCTS_MENU_PATTERN.test(combined);
  let websiteOffering: WebsiteOffering = "unknown";
  if (hasProductsMenu) {
    websiteOffering = "products_menu";
  } else if (combined.trim() !== "") {
    CAPABILITIES_PATTERN.lastIndex = 0;
    websiteOffering = CAPABILITIES_PATTERN.test(combined)
      ? "capabilities_only"
      : "unknown";
  }
  const ownershipHints = pickHintSentences(
    combined,
    OWNERSHIP_SENTENCE_PATTERN,
  );
  const sizeHints = pickHintSentences(combined, SIZE_SENTENCE_PATTERN);
  const productHints = pickProductHintSentences(combined);
  const excerpts = joinBoundedHints([
    ...productHints,
    ...ownershipHints,
    ...sizeHints,
  ]);
  return { websiteOffering, excerpts, ownershipHints, sizeHints, productHints };
}

/**
 * Collect bounded first-party website evidence for one verified domain.
 * Already-safe identity pages are reused, direct retrieval follows actual
 * same-site HTML navigation, and Exa is reserved for pages that were retrieved
 * successfully but yielded no usable server-rendered text. Operational
 * retrieval failures are therefore never hidden by a paid fallback.
 */
export async function fetchWebsiteEvidence(
  apiKey: string,
  domainOrUrl: string,
  _companyName: string,
  options: FetchWebsiteEvidenceOptions = {},
): Promise<WebsiteFetchResult> {
  const fallbackUrls = buildWebsitePageUrls(domainOrUrl);
  let fetchesAttempted = 0;
  let costUsd = 0;
  let sawRetryableFailure = false;
  let sawPermanentFailure = false;
  const finish = (
    outcome: WebsiteFetchOutcome,
    pages: readonly WebsiteFetchedPage[],
    errorCode: ExaSearchErrorCode | null = null,
  ): WebsiteFetchResult => {
    const evidence =
      pages.length === 0
        ? EMPTY_WEBSITE_EVIDENCE
        : classifyWebsiteEvidence(pages);
    return {
      ...evidence,
      outcome,
      errorCode,
      costUsd,
      fetchesAttempted,
      fetchesSucceeded: pages.length,
      budgetLimited: outcome === "budget_limited",
      pages,
    };
  };
  if (fallbackUrls.length === 0) return finish("no_content", []);

  const fetchUrl = options.fetchUrl ?? safeFetchUrl;
  const safePages: SafeFetchResult[] = [];
  const navigationPages: WebsiteNavigationPage[] = [];
  const pagesByUrl = new Map<string, WebsiteFetchedPage>();
  const sourcePageKeys = new Set<string>();
  const knownSafePageKeys = new Set<string>();
  const attemptedKeys = new Set<string>();
  const exaCandidateUrls: string[] = [];
  const acceptSafePage = (
    result: SafeFetchResult,
    sourcePage: boolean,
  ): boolean => {
    if (!websitePageBelongsToDomain(result.finalUrl, domainOrUrl)) return false;
    const key = canonicalWebsiteUrl(result.finalUrl);
    if (key === null) return false;
    if (sourcePage) sourcePageKeys.add(key);
    const visibleContent =
      result.contentType === "text/html"
        ? result.content.replace(NON_VISIBLE_HTML_PATTERN, " ")
        : result.content;
    if (!knownSafePageKeys.has(key)) {
      knownSafePageKeys.add(key);
      safePages.push(result);
      if (result.contentType === "text/html") {
        navigationPages.push({
          finalUrl: result.finalUrl,
          visibleHtml: visibleContent,
        });
      }
    }
    const page = websitePageFromSafeFetch(result, visibleContent);
    if (page === null) {
      if (!exaCandidateUrls.includes(result.finalUrl)) {
        exaCandidateUrls.push(result.finalUrl);
      }
      return true;
    }
    if (!pagesByUrl.has(key)) pagesByUrl.set(key, page);
    return true;
  };
  for (const sourcePage of (options.sourcePages ?? []).slice(0, MAX_PAGES)) {
    acceptSafePage(sourcePage, true);
  }

  const fetchDirectPage = async (url: string): Promise<void> => {
    if (fetchesAttempted >= MAX_DIRECT_FETCH_ATTEMPTS) return;
    const requestKey = canonicalWebsiteUrl(url);
    if (
      requestKey === null ||
      attemptedKeys.has(requestKey) ||
      knownSafePageKeys.has(requestKey) ||
      !websitePageBelongsToDomain(url, domainOrUrl)
    ) {
      return;
    }
    attemptedKeys.add(requestKey);
    fetchesAttempted += 1;
    let fetched: SafeFetchResult;
    try {
      fetched = await fetchUrl(url);
    } catch (error) {
      if (isRetryableSafeFetchError(error)) {
        sawRetryableFailure = true;
      } else {
        sawPermanentFailure = true;
      }
      return;
    }
    if (!acceptSafePage(fetched, false)) sawPermanentFailure = true;
  };

  const hasSafePageKind = (kind: "home" | "product" | "about"): boolean =>
    safePages.some(
      (page) => websitePageKind({ url: page.finalUrl, title: "" }) === kind,
    );
  if (!hasSafePageKind("home")) {
    await fetchDirectPage(fallbackUrls[0] as string);
  }

  let navigation = discoverPreferredNavigation(navigationPages, domainOrUrl);
  if (!hasSafePageKind("product")) {
    await fetchDirectPage(navigation.productUrl ?? (fallbackUrls[1] as string));
  }
  navigation = discoverPreferredNavigation(navigationPages, domainOrUrl);
  if (!hasSafePageKind("about")) {
    await fetchDirectPage(navigation.aboutUrl ?? (fallbackUrls[2] as string));
  }

  const directPages = selectWebsitePages(
    [...pagesByUrl.values()],
    sourcePageKeys,
  );
  if (sawRetryableFailure) {
    return finish("retryable_error", directPages);
  }
  if (directPages.length > 0) return finish("success", directPages);
  if (sawPermanentFailure) return finish("provider_error", []);

  const exaUrls = exaCandidateUrls.slice(0, MAX_PAGES);
  if (exaUrls.length === 0) return finish("no_content", []);
  if (
    (apiKey.trim().length === 0 && options.client === undefined) ||
    options.accounting === undefined
  ) {
    return finish("configuration_error", []);
  }
  const client =
    options.client ??
    new ExaSearchClient({
      apiKey,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  let providerCostUsd: string | null;
  let results: readonly { url: string; title: string; text: string }[];
  fetchesAttempted += exaUrls.length;
  try {
    const accounted = await executeAccountedExaContents(
      options.accounting,
      client,
      exaUrls,
    );
    if (accounted.outcome === "deferred") {
      return finish("budget_limited", []);
    }
    if (accounted.outcome === "ambiguous") {
      return finish("retryable_error", []);
    }
    results = accounted.results;
    providerCostUsd = accounted.providerCostUsd;
    costUsd =
      providerCostUsd === null ? 0 : Number.parseFloat(providerCostUsd);
  } catch (error) {
    if (error instanceof ExaApiKeyMissingError) {
      return finish("configuration_error", []);
    }
    if (error instanceof ExaSearchError) {
      return finish(
        error.transient ? "retryable_error" : "provider_error",
        [],
        error.code,
      );
    }
    return finish("retryable_error", []);
  }
  const retrievedAt = new Date().toISOString();
  const exaPages = results
    .filter(
      (result) =>
        result.text.trim() !== "" &&
        websitePageBelongsToDomain(result.url, domainOrUrl),
    )
    .slice(0, MAX_PAGES)
    .map((result): WebsiteFetchedPage => {
      const text = boundEvidenceText(result.text, MAX_PAGE_TEXT_CHARS);
      return {
        url: result.url,
        title: result.title,
        text,
        textChars: text.length,
        excerpt: boundEvidenceText(text, 500).replace(/\s+/gu, " ").trim(),
        contentSha256: sha256Hex(text),
        retrievedAt,
      };
    });
  if (exaPages.length === 0) return finish("no_content", []);
  return finish("success", selectWebsitePages(exaPages, sourcePageKeys));
}

// ---------------------------------------------------------------------------
// Scheduler tick entry-point (research queue + P1, cap 10/tick)
// ---------------------------------------------------------------------------

/** Scheduler cap: at most this many website enrichments per tick. */
export const WEBSITE_ENRICHMENT_TICK_CAP = 10;

export interface WebsiteEnrichmentCandidate {
  readonly companyName: string;
  readonly domain: string | null;
  readonly sourceSignalId: string;
}

export interface WebsiteEnrichmentOptions {
  /** Max domains to enrich; clamped to WEBSITE_ENRICHMENT_TICK_CAP. */
  readonly limit?: number;
  /** Defaults to process.env.EXA_API_KEY (never logged). */
  readonly exaApiKey?: string;
}

export interface WebsiteEnrichmentSummary {
  readonly checked: number;
  readonly enriched: number;
  readonly skipped: string | null;
  readonly costUsd: number;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Explicit legacy projection persistence. The evidence document hash is the
 * fetched bounded content hash, not a URL/classification surrogate.
 * Persistence failures propagate to the scheduler summary.
 */
async function persistWebsiteEvidence(
  db: Database,
  companyName: string,
  result: WebsiteFetchResult,
): Promise<void> {
  if (result.fetchesSucceeded === 0) return;
  const sourceId = await resolveExaSourceId(db, "website");
  if (sourceId === null) {
    throw new Error("Unable to persist website evidence source");
  }
  const metadata = JSON.stringify({
    companyName,
    [WEBSITE_EVIDENCE_METADATA_KEYS.offering]: result.websiteOffering,
    [WEBSITE_EVIDENCE_METADATA_KEYS.excerpts]: result.excerpts,
    [WEBSITE_EVIDENCE_METADATA_KEYS.ownershipHints]: result.ownershipHints,
    [WEBSITE_EVIDENCE_METADATA_KEYS.sizeHints]: result.sizeHints,
    [WEBSITE_EVIDENCE_METADATA_KEYS.productHints]: result.productHints,
  });
  const pageUrls: string[] = [];
  for (const page of result.pages) {
    const documentId = await resolveDocumentId(db, {
      sourceId,
      url: page.url,
      title: page.title || `Official site: ${companyName}`,
      documentType: "web_page",
      contentHash: page.contentSha256,
      metadataJson: JSON.stringify({
        companyName,
        method: WEBSITE_EVIDENCE_EXTRACTION_METHOD,
        retrievedAt: page.retrievedAt,
        textChars: page.textChars,
      }),
    });
    if (documentId === null) {
      throw new Error(`Unable to persist website document ${page.url}`);
    }
    pageUrls.push(page.url);
    const inserted = await db.execute<{ id: string }>(sql`
      INSERT INTO evidence
        (source_document_id, quote, locator, extraction_method, content_sha256, metadata)
      VALUES (
        ${documentId},
        ${page.excerpt},
        ${page.url},
        ${WEBSITE_EVIDENCE_EXTRACTION_METHOD},
        ${sha256Hex(page.excerpt)},
        ${metadata}::jsonb
      )
      RETURNING id
    `);
    if (inserted.rows[0]?.id === undefined) {
      throw new Error(`Unable to persist website evidence ${page.url}`);
    }
  }
  if (pageUrls.length === 0) return;
  const normalized = normalizeUnifiedName(companyName);
  await db.execute(sql`
    UPDATE unified_targets
    SET evidence_urls = (
      SELECT COALESCE(jsonb_agg(DISTINCT e), '[]'::jsonb)
      FROM jsonb_array_elements_text(
        COALESCE(unified_targets.evidence_urls, '[]'::jsonb) || ${JSON.stringify(pageUrls)}::jsonb
      ) AS e
    ),
    updated_at = now()
    WHERE normalized_name = ${normalized}
  `);
}

/**
 * Research-queue / P1 names with a domain that have no website evidence yet,
 * oldest-touched first. "Unvetted" is derived (no schema changes): no
 * evidence row with the website extraction method is linked to a document
 * whose URL contains the target's domain.
 */
export async function selectWebsiteEnrichmentCandidates(
  db: Database,
  limit: number,
): Promise<WebsiteEnrichmentCandidate[]> {
  const capped = Math.max(0, Math.min(limit, WEBSITE_ENRICHMENT_TICK_CAP));
  if (capped === 0) return [];
  const result = await db.execute<{
    company_name: string;
    domain: string | null;
    website_url: string | null;
    signal_id: string;
  }>(sql`
    SELECT company_name, domain, website_url, signal_id
    FROM unified_targets ut
    WHERE (
        tier IN ('needs_research', 'evaluate', 'high_interest')
        OR investor_priority = 1
      )
      AND COALESCE(domain, website_url) IS NOT NULL
      AND COALESCE(domain, website_url) <> ''
      AND signal_id IS NOT NULL
      AND (
        NOT EXISTS (
          SELECT 1 FROM evidence e
          JOIN source_documents sd ON sd.id = e.source_document_id
          WHERE e.extraction_method = ${WEBSITE_EVIDENCE_EXTRACTION_METHOD}
            AND position(lower(COALESCE(ut.domain, ut.website_url, '')) in lower(sd.canonical_url)) > 0
        )
        OR (
          -- Flaky-fetch recovery (bakeoff finding): a thin first fetch
          -- permanently starves rung 2, so retry while evidence stays
          -- excerpt-poor and attempts are below the bound.
          (
            SELECT COUNT(*)
            FROM evidence e
            JOIN source_documents sd ON sd.id = e.source_document_id
            WHERE e.extraction_method = ${WEBSITE_EVIDENCE_EXTRACTION_METHOD}
              AND position(lower(COALESCE(ut.domain, ut.website_url, '')) in lower(sd.canonical_url)) > 0
          ) < 3
          AND NOT EXISTS (
            SELECT 1 FROM evidence e
            JOIN source_documents sd ON sd.id = e.source_document_id
            WHERE e.extraction_method = ${WEBSITE_EVIDENCE_EXTRACTION_METHOD}
              AND position(lower(COALESCE(ut.domain, ut.website_url, '')) in lower(sd.canonical_url)) > 0
              AND COALESCE(e.metadata->>'website_excerpts', '') <> ''
          )
        )
      )
    ORDER BY updated_at ASC NULLS FIRST
    LIMIT ${capped}
  `);
  return result.rows.map((row) => ({
    companyName: row.company_name,
    domain: row.domain ?? row.website_url,
    sourceSignalId: row.signal_id,
  }));
}

/**
 * Batch website sweep for the scheduler tick: research queue + P1,
 * cap WEBSITE_ENRICHMENT_TICK_CAP/tick, stops early when the
 * EXA_DAILY_BUDGET_USD cap is reached. Key sourced from EXA_API_KEY env
 * unless overridden. Never throws.
 */
export async function runWebsiteEnrichment(
  db: Database = getDatabase(),
  opts: WebsiteEnrichmentOptions = {},
): Promise<WebsiteEnrichmentSummary> {
  try {
    const apiKey = opts.exaApiKey ?? process.env["EXA_API_KEY"] ?? "";
    if (apiKey.trim().length === 0) {
      return {
        checked: 0,
        enriched: 0,
        skipped: "missing_exa_api_key",
        costUsd: 0,
      };
    }
    const candidates = await selectWebsiteEnrichmentCandidates(
      db,
      opts.limit ?? WEBSITE_ENRICHMENT_TICK_CAP,
    );
    let checked = 0;
    let enriched = 0;
    let costUsd = 0;
    let skipped: string | null =
      candidates.length === 0 ? "no_candidates" : null;
    for (const candidate of candidates) {
      if (candidate.domain === null) {
        skipped = "no_domain";
        continue;
      }
      const outcome = await fetchWebsiteEvidence(
        apiKey,
        candidate.domain,
        candidate.companyName,
        {
          accounting: {
            db,
            budgetScopeId: exaBudgetScopeId(),
            sourceSignalId: candidate.sourceSignalId,
          },
        },
      );
      checked += 1;
      costUsd += outcome.costUsd;
      if (outcome.outcome === "budget_limited") {
        skipped = "budget_exhausted";
        break;
      }
      if (outcome.outcome === "configuration_error") {
        skipped = "missing_exa_api_key";
        break;
      }
      if (
        outcome.outcome === "retryable_error" ||
        outcome.outcome === "provider_error"
      ) {
        skipped = "provider_error";
        break;
      }
      if (outcome.outcome === "success") {
        await persistWebsiteEvidence(db, candidate.companyName, outcome);
        enriched += 1;
      } else {
        const normalized = normalizeUnifiedName(candidate.companyName);
        await db.execute(sql`
          UPDATE unified_targets SET updated_at = now()
          WHERE normalized_name = ${normalized}
        `);
      }
    }
    return { checked, enriched, skipped, costUsd };
  } catch {
    return { checked: 0, enriched: 0, skipped: "error", costUsd: 0 };
  }
}
