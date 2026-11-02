/**
 * Release 0.5.0 (C4 wins_misses): what went right and wrong between two periods, by fixed published thresholds.
 * Pure: no I/O, no clock. The rules (and WM) are printed in the rendered section, so changing a number here changes
 * what the report promises.
 */
import { pctChange } from "../lib/dates.js";
import { stripControl } from "../lib/terminal-text.js";
import type { GscRow } from "../providers/gsc.js";
import type { Ga4Summary } from "../reports/monthly.js";
import type { WinMissItem, WinsMissesData } from "../reports/report-types.js";

export const WM = { kpiPct: 5, kpiAbs: 20, positionMove: 1.0, pageAbs: 20, pagePct: 25, queryMinImpr: 100 } as const;

export type GoalMetric = "clicks" | "impressions" | "sessions" | "keyEvents";
export interface WinsMissesInput {
  totals: { cur: GscRow; prev: GscRow | null };
  ga4?: { cur: Ga4Summary; prev: Ga4Summary | null };
  pages: { cur: GscRow[]; prev: GscRow[] };
  queries: { cur: GscRow[]; prev: GscRow[] };
  goals: { metric: GoalMetric; target: number; label?: string | undefined }[];
  limit: number;
  isBranded: (q: string) => boolean;
}

/** Where a query sits when it is not in the rows at all (beyond what Search Console returned): used only to order. */
const UNSEEN_POSITION = 100;

const shortText = (s: string, n: number) => stripControl(s).slice(0, n);
const one = (n: number) => n.toFixed(1);
/**
 * A count as the report prints it ("20,000", not "20000"): the same formatting as fmtInt in render/sections.ts and
 * int in highlights.ts. Kept here rather than imported: analysis must not load the renderer (a module cycle through
 * render/narrative.js deadlocks when a test mocks it).
 */
const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");

interface Candidate {
  item: WinMissItem;
  /** Larger first. */
  size: number;
  tie: string;
}
const bySize = (a: Candidate, b: Candidate) => b.size - a.size || (a.tie < b.tie ? -1 : a.tie > b.tie ? 1 : 0);
const sorted = (list: Candidate[]) => [...list].sort(bySize).map((c) => c.item);

const GOAL_VALUE = (input: WinsMissesInput, metric: GoalMetric): { cur: number; prev: number | null } | null => {
  if (metric === "clicks" || metric === "impressions") return { cur: input.totals.cur[metric], prev: input.totals.prev ? input.totals.prev[metric] : null };
  if (!input.ga4) return null;
  return { cur: input.ga4.cur[metric], prev: input.ga4.prev ? input.ga4.prev[metric] : null };
};

function goalItems(input: WinsMissesInput): { goals: WinMissItem[]; skipped: string[] } {
  const goals: WinMissItem[] = [];
  const skipped: string[] = [];
  for (const g of input.goals) {
    const name = g.label ?? g.metric;
    const v = GOAL_VALUE(input, g.metric);
    if (!v) {
      skipped.push(name);
      continue;
    }
    const met = v.cur >= g.target;
    goals.push({
      kind: met ? "win" : "miss",
      rule: "goal",
      text: met ? `Goal met: ${name} ${fmtInt(v.cur)} (target ${fmtInt(g.target)})` : `Goal missed: ${name} ${fmtInt(v.cur)} of ${fmtInt(g.target)} (${Math.floor((v.cur / g.target) * 100)}%)`,
      metric: g.metric,
      current: v.cur,
      previous: v.prev,
      target: g.target,
    });
  }
  return { goals, skipped };
}

function kpiItems(input: WinsMissesInput): Candidate[] {
  const out: Candidate[] = [];
  const counts: { metric: string; name: string; cur: number; prev: number }[] = [];
  const { cur, prev } = input.totals;
  if (prev) {
    counts.push({ metric: "clicks", name: "Search clicks", cur: cur.clicks, prev: prev.clicks }, { metric: "impressions", name: "Search impressions", cur: cur.impressions, prev: prev.impressions });
  }
  if (input.ga4?.prev) {
    counts.push({ metric: "sessions", name: "Organic sessions", cur: input.ga4.cur.sessions, prev: input.ga4.prev.sessions }, { metric: "keyEvents", name: "Organic key events", cur: input.ga4.cur.keyEvents, prev: input.ga4.prev.keyEvents });
  }
  for (const c of counts) {
    const delta = c.cur - c.prev;
    // Integer comparisons: no float edge at exactly 5%.
    const bigEnough = Math.abs(delta) >= WM.kpiAbs && Math.abs(delta) * 100 >= WM.kpiPct * c.prev;
    if (!bigEnough) continue;
    const win = delta > 0;
    const pct = pctChange(c.cur, c.prev);
    const text = c.prev === 0 ? `${c.name} rose from 0 to ${fmtInt(c.cur)}` : `${c.name} ${win ? "rose" : "fell"} ${Math.abs(pct ?? 0)}% (${fmtInt(c.cur)} against ${fmtInt(c.prev)})`;
    out.push({ item: { kind: win ? "win" : "miss", rule: "kpi", text, metric: c.metric, current: c.cur, previous: c.prev }, size: Math.abs(delta), tie: c.metric });
  }
  if (prev && cur.impressions > 0 && prev.impressions > 0) {
    const move = Math.round((cur.position - prev.position) * 10) / 10;
    if (Math.abs(move) >= WM.positionMove) {
      const win = move < 0;
      out.push({
        item: {
          kind: win ? "win" : "miss",
          rule: "kpi",
          text: `Average position ${win ? "improved" : "slipped"} from ${one(prev.position)} to ${one(cur.position)}`,
          metric: "position",
          current: cur.position,
          previous: prev.position,
        },
        size: Math.abs(move),
        tie: "position",
      });
    }
  }
  return out;
}

function pageItems(input: WinsMissesInput): { wins: WinMissItem[]; misses: WinMissItem[] } {
  const prev = new Map(input.pages.prev.map((r) => [r.keys[0] ?? "", r.clicks]));
  const cur = new Map(input.pages.cur.map((r) => [r.keys[0] ?? "", r.clicks]));
  const by: Record<"page" | "page_new" | "page_lost", Candidate[]> = { page: [], page_new: [], page_lost: [] };
  const add = (rule: keyof typeof by, url: string, win: boolean, text: string, current: number, previous: number | null, size: number) =>
    by[rule].push({ item: { kind: win ? "win" : "miss", rule, text, metric: "clicks", current, previous }, size, tie: url });
  for (const [url, c] of cur) {
    const p = prev.get(url) ?? 0;
    const shown = shortText(url, 150);
    if (p === 0) {
      if (c >= WM.pageAbs) add("page_new", url, true, `${shown} is new, with ${fmtInt(c)} clicks`, c, null, c);
    } else if (c > 0) {
      const d = c - p;
      // |d| >= max(20, 25% of p), in integers.
      if (Math.abs(d) >= WM.pageAbs && Math.abs(d) * 100 >= WM.pagePct * p) {
        add("page", url, d > 0, `${shown} ${d > 0 ? "gained" : "lost"} ${fmtInt(Math.abs(d))} clicks`, c, p, Math.abs(d));
      }
    }
  }
  for (const [url, p] of prev) {
    if (p >= WM.pageAbs && (cur.get(url) ?? 0) === 0) add("page_lost", url, false, `${shortText(url, 150)} lost its ${fmtInt(p)} clicks`, 0, p, p);
  }
  const all = [...sorted(by.page), ...sorted(by.page_new), ...sorted(by.page_lost)];
  return { wins: all.filter((i) => i.kind === "win"), misses: all.filter((i) => i.kind === "miss") };
}

function queryItems(input: WinsMissesInput): { wins: WinMissItem[]; misses: WinMissItem[] } {
  const prev = new Map(input.queries.prev.map((r) => [r.keys[0] ?? "", r]));
  const cur = new Map(input.queries.cur.map((r) => [r.keys[0] ?? "", r]));
  const keys = new Set([...cur.keys(), ...prev.keys()]);
  const by: Record<"query_top3" | "query_top10", Candidate[]> = { query_top3: [], query_top10: [] };
  for (const key of [...keys].sort()) {
    if (input.isBranded(key)) continue;
    const c = cur.get(key);
    const p = prev.get(key);
    const shown = shortText(key, 100);
    const size = Math.abs((c?.position ?? UNSEEN_POSITION) - (p?.position ?? UNSEEN_POSITION));
    // The top-3 rule first; the top-10 rule only for queries it didn't catch.
    let caught = false;
    for (const [rule, line, label] of [["query_top3", 3.0, "top 3"], ["query_top10", 10.0, "top 10"]] as const) {
      if (caught) break;
      const entered = c && c.position <= line && (!p || p.position > line) && c.impressions >= WM.queryMinImpr;
      const left = p && p.position <= line && p.impressions >= WM.queryMinImpr && (!c || c.position > line);
      if (entered) {
        by[rule].push({ item: { kind: "win", rule, text: `"${shown}" moved into the ${label}`, metric: "position", current: c.position, previous: p ? p.position : null }, size, tie: key });
        caught = true;
      } else if (left) {
        by[rule].push({ item: { kind: "miss", rule, text: `"${shown}" dropped out of the ${label}`, metric: "position", current: c ? c.position : 0, previous: p.position }, size, tie: key });
        caught = true;
      }
    }
  }
  const all = [...sorted(by.query_top3), ...sorted(by.query_top10)];
  return { wins: all.filter((i) => i.kind === "win"), misses: all.filter((i) => i.kind === "miss") };
}

export function winsAndMisses(input: WinsMissesInput): Omit<WinsMissesData, "comparedWith"> {
  const { goals, skipped } = goalItems(input);
  const kpi = sorted(kpiItems(input));
  const pages = pageItems(input);
  const queries = queryItems(input);
  const side = (kind: "win" | "miss", rest: WinMissItem[]) => [...kpi.filter((i) => i.kind === kind), ...rest].slice(0, input.limit);
  return { goals, wins: side("win", [...pages.wins, ...queries.wins]), misses: side("miss", [...pages.misses, ...queries.misses]), skippedGoals: skipped };
}
