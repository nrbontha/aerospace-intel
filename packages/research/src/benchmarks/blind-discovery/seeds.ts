/**
 * Blind-discovery seed construction.
 *
 * Seeds are derived from golden-archetype capability/platform language ONLY:
 * no company names, no domains, no person or place identifiers tied to a
 * known company. `findIdentityLeaks` is a pure guard proving that.
 */

export interface BlindSeeds {
  readonly sources: readonly string[];
  readonly geography: readonly string[];
  readonly platforms: readonly string[];
  readonly capabilities: readonly string[];
}

/**
 * Archetype-derived seeds. The golden archetype is "small US precision
 * component manufacturer feeding aerospace primes" — expressed here only as
 * process capabilities, platform families, and US aerospace-manufacturing
 * geography.
 */
export function buildBlindSeeds(): BlindSeeds {
  return {
    sources: ["usaspending"],
    geography: ["US"],
    platforms: [
      "fixed-wing aircraft",
      "rotorcraft",
      "unmanned aerial systems",
      "spacecraft hardware",
    ],
    capabilities: [
      "precision CNC machining",
      "sheet metal fabrication",
      "cable and wire harness assembly",
      "surface treatment and finishing",
      "fastener manufacturing",
      "casting and forging",
    ],
  };
}

const STOPWORDS: Record<string, true> = {
  and: true,
  for: true,
  the: true,
  with: true,
};

export interface IdentityLeak {
  readonly seedField: keyof BlindSeeds;
  readonly seedValue: string;
  /** The leaked phrase or domain substring. */
  readonly leakedToken: string;
  /** The forbidden identity string whose phrase appeared in the seed. */
  readonly forbiddenValue: string;
}

/** Lowercase word sequence of a string (stopwords removed, tokens ≥ 2 chars). */
function wordsOf(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((t) => t.length >= 2 && STOPWORDS[t] !== true);
}

function containsSequence(
  haystack: readonly string[],
  needle: readonly string[],
): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    let matched = true;
    for (let i = 0; i < needle.length; i += 1) {
      if (haystack[start + i] !== needle[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/**
 * Pure leak guard.
 *
 * A seed "targets" a known entity when it embeds a phrase from that
 * entity's name — any consecutive 2-token n-gram of the name — or the
 * entity's domain as a substring. Single shared industry nouns ("Wire",
 * "Metal", "Aircraft") are unavoidable across a 246-member universe and do
 * NOT constitute targeting; a consecutive phrase like "zephyr
 * international" or "york precision" does. Single-word identities are
 * checked as whole words.
 */
export function findIdentityLeaks(
  seeds: BlindSeeds,
  forbiddenIdentities: readonly string[],
): IdentityLeak[] {
  const leaks: IdentityLeak[] = [];
  const seedFields = ["geography", "platforms", "capabilities", "sources"] as const;
  const seedWordCache = new Map<string, string[]>();
  const wordsFor = (seedValue: string): string[] => {
    const cached = seedWordCache.get(seedValue);
    if (cached !== undefined) return cached;
    const words = wordsOf(seedValue);
    seedWordCache.set(seedValue, words);
    return words;
  };

  for (const identity of forbiddenIdentities) {
    if (identity.trim().length === 0) continue;
    const isDomain = identity.includes(".");
    const identityWords = wordsOf(identity);
    const phrases: string[][] = [];
    if (!isDomain) {
      if (identityWords.length === 1) {
        phrases.push([identityWords[0]!]);
      } else {
        for (let i = 0; i + 2 <= identityWords.length; i += 1) {
          phrases.push(identityWords.slice(i, i + 2));
        }
      }
    }

    for (const field of seedFields) {
      for (const seedValue of seeds[field]) {
        if (isDomain) {
          if (seedValue.toLowerCase().includes(identity.toLowerCase())) {
            leaks.push({
              seedField: field,
              seedValue,
              leakedToken: identity,
              forbiddenValue: identity,
            });
          }
          continue;
        }
        const seedWords = wordsFor(seedValue);
        const hit = phrases.find((phrase) => containsSequence(seedWords, phrase));
        if (hit !== undefined) {
          leaks.push({
            seedField: field,
            seedValue,
            leakedToken: hit.join(" "),
            forbiddenValue: identity,
          });
        }
      }
    }
  }
  return leaks;
}
