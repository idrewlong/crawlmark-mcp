import { google } from "googleapis";
import { cached, cacheKey, TTL } from "../lib/cache.js";
import { mapLimit } from "../lib/concurrency.js";
import {
  ga4PropertiesFromSummaries,
  gscSitesFromResponse,
  webStreamUrisFromResponse,
  type Ga4Property,
  type Ga4Ref,
  type GscSite,
} from "../lib/clients.js";
import { googleAuth, googleAuthIdentity } from "./google.js";

/**
 * Lists what the active Google identity can see: Search Console sites and GA4
 * properties with their web-stream URLs. Raw lists are cached for a day; the
 * join into clients happens in src/lib/clients.ts.
 */

/** Stream lookups in flight at once. The Admin API quota is generous, but accounts can have hundreds of properties. */
const STREAM_CONCURRENCY = 5;

/** Cache keys include the identity, so switching account or auth mode doesn't reuse another identity's list. */
const identity = googleAuthIdentity;

export interface Fetched<T> {
  value: T;
  fromCache: boolean;
}

export async function listGscSites(opts: { refresh?: boolean } = {}): Promise<Fetched<GscSite[]>> {
  const auth = googleAuth(); // throws a setup message before touching the cache if auth isn't configured
  return cached(
    cacheKey("discovery-gsc-sites", identity()),
    TTL.day,
    async () => {
      const sc = google.searchconsole({ version: "v1", auth });
      const res = await sc.sites.list();
      return gscSitesFromResponse(res.data);
    },
    opts,
  );
}

export interface Ga4Listing {
  properties: Ga4Property[];
  /** Per-property stream lookups that failed (not cached, so they retry next time). */
  errors: string[];
}

export async function listGa4Properties(opts: { refresh?: boolean } = {}): Promise<Fetched<Ga4Listing>> {
  const auth = googleAuth();
  const id = identity();
  const admin = google.analyticsadmin({ version: "v1beta", auth });

  const summaries = await cached(
    cacheKey("discovery-ga4-properties", id),
    TTL.day,
    async () => {
      const out: Ga4Ref[] = [];
      let pageToken: string | undefined;
      do {
        const res = await admin.accountSummaries.list({ pageSize: 200, pageToken });
        out.push(...ga4PropertiesFromSummaries(res.data));
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken);
      return out;
    },
    opts,
  );

  const errors: string[] = [];
  let allFromCache = summaries.fromCache;
  const properties = await mapLimit(summaries.value, STREAM_CONCURRENCY, async (p): Promise<Ga4Property | undefined> => {
    try {
      const streams = await cached(
        cacheKey("discovery-ga4-streams", id, p.propertyId),
        TTL.day,
        async () => {
          const uris: string[] = [];
          let pageToken: string | undefined;
          do {
            const res = await admin.properties.dataStreams.list({
              parent: `properties/${p.propertyId}`,
              pageSize: 200,
              pageToken,
            });
            uris.push(...webStreamUrisFromResponse(res.data));
            pageToken = res.data.nextPageToken ?? undefined;
          } while (pageToken);
          return uris;
        },
        opts,
      );
      if (!streams.fromCache) allFromCache = false;
      return { ...p, webStreamUris: streams.value };
    } catch (err) {
      errors.push(`GA4 property ${p.propertyId} (${p.displayName}): could not list data streams: ${(err as Error).message}`);
      return undefined;
    }
  });

  return {
    value: { properties: properties.filter((p): p is Ga4Property => Boolean(p)), errors },
    fromCache: allFromCache,
  };
}
