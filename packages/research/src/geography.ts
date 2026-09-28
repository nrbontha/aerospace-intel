const STATE_NAMES_BY_CODE: Readonly<Record<string, string>> = {
  al: "alabama",
  ak: "alaska",
  az: "arizona",
  ar: "arkansas",
  ca: "california",
  co: "colorado",
  ct: "connecticut",
  de: "delaware",
  dc: "district of columbia",
  fl: "florida",
  ga: "georgia",
  hi: "hawaii",
  id: "idaho",
  il: "illinois",
  in: "indiana",
  ia: "iowa",
  ks: "kansas",
  ky: "kentucky",
  la: "louisiana",
  me: "maine",
  md: "maryland",
  ma: "massachusetts",
  mi: "michigan",
  mn: "minnesota",
  ms: "mississippi",
  mo: "missouri",
  mt: "montana",
  ne: "nebraska",
  nv: "nevada",
  nh: "new hampshire",
  nj: "new jersey",
  nm: "new mexico",
  ny: "new york",
  nc: "north carolina",
  nd: "north dakota",
  oh: "ohio",
  ok: "oklahoma",
  or: "oregon",
  pa: "pennsylvania",
  ri: "rhode island",
  sc: "south carolina",
  sd: "south dakota",
  tn: "tennessee",
  tx: "texas",
  ut: "utah",
  vt: "vermont",
  va: "virginia",
  wa: "washington",
  wv: "west virginia",
  wi: "wisconsin",
  wy: "wyoming",
};

const STATE_CODES_BY_NAME: Readonly<Record<string, string>> = {
  alabama: "al",
  alaska: "ak",
  arizona: "az",
  arkansas: "ar",
  california: "ca",
  colorado: "co",
  connecticut: "ct",
  delaware: "de",
  "district of columbia": "dc",
  florida: "fl",
  georgia: "ga",
  hawaii: "hi",
  idaho: "id",
  illinois: "il",
  indiana: "in",
  iowa: "ia",
  kansas: "ks",
  kentucky: "ky",
  louisiana: "la",
  maine: "me",
  maryland: "md",
  massachusetts: "ma",
  michigan: "mi",
  minnesota: "mn",
  mississippi: "ms",
  missouri: "mo",
  montana: "mt",
  nebraska: "ne",
  nevada: "nv",
  "new hampshire": "nh",
  "new jersey": "nj",
  "new mexico": "nm",
  "new york": "ny",
  "north carolina": "nc",
  "north dakota": "nd",
  ohio: "oh",
  oklahoma: "ok",
  oregon: "or",
  pennsylvania: "pa",
  "rhode island": "ri",
  "south carolina": "sc",
  "south dakota": "sd",
  tennessee: "tn",
  texas: "tx",
  utah: "ut",
  vermont: "vt",
  virginia: "va",
  washington: "wa",
  "west virginia": "wv",
  wisconsin: "wi",
  wyoming: "wy",
};

/** Normalize a state value ("CT" / "Connecticut" / "California, USA") to its full lowercase name when recognized. */
export function normalizeState(value: string): string {
  const cleaned = value.replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
  const withoutCountry = cleaned
    .replace(/\b(usa|u\.s\.a\.|us|united states)\b/gu, " ")
    .replace(/[,.-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const normalizedWithoutCountry = STATE_NAMES_BY_CODE[withoutCountry];
  if (normalizedWithoutCountry !== undefined) return normalizedWithoutCountry;
  if (STATE_CODES_BY_NAME[withoutCountry] !== undefined) return withoutCountry;
  const normalizedCleaned = STATE_NAMES_BY_CODE[cleaned];
  if (normalizedCleaned !== undefined) return normalizedCleaned;
  if (STATE_CODES_BY_NAME[cleaned] !== undefined) return cleaned;
  return withoutCountry.length > 0 ? withoutCountry : cleaned;
}

/** Return the USPS code for a recognized state name or code. */
export function getUsStateCode(value: string): string | null {
  return STATE_CODES_BY_NAME[normalizeState(value)] ?? null;
}
