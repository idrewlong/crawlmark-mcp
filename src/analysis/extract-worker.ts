import { parentPort, workerData } from "node:worker_threads";
import { extractCrawlPage } from "./crawl-parse.js";
import { extractPageHygiene, parseSitemapXml } from "./hygiene-parse.js";
import { extractSeo } from "./render-extract.js";

// Runs the parsers off the main thread so hostile markup can only burn this worker's time and memory.
const task = workerData as { kind?: "seo" | "sitemap" | "hygiene" | "crawl"; html: string; url: string };
try {
  const out =
    task.kind === "sitemap"
      ? parseSitemapXml(task.html)
      : task.kind === "hygiene"
        ? extractPageHygiene(task.html, task.url)
        : task.kind === "crawl"
          ? extractCrawlPage(task.html, task.url)
          : extractSeo(task.html, task.url);
  parentPort!.postMessage({ ok: true, seo: out });
} catch (err) {
  parentPort!.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
}
