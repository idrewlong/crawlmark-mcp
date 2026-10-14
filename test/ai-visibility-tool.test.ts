/**
 * Phase 12 C5: the ai_visibility tool and the aivisibility setup_status row. No real network: DataForSEO is a
 * stubbed fetch on the closed local port; the status row is built from fake providers.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forHumans } from "../src/setup/status-render.js";
import { collectSetupStatus, type StatusProviders } from "../src/setup/status.js";

const MENTIONS = readFileSync(new URL("./fixtures/dataforseo/ai_optimization_llm_mentions_search_mentions_live.json", import.meta.url), "utf8");
type Cb = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;

async function loadTool(enabled: string | undefined) {
  vi.resetModules();
  if (enabled === undefined) delete process.env.AI_VISIBILITY_ENABLED;
  else process.env.AI_VISIBILITY_ENABLED = enabled;
  const { registerAiVisibilityTools } = await import("../src/tools/ai-visibility.js");
  let cb: Cb | undefined;
  let meta: { title?: string; description?: string; annotations?: unknown } = {};
  registerAiVisibilityTools({ registerTool: (_n: string, d: typeof meta, c: Cb) => void ((cb = c), (meta = d)) } as never);
  return { tool: cb!, meta };
}
function stub(): string[] {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(String(input));
      if (url.hostname !== "127.0.0.1") throw new Error(`real host: ${url.hostname}`);
      paths.push(url.pathname);
      return url.pathname.endsWith("/search_mentions/live") ? new Response(MENTIONS) : new Response("{}", { status: 404 });
    }),
  );
  return paths;
}
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AI_VISIBILITY_ENABLED;
});

describe("ai_visibility tool", () => {
  it("its description states the switch, the per-request minimum, the sub-cap, the $100 top-up and estimate-first", async () => {
    const { meta } = await loadTool(undefined);
    expect(meta.title).toBe("AI-search visibility");
    expect(meta.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
    expect(meta.description).toMatch(/OFF unless AI_VISIBILITY_ENABLED=true/);
    expect(meta.description).toMatch(/the minimum is \$0\.10 per request/);
    expect(meta.description).toMatch(/AI_VISIBILITY_MONTHLY_BUDGET_USD, default \$2/);
    expect(meta.description).toMatch(/\$100 monthly top-up/);
    expect(meta.description).toMatch(/Always call with estimateOnly: true first/);
    expect(meta.description).toMatch(/sandbox/);
  });

  it("off: an error with the enable instructions and no request", async () => {
    writeFileSync(process.env.CLIENTS_FILE!, "clients:\n  example.com:\n    domain: example.com\n");
    const paths = stub();
    const r = await (await loadTool(undefined)).tool({ client: "example.com", estimateOnly: true });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/AI-search visibility is off\..*AI_VISIBILITY_ENABLED=true/);
    expect(paths).toEqual([]);
  });

  it("on: estimate, then the call", async () => {
    writeFileSync(process.env.CLIENTS_FILE!, "clients:\n  example.com:\n    domain: example.com\n");
    const paths = stub();
    const { tool } = await loadTool("true");
    const e = JSON.parse((await tool({ client: "example.com", limit: 20, estimateOnly: true })).content[0]!.text);
    expect(e).toMatchObject({ estimateOnly: true, estimate: { usd: 0.12 } });
    expect(paths).toEqual([]);
    const r = await tool({ client: "www.example.com", limit: 20 });
    expect(r.isError, r.content[0]!.text).toBeUndefined();
    expect(JSON.parse(r.content[0]!.text)).toMatchObject({ mode: "mentions", total: 3 });
    expect(paths).toEqual(["/v3/ai_optimization/llm_mentions/search_mentions/live"]);
  });
});

function providers(ai: ReturnType<NonNullable<StatusProviders["aiVisibility"]>>): StatusProviders {
  return {
    cli: () => "crawlmark-cli",
    home: () => ({ info: { dir: "/h", source: "env", reason: "x" }, exists: true, envFile: "/h/.env", envFileExists: true, configuredByEnv: false }),
    dataforseo: async () => ({ credentialsConfigured: false, credentialsWork: false, reachable: true, mode: "sandbox", apiHost: "x", error: "not set", costUsd: 0 }),
    googleStatus: () => ({ mode: "none", auto: true, configured: false, problem: "none" }),
    googleLive: vi.fn(),
    gscSites: vi.fn(),
    ga4Properties: vi.fn(),
    gtmContainers: vi.fn(),
    psiKeySet: () => false,
    chrome: async () => ({ ok: true, version: "1" }),
    clients: () => ({ count: 0, ignored: 0, file: "/h/c.yaml", exists: false }),
    aiVisibility: () => ai,
  } as unknown as StatusProviders;
}
const row = async (ai: Parameters<typeof providers>[0]) => {
  const r = await collectSetupStatus(providers(ai), { only: ["aivisibility"] } as never);
  return { r, row: r.integrations.find((i) => i.id === "aivisibility")! };
};

describe("aivisibility setup_status row", () => {
  it("off: missing, with the cost and $100 warning and a docs link; hidden from human output", async () => {
    const { r, row: s } = await row({ enabled: false, raw: null, dataForSeo: true, capUsd: 2, spentUsd: 0 });
    expect(s).toMatchObject({ state: "missing", next: "https://github.com/idrewlong/crawlmark-mcp#ai-search-visibility-optional-paid", data: { enabled: false, capUsd: 2 } });
    expect(s.detail).toMatch(/Set AI_VISIBILITY_ENABLED=true .*at least \$0\.10 per request, capped at \$2 a month .*\$100 monthly top-up/);
    expect(forHumans({ ...r, fromCache: false }).integrations.map((i) => i.id)).not.toContain("aivisibility");
  });

  it("a value that isn't true or false is flagged (and shown)", async () => {
    const { r, row: s } = await row({ enabled: false, raw: "yes", dataForSeo: true, capUsd: 2, spentUsd: 0 });
    expect(s).toMatchObject({ state: "error", detail: expect.stringMatching(/isn't "true", so ai_visibility stays off/) });
    expect(forHumans({ ...r, fromCache: false }).integrations.map((i) => i.id)).toContain("aivisibility");
  });

  it("on: configured with this month's spend against the cap; without DataForSEO it's an error naming the step", async () => {
    const on = await row({ enabled: true, raw: "true", dataForSeo: true, capUsd: 2, spentUsd: 0.2234 });
    expect(on.row).toMatchObject({ state: "configured", detail: expect.stringMatching(/^On: \$0\.22 of \$2 spent this month\./) });
    const noDfs = await row({ enabled: true, raw: "true", dataForSeo: false, capUsd: 2, spentUsd: 0 });
    expect(noDfs.row).toMatchObject({ state: "error", next: expect.stringMatching(/setup --step dataforseo$/) });
  });
});
