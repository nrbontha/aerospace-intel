/**
 * Enrichment benchmark (spec §9B.2 direct-name variant) — extraction schema.
 *
 * The model receives fetched, de-HTMLed page text for one named company and
 * returns an {@link EnrichmentProfile}. Priority/Grata data is NEVER shown to
 * the model: comparison happens afterwards against the golden_examples
 * grata_payload stored in the database.
 */
import { z } from "zod";

export const ENRICHMENT_PROFILE_SCHEMA_NAME = "enrichment_profile_v1";

export const provenanceEntrySchema = z.strictObject({
  field: z.string().min(1),
  url: z.string().min(1),
  excerpt: z.string().min(1).max(200),
});

export const enrichProfileSchema = z.strictObject({
  identity: z.strictObject({
    legalName: z.string().min(1),
    domain: z.string().min(1),
    hqState: z.optional(z.string().min(1)),
    hqCity: z.optional(z.string().min(1)),
  }),
  size: z.strictObject({
    revenueEstimateUsd: z.optional(z.number().positive().finite()),
    revenueBasis: z.optional(z.string().min(1)),
    employees: z.optional(z.number().int().positive().finite()),
  }),
  ownership: z.strictObject({
    ownershipType: z.string().min(1),
    parentOrSponsor: z.optional(z.string().min(1)),
  }),
  business: z.strictObject({
    descriptionOneLiner: z.string().min(1),
    manufacturesProducts: z.boolean(),
    distributes: z.boolean(),
    services: z.boolean(),
    pmaMentioned: z.boolean(),
    proprietaryLanguage: z.boolean(),
  }),
  provenance: z.array(provenanceEntrySchema).max(24),
});

export type EnrichmentProfile = z.infer<typeof enrichProfileSchema>;
export type ProvenanceEntry = z.infer<typeof provenanceEntrySchema>;

/** Canonical ownership groups after keyword classification. */
export const OWNERSHIP_GROUPS = [
  "public_subsidiary",
  "private_subsidiary",
  "sponsor_backed",
  "public",
  "bootstrapped",
  "unknown",
] as const;
export type OwnershipGroup = (typeof OWNERSHIP_GROUPS)[number];

const STATE_NAMES: Record<string, true> = {
  alabama: true, alaska: true, arizona: true, arkansas: true,
  california: true, colorado: true, connecticut: true, delaware: true,
  florida: true, georgia: true, hawaii: true, idaho: true, illinois: true,
  indiana: true, iowa: true, kansas: true, kentucky: true, louisiana: true,
  maine: true, maryland: true, massachusetts: true, michigan: true,
  minnesota: true, mississippi: true, missouri: true, montana: true,
  nebraska: true, nevada: true, "new hampshire": true, "new jersey": true,
  "new mexico": true, "new york": true, "north carolina": true,
  "north dakota": true, ohio: true, oklahoma: true, oregon: true,
  pennsylvania: true, "rhode island": true, "south carolina": true,
  "south dakota": true, tennessee: true, texas: true, utah: true,
  vermont: true, virginia: true, washington: true, "west virginia": true,
  wisconsin: true, wyoming: true,
};

const STATE_ABBREVIATIONS: Record<string, string> = {
  al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas",
  ca: "california", co: "colorado", ct: "connecticut", de: "delaware",
  fl: "florida", ga: "georgia", hi: "hawaii", id: "idaho", il: "illinois",
  in: "indiana", ia: "iowa", ks: "kansas", ky: "kentucky", la: "louisiana",
  me: "maine", md: "maryland", ma: "massachusetts", mi: "michigan",
  mn: "minnesota", ms: "mississippi", mo: "missouri", mt: "montana",
  ne: "nebraska", nv: "nevada", nh: "new hampshire", nj: "new jersey",
  nm: "new mexico", ny: "new york", nc: "north carolina", nd: "north dakota",
  oh: "ohio", ok: "oklahoma", or: "oregon", pa: "pennsylvania",
  ri: "rhode island", sc: "south carolina", sd: "south dakota",
  tn: "tennessee", tx: "texas", ut: "utah", vt: "vermont",
  va: "virginia", wa: "washington", wv: "west virginia", wi: "wisconsin",
  wy: "wyoming",
};

/** Normalize a state value ("CT" / "Connecticut" / "California, USA") to its full lowercase name when recognized. */
export function normalizeState(value: string): string {
  const cleaned = value.replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
  const withoutCountry = cleaned
    .replace(/\b(usa|u\.s\.a\.|us|united states)\b/gu, " ")
    .replace(/[,.\-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (STATE_ABBREVIATIONS[withoutCountry] !== undefined) return STATE_ABBREVIATIONS[withoutCountry];
  if (STATE_NAMES[withoutCountry] === true) return withoutCountry;
  if (STATE_ABBREVIATIONS[cleaned] !== undefined) return STATE_ABBREVIATIONS[cleaned];
  if (STATE_NAMES[cleaned] === true) return cleaned;
  return withoutCountry.length > 0 ? withoutCountry : cleaned;
}

const SPONSOR_WORDS = /\b(private equity|\bpe\b|pe-owned|pe-backed|investor[- ]backed|venture[- ]backed|\bvc\b|sponsor|majority (?:stake|investment)|growth equity)\b/iu;
const PUBLIC_SUB_WORDS = /\bpublic(?:ly[- ]traded)? subsidiary\b|(?:subsidiary|division) of a public\b/iu;
const PRIVATE_SUB_WORDS = /\bsub(sidiar\w+)?\b/iu;
const BOOTSTRAP_WORDS =
  /\b(bootstrapp\w+|self[- ]fund\w*|founder[- ]own\w*|owner[- ]operat\w*|family[- ]own\w*|no (?:external )?funding|independent(?:ly owned)?|privately held|private(?:ly)? own\w*)\b/iu;
const PUBLIC_COMPANY_WORDS =
  /\b(public(?:ly[- ]traded)? company| publicly listed|listed on|nasdaq|nyse|ipo)\b/iu;

/**
 * Keyword-rule mapping from free-text ownership language to a canonical group.
 * Grata values map through the same function so both sides share one taxonomy.
 */
export function classifyOwnership(text: string | null | undefined): OwnershipGroup {
  const value = (text ?? "").trim();
  if (value.length === 0) return "unknown";
  if (/^bootstrapped$/iu.test(value)) return "bootstrapped";
  if (/^investor backed$|^private equity add-on$|^private equity backed$/iu.test(value)) {
    return "sponsor_backed";
  }
  if (/^public subsidiary$/iu.test(value)) return "public_subsidiary";
  if (/^private subsidiary$/iu.test(value)) return "private_subsidiary";
  if (PUBLIC_SUB_WORDS.test(value)) return "public_subsidiary";
  if (SPONSOR_WORDS.test(value)) return "sponsor_backed";
  if (PUBLIC_COMPANY_WORDS.test(value)) return "public";
  if (PRIVATE_SUB_WORDS.test(value)) return "private_subsidiary";
  if (BOOTSTRAP_WORDS.test(value)) return "bootstrapped";
  return "unknown";
}


export function grataNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.replace(/[^0-9.eE+-]/gu, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

const MAX_DOCUMENT_CHARACTERS = 60_000;

/** Convert fetched HTML to bounded plain text (title, meta description, JSON-LD, body). */
export function htmlToText(content: string, contentType: string): string {
  if (!/html/iu.test(contentType)) {
    return content.replace(/\s+/gu, " ").trim().slice(0, MAX_DOCUMENT_CHARACTERS);
  }
  const title = content.match(/<title[^>]*>([\s\S]*?)<\/title>/iu)?.[1] ?? "";
  const metas = [...content.matchAll(/<meta\b[^>]*>/giu)]
    .map((match) => match[0])
    .flatMap((tag) => {
      const property =
        tag.match(/\sproperty\s*=\s*(["'])([\s\S]*?)\1/iu)?.[2] ??
        tag.match(/\sname\s*=\s*(["'])([\s\S]*?)\1/iu)?.[2];
      const value = tag.match(/\scontent\s*=\s*(["'])([\s\S]*?)\1/iu)?.[2];
      if (
        property === undefined ||
        value === undefined ||
        !/^(description|og:title|og:description|og:site_name)$/iu.test(property)
      ) {
        return [];
      }
      return [value];
    });
  const jsonLd = [...content.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu,
  )].map((match) => match[1] ?? "");
  const body = content
    .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/giu, " ")
    .replace(/<[^>]+>/gu, " ");
  return decodeEntities([title, ...metas, ...jsonLd, body].join(" "))
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_DOCUMENT_CHARACTERS);
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  };
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/giu,
    (match, entity: string) => {
      if (entity.startsWith("#x")) {
        try {
          return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
        } catch {
          return match;
        }
      }
      if (entity.startsWith("#")) {
        try {
          return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
        } catch {
          return match;
        }
      }
      return named[entity.toLocaleLowerCase("en-US")] ?? match;
    },
  );
}

const ABOUT_LINK_PATTERN = /about|company|contact|history|capabilities|team|our-?story|who-we-are/iu;

/** Collect same-host about/contact/capabilities links from raw homepage HTML. */
export function collectAboutLinks(html: string, baseUrl: string, limit = 3): string[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*(["'])([\s\S]*?)\1/giu)) {
    const href = match[2]?.trim();
    if (href === undefined || href.length === 0 || href.startsWith("#")) continue;
    if (!ABOUT_LINK_PATTERN.test(href)) continue;
    let resolved: URL;
    try {
      resolved = new URL(href, base);
    } catch {
      continue;
    }
    if (resolved.hostname !== base.hostname) continue;
    if (!/^https?:$/u.test(resolved.protocol)) continue;
    resolved.hash = "";
    const url = resolved.toString();
    if (!found.includes(url)) found.push(url);
    if (found.length >= limit) break;
  }
  return found;
}

export const EXTRACTION_SYSTEM_PROMPT = `You extract conservative, evidence-backed facts about exactly one named company from the provided web page text (its own website).
Rules:
- Report only what the page text supports. If a field is not supported, omit it rather than guessing.
- hqState/hqCity: the company's headquarters location (US state and city), not a sales office.
- revenueEstimateUsd: only an explicit revenue/annual sales figure stated on the page (number, USD). revenueBasis: quote the phrase or fiscal period it comes from.
- employees: only an explicit employee/headcount count stated on the page.
- ownershipType: free text describing ownership (e.g. "privately held", "subsidiary of X", "private equity backed", "publicly traded").
- manufacturesProducts=true if they make/manufacture products; distributes=true if they distribute/resell others' products; services=true if they provide services (MRO, repair, engineering services).
- pmaMentioned=true only if FAA-PMA / PMA parts approval is mentioned. proprietaryLanguage=true if the page uses proprietary/patented language about their technology or products.
- Every non-boolean field you report MUST have a provenance entry: the source page URL and a verbatim excerpt (max 200 chars) supporting it.`;

export function buildExtractionPrompt(
  companyName: string,
  domain: string,
  documents: ReadonlyArray<{ readonly url: string; readonly text: string }>,
): string {
  const sections = documents.map(
    (doc, index) =>
      `--- PAGE ${index + 1}: ${doc.url} ---\n${doc.text}`,
  );
  return [
    `Company: ${companyName}`,
    `Domain: ${domain}`,
    "",
    ...sections,
    "",
    "Extract the enrichment profile for this company from the page text above.",
    "",
    "OUTPUT CONTRACT (mandatory): reply with exactly ONE raw JSON object — no markdown, no headings, no bullets, no code fences, no commentary before or after. Shape:",
    '{"identity":{"legalName":"...","domain":"...","hqState":"...","hqCity":"..."},"size":{"revenueEstimateUsd":123,"revenueBasis":"...","employees":123},"ownership":{"ownershipType":"...","parentOrSponsor":"..."},"business":{"descriptionOneLiner":"...","manufacturesProducts":true,"distributes":false,"services":false,"pmaMentioned":false,"proprietaryLanguage":false},"provenance":[{"field":"...","url":"...","excerpt":"..."}]}',
    "All five business booleans are REQUIRED (use false when not supported). Omit optional fields you cannot support instead of inventing them.",
  ].join("\n");
}

/**
 * The gateway's structured-output enforcement is provider-dependent; some
 * free-tier models return prose despite response_format. This normalizer
 * repairs common deviations (numeric strings, nulls, unknown keys, over-long
 * excerpts) before strict validation. Throws when required fields are absent
 * so callers can record an honest extraction failure.
 */
export function normalizeExtraction(
  value: unknown,
  fallbackIdentity: { readonly legalName?: string; readonly domain?: string } = {},
): EnrichmentProfile {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("model did not return a JSON object");
  }
  const root = value as Record<string, unknown>;
  const identity = asRecord(root.identity);
  const size = asRecord(root.size);
  const ownership = asRecord(root.ownership);
  const business = asRecord(root.business);

  const legalName =
    firstString(identity["legalName"]) ?? fallbackIdentity.legalName;
  const domain = firstString(identity["domain"]) ?? fallbackIdentity.domain;
  if (legalName === undefined || domain === undefined) {
    throw new Error("extraction missing legalName/domain");
  }
  // The system prompt says "omit rather than guess", so the model omits these
  // when pages don't state them; defaults keep the profile shape honest.
  const ownershipType =
    firstString(ownership["ownershipType"]) ?? "not stated on fetched pages";
  const descriptionOneLiner =
    firstString(business["descriptionOneLiner"]) ??
    `${legalName} — description not stated on fetched pages`;

  const flagNames = [
    "manufacturesProducts",
    "distributes",
    "services",
    "pmaMentioned",
    "proprietaryLanguage",
  ] as const;
  const flags = Object.fromEntries(
    flagNames.map((name) => [name, coerceFlag(business[name])]),
  ) as Record<(typeof flagNames)[number], boolean>;
  for (const name of flagNames) {
    if (flags[name] === undefined) {
      throw new Error(`extraction missing boolean ${name}`);
    }
  }

  const provenance = Array.isArray(root.provenance)
    ? root.provenance.flatMap((entry) => {
        if (entry === null || typeof entry !== "object") return [];
        const record = entry as Record<string, unknown>;
        const field = firstString(record["field"]);
        const url = firstString(record["url"]);
        const excerpt = firstString(record["excerpt"])?.slice(0, 200);
        if (field === undefined || url === undefined || excerpt === undefined) return [];
        return [{ field, url, excerpt }];
      })
    : [];

  return enrichProfileSchema.parse({
    identity: {
      legalName,
      domain,
      ...(firstString(identity["hqState"]) === undefined
        ? {}
        : { hqState: firstString(identity["hqState"]) }),
      ...(firstString(identity["hqCity"]) === undefined
        ? {}
        : { hqCity: firstString(identity["hqCity"]) }),
    },
    size: {
      ...(coercePositiveNumber(size["revenueEstimateUsd"]) === undefined
        ? {}
        : { revenueEstimateUsd: coercePositiveNumber(size["revenueEstimateUsd"]) }),
      ...(firstString(size["revenueBasis"]) === undefined
        ? {}
        : { revenueBasis: firstString(size["revenueBasis"]) }),
      ...(coercePositiveNumber(size["employees"]) === undefined
        ? {}
        : { employees: Math.round(coercePositiveNumber(size["employees"])!) }),
    },
    ownership: {
      ownershipType,
      ...(firstString(ownership["parentOrSponsor"]) === undefined
        ? {}
        : { parentOrSponsor: firstString(ownership["parentOrSponsor"]) }),
    },
    business: {
      descriptionOneLiner,
      manufacturesProducts: flags.manufacturesProducts!,
      distributes: flags.distributes!,
      services: flags.services!,
      pmaMentioned: flags.pmaMentioned!,
      proprietaryLanguage: flags.proprietaryLanguage!,
    },
    provenance: provenance.slice(0, 24),
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function coerceFlag(value: unknown): boolean | undefined {
  if (value === null) return false;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function coercePositiveNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const digits = value.replace(/[$,\s]/gu, "");
    if (/^\d+(\.\d+)?$/u.test(digits)) {
      const parsed = Number.parseFloat(digits);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  return undefined;
}
