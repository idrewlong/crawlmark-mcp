/** Shared name-splitting helpers (pure, no I/O): articles, places, company suffixes and the distinctive part of a name. */

/** Leading words a brand may start with ("the", "el", "la" ...); allowed only at the start of a 2-3 word phrase. */
export const ARTICLES = new Set(["the", "el", "la", "le", "les", "los", "las", "il", "lo", "da", "de", "di", "del", "du", "des"]);

export const LOCATION_WORDS = new Set([
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho",
  "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan", "minnesota",
  "mississippi", "missouri", "montana", "nebraska", "nevada", "hampshire", "jersey", "mexico", "york", "carolina", "dakota", "ohio",
  "oklahoma", "oregon", "pennsylvania", "rhode", "tennessee", "texas", "utah", "vermont", "virginia", "washington", "wisconsin", "wyoming",
  "downtown", "north", "south", "east", "west", "county", "city", "united", "states", "america",
]);


/** Company suffixes that never make a name distinctive ("austinplumbingco"). */
export const COMPANY_SUFFIXES = new Set(["co", "inc", "llc", "company", "corp", "ltd", "group", "services", "service", "pros", "team", "solutions"]);

/**
 * The distinctive part of a squashed name: the name minus its generic segments (trade words, places and
 * company suffixes), found by splitting it to cover as much as possible with generic words. Without a
 * known area, a remaining segment next to a trade word is taken as a probable place ("austin" in
 * "austinplumbing"). Leading articles stay ("lafornina" stays whole). Empty for an exact-match
 * domain made only of generic words.
 */
export function distinctiveRemainder(
  squashed: string,
  kindOf: (piece: string) => "trade" | "place" | null,
  hasArea: boolean,
): string {
  const n = squashed.length;
  type Part = { text: string; kind: "trade" | "place" | "suffix" | "rest" };
  // best[i]: fewest uncovered characters (then fewest parts) to cover squashed[0, i).
  const best: ({ cost: number; parts: Part[] } | undefined)[] = new Array(n + 1);
  best[0] = { cost: 0, parts: [] };
  for (let i = 0; i < n; i++) {
    const cur = best[i];
    if (!cur) continue;
    const offer = (j: number, part: Part, extra: number) => {
      const parts = [...cur.parts];
      const last = parts[parts.length - 1];
      if (part.kind === "rest" && last?.kind === "rest") parts[parts.length - 1] = { text: last.text + part.text, kind: "rest" };
      else parts.push(part);
      const cand = { cost: cur.cost + extra, parts };
      const prior = best[j];
      if (!prior || cand.cost < prior.cost || (cand.cost === prior.cost && cand.parts.length < prior.parts.length)) best[j] = cand;
    };
    offer(i + 1, { text: squashed[i]!, kind: "rest" }, 1);
    for (let j = i + 2; j <= n; j++) {
      const piece = squashed.slice(i, j);
      if (COMPANY_SUFFIXES.has(piece)) offer(j, { text: piece, kind: "suffix" }, 0);
      else if (piece.length >= 3) {
        const kind = kindOf(piece);
        if (kind) offer(j, { text: piece, kind }, 0);
      }
    }
  }
  const parts = best[n]!.parts;
  const kept = parts.filter((p, i) => {
    if (p.kind !== "rest") return false;
    if (hasArea) return true;
    return parts[i - 1]?.kind !== "trade" && parts[i + 1]?.kind !== "trade";
  });
  const rest = kept.map((p) => p.text).join("");
  // A lone article or a fragment is not a name.
  return rest.length >= 3 && !ARTICLES.has(rest) ? rest : "";
}

