/**
 * Domains suggest_competitors never proposes: platforms that rank for nearly
 * everything but aren't a business's competitors (social networks, review and
 * listing sites, marketplaces, encyclopedias, video platforms, big-box
 * retailers, search engines) and public-sector suffixes. Pure: the file and
 * env var are read in src/competitors.ts.
 *
 * This is the one file allowed to name real platforms.
 *
 * Rule syntax (built-in list, config/competitor-denylist.txt, COMPETITOR_DENYLIST):
 *   example.com     that domain and its subdomains
 *   *.gov           any domain ending in .gov (not `gov` itself)
 *   example.*       example.<suffix> for a short suffix of one or two labels
 *                   (.com, .de, .co.uk, .com.au ...), plus subdomains
 *   *.gov.*         both: any domain ending in .gov.<country code> (.gov.uk, .gov.au)
 *   !example.org    never deny this domain (or its subdomains), even if another rule matches
 *   # comment       blank lines and text after # are ignored
 */

export const BUILTIN_DENYLIST: readonly string[] = [
  // Search engines, maps and the big platforms behind them
  "google.*", "bing.com", "yahoo.*", "duckduckgo.com", "baidu.com", "yandex.*", "apple.com", "mapquest.com",
  // Social networks and forums
  "facebook.*", "fb.com", "instagram.*", "twitter.com", "x.com", "linkedin.*", "pinterest.*", "tiktok.com",
  "reddit.com", "quora.com", "tumblr.com", "snapchat.com", "threads.net", "nextdoor.*", "medium.com",
  "whatsapp.com", "telegram.org", "discord.com",
  // Video and audio platforms
  "youtube.*", "youtu.be", "vimeo.com", "dailymotion.com", "twitch.tv", "spotify.com", "soundcloud.com",
  // Review, directory and lead-gen listing sites
  "yelp.*", "tripadvisor.*", "trustpilot.*", "yellowpages.*", "yell.com", "bbb.org", "angi.com", "angieslist.com",
  "homeadvisor.com", "thumbtack.com", "houzz.*", "porch.com", "foursquare.com", "manta.com", "superpages.com",
  "citysearch.com", "chamberofcommerce.com", "expertise.com", "bark.com", "checkatrade.com", "trustatrade.com",
  "birdeye.com", "brownbook.net", "hotfrog.*", "cylex.*", "merchantcircle.com", "local.com", "dexknows.com",
  "glassdoor.*", "indeed.*", "ziprecruiter.com", "healthgrades.com", "zocdoc.com", "vitals.com", "webmd.com",
  "avvo.com", "findlaw.com", "justia.com", "lawyers.com", "martindale.com", "nolo.com",
  "opentable.*", "zomato.com", "doordash.com", "ubereats.com", "grubhub.com", "just-eat.*", "deliveroo.*",
  "seamless.com", "postmates.com", "groupon.*", "g2.com", "capterra.com", "clutch.co", "sitejabber.com",
  "consumeraffairs.com", "upwork.com", "fiverr.com", "taskrabbit.com",
  // Real estate and travel aggregators
  "zillow.com", "realtor.com", "trulia.com", "redfin.com", "apartments.com", "rightmove.co.uk", "zoopla.co.uk",
  "booking.com", "expedia.*", "hotels.com", "airbnb.*", "kayak.*", "vrbo.com", "trivago.*", "agoda.com",
  // Marketplaces and big-box retailers
  "amazon.*", "ebay.*", "etsy.com", "walmart.com", "target.com", "bestbuy.com", "homedepot.com", "lowes.com",
  "costco.com", "ikea.com", "wayfair.com", "alibaba.com", "aliexpress.com", "temu.com", "craigslist.org",
  "gumtree.com", "kijiji.ca", "argos.co.uk", "screwfix.com", "bunnings.com.au",
  // Encyclopedias, dictionaries and Q&A references
  "wikipedia.org", "wikimedia.org", "wikihow.com", "britannica.com", "fandom.com", "dictionary.com",
  "merriam-webster.com", "cambridge.org", "investopedia.com",
  // Site builders' shared hosts (pages there belong to many unrelated owners)
  "sites.google.com", "blogspot.com", "wordpress.com", "github.io",
  // Public sector, education and international bodies
  "*.gov", "*.gov.*", "*.mil", "*.edu", "*.edu.*", "*.ac.uk", "*.ac.*", "*.int", "*.nhs.uk", "*.gc.ca",
];

export interface Denylist {
  deny: RegExp[];
  allow: RegExp[];
}

const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/** One rule to a matcher, or undefined if it isn't a usable rule. */
export function compileRule(rule: string): RegExp | undefined {
  let r = rule.trim().toLowerCase();
  if (!r) return undefined;
  const anyPrefix = r.startsWith("*.");
  if (anyPrefix) r = r.slice(2);
  const anySuffix = r.endsWith(".*");
  if (anySuffix) r = r.slice(0, -2);
  r = r.replace(/^www\./, "");
  if (!r || !/^[a-z0-9.-]+$/.test(r) || r.startsWith(".") || r.endsWith(".")) return undefined;
  const head = anyPrefix ? "^(?:[^.]+\\.)+" : "^(?:[^.]+\\.)*";
  // `*.gov.*`: a country code only, so `x.gov.com` isn't caught.
  // `name.*`: a short public-suffix-like tail: .com, .de, .co.uk, .com.au
  const tail = !anySuffix ? "$" : anyPrefix ? "\\.[a-z]{2}$" : "(?:\\.[a-z]{2,3}){1,2}$";
  return new RegExp(head + escape(r) + tail);
}

/** Split text (file contents, or a comma-separated env value) into rules. */
export function parseRules(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean);
}

/** Build a denylist from rule strings. Unusable rules are returned so callers can warn. */
export function buildDenylist(rules: readonly string[]): { denylist: Denylist; invalid: string[] } {
  const denylist: Denylist = { deny: [], allow: [] };
  const invalid: string[] = [];
  for (const raw of rules) {
    const allow = raw.startsWith("!");
    const re = compileRule(allow ? raw.slice(1) : raw);
    if (!re) invalid.push(raw);
    else (allow ? denylist.allow : denylist.deny).push(re);
  }
  return { denylist, invalid };
}

/** True when a (normalised) domain is denied and not explicitly allowed. */
export function isDenied(domain: string, list: Denylist): boolean {
  return list.deny.some((re) => re.test(domain)) && !list.allow.some((re) => re.test(domain));
}
