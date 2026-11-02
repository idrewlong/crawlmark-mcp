/**
 * Release 0.5.0: Traffic by channel, year over year (C4 channel_yoy; Y1).
 * One GA4 request per range (all traffic, per default channel group, not only organic). The comparison is always the
 * same dates a year earlier, whatever the template's `compare` says.
 */
import { pctChange } from "../../lib/dates.js";
import type { ChannelRow, ChannelYoyData } from "../report-types.js";
import { minusOneYear } from "../templates/period.js";
import type { SectionSpec } from "../templates/schema.js";
import { SectionUnavailableError } from "../templates/run.js";
import type { YearlyCtx } from "./context.js";

type Figures = { sessions: number; users: number; engagedSessions: number; keyEvents: number };
type Prev = { sessions: number; users: number; keyEvents: number };

const DEFAULT_LIMIT = 8;
const ZERO: Figures = { sessions: 0, users: 0, engagedSessions: 0, keyEvents: 0 };

const sum = (list: readonly Figures[]): Figures =>
  list.reduce((a, r) => ({ sessions: a.sessions + r.sessions, users: a.users + r.users, engagedSessions: a.engagedSessions + r.engagedSessions, keyEvents: a.keyEvents + r.keyEvents }), ZERO);

function row(channel: string, cur: Figures, prev: Prev | null): ChannelRow {
  const p = prev ?? { sessions: 0, users: 0, keyEvents: 0 };
  return {
    channel,
    sessions: cur.sessions,
    users: cur.users,
    keyEvents: cur.keyEvents,
    engagementRate: cur.sessions > 0 ? Number(((cur.engagedSessions / cur.sessions) * 100).toFixed(1)) : null,
    previous: prev,
    change: { sessions: pctChange(cur.sessions, p.sessions), users: pctChange(cur.users, p.users), keyEvents: pctChange(cur.keyEvents, p.keyEvents) },
  };
}

export async function channelYoy(s: Extract<SectionSpec, { type: "channel_yoy" }>, ctx: YearlyCtx): Promise<ChannelYoyData> {
  const fetchChannels = ctx.deps.ga4ChannelReport;
  if (!fetchChannels) throw new SectionUnavailableError("this build can't read GA4 channels");
  const metric = s.metric ?? "sessions";
  const limit = s.limit ?? DEFAULT_LIMIT;
  const current = ctx.period.current;
  const previous = minusOneYear(current);
  const read = (r: typeof current) => ctx.once(`gc:${r.startDate}:${r.endDate}`, () => fetchChannels(ctx.client, r));
  const [curRows, prevRows] = await Promise.all([read(current), read(previous)]);

  const names = [...new Set([...curRows, ...prevRows].map((r) => r.channel))];
  const figures = (list: typeof curRows, name: string): Figures => sum(list.filter((r) => r.channel === name));
  const all = names
    .map((name) => {
      const c = figures(curRows, name);
      const hadPrev = prevRows.some((r) => r.channel === name);
      const p = figures(prevRows, name);
      return { name, c, p, prev: hadPrev ? { sessions: p.sessions, users: p.users, keyEvents: p.keyEvents } : null };
    })
    .sort((a, b) => b.c[metric] - a.c[metric] || a.name.localeCompare(b.name));

  const shown = all.slice(0, limit);
  const rest = all.slice(limit);
  const rows = shown.map((x) => row(x.name, x.c, x.prev));
  let other: ChannelRow | null = null;
  if (rest.length) {
    const p = sum(rest.map((x) => x.p));
    other = row("Other channels", sum(rest.map((x) => x.c)), rest.some((x) => x.prev) ? { sessions: p.sessions, users: p.users, keyEvents: p.keyEvents } : null);
  }
  const pt = sum(prevRows);
  return {
    current,
    previous,
    metric,
    rows,
    other,
    totals: row("Total", sum(curRows), { sessions: pt.sessions, users: pt.users, keyEvents: pt.keyEvents }),
    previousEmpty: pt.sessions === 0,
  };
}
