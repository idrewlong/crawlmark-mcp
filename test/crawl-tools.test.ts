/** Phase 12 C1: the crawl tools register with the right annotations; local_crawl_pages reads a saved crawl (local only). */
import { describe, expect, it } from "vitest";
import type { CrawlPage } from "../src/analysis/crawl.js";
import { saveCrawl } from "../src/lib/crawls.js";
import { registerCrawlTools } from "../src/tools/crawl.js";

type Cb = (args: Record<string, unknown>, extra?: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
const tools = new Map<string, { def: { annotations: unknown }; cb: Cb }>();
registerCrawlTools({ registerTool: (name: string, def: { annotations: unknown }, cb: Cb) => void tools.set(name, { def, cb }) } as never);

const p = (url: string, o: Partial<CrawlPage> = {}): CrawlPage => ({ url, depth: 1, status: 200, finalUrl: url, finalStatus: 200, redirectChain: [], contentType: "text/html", title: "T", description: null, canonical: null, robots: null, noindex: false, h1Count: 1, inlinks: 1, outlinks: 2, firstLinkedFrom: null, parsed: true, issues: [], ...o });

describe("crawl tools", () => {
  it("registers both tools with local-write / local-read annotations", () => {
    expect(tools.get("local_crawl")!.def.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    expect(tools.get("local_crawl_pages")!.def.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
  });

  it("local_crawl_pages filters by issue and status and caps the list", async () => {
    saveCrawl({
      id: "crawl_tools1",
      client: "example.com",
      ranAt: Date.UTC(2026, 9, 1),
      settings: {},
      summary: {},
      exhaustive: true,
      pages: [p("https://example.com/a", { issues: ["missing-description"] }), p("https://example.com/b", { status: 404, finalStatus: 404, issues: ["broken-internal-link"] }), p("https://example.com/c", { issues: ["missing-description"] })],
    });
    const call = async (args: Record<string, unknown>) => JSON.parse((await tools.get("local_crawl_pages")!.cb(args)).content[0]!.text);
    const r = await call({ crawlId: "crawl_tools1", issue: "missing-description", limit: 1 });
    expect(r).toMatchObject({ crawlId: "crawl_tools1", client: "example.com", total: 2, exhaustive: true });
    expect(r.pages).toHaveLength(1);
    expect(Object.keys(r.pages[0]).sort()).toEqual(["canonical", "depth", "description", "h1Count", "inlinks", "issues", "outlinks", "redirectChain", "robots", "status", "title", "url"]);
    expect((await call({ crawlId: "crawl_tools1", status: 404 })).pages.map((x: { url: string }) => x.url)).toEqual(["https://example.com/b"]);
    const missing = await tools.get("local_crawl_pages")!.cb({ crawlId: "crawl_nope" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toMatch(/No saved crawl crawl_nope/);
  });
});
