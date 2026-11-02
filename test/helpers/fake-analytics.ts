/**
 * A fake googleapis for the Search Console and GA4 report calls (Release A, WS3). Nothing leaves the process: a test
 * sets `fake.gsc` / `fake.ga4` (the answer for one request body) and reads `fake.gscCalls` / `fake.ga4Calls` (every
 * request body sent). Use it with:
 *
 *   vi.mock("googleapis", async () => (await import("./helpers/fake-analytics.js")).googleapisMock);
 *   vi.mock("../src/providers/google.js", async () => (await import("./helpers/fake-analytics.js")).googleProviderMock);
 */
export interface FakeRow {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
}

export interface GscBody {
  startDate: string;
  endDate: string;
  dimensions?: string[];
  rowLimit?: number;
  dimensionFilterGroups?: { filters: { dimension: string; operator: string; expression: string }[] }[];
}

export const fake = {
  gscCalls: [] as GscBody[],
  ga4Calls: [] as any[],
  gsc: (async () => []) as (body: GscBody) => Promise<FakeRow[]> | FakeRow[],
  ga4: (async () => ({ rows: [] })) as (body: any) => Promise<any> | any,
  reset() {
    this.gscCalls = [];
    this.ga4Calls = [];
    this.gsc = async () => [];
    this.ga4 = async () => ({ rows: [] });
  },
};

export const googleapisMock = {
  google: {
    options: () => undefined,
    auth: {},
    searchconsole: () => ({
      searchanalytics: {
        query: async ({ requestBody }: { requestBody: GscBody }) => {
          fake.gscCalls.push(structuredClone(requestBody));
          // Search Console reports ctr as a fraction.
          return { data: { rows: await fake.gsc(requestBody) } };
        },
      },
    }),
    analyticsdata: () => ({
      properties: {
        runReport: async ({ requestBody }: { requestBody: unknown }) => {
          fake.ga4Calls.push(structuredClone(requestBody));
          return { data: await fake.ga4(requestBody) };
        },
      },
    }),
  },
};

export const googleProviderMock = {
  googleAuth: () => ({}),
  googleAuthIdentity: () => "fake-analytics-identity",
  assertGoogleConfigured: () => undefined,
  googleConfigured: () => true,
  googleAuthStatus: () => ({ mode: "service_account", auto: false, configured: true, email: "crawlmark@example-project.iam.gserviceaccount.com" }),
};

/** A Search Console row as the API returns it (ctr as a fraction). */
export const row = (keys: string[], clicks: number, impressions: number, position = 5): FakeRow => ({
  keys,
  clicks,
  impressions,
  ctr: impressions ? clicks / impressions : 0,
  position,
});

/** Which filters (by operator) a request carried. */
export const filtersOf = (b: GscBody) => b.dimensionFilterGroups?.[0]?.filters ?? [];
