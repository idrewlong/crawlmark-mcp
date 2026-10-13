import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  ADMIN_API_DISABLED_WARNING,
  assembleRegistry,
  findClient,
  ga4PropertiesFromSummaries,
  gscSitesFromResponse,
  isAdminApiDisabled,
  joinDiscovered,
  mergeClients,
  missingPieces,
  normalizeHost,
  parseOverrides,
  planSync,
  toHomepageUrl,
  unknownClientMessage,
  webStreamUrisFromResponse,
  type Client,
  type ClientDefaults,
  type DiscoveryOutcome,
  type Ga4Property,
} from "../src/lib/clients.js";
import { mapLimit } from "../src/lib/concurrency.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (p: string) => JSON.parse(readFileSync(join(here, "fixtures/google", p), "utf8"));
const root = join(here, "..");

const DEFAULTS: ClientDefaults = { locationCode: 2840, languageCode: "en", monthlyBudgetUsd: 5 };

/** Discovery input built from the fixtures exactly as the provider builds it. */
function fixtureDiscovery() {
  const sites = gscSitesFromResponse(fixture("sites-list.json"));
  const properties: Ga4Property[] = ga4PropertiesFromSummaries(fixture("account-summaries.json")).map((p) => ({
    ...p,
    webStreamUris: webStreamUrisFromResponse(fixture(`data-streams/${p.propertyId}.json`)),
  }));
  return { sites, properties };
}

const byDomain = <T extends { domain: string }>(clients: T[], d: string): T | undefined => clients.find((c) => c.domain === d);

describe("normalizeHost", () => {
  it.each([
    ["example.com", "example.com"],
    ["Example.COM", "example.com"],
    ["www.example.com", "example.com"],
    ["sc-domain:example.com", "example.com"],
    ["https://www.example.com/", "example.com"],
    ["http://example.com:8080/path?q=1#x", "example.com"],
    ["https://user:pw@www.example.com/a", "example.com"],
    ["  https://WWW.Example.com  ", "example.com"],
    ["example.com.", "example.com"],
    ["shop.example.com", "shop.example.com"],
    ["https://www.shop.example.com/", "shop.example.com"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeHost(input)).toBe(expected);
  });

  it("returns undefined for empty or non-host input", () => {
    expect(normalizeHost("")).toBeUndefined();
    expect(normalizeHost("   ")).toBeUndefined();
    expect(normalizeHost("https://")).toBeUndefined();
    expect(normalizeHost("not a host")).toBeUndefined();
  });

  it("converts internationalised domains to punycode", () => {
    expect(normalizeHost("bücher.example")).toBe("xn--bcher-kva.example");
    expect(normalizeHost("https://www.BÜCHER.example/")).toBe("xn--bcher-kva.example");
    expect(normalizeHost("sc-domain:xn--bcher-kva.example")).toBe("xn--bcher-kva.example");
  });

  it("only strips one leading www.", () => {
    expect(normalizeHost("www.www.example.com")).toBe("www.example.com");
    expect(normalizeHost("wwwexample.com")).toBe("wwwexample.com");
  });
});

describe("toHomepageUrl", () => {
  it("adds a scheme and trailing slash, rejects junk", () => {
    expect(toHomepageUrl("https://example.net")).toBe("https://example.net/");
    expect(toHomepageUrl("www.example.net")).toBe("https://www.example.net/");
    expect(toHomepageUrl("ftp://example.net")).toBeUndefined();
    expect(toHomepageUrl("https://")).toBeUndefined();
  });
});

describe("response mappers", () => {
  it("read the real response shapes", () => {
    const { sites, properties } = fixtureDiscovery();
    expect(sites).toHaveLength(6);
    expect(sites[1]).toEqual({ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" });
    expect(properties.map((p) => p.propertyId)).toEqual(["300000002", "99999999", "200000001", "400000001"]);
    expect(properties.find((p) => p.propertyId === "400000001")!.webStreamUris).toEqual([]);
  });

  it("tolerate empty responses", () => {
    expect(gscSitesFromResponse({})).toEqual([]);
    expect(ga4PropertiesFromSummaries({ accountSummaries: [{}] })).toEqual([]);
    expect(
      ga4PropertiesFromSummaries({
        accountSummaries: [{ propertySummaries: [{ property: "properties/7", displayName: " Padded  " }, { property: "properties/8", displayName: "  " }] }],
      }),
    ).toEqual([
      { propertyId: "7", displayName: "Padded" },
      { propertyId: "8", displayName: "8" },
    ]);
    expect(webStreamUrisFromResponse({})).toEqual([]);
  });
});

describe("joinDiscovered", () => {
  const { sites, properties } = fixtureDiscovery();
  const { clients, notes } = joinDiscovered(sites, properties);

  it("joins GSC and GA4 on the host, sorted by domain", () => {
    expect(clients.map((c) => c.domain)).toEqual(["example.com", "example.net", "example.org", "shop.example.com"]);
  });

  it("prefers the sc-domain property over a URL-prefix one and records the alternate", () => {
    const c = byDomain(clients, "example.com")!;
    expect(c.gscProperty).toBe("sc-domain:example.com");
    expect(c.gscAlternates).toEqual(["https://www.example.com/"]);
  });

  it("prefers https among URL-prefix properties", () => {
    const c = byDomain(clients, "example.org")!;
    expect(c.gscProperty).toBe("https://example.org/");
    expect(c.gscAlternates).toEqual(["http://example.org/"]);
    expect(c.ga4PropertyId).toBeUndefined();
  });

  it("picks the lowest GA4 property ID numerically and records the rest as alternates", () => {
    const c = byDomain(clients, "example.com")!;
    expect(c.ga4PropertyId).toBe("99999999");
    expect(c.ga4DisplayName).toBe("Example Co");
    expect(c.homepage).toBe("https://www.example.com/");
    expect(c.ga4Alternates).toEqual([{ propertyId: "300000002", displayName: "Example Co (old)" }]);
  });

  it("keeps GA4-only and GSC-only hosts", () => {
    const net = byDomain(clients, "example.net")!;
    expect(net.gscProperty).toBeUndefined();
    expect(net.ga4PropertyId).toBe("200000001");
    expect(net.homepage).toBe("https://example.net/");
    expect(byDomain(clients, "shop.example.com")!.gscProperty).toBe("https://shop.example.com/");
  });

  it("skips unverified sites and GA4 properties without a web stream, with notes", () => {
    expect(byDomain(clients, "example.edu")).toBeUndefined();
    expect(notes).toEqual([
      "Search Console site https://example.edu/ is unverified for this account; skipped.",
      "GA4 property 400000001 (Example App) has no web data stream with a URL; skipped.",
    ]);
  });

  it("is deterministic regardless of input order", () => {
    const reversed = joinDiscovered([...sites].reverse(), [...properties].reverse());
    expect(reversed.clients).toEqual(clients);
  });

  it("joins an IDN Search Console property with its Unicode GA4 stream", () => {
    const r = joinDiscovered(
      [{ siteUrl: "sc-domain:xn--bcher-kva.example", permissionLevel: "siteOwner" }],
      [{ propertyId: "9", displayName: "Bücher", webStreamUris: ["https://bücher.example"] }],
    );
    expect(r.clients).toHaveLength(1);
    expect(r.clients[0]).toMatchObject({
      domain: "xn--bcher-kva.example",
      gscProperty: "sc-domain:xn--bcher-kva.example",
      ga4PropertyId: "9",
    });
  });

  it("ranks root-path URL-prefix properties before path-scoped ones, then https, then shorter", () => {
    const r = joinDiscovered(
      [
        { siteUrl: "https://example.org/blog/" },
        { siteUrl: "http://example.org/" },
        { siteUrl: "https://www.example.org/" },
        { siteUrl: "https://example.org/" },
      ],
      [],
    );
    expect(r.clients[0]!.gscProperty).toBe("https://example.org/");
    expect(r.clients[0]!.gscAlternates).toEqual(["https://www.example.org/", "http://example.org/", "https://example.org/blog/"]);
    const noRootHttps = joinDiscovered([{ siteUrl: "https://example.org/blog/" }, { siteUrl: "http://example.org/" }], []);
    expect(noRootHttps.clients[0]!.gscProperty).toBe("http://example.org/");
  });

  it("maps a property whose streams cover several hosts to each host", () => {
    const r = joinDiscovered([], [
      { propertyId: "5", displayName: "Multi", webStreamUris: ["https://example.com/", "https://www.example.org"] },
    ]);
    expect(r.clients.map((c) => [c.domain, c.ga4PropertyId])).toEqual([
      ["example.com", "5"],
      ["example.org", "5"],
    ]);
  });
});

describe("parseOverrides", () => {
  it("accepts the shipped example file", () => {
    const raw = parseYaml(readFileSync(join(root, "config/clients.example.yaml"), "utf8"));
    const overrides = parseOverrides(raw);
    expect(overrides.length).toBeGreaterThan(0);
    for (const o of overrides) expect(normalizeHost(o.domain)).toBe(o.domain);
  });

  it("accepts a fully specified legacy entry", () => {
    const [o] = parseOverrides({
      clients: {
        "manual-client": {
          name: "Manual Client",
          domain: "www.manual.example",
          gscProperty: "sc-domain:manual.example",
          ga4PropertyId: "123456789",
          locationCode: 2840,
          languageCode: "en",
          competitors: ["rival.example"],
          trackedKeywords: ["plumber near me"],
          keyPages: ["https://manual.example/"],
          monthlyBudgetUsd: 5,
        },
      },
    });
    expect(o).toMatchObject({ slug: "manual-client", domain: "manual.example", ga4PropertyId: "123456789" });
  });

  it("only requires domain, and coerces a numeric GA4 ID", () => {
    expect(parseOverrides({ clients: { a: { domain: "example.com", ga4PropertyId: 42 } } })).toEqual([
      { slug: "a", domain: "example.com", ga4PropertyId: "42" },
    ]);
  });

  it("treats an empty file or empty clients map as no overrides", () => {
    expect(parseOverrides(null)).toEqual([]);
    expect(parseOverrides({ clients: null })).toEqual([]);
    expect(parseOverrides({ clients: {} })).toEqual([]);
  });

  it("rejects a missing domain, a bad field, or two entries for one domain", () => {
    expect(() => parseOverrides({ clients: { a: { name: "x" } } })).toThrow(/clients\.a\.domain/);
    expect(() => parseOverrides({ clients: { a: { domain: "example.com", keyPages: ["not a url"] } } })).toThrow(/keyPages/);
    expect(() =>
      parseOverrides({ clients: { a: { domain: "example.com" }, b: { domain: "https://www.example.com/" } } }),
    ).toThrow(/clients\.a and clients\.b both use domain example\.com/);
  });
});

describe("mergeClients", () => {
  const { sites, properties } = fixtureDiscovery();
  const discovered = joinDiscovered(sites, properties).clients;

  it("applies defaults to discovered clients", () => {
    const [c] = mergeClients(discovered.filter((d) => d.domain === "example.com"), [], DEFAULTS);
    expect(c).toEqual<Client>({
      slug: "example.com",
      domain: "example.com",
      name: "Example Co",
      gscProperty: "sc-domain:example.com",
      ga4PropertyId: "99999999",
      locationCode: 2840,
      languageCode: "en",
      competitors: [],
      competitorEntries: [],
      trackedKeywords: [],
      keywordEntries: [],
      brandTerms: [],
      brandTermEntries: [],
      keyPages: ["https://www.example.com/"],
      monthlyBudgetUsd: 5,
      aliases: [],
      sources: ["gsc", "ga4"],
      alternates: {
        gsc: ["https://www.example.com/"],
        ga4: [{ propertyId: "300000002", displayName: "Example Co (old)" }],
      },
    });
  });

  it("names GSC-only clients after the domain and audits https://<domain>/", () => {
    const c = byDomain(mergeClients(discovered, [], DEFAULTS), "example.org") as Client;
    expect(c.name).toBe("example.org");
    expect(c.keyPages).toEqual(["https://example.org/"]);
    expect(c.sources).toEqual(["gsc"]);
    expect(missingPieces(c)).toEqual(["ga4PropertyId"]);
  });

  it("uses env defaults passed in", () => {
    const c = mergeClients(discovered, [], { locationCode: 2826, languageCode: "en-gb", monthlyBudgetUsd: 12 })[0]!;
    expect([c.locationCode, c.languageCode, c.monthlyBudgetUsd]).toEqual([2826, "en-gb", 12]);
  });

  it("merges yaml over a discovered client field by field; arrays replace", () => {
    const overrides = parseOverrides({
      clients: {
        "example-co": {
          domain: "https://www.example.com/",
          name: "Example Company",
          ga4PropertyId: "300000002",
          competitors: ["rival.example"],
          keyPages: ["https://www.example.com/a", "https://www.example.com/b"],
          monthlyBudgetUsd: 20,
        },
      },
    });
    const c = byDomain(mergeClients(discovered, overrides, DEFAULTS), "example.com") as Client;
    expect(c.name).toBe("Example Company");
    expect(c.ga4PropertyId).toBe("300000002");
    expect(c.gscProperty).toBe("sc-domain:example.com"); // not set in yaml, so discovered wins
    expect(c.competitors).toEqual(["rival.example"]);
    expect(c.keyPages).toEqual(["https://www.example.com/a", "https://www.example.com/b"]);
    expect(c.trackedKeywords).toEqual([]);
    expect(c.monthlyBudgetUsd).toBe(20);
    expect(c.locationCode).toBe(2840);
    expect(c.aliases).toEqual(["example-co"]);
    expect(c.sources).toEqual(["gsc", "ga4", "yaml"]);
  });

  it("keeps yaml entries that weren't discovered as standalone clients", () => {
    const overrides = parseOverrides({
      clients: { "manual-client": { domain: "manual.example", gscProperty: "sc-domain:manual.example" } },
    });
    const c = byDomain(mergeClients(discovered, overrides, DEFAULTS), "manual.example") as Client;
    expect(c).toMatchObject({
      name: "manual.example",
      gscProperty: "sc-domain:manual.example",
      keyPages: ["https://manual.example/"],
      sources: ["yaml"],
      aliases: ["manual-client"],
    });
    expect(c.ga4PropertyId).toBeUndefined();
  });

  it("rejects a yaml key that names a different client's domain", () => {
    const shadowing = parseOverrides({ clients: { "example.net": { domain: "example.com", name: "x" } } });
    expect(() => mergeClients(discovered, shadowing, DEFAULTS)).toThrow(
      /clients\.example\.net \(domain example\.com\) names a different client's domain, example\.net/,
    );
    const viaUrl = parseOverrides({ clients: { "https://www.example.org/": { domain: "alias.example" } } });
    expect(() => mergeClients(discovered, viaUrl, DEFAULTS)).toThrow(/different client's domain, example\.org/);
  });

  it("allows a key that names its own domain or no known domain", () => {
    const ok = parseOverrides({ clients: { "www.example.com": { domain: "example.com" }, "alias.example": { domain: "other.example" } } });
    const merged = mergeClients(discovered, ok, DEFAULTS);
    expect(byDomain(merged, "example.com")!.aliases).toEqual([]);
    expect(byDomain(merged, "other.example")!.aliases).toEqual(["alias.example"]);
  });

  it("rejects keys that differ only in case", () => {
    const dup = parseOverrides({ clients: { Dup: { domain: "a.example" }, dup: { domain: "b.example" } } });
    expect(() => mergeClients([], dup, DEFAULTS)).toThrow(/differ only in case/);
  });

  it("does not add the domain itself as an alias", () => {
    const overrides = parseOverrides({ clients: { "example.net": { domain: "example.net" } } });
    expect((byDomain(mergeClients(discovered, overrides, DEFAULTS), "example.net") as Client).aliases).toEqual([]);
  });
});

describe("findClient", () => {
  const { sites, properties } = fixtureDiscovery();
  const overrides = parseOverrides({ clients: { "Example-Co": { domain: "example.com" } } });
  const clients = mergeClients(joinDiscovered(sites, properties).clients, overrides, DEFAULTS);

  it.each([
    "example.com",
    "EXAMPLE.com",
    "www.example.com",
    "https://www.example.com/",
    "http://example.com/some/page?x=1",
    "sc-domain:example.com",
    "example-co",
    "Example-Co",
  ])("resolves %s", (id) => {
    expect(findClient(clients, id)?.domain).toBe("example.com");
  });

  it("does not resolve a subdomain to its parent, or unknown input", () => {
    expect(findClient(clients, "shop.example.com")?.domain).toBe("shop.example.com");
    expect(findClient(clients, "blog.example.com")).toBeUndefined();
    expect(findClient(clients, "nope")).toBeUndefined();
  });

  it("explains unknown clients, including a discovery failure", () => {
    const msg = unknownClientMessage("nope", clients, "Not signed in to Google");
    expect(msg).toContain('Unknown client "nope"');
    expect(msg).toContain("example.com, example.net");
    expect(msg).toContain("Client discovery failed (Not signed in to Google)");
  });
});

describe("assembleRegistry (fallbacks)", () => {
  const { sites, properties } = fixtureDiscovery();
  const ok = <T>(value: T) => ({ ok: true as const, value });
  const fail = (message: string) => ({ ok: false as const, error: new Error(message) });
  const overrides = parseOverrides({ clients: { "manual-client": { domain: "manual.example" } } });
  const ADMIN_DISABLED =
    "Google Analytics Admin API has not been used in project 123456 before or it is disabled. " +
    "Enable it by visiting https://console.developers.google.com/apis/api/analyticsadmin.googleapis.com/overview?project=123456 then retry.";

  it("lists everything when both sources work", () => {
    const r = assembleRegistry({ gsc: ok(sites), ga4: ok({ properties, errors: [] }) }, overrides, DEFAULTS);
    expect(r.discovery).toMatchObject({ ok: true, warnings: [] });
    expect(r.discovery.notes).toHaveLength(2);
    expect(r.clients.map((c) => c.domain)).toEqual([
      "example.com",
      "example.net",
      "example.org",
      "manual.example",
      "shop.example.com",
    ]);
  });

  it("falls back to yaml-only clients with the reason when discovery fails entirely", () => {
    const outcome: DiscoveryOutcome = {
      gsc: fail("Not signed in to Google (no token at /x). Run `crawlmark-cli auth login` to sign in."),
      ga4: fail("Not signed in to Google (no token at /x). Run `crawlmark-cli auth login` to sign in."),
    };
    const r = assembleRegistry(outcome, overrides, DEFAULTS);
    expect(r.clients.map((c) => c.domain)).toEqual(["manual.example"]);
    expect(r.discovery.ok).toBe(false);
    expect(r.discovery.error).toBe("Not signed in to Google (no token at /x). Run `crawlmark-cli auth login` to sign in.");
  });

  it("combines two different failure reasons", () => {
    const r = assembleRegistry({ gsc: fail("gsc down"), ga4: fail("ga4 down") }, [], DEFAULTS);
    expect(r.discovery.error).toBe("Search Console: gsc down GA4: ga4 down");
    expect(r.clients).toEqual([]);
  });

  it("returns GSC-only clients plus an enable-the-API warning when the Admin API is disabled", () => {
    const r = assembleRegistry({ gsc: ok(sites), ga4: fail(ADMIN_DISABLED) }, [], DEFAULTS);
    expect(r.discovery.ok).toBe(true);
    expect(r.discovery.warnings).toEqual([ADMIN_API_DISABLED_WARNING]);
    expect(ADMIN_API_DISABLED_WARNING).toContain('"Google Analytics Admin API"');
    expect(r.clients.map((c) => c.domain)).toEqual(["example.com", "example.org", "shop.example.com"]);
    expect(r.clients.every((c) => c.ga4PropertyId === undefined)).toBe(true);
  });

  it("returns GA4-only clients with a warning when Search Console listing fails", () => {
    const r = assembleRegistry({ gsc: fail("403 forbidden"), ga4: ok({ properties, errors: [] }) }, [], DEFAULTS);
    expect(r.clients.map((c) => c.domain)).toEqual(["example.com", "example.net"]);
    expect(r.discovery.warnings[0]).toMatch(/Search Console sites could not be listed.*403 forbidden/);
  });

  it("surfaces per-property stream errors as warnings", () => {
    const r = assembleRegistry({ gsc: ok([]), ga4: ok({ properties, errors: ["GA4 property 1 (X): boom"] }) }, [], DEFAULTS);
    expect(r.discovery.warnings).toEqual(["GA4 property 1 (X): boom"]);
  });
});

describe("ignore", () => {
  const { sites, properties } = fixtureDiscovery();
  const discovered = joinDiscovered(sites, properties).clients;

  it("hides an ignored domain from the client list and from resolution", () => {
    const overrides = parseOverrides({ clients: { "example.org": { domain: "example.org", ignore: true } } });
    const r = assembleRegistry({ gsc: { ok: true, value: sites }, ga4: { ok: true, value: { properties, errors: [] } } }, overrides, DEFAULTS);
    expect(r.clients.map((c) => c.domain)).not.toContain("example.org");
    expect(r.ignored).toEqual(["example.org"]);
    expect(findClient(r.clients, "example.org")).toBeUndefined();
    expect(mergeClients(discovered, overrides, DEFAULTS).map((c) => c.domain)).toEqual(["example.com", "example.net", "shop.example.com"]);
  });
});

describe("assembleRegistry (Google not set up)", () => {
  it("returns the clients.yaml entries with an info line, not an error", () => {
    const overrides = parseOverrides({ clients: { "example.com": { domain: "example.com" } } });
    const r = assembleRegistry({ skipped: "Google isn't set up." }, overrides, DEFAULTS);
    expect(r.clients.map((c) => [c.domain, c.sources, c.keyPages])).toEqual([["example.com", ["yaml"], ["https://example.com/"]]]);
    expect(r.discovery).toEqual({ ok: false, skipped: true, info: "Google isn't set up.", warnings: [], notes: [] });
  });
});

describe("assembleRegistry (clients.yaml notes)", () => {
  const { sites, properties } = fixtureDiscovery();
  const ok = { gsc: { ok: true as const, value: sites }, ga4: { ok: true as const, value: { properties, errors: [] } } };

  it("notes a pinned property that differs from discovery, and one the account can't see", () => {
    const overrides = parseOverrides({
      clients: {
        "example.com": { domain: "example.com", gscProperty: "https://www.example.com/", ga4PropertyId: "300000002" },
        "gone.example": { domain: "gone.example", gscProperty: "sc-domain:gone.example", ga4PropertyId: "1" },
        "manual.example": { domain: "manual.example" },
      },
    });
    const r = assembleRegistry(ok, overrides, DEFAULTS);
    expect(r.discovery.notes.slice(2)).toEqual([
      "example.com: clients.yaml pins gscProperty https://www.example.com/; discovery would pick sc-domain:example.com.",
      "example.com: clients.yaml pins ga4PropertyId 300000002; discovery would pick 99999999.",
      "gone.example: clients.yaml has gscProperty sc-domain:gone.example, but this Google account can't see it in Search Console.",
      "gone.example: clients.yaml has ga4PropertyId 1, but this Google account can't see it in GA4.",
    ]);
    // yaml still wins, and the undiscovered entry is kept.
    expect(byDomain(r.clients, "example.com")!.gscProperty).toBe("https://www.example.com/");
    expect(byDomain(r.clients, "gone.example")).toBeDefined();
  });

  it("doesn't judge GA4 entries when the GA4 list is incomplete", () => {
    const overrides = parseOverrides({ clients: { "gone.example": { domain: "gone.example", ga4PropertyId: "1" } } });
    const partial = { ...ok, ga4: { ok: true as const, value: { properties, errors: ["GA4 property 1 (X): boom"] } } };
    expect(assembleRegistry(partial, overrides, DEFAULTS).discovery.notes.slice(2)).toEqual([]);
  });
});

describe("planSync", () => {
  const { sites, properties } = fixtureDiscovery();
  const discovered = joinDiscovered(sites, properties).clients;

  it("adds every discovered domain to an empty file, keyed by domain", () => {
    expect(planSync([], discovered)).toEqual({
      add: [
        { domain: "example.com", name: "Example Co", gscProperty: "sc-domain:example.com", ga4PropertyId: "99999999" },
        { domain: "example.net", name: "Example Net", ga4PropertyId: "200000001" },
        { domain: "example.org", gscProperty: "https://example.org/" },
        { domain: "shop.example.com", gscProperty: "https://shop.example.com/" },
      ],
      fill: [],
    });
  });

  it("only fills missing properties, never overwrites, and skips ignored entries", () => {
    const overrides = parseOverrides({
      clients: {
        "example-co": { domain: "example.com", name: "Mine", gscProperty: "https://www.example.com/" },
        "example.net": { domain: "example.net", ignore: true },
        "example.org": { domain: "example.org", gscProperty: "http://example.org/", ga4PropertyId: "5" },
        "manual.example": { domain: "manual.example" },
      },
    });
    expect(planSync(overrides, discovered)).toEqual({
      add: [{ domain: "shop.example.com", gscProperty: "https://shop.example.com/" }],
      fill: [{ key: "example-co", domain: "example.com", field: "ga4PropertyId", value: "99999999" }],
    });
  });

  it("treats an empty-string property as missing", () => {
    const overrides = parseOverrides({ clients: { "example.com": { domain: "example.com", gscProperty: "", ga4PropertyId: "" } } });
    const plan = planSync(overrides, discovered.filter((d) => d.domain === "example.com"));
    expect(plan.fill.map((f) => [f.field, f.value])).toEqual([
      ["gscProperty", "sc-domain:example.com"],
      ["ga4PropertyId", "99999999"],
    ]);
  });

  it("is a no-op once everything is present", () => {
    const first = planSync([], discovered);
    const overrides = first.add.map((e) => ({ ...e, slug: e.domain }));
    expect(planSync(overrides, discovered)).toEqual({ add: [], fill: [] });
  });
});

describe("isAdminApiDisabled", () => {
  it("recognises the disabled-API message and nothing else", () => {
    expect(isAdminApiDisabled(new Error("Google Analytics Admin API has not been used in project 1 before or it is disabled."))).toBe(true);
    expect(isAdminApiDisabled(new Error("analyticsadmin.googleapis.com SERVICE_DISABLED"))).toBe(true);
    expect(isAdminApiDisabled(new Error("The caller does not have permission"))).toBe(false);
    expect(isAdminApiDisabled(new Error("Google Analytics Data API has not been used in project 1"))).toBe(false);
  });
});

describe("mapLimit", () => {
  it("keeps order and never exceeds the limit", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3, 0], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, n));
      active--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 0]);
    expect(peak).toBe(2);
  });

  it("handles an empty list", async () => {
    expect(await mapLimit([], 3, async () => 1)).toEqual([]);
  });
});
