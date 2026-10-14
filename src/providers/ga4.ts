import { google } from "googleapis";
import type { Client } from "../config.js";
import { cached, cacheKey, TTL } from "../lib/cache.js";
import type { DateRange } from "../lib/dates.js";
import { ga4Error } from "../lib/google-access.js";
import { assertGoogleConfigured, googleAuth, googleAuthIdentity, googleAuthStatus } from "./google.js";

function whoAmI() {
  const s = googleAuthStatus();
  return s.mode === "none" ? { mode: "none" as const } : { mode: s.mode, email: s.email };
}

export interface Ga4ReportOptions extends DateRange {
  metrics: string[];
  dimensions?: string[];
  /** Restrict to organic search sessions. */
  organicOnly?: boolean;
  limit?: number;
}

export type Ga4Row = Record<string, string | number>;

function requireProperty(client: Client): string {
  assertGoogleConfigured();
  if (!client.ga4PropertyId) {
    throw new Error(
      `No GA4 property found for ${client.domain}. Give the Google account access to its GA4 property ` +
        "(then call list_clients with refresh: true), or set ga4PropertyId for it in clients.yaml.",
    );
  }
  return `properties/${client.ga4PropertyId}`;
}

/** GA4 Data API runReport, flattened into plain row objects. */
export async function ga4Report(client: Client, opts: Ga4ReportOptions): Promise<Ga4Row[]> {
  const property = requireProperty(client);
  const { value } = await cached(cacheKey("ga4", googleAuthIdentity(), property, opts), TTL.day, async () => {
    const data = google.analyticsdata({ version: "v1beta", auth: googleAuth() });
    let res;
    try {
      res = await data.properties.runReport({
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
    } catch (err) {
      throw ga4Error(err, property, whoAmI());
    }
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

/** Organic sessions per day (GA4 `date` dimension, YYYYMMDD to YYYY-MM-DD), oldest first. */
export async function ga4OrganicDaily(client: Client, range: DateRange): Promise<{ date: string; sessions: number }[]> {
  const rows = await ga4Report(client, { ...range, organicOnly: true, dimensions: ["date"], metrics: ["sessions"], limit: 1000 });
  // GA4 leaves out days with no sessions; the report fills the gaps between reported days (src/reports/templates/run.ts).
  return rows
    .map((r) => ({ date: String(r.date ?? "").replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"), sessions: Number(r.sessions ?? 0) }))
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date))
    .sort((a, b) => a.date.localeCompare(b.date));
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
