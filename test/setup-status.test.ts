import { describe, expect, it, vi } from "vitest";
import type { GoogleAuthStatus } from "../src/lib/google-auth.js";
import type { DataForSeoStatusResult } from "../src/providers/dataforseo.js";
import { cachedStatus, collectSetupStatus, isApiDisabled, LINKS, type StatusProviders } from "../src/setup/status.js";

const CLI = "crawlmark-cli";

const sa: GoogleAuthStatus = { mode: "service_account", auto: true, configured: true, email: "svc@proj.iam.gserviceaccount.com", keyFile: "/h/secrets/k.json" };
const dfsOk: DataForSeoStatusResult = { credentialsConfigured: true, credentialsWork: true, reachable: true, mode: "sandbox", apiHost: "sandbox.dataforseo.com", balanceUsd: 12.5, totalUsd: 20, timezone: null, costUsd: 0 };

function providers(over: Partial<StatusProviders> = {}): StatusProviders {
  return {
    home: () => ({ info: { dir: "/h", source: "project", reason: "source checkout" }, exists: true, envFile: "/h/.env", envFileExists: true, configuredByEnv: false }),
    cli: () => CLI,
    dataforseo: async () => dfsOk,
    // Phase 9: Ahrefs not set up and not anyone's provider.
    ahrefs: async () => ({ check: { configured: false, works: false, reachable: true, error: "AHREFS_API_KEY is not set.", costUsd: 0 }, chosen: { byDefault: false, clients: 0 }, unitsUsedThisMonth: 0, cap: 50_000 }),
    seoDataProvider: () => ({ default: "dataforseo", source: "default", perClientOverrides: 0 }),
    semrush: async () => ({ check: { configured: false, works: false, reachable: true, error: "SEMRUSH_API_KEY is not set.", costUsd: 0 }, chosen: { byDefault: false, clients: 0 }, v4KeySet: false, unitsUsedThisMonth: 0, cap: 20_000 }),
    googleStatus: () => sa,
    googleLive: async () => ({ ok: true }),
    gscSites: async () => ({ items: ["sc-domain:example.com", "https://www.example.org/"] }),
    ga4Properties: async () => ({ items: [{ id: "123", name: "Example" }] }),
    gtmContainers: async () => ({ items: [{ publicId: "GTM-ABC", name: "Example" }] }),
    psiKeySet: () => false,
    chrome: async () => ({ ok: true, version: "Chrome/1" }),
    clients: () => ({ count: 2, ignored: 1, file: "/h/config/clients.yaml", exists: true }),
    ...over,
  };
}

const byId = async (p: StatusProviders, opts = {}) => Object.fromEntries((await collectSetupStatus(p, opts)).integrations.map((i) => [i.id, i]));

describe("setup_status", () => {
  it("everything working: states, counts, mode, balance and email; no next steps", async () => {
    const r = await collectSetupStatus(providers());
    const s = Object.fromEntries(r.integrations.map((i) => [i.id, i]));
    // Phase 12 adds the crux, bing and aivisibility rows (missing here: no CrUX or Bing key, AI visibility off).
    expect(r.integrations.map((i) => i.id)).toEqual(["home", "dataforseo", "seoprovider", "ahrefs", "semrush", "google", "gsc", "ga4", "tagmanager", "psi", "crux", "bing", "aivisibility", "chrome", "clients"]);
    expect(s.dataforseo).toMatchObject({ state: "working", next: null, data: { mode: "sandbox", balanceUsd: 12.5 } });
    expect(s.dataforseo!.detail).toContain("$12.50");
    expect(s.google).toMatchObject({ state: "working", data: { mode: "service_account", email: "svc@proj.iam.gserviceaccount.com" } });
    expect(s.gsc).toMatchObject({ state: "working", data: { count: 2 } });
    expect(s.ga4).toMatchObject({ state: "working", data: { count: 1 } });
    expect(s.tagmanager).toMatchObject({ state: "working", data: { count: 1, apiEnabled: true } });
    expect(s.psi).toMatchObject({ state: "missing", next: `${CLI} setup --step psi` });
    expect(s.chrome!.state).toBe("working");
    expect(s.clients).toMatchObject({ state: "working", data: { count: 2, ignored: 1 } });
    // Phase 9: the data-provider row works (DataForSEO by default); the optional Ahrefs and Semrush rows are "missing".
    expect(r.summary).toEqual({ working: 9, configured: 0, missing: 6, error: 0 });
    expect(r.costUsd).toBe(0);
    expect(JSON.stringify(r)).not.toMatch(/password|secret/i);
  });

  it("nothing set up: every next step is a command or a URL", async () => {
    const r = await collectSetupStatus(
      providers({
        home: () => ({ info: { dir: "/u/.crawlmark", source: "user", reason: "installed" }, exists: false, envFile: "/u/.crawlmark/.env", envFileExists: false, configuredByEnv: false }),
        dataforseo: async () => ({ credentialsConfigured: false, credentialsWork: false, reachable: true, mode: "sandbox", apiHost: "x", error: "not set", costUsd: 0 }),
        googleStatus: () => ({ mode: "none", auto: true, configured: false, problem: "Google isn't set up" }),
        googleLive: vi.fn(),
        chrome: async () => ({ ok: false, error: "Could not find Chrome" }),
        clients: () => ({ count: 0, ignored: 0, file: "/u/.crawlmark/config/clients.yaml", exists: false }),
      }),
    );
    for (const i of r.integrations) {
      expect(i.state, i.id).not.toBe("working");
      expect(i.next, i.id).toMatch(/^(crawlmark-cli |npx |https:\/\/)/);
      expect(i.next, i.id).not.toMatch(/paste/i);
    }
    const s = Object.fromEntries(r.integrations.map((i) => [i.id, i]));
    expect(s.home).toMatchObject({ state: "missing", next: `${CLI} setup` });
    expect(s.dataforseo).toMatchObject({ state: "missing", next: `${CLI} setup --step dataforseo` });
    expect(s.google).toMatchObject({ state: "missing", next: `${CLI} setup --step google` });
    expect(s.gsc!.state).toBe("missing");
    expect(s.chrome).toMatchObject({ state: "error", next: "npx puppeteer browsers install chrome" });
    expect(s.clients).toMatchObject({ state: "missing", next: `${CLI} clients add <domain>` });
  });

  it("the Chrome row names the binary in data and leaves the plain detail alone for the headless shell", async () => {
    const r = await collectSetupStatus(providers({ chrome: async () => ({ ok: true, version: "HeadlessChrome/1", binary: { kind: "headless-shell", label: "headless shell", path: "/c/chrome-headless-shell" } }) }));
    const chrome = r.integrations.find((i) => i.id === "chrome")!;
    expect(chrome.detail).toBe("Headless Chrome launches (HeadlessChrome/1).");
    expect(chrome.data).toEqual({ version: "HeadlessChrome/1", binary: "headless-shell", binaryLabel: "headless shell", path: "/c/chrome-headless-shell" });
  });

  it("home is working when settings come from the environment (e.g. a Desktop bundle) and there's no .env", async () => {
    const s = await byId(providers({ home: () => ({ info: { dir: "/u/.crawlmark", source: "user", reason: "installed" }, exists: false, envFile: "/u/.crawlmark/.env", envFileExists: false, configuredByEnv: true }) }), { only: ["home"] });
    expect(s.home).toMatchObject({ state: "working", next: null, data: { configuredByEnv: true } });
    expect(s.home!.detail).toContain("environment");
  });

  it("maps DataForSEO rejected vs unreachable", async () => {
    const rejected = await byId(providers({ dataforseo: async () => ({ credentialsConfigured: true, credentialsWork: false, reachable: true, mode: "live", apiHost: "api", error: "rejected", costUsd: 0 }) }), { only: ["dataforseo"] });
    expect(rejected.dataforseo).toMatchObject({ state: "error", next: `${CLI} setup --step dataforseo` });
    const down = await byId(providers({ dataforseo: async () => ({ credentialsConfigured: true, credentialsWork: null, reachable: false, mode: "live", apiHost: "api", error: "HTTP 503", costUsd: 0 }) }), { only: ["dataforseo"] });
    expect(down.dataforseo).toMatchObject({ state: "configured", next: LINKS.dataforseoStatus });
  });

  it("OAuth without a token points to auth login; a failed live check is an error for Google and everything that needs it", async () => {
    const noToken = await byId(providers({ googleStatus: () => ({ mode: "oauth", auto: true, configured: true, signedIn: false, tokenFile: "/t", problem: "Not signed in" }) }));
    expect(noToken.google).toMatchObject({ state: "error", next: `${CLI} auth login` });
    expect(noToken.gsc).toMatchObject({ state: "error", next: `${CLI} auth login` });

    const expired = await byId(providers({ googleLive: async () => ({ ok: false, error: "invalid_grant" }) }));
    expect(expired.google).toMatchObject({ state: "error", next: `${CLI} setup --step google` });
    expect(expired.ga4!.state).toBe("error");
  });

  it("disabled APIs point to the Cloud console; no properties points to sharing; GTM scope missing points to auth login", async () => {
    const disabled = new Error("Google Analytics Admin API has not been used in project 1 before or it is disabled.");
    const s = await byId(
      providers({
        gscSites: async () => ({ items: [] }),
        ga4Properties: async () => Promise.reject(disabled),
        gtmContainers: async () => Promise.reject(new Error("Tag Manager API has not been used in project 1 before or it is disabled (SERVICE_DISABLED)")),
      }),
    );
    expect(s.gsc).toMatchObject({ state: "configured", next: LINKS.searchConsoleUsers });
    expect(s.gsc!.detail).toContain("svc@proj.iam.gserviceaccount.com");
    expect(s.ga4).toMatchObject({ state: "error", next: LINKS.enableAnalyticsAdmin });
    expect(s.tagmanager).toMatchObject({ state: "error", next: LINKS.enableTagManager, data: { apiEnabled: false } });

    const noScope = await byId(providers({ googleStatus: () => ({ mode: "oauth", auto: false, configured: true, signedIn: true, tokenFile: "/t", email: "me@example.com" }), googleLive: async () => ({ ok: true, gtmScopeMissing: true, scopes: [] }) }));
    expect(noScope.google!.data).toMatchObject({ mode: "oauth", email: "me@example.com" });
    expect(noScope.tagmanager).toMatchObject({ state: "error", next: `${CLI} auth login` });
  });

  it("PSI key set is configured; an unreadable clients.yaml is an error, not a crash", async () => {
    const s = await byId(providers({ psiKeySet: () => true, clients: () => { throw new Error("Could not parse clients.yaml"); } }));
    expect(s.psi).toMatchObject({ state: "configured", next: null });
    expect(s.clients).toMatchObject({ state: "error", next: `${CLI} clients list` });
  });

  it("`only` limits the checks (no Chrome launch, no network) and lists are sampled", async () => {
    const chrome = vi.fn();
    const dataforseo = vi.fn();
    const many = Array.from({ length: 40 }, (_, i) => `sc-domain:site${i}.example`);
    const r = await collectSetupStatus(providers({ chrome, dataforseo, gscSites: async () => ({ items: many }) }), { only: ["gsc"] });
    expect(r.integrations.map((i) => i.id)).toEqual(["gsc"]);
    expect(chrome).not.toHaveBeenCalled();
    expect(dataforseo).not.toHaveBeenCalled();
    expect(r.integrations[0]!.data).toMatchObject({ count: 40 });
    expect((r.integrations[0]!.data!.sample as string[]).length).toBe(25);
  });

  it("caches for 60 seconds per `only`, and refresh bypasses", async () => {
    let t = 0;
    const dataforseo = vi.fn(async () => dfsOk);
    const status = cachedStatus(providers({ dataforseo }), 60_000, () => t);
    expect((await status()).fromCache).toBe(false);
    t = 30_000;
    expect((await status()).fromCache).toBe(true);
    expect((await status({ only: ["dataforseo"] })).fromCache).toBe(false);
    expect((await status({ refresh: true })).fromCache).toBe(false);
    t = 200_000;
    expect((await status()).fromCache).toBe(false);
    expect(dataforseo).toHaveBeenCalledTimes(4);
  });

  it("recognises disabled-API errors", () => {
    expect(isApiDisabled("SERVICE_DISABLED")).toBe(true);
    expect(isApiDisabled("Request had insufficient authentication scopes.")).toBe(false);
  });
});
