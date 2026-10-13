/**
 * Records raw DataForSEO SANDBOX responses for the shaped endpoints.
 * Usage: npx tsx scripts/record-fixtures.ts <out-dir> [only]
 * `only` records just the fixtures whose file name contains it (e.g. `serp`).
 * Writes unscrubbed responses: scrub them before committing anything.
 * Refuses to run unless DATAFORSEO_BASE_URL is the sandbox. Never prints credentials.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));

const base = process.env.DATAFORSEO_BASE_URL ?? "";
if (base !== "https://sandbox.dataforseo.com/v3") {
  console.error("Refusing to record: DATAFORSEO_BASE_URL must be https://sandbox.dataforseo.com/v3");
  process.exit(1);
}
const { DATAFORSEO_LOGIN: login, DATAFORSEO_PASSWORD: password } = process.env;
if (!login || !password) {
  console.error("DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not set in .env");
  process.exit(1);
}
const outDir = resolve(process.argv[2] ?? "./recordings");
mkdirSync(outDir, { recursive: true });

const geo = { location_code: 2840, language_code: "en" };
const target = "example.com";
const calls: [file: string, path: string, body: unknown][] = [
  [
    "dataforseo_labs_google_ranked_keywords_live",
    "/dataforseo_labs/google/ranked_keywords/live",
    [{ target, limit: 10, item_types: ["organic"], ...geo, order_by: ["keyword_data.keyword_info.search_volume,desc"] }],
  ],
  [
    "dataforseo_labs_google_competitors_domain_live",
    "/dataforseo_labs/google/competitors_domain/live",
    [{ target, limit: 10, item_types: ["organic"], ...geo }],
  ],
  ["backlinks_summary_live", "/backlinks/summary/live", [{ target, internal_list_limit: 10, include_subdomains: true }]],
  ["on_page_instant_pages", "/on_page/instant_pages", [{ url: `https://${target}/`, enable_javascript: true }]],
  [
    // Same body suggest_competitors sends for a client with an `area`.
    "serp_google_organic_live_regular",
    "/serp/google/organic/live/regular",
    [{ keyword: "example keyword", depth: 20, location_name: "Austin,Texas,United States", language_code: "en" }],
  ],
];
const only = process.argv[3];

for (const [file, path, body] of calls) {
  if (only && !file.includes(only)) continue;
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${login}:${password}`).toString("base64"), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.error(`${path} -> HTTP ${res.status}`);
  if (res.ok) writeFileSync(join(outDir, `${file}.json`), text);
}
