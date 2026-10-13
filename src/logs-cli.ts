/**
 * `crawlmark-cli logs` (Phase 12 C2): log_analysis on files the user names in the
 * terminal (no LOG_DIRS needed: the user typed the paths). JSON on stdout, a short
 * summary on stderr. Exit 0 analysed, 1 usage error or failure. Logs are read
 * locally and never uploaded; the output has no IPs or user agents.
 */
import type { Client } from "./config.js";
import { resolveCliLogFiles, type ResolvedLogFile } from "./lib/log-files.js";
import type { LogAnalysisOptions, LogAnalysisResult } from "./reports/log-analysis.js";

export interface LogsCliFlags {
  client?: string | undefined;
  since?: string | undefined;
  until?: string | undefined;
  bots?: string | undefined;
  "no-verify"?: boolean | undefined;
}

export interface LogsCliIo {
  out(line: string): void;
  warn(line: string): void;
  usage(problem: string): number;
}

export interface LogsCliDeps {
  resolveClient(input: string): Promise<Client>;
  analyze(client: Client, files: ResolvedLogFile[], opts: LogAnalysisOptions): Promise<LogAnalysisResult>;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function logsCommand(args: string[], values: LogsCliFlags, io: LogsCliIo, deps: LogsCliDeps): Promise<number> {
  if (!values.client) return io.usage("logs needs --client <domain|slug>.");
  if (!args.length) return io.usage("logs needs at least one log file path.");
  if (args.length > 50) return io.usage("logs reads at most 50 files at once.");
  for (const [k, v] of [["since", values.since], ["until", values.until]] as const) if (v !== undefined && !DAY.test(v)) return io.usage(`--${k} must be YYYY-MM-DD.`);
  const bots = values.bots?.split(",").map((b) => b.trim()).filter(Boolean);
  if (values.bots !== undefined && !bots?.length) return io.usage("--bots needs at least one bot name.");
  try {
    const client = await deps.resolveClient(values.client);
    const files = await resolveCliLogFiles(args);
    const r = await deps.analyze(client, files, {
      ...(values.since ? { since: values.since } : {}),
      ...(values.until ? { until: values.until } : {}),
      ...(bots ? { bots } : {}),
      ...(values["no-verify"] ? { verify: false } : {}),
    });
    io.out(JSON.stringify({ command: "logs", ...r }, null, 2));
    const fmt = (n: number) => n.toLocaleString("en-US");
    const lines = r.bots.slice(0, 6).map((b) => `${b.bot}${b.verified + b.unverified > 0 ? ` (${fmt(b.verified)} verified, ${fmt(b.unverified)} not)` : ""}: ${fmt(b.hits)} hits, ${b.byStatus["4xx"] ? `${((b.byStatus["4xx"] / b.hits) * 100).toFixed(1)}% 4xx` : "no 4xx"}`);
    io.warn(`${fmt(r.totals.hits)} requests, ${fmt(r.totals.botHits)} from known bots${r.window.start ? ` (${r.window.start.slice(0, 10)} to ${r.window.end!.slice(0, 10)})` : ""}.${lines.length ? ` ${lines.join("; ")}.` : ""}`);
    return 0;
  } catch (err) {
    io.warn(`Error: ${(err as Error).message}`);
    return 1;
  }
}
