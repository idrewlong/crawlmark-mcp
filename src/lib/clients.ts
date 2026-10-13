/**
 * Pure client logic (no I/O): host normalisation, joining discovered Search
 * Console sites with GA4 properties, merging clients.yaml entries, planning
 * what discovery adds to clients.yaml, and resolving a tool's `client` argument.
 * Discovery I/O lives in src/providers/discovery.ts; the clients.yaml text
 * edits in src/lib/clients-file.ts; assembly and file I/O in src/clients.ts.
 */
import { z } from "zod";

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

// ---------------------------------------------------------------- clients.yaml overrides

const OverrideSchema = z.object({
  domain: z.string().min(1),
  name: z.string().optional(),
  gscProperty: z.string().optional(),
  // YAML users often leave the ID unquoted; accept a number too.
  ga4PropertyId: z.union([z.string(), z.number().int()]).transform(String).optional(),
  locationCode: z.number().int().optional(),
  languageCode: z.string().optional(),
  competitors: z.array(z.string()).optional(),
  trackedKeywords: z.array(z.string()).optional(),
  keyPages: z.array(z.string().url()).optional(),
  monthlyBudgetUsd: z.number().positive().optional(),
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
    return { ...entry, domain: host, slug };
  });
}

// ---------------------------------------------------------------- merged clients

export type ClientSource = "gsc" | "ga4" | "yaml";

export interface ClientDefaults {
  locationCode: number;
  languageCode: string;
  monthlyBudgetUsd: number;
}

export interface Client {
  /** Canonical ID: the normalised domain. Also the key for spend tracking. */
  slug: string;
  domain: string;
  name: string;
  gscProperty?: string;
  ga4PropertyId?: string;
  locationCode: number;
  languageCode: string;
  competitors: string[];
  trackedKeywords: string[];
  keyPages: string[];
  monthlyBudgetUsd: number;
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
      const client: Client = {
        slug: domain,
        domain,
        name: y?.name ?? d?.ga4DisplayName ?? domain,
        locationCode: y?.locationCode ?? defaults.locationCode,
        languageCode: y?.languageCode ?? defaults.languageCode,
        competitors: y?.competitors ?? [],
        trackedKeywords: y?.trackedKeywords ?? [],
        keyPages: y?.keyPages?.length ? y.keyPages : [homepage],
        monthlyBudgetUsd: y?.monthlyBudgetUsd ?? defaults.monthlyBudgetUsd,
        aliases: y && normalizeHost(y.slug) !== domain ? [y.slug] : [],
        sources,
        alternates: { gsc: d?.gscAlternates ?? [], ga4: d?.ga4Alternates ?? [] },
      };
      const gscProperty = y?.gscProperty ?? d?.gscProperty;
      const ga4PropertyId = y?.ga4PropertyId ?? d?.ga4PropertyId;
      if (gscProperty) client.gscProperty = gscProperty;
      if (ga4PropertyId) client.ga4PropertyId = ga4PropertyId;
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

  const ga4Disabled = !ga4.ok && isAdminApiDisabled(ga4.error);
  if (!gsc.ok && !ga4.ok) {
    const gscMsg = errText(gsc.error);
    const ga4Msg = errText(ga4.error);
    if (ga4Disabled) warnings.push(ADMIN_API_DISABLED_WARNING);
    const error =
      gscMsg === ga4Msg || ga4Disabled ? gscMsg : `Search Console: ${gscMsg} GA4: ${ga4Msg}`;
    return {
      clients: mergeClients([], overrides, defaults),
      ignored,
      discovery: { ok: false, error, warnings, notes: [] },
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
    clients: mergeClients(joined.clients, overrides, defaults),
    ignored,
    discovery: {
      ok: true,
      warnings,
      notes: [...joined.notes, ...yamlPropertyNotes(overrides, joined.clients, gsc.ok ? gsc.value : undefined, ga4Ids)],
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
}

export interface SyncPlan {
  add: NewEntry[];
  /** Missing gscProperty / ga4PropertyId to fill on existing entries, by yaml key. */
  fill: { key: string; domain: string; field: "gscProperty" | "ga4PropertyId"; value: string }[];
}

/**
 * What discovery adds to clients.yaml. Never changes a value a user wrote:
 * it only appends domains that have no entry, and fills gscProperty or
 * ga4PropertyId where an existing entry has none. Ignored entries are left
 * alone, and entries for domains no longer discovered are kept.
 */
export function planSync(overrides: ClientOverride[], discovered: DiscoveredClient[]): SyncPlan {
  const byDomain = new Map(overrides.map((o) => [o.domain, o]));
  const plan: SyncPlan = { add: [], fill: [] };
  for (const d of discovered) {
    const o = byDomain.get(d.domain);
    if (!o) {
      const entry: NewEntry = { domain: d.domain };
      if (d.ga4DisplayName) entry.name = d.ga4DisplayName;
      if (d.gscProperty) entry.gscProperty = d.gscProperty;
      if (d.ga4PropertyId) entry.ga4PropertyId = d.ga4PropertyId;
      plan.add.push(entry);
      continue;
    }
    if (o.ignore) continue;
    if (!o.gscProperty && d.gscProperty) plan.fill.push({ key: o.slug, domain: o.domain, field: "gscProperty", value: d.gscProperty });
    if (!o.ga4PropertyId && d.ga4PropertyId) {
      plan.fill.push({ key: o.slug, domain: o.domain, field: "ga4PropertyId", value: d.ga4PropertyId });
    }
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
