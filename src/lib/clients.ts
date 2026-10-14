/**
 * Pure client logic (no I/O): host normalisation, joining discovered Search
 * Console sites with GA4 properties, merging clients.yaml entries, planning
 * what discovery adds to clients.yaml, and resolving a tool's `client` argument.
 * Discovery I/O lives in src/providers/discovery.ts; the clients.yaml text
 * edits in src/lib/clients-file.ts; assembly and file I/O in src/clients.ts.
 */
import { z } from "zod";
import { normalizeBrandTerm, squash } from "./brand.js";
import { gtmNotes, joinGtmContainers, type GtmListing, type GtmMatch } from "./gtm.js";
import { resolveCountry } from "./country.js";
import { PROVIDER_IDS, type ProviderId } from "./provider-ids.js";

// ---------------------------------------------------------------- normalisation

/**
 * Normalise anything that names a site to a bare host: lowercase, no scheme,
 * path, query, port, trailing dot or leading `www.`. `sc-domain:x.com`,
 * `https://www.x.com/blog`, `WWW.X.COM` and `x.com` all give `x.com`.
 * Returns undefined when nothing host-like is left.
 */
export function normalizeHost(input: string): string | undefined {
  let s = input.trim().toLowerCase();
  if (s.startsWith("sc-domain:")) s = s.slice("sc-domain:".length);
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.split(/[/?#]/, 1)[0] ?? "";
  s = s.replace(/^.*@/, ""); // userinfo
  s = s.replace(/:\d*$/, ""); // port
  s = s.replace(/\.+$/, "");
  if (!s || !/^[^\s:@]+$/.test(s)) return undefined;
  // IDNs to punycode, so `bücher.example` and `xn--bcher-kva.example` match.
  try {
    s = new URL(`http://${s}`).hostname.replace(/\.+$/, "");
  } catch {
    return undefined;
  }
  s = s.replace(/^www\./, "");
  return s || undefined;
}

// ---------------------------------------------------------------- discovery input

/** One Search Console site, as `sites.list` returns it. */
export interface GscSite {
  siteUrl: string;
  permissionLevel?: string | null;
}

/** One GA4 property with the default URIs of its web data streams. */
export interface Ga4Property {
  /** Numeric ID, without the `properties/` prefix. */
  propertyId: string;
  displayName: string;
  webStreamUris: string[];
}

/** `searchconsole.sites.list` response body -> sites. */
export function gscSitesFromResponse(data: {
  siteEntry?: { siteUrl?: string | null; permissionLevel?: string | null }[] | null;
}): GscSite[] {
  return (data.siteEntry ?? []).flatMap((e) =>
    e.siteUrl ? [{ siteUrl: e.siteUrl, permissionLevel: e.permissionLevel ?? null }] : [],
  );
}

/** `analyticsadmin.accountSummaries.list` response body -> properties (no streams yet). */
export function ga4PropertiesFromSummaries(data: {
  accountSummaries?: { propertySummaries?: { property?: string | null; displayName?: string | null }[] | null }[] | null;
}): Ga4Ref[] {
  return (data.accountSummaries ?? []).flatMap((a) =>
    (a.propertySummaries ?? []).flatMap((p) => {
      const propertyId = p.property?.replace(/^properties\//, "");
      return propertyId ? [{ propertyId, displayName: p.displayName?.trim() || propertyId }] : [];
    }),
  );
}

/** `analyticsadmin.properties.dataStreams.list` response body -> web stream default URIs. */
export function webStreamUrisFromResponse(data: {
  dataStreams?: { webStreamData?: { defaultUri?: string | null } | null }[] | null;
}): string[] {
  return (data.dataStreams ?? []).flatMap((s) => (s.webStreamData?.defaultUri ? [s.webStreamData.defaultUri] : []));
}

export interface Ga4Ref {
  propertyId: string;
  displayName: string;
}

export interface DiscoveredClient {
  domain: string;
  gscProperty?: string;
  gscAlternates: string[];
  ga4PropertyId?: string;
  ga4DisplayName?: string;
  ga4Alternates: Ga4Ref[];
  /** The chosen GA4 property's web stream URI for this host. */
  homepage?: string;
}

export interface JoinResult {
  clients: DiscoveredClient[];
  /** Things skipped during the join, e.g. a GA4 property with no web stream. */
  notes: string[];
}

/**
 * Rank Search Console properties for one host: the domain property first, then
 * root-path URL-prefix properties before path-scoped ones, then https, then the
 * shortest URL.
 */
function gscRank(siteUrl: string): [number, number, number, number, string] {
  const isDomain = siteUrl.startsWith("sc-domain:");
  let isRoot = 1;
  if (!isDomain) {
    try {
      isRoot = new URL(siteUrl).pathname === "/" ? 0 : 1;
    } catch {
      /* unparseable: rank last among URL-prefix properties */
    }
  }
  const isHttps = siteUrl.startsWith("https://") ? 0 : 1;
  return [isDomain ? 0 : 1, isRoot, isHttps, siteUrl.length, siteUrl];
}

function compareTuples(a: (number | string)[], b: (number | string)[]): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/** Compare numeric GA4 property IDs (as strings) numerically, falling back to string order. */
function compareIds(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Absolute URL for a stream URI; GA4 sometimes stores it without a scheme. */
export function toHomepageUrl(uri: string): string | undefined {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(uri.trim()) ? uri.trim() : `https://${uri.trim()}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}

/**
 * Join Search Console sites and GA4 properties on the normalised host.
 * - Unverified Search Console entries are skipped (they can't be queried).
 * - A host with a `sc-domain:` property and URL-prefix properties uses the domain property.
 * - A host with several GA4 properties uses the lowest property ID; the rest are `ga4Alternates`.
 * - A GA4 property with no web stream is skipped with a note.
 */
export function joinDiscovered(sites: GscSite[], properties: Ga4Property[]): JoinResult {
  const notes: string[] = [];
  const gscByHost = new Map<string, string[]>();
  for (const site of sites) {
    if (site.permissionLevel === "siteUnverifiedUser") {
      notes.push(`Search Console site ${site.siteUrl} is unverified for this account; skipped.`);
      continue;
    }
    const host = normalizeHost(site.siteUrl);
    if (!host) {
      notes.push(`Search Console site ${site.siteUrl} has no usable host; skipped.`);
      continue;
    }
    const list = gscByHost.get(host) ?? [];
    if (!list.includes(site.siteUrl)) list.push(site.siteUrl);
    gscByHost.set(host, list);
  }

  const ga4ByHost = new Map<string, { ref: Ga4Ref; uri: string }[]>();
  for (const p of properties) {
    const label = `GA4 property ${p.propertyId} (${p.displayName})`;
    const hosts = new Map<string, string>();
    for (const uri of p.webStreamUris) {
      const host = normalizeHost(uri);
      const url = toHomepageUrl(uri);
      if (host && url && !hosts.has(host)) hosts.set(host, url);
    }
    if (hosts.size === 0) {
      notes.push(`${label} has no web data stream with a URL; skipped.`);
      continue;
    }
    for (const [host, uri] of hosts) {
      const list = ga4ByHost.get(host) ?? [];
      list.push({ ref: { propertyId: p.propertyId, displayName: p.displayName }, uri });
      ga4ByHost.set(host, list);
    }
  }

  const hosts = [...new Set([...gscByHost.keys(), ...ga4ByHost.keys()])].sort();
  const clients = hosts.map((domain): DiscoveredClient => {
    const gsc = [...(gscByHost.get(domain) ?? [])].sort((a, b) => compareTuples(gscRank(a), gscRank(b)));
    const ga4 = [...(ga4ByHost.get(domain) ?? [])].sort((a, b) => compareIds(a.ref.propertyId, b.ref.propertyId));
    const [chosenGa4, ...otherGa4] = ga4;
    const out: DiscoveredClient = {
      domain,
      gscAlternates: gsc.slice(1),
      ga4Alternates: otherGa4.map((g) => g.ref),
    };
    if (gsc[0]) out.gscProperty = gsc[0];
    if (chosenGa4) {
      out.ga4PropertyId = chosenGa4.ref.propertyId;
      out.ga4DisplayName = chosenGa4.ref.displayName;
      out.homepage = chosenGa4.uri;
    }
    return out;
  });

  return { clients, notes };
}

// ---------------------------------------------------------------- competitors and tracked keywords

/** Who added a competitor or keyword: a person (`manual`) or a confirmed suggestion. */
export const ENTRY_SOURCES = ["manual", "suggested"] as const;
export type EntrySource = (typeof ENTRY_SOURCES)[number];

export interface CompetitorEntry {
  /** Normalised host, e.g. `competitor.example`. */
  domain: string;
  note?: string;
  source?: EntrySource;
  /** ISO date (YYYY-MM-DD) the entry was added. */
  addedAt?: string;
}

export interface KeywordEntry {
  /** Normalised keyword: lowercase, single spaces. */
  keyword: string;
  note?: string;
  source?: EntrySource;
  addedAt?: string;
}

const entryMeta = {
  note: z.string().optional(),
  source: z.enum(ENTRY_SOURCES).optional(),
  addedAt: z.string().optional(),
};

/** A competitor is a plain domain string or `{ domain, note?, source?, addedAt? }`. */
const CompetitorItemSchema = z.union([z.string().min(1), z.object({ domain: z.string().min(1), ...entryMeta })]);
/** A tracked keyword is a plain string or `{ keyword, note?, source?, addedAt? }`. */
const KeywordItemSchema = z.union([z.string().min(1), z.object({ keyword: z.string().min(1), ...entryMeta })]);

/** Who added a brand term: a person, a confirmed suggestion, or automatic inference (Search Console or DataForSEO). */
export const BRAND_TERM_SOURCES = ["manual", "auto-gsc", "auto-dataforseo", "suggested"] as const;
export type BrandTermSource = (typeof BRAND_TERM_SOURCES)[number];

export interface BrandTermEntry {
  /** Normalised term (single spaces; case as written). */
  term: string;
  source?: BrandTermSource;
  addedAt?: string;
}

/** A brand term is a plain string or `{ term, source?, addedAt? }`. */
const BrandTermItemSchema = z.union([
  z.string(),
  z.object({ term: z.string(), source: z.enum(BRAND_TERM_SOURCES).optional(), addedAt: z.string().optional() }),
]);
export type BrandTermItem = z.infer<typeof BrandTermItemSchema>;

/** The text of a brand-term item, whichever form it is written in. */
export const brandTermText = (item: BrandTermItem): string => (typeof item === "string" ? item : item.term);

/** clients.yaml brand-term items -> normalised entries, de-duplicated ignoring case, spacing and punctuation. The first wins; invalid ones are dropped. */
export function toBrandTermEntries(items: BrandTermItem[] | undefined): BrandTermEntry[] {
  const seen = new Set<string>();
  const out: BrandTermEntry[] = [];
  for (const item of items ?? []) {
    const term = normalizeBrandTerm(brandTermText(item));
    if (!term || seen.has(squash(term))) continue;
    seen.add(squash(term));
    const e: BrandTermEntry = { term };
    if (typeof item !== "string") {
      if (item.source) e.source = item.source;
      if (item.addedAt) e.addedAt = item.addedAt;
    }
    out.push(e);
  }
  return out;
}

export type CompetitorItem = z.infer<typeof CompetitorItemSchema>;
export type KeywordItem = z.infer<typeof KeywordItemSchema>;

/** A competitor's bare domain (any URL or `www.` form works), or undefined if it isn't a domain. */
/**
 * A plain host name after normalizeHost (punycode, lowercase): letters, digits, dots and hyphens only, no
 * leading or trailing dot or hyphen, no empty label, and at least one dot. Characters such as `, ; & = *`
 * (which the URL parser lets through) are refused, so a "domain" can't smuggle syntax into provider requests.
 */
export function isPlainDomain(host: string): boolean {
  return /^[a-z0-9.-]+$/.test(host) && host.includes(".") && !/^[.-]|[.-]$/.test(host) && !host.includes("..") && !/(^|\.)-|-(\.|$)/.test(host);
}

export function normalizeCompetitorDomain(input: string): string | undefined {
  const host = normalizeHost(input);
  return host && isPlainDomain(host) ? host : undefined;
}

/** Longest keyword accepted; DataForSEO's keyword endpoints cap well below this. */
export const MAX_KEYWORD_LENGTH = 200;

/**
 * A keyword as a tool input: 1-200 characters with no `;`, CR or LF. Semrush separates the
 * keywords of one request with `;`, so a separator inside a keyword would be billed as extra keywords.
 */
export const keywordInput = z
  .string()
  .min(1, { error: "A keyword can't be empty." })
  .max(MAX_KEYWORD_LENGTH, { error: `A keyword can be at most ${MAX_KEYWORD_LENGTH} characters.` })
  .refine((k) => !/[;\r\n]/.test(k), { error: "A keyword can't contain ';' or a line break; pass each keyword as its own array item." });

/** Lowercase, Unicode NFC, whitespace collapsed. Undefined when empty or too long. */
export function normalizeKeyword(input: string): string | undefined {
  const k = input.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
  return k && k.length <= MAX_KEYWORD_LENGTH ? k : undefined;
}

function withMeta<T extends object>(base: T, item: { note?: string | undefined; source?: EntrySource | undefined; addedAt?: string | undefined }) {
  const out: T & { note?: string; source?: EntrySource; addedAt?: string } = { ...base };
  if (item.note?.trim()) out.note = item.note.trim();
  if (item.source) out.source = item.source;
  if (item.addedAt) out.addedAt = item.addedAt;
  return out;
}

/** clients.yaml competitor items -> normalised entries. The first of any duplicates wins; invalid ones are dropped. */
export function toCompetitorEntries(items: CompetitorItem[] | undefined): CompetitorEntry[] {
  const seen = new Set<string>();
  const out: CompetitorEntry[] = [];
  for (const item of items ?? []) {
    const domain = normalizeCompetitorDomain(typeof item === "string" ? item : item.domain);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    out.push(typeof item === "string" ? { domain } : withMeta({ domain }, item));
  }
  return out;
}

/** clients.yaml keyword items -> normalised entries. The first of any duplicates wins; invalid ones are dropped. */
export function toKeywordEntries(items: KeywordItem[] | undefined): KeywordEntry[] {
  const seen = new Set<string>();
  const out: KeywordEntry[] = [];
  for (const item of items ?? []) {
    const keyword = normalizeKeyword(typeof item === "string" ? item : item.keyword);
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword);
    out.push(typeof item === "string" ? { keyword } : withMeta({ keyword }, item));
  }
  return out;
}

/**
 * A DataForSEO `location_name`, e.g. `Austin,Texas,United States`. Trims each
 * part and drops the spaces after commas that people tend to type. Undefined when empty.
 */
export function normalizeArea(input: string): string | undefined {
  const parts = input.split(",").map((p) => p.replace(/\s+/g, " ").trim());
  if (parts.some((p) => p === "")) return undefined;
  return parts.join(",");
}

// ---------------------------------------------------------------- clients.yaml overrides

/** A Google place ID (e.g. ChIJexamplePlaceId000001): letters, digits, - and _ only. Phase 12 C4. */
export const PLACE_ID_RE = /^[A-Za-z0-9_-]{10,300}$/;

const OverrideSchema = z.object({
  domain: z.string().min(1),
  name: z.string().optional(),
  gscProperty: z.string().optional(),
  // YAML users often leave the ID unquoted; accept a number too.
  ga4PropertyId: z.union([z.string(), z.number().int()]).transform(String).optional(),
  /** Tag Manager account and container (the numeric IDs from the GTM URL). Override for container discovery; see src/lib/gtm.ts. */
  gtmAccountId: z.union([z.string(), z.number().int()]).transform(String).optional(),
  gtmContainerId: z.union([z.string(), z.number().int()]).transform(String).optional(),
  locationCode: z.number().int().optional(),
  languageCode: z.string().optional(),
  competitors: z.array(CompetitorItemSchema).optional(),
  trackedKeywords: z.array(KeywordItemSchema).optional(),
  /** DataForSEO location_name for local searches, e.g. "Austin,Texas,United States". */
  area: z.string().optional(),
  /** What the client does, in a few words, e.g. "emergency plumber". */
  niche: z.string().optional(),
  /** Names people search for the brand: a string or { term, source?, addedAt? }. Add to the built-in domain and name matching; see src/lib/brand.ts. */
  brandTerms: z.array(BrandTermItemSchema).optional(),
  keyPages: z.array(z.string().url()).optional(),
  monthlyBudgetUsd: z.number().positive().optional(),
  /** Phase 9: overrides SEO_DATA_PROVIDER for this client (whose paid keyword, ranking, competitor and backlink data is used). */
  dataProvider: z.enum(PROVIDER_IDS, { error: `must be one of ${PROVIDER_IDS.join(", ")}` }).optional(),
  /** Phase 9: ISO 3166-1 alpha-2 market for Ahrefs/Semrush (stored uppercase); else derived from a country-level locationCode. */
  country: z
    .string()
    .regex(/^\s*[A-Za-z]{2}\s*$/, { error: "must be a two-letter ISO country code, e.g. US or GB" })
    .transform((c) => c.trim().toUpperCase())
    .optional(),
  /** Phase 9: per-client monthly unit caps; else DEFAULT_CLIENT_MONTHLY_AHREFS_UNITS / _SEMRUSH_UNITS. */
  monthlyUnits: z
    .object({ ahrefs: z.number().int().positive().optional(), semrush: z.number().int().positive().optional() })
    .strict()
    .optional(),
  /** Phase 12 C3: the Bing Webmaster Tools site URL to read (e.g. https://www.example.com/); unset matches the domain against the key's verified sites. */
  bingSite: z
    .string()
    .max(500)
    .refine((v) => /^https?:\/\/[^\s/]+/i.test(v.trim()), { error: "must be an http(s) site URL, e.g. https://www.example.com/" })
    .optional(),
  /** Phase 12 C4: the client's confirmed Google Business Profile place ID (local_profile finds it; saved only after the user confirms). */
  gbpPlaceId: z.string().regex(PLACE_ID_RE, { error: "must be a Google place ID (letters, digits, - and _), e.g. ChIJexamplePlaceId000001" }).optional(),
  /** Hide this domain: it isn't a client, and discovery never re-adds it. */
  ignore: z.boolean().optional(),
});

export type ClientOverride = z.infer<typeof OverrideSchema> & { slug: string };

const OverridesFileSchema = z
  .object({ clients: z.record(z.string(), OverrideSchema).nullish() })
  .nullish();

/**
 * Validate parsed clients.yaml content. An empty file or empty `clients:` is
 * fine. Throws one readable error naming the bad entries.
 */
export function parseOverrides(raw: unknown, source = "clients.yaml"): ClientOverride[] {
  const parsed = OverridesFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid ${source}: ${issues}`);
  }
  const entries = Object.entries(parsed.data?.clients ?? {});
  const seen = new Map<string, string>();
  return entries.map(([slug, entry]) => {
    const host = normalizeHost(entry.domain);
    if (!host) throw new Error(`Invalid ${source}: clients.${slug}.domain "${entry.domain}" is not a domain.`);
    const prior = seen.get(host);
    if (prior) throw new Error(`Invalid ${source}: clients.${prior} and clients.${slug} both use domain ${host}.`);
    seen.set(host, slug);
    entry.competitors?.forEach((c, i) => {
      const value = typeof c === "string" ? c : c.domain;
      if (!normalizeCompetitorDomain(value)) {
        throw new Error(`Invalid ${source}: clients.${slug}.competitors[${i}] "${value}" is not a domain.`);
      }
    });
    entry.trackedKeywords?.forEach((k, i) => {
      const value = typeof k === "string" ? k : k.keyword;
      if (!normalizeKeyword(value)) {
        throw new Error(`Invalid ${source}: clients.${slug}.trackedKeywords[${i}] is empty or longer than ${MAX_KEYWORD_LENGTH} characters.`);
      }
    });
    entry.brandTerms?.forEach((t, i) => {
      if (!normalizeBrandTerm(brandTermText(t))) throw new Error(`Invalid ${source}: clients.${slug}.brandTerms[${i}] must contain a letter or digit and be at most 100 characters.`);
    });
    return { ...entry, domain: host, slug };
  });
}

// ---------------------------------------------------------------- merged clients

export type ClientSource = "gsc" | "ga4" | "yaml";

export interface ClientDefaults {
  locationCode: number;
  languageCode: string;
  monthlyBudgetUsd: number;
  /** Per-client unit caps for clients that don't set monthlyUnits (default: DEFAULT_MONTHLY_UNITS). */
  monthlyUnits?: { ahrefs: number; semrush: number };
}

/** DEFAULT_CLIENT_MONTHLY_AHREFS_UNITS / _SEMRUSH_UNITS defaults (D1). */
export const DEFAULT_MONTHLY_UNITS = { ahrefs: 10_000, semrush: 5_000 } as const;

export interface Client {
  /** Canonical ID: the normalised domain. Also the key for spend tracking. */
  slug: string;
  domain: string;
  name: string;
  gscProperty?: string;
  ga4PropertyId?: string;
  /** Tag Manager container for gtm_audit: from clients.yaml, else discovery. The account may be missing when only gtmContainerId is pinned. */
  gtmAccountId?: string;
  gtmContainerId?: string;
  locationCode: number;
  languageCode: string;
  /** Competitor domains (normalised, de-duplicated). Details in competitorEntries. */
  competitors: string[];
  competitorEntries: CompetitorEntry[];
  /** Tracked keywords (normalised, de-duplicated). Details in keywordEntries. */
  trackedKeywords: string[];
  keywordEntries: KeywordEntry[];
  /** DataForSEO location_name for local searches; when unset, locationCode is used. */
  area?: string;
  niche?: string;
  /** Explicit brand terms (normalised, de-duplicated). They add to the domain and name matching in isBranded. */
  brandTerms: string[];
  /** Brand terms with their source and date. */
  brandTermEntries: BrandTermEntry[];
  /** The GA4 property's display name, when it differs from `name`. */
  ga4Name?: string;
  keyPages: string[];
  monthlyBudgetUsd: number;
  /** Phase 9: the client's own SEO data provider (clients.yaml dataProvider); unset means SEO_DATA_PROVIDER. */
  dataProvider?: ProviderId;
  /** Phase 9: ISO alpha-2 market for Ahrefs/Semrush (clients.yaml country, else from a country-level locationCode); null when neither gives one. */
  country: string | null;
  /** Phase 9: monthly unit caps for this client. */
  monthlyUnits: { ahrefs: number; semrush: number };
  /** Phase 12 C3: clients.yaml bingSite (the Bing Webmaster Tools site to read); unset means match by domain. */
  bingSite?: string;
  /** Phase 12 C4: clients.yaml gbpPlaceId, the confirmed Google Business Profile; unset means none confirmed yet. */
  gbpPlaceId?: string;
  /** clients.yaml slugs that also resolve to this client. */
  aliases: string[];
  sources: ClientSource[];
  alternates: { gsc: string[]; ga4: Ga4Ref[] };
}

/** Merge discovered clients and clients.yaml overrides. yaml wins field by field; arrays replace. */
export function mergeClients(
  discovered: DiscoveredClient[],
  overrides: ClientOverride[],
  defaults: ClientDefaults,
  gtm: ReadonlyMap<string, GtmMatch> = new Map(),
): Client[] {
  const byDomain = new Map<string, { d?: DiscoveredClient; y?: ClientOverride }>();
  for (const d of discovered) byDomain.set(d.domain, { d });
  for (const y of overrides) byDomain.set(y.domain, { ...byDomain.get(y.domain), y });
  assertAliasesUnambiguous(overrides, new Set(byDomain.keys()));
  for (const y of overrides) if (y.ignore) byDomain.delete(y.domain);

  return [...byDomain.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([domain, { d, y }]): Client => {
      const sources: ClientSource[] = [];
      if (d?.gscProperty) sources.push("gsc");
      if (d?.ga4PropertyId) sources.push("ga4");
      if (y) sources.push("yaml");
      const homepage = d?.homepage ?? `https://${domain}/`;
      const competitorEntries = toCompetitorEntries(y?.competitors);
      const keywordEntries = toKeywordEntries(y?.trackedKeywords);
      const brandTermEntries = toBrandTermEntries(y?.brandTerms);
      const client: Client = {
        slug: domain,
        domain,
        name: y?.name ?? d?.ga4DisplayName ?? domain,
        locationCode: y?.locationCode ?? defaults.locationCode,
        languageCode: y?.languageCode ?? defaults.languageCode,
        competitors: competitorEntries.map((c) => c.domain),
        competitorEntries,
        trackedKeywords: keywordEntries.map((k) => k.keyword),
        keywordEntries,
        brandTerms: brandTermEntries.map((b) => b.term),
        brandTermEntries,
        keyPages: y?.keyPages?.length ? y.keyPages : [homepage],
        monthlyBudgetUsd: y?.monthlyBudgetUsd ?? defaults.monthlyBudgetUsd,
        country: resolveCountry(y?.country, y?.locationCode ?? defaults.locationCode),
        monthlyUnits: {
          ahrefs: y?.monthlyUnits?.ahrefs ?? defaults.monthlyUnits?.ahrefs ?? DEFAULT_MONTHLY_UNITS.ahrefs,
          semrush: y?.monthlyUnits?.semrush ?? defaults.monthlyUnits?.semrush ?? DEFAULT_MONTHLY_UNITS.semrush,
        },
        aliases: y && normalizeHost(y.slug) !== domain ? [y.slug] : [],
        sources,
        alternates: { gsc: d?.gscAlternates ?? [], ga4: d?.ga4Alternates ?? [] },
      };
      const gscProperty = y?.gscProperty ?? d?.gscProperty;
      const ga4PropertyId = y?.ga4PropertyId ?? d?.ga4PropertyId;
      if (gscProperty) client.gscProperty = gscProperty;
      if (ga4PropertyId) client.ga4PropertyId = ga4PropertyId;
      // A pinned container wins; discovery only supplies a pair when yaml has neither id.
      const found = y?.gtmContainerId || y?.gtmAccountId ? undefined : gtm.get(domain);
      const gtmAccountId = y?.gtmAccountId ?? found?.gtmAccountId;
      const gtmContainerId = y?.gtmContainerId ?? found?.gtmContainerId;
      if (gtmAccountId) client.gtmAccountId = gtmAccountId;
      if (gtmContainerId) client.gtmContainerId = gtmContainerId;
      const area = y?.area && normalizeArea(y.area);
      if (area) client.area = area;
      if (y?.niche?.trim()) client.niche = y.niche.trim();
      if (y?.dataProvider) client.dataProvider = y.dataProvider;
      if (y?.bingSite?.trim()) client.bingSite = y.bingSite.trim();
      if (y?.gbpPlaceId) client.gbpPlaceId = y.gbpPlaceId;
      if (d?.ga4DisplayName && d.ga4DisplayName !== client.name) client.ga4Name = d.ga4DisplayName;
      return client;
    });
}

/**
 * A clients.yaml key is an alias for its own entry. It must not name another
 * client's domain (it would hide that client from lookups by domain) or repeat
 * another key with different case.
 */
function assertAliasesUnambiguous(overrides: ClientOverride[], domains: Set<string>): void {
  const seen = new Map<string, string>();
  for (const y of overrides) {
    const lower = y.slug.trim().toLowerCase();
    const prior = seen.get(lower);
    if (prior !== undefined) {
      throw new Error(`Invalid clients.yaml: clients.${prior} and clients.${y.slug} differ only in case.`);
    }
    seen.set(lower, y.slug);
    const host = normalizeHost(y.slug);
    if (host && host !== y.domain && domains.has(host)) {
      throw new Error(
        `Invalid clients.yaml: the key clients.${y.slug} (domain ${y.domain}) names a different client's domain, ${host}. Rename the key.`,
      );
    }
  }
}

/** Which Google properties a client lacks. */
export function missingPieces(c: Client): ("gscProperty" | "ga4PropertyId")[] {
  const out: ("gscProperty" | "ga4PropertyId")[] = [];
  if (!c.gscProperty) out.push("gscProperty");
  if (!c.ga4PropertyId) out.push("ga4PropertyId");
  return out;
}

// ---------------------------------------------------------------- resolution

/**
 * Find a client by a clients.yaml slug (case-insensitive) or anything that
 * normalises to its domain: `example.com`, `www.example.com`,
 * `https://www.example.com/page`, `sc-domain:example.com`.
 */
export function findClient(clients: Client[], idOrDomain: string): Client | undefined {
  const key = idOrDomain.trim().toLowerCase();
  const byAlias = clients.find((c) => c.aliases.some((a) => a.toLowerCase() === key));
  if (byAlias) return byAlias;
  const host = normalizeHost(idOrDomain);
  return host ? clients.find((c) => c.domain === host) : undefined;
}

export function unknownClientMessage(idOrDomain: string, clients: Client[], discoveryError?: string): string {
  const known = clients.map((c) => c.domain).join(", ") || "(none)";
  const why = discoveryError ? ` Client discovery failed (${discoveryError}), so only clients.yaml entries are available.` : "";
  return `Unknown client "${idOrDomain}". Known clients: ${known}.${why} Call list_clients to see them.`;
}

// ---------------------------------------------------------------- Admin API errors

/** True when a GA4 Admin API call failed because the API isn't enabled in the Cloud project. */
export function isAdminApiDisabled(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /Analytics Admin API has not been used in project/i.test(msg) ||
    (/analyticsadmin\.googleapis\.com/i.test(msg) && /disabled|SERVICE_DISABLED/i.test(msg))
  );
}

export const ADMIN_API_DISABLED_WARNING =
  'GA4 properties could not be listed because the "Google Analytics Admin API" is not enabled in your Google Cloud project. ' +
  "Enable it under APIs & Services > Library, wait a minute, then call list_clients with refresh: true. " +
  "Until then only Search Console clients (and clients.yaml entries) are listed.";

// ---------------------------------------------------------------- assembly

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

export interface DiscoveryOutcome {
  gsc: Settled<GscSite[]>;
  ga4: Settled<{ properties: Ga4Property[]; errors: string[] }>;
  /** Tag Manager containers. Best-effort: a failure here only adds a discovery note. */
  gtm?: Settled<GtmListing>;
}

/** Containers matched to client domains, plus discovery notes (failures, unmatched containers). */
export function gtmFromOutcome(gtm: Settled<GtmListing> | undefined, overrides: ClientOverride[] = []): { matches: Map<string, GtmMatch>; notes: string[] } {
  if (!gtm) return { matches: new Map(), notes: [] };
  if (!gtm.ok) return { matches: new Map(), notes: [`Tag Manager containers could not be listed (gtm_audit may still work with gtmAccountId and gtmContainerId in clients.yaml): ${errText(gtm.error)}`] };
  const { matches, unmatched } = joinGtmContainers(gtm.value.containers, normalizeHost);
  // A pin is a container set in clients.yaml. Discovery writes a name match there itself, so the
  // matched-by-name note keeps showing until the user pins a different container.
  const pinned = overrides.filter((o) => {
    if (!o.gtmContainerId && !o.gtmAccountId) return false;
    const m = matches.get(o.domain);
    return !(m?.matchedBy === "name" && o.gtmContainerId === m.gtmContainerId);
  });
  return { matches, notes: gtmNotes(gtm.value, matches, unmatched, new Set(pinned.map((o) => o.domain))) };
}

/** Discovery didn't run because no Google auth is configured. Not an error. */
export interface DiscoverySkipped {
  skipped: string;
}

export interface DiscoveryStatus {
  /** False when discovery was skipped or neither Search Console nor GA4 could be listed. */
  ok: boolean;
  /** True when Google isn't set up, so discovery didn't run (clients come from clients.yaml only). */
  skipped?: boolean;
  /** One informational line, e.g. why discovery was skipped. */
  info?: string;
  /** Why discovery failed entirely (configured, but both sources failed). */
  error?: string;
  /** Partial failures worth acting on, e.g. the Admin API being disabled. */
  warnings: string[];
  /** Things worth knowing: skipped properties, pinned or no-longer-visible clients.yaml properties. */
  notes: string[];
}

export interface ClientRegistry {
  clients: Client[];
  /** Domains hidden with `ignore: true` in clients.yaml. */
  ignored: string[];
  discovery: DiscoveryStatus;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Notes for clients.yaml properties that discovery disagrees with: a pinned
 * value that differs from the discovered one (yaml wins), or a property this
 * Google account can no longer see. Only checked for sources that listed cleanly.
 */
function yamlPropertyNotes(
  overrides: ClientOverride[],
  joined: DiscoveredClient[],
  gscSites: GscSite[] | undefined,
  ga4Ids: Set<string> | undefined,
): string[] {
  const notes: string[] = [];
  const byDomain = new Map(joined.map((d) => [d.domain, d]));
  const siteUrls = gscSites && new Set(gscSites.filter((s) => s.permissionLevel !== "siteUnverifiedUser").map((s) => s.siteUrl));
  for (const o of overrides) {
    if (o.ignore) continue;
    const d = byDomain.get(o.domain);
    if (o.gscProperty && siteUrls) {
      if (!siteUrls.has(o.gscProperty)) {
        notes.push(`${o.domain}: clients.yaml has gscProperty ${o.gscProperty}, but this Google account can't see it in Search Console.`);
      } else if (d?.gscProperty && d.gscProperty !== o.gscProperty) {
        notes.push(`${o.domain}: clients.yaml pins gscProperty ${o.gscProperty}; discovery would pick ${d.gscProperty}.`);
      }
    }
    if (o.ga4PropertyId && ga4Ids) {
      if (!ga4Ids.has(o.ga4PropertyId)) {
        notes.push(`${o.domain}: clients.yaml has ga4PropertyId ${o.ga4PropertyId}, but this Google account can't see it in GA4.`);
      } else if (d?.ga4PropertyId && d.ga4PropertyId !== o.ga4PropertyId) {
        notes.push(`${o.domain}: clients.yaml pins ga4PropertyId ${o.ga4PropertyId}; discovery would pick ${d.ga4PropertyId}.`);
      }
    }
  }
  return notes;
}

/**
 * Turn discovery results (each source may have failed, or discovery may have
 * been skipped) plus clients.yaml into the client list. Failing sources become
 * warnings; if both fail, the yaml entries stand alone and `discovery.error`
 * says why.
 */
export function assembleRegistry(
  outcome: DiscoveryOutcome | DiscoverySkipped,
  overrides: ClientOverride[],
  defaults: ClientDefaults,
): ClientRegistry {
  const ignored = overrides.filter((o) => o.ignore).map((o) => o.domain);
  if ("skipped" in outcome) {
    return {
      clients: mergeClients([], overrides, defaults),
      ignored,
      discovery: { ok: false, skipped: true, info: outcome.skipped, warnings: [], notes: [] },
    };
  }

  const warnings: string[] = [];
  const { gsc, ga4 } = outcome;
  const gtm = gtmFromOutcome(outcome.gtm, overrides);

  const ga4Disabled = !ga4.ok && isAdminApiDisabled(ga4.error);
  if (!gsc.ok && !ga4.ok) {
    const gscMsg = errText(gsc.error);
    const ga4Msg = errText(ga4.error);
    if (ga4Disabled) warnings.push(ADMIN_API_DISABLED_WARNING);
    const error =
      gscMsg === ga4Msg || ga4Disabled ? gscMsg : `Search Console: ${gscMsg} GA4: ${ga4Msg}`;
    return {
      clients: mergeClients([], overrides, defaults, gtm.matches),
      ignored,
      discovery: { ok: false, error, warnings, notes: gtm.notes },
    };
  }

  if (!gsc.ok) warnings.push(`Search Console sites could not be listed, so only GA4 clients were discovered: ${errText(gsc.error)}`);
  if (!ga4.ok) {
    warnings.push(ga4Disabled ? ADMIN_API_DISABLED_WARNING : `GA4 properties could not be listed, so only Search Console clients were discovered: ${errText(ga4.error)}`);
  } else {
    warnings.push(...ga4.value.errors);
  }

  const joined = joinDiscovered(gsc.ok ? gsc.value : [], ga4.ok ? ga4.value.properties : []);
  // A property whose stream lookup failed is missing from the list, so only trust the GA4 list when it's complete.
  const ga4Ids = ga4.ok && ga4.value.errors.length === 0 ? new Set(ga4.value.properties.map((p) => p.propertyId)) : undefined;
  return {
    clients: mergeClients(joined.clients, overrides, defaults, gtm.matches),
    ignored,
    discovery: {
      ok: true,
      warnings,
      notes: [...joined.notes, ...yamlPropertyNotes(overrides, joined.clients, gsc.ok ? gsc.value : undefined, ga4Ids), ...gtm.notes],
    },
  };
}

// ---------------------------------------------------------------- persistence plan

/** A new clients.yaml entry, keyed by its domain. */
export interface NewEntry {
  domain: string;
  name?: string;
  gscProperty?: string;
  ga4PropertyId?: string;
  gtmAccountId?: string;
  gtmContainerId?: string;
}

export interface SyncPlan {
  add: NewEntry[];
  /** Missing gscProperty / ga4PropertyId / gtm ids to fill on existing entries, by yaml key. */
  fill: { key: string; domain: string; field: "gscProperty" | "ga4PropertyId" | "gtmAccountId" | "gtmContainerId"; value: string }[];
}

/**
 * What discovery adds to clients.yaml. Never changes a value a user wrote:
 * it only appends domains that have no entry, and fills gscProperty or
 * ga4PropertyId where an existing entry has none. Ignored entries are left
 * alone, and entries for domains no longer discovered are kept.
 */
export function planSync(
  overrides: ClientOverride[],
  discovered: DiscoveredClient[],
  gtm: ReadonlyMap<string, GtmMatch> = new Map(),
): SyncPlan {
  const byDomain = new Map(overrides.map((o) => [o.domain, o]));
  const plan: SyncPlan = { add: [], fill: [] };
  for (const d of discovered) {
    const o = byDomain.get(d.domain);
    if (!o) {
      const entry: NewEntry = { domain: d.domain };
      if (d.ga4DisplayName) entry.name = d.ga4DisplayName;
      if (d.gscProperty) entry.gscProperty = d.gscProperty;
      if (d.ga4PropertyId) entry.ga4PropertyId = d.ga4PropertyId;
      const g = gtm.get(d.domain);
      if (g) {
        entry.gtmAccountId = g.gtmAccountId;
        entry.gtmContainerId = g.gtmContainerId;
      }
      plan.add.push(entry);
      continue;
    }
    if (o.ignore) continue;
    if (!o.gscProperty && d.gscProperty) plan.fill.push({ key: o.slug, domain: o.domain, field: "gscProperty", value: d.gscProperty });
    if (!o.ga4PropertyId && d.ga4PropertyId) {
      plan.fill.push({ key: o.slug, domain: o.domain, field: "ga4PropertyId", value: d.ga4PropertyId });
    }
  }
  // Tag Manager containers fill any existing entry (discovered or hand-added), and only as a pair:
  // an entry that already pins either id is left alone.
  for (const o of overrides) {
    const g = gtm.get(o.domain);
    if (!g || o.ignore || o.gtmAccountId || o.gtmContainerId) continue;
    plan.fill.push({ key: o.slug, domain: o.domain, field: "gtmAccountId", value: g.gtmAccountId });
    plan.fill.push({ key: o.slug, domain: o.domain, field: "gtmContainerId", value: g.gtmContainerId });
  }
  return plan;
}

// ---------------------------------------------------------------- CLI

/** Plain-text table with padded columns, for the CLI. */
export function formatTable(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}
