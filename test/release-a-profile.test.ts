/**
 * Release A (spec C1-C3, WS0): ga4Hostnames, gscExcludeQueries and gtmContainerId in clients.yaml, on the Client,
 * in setClientProfile, in the set_client_profile tool and in `clients set`. Temp clients file and data directory only.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { env } from "../src/config.js";
import { resolveClient, setClientProfile } from "../src/clients.js";
import { mergeClients, parseOverrides, type ClientDefaults } from "../src/lib/clients.js";
import type { GtmMatch } from "../src/lib/gtm.js";
import { registerCompetitorTools } from "../src/tools/competitors.js";

const DEFAULTS: ClientDefaults = { locationCode: 2840, languageCode: "en", monthlyBudgetUsd: 5 };
const C1_YAML = `
clients:
  example:
    domain: example.com
    ga4Hostnames: [example.com, www.example.com, shop.example.com]
    gscExcludeQueries: ["example login", "/^site:example\\\\.com/"]
    gtmContainerId: GTM-ABC1234
`;
const overrides = (yaml: object) => parseOverrides(yaml, "test");
const reload = () => parseYaml(readFileSync(env.CLIENTS_FILE, "utf8")).clients as Record<string, Record<string, unknown>>;

describe("clients.yaml fields (C1)", () => {
  it("round-trips the C1 example through parseOverrides", () => {
    const [o] = parseOverrides(parseYaml(C1_YAML));
    expect(o).toMatchObject({
      slug: "example",
      domain: "example.com",
      ga4Hostnames: ["example.com", "www.example.com", "shop.example.com"],
      gscExcludeQueries: ["example login", "/^site:example\\.com/"],
      gtmContainerId: "GTM-ABC1234",
    });
  });

  it("is ignored by the 0.1.3 override shape (non-strict z.object strips unknown keys)", () => {
    const old = z.object({ domain: z.string().min(1), gtmContainerId: z.union([z.string(), z.number().int()]).transform(String).optional() });
    const parsed = z.object({ clients: z.record(z.string(), old) }).parse(parseYaml(C1_YAML));
    expect(parsed.clients.example).toEqual({ domain: "example.com", gtmContainerId: "GTM-ABC1234" });
  });

  it("names the field and index of a bad entry", () => {
    expect(() => overrides({ clients: { x: { domain: "example.com", ga4Hostnames: ["example.com", "https://x.com"] } } })).toThrow(/Invalid test: clients\.x\.ga4Hostnames\[1\] "https:\/\/x\.com" must be a host/);
    expect(() => overrides({ clients: { x: { domain: "example.com", ga4Hostnames: ["*", "example.com"] } } })).toThrow(/clients\.x\.ga4Hostnames .*only entry/);
    expect(() => overrides({ clients: { x: { domain: "example.com", ga4Hostnames: [] } } })).toThrow(/clients\.x\.ga4Hostnames/);
    expect(() => overrides({ clients: { x: { domain: "example.com", ga4Hostnames: Array.from({ length: 21 }, (_, i) => `h${i}.example.com`) } } })).toThrow(/ga4Hostnames/);
    expect(() => overrides({ clients: { x: { domain: "example.com", gscExcludeQueries: ["fine", "/(?=x)/"] } } })).toThrow(/clients\.x\.gscExcludeQueries\[1\] "\/\(\?=x\)\/" is a lookaround|clients\.x\.gscExcludeQueries\[1\] .*lookarounds/);
    expect(() => overrides({ clients: { x: { domain: "example.com", gscExcludeQueries: ["/(a)\\1/"] } } })).toThrow(/backreferences/);
    expect(() => overrides({ clients: { x: { domain: "example.com", gscExcludeQueries: [""] } } })).toThrow(/gscExcludeQueries/);
    expect(() => overrides({ clients: { x: { domain: "example.com", gscExcludeQueries: ["x".repeat(201)] } } })).toThrow(/gscExcludeQueries/);
    const long = Array.from({ length: 30 }, (_, i) => `/${String(i).padStart(3, "0")}${"x".repeat(150)}/`);
    expect(() => overrides({ clients: { x: { domain: "example.com", gscExcludeQueries: long } } })).toThrow(/-character expression/);
  });
});

describe("Client fields (C2)", () => {
  it("an existing clients.yaml with none of the new keys gets the defaults", () => {
    const [c] = mergeClients([], overrides({ clients: { "example.com": { domain: "example.com", name: "Example Co" } } }), DEFAULTS);
    expect(c).toMatchObject({
      ga4Hostnames: ["example.com", "www.example.com"],
      ga4HostnamesSource: "default",
      gscExcludeQueries: [],
      gtmPinned: false,
      gtmCandidates: [],
    });
    expect(c!.gtmContainerId).toBeUndefined();
    expect(c!.gtmAccountId).toBeUndefined();
  });

  it("yaml hostnames and exclusions are used as written", () => {
    const [c] = mergeClients([], parseOverrides(parseYaml(C1_YAML)), DEFAULTS);
    expect(c).toMatchObject({
      ga4Hostnames: ["example.com", "www.example.com", "shop.example.com"],
      ga4HostnamesSource: "yaml",
      gscExcludeQueries: ["example login", "/^site:example\\.com/"],
      gtmPinned: true,
      gtmContainerId: "GTM-ABC1234",
      gtmCandidates: [],
    });
  });

  const match = (alternates: GtmMatch["alternates"] = []): GtmMatch => ({
    gtmAccountId: "6000000001",
    gtmContainerId: "7000000001",
    publicId: "GTM-AAAA111",
    name: "example.com",
    matchedBy: "domain",
    alternates,
  });
  const yamlFor = (extra: object = {}) => overrides({ clients: { "example.com": { domain: "example.com", ...extra } } });

  it("a single discovered candidate sets the ids and is listed", () => {
    const [c] = mergeClients([], yamlFor(), DEFAULTS, new Map([["example.com", match()]]));
    expect(c).toMatchObject({ gtmPinned: false, gtmAccountId: "6000000001", gtmContainerId: "7000000001" });
    expect(c!.gtmCandidates).toEqual([{ gtmAccountId: "6000000001", gtmContainerId: "7000000001", publicId: "GTM-AAAA111", matchedBy: "domain" }]);
  });

  it("two or more candidates and no pin set no ids and list every candidate", () => {
    const alt = { gtmAccountId: "6000000001", gtmContainerId: "7000000002", publicId: "GTM-BBBB222" };
    const [c] = mergeClients([], yamlFor(), DEFAULTS, new Map([["example.com", match([alt])]]));
    expect(c!.gtmAccountId).toBeUndefined();
    expect(c!.gtmContainerId).toBeUndefined();
    expect(c!.gtmPinned).toBe(false);
    expect(c!.gtmCandidates.map((x) => x.publicId)).toEqual(["GTM-AAAA111", "GTM-BBBB222"]);
  });

  it("a pin wins over discovery, with no candidates", () => {
    const alt = { gtmAccountId: "6000000001", gtmContainerId: "7000000002", publicId: "GTM-BBBB222" };
    const [c] = mergeClients([], yamlFor({ gtmContainerId: "GTM-BBBB222" }), DEFAULTS, new Map([["example.com", match([alt])]]));
    expect(c).toMatchObject({ gtmPinned: true, gtmContainerId: "GTM-BBBB222", gtmCandidates: [] });
    expect(c!.gtmAccountId).toBeUndefined();
    const [acct] = mergeClients([], yamlFor({ gtmAccountId: "9" }), DEFAULTS, new Map([["example.com", match()]]));
    expect(acct).toMatchObject({ gtmPinned: true, gtmAccountId: "9", gtmCandidates: [] });
    expect(acct!.gtmContainerId).toBeUndefined();
  });
});

describe("setClientProfile (C3)", () => {
  const start = (extra = "") => writeFileSync(env.CLIENTS_FILE, `# keep me\nclients:\n  example.com:\n    domain: example.com # inline\n${extra}`);

  it("sets, replaces and clears ga4Hostnames", async () => {
    start();
    const set = await setClientProfile("example.com", { ga4Hostnames: ["shop.example.com", " Shop.Example.com ", "example.com"] });
    expect(reload()["example.com"]!.ga4Hostnames).toEqual(["shop.example.com", "example.com"]);
    expect(set.set).toMatchObject({ ga4Hostnames: "shop.example.com, example.com" });
    expect(set.profile.ga4Hostnames).toEqual(["shop.example.com", "example.com"]);
    expect((await resolveClient("example.com")).ga4HostnamesSource).toBe("yaml");
    await setClientProfile("example.com", { ga4Hostnames: ["*"] });
    expect(reload()["example.com"]!.ga4Hostnames).toEqual(["*"]);
    const cleared = await setClientProfile("example.com", { ga4Hostnames: [] });
    expect(cleared.cleared).toContain("ga4Hostnames");
    expect(cleared.profile.ga4Hostnames).toEqual(["example.com", "www.example.com"]);
    expect(reload()["example.com"]!.ga4Hostnames).toBeUndefined();
    expect(readFileSync(env.CLIENTS_FILE, "utf8")).toContain("# keep me");
  });

  it("sets, replaces and clears gscExcludeQueries", async () => {
    start();
    const r = await setClientProfile("example.com", { gscExcludeQueries: ["example login", "/^site:example\\.com/"] });
    expect(reload()["example.com"]!.gscExcludeQueries).toEqual(["example login", "/^site:example\\.com/"]);
    expect(r.profile.gscExcludeQueries).toEqual(["example login", "/^site:example\\.com/"]);
    await setClientProfile("example.com", { gscExcludeQueries: ["only this"] });
    expect(reload()["example.com"]!.gscExcludeQueries).toEqual(["only this"]);
    const cleared = await setClientProfile("example.com", { gscExcludeQueries: [] });
    expect(cleared.cleared).toContain("gscExcludeQueries");
    expect(reload()["example.com"]!.gscExcludeQueries).toBeUndefined();
  });

  it("rejects invalid input with a message that names the param, and writes nothing", async () => {
    start();
    await expect(setClientProfile("example.com", { gscExcludeQueries: ["/(?=x)/"] })).rejects.toThrow(`gscExcludeQueries: "/(?=x)/" isn't a usable exclusion: lookarounds aren't supported (Search Console uses RE2).`);
    await expect(setClientProfile("example.com", { ga4Hostnames: ["*", "example.com"] })).rejects.toThrow(/ga4Hostnames: .*only entry/);
    await expect(setClientProfile("example.com", { ga4Hostnames: ["not a host"] })).rejects.toThrow(/ga4Hostnames: "not a host" isn't a usable GA4 hostname/);
    await expect(setClientProfile("example.com", { gtmContainerId: "GTM-" })).rejects.toThrow(/isn't a Tag Manager container ID/);
    await expect(setClientProfile("example.com", { gtmContainerId: "ABC123" })).rejects.toThrow(/isn't a Tag Manager container ID/);
    expect(reload()["example.com"]).toEqual({ domain: "example.com" });
  });

  it("pins gtmContainerId (uppercased) and removes a stale gtmAccountId; \"\" clears both", async () => {
    start("    gtmAccountId: \"6000000001\"\n    gtmContainerId: \"7000000001\"\n");
    const r = await setClientProfile("example.com", { gtmContainerId: "gtm-bbbb222" });
    expect(reload()["example.com"]).toMatchObject({ gtmContainerId: "GTM-BBBB222" });
    expect(reload()["example.com"]!.gtmAccountId).toBeUndefined();
    expect(r.set).toEqual({ gtmContainerId: "GTM-BBBB222" });
    expect(r.cleared).toEqual([]);
    expect(r.profile.gtm).toEqual({ containerId: "GTM-BBBB222", pinned: true });
    const c = await resolveClient("example.com");
    expect(c).toMatchObject({ gtmPinned: true, gtmContainerId: "GTM-BBBB222" });
    await setClientProfile("example.com", { gtmContainerId: "7000000009" });
    expect(reload()["example.com"]!.gtmContainerId).toBe("7000000009");
    const cleared = await setClientProfile("example.com", { gtmContainerId: "" });
    expect(cleared.cleared).toEqual(["gtmContainerId"]);
    expect(cleared.profile.gtm).toEqual({ containerId: null, pinned: false });
    expect(reload()["example.com"]!.gtmContainerId).toBeUndefined();
    expect(reload()["example.com"]!.gtmAccountId).toBeUndefined();
  });

  it("\"Nothing to set\" lists the new fields", async () => {
    start();
    await expect(setClientProfile("example.com", {})).rejects.toThrow(/ga4Hostnames, gscExcludeQueries or gtmContainerId/);
  });
});

describe("set_client_profile tool (C3)", () => {
  it("accepts the three new params and describes them", async () => {
    let def: { description: string; inputSchema: Record<string, z.ZodType> } | undefined;
    let cb: ((a: Record<string, unknown>, extra: unknown) => Promise<unknown>) | undefined;
    registerCompetitorTools({ registerTool: (name: string, d: never, c: never) => void (name === "set_client_profile" && ((def = d), (cb = c))) } as never);
    expect(def!.description).toContain('ga4Hostnames limits GA4 numbers to these hostnames (default: the domain and www.; "*.example.com" for subdomains; ["*"] for no filter).');
    expect(def!.description).toContain("gscExcludeQueries leaves queries out of Search Console totals and query lists (exact text, or /regex/ in RE2).");
    expect(def!.description).toContain('gtmContainerId pins the Tag Manager container gtm_audit uses ("GTM-XXXX" or the numeric ID).');
    const schema = z.object(def!.inputSchema);
    expect(schema.safeParse({ client: "example.com", ga4Hostnames: ["example.com"], gscExcludeQueries: ["x"], gtmContainerId: "GTM-AAAA111" }).success).toBe(true);
    expect(schema.safeParse({ client: "example.com", ga4Hostnames: Array.from({ length: 21 }, () => "a.example.com") }).success).toBe(false);
    expect(schema.safeParse({ client: "example.com", gscExcludeQueries: Array.from({ length: 101 }, () => "q") }).success).toBe(false);
    expect(schema.safeParse({ client: "example.com", gscExcludeQueries: ["x".repeat(201)] }).success).toBe(false);
    expect(schema.safeParse({ client: "example.com", gtmContainerId: "x".repeat(26) }).success).toBe(false);
    // And it reaches clients.yaml.
    writeFileSync(env.CLIENTS_FILE, "clients:\n  example.com:\n    domain: example.com\n");
    await cb!({ client: "example.com", ga4Hostnames: ["shop.example.com"], gtmContainerId: "GTM-AAAA111" }, {});
    expect(reload()["example.com"]).toMatchObject({ ga4Hostnames: ["shop.example.com"], gtmContainerId: "GTM-AAAA111" });
  });
});

describe("clients set flags (C3, CLI)", () => {
  const SPAWN_TIMEOUT_MS = 45_000;
  const cli = (file: string, dir: string, ...args: string[]) =>
    spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", join(import.meta.dirname, "..", "src", "cli.ts"), "clients", "set", ...args], {
      encoding: "utf8",
      timeout: SPAWN_TIMEOUT_MS,
      killSignal: "SIGKILL",
      env: { ...process.env, CRAWLMARK_HOME: dir, CLIENTS_FILE: file, DATA_DIR: join(dir, "data") },
    });

  it("--ga4-hostname writes ga4Hostnames, --gsc-exclude-query and --gtm-container too, and none clears", () => {
    const dir = mkdtempSync(join(tmpdir(), "crawlmark-release-a-cli-"));
    const file = join(dir, "clients.yaml");
    writeFileSync(file, "clients:\n  example.com:\n    domain: example.com\n    gtmAccountId: \"6000000001\"\n");
    const read = () => parseYaml(readFileSync(file, "utf8")).clients["example.com"] as Record<string, unknown>;

    const one = cli(file, dir, "example.com", "--ga4-hostname", "shop.example.com");
    expect(one.status, one.stderr).toBe(0);
    expect(read().ga4Hostnames).toEqual(["shop.example.com"]);
    expect(one.stdout).toContain("GA4 hostnames shop.example.com");

    const many = cli(file, dir, "example.com", "--ga4-hostname", "example.com", "--ga4-hostname", "*.example.com", "--gsc-exclude-query", "example login", "--gsc-exclude-query", "/^site:example\\.com/", "--gtm-container", "GTM-BBBB222");
    expect(many.status, many.stderr).toBe(0);
    expect(read()).toMatchObject({ ga4Hostnames: ["example.com", "*.example.com"], gscExcludeQueries: ["example login", "/^site:example\\.com/"], gtmContainerId: "GTM-BBBB222" });
    expect(read().gtmAccountId).toBeUndefined();

    const none = cli(file, dir, "example.com", "--ga4-hostname", "none", "--gsc-exclude-query", "none", "--gtm-container", "none");
    expect(none.status, none.stderr).toBe(0);
    expect(read()).toEqual({ domain: "example.com" });

    const mixed = cli(file, dir, "example.com", "--ga4-hostname", "none", "--ga4-hostname", "example.com");
    expect(mixed.status).not.toBe(0);
    expect(mixed.stderr).toMatch(/none clears the list/);

    const bad = cli(file, dir, "example.com", "--gsc-exclude-query", "/(?=x)/");
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/lookarounds/);

    const nothing = cli(file, dir, "example.com");
    expect(nothing.status).toBe(2);
    expect(nothing.stderr).toMatch(/--ga4-hostname, --gsc-exclude-query, or --gtm-container/);
  }, 6 * SPAWN_TIMEOUT_MS);
});

describe("lighthouse tool registration and timeouts (C13)", () => {
  it("has the run and queue limits and says that runs queue", async () => {
    const { TIMEOUTS } = await import("../src/lib/timeout.js");
    expect(TIMEOUTS).toMatchObject({ browserMs: 90_000, lighthouseRunMs: 150_000, lighthouseQueueMs: 600_000 });
    const { registerRawTools } = await import("../src/tools/raw.js");
    const defs = new Map<string, { description: string }>();
    registerRawTools({ registerTool: (name: string, d: { description: string }) => void defs.set(name, d) } as never);
    const lh = defs.get("lighthouse")!.description;
    expect(lh).toContain("Lighthouse runs one at a time, so parallel calls queue (each run times out after 150 s, not counting the wait). Call it for one URL at a time.");
    expect(lh).not.toContain("Times out after 90s");
    expect(defs.get("accessibility_check")!.description).toContain("Times out after 90s.");
  });
});
