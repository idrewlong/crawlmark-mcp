/**
 * Release 0.5.0 Y1.1: the channel_yoy section (GA4 default channel groups, all traffic, against the same dates a
 * year earlier). Fixture GA4; no network.
 */
import { describe, expect, it, vi } from "vitest";
import type { DateRange } from "../src/lib/dates.js";
import { channelYoy } from "../src/reports/yearly/channel-yoy.js";
import type { YearlyCtx } from "../src/reports/yearly/context.js";
import type { ResolvedPeriod } from "../src/reports/templates/period.js";
import type { RunDeps } from "../src/reports/templates/run.js";
import type { SectionSpec } from "../src/reports/templates/schema.js";
import { client, fakeDeps } from "./fixtures/reports/deps.js";
import { CHANNEL_YOY, YEAR_2024, YEAR_2025 } from "./fixtures/reports/yearly-data.js";

type Spec = Extract<SectionSpec, { type: "channel_yoy" }>;
const spec = (over: Partial<Spec> = {}): Spec => ({ id: "channels", type: "channel_yoy", ...over }) as Spec;

function ctx(over: { deps?: Partial<RunDeps>; period?: ResolvedPeriod } = {}): YearlyCtx {
  const memo = new Map<string, Promise<unknown>>();
  const period: ResolvedPeriod = over.period ?? { current: YEAR_2025, label: "2025", folderMonth: "2025-12", comparisons: { previous_year: YEAR_2024 } };
  const deps = fakeDeps(over.deps);
  return {
    client,
    deps,
    today: new Date("2026-10-13T12:00:00Z"),
    period,
    gscPeriod: period,
    coverage: () => ({ complete: true, source: "google" }),
    once: (k, fn) => {
      if (!memo.has(k)) memo.set(k, fn());
      return memo.get(k) as Promise<never>;
    },
    totals: async (r) => deps.gscTotals(client, r),
    note: () => {},
  };
}

describe("channelYoy", () => {
  it("matches the contract fixture for 2025 against 2024", async () => {
    expect(await channelYoy(spec(), ctx())).toEqual(CHANNEL_YOY);
  });

  it("always compares with the same dates a year earlier, even when the template compares with the previous period", async () => {
    const calls: DateRange[] = [];
    const current = { startDate: "2026-01-01", endDate: "2026-09-30" };
    const period: ResolvedPeriod = { current, label: "x", folderMonth: "2026-09", comparisons: { previous_period: { startDate: "2025-04-01", endDate: "2025-12-31" } } };
    const data = await channelYoy(spec(), ctx({ period, deps: { ga4ChannelReport: async (_c, r) => (calls.push(r), []) } }));
    expect(calls).toEqual([current, { startDate: "2025-01-01", endDate: "2025-09-30" }]);
    expect(data.previous).toEqual({ startDate: "2025-01-01", endDate: "2025-09-30" });
    expect(data.previousEmpty).toBe(true);
  });

  it("sends one request per range", async () => {
    const f = vi.fn(async () => []);
    await channelYoy(spec(), ctx({ deps: { ga4ChannelReport: f } }));
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("sorts by the chosen metric, ties by channel name", async () => {
    const rows = [
      { channel: "B", sessions: 10, users: 5, engagedSessions: 5, keyEvents: 1 },
      { channel: "A", sessions: 10, users: 9, engagedSessions: 5, keyEvents: 0 },
      { channel: "C", sessions: 3, users: 2, engagedSessions: 1, keyEvents: 7 },
    ];
    const deps = { ga4ChannelReport: async () => rows };
    expect((await channelYoy(spec(), ctx({ deps }))).rows.map((r) => r.channel)).toEqual(["A", "B", "C"]);
    expect((await channelYoy(spec({ metric: "users" }), ctx({ deps }))).rows.map((r) => r.channel)).toEqual(["A", "B", "C"]);
    const byKey = await channelYoy(spec({ metric: "keyEvents" }), ctx({ deps }));
    expect(byKey.metric).toBe("keyEvents");
    expect(byKey.rows.map((r) => r.channel)).toEqual(["C", "B", "A"]);
  });

  it("sums the rows after the limit into Other channels and totals everything", async () => {
    const data = await channelYoy(spec({ limit: 2 }), ctx());
    expect(data.rows.map((r) => r.channel)).toEqual(["Organic Search", "Direct"]);
    expect(data.other).toMatchObject({ channel: "Other channels", sessions: 600 + 300 + 250 + 120 + 40 });
    expect(data.other!.previous!.sessions).toBe(Math.round(600 * 0.75) + Math.round(300 * 0.75) + Math.round(250 * 0.75) + Math.round(120 * 0.75) + Math.round(40 * 0.75) + 60);
    expect(data.totals.channel).toBe("Total");
    expect(data.totals.sessions).toBe(CHANNEL_YOY.totals.sessions);
    expect(data.totals.previous).toEqual(CHANNEL_YOY.totals.previous);
    expect(data.rows.reduce((a, r) => a + r.sessions, 0) + data.other!.sessions).toBe(data.totals.sessions);
  });

  it("computes changes, null at a zero base, and keeps a channel that exists only last year with zeros now", async () => {
    const data = await channelYoy(spec(), ctx());
    const affiliates = data.rows.find((r) => r.channel === "Affiliates")!;
    expect(affiliates).toMatchObject({ sessions: 0, users: 0, keyEvents: 0, engagementRate: null, previous: { sessions: 60, users: 55, keyEvents: 3 } });
    expect(affiliates.change).toEqual({ sessions: -100, users: -100, keyEvents: -100 });
    expect(data.rows.find((r) => r.channel === "Organic Search")!.change.sessions).toBe(33.3);
    const fresh = await channelYoy(
      spec(),
      ctx({ deps: { ga4ChannelReport: async (_c, r) => (r.startDate.startsWith("2024") ? [] : [{ channel: "Direct", sessions: 5, users: 4, engagedSessions: 2, keyEvents: 0 }]) } }),
    );
    expect(fresh.rows[0]).toMatchObject({ previous: null, engagementRate: 40, change: { sessions: null, users: null, keyEvents: null } });
    expect(fresh.previousEmpty).toBe(true);
  });

  it("is unavailable without a GA4 channel reader", async () => {
    const c = ctx();
    delete (c.deps as { ga4ChannelReport?: unknown }).ga4ChannelReport;
    await expect(channelYoy(spec(), c)).rejects.toMatchObject({ name: "SectionUnavailableError", message: "this build can't read GA4 channels" });
  });
});
