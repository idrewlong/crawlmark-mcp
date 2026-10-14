/**
 * Phase 12 C4: the local_profile, local_pack and local_reviews tools and the clients.yaml gbpPlaceId field.
 * A temp clients.yaml (test/setup.ts) and a stubbed fetch on the closed local port answering with the
 * hand-built fixtures. No real network; the tools never write clients.yaml.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseOverrides } from "../src/lib/clients.js";

const fx = (name: string) => readFileSync(new URL(`./fixtures/dataforseo/${name}`, import.meta.url), "utf8");
const BY_PATH: Record<string, string> = {
  "/v3/business_data/google/my_business_info/live": fx("business_data_google_my_business_info_live.json"),
  "/v3/serp/google/maps/live/advanced": fx("serp_google_maps_live_advanced.json"),
  "/v3/business_data/google/reviews/task_post": fx("business_data_google_reviews_task_post.json"),
};
const READY = fx("business_data_google_reviews_task_get.json");

function stubDfs(): string[] {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(String(input));
      if (url.hostname !== "127.0.0.1") throw new Error(`test tried to reach a real host: ${url.hostname}`);
      paths.push(url.pathname);
      if (url.pathname.startsWith("/v3/business_data/google/reviews/task_get/")) return new Response(READY);
      const body = BY_PATH[url.pathname];
      return body ? new Response(body) : new Response("{}", { status: 404 });
    }),
  );
  return paths;
}
afterEach(() => vi.unstubAllGlobals());

type Cb = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
async function loadTools(): Promise<{ tools: Record<string, Cb>; meta: Record<string, { annotations?: unknown; description?: string }> }> {
  vi.resetModules();
  const { registerLocalTools } = await import("../src/tools/local.js");
  const tools: Record<string, Cb> = {};
  const meta: Record<string, { annotations?: unknown; description?: string }> = {};
  registerLocalTools({ registerTool: (n: string, d: { annotations?: unknown; description?: string }, c: Cb) => void ((tools[n] = c), (meta[n] = d)) } as never);
  return { tools, meta };
}
const clientsFile = () => process.env.CLIENTS_FILE!;
const json = (r: { content: { text: string }[]; isError?: boolean }) => {
  expect(r.isError, r.content[0]!.text).toBeUndefined();
  return JSON.parse(r.content[0]!.text);
};

describe("local tools", () => {
  it("are read-only, titled, and say they're paid, estimate-first and DataForSEO only", async () => {
    const { meta } = await loadTools();
    expect(Object.keys(meta).sort()).toEqual(["local_pack", "local_profile", "local_reviews"]);
    for (const m of Object.values(meta)) {
      expect(m.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
      expect(m.description).toMatch(/Paid: .*estimateOnly: true first\. DataForSEO only\./);
    }
    expect(meta.local_profile!.description).toMatch(/never saves anything/);
    const query = (meta.local_profile as unknown as { inputSchema: { query: { description?: string } } }).inputSchema.query;
    expect(query.description).toMatch(/Ignored while the client has a saved gbpPlaceId.*clear it with set_client_profile gbpPlaceId/);
    expect(meta.local_reviews!.description).toMatch(/Reviewer names, profiles and photos are never returned/);
  });

  it("local_profile estimate, then the lookup; clients.yaml is never written", async () => {
    const yaml = "# mine\nclients:\n  example.com:\n    domain: example.com\n    name: Example Plumbing\n    area: Smallville,Kansas,United States\n";
    writeFileSync(clientsFile(), yaml);
    const paths = stubDfs();
    const { tools } = await loadTools();
    expect(json(await tools.local_profile!({ client: "example.com", estimateOnly: true }))).toMatchObject({ estimateOnly: true, estimate: { usd: 0.0054, requests: 1 } });
    expect(paths).toEqual([]);
    const r = json(await tools.local_profile!({ client: "www.example.com" }));
    expect(r).toMatchObject({ matched: { placeId: "ChIJexamplePlaceId000001" }, domainMatchesClient: true, saved: { gbpPlaceId: null } });
    expect(readFileSync(clientsFile(), "utf8")).toBe(yaml);
  });

  it("local_reviews refuses without a confirmed place ID; with one it returns reviews without reviewer data", async () => {
    writeFileSync(clientsFile(), "clients:\n  example.com:\n    domain: example.com\n    area: Smallville,Kansas,United States\n  example.org:\n    domain: example.org\n    area: Smallville,Kansas,United States\n    gbpPlaceId: ChIJexamplePlaceId000001\n");
    stubDfs();
    const { tools } = await loadTools();
    const refused = await tools.local_reviews!({ client: "example.com" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/confirmed Google Business Profile/);
    const r = await tools.local_reviews!({ client: "example.org", depth: 10 });
    expect(json(r).reviews).toHaveLength(3);
    expect(r.content[0]!.text).not.toMatch(/Jane|profile_name|contrib/);
  });

  it("local_pack takes keywords and depth", async () => {
    writeFileSync(clientsFile(), "clients:\n  example.com:\n    domain: example.com\n    area: Smallville,Kansas,United States\n");
    stubDfs();
    const { tools } = await loadTools();
    const r = json(await tools.local_pack!({ client: "example.com", keywords: ["plumber smallville"], depth: 10 }));
    expect(r).toMatchObject({ depth: 10, matchedBy: "domain", results: [{ keyword: "plumber smallville", clientRank: 4 }] });
  });
});

describe("clients.yaml gbpPlaceId", () => {
  it("parses a place ID and refuses anything else", () => {
    const [c] = parseOverrides({ clients: { "example.com": { domain: "example.com", gbpPlaceId: "ChIJexamplePlaceId000001" } } });
    expect(c!.gbpPlaceId).toBe("ChIJexamplePlaceId000001");
    expect(() => parseOverrides({ clients: { "example.com": { domain: "example.com", gbpPlaceId: "place id; rm" } } })).toThrow(/gbpPlaceId: must be a Google place ID/);
  });

  it("set_client_profile stores it (keeping comments), \"\" clears it, a bad value is refused", async () => {
    writeFileSync(clientsFile(), "# keep me\nclients:\n  example.com:\n    domain: example.com # inline\n");
    vi.resetModules();
    const { setClientProfile } = await import("../src/clients.js");
    const set = await setClientProfile("example.com", { gbpPlaceId: " ChIJexamplePlaceId000001 " }, { trustedPlaceId: true });
    expect(set).toMatchObject({ set: { gbpPlaceId: "ChIJexamplePlaceId000001" }, profile: { gbpPlaceId: "ChIJexamplePlaceId000001" } });
    const text = readFileSync(clientsFile(), "utf8");
    expect(text).toContain("# keep me");
    expect(parseYaml(text).clients["example.com"].gbpPlaceId).toBe("ChIJexamplePlaceId000001");
    await expect(setClientProfile("example.com", { gbpPlaceId: "bad\u0007id" })).rejects.toThrow(/is not a Google place ID/);
    const cleared = await setClientProfile("example.com", { gbpPlaceId: "" });
    expect(cleared).toMatchObject({ cleared: ["gbpPlaceId"], profile: { gbpPlaceId: null } });
    expect(parseYaml(readFileSync(clientsFile(), "utf8")).clients["example.com"].gbpPlaceId).toBeUndefined();
  });

  it("SEC-2: set_client_profile (MCP) accepts only a place ID local_profile showed for this client", async () => {
    writeFileSync(clientsFile(), "clients:\n  example.net:\n    domain: example.net\n    name: Example Plumbing\n    area: Thirdtown,Kansas,United States\n  example.edu:\n    domain: example.edu\n");
    stubDfs();
    const { tools } = await loadTools();
    const { registerCompetitorTools } = await import("../src/tools/competitors.js");
    let setProfile: Cb | undefined;
    registerCompetitorTools({ registerTool: (n: string, _d: unknown, c: Cb) => void (n === "set_client_profile" && (setProfile = c)) } as never);
    // Before any lookup: refused, nothing written.
    const before = await setProfile!({ client: "example.net", gbpPlaceId: "ChIJexamplePlaceId000001" });
    expect(before.isError).toBe(true);
    expect(before.content[0]!.text).toMatch(/Run local_profile for this client first and confirm the match with the user/);
    expect(parseYaml(readFileSync(clientsFile(), "utf8")).clients["example.net"].gbpPlaceId).toBeUndefined();
    // After local_profile showed it (and the other candidate): accepted.
    json(await tools.local_profile!({ client: "example.net" }));
    expect(json(await setProfile!({ client: "example.net", gbpPlaceId: "ChIJexamplePlaceId000001" }))).toMatchObject({ set: { gbpPlaceId: "ChIJexamplePlaceId000001" } });
    // Candidates are per client: example.org never looked it up.
    expect((await setProfile!({ client: "example.edu", gbpPlaceId: "ChIJexamplePlaceId000002" })).isError).toBe(true);
    // A well-formed ID the lookup never returned is refused; clearing is always allowed.
    expect((await setProfile!({ client: "example.net", gbpPlaceId: "ChIJsomethingElse0000001" })).isError).toBe(true);
    expect(json(await setProfile!({ client: "example.net", gbpPlaceId: "" }))).toMatchObject({ cleared: ["gbpPlaceId"] });
  });

  it("crawlmark-cli clients set --place-id saves and clears it (typed by the user: no lookup needed)", () => {
    const dir = mkdtempSync(join(tmpdir(), "crawlmark-placeid-cli-"));
    const file = join(dir, "clients.yaml");
    writeFileSync(file, "clients:\n  example.com:\n    domain: example.com\n");
    const run = (args: string[]) =>
      spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", join(import.meta.dirname, "..", "src", "cli.ts"), ...args], {
        encoding: "utf8",
        timeout: 45_000,
        killSignal: "SIGKILL",
        env: { ...process.env, CRAWLMARK_HOME: dir, CLIENTS_FILE: file, DATA_DIR: join(dir, "data") },
      });
    const ok = run(["clients", "set", "example.com", "--place-id", "ChIJexamplePlaceId000001"]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain("Google Business Profile place ID ChIJexamplePlaceId000001");
    expect(parseYaml(readFileSync(file, "utf8")).clients["example.com"].gbpPlaceId).toBe("ChIJexamplePlaceId000001");
    expect(run(["clients", "set", "example.com", "--place-id", "none"]).stdout).toContain("place ID (not set)");
  }, 105_000);
});
