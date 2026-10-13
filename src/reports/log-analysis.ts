/**
 * log_analysis / crawlmark-cli logs (Phase 12 C2): read access logs on this
 * machine and summarise known bots. Logs never leave the machine and nothing
 * is written: the result holds aggregates only (bot names, paths without query
 * strings, statuses, days, counts), never IP addresses, user agents, referrers
 * or raw lines. Googlebot-family hits are checked against Google's published
 * crawler ranges (one public download a week); no reverse DNS.
 */
import { ipInRanges, parseIp, type Cidr } from "../analysis/cidr.js";
import { isPrivateHost } from "../lib/url-guard.js";
import { BOT_NAMES, BOTS, resolveBotNames } from "../analysis/bots.js";
import { LogAggregator, parseLogLine, type BotSummary, type LogFormat, type Verification } from "../analysis/logs.js";
import { DEFAULT_READ_CAPS, LogAccessError, readLogLines, type ReadCaps, type ReadState, type ResolvedLogFile } from "../lib/log-files.js";
import { stripControl } from "../lib/terminal-text.js";
import type { GoogleRanges } from "../providers/crawler-ipranges.js";

export interface LogAnalysisOptions {
  since?: string;
  until?: string;
  bots?: string[];
  /** Check Googlebot-family IPs against Google's published ranges (default true). false makes no network request at all. */
  verify?: boolean;
  caps?: ReadCaps;
  signal?: AbortSignal;
}

export interface LogAnalysisDeps {
  googleRanges(signal?: AbortSignal): Promise<GoogleRanges>;
}

export interface LogAnalysisResult {
  client: string;
  files: { name: string; lines: number; parsed: number; skipped: number; format: LogFormat | "unknown" }[];
  window: { start: string | null; end: string | null; since: string | null; until: string | null };
  totals: { hits: number; botHits: number; outsideWindow: number };
  verification: { method: "google-published-ranges"; available: boolean; files?: GoogleRanges["files"] } | { method: "off"; available: false };
  bots: BotSummary[];
  notes: string[];
}

/** Distinct addresses whose verification is remembered during one call (then discarded); past this, each hit is checked again. */
const VERIFY_MEMO = 200_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const dayStart = (d: string) => Date.parse(`${d}T00:00:00Z`);

export async function analyzeLogs(client: string, files: ResolvedLogFile[], o: LogAnalysisOptions, deps: LogAnalysisDeps, preNotes: string[] = []): Promise<LogAnalysisResult> {
  for (const d of [o.since, o.until]) if (d !== undefined && (!DAY.test(d) || Number.isNaN(dayStart(d)))) throw new Error(`Dates must be YYYY-MM-DD (got ${stripControl(d)}).`);
  if (o.since && o.until && o.since > o.until) throw new Error(`since (${o.since}) is after until (${o.until}).`);
  let botFilter: Set<string> | undefined;
  if (o.bots?.length) {
    const r = resolveBotNames(o.bots);
    if (r.unknown.length) throw new Error(`Unknown bot${r.unknown.length > 1 ? "s" : ""}: ${r.unknown.map((b) => stripControl(b).slice(0, 50)).join(", ")}. Known: ${BOT_NAMES.join(", ")}.`);
    botFilter = new Set(r.bots);
  }
  const notes = [...preNotes];
  const verifyOn = o.verify ?? true;

  // Google's ranges are needed only when a Google-verifiable bot can be in the result.
  let ranges: Cidr[] | null = null;
  let verification: LogAnalysisResult["verification"] = { method: "off", available: false };
  const wantsGoogle = !botFilter || BOTS.some((b) => b.googleVerifiable && botFilter!.has(b.bot));
  if (verifyOn && wantsGoogle) {
    try {
      const g = await deps.googleRanges(o.signal);
      ranges = g.ranges;
      verification = { method: "google-published-ranges", available: true, files: g.files };
    } catch (err) {
      o.signal?.throwIfAborted();
      verification = { method: "google-published-ranges", available: false };
      notes.push(`Google's crawler IP lists couldn't be read (${stripControl((err as Error).message).slice(0, 200)}), so Googlebot hits are counted as unknownVerification.`);
    }
  } else if (!verifyOn) notes.push("verify: false, so no hit was checked and no request was made.");

  const memo = new Map<string, { v: Verification; ip: boolean; priv: boolean }>();
  let addressedHits = 0; // Google-family hits whose address field is an IP
  let privateHits = 0;
  const verify = (ip: string): Verification => {
    let m = memo.get(ip);
    if (m === undefined) {
      // A hostname or "-" in the address field can't be checked: unknown, not "unverified".
      const isIp = parseIp(ip) !== null;
      m = { ip: isIp, priv: isIp && isPrivateHost(ip.replace(/^\[|\]$/g, "")), v: !isIp || !ranges ? "unknown" : ipInRanges(ip, ranges) ? "verified" : "unverified" };
      if (memo.size < VERIFY_MEMO) memo.set(ip, m);
    }
    if (m.ip) addressedHits++;
    if (m.priv) privateHits++;
    return m.v;
  };

  const agg = new LogAggregator({
    ...(o.since ? { since: dayStart(o.since) } : {}),
    ...(o.until ? { until: dayStart(o.until) + 86_400_000 } : {}),
    ...(botFilter ? { bots: botFilter } : {}),
    verify,
  });
  const caps = o.caps ?? DEFAULT_READ_CAPS;
  const state: ReadState = { bytes: 0, lines: 0, capped: null };
  const outFiles: LogAnalysisResult["files"] = [];
  for (const f of files) {
    o.signal?.throwIfAborted();
    if (state.capped) {
      outFiles.push({ name: f.name, lines: 0, parsed: 0, skipped: 0, format: "unknown" });
      continue;
    }
    let parsed = 0;
    let skipped = 0;
    let combined = 0;
    let common = 0;
    let r: { lines: number; tooLong: number };
    try {
      r = await readLogLines(
        f,
        (line) => {
          const p = parseLogLine(line);
          if (!p) {
            skipped++;
            return;
          }
          parsed++;
          if (p.format === "combined") combined++;
          else common++;
          agg.add(p.entry);
        },
        state,
        caps,
      );
    } catch (err) {
      if (err instanceof LogAccessError) {
        notes.push(stripControl(err.message).slice(0, 300));
        outFiles.push({ name: f.name, lines: 0, parsed: 0, skipped: 0, format: "unknown" });
        continue;
      }
      notes.push(`${f.name} couldn't be read completely (${stripControl((err as Error).message).slice(0, 200)}); its counts are partial.`);
      r = { lines: parsed + skipped, tooLong: 0 };
    }
    const format: LogFormat | "unknown" = parsed === 0 ? "unknown" : combined >= common ? "combined" : "common";
    if (format === "common") notes.push(`${f.name} is in the common format (no user agent), so its hits can't be attributed to bots.`);
    if (r.tooLong) notes.push(`${f.name}: ${r.tooLong} line${r.tooLong === 1 ? " was" : "s were"} longer than ${caps.maxLineChars.toLocaleString("en-US")} characters and skipped.`);
    outFiles.push({ name: f.name, lines: r.lines + r.tooLong, parsed, skipped: skipped + r.tooLong, format });
  }
  if (state.capped === "bytes") notes.push(`Stopped at the ${(caps.maxBytes / 1024 ** 3).toFixed(caps.maxBytes >= 1024 ** 3 ? 0 : 3)} GB read limit; later lines and files were not read.`);
  if (state.capped === "lines") notes.push(`Stopped at the ${caps.maxLines.toLocaleString("en-US")}-line limit; later lines and files were not read.`);
  const capped = agg.pathsCapped();
  if (capped.length) notes.push(`${capped.join(", ")} requested more than 20,000 distinct paths; the path lists cover the first 20,000.`);
  if (!botFilter || botFilter.has("Google-Extended")) notes.push("Google-Extended is a robots.txt token only: it never appears in logs (Google fetches with Googlebot).");
  notes.push("Logs were read on this machine and never uploaded. IP addresses, user agents and referrers are not returned or stored; paths are shown without query strings.");
  if (addressedHits > 0 && privateHits * 2 > addressedHits) {
    notes.push("Most Googlebot-family hits come from private or loopback addresses, so these logs are probably behind a reverse proxy or load balancer: log the real client address (e.g. X-Forwarded-For via real_ip / mod_remoteip) for verification to mean anything.");
  }
  if (ranges) notes.push("Googlebot, Google-InspectionTool and GoogleOther hits are verified against Google's published crawler IP ranges; other bots can't be verified this way (unknownVerification).");

  return {
    client,
    files: outFiles,
    window: { ...agg.window(), since: o.since ?? null, until: o.until ?? null },
    totals: { hits: agg.hits, botHits: agg.botHits, outsideWindow: agg.outsideWindow },
    verification,
    bots: agg.result(),
    notes: [...new Set(notes)],
  };
}
