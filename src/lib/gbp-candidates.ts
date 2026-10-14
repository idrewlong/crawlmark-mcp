/**
 * Google Business Profile place IDs local_profile has shown for a client in the last day (SEC-2). set_client_profile
 * accepts an MCP-supplied gbpPlaceId only from this list, so a place ID can't be saved without a lookup the user
 * could check first. The CLI's --place-id is typed by the user and skips the check.
 */
import { cacheKey, peekCache, putCache, TTL } from "./cache.js";

const key = (clientSlug: string) => cacheKey("gbp-candidates", clientSlug);

/** Remember the place IDs a lookup returned for this client (added to the day's list). */
export function recordGbpCandidates(clientSlug: string, placeIds: readonly (string | null)[]): void {
  const ids = placeIds.filter((p): p is string => Boolean(p));
  if (ids.length === 0) return;
  const prior = peekCache<string[]>(key(clientSlug)) ?? [];
  putCache(key(clientSlug), TTL.day, [...new Set([...prior, ...ids])].slice(-50));
}

/** True when local_profile returned this place ID for this client in the last day. */
export function isGbpCandidate(clientSlug: string, placeId: string): boolean {
  return (peekCache<string[]>(key(clientSlug)) ?? []).includes(placeId);
}
