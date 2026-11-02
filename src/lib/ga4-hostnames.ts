/**
 * Release A / D3: which hostnames count toward a client's GA4 numbers. Pure (no I/O).
 * Entries are an exact host ("shop.example.com"), "*.example.com" (any subdomain, not the apex) or "*" alone (no filter).
 */

/** The single entry that turns the hostname filter off. */
export const ALL_HOSTNAMES = "*";

export const MAX_GA4_HOSTNAMES = 20;
const MAX_HOST_LENGTH = 253;
const HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** The hostnames counted when clients.yaml sets none: the domain and its www form (no subdomains). */
export function defaultGa4Hostnames(domain: string): string[] {
  const bare = domain.trim().toLowerCase().replace(/^www\./, "");
  return [bare, `www.${bare}`];
}

function isHost(host: string): boolean {
  return host.length <= MAX_HOST_LENGTH && (host === "localhost" || HOST_RE.test(host));
}

/** Why one entry isn't usable, or null when it is. */
export function ga4HostnameProblem(item: string): string | null {
  if (typeof item !== "string" || item.trim() === "") return "is empty";
  const s = item.toLowerCase();
  if (s === ALL_HOSTNAMES) return null;
  if (s.length > MAX_HOST_LENGTH + 2) return `is longer than ${MAX_HOST_LENGTH} characters`;
  const host = s.startsWith("*.") ? s.slice(2) : s;
  if (!isHost(host)) {
    return 'must be a host such as "shop.example.com" (letters, digits, - and ., with a dot), "*.example.com" for any subdomain, or "*" alone for no filter';
  }
  return null;
}

/** Error text for a whole list, or null when it is OK. An empty list is an error: callers clear a list instead of validating it. */
export function validateGa4Hostnames(items: readonly string[]): string | null {
  if (items.length === 0) return "needs at least one hostname";
  if (items.length > MAX_GA4_HOSTNAMES) return `has ${items.length} entries; the most allowed is ${MAX_GA4_HOSTNAMES}`;
  for (const item of items) {
    const problem = ga4HostnameProblem(item);
    if (problem) return `"${item.slice(0, 100)}" isn't a usable GA4 hostname: ${problem}.`;
  }
  if (items.length > 1 && items.some((i) => i.toLowerCase() === ALL_HOSTNAMES)) {
    return '"*" turns the hostname filter off, so it must be the only entry.';
  }
  return null;
}

const escapeRe2 = (s: string) => s.replace(/[\\.^$|?*+()[\]{}]/g, "\\$&");

function isAll(items: readonly string[]): boolean {
  return items.some((i) => i.trim().toLowerCase() === ALL_HOSTNAMES);
}

function normalized(items: readonly string[]): string[] {
  return [...new Set(items.map((i) => i.trim().toLowerCase()).filter(Boolean))];
}

/**
 * RE2 FULL_REGEXP for GA4's hostName filter (the caller sets caseSensitive false), or null for ["*"].
 * Exact hosts are escaped; "*.example.com" becomes "([a-z0-9-]+\.)+example\.com".
 */
export function ga4HostnameRegex(items: readonly string[]): string | null {
  if (isAll(items)) return null;
  const parts = normalized(items).map((i) => (i.startsWith("*.") ? `([a-z0-9-]+\\.)+${escapeRe2(i.slice(2))}` : escapeRe2(i)));
  return parts.length ? parts.join("|") : null;
}

/** JS-side test of one hostName against the list (same semantics as the regex). */
export function hostnameAllowed(host: string, items: readonly string[]): boolean {
  if (isAll(items)) return true;
  const h = host.trim().toLowerCase();
  for (const item of normalized(items)) {
    if (!item.startsWith("*.")) {
      if (h === item) return true;
      continue;
    }
    const base = item.slice(2);
    if (h.length > base.length + 1 && h.endsWith(`.${base}`) && /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(h.slice(0, -(base.length + 1)))) return true;
  }
  return false;
}
