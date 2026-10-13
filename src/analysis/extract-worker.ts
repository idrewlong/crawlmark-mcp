import { parentPort, workerData } from "node:worker_threads";
import { extractSeo } from "./render-extract.js";

// Runs extractSeo off the main thread so hostile markup can only burn this worker's time and memory.
const { html, url } = workerData as { html: string; url: string };
try {
  parentPort!.postMessage({ ok: true, seo: extractSeo(html, url) });
} catch (err) {
  parentPort!.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
}
