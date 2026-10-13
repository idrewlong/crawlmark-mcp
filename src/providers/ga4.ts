import { google } from "googleapis";
import type { Client } from "../config.js";
import { cached, cacheKey, TTL } from "../lib/cache.js";
import type { DateRange } from "../lib/dates.js";
import { googleAuth } from "./google.js";

export interface Ga4ReportOptions extends DateRange {
  metrics: string[];
  dimensions?: string[];
  /** Restrict to organic search sessions. */
  organicOnly?: boolean;
  limit?: number;
}

export type Ga4Row = Record<string, string | number>;

function requireProperty(client: Client): string {
  if (!client.ga4PropertyId) throw new Error(`${client.slug} has no ga4PropertyId in clients.yaml`);
  return `properties/${client.ga4PropertyId}`;
}

/** GA4 Data API runReport, flattened into plain row objects. */
export async function ga4Report(client: Client, opts: Ga4ReportOptions): Promise<Ga4Row[]> {
  const property = requireProperty(client);
  const { value } = await cached(cacheKey("ga4", property, opts), TTL.day, async () => {
    const data = google.analyticsdata({ version: "v1beta", auth: googleAuth() });
    const res = await data.properties.runReport({
      property,
      requestBody: {
        dateRanges: [{ startDate: opts.startDate, endDate: opts.endDate }],
        metrics: opts.metrics.map((name) => ({ name })),
        dimensions: (opts.dimensions ?? []).map((name) => ({ name })),
        limit: String(opts.limit ?? 1000),
        dimensionFilter: opts.organicOnly
          ? {
              filter: {
                fieldName: "sessionDefaultChannelGroup",
                stringFilter: { value: "Organic Search", matchType: "EXACT" },
              },
            }
          : undefined,
      },
    });
    const dimNames = res.data.dimensionHeaders?.map((h) => h.name!) ?? [];
    const metNames = res.data.metricHeaders?.map((h) => h.name!) ?? [];
    return (res.data.rows ?? []).map((row) => {
      const out: Ga4Row = {};
      row.dimensionValues?.forEach((v, i) => (out[dimNames[i]!] = v.value ?? ""));
      row.metricValues?.forEach((v, i) => (out[metNames[i]!] = Number(v.value ?? 0)));
      return out;
    });
  });
  return value;
}

/** Headline organic metrics for a date range. */
export async function ga4OrganicSummary(client: Client, range: DateRange) {
  const [row] = await ga4Report(client, {
    ...range,
    organicOnly: true,
    metrics: ["sessions", "totalUsers", "engagedSessions", "engagementRate", "keyEvents"],
  });
  return {
    sessions: Number(row?.sessions ?? 0),
    users: Number(row?.totalUsers ?? 0),
    engagedSessions: Number(row?.engagedSessions ?? 0),
    engagementRate: Number((Number(row?.engagementRate ?? 0) * 100).toFixed(1)),
    keyEvents: Number(row?.keyEvents ?? 0),
  };
}

/** Top organic landing pages for a date range. */
export function ga4TopLandingPages(client: Client, range: DateRange, limit = 20) {
  return ga4Report(client, {
    ...range,
    organicOnly: true,
    dimensions: ["landingPagePlusQueryString"],
    metrics: ["sessions", "engagementRate", "keyEvents"],
    limit,
  });
}
