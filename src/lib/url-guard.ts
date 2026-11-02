import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { cliHint } from "./cli-hint.js";

/**
 * Guard for user-supplied URLs and every outbound connection the browser checks make.
 * - `assertSafeUrl`: scheme allowlist plus a check of literal hosts (sync, no DNS).
 * - `assertSafeUrlResolved` / `resolvePublic`: also resolve the hostname and refuse it
 *   when any A/AAAA record is private, loopback or link-local. Callers then connect to
 *   the vetted addresses only (`pinnedLookup`), so DNS rebinding cannot swap them.
 * - `assertOnClientDomain`: the RESTRICT_TO_CLIENT_DOMAINS allowlist (pure).
 */

/** A URL or host was refused by the guard. Its own class so usage stats can count refusals. */
export class UrlRefusedError extends Error {
  override name = "UrlRefusedError";
}

export function privateUrlsAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return (env.ALLOW_PRIVATE_URLS ?? "").trim().toLowerCase() === "true";
}

function ipv4Private(a: number, b: number, c: number): boolean {
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) || // 192.0.0.0/24 IETF protocol assignments
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Expand an IPv6 literal (no brackets) to 8 numeric groups, or null if malformed. */
function ipv6Groups(h: string): number[] | null {
  let s = h;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    s = s.slice(0, dotted.index) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (x: string) => (x === "" ? [] : x.split(":"));
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  const nums = all.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.length === 8 && nums.every((n) => !Number.isNaN(n)) ? nums : null;
}

const v4From = (hi: number, lo: number) => ipv4Private(hi >> 8, hi & 255, lo >> 8);

function ipv6Private(g: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  const zeroTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroTo(7) && (g7 === 0 || g7 === 1)) return true; // :: and ::1
  if (zeroTo(5) && g5 === 0) return v4From(g6, g7); // ::x:y (IPv4-compatible)
  if (zeroTo(5) && g5 === 0xffff) return v4From(g6, g7); // IPv4-mapped
  if (zeroTo(4) && g4 === 0xffff && g5 === 0) return true; // ::ffff:0:0/96 SIIT IPv4-translated
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return v4From(g6, g7); // NAT64
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true; // 64:ff9b:1::/48 NAT64 local-use
  if (g0 === 0x2002) return v4From(g1, g2); // 6to4
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/** True when `host` (as URL.hostname gives it) is a loopback, private or link-local literal. */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) return ipv4Private(Number(v4[1]), Number(v4[2]), Number(v4[3]));

  if (h.includes(":")) {
    const g = ipv6Groups(h);
    return g ? ipv6Private(g) : true; // malformed literal: refuse
  }
  return false;
}

/** Parse and validate a URL; throws a readable error when it is not allowed. Returns the parsed URL. */
export function assertSafeUrl(raw: string, env: Record<string, string | undefined> = process.env): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UrlRefusedError(`Not a valid URL: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new UrlRefusedError(`Only http and https URLs are allowed (got ${u.protocol})`);
  }
  if (!privateUrlsAllowed(env) && isPrivateHost(u.hostname)) {
    throw new UrlRefusedError(`Refusing to fetch a private or loopback address (${u.hostname}). Set ALLOW_PRIVATE_URLS=true for local development.`);
  }
  return u;
}

// ------------------------------------------------------------ DNS-resolving guard

/** Resolve a host to all of its addresses. Injectable so tests can fake DNS. */
export type LookupFn = (host: string) => Promise<LookupAddress[]>;

export const systemLookup: LookupFn = (host) => dnsLookup(host, { all: true });

const bare = (host: string) => host.replace(/^\[|\]$/g, "");

/**
 * Resolve `host` (A and AAAA) and refuse it when it is a private literal, a localhost
 * name, or when ANY resolved address is private, loopback, link-local or otherwise
 * internal. Returns the vetted addresses; connect to these and nothing else.
 */
export async function resolvePublic(
  host: string,
  opts: { allowPrivate?: boolean; lookup?: LookupFn } = {},
): Promise<LookupAddress[]> {
  const h = bare(host);
  const allowPrivate = opts.allowPrivate ?? privateUrlsAllowed();
  if (!allowPrivate && isPrivateHost(h)) {
    throw new UrlRefusedError(`Refusing to connect to a private or loopback address (${h}). Set ALLOW_PRIVATE_URLS=true for local development.`);
  }
  // Unresolvable and private get the same message, so the error never reveals internal addresses
  // or whether a name exists internally. The detail goes to stderr only.
  const refuse = (detail: string) => {
    console.error(`crawlmark: refused ${h}: ${detail}`);
    return new UrlRefusedError(
      `Refusing ${h}: it does not resolve to a public address. Set ALLOW_PRIVATE_URLS=true for local development.`,
    );
  };
  let addresses: LookupAddress[];
  try {
    addresses = await (opts.lookup ?? systemLookup)(h);
  } catch (err) {
    throw refuse(`lookup failed (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`);
  }
  if (!addresses.length) throw refuse("no addresses");
  if (!allowPrivate) {
    const bad = addresses.find((a) => isPrivateHost(a.address));
    if (bad) throw refuse(`resolves to private or loopback address ${bad.address}`);
  }
  return addresses;
}

/** `assertSafeUrl` plus DNS: every A/AAAA record of the hostname must be public. */
export async function assertSafeUrlResolved(
  raw: string,
  opts: { env?: Record<string, string | undefined>; lookup?: LookupFn } = {},
): Promise<{ url: URL; addresses: LookupAddress[] }> {
  const env = opts.env ?? process.env;
  const url = assertSafeUrl(raw, env);
  const addresses = await resolvePublic(url.hostname, { allowPrivate: privateUrlsAllowed(env), lookup: opts.lookup });
  return { url, addresses };
}

type NetLookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * A `lookup` for node:net / node:http that only ever returns the given, already vetted
 * addresses. Pins the connection to what the guard checked, so a second DNS answer
 * (rebinding) is never used.
 */
export function pinnedLookup(addresses: LookupAddress[]) {
  return (_host: string, options: { all?: boolean } | number | undefined, cb: NetLookupCallback): void => {
    const all = typeof options === "object" && options?.all;
    if (all) return cb(null, addresses);
    const first = addresses[0]!;
    cb(null, first.address, first.family);
  };
}

// ------------------------------------------------------- client-domain allowlist

/**
 * RESTRICT_TO_CLIENT_DOMAINS: true/1/yes turns it on; empty/false/0/no leaves it off.
 * Any other value throws, so a typo fails closed instead of silently allowing everything.
 */
export function restrictToClientDomains(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.RESTRICT_TO_CLIENT_DOMAINS ?? "").trim().toLowerCase();
  if (v === "" || v === "false" || v === "0" || v === "no") return false;
  if (v === "true" || v === "1" || v === "yes") return true;
  throw new UrlRefusedError(`RESTRICT_TO_CLIENT_DOMAINS must be true or false (got "${env.RESTRICT_TO_CLIENT_DOMAINS}")`);
}

/** True when `host` is one of `domains` or a subdomain of one. Case, brackets and trailing dots are ignored. */
export function hostInDomains(host: string, domains: string[]): boolean {
  const h = bare(host).toLowerCase().replace(/\.+$/, "");
  return domains.some((d) => {
    const dd = d.toLowerCase().replace(/\.+$/, "");
    return dd !== "" && (h === dd || h.endsWith(`.${dd}`));
  });
}

/** Throw unless `host` is on a client domain (or a subdomain of one). */
export function assertOnClientDomain(host: string, domains: string[]): void {
  if (!hostInDomains(host, domains)) {
    throw new UrlRefusedError(
      `Refusing ${bare(host)}: RESTRICT_TO_CLIENT_DOMAINS=true and it is not a client domain or a subdomain of one. Add the client with \`${cliHint()} clients add\`.`,
    );
  }
}
