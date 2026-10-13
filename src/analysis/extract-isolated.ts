import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { CrawlPageExtract } from "./crawl-parse.js";
import type { PageHygieneExtract, ParsedSitemap } from "./hygiene-parse.js";
import type { SeoExtract } from "./render-extract.js";

export const EXTRACT_TIMEOUT_MS = 10_000;
const MAX_OLD_GEN_MB = 256;

/**
 * Worker entry. Built output (dist/) has a sibling extract-worker.js and runs it
 * directly. From source (tsx, vitest) only the .ts exists, so the worker is started
 * with tsx's loader (`--import`), resolved from this package's own dependencies.
 */
function workerSpec(): { file: URL; execArgv: string[] } {
  const js = new URL("./extract-worker.js", import.meta.url);
  if (existsSync(js)) return { file: js, execArgv: [] };
  const tsxEntry = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  return { file: new URL("./extract-worker.ts", import.meta.url), execArgv: ["--import", tsxEntry] };
}

/** At most this many extraction workers run at once, so parallel render checks can't stack up heap. */
export const MAX_EXTRACT_WORKERS = 4;
let running = 0;
const waiting: (() => void)[] = [];

/** extractSeo in a worker thread with a hard timeout and heap limit. Rejects with a clear error on either. */
export async function extractIsolated(html: string, url: string, opts: { timeoutMs?: number } = {}): Promise<SeoExtract> {
  return runIsolated<SeoExtract>("seo", html, url, opts);
}

/** Sitemap XML parsed (cheerio, xml mode) in a worker with the same limits. */
export const parseSitemapIsolated = (xml: string, opts: { timeoutMs?: number } = {}) => runIsolated<ParsedSitemap>("sitemap", xml, "", opts);

/** JSON-LD blocks, hreflang, robots meta and canonical of a page, in a worker with the same limits. */
export const extractHygieneIsolated = (html: string, url: string, opts: { timeoutMs?: number } = {}) =>
  runIsolated<PageHygieneExtract>("hygiene", html, url, opts);

/** Title, description, canonical, robots meta, H1 count and links of a page for the local crawler, in a worker with the same limits. */
export const extractCrawlIsolated = (html: string, url: string, opts: { timeoutMs?: number } = {}) => runIsolated<CrawlPageExtract>("crawl", html, url, opts);

async function runIsolated<T>(kind: "seo" | "sitemap" | "hygiene" | "crawl", html: string, url: string, opts: { timeoutMs?: number }): Promise<T> {
  if (running >= MAX_EXTRACT_WORKERS) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await runWorker<T>(kind, html, url, opts);
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function runWorker<T>(kind: string, html: string, url: string, opts: { timeoutMs?: number }): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? EXTRACT_TIMEOUT_MS;
  const { file, execArgv } = workerSpec();
  return new Promise<T>((resolve, reject) => {
    const worker = new Worker(file, {
      workerData: { kind, html, url },
      execArgv,
      resourceLimits: { maxOldGenerationSizeMb: MAX_OLD_GEN_MB },
    });
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(
      () => done(() => reject(new Error(`HTML analysis timed out after ${timeoutMs / 1000}s (page is too complex to parse safely)`))),
      timeoutMs,
    );
    worker.once("message", (m: { ok: true; seo: T } | { ok: false; error: string }) =>
      done(() => (m.ok ? resolve(m.seo) : reject(new Error(m.error)))),
    );
    worker.once("error", (err: NodeJS.ErrnoException) =>
      done(() =>
        reject(new Error(err.code === "ERR_WORKER_OUT_OF_MEMORY" ? "HTML analysis ran out of memory (page is too complex to parse safely)" : `HTML analysis failed: ${err.message}`)),
      ),
    );
    worker.once("exit", (code) => done(() => reject(new Error(`HTML analysis worker exited unexpectedly (code ${code})`))));
  });
}
