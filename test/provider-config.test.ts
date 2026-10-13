import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { ahrefsCountry, countryFromLocationCode, resolveCountry, SEMRUSH_DATABASES, semrushDatabase } from "../src/lib/country.js";
import { mergeClients, parseOverrides } from "../src/lib/clients.js";
import { dropUnsetKeys, PHASE9_ENV_KEYS, shellUrlOverride, urlOverrideNotice } from "../src/lib/env.js";
import { resolveDefaultProvider } from "../src/lib/provider-ids.js";

const root = join(import.meta.dirname, "..");

describe("resolveDefaultProvider (9.3, D11)", () => {
  it("unset, empty, whitespace and a leftover bundle placeholder all mean dataforseo from the default", () => {
    for (const raw of [undefined, "", "  ", "${user_config.seo_data_provider}"]) {
      expect(resolveDefaultProvider({ raw, source: "env" }), String(raw)).toEqual({ ok: true, provider: "dataforseo", source: "default" });
    }
  });

  it("matches a known id ignoring case and spaces, keeping where it came from", () => {
    expect(resolveDefaultProvider({ raw: "Ahrefs ", source: "env" })).toEqual({ ok: true, provider: "ahrefs", source: "env" });
    expect(resolveDefaultProvider({ raw: "SEMRUSH", source: "envFile" })).toEqual({ ok: true, provider: "semrush", source: "envFile" });
  });

  it("an unknown value is not ok, never throws, and the message names all three and says blank means dataforseo", () => {
    const r = resolveDefaultProvider({ raw: "moz", source: "env" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.invalidValue).toBe("moz");
    expect(r.message).toBe('SEO_DATA_PROVIDER is "moz", which isn\'t a provider crawlmark knows. Use dataforseo, ahrefs or semrush, or leave it blank for dataforseo.');
  });
});

describe("env helpers", () => {
  it("dropUnsetKeys removes only unset Phase 9 keys", () => {
    const e: Record<string, string | undefined> = { SEO_DATA_PROVIDER: "", AHREFS_API_KEY: "${user_config.ahrefs_api_key}", SEMRUSH_API_KEY: "k", PSI_API_KEY: "" };
    expect(dropUnsetKeys(e, PHASE9_ENV_KEYS).sort()).toEqual(["AHREFS_API_KEY", "SEO_DATA_PROVIDER"]);
    expect(e).toEqual({ SEMRUSH_API_KEY: "k", PSI_API_KEY: "" });
  });

  it("shellUrlOverride ignores .env values and non-http URLs", () => {
    expect(shellUrlOverride("http://127.0.0.1:9/v3/", false, "https://x")).toBe("http://127.0.0.1:9/v3");
    expect(shellUrlOverride("http://127.0.0.1:9", true, "https://x")).toBe("https://x");
    expect(shellUrlOverride("file:///etc", false, "https://x")).toBe("https://x");
    expect(shellUrlOverride("", false, "https://x")).toBe("https://x");
  });
});

describe("config precedence for SEO_DATA_PROVIDER", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    vi.resetModules();
  });

  async function loadWith(processValue: string | undefined, fileValue: string | undefined) {
    const home = mkdtempSync(join(tmpdir(), "crawlmark-provcfg-"));
    if (fileValue !== undefined) writeFileSync(join(home, ".env"), `SEO_DATA_PROVIDER=${fileValue}\n`);
    process.env.CRAWLMARK_HOME = home;
    if (processValue === undefined) delete process.env.SEO_DATA_PROVIDER;
    else process.env.SEO_DATA_PROVIDER = processValue;
    vi.resetModules();
    return (await import("../src/config.js")).seoDefaultProvider;
  }

  it("a blank process value (a blank bundle field) doesn't hide .env", async () => {
    expect(await loadWith("", "semrush")).toEqual({ ok: true, provider: "semrush", source: "envFile" });
    expect(await loadWith("${user_config.seo_data_provider}", "ahrefs")).toEqual({ ok: true, provider: "ahrefs", source: "envFile" });
  });

  it("a set process value beats .env", async () => {
    expect(await loadWith("ahrefs", "semrush")).toEqual({ ok: true, provider: "ahrefs", source: "env" });
  });

  it("unset everywhere is dataforseo; an invalid value loads without throwing", async () => {
    expect(await loadWith(undefined, undefined)).toEqual({ ok: true, provider: "dataforseo", source: "default" });
    const bad = await loadWith("moz", undefined);
    expect(bad.ok).toBe(false);
  });
});

describe("markets (src/lib/country.ts)", () => {
  it("country-level DataForSEO codes map to alpha-2; city codes don't", () => {
    expect(countryFromLocationCode(2840)).toBe("US");
    expect(countryFromLocationCode(2826)).toBe("GB");
    expect(countryFromLocationCode(2276)).toBe("DE");
    expect(countryFromLocationCode(1023191)).toBeNull();
    expect(countryFromLocationCode(2000)).toBeNull();
    expect(resolveCountry("gb", 2840)).toBe("GB");
    expect(resolveCountry(undefined, 1023191)).toBeNull();
  });

  it("Ahrefs gets lowercase; Semrush gets uk for GB and null outside the documented list", () => {
    expect(ahrefsCountry("GB")).toBe("gb");
    expect(semrushDatabase("GB")).toBe("uk");
    expect(semrushDatabase("US")).toBe("us");
    expect(semrushDatabase("GL")).toBeNull();
    expect(SEMRUSH_DATABASES.has("gb")).toBe(false);
    // Exactly the documented list (docs/research/semrush-api.md "Databases").
    const note = readFileSync(join(root, "docs", "research", "semrush-api.md"), "utf8");
    const listed = /The documented desktop list: ([a-z ]+)\./.exec(note)![1]!.split(" ");
    expect([...SEMRUSH_DATABASES].sort()).toEqual(listed.sort());
  });
});

describe("clients.yaml Phase 9 fields", () => {
  const defaults = { locationCode: 2840, languageCode: "en", monthlyBudgetUsd: 5, monthlyUnits: { ahrefs: 10_000, semrush: 5_000 } };

  it("parses dataProvider, country (uppercased) and monthlyUnits, and resolves them", () => {
    const overrides = parseOverrides({
      clients: {
        a: { domain: "example.com", dataProvider: "ahrefs", country: "gb", monthlyUnits: { ahrefs: 20_000 } },
        b: { domain: "example.org", locationCode: 1023191 },
      },
    });
    const [a, b] = mergeClients([], overrides, defaults);
    expect(a).toMatchObject({ dataProvider: "ahrefs", country: "GB", monthlyUnits: { ahrefs: 20_000, semrush: 5_000 } });
    expect(b!.dataProvider).toBeUndefined();
    expect(b!.country).toBeNull();
  });

  it("an invalid dataProvider or country fails with the clients.<slug>.<field> style naming the allowed values", () => {
    expect(() => parseOverrides({ clients: { a: { domain: "example.com", dataProvider: "moz" } } })).toThrow(
      /clients\.a\.dataProvider: must be one of dataforseo, ahrefs, semrush/,
    );
    expect(() => parseOverrides({ clients: { a: { domain: "example.com", country: "USA" } } })).toThrow(/clients\.a\.country: must be a two-letter ISO country code/);
  });
});

describe("clients set --provider/--country (CLI)", () => {
  const dir = mkdtempSync(join(tmpdir(), "crawlmark-clientsset-"));
  const file = join(dir, "clients.yaml");
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", join(root, "src", "cli.ts"), ...args], {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, CRAWLMARK_HOME: dir, CLIENTS_FILE: file, DATA_DIR: join(dir, "data") },
    });
  const entry = () => (parseYaml(readFileSync(file, "utf8")) as { clients: Record<string, Record<string, unknown>> }).clients["example.com"]!;

  it("writes dataProvider and country, keeps comments, and none clears both", () => {
    writeFileSync(file, "# keep me\nclients:\n  example.com:\n    domain: example.com # inline\n");
    const set = run(["clients", "set", "example.com", "--provider", "ahrefs", "--country", "GB"]);
    expect(set.status, set.stderr).toBe(0);
    expect(entry()).toMatchObject({ dataProvider: "ahrefs", country: "GB" });
    expect(readFileSync(file, "utf8")).toContain("domain: example.com # inline");
    expect(set.stdout).toContain("data provider ahrefs; country GB");

    const cleared = run(["clients", "set", "example.com", "--provider", "none", "--country", "none"]);
    expect(cleared.status, cleared.stderr).toBe(0);
    expect(entry().dataProvider).toBeUndefined();
    expect(entry().country).toBeUndefined();
  }, 60_000);

  it("an unknown provider is a usage error (exit 2) naming the allowed values", () => {
    writeFileSync(file, "clients:\n  example.com:\n    domain: example.com\n");
    const r = run(["clients", "set", "example.com", "--provider", "moz"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--provider must be one of dataforseo, ahrefs, semrush or none");
    expect(entry().dataProvider).toBeUndefined();
  }, 60_000);
});

describe("set_client_profile dataProvider/country (setClientProfile)", () => {
  it("stores semrush and GB, keeps comments, and \"\" clears both", async () => {
    const file = process.env.CLIENTS_FILE!;
    writeFileSync(file, "# keep me\nclients:\n  example.com:\n    domain: example.com # inline\n");
    vi.resetModules();
    const { setClientProfile } = await import("../src/clients.js");
    const set = await setClientProfile("example.com", { dataProvider: "semrush", country: "gb" });
    expect(set.set).toEqual({ dataProvider: "semrush", country: "GB" });
    expect(set.profile).toMatchObject({ dataProvider: "semrush", country: "GB" });
    const text = readFileSync(file, "utf8");
    expect(text).toContain("# keep me");
    expect(text).toContain("domain: example.com # inline");
    expect(parseYaml(text).clients["example.com"]).toMatchObject({ dataProvider: "semrush", country: "GB" });

    const cleared = await setClientProfile("example.com", { dataProvider: "", country: "" });
    expect(cleared.cleared).toEqual(["dataProvider", "country"]);
    const after = parseYaml(readFileSync(file, "utf8")).clients["example.com"];
    expect(after.dataProvider).toBeUndefined();
    expect(after.country).toBeUndefined();
    // Cleared country falls back to the location code's (2840 = US).
    expect(cleared.profile).toMatchObject({ dataProvider: null, country: "US" });

    await expect(setClientProfile("example.com", { dataProvider: "moz" })).rejects.toThrow(/not a data provider/);
    await expect(setClientProfile("example.com", { country: "USA" })).rejects.toThrow(/two-letter ISO/);
  });
});

describe("SEC-2: provider URL overrides", () => {
  it("accept https anywhere, plain http only for loopback hosts", () => {
    expect(shellUrlOverride("https://proxy.example.com/v3", false, "https://x")).toBe("https://proxy.example.com/v3");
    for (const ok of ["http://127.0.0.1:9/v3", "http://localhost:8080", "http://[::1]:9"]) expect(shellUrlOverride(ok, false, "https://x"), ok).toBe(ok);
    for (const bad of ["http://example.com/v3", "http://10.0.0.5", "http://127.0.0.1.example.com", "ftp://127.0.0.1"]) expect(shellUrlOverride(bad, false, "https://x"), bad).toBe("https://x");
  });

  it("the notice names each overridden variable by origin only, and is silent when nothing is overridden", () => {
    const n = urlOverrideNotice([
      { name: "AHREFS_BASE_URL", value: "http://127.0.0.1:9/v3/secret-path", fallback: "https://api.ahrefs.com/v3" },
      { name: "SEMRUSH_BASE_URL", value: "https://api.semrush.com", fallback: "https://api.semrush.com" },
    ]);
    expect(n).toBe("crawlmark: test-only provider URL override in use: AHREFS_BASE_URL -> http://127.0.0.1:9. Unset it unless you are testing against a fake server.");
    expect(n).not.toContain("secret-path");
    expect(urlOverrideNotice([{ name: "X", value: "https://a", fallback: "https://a" }])).toBeUndefined();
  });

  it("setup prints the notice on stderr", () => {
    const home = mkdtempSync(join(tmpdir(), "crawlmark-urlnotice-"));
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", join(root, "src", "cli.ts"), "setup", "status", "--only", "home", "--json"], {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, CRAWLMARK_HOME: home },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("crawlmark: test-only provider URL override in use: AHREFS_BASE_URL -> http://127.0.0.1:9, SEMRUSH_BASE_URL -> http://127.0.0.1:9, SEMRUSH_BALANCE_URL -> http://127.0.0.1:9, CRUX_BASE_URL -> http://127.0.0.1:9.");
  }, 60_000);
});

describe("SEC-3: an invalid SEO_DATA_PROVIDER that might be a pasted key is never echoed", () => {
  const KEY = "sk-SENTINEL-pasted-into-provider-field-1234567890";

  it("echoes only short word-like values", async () => {
    const { displayProviderValue } = await import("../src/lib/provider-ids.js");
    expect(displayProviderValue("moz")).toBe("moz");
    expect(displayProviderValue("semrush_v2-x")).toBe("semrush_v2-x");
    expect(displayProviderValue(KEY)).toBe(`(hidden, ${KEY.length} characters)`);
    expect(displayProviderValue("a b")).toBe("(hidden, 3 characters)");
    expect(displayProviderValue(displayProviderValue(KEY))).toBe(`(hidden, ${KEY.length} characters)`);
  });

  it("resolveDefaultProvider, the seoprovider row and a routed call's message never contain it", async () => {
    const r = resolveDefaultProvider({ raw: KEY, source: "env" });
    expect(r).toEqual({ ok: false, invalidValue: `(hidden, ${KEY.length} characters)`, message: expect.stringContaining(`SEO_DATA_PROVIDER is (hidden, ${KEY.length} characters), which isn't`) });
    const { seoProviderRow } = await import("../src/setup/status.js");
    const row = seoProviderRow({ default: null, source: "env", invalidValue: r.ok ? "" : r.invalidValue, perClientOverrides: 0 }, { dataforseo: "working", ahrefs: "missing", semrush: "missing" }, { cli: "x", configuredByEnv: false });
    const { resolveProvider } = await import("../src/providers/seo-data.js");
    const routed = resolveProvider({ slug: "example.com" }, "keywordVolume", { defaultProvider: { invalid: KEY }, configured: { dataforseo: true, ahrefs: false, semrush: false } });
    for (const text of [JSON.stringify(r), JSON.stringify(row), JSON.stringify(routed)]) expect(text).not.toContain(KEY);
  });

  it("the server's stderr line hides it", async () => {
    const home = mkdtempSync(join(tmpdir(), "crawlmark-sec3-"));
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", join(root, "src", "index.ts")], {
      encoding: "utf8",
      timeout: 60_000,
      input: "",
      env: { ...process.env, CRAWLMARK_HOME: home, SEO_DATA_PROVIDER: KEY },
    });
    expect(r.stderr).toContain(`crawlmark: SEO_DATA_PROVIDER is (hidden, ${KEY.length} characters), which isn't a provider crawlmark knows.`);
    expect(r.stderr + r.stdout).not.toContain(KEY);
  }, 60_000);
});
