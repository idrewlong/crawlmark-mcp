/**
 * IPv4 and IPv6 CIDR matching (Phase 12 C2: checking crawler IPs against Google's
 * published ranges). Pure; addresses are parsed to bigints, so v4 and v6 share one
 * code path. IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) match IPv4 ranges.
 */
export interface Cidr {
  v: 4 | 6;
  base: bigint;
  mask: bigint;
}

function parseV4(s: string): bigint | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  let n = 0n;
  for (const part of m.slice(1)) {
    const x = Number(part);
    if (x > 255 || (part.length > 1 && part.startsWith("0"))) return null;
    n = (n << 8n) | BigInt(x);
  }
  return n;
}

function parseV6(raw: string): bigint | null {
  let s = raw.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (!s.includes(":")) return null;
  // A trailing dotted IPv4 part (::ffff:1.2.3.4) becomes two groups.
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (dotted) {
    const v4 = parseV4(dotted[1]!);
    if (v4 === null) return null;
    s = s.slice(0, dotted.index) + ((v4 >> 16n) & 0xffffn).toString(16) + ":" + (v4 & 0xffffn).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (x: string) => (x === "" ? [] : x.split(":"));
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

/** Parse an IP address; IPv4-mapped IPv6 is returned as IPv4. Null when malformed. */
export function parseIp(raw: string): { v: 4 | 6; n: bigint } | null {
  const s = raw.trim();
  const v4 = parseV4(s);
  if (v4 !== null) return { v: 4, n: v4 };
  const v6 = parseV6(s);
  if (v6 === null) return null;
  if (v6 >> 32n === 0xffffn) return { v: 4, n: v6 & 0xffffffffn };
  return { v: 6, n: v6 };
}

/** Parse "a.b.c.d/n" or "x::/n". Null when malformed. */
export function parseCidr(raw: string): Cidr | null {
  const [addr, len, extra] = raw.trim().split("/");
  if (extra !== undefined || addr === undefined) return null;
  const v4 = parseV4(addr);
  const v6 = v4 === null ? parseV6(addr) : null;
  if (v4 === null && v6 === null) return null;
  const v: 4 | 6 = v4 !== null ? 4 : 6;
  const bits = v === 4 ? 32 : 128;
  const prefix = len === undefined ? bits : /^\d{1,3}$/.test(len) ? Number(len) : NaN;
  if (!(prefix >= 0 && prefix <= bits)) return null;
  const all = (1n << BigInt(bits)) - 1n;
  const mask = prefix === 0 ? 0n : (all << BigInt(bits - prefix)) & all;
  return { v, base: (v4 ?? v6!) & mask, mask };
}

/** True when the address is inside any of the ranges. */
export function ipInRanges(ip: string, ranges: readonly Cidr[]): boolean {
  const a = parseIp(ip);
  if (!a) return false;
  for (const r of ranges) if (r.v === a.v && (a.n & r.mask) === r.base) return true;
  return false;
}
