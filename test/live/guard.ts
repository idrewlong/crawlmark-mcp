/**
 * The paid-endpoint guard for `npm run test:live`. Every request the live checks make goes through
 * `guardedFetch`, which throws before sending anything unless method, host and path are on the allowlist below.
 * The allowlist holds only endpoints the vendors document as free. Adding to it needs a vendor doc that says "free".
 */
export class PaidEndpointRefusedError extends Error {
  override name = "PaidEndpointRefusedError";
}

interface Rule {
  vendor: string;
  method: string;
  /** Matched against the hostname. */
  host: RegExp;
  /** Matched against the whole path (no query string). */
  path: RegExp;
}

export const FREE_ENDPOINTS: readonly Rule[] = [
  { vendor: "Search Console", method: "GET", host: /^searchconsole\.googleapis\.com$/, path: /^\/webmasters\/v3\/sites$/ },
  { vendor: "GA4 Admin", method: "GET", host: /^analyticsadmin\.googleapis\.com$/, path: /^\/v1beta\/accountSummaries$/ },
  // Token refresh for the OAuth or service-account identity. Not an API call.
  { vendor: "Google auth", method: "POST", host: /^(oauth2|www)\.googleapis\.com$/, path: /^\/(oauth2\/v4\/)?token$/ },
  // "free and do not consume any API units" (Ahrefs docs).
  { vendor: "Ahrefs", method: "GET", host: /^api\.ahrefs\.com$/, path: /^\/v3\/subscription-info\/limits-and-usage$/ },
  // Account details; free in the sandbox and live (DataForSEO docs). The sandbox host is the default here.
  { vendor: "DataForSEO", method: "GET", host: /(^|\.)dataforseo\.com$/, path: /^\/v3\/appendix\/user_data$/ },
  // Units balance check; documented as free (Semrush API docs).
  { vendor: "Semrush", method: "GET", host: /^api\.semrush\.com$/, path: /^\/users\/countapiunits\.html$/ },
  { vendor: "Bing Webmaster", method: "GET", host: /^ssl\.bing\.com$/, path: /^\/webmaster\/api\.svc\/json\/GetUserSites$/ },
  // CrUX History API: no per-call charge, 150 queries a minute quota.
  { vendor: "CrUX", method: "POST", host: /^chromeuxreport\.googleapis\.com$/, path: /^\/v1\/records:queryHistoryRecord$/ },
];

/** Throws PaidEndpointRefusedError unless this request is on the allowlist. The message never includes the query string (it can carry a key). */
export function assertFreeEndpoint(method: string, rawUrl: string): void {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new PaidEndpointRefusedError("Refusing a request to an unparseable URL.");
  }
  const m = method.toUpperCase();
  const ok = FREE_ENDPOINTS.some((r) => r.method === m && r.host.test(u.hostname) && r.path.test(u.pathname));
  if (!ok) {
    throw new PaidEndpointRefusedError(
      `Refusing ${m} ${u.hostname}${u.pathname}: not on the live-test allowlist of free endpoints (test/live/guard.ts). This may be a paid endpoint.`,
    );
  }
}

type FetchInput = Parameters<typeof fetch>[0];

function describeRequest(input: FetchInput, init?: RequestInit): { method: string; url: string } {
  if (typeof input === "string") return { method: init?.method ?? "GET", url: input };
  if (input instanceof URL) return { method: init?.method ?? "GET", url: input.href };
  return { method: init?.method ?? input.method, url: input.url };
}

/** A `fetch` that refuses anything not on the allowlist, then delegates to the real one. */
export function guardedFetchFrom(real: typeof fetch): typeof fetch {
  return (async (input: FetchInput, init?: RequestInit) => {
    const { method, url } = describeRequest(input, init);
    assertFreeEndpoint(method, url);
    // Only the checked URL may be fetched: a redirect to another endpoint fails instead of being followed unchecked.
    return real(input, { ...init, redirect: "error" });
  }) as typeof fetch;
}
