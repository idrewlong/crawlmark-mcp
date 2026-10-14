import { loadRegistry } from "./clients.js";
import { assertOnClientDomain, assertSafeUrlResolved, hostInDomains, restrictToClientDomains, UrlRefusedError } from "./lib/url-guard.js";

/**
 * Check a URL a user passed to a tool (lighthouse, accessibility_check, render_check,
 * run_audit `urls`): http(s) only, every resolved address public (unless
 * ALLOW_PRIVATE_URLS=true), and with RESTRICT_TO_CLIENT_DOMAINS=true, on a client
 * domain or one of its subdomains. Subresources the page loads are not restricted to
 * client domains; the egress proxy still applies the address check to them.
 */
export async function assertUserUrl(raw: string): Promise<URL> {
  const restrict = restrictToClientDomains();
  const { url } = await assertSafeUrlResolved(raw);
  if (restrict) {
    const { clients } = await loadRegistry();
    assertOnClientDomain(url.hostname, clients.map((c) => c.domain));
  }
  return url;
}

/**
 * The RESTRICT_TO_CLIENT_DOMAINS policy for the URLs a check ends up on after redirects: undefined when the restriction
 * is off, else a predicate that is true only for a client domain or a subdomain of one. Browser-based checks (render,
 * Lighthouse, axe) test the final URL and each redirect hop with it; subresources stay unrestricted (the egress proxy
 * still checks their addresses).
 */
export async function clientDomainPolicy(): Promise<((url: string) => boolean) | undefined> {
  if (!restrictToClientDomains()) return undefined;
  const domains = (await loadRegistry()).clients.map((c) => c.domain);
  return (u) => {
    try {
      return hostInDomains(new URL(u).hostname, domains);
    } catch {
      return false;
    }
  };
}

/** Throw UrlRefusedError when `policy` is set and refuses `url` (a page that redirected off the client's domains). */
export function assertAllowedByPolicy(policy: ((url: string) => boolean) | undefined, url: string): void {
  if (!policy || policy(url)) return;
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* keep the raw text */
  }
  throw new UrlRefusedError(`Refusing a redirect to ${host}: RESTRICT_TO_CLIENT_DOMAINS=true and it is not a client domain or a subdomain of one.`);
}
