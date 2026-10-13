/**
 * Pure helpers for Tag Manager discovery and errors (Phase 6b): API payloads ->
 * container refs, the domain join  and
 * the error messages. The I/O lives in src/providers/gtm.ts.
 */
import { GTM_SCOPE_MESSAGE } from "./google-auth.js";

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

/**
 * Match containers to client domains. Each listed domain goes through

 * normalizeHost, the Phase 0c host normaliser passed in by the caller (`https://www.x.com/` and `x.com` both give `x.com`). When
 * several containers list one host, the lowest `GTM-` ID wins and the others
 * become alternates. Containers with no domain list are returned unmatched.
 */
export function joinGtmContainers(
  containers: GtmContainerRef[],
  normalizeHost: (input: string) => string | undefined,
): { matches: Map<string, GtmMatch>; unmatched: GtmContainerRef[] } {
  const byHost = new Map<string, GtmContainerRef[]>();
  const unmatched: GtmContainerRef[] = [];
  for (const c of [...containers].sort(byIds)) {
    const hosts = new Set(c.domainName.flatMap((d) => normalizeHost(d) ?? []));
    if (hosts.size === 0) {
      unmatched.push(c);
      continue;
    }
    for (const h of hosts) byHost.set(h, [...(byHost.get(h) ?? []), c]);
  }
  const matches = new Map<string, GtmMatch>();
  for (const [host, list] of byHost) {
    const [first, ...rest] = list;
    matches.set(host, {
      gtmAccountId: first!.accountId,
      gtmContainerId: first!.containerId,
      publicId: first!.publicId,
      name: first!.name,
      alternates: rest.map((c) => ({ gtmAccountId: c.accountId, gtmContainerId: c.containerId, publicId: c.publicId })),
    });
  }
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
    const shown = unmatched.slice(0, MAX_LISTED).map((c) => `${c.publicId || c.containerId} "${c.name}" (account ${c.accountId})`);
    const more = unmatched.length > shown.length ? ` and ${unmatched.length - shown.length} more` : "";
    notes.push(
      `Tag Manager: ${unmatched.length} web container(s) list no domain, so they can't be matched to a client: ${shown.join(", ")}${more}. ` +
        "Set gtmAccountId and gtmContainerId on the client in clients.yaml to use one.",
    );
  }
  for (const [host, m] of matches) {
    if (m.alternates.length && !pinned.has(host)) {
      notes.push(
        `Tag Manager: ${host} is listed by ${m.alternates.length + 1} containers; using ${m.publicId || m.gtmContainerId}. ` +
          `Others: ${m.alternates.map((a) => a.publicId || a.gtmContainerId).join(", ")}. Pin one with gtmContainerId in clients.yaml.`,
      );
    }
  }
  notes.push(...listing.errors);
  return notes;
}

// ---------------------------------------------------------------- errors

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
  const info = apiErrorInfo(err);
  switch (classifyGtmError(info)) {
    case "api-disabled":
      return new Error(`The Tag Manager API is disabled for the Google Cloud project. ${TAG_MANAGER_API_DISABLED}`);
    case "rate-limit":
      return new Error("Tag Manager is rate limiting requests (quota exceeded). Wait a minute and retry.");
    case "scope":
      return new Error(GTM_SCOPE_MESSAGE);
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
