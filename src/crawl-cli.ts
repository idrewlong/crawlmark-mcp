/**
 * `crawlmark-cli crawl` (Phase 12 C1): the free local crawl for one client, as the
 * local_crawl tool runs it. JSON on stdout, a one-line summary on stderr.
 * Exit 0 crawled and saved, 1 usage error or failure. Dependencies are injected for tests.
 */
import type { Client } from "./config.js";
import { CRAWL_LIMITS, inCrawlScope } from "./providers/crawler.js";
import type { LocalCrawlOptions, LocalCrawlResult } from "./reports/local-crawl.js";

export interface CrawlCliFlags {
  client?: string | undefined;
  "max-pages"?: string | undefined;
  "max-depth"?: string | undefined;
  concurrency?: string | undefined;
  "user-agent"?: string | undefined;
  "include-subdomains"?: boolean | undefined;
  "start-url"?: string | undefined;
}

export interface CrawlCliIo {
  out(line: string): void;
  warn(line: string): void;
  /** Prints the usage problem and the group help; returns the exit code (1). */
  usage(problem: string): number;
}

export interface CrawlCliDeps {
  resolveClient(input: string): Promise<Client>;
  run(client: Client, opts: LocalCrawlOptions): Promise<LocalCrawlResult>;
}

function intFlag(name: string, raw: string | undefined, l: { min: number; max: number }): number | undefined | string {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw.trim())) return `--${name} must be a whole number from ${l.min} to ${l.max}.`;
  const n = Number(raw);
  return n < l.min || n > l.max ? `--${name} must be from ${l.min} to ${l.max}.` : n;
}

const duration = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};

export async function crawlCommand(args: string[], values: CrawlCliFlags, io: CrawlCliIo, deps: CrawlCliDeps): Promise<number> {
  if (args.length) return io.usage(`crawl takes only flags, got: ${args.join(" ")}`);
  if (!values.client) return io.usage("crawl needs --client <domain|slug>.");
  const maxPages = intFlag("max-pages", values["max-pages"], CRAWL_LIMITS.maxPages);
  const maxDepth = intFlag("max-depth", values["max-depth"], CRAWL_LIMITS.maxDepth);
  const concurrency = intFlag("concurrency", values.concurrency, CRAWL_LIMITS.concurrency);
  for (const v of [maxPages, maxDepth, concurrency]) if (typeof v === "string") return io.usage(v);
  const ua = values["user-agent"];
  if (ua !== undefined && ua !== "crawlmark" && ua !== "googlebot") return io.usage("--user-agent must be crawlmark or googlebot.");
  let startUrls: string[] | undefined;
  if (values["start-url"] !== undefined) {
    startUrls = values["start-url"].split(",").map((u) => u.trim()).filter(Boolean);
    if (!startUrls.length || startUrls.length > 50) return io.usage("--start-url needs 1 to 50 comma-separated URLs.");
    for (const u of startUrls) {
      try {
        const x = new URL(u);
        if (x.protocol !== "http:" && x.protocol !== "https:") throw new Error();
      } catch {
        return io.usage(`--start-url: not an http(s) URL: ${u}`);
      }
    }
  }

  let client: Client;
  try {
    client = await deps.resolveClient(values.client);
  } catch (err) {
    io.warn(`Error: ${(err as Error).message}`);
    return 1;
  }
  // Like the local_crawl tool: a start URL off the client's host is refused, not silently dropped.
  for (const u of startUrls ?? []) {
    if (!inCrawlScope(u, client.domain, values["include-subdomains"] ?? false, "any")) {
      return io.usage(`--start-url ${u} is not on ${client.domain}${values["include-subdomains"] ? " or its subdomains" : ""}.`);
    }
  }
  try {
    const r = await deps.run(client, {
      ...(typeof maxPages === "number" ? { maxPages } : {}),
      ...(typeof maxDepth === "number" ? { maxDepth } : {}),
      ...(typeof concurrency === "number" ? { concurrency } : {}),
      ...(ua ? { userAgent: ua } : {}),
      ...(values["include-subdomains"] ? { includeSubdomains: true } : {}),
      ...(startUrls ? { startUrls } : {}),
    });
    io.out(JSON.stringify({ command: "crawl", ...r }, null, 2));
    const s = r.summary;
    io.warn(
      `Crawled ${s.fetched} page${s.fetched === 1 ? "" : "s"} in ${duration(r.durationMs)} (exhaustive: ${r.exhaustive ? "yes" : `no${r.stoppedBy ? `, stopped by ${r.stoppedBy}` : ""}`}). ` +
        `${s.brokenLinks} broken internal link${s.brokenLinks === 1 ? "" : "s"}, ${s.duplicateTitles} duplicate titles, ` +
        (s.orphans.available ? `${s.orphans.count} orphan page${s.orphans.count === 1 ? "" : "s"}.` : "orphans not judged.") +
        ` Saved as ${r.crawlId}.`,
    );
    return 0;
  } catch (err) {
    io.warn(`Error: ${(err as Error).message}`);
    return 1;
  }
}
