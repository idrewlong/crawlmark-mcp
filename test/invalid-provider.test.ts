/**
 * An unknown SEO_DATA_PROVIDER (D11): the server's modules load, setup_status reports the
 * seoprovider row as an error, and keyword_volume returns a tool error with the message
 * and makes no request. Everything runs in-process; fetch is stubbed.
 */
import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

process.env.SEO_DATA_PROVIDER = "moz";

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { registerRawTools } = await import("../src/tools/raw.js");
const { seoDefaultProvider } = await import("../src/config.js");
const { collectSetupStatus } = await import("../src/setup/status.js");
const { realStatusProviders } = await import("../src/setup/status-providers.js");

afterEach(() => vi.unstubAllGlobals());

describe("SEO_DATA_PROVIDER=moz", () => {
  it("loads without throwing and resolves to the invalid value", () => {
    expect(seoDefaultProvider).toMatchObject({ ok: false, invalidValue: "moz" });
  });

  it("setup_status's seoprovider row is an error with the message and the change command", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const r = await collectSetupStatus(realStatusProviders, { only: ["seoprovider"] });
    expect(r.integrations).toHaveLength(1);
    // test/setup.ts sets DataForSEO credentials in the process env, which reads as a bundle install,
    // and the invalid value came from the process env too: so `next` is the extension-settings field.
    expect(r.integrations[0]).toMatchObject({ id: "seoprovider", state: "error", next: 'Change "Default SEO data provider" in Claude Desktop > Settings > Extensions > Crawlmark' });
    expect(r.integrations[0]!.detail).toContain('SEO_DATA_PROVIDER is "moz"');
    expect(r.seoDataProvider).toMatchObject({ default: null, invalidValue: "moz", change: expect.stringMatching(/setup --step provider$/) });
  });

  it("keyword_volume returns a tool error with that message and makes no request", async () => {
    writeFileSync(process.env.CLIENTS_FILE!, "clients:\n  example.com:\n    domain: example.com\n");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const server = new McpServer({ name: "t", version: "0" });
    registerRawTools(server);
    const client = new Client({ name: "c", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const res = (await client.callTool({ name: "keyword_volume", arguments: { client: "example.com", keywords: ["example widgets"] } })) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/^Error: SEO_DATA_PROVIDER is "moz", which isn't a provider crawlmark knows\. Use dataforseo, ahrefs or semrush, or leave it blank for dataforseo\. Change it with: .* setup --step provider, or in Claude Desktop's extension settings\.$/);
    expect(fetch).not.toHaveBeenCalled();
    // serp_check (DataForSEO-only) is unaffected: it reaches DataForSEO (the stub) instead of failing on the provider.
    await client.callTool({ name: "serp_check", arguments: { client: "example.com", keyword: "example widgets" } });
    expect(fetch).toHaveBeenCalled();
  });
});
