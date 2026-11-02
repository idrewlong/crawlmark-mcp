/**
 * Pure helpers for Tag Manager discovery and errors (Phase 6b): API payloads ->
 * container refs, the domain join  and
 * the error messages. The I/O lives in src/providers/gtm.ts.
 */
import { gtmScopeMessage } from "./google-auth.js";
import { stripControl } from "./terminal-text.js";

export interface GtmContainerRef {
  accountId: string;
  containerId: string;
  /** The `GTM-XXXXXX` snippet ID. */
  publicId: string;
  name: string;
  /** Domains listed on the container (web containers only). */
  domainName: string[];
}

export interface GtmListing {
  containers: GtmContainerRef[];
  /** Per-account container lookups that failed (the rest are still listed). */
  errors: string[];
}

/** What a client gets from discovery. */
export interface GtmMatch {
  gtmAccountId: string;
  gtmContainerId: string;
  publicId: string;
  name: string;
  /** How the container was matched: a domain on its domain list, or its name (when it lists no domains). */
  matchedBy: "domain" | "name";
  /** Other containers listing the same host (not used). */
  alternates: { gtmAccountId: string; gtmContainerId: string; publicId: string }[];
}

interface ApiContainer {
  accountId?: string | null;
  containerId?: string | null;
  publicId?: string | null;
  name?: string | null;
  domainName?: string[] | null;
  usageContext?: string[] | null;
}

/** `accounts.containers.list` response body -> web container refs. Server, mobile and AMP containers are skipped. */
export function containersFromResponse(data: { container?: ApiContainer[] | null }): GtmContainerRef[] {
  return (data.container ?? []).flatMap((c) => {
    if (!c.accountId || !c.containerId) return [];
    const ctx = c.usageContext ?? [];
    if (ctx.length > 0 && !ctx.includes("web")) return [];
    return [
      {
        accountId: c.accountId,
        containerId: c.containerId,
        publicId: c.publicId ?? "",
        name: c.name?.trim() || c.publicId || c.containerId,
        domainName: c.domainName ?? [],
      },
    ];
  });
}

const byIds = (a: GtmContainerRef, b: GtmContainerRef) =>
  a.publicId < b.publicId ? -1 : a.publicId > b.publicId ? 1 : Number(a.containerId) - Number(b.containerId);

/** A container name that is itself a host (`www.example.com/`): the normalised host, else undefined. Names with spaces never qualify. */
function hostFromName(name: string, normalizeHost: (input: string) => string | undefined): string | undefined {
  const trimmed = name.trim();
  if (!trimmed || /\s/.test(trimmed)) return undefined;
  const host = normalizeHost(trimmed);
  return host && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : undefined;
}

function toMatch(list: GtmContainerRef[], matchedBy: GtmMatch["matchedBy"]): GtmMatch {
  const [first, ...rest] = list;
  return {
    gtmAccountId: first!.accountId,
    gtmContainerId: first!.containerId,
    publicId: first!.publicId,
    name: first!.name,
    matchedBy,
    alternates: rest.map((c) => ({ gtmAccountId: c.accountId, gtmContainerId: c.containerId, publicId: c.publicId })),
  };
}

/**
 * Match containers to client domains. Each listed domain goes through
 * normalizeHost, the Phase 0c host normaliser passed in by the caller
 * (`https://www.x.com/` and `x.com` both give `x.com`). When several containers
 * list one host they are all candidates, ordered by `GTM-` ID (first is `primary`, the rest `alternates`);
 * gtm_audit picks among them by what the live homepage loads. Nothing here chooses by ID.
 *
 * Then a container with no domain list is matched by its name when the name is
 * a host (`www.example.com/` gives `example.com`), unless some container's
 * domain list already claims that host. Name candidates for a host follow the
 * same ordering. Everything else is returned unmatched.
 */
export function joinGtmContainers(
  containers: GtmContainerRef[],
  normalizeHost: (input: string) => string | undefined,
): { matches: Map<string, GtmMatch>; unmatched: GtmContainerRef[] } {
  const byHost = new Map<string, GtmContainerRef[]>();
  const noDomains: GtmContainerRef[] = [];
  for (const c of [...containers].sort(byIds)) {
    const hosts = new Set(c.domainName.flatMap((d) => normalizeHost(d) ?? []));
    if (hosts.size === 0) {
      noDomains.push(c);
      continue;
    }
    for (const h of hosts) byHost.set(h, [...(byHost.get(h) ?? []), c]);
  }
  const byName = new Map<string, GtmContainerRef[]>();
  const unmatched: GtmContainerRef[] = [];
  for (const c of noDomains) {
    const host = hostFromName(c.name, normalizeHost);
    if (host === undefined || byHost.has(host)) unmatched.push(c);
    else byName.set(host, [...(byName.get(host) ?? []), c]);
  }
  const matches = new Map<string, GtmMatch>();
  for (const [host, list] of byHost) matches.set(host, toMatch(list, "domain"));
  for (const [host, list] of byName) matches.set(host, toMatch(list, "name"));
  return { matches, unmatched };
}

const MAX_LISTED = 10;

/** Discovery notes for the Tag Manager listing: containers that can't be matched, and alternates. */
export function gtmNotes(
  listing: GtmListing,
  matches: Map<string, GtmMatch>,
  unmatched: GtmContainerRef[],
  /** Hosts whose client already pins a container in clients.yaml: no ambiguity note needed. */
  pinned: ReadonlySet<string> = new Set(),
): string[] {
  const notes: string[] = [];
  if (unmatched.length) {
    const shown = unmatched.slice(0, MAX_LISTED).map((c) => `${c.publicId || c.containerId} "${stripControl(c.name)}" (account ${c.accountId}, container ${c.containerId})`);
    const more = unmatched.length > shown.length ? ` and ${unmatched.length - shown.length} more` : "";
    notes.push(
      `Tag Manager: ${unmatched.length} web container(s) list no domain, so they can't be matched to a client: ${shown.join(", ")}${more}. ` +
        "Set gtmAccountId and gtmContainerId on the client in clients.yaml to use one.",
    );
  }
  const names = new Map(listing.containers.map((c) => [`${c.accountId}/${c.containerId}`, c.name]));
  for (const [host, m] of matches) {
    if (m.matchedBy === "name" && !pinned.has(host)) {
      // Container names come from Tag Manager and are shown in a terminal: no control characters.
      const name = stripControl(names.get(`${m.gtmAccountId}/${m.gtmContainerId}`) ?? m.name);
      notes.push(
        `Tag Manager: matched ${m.publicId || m.gtmContainerId} "${name}" to ${host} by its name (the container lists no domains). ` +
          "If that's wrong, pin another with gtmContainerId in clients.yaml.",
      );
    }
    if (m.alternates.length && !pinned.has(host)) {
      const ids = [m, ...m.alternates].map((c) => c.publicId || c.gtmContainerId);
      notes.push(
        `Tag Manager: ${host} is ${m.matchedBy === "name" ? "the name of" : "listed by"} ${ids.length} containers (${ids.join(", ")}); ` +
          "gtm_audit picks the one the live homepage loads. Pin one with set_client_profile gtmContainerId.",
      );
    }
  }
  notes.push(...listing.errors);
  return notes;
}

const GTM_ID = "(GTM-[A-Z0-9]{4,12})";
/**
 * Only IDs in a loader context count: the gtm.js / ns.html URL (`?id=GTM-X`, with other params before or after, and
 * `&amp;` encoded) or the snippet's `(window,document,'script','<layer>','GTM-X')` call. A GTM-XXXX in body text, a
 * comment or an unrelated widget is not a container the page loads, and must not steer which container is audited.
 */
const GTM_LOADER_RE = new RegExp(
  `googletagmanager\\.com/(?:gtm\\.js|ns\\.html)\\?[^"'\\s<>]*?\\bid=${GTM_ID}\\b` +
    `|['"]script['"]\\s*,\\s*['"][\\w$.-]+['"]\\s*,\\s*['"]${GTM_ID}['"]` +
    `|['"]dataLayer['"]\\s*,\\s*['"]${GTM_ID}['"]`,
  "gi",
);

/**
 * `GTM-XXXX` container IDs the page loads (the loader snippet, the noscript iframe, a gtm.js URL), uppercased,
 * de-duplicated, in page order, at most 10. Containers injected only by JavaScript at runtime aren't seen: pin those.
 */
export function extractGtmIds(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(GTM_LOADER_RE)) {
    const id = (m[1] ?? m[2] ?? m[3])?.toUpperCase();
    if (id && !out.includes(id)) out.push(id);
    if (out.length === 10) break;
  }
  return out;
}

// ---------------------------------------------------------------- errors

/** A Tag Manager call that kept hitting the rate limit until its retry budget ran out. The message is final. */
export class GtmRateLimitError extends Error {
  override name = "GtmRateLimitError";
}

export const TAG_MANAGER_API_DISABLED = "Enable the \"Tag Manager API\" in the Google Cloud project (APIs & Services > Library), then retry. If you just enabled it, call list_clients with refresh: true.";

/** The bits of a googleapis (gaxios) error that classification needs. */
export interface ApiErrorInfo {
  status?: number;
  message: string;
  reasons: string[];
}

export function apiErrorInfo(err: unknown): ApiErrorInfo {
  const e = err as {
    code?: number | string;
    status?: number;
    message?: string;
    response?: { status?: number; data?: { error?: { errors?: { reason?: string }[]; status?: string; message?: string } } };
  };
  const status = e?.response?.status ?? (typeof e?.code === "number" ? e.code : undefined) ?? e?.status;
  const data = e?.response?.data?.error;
  const reasons = [...(data?.errors?.map((x) => x.reason ?? "") ?? []), data?.status ?? ""].filter(Boolean);
  return { ...(status !== undefined ? { status } : {}), message: data?.message ?? e?.message ?? String(err), reasons };
}

export type GtmErrorKind = "rate-limit" | "api-disabled" | "scope" | "denied" | "not-found" | "other";

export function classifyGtmError(info: ApiErrorInfo): GtmErrorKind {
  const text = `${info.message} ${info.reasons.join(" ")}`;
  if (/has not been used in project|accessNotConfigured|SERVICE_DISABLED|API .* is disabled/i.test(text)) return "api-disabled";
  if (/insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(text)) return "scope";
  if (/rateLimitExceeded|userRateLimitExceeded|quotaExceeded|rate limit exceeded|quota exceeded/i.test(text) || info.status === 429) return "rate-limit";
  if (info.status === 403 || info.status === 401) return "denied";
  if (info.status === 404) return "not-found";
  return "other";
}

/** Who to add in GTM Admin > User Management. */
export interface GtmIdentity {
  mode: "oauth" | "service_account" | "none";
  email?: string | undefined;
}

export function accessDeniedMessage(containerPath: string, who: GtmIdentity): string {
  const account =
    who.mode === "service_account"
      ? `the service account${who.email ? ` ${who.email}` : ""}`
      : who.mode === "oauth"
        ? `the signed-in Google account${who.email ? ` ${who.email}` : ""}`
        : "the Google account crawlmark uses";
  return (
    `Tag Manager denied access to ${containerPath}. In Tag Manager, open Admin > User Management for that container (or its account), ` +
    `add ${account} with Read access (or higher), then retry. Access can take a minute to apply; ` +
    "call list_clients with refresh: true to re-run container discovery."
  );
}

/** Turn a Tag Manager API failure into the error a tool should show. */
export function gtmApiError(err: unknown, containerPath: string, who: GtmIdentity): Error {
  if (err instanceof GtmRateLimitError) return err;
  const info = apiErrorInfo(err);
  switch (classifyGtmError(info)) {
    case "api-disabled":
      return new Error(`The Tag Manager API is disabled for the Google Cloud project. ${TAG_MANAGER_API_DISABLED}`);
    case "rate-limit":
      return new Error("Tag Manager is rate limiting requests (quota exceeded). Wait a minute and retry.");
    case "scope":
      return new Error(gtmScopeMessage());
    case "denied":
      return new Error(accessDeniedMessage(containerPath, who));
    case "not-found":
      return new Error(
        `${containerPath} was not found in Tag Manager (or the Google account can't see it). Check gtmAccountId and gtmContainerId in clients.yaml; ` +
          "they are the numeric IDs in the Tag Manager URL (/container/accounts/<account>/containers/<container>), not the GTM-XXXX ID.",
      );
    default:
      return new Error(`Tag Manager request for ${containerPath} failed: ${info.message}`);
  }
}
