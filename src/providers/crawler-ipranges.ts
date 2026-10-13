/**
 * Google's published crawler IP ranges (Phase 12 C2, research G1):
 * common-crawlers.json (Googlebot) and special-crawlers.json, fetched at most
 * once a week (cache table, TTL.week) from CRAWLER_IPRANGES_BASE_URL. The request
 * carries nothing about the user or their logs: a plain GET of a public file.
 * Only the public ranges are cached; no log data is ever stored.
 */
import { z } from "zod";
import { env } from "../config.js";
import { parseCidr, type Cidr } from "../analysis/cidr.js";
import { cached, cacheKey, TTL } from "../lib/cache.js";

export const GOOGLE_RANGE_FILES = ["common-crawlers.json", "special-crawlers.json"] as const;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_PREFIXES = 20_000;
const MAX_BYTES = 2 * 1024 * 1024;

const RangeFile = z.object({
  creationTime: z.string().optional(),
  prefixes: z.array(z.object({ ipv4Prefix: z.string().max(64).optional(), ipv6Prefix: z.string().max(64).optional() })).max(MAX_PREFIXES),
});

export type FetchFn = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; body: ReadableStream<Uint8Array> | null }>;

/** Read a response body up to `max` bytes, streaming; throws (and cancels) as soon as it is larger. */
export async function readBodyCapped(body: ReadableStream<Uint8Array> | null, max: number, what: string): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`${what} is larger than expected (over ${Math.round(max / 1024 / 1024)} MB)`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface GoogleRanges {
  ranges: Cidr[];
  /** Each file's creationTime, when the file gave one. */
  files: { file: string; prefixes: number; creationTime: string | null }[];
  fromCache: boolean;
}

/** The prefix strings of one file, validated. Pure. */
export function parseRangeFile(text: string): { prefixes: string[]; creationTime: string | null } {
  const parsed = RangeFile.parse(JSON.parse(text));
  const prefixes = parsed.prefixes.flatMap((p) => [p.ipv4Prefix, p.ipv6Prefix].filter((x): x is string => typeof x === "string" && parseCidr(x) !== null));
  return { prefixes, creationTime: parsed.creationTime ?? null };
}

/** Both files' ranges; throws when a file can't be fetched or parsed (the caller then reports hits as unknownVerification). */
export async function googleCrawlerRanges(opts: { fetchFn?: FetchFn; baseUrl?: string; signal?: AbortSignal } = {}): Promise<GoogleRanges> {
  const base = (opts.baseUrl ?? env.CRAWLER_IPRANGES_BASE_URL).replace(/\/+$/, "");
  const fetchFn: FetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
  let fromCache = true;
  const files: GoogleRanges["files"] = [];
  const ranges: Cidr[] = [];
  for (const file of GOOGLE_RANGE_FILES) {
    const url = `${base}/${file}`;
    const r = await cached(cacheKey("crawler-ipranges", url), TTL.week, async () => {
      const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) : AbortSignal.timeout(FETCH_TIMEOUT_MS);
      const res = await fetchFn(url, { signal, headers: { accept: "application/json" } });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new Error(`Google's crawler IP list ${file} returned HTTP ${res.status}`);
      }
      return parseRangeFile(await readBodyCapped(res.body, MAX_BYTES, `Google's crawler IP list ${file}`));
    });
    if (!r.fromCache) fromCache = false;
    files.push({ file, prefixes: r.value.prefixes.length, creationTime: r.value.creationTime });
    for (const p of r.value.prefixes) {
      const c = parseCidr(p);
      if (c) ranges.push(c);
    }
  }
  return { ranges, files, fromCache };
}
