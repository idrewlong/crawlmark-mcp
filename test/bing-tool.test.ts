/**
 * Phase 12 C3: the bing_report tool and the clients.yaml bingSite field. A temp clients.yaml (test/setup.ts),
 * a stubbed global fetch (no network) and a sentinel key that must never appear in a tool result, an error,
 * the cache or the tool_calls usage rows.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseOverrides } from "../src/lib/clients.js";

const KEY = "SENTINEL-bing-tool-key-9876543210";
const FIX = join(import.meta.dirname, "fixtures", "bing");
const BY_METHOD: Record<string, string> = {
  GetUserSites: "user-sites.json",
  GetRankAndTrafficStats: "traffic.json",
  GetQueryStats: "query-stats.json",
  GetPageStats: "page-stats.json",
  GetCrawlStats: "crawl-stats.json",
  GetCrawlIssues: "crawl-issues.json",
};

type Cb = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
async function loadTool(key: string | undefined): Promise<Cb> {
  vi.resetModules();
  if (key === undefined) delete process.env.BING_WEBMASTER_API_KEY;
  else process.env.BING_WEBMASTER_API_KEY = key;
  const { registerBingTools } = await import("../src/tools/bing.js");
  let cb: Cb | undefined;
  registerBingTools({ registerTool: (_n: string, _d: unknown, c: Cb) => void (cb = c) } as never);
  return cb!;
}

function stubBing() {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      urls.push(String(input));
      const m = new URL(String(input)).pathname.split("/").pop()!;
      const f = BY_METHOD[m];
      return f ? new Response(readFileSync(join(FIX, f), "utf8"), { status: 200 }) : new Response("{}", { status: 404 });
    }),
  );
  return urls;
}

const clientsFile = () => process.env.CLIENTS_FILE!;
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.BING_WEBMASTER_API_KEY;
});

describe("bing_report tool", () => {
  it("without a key it is unavailable with the setup step, and makes no request", async () => {
    writeFileSync(clientsFile(), "clients:\n  example.com:\n    domain: example.com\n");
    const urls = stubBing();
    const r = await (await loadTool(undefined))({ client: "example.com" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/BING_WEBMASTER_API_KEY.*setup --step bing/);
    expect(urls).toEqual([]);
  });

  it("returns the report; the key is absent from the result, cache and tool_calls", async () => {
    writeFileSync(clientsFile(), "clients:\n  example.com:\n    domain: example.com\n");
    const urls = stubBing();
    const tool = await loadTool(KEY);
    const r = await tool({ client: "https://www.example.com/page", days: 28, refresh: true });
    expect(r.isError, r.content[0]!.text).toBeUndefined();
    const data = JSON.parse(r.content[0]!.text);
    expect(data).toMatchObject({ site: "https://www.example.com/", totals: { clicks: 420 }, notes: ["Bing updates query stats weekly"] });
    expect(urls.every((u) => u.startsWith("http://127.0.0.1:9/Get"))).toBe(true);
    expect(r.content[0]!.text).not.toContain(KEY);
    const { db } = await import("../src/lib/store.js");
    expect(JSON.stringify(db.prepare("SELECT * FROM cache").all())).not.toContain(KEY);
    const calls = db.prepare("SELECT * FROM tool_calls WHERE tool = 'bing_report'").all();
    expect(calls.length).toBeGreaterThan(0);
    expect(JSON.stringify(calls)).not.toContain(KEY);
  });

  it("a client without a verified Bing site is an error naming bingSite; a pinned bingSite is used", async () => {
    writeFileSync(clientsFile(), "clients:\n  example.org:\n    domain: example.org\n  example.com:\n    domain: example.com\n    bingSite: http://example.com/\n");
    stubBing();
    const tool = await loadTool(KEY);
    const bad = await tool({ client: "example.org", refresh: true });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toMatch(/not verified.*--bing-site/);
    const pinned = JSON.parse((await tool({ client: "example.com", refresh: true })).content[0]!.text);
    expect(pinned).toMatchObject({ site: "http://example.com/", siteSource: "bingSite" });
  });
});

describe("clients set --bing-site (CLI)", () => {
  it("refuses a site on another host with exit 1 and writes nothing", async () => {
    const { spawnSync } = await import("node:child_process");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "crawlmark-bingsite-cli-"));
    const file = join(dir, "clients.yaml");
    writeFileSync(file, "clients:\n  example.com:\n    domain: example.com\n");
    const run = (args: string[]) =>
      spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", join(import.meta.dirname, "..", "src", "cli.ts"), ...args], {
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, CRAWLMARK_HOME: dir, CLIENTS_FILE: file, DATA_DIR: join(dir, "data") },
      });
    const bad = run(["clients", "set", "example.com", "--bing-site", "https://example.org/"]);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/isn't on example\.com/);
    expect(parseYaml(readFileSync(file, "utf8")).clients["example.com"].bingSite).toBeUndefined();
    const ok = run(["clients", "set", "example.com", "--bing-site", "https://www.example.com/"]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain("Bing site https://www.example.com/");
    expect(run(["clients", "set", "example.com", "--bing-site", "none"]).stdout).toContain("Bing site (matched by domain)");
  }, 60_000);
});

describe("clients.yaml bingSite", () => {
  it("parses an http(s) site URL and refuses anything else", () => {
    const [c] = parseOverrides({ clients: { "example.com": { domain: "example.com", bingSite: "https://www.example.com/" } } });
    expect(c!.bingSite).toBe("https://www.example.com/");
    expect(() => parseOverrides({ clients: { "example.com": { domain: "example.com", bingSite: "www.example.com" } } })).toThrow(/bingSite: must be an http\(s\) site URL/);
  });

  it("set_client_profile / clients set store it, keep comments, and \"\" clears it", async () => {
    writeFileSync(clientsFile(), "# keep me\nclients:\n  example.com:\n    domain: example.com # inline\n");
    vi.resetModules();
    const { setClientProfile } = await import("../src/clients.js");
    const set = await setClientProfile("example.com", { bingSite: " https://www.example.com/ " });
    expect(set.set).toEqual({ bingSite: "https://www.example.com/" });
    expect(set.profile).toMatchObject({ bingSite: "https://www.example.com/" });
    const text = readFileSync(clientsFile(), "utf8");
    expect(text).toContain("# keep me");
    expect(parseYaml(text).clients["example.com"].bingSite).toBe("https://www.example.com/");
    const cleared = await setClientProfile("example.com", { bingSite: "" });
    expect(cleared.cleared).toEqual(["bingSite"]);
    expect(cleared.profile.bingSite).toBeNull();
    await expect(setClientProfile("example.com", { bingSite: "ftp://example.com/" })).rejects.toThrow(/not a site URL/);
    // SEC-2: another host is refused (it would mix another site's data into this client's reports); subdomains are fine.
    await expect(setClientProfile("example.com", { bingSite: "https://example.net/" })).rejects.toThrow(/isn't on example\.com: it would show another site's Bing data/);
    expect(parseYaml(readFileSync(clientsFile(), "utf8")).clients["example.com"].bingSite).toBeUndefined();
    expect((await setClientProfile("example.com", { bingSite: "https://blog.example.com/" })).profile.bingSite).toBe("https://blog.example.com/");
    await setClientProfile("example.com", { bingSite: "" });
    // Untouched profile output keeps its old keys (additive only).
    expect((await setClientProfile("example.com", { niche: "plumber" })).profile).not.toHaveProperty("bingSite");
  });
});
