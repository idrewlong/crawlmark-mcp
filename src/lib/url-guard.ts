/**
 * Guard for user-supplied URLs. Phase 4 version: scheme allowlist plus a check of
 * literal IP hosts (no DNS resolution yet, so a hostname that resolves to a private
 * address is not caught). Phase 6d extends this with hostname resolution and
 * RESTRICT_TO_CLIENT_DOMAINS. Pure apart from reading the env.
 */

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
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return v4From(g6, g7); // NAT64
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
    throw new Error(`Not a valid URL: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`Only http and https URLs are allowed (got ${u.protocol})`);
  }
  if (!privateUrlsAllowed(env) && isPrivateHost(u.hostname)) {
    throw new Error(`Refusing to fetch a private or loopback address (${u.hostname}). Set ALLOW_PRIVATE_URLS=true for local development.`);
  }
  return u;
}
