import { loadRegistry } from "./clients.js";
import { assertOnClientDomain, assertSafeUrlResolved, restrictToClientDomains } from "./lib/url-guard.js";

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
