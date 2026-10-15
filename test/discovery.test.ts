import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POSIX_MODES } from "./platform.js";

/**
 * src/providers/discovery.ts and src/clients.ts against a mocked googleapis
 * (fixture payloads, no network) and the real SQLite cache in a temp DATA_DIR.
 * Each test uses its own auth identity, so cache entries don't leak between tests.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (p: string) => JSON.parse(readFileSync(join(here, "fixtures/google", p), "utf8"));

// Set before src/config.ts loads (imported dynamically below; it never overrides set variables).
const tmp = mkdtempSync(join(tmpdir(), "crawlmark-discovery-"));
process.env.DATA_DIR = tmp;
const clientsFile = join(tmp, "config", "clients.yaml");
process.env.CLIENTS_FILE = clientsFile;

const state = vi.hoisted(() => ({
  identity: "",
  configured: true,
  modeNote: undefined as string | undefined,
  calls: { sites: 0, summaries: 0, streams: [] as string[] },
  failStreams: new Set<string>(),
  adminError: undefined as Error | undefined,
  sitesDelayMs: 0,
  fixtures: {} as { sites: unknown; summaries: unknown; streams: Record<string, unknown> },
  gtm: {
    accounts: { account: [] } as unknown,
    containers: {} as Record<string, unknown>,
    accountsError: undefined as Error | undefined,
    failAccounts: new Set<string>(),
    calls: { accounts: 0, containers: 0 },
  },
}));

vi.mock("googleapis", () => ({
  google: {
    searchconsole: () => ({
      sites: {
        list: async () => {
          state.calls.sites++;
          if (state.sitesDelayMs) await new Promise((r) => setTimeout(r, state.sitesDelayMs));
          return { data: state.fixtures.sites };
        },
      },
    }),
    tagmanager: () => ({
      accounts: {
        list: async () => {
          state.gtm.calls.accounts++;
          if (state.gtm.accountsError) throw state.gtm.accountsError;
          return { data: state.gtm.accounts };
        },
        containers: {
          list: async ({ parent }: { parent: string }) => {
            state.gtm.calls.containers++;
            const id = parent.replace("accounts/", "");
            if (state.gtm.failAccounts.has(id)) throw new Error(`containers failed for ${id}`);
            return { data: state.gtm.containers[id] ?? {} };
          },
        },
      },
    }),
    analyticsadmin: () => ({
      accountSummaries: {
        list: async () => {
          state.calls.summaries++;
          if (state.adminError) throw state.adminError;
          return { data: state.fixtures.summaries };
        },
      },
      properties: {
        dataStreams: {
          list: async ({ parent }: { parent: string }) => {
            const id = parent.replace("properties/", "");
            state.calls.streams.push(id);
            if (state.failStreams.has(id)) throw new Error(`stream lookup failed for ${id}`);
            return { data: state.fixtures.streams[id] ?? {} };
          },
        },
      },
    }),
  },
}));

vi.mock("../src/providers/google.js", () => ({
  googleAuth: () => ({}),
  googleAuthIdentity: () => state.identity,
  googleConfigured: () => state.configured,
  googleAuthModeNote: () => state.modeNote,
  assertGoogleConfigured: () => {},
  googleAuthStatus: () => ({ mode: "service_account", auto: false, configured: true, email: "crawlmark@example-project.iam.gserviceaccount.com" }),
}));

state.fixtures = {
  sites: fixture("sites-list.json"),
  summaries: fixture("account-summaries.json"),
  streams: Object.fromEntries(
    ["99999999", "300000002", "200000001", "400000001"].map((id) => [id, fixture(`data-streams/${id}.json`)]),
  ),
};

const { listGa4Properties, listGscSites } = await import("../src/providers/discovery.js");
const { addClient, loadRegistry, removeClient, resolveClient } = await import("../src/clients.js");
const { ADMIN_API_DISABLED_WARNING } = await import("../src/lib/clients.js");

beforeEach(() => {
  state.calls = { sites: 0, summaries: 0, streams: [] };
  state.failStreams = new Set();
  state.adminError = undefined;
  state.sitesDelayMs = 0;
  state.configured = true;
  state.modeNote = undefined;
  state.gtm.accounts = { account: [] };
  state.gtm.containers = {};
  state.gtm.accountsError = undefined;
  state.gtm.failAccounts = new Set();
  state.gtm.calls = { accounts: 0, containers: 0 };
  rmSync(clientsFile, { force: true });
});

const fileText = () => readFileSync(clientsFile, "utf8");

describe("listGa4Properties", () => {
  it("doesn't cache a failing stream lookup, but caches the others", async () => {
    state.identity = "test:streams";
    state.failStreams.add("200000001");

    const first = await listGa4Properties();
    expect(first.fromCache).toBe(false);
    expect(first.value.errors).toEqual([
      "GA4 property 200000001 (Example Net): could not list data streams: stream lookup failed for 200000001",
    ]);
    expect(first.value.properties.map((p) => p.propertyId)).toEqual(["300000002", "99999999", "400000001"]);
    expect([...state.calls.streams].sort()).toEqual(["200000001", "300000002", "400000001", "99999999"]);

    // Next call: only the failed property is fetched again; the summary list is cached.
    state.failStreams.clear();
    state.calls.streams = [];
    const second = await listGa4Properties();
    expect(state.calls.summaries).toBe(1);
    expect(state.calls.streams).toEqual(["200000001"]);
    expect(second.value.errors).toEqual([]);
    expect(second.value.properties).toHaveLength(4);
    expect(second.fromCache).toBe(false); // one stream list was fetched fresh

    state.calls.streams = [];
    const third = await listGa4Properties();
    expect(state.calls.streams).toEqual([]);
    expect(third.fromCache).toBe(true);
  });

  it("refresh bypasses every cached list", async () => {
    state.identity = "test:refresh";
    await listGa4Properties();
    state.calls = { sites: 0, summaries: 0, streams: [] };
    const fresh = await listGa4Properties({ refresh: true });
    expect(fresh.fromCache).toBe(false);
    expect(state.calls.summaries).toBe(1);
    expect(state.calls.streams).toHaveLength(4);
  });
});

describe("listGscSites", () => {
  it("caches per identity", async () => {
    state.identity = "test:identity-a";
    expect((await listGscSites()).fromCache).toBe(false);
    expect((await listGscSites()).fromCache).toBe(true);
    expect(state.calls.sites).toBe(1);

    state.identity = "test:identity-b";
    const other = await listGscSites();
    expect(other.fromCache).toBe(false);
    expect(state.calls.sites).toBe(2);
    expect(other.value).toHaveLength(6);
  });
});

describe("loadRegistry", () => {
  it("keeps Search Console clients and warns when the Admin API is disabled", async () => {
    state.identity = "test:admin-disabled";
    state.adminError = new Error(
      "Google Analytics Admin API has not been used in project 123456 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/analyticsadmin.googleapis.com/overview?project=123456 then retry.",
    );
    const r = await loadRegistry();
    expect(r.discovery.ok).toBe(true);
    expect(r.discovery.warnings).toEqual([ADMIN_API_DISABLED_WARNING]);
    expect(r.clients.map((c) => [c.domain, c.sources])).toEqual([
      ["example.com", ["gsc", "yaml"]],
      ["example.org", ["gsc", "yaml"]],
      ["shop.example.com", ["gsc", "yaml"]],
    ]);
    expect(r.clientsFile.added).toEqual(["example.com", "example.org", "shop.example.com"]);
    // The failure isn't cached: once the API is enabled, GA4 shows up without a refresh,
    // and the existing entry gets its missing ga4PropertyId filled.
    state.adminError = undefined;
    const after = await loadRegistry();
    expect(after.discovery.warnings).toEqual([]);
    expect(after.clientsFile.added).toEqual(["example.net"]);
    expect(after.clientsFile.filled).toEqual(["example.com ga4PropertyId"]);
    expect(after.clients.find((c) => c.domain === "example.com")!.ga4PropertyId).toBe("99999999");
  });

  it("aggregates fromCache across both sources", async () => {
    state.identity = "test:aggregate";
    expect((await loadRegistry()).fromCache).toBe(false);
    expect((await loadRegistry()).fromCache).toBe(true);
  });

  it("shares one discovery run between concurrent calls", async () => {
    state.identity = "test:coalesce";
    state.sitesDelayMs = 20;
    const results = await Promise.all([loadRegistry(), loadRegistry(), loadRegistry()]);
    expect(state.calls.sites).toBe(1);
    expect(state.calls.summaries).toBe(1);
    expect(results.every((r) => r.clients.length === 4)).toBe(true);
    // One run, one write: only the shared run reports the additions.
    expect(results.map((r) => r.clientsFile.added.length)).toEqual([4, 4, 4]);

    // Once settled, the memo is cleared: a refresh starts a new run.
    await loadRegistry({ refresh: true });
    expect(state.calls.sites).toBe(2);
  });
});

describe("clients.yaml persistence", () => {
  it("creates clients.yaml with the discovered domains, then leaves it alone", async () => {
    state.identity = "test:persist";
    expect(existsSync(clientsFile)).toBe(false);
    const first = await loadRegistry();
    expect(first.clientsFile).toMatchObject({ exists: true, added: ["example.com", "example.net", "example.org", "shop.example.com"], filled: [] });
    const text = fileText();
    expect(text).toContain("crawlmark clients.");
    expect(text).toContain('  example.com:\n    domain: example.com\n    name: Example Co\n    gscProperty: sc-domain:example.com\n    ga4PropertyId: "99999999"\n');
    const mtime = statSync(clientsFile).mtimeMs;

    const second = await loadRegistry();
    expect(second.clientsFile).toMatchObject({ added: [], filled: [] });
    expect(fileText()).toBe(text);
    expect(statSync(clientsFile).mtimeMs).toBe(mtime);
    expect(second.clients.map((c) => c.domain)).toEqual(first.clients.map((c) => c.domain));
  });

  it("never changes user values and keeps undiscovered entries", async () => {
    state.identity = "test:persist-user";
    writeFileSync(
      clientsFile,
      "# mine\nclients:\n  example-co:\n    domain: example.com\n    name: Mine\n    gscProperty: https://www.example.com/\n  manual.example:\n    domain: manual.example\n",
    );
    const r = await loadRegistry();
    const text = fileText();
    expect(text.startsWith("# mine\n")).toBe(true);
    expect(text).toContain("    gscProperty: https://www.example.com/\n");
    expect(r.clientsFile.filled).toEqual(["example.com ga4PropertyId"]);
    expect(r.clientsFile.added).toEqual(["example.net", "example.org", "shop.example.com"]);
    const c = r.clients.find((x) => x.domain === "example.com")!;
    expect([c.name, c.gscProperty, c.ga4PropertyId, c.aliases]).toEqual(["Mine", "https://www.example.com/", "99999999", ["example-co"]]);
    expect(r.clients.find((x) => x.domain === "manual.example")!.sources).toEqual(["yaml"]);
    expect(r.discovery.notes).toContain("example.com: clients.yaml pins gscProperty https://www.example.com/; discovery would pick sc-domain:example.com.");
  });

  it("doesn't write when clients.yaml is invalid", async () => {
    state.identity = "test:persist-invalid";
    writeFileSync(clientsFile, "clients:\n  bad:\n    name: no domain\n");
    await expect(loadRegistry()).rejects.toThrow(/clients\.bad\.domain/);
    expect(fileText()).toBe("clients:\n  bad:\n    name: no domain\n");
  });
});

const useGtmFixtures = () => {
  state.gtm.accounts = fixture("gtm-accounts.json");
  state.gtm.containers = fixture("gtm-containers.json");
};

describe("Tag Manager discovery", () => {
  it("matches containers to clients by domain and writes the ids to clients.yaml, fill only", async () => {
    state.identity = "test:gtm-sync";
    useGtmFixtures();
    writeFileSync(
      clientsFile,
      'clients:\n  example.net:\n    domain: example.net\n    gtmContainerId: "555"\n  example.org:\n    domain: example.org\n    gscProperty: https://example.org/\n',
    );
    const r = await loadRegistry();
    const com = r.clients.find((c) => c.domain === "example.com")!;
    expect([com.gtmAccountId, com.gtmContainerId]).toEqual(["6000000001", "7000000001"]);
    expect(r.clientsFile.added).toContain("example.com");
    expect(fileText()).toMatch(/example\.com:\n {4}domain: example\.com\n(?: {4}.*\n)* {4}gtmAccountId: "6000000001"\n {4}gtmContainerId: "7000000001"\n/);
    // example.net pins a container, so discovery leaves it alone (and doesn't invent an account).
    const net = r.clients.find((c) => c.domain === "example.net")!;
    expect([net.gtmAccountId, net.gtmContainerId]).toEqual([undefined, "555"]);
    // The unmatched web container is listed as a note.
    expect(r.discovery.notes.some((n) => n.includes("GTM-EXAMPL2") && n.includes("no domain"))).toBe(true);
    // example.org has only a server container (skipped), so it gets nothing.
    expect(r.clients.find((c) => c.domain === "example.org")!.gtmContainerId).toBeUndefined();

    const text = fileText();
    await loadRegistry();
    expect(fileText()).toBe(text);
  });

  it("matches a container that lists no domains by its name, and says so in the notes", async () => {
    state.identity = "test:gtm-by-name";
    state.gtm.accounts = fixture("gtm-accounts.json");
    state.gtm.containers = fixture("gtm-containers-by-name.json");
    const r = await loadRegistry();
    const com = r.clients.find((c) => c.domain === "example.com")!;
    expect([com.gtmAccountId, com.gtmContainerId]).toEqual(["6000000001", "7000000011"]);
    expect(r.discovery.notes).toContain(
      'Tag Manager: matched GTM-NAMED01 "www.example.com/" to example.com by its name (the container lists no domains). If that\'s wrong, pin another with gtmContainerId in clients.yaml.',
    );
    // The container whose name isn't a host stays unmatched, with its numeric container ID shown for pinning.
    expect(r.discovery.notes.some((n) => n.includes('GTM-EXAMPL2 "No domains" (account 6000000001, container 7000000002)'))).toBe(true);
  });

  it("fills a missing pair on an existing entry", async () => {
    state.identity = "test:gtm-fill";
    useGtmFixtures();
    writeFileSync(clientsFile, "clients:\n  example.com:\n    domain: example.com\n    gscProperty: sc-domain:example.com\n");
    const r = await loadRegistry();
    expect(r.clientsFile.filled).toEqual(expect.arrayContaining(["example.com gtmAccountId", "example.com gtmContainerId"]));
    expect(fileText()).toContain('    gtmAccountId: "6000000001"\n    gtmContainerId: "7000000001"\n');
  });

  it("a Tag Manager failure never breaks client discovery; it becomes a note", async () => {
    state.identity = "test:gtm-fail";
    state.gtm.accountsError = new Error("Tag Manager API has not been used in project 1 before or it is disabled.");
    const r = await loadRegistry();
    expect(r.discovery.ok).toBe(true);
    expect(r.clients.map((c) => c.domain)).toContain("example.com");
    expect(r.discovery.notes.some((n) => n.startsWith("Tag Manager containers could not be listed") && n.includes("Tag Manager API is disabled"))).toBe(true);
    expect(r.clients.every((c) => c.gtmContainerId === undefined)).toBe(true);
    // The failure is remembered, so the next call doesn't hit the API again.
    const before = state.gtm.calls.accounts;
    await loadRegistry();
    expect(state.gtm.calls.accounts).toBe(before);
    await loadRegistry({ refresh: true });
    expect(state.gtm.calls.accounts).toBe(before + 1);
  });

  it("keeps the containers it could list when one account fails, and doesn't cache the failure", async () => {
    state.identity = "test:gtm-partial";
    useGtmFixtures();
    state.gtm.failAccounts.add("6000000002");
    const r = await loadRegistry();
    expect(r.discovery.notes.some((n) => n.includes("account 6000000002") && n.includes("could not list containers"))).toBe(true);
    expect(r.clients.find((c) => c.domain === "example.com")!.gtmContainerId).toBe("7000000001");
    state.gtm.failAccounts.clear();
    const callsBefore = state.gtm.calls.containers;
    await loadRegistry();
    // Account 6000000001 came from the cache; only the failed account is retried.
    expect(state.gtm.calls.containers).toBe(callsBefore + 1);
  });

  it("finding no containers at all is not an error", async () => {
    state.identity = "test:gtm-none";
    const r = await loadRegistry();
    expect(r.discovery.ok).toBe(true);
    expect(r.discovery.notes.filter((n) => n.startsWith("Tag Manager"))).toEqual([]);
  });
});

describe("manual clients (no Google)", () => {
  it("skips discovery quietly and serves clients.yaml entries", async () => {
    state.configured = false;
    const empty = await loadRegistry();
    expect(empty.discovery).toMatchObject({ ok: false, skipped: true, warnings: [] });
    expect(empty.discovery.info).toMatch(/Google isn't set up/);
    expect(empty.clients).toEqual([]);
    expect(existsSync(clientsFile)).toBe(false); // nothing to persist
    expect(state.calls.sites + state.calls.summaries).toBe(0);

    expect(await addClient("https://www.Manual.example/", "Manual Co")).toEqual({ status: "added", domain: "manual.example", key: "manual.example" });
    expect(await addClient("manual.example")).toMatchObject({ status: "exists" });
    const c = await resolveClient("www.manual.example");
    expect([c.domain, c.name, c.keyPages, c.gscProperty, c.ga4PropertyId]).toEqual([
      "manual.example",
      "Manual Co",
      ["https://manual.example/"],
      undefined,
      undefined,
    ]);
    await expect(resolveClient("other.example")).rejects.toThrow(/crawlmark-cli clients add other\.example/);
    await expect(addClient("not a domain")).rejects.toThrow(/not a domain/);
  });

  it("removes an entry, or hides it for good with ignore", async () => {
    state.identity = "test:remove";
    await loadRegistry(); // discovery writes the four domains
    expect(await removeClient("example.org")).toEqual({ status: "removed", domain: "example.org" });
    expect(fileText()).not.toContain("example.org:");
    // Still discovered, so the next run adds it back...
    expect((await loadRegistry()).clientsFile.added).toEqual(["example.org"]);
    // ...unless it's ignored.
    expect(await removeClient("https://example.org/", { ignore: true })).toEqual({ status: "ignored", domain: "example.org" });
    const r = await loadRegistry();
    expect(r.clientsFile.added).toEqual([]);
    expect(r.ignored).toEqual(["example.org"]);
    expect(r.clients.map((c) => c.domain)).not.toContain("example.org");
    await expect(resolveClient("example.org")).rejects.toThrow(/ignore: true/);
    // Adding it again clears ignore.
    expect(await addClient("example.org")).toMatchObject({ status: "unignored" });
    expect((await loadRegistry()).clients.map((c) => c.domain)).toContain("example.org");
    expect(await removeClient("nothing.example")).toEqual({ status: "not-found", domain: "nothing.example" });
  });
});

describe("review follow-ups", () => {
  it("resolves an ignored entry's key to the ignore error", async () => {
    state.configured = false;
    writeFileSync(clientsFile, "clients:\n  hidden-co:\n    domain: hidden.example\n    ignore: true\n");
    await expect(resolveClient("hidden-co")).rejects.toThrow(/hidden\.example is marked ignore: true/);
    await expect(resolveClient("https://www.hidden.example/")).rejects.toThrow(/marked ignore: true/);
    await expect(resolveClient("nope.example")).rejects.toThrow(/Unknown client/);
  });

  it("puts the auth-mode note in the discovery info", async () => {
    state.identity = "test:note";
    state.modeNote = "OAuth vars ignored.";
    const r = await loadRegistry();
    expect(r.discovery.info).toBe("OAuth vars ignored.");
  });

  it("does not report an empty-string fill again once it has been filled", async () => {
    state.identity = "test:empty-fill";
    writeFileSync(clientsFile, 'clients:\n  example.com:\n    domain: example.com\n    gscProperty: ""\n');
    expect((await loadRegistry()).clientsFile.filled).toEqual(["example.com gscProperty", "example.com ga4PropertyId"]);
    expect((await loadRegistry()).clientsFile.filled).toEqual([]);
  });

  it("writes through a symlinked clients.yaml and keeps the target's permissions", async () => {
    state.configured = false;
    const target = join(tmp, "real-clients.yaml");
    writeFileSync(target, "# shared\nclients: {}\n", { mode: 0o600 });
    symlinkSync(target, clientsFile);
    await addClient("example.com");
    expect(lstatSync(clientsFile).isSymbolicLink()).toBe(true);
    if (POSIX_MODES) expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readFileSync(target, "utf8")).toContain("# shared\nclients:\n  example.com:\n    domain: example.com\n");
    rmSync(target);
  });
});
