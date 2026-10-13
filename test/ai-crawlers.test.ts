/**
 * AI crawler access in robots.txt: the access table (named vs `*` group, allowed / partial / blocked),
 * low findings for AI search/answer crawlers only, no double-reporting of robots-disallow-all or
 * robots-blocks-key-page, the siteHygiene integration, and the reconciliation with bots.ts.
 */
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.DATA_DIR ??= mkdtempSync(join(tmpdir(), "crawlmark-ai-crawlers-"));

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "../src/config.js";
import { AI_CRAWLERS, analyzeAiCrawlers } from "../src/analysis/ai-crawlers.js";
import { BOTS } from "../src/analysis/bots.js";
import { siteCheckUrl } from "../src/analysis/findings.js";
import { analyzeRobots } from "../src/analysis/hygiene.js";
import { siteHygiene } from "../src/reports/site-hygiene.js";

const ROBOTS = "https://example.com/robots.txt";
const HOME = "https://example.com/";
function run(text: string, keyPages: string[] = [], status = 200) {
  const fetched = { status, contentType: "text/plain", text };
  const robots = analyzeRobots(ROBOTS, fetched, keyPages);
  const ai = analyzeAiCrawlers(ROBOTS, robots.file, robots.robots, HOME, keyPages);
  const by = Object.fromEntries(ai.aiCrawlers.crawlers.map((c) => [c.bot, c]));
  return { ...ai, by, robotsFlags: robots.flags.map((f) => f.rule) };
}

describe("AI crawler table", () => {
  it("covers every AI crawler bots.ts knows, plus the robots-only tokens, with matching names", () => {
    const ai = new Set(AI_CRAWLERS.map((c) => c.bot));
    for (const b of BOTS.filter((x) => x.family.startsWith("ai-"))) expect(ai.has(b.bot), b.bot).toBe(true);
    expect([...ai]).toEqual(expect.arrayContaining(["anthropic-ai", "Applebot-Extended", "Google-Extended", "Amazonbot"]));
    expect(AI_CRAWLERS).toHaveLength(15);
    // Every token is the lowercased name, so a named group in robots.txt is found.
    for (const c of AI_CRAWLERS) expect(c.token).toBe(c.bot.toLowerCase());
  });

  it("with no robots.txt every crawler is allowed through no group", () => {
    const r = run("", [], 404);
    expect(r.aiCrawlers.robotsFound).toBe(false);
    expect(r.aiCrawlers.crawlers.every((c) => c.access === "allowed" && c.group === "none")).toBe(true);
    expect(r.flags).toEqual([]);
  });

  it("reports named vs * groups and allowed / partial / blocked", () => {
    const r = run(
      `User-agent: GPTBot
Disallow: /

User-agent: OAI-SearchBot
Disallow: /pricing

User-agent: *
Disallow: /admin
`,
      ["https://example.com/pricing", "https://example.com/about"],
    );
    expect(r.by["GPTBot"]).toMatchObject({ group: "named", access: "blocked", homepage: "blocked", purpose: "training" });
    expect(r.by["OAI-SearchBot"]).toMatchObject({ group: "named", access: "partial", homepage: "allowed", blockedKeyPages: ["https://example.com/pricing"] });
    expect(r.by["ClaudeBot"]).toMatchObject({ group: "*", access: "allowed" });
    // Training-only blocks are data, not findings; the search crawler block is a low finding.
    expect(r.flags).toEqual([
      {
        rule: "ai-search-crawler-blocked",
        url: "https://example.com/pricing",
        severity: "low",
        title: "robots.txt blocks AI search crawlers from this page (if this is intended, ignore it)",
        evidence: `OAI-SearchBot (group oai-searchbot) in ${ROBOTS}`,
      },
    ]);
  });

  it("groups several blocked search crawlers per page, including the homepage", () => {
    const r = run("User-agent: PerplexityBot\nUser-agent: Claude-SearchBot\nUser-agent: Claude-User\nDisallow: /\n\nUser-agent: *\nAllow: /\n");
    expect(r.flags.map((f) => [f.url, f.evidence])).toEqual([[HOME, `Claude-SearchBot (group claude-searchbot), Claude-User (group claude-user), PerplexityBot (group perplexitybot) in ${ROBOTS}`]]);
  });

  it("user fetchers that may ignore robots.txt are data only", () => {
    const r = run("User-agent: ChatGPT-User\nUser-agent: Perplexity-User\nDisallow: /\n");
    expect(r.by["ChatGPT-User"]).toMatchObject({ access: "blocked", honorsRobots: false });
    expect(r.flags).toEqual([]);
  });

  it("does not double-report a * group that blocks everything or a key page Googlebot is also blocked from", () => {
    const all = run("User-agent: *\nDisallow: /\n", ["https://example.com/a"]);
    expect(all.robotsFlags).toContain("robots-disallow-all");
    expect(all.by["OAI-SearchBot"]).toMatchObject({ group: "*", access: "blocked" });
    expect(all.flags).toEqual([]);

    const key = run("User-agent: *\nDisallow: /private\n", ["https://example.com/private/x"]);
    expect(key.robotsFlags).toContain("robots-blocks-key-page");
    expect(key.flags).toEqual([]);

    // Googlebot has its own group, so the * block only hits other crawlers: reported.
    const notGoogle = run("User-agent: Googlebot\nAllow: /\n\nUser-agent: *\nDisallow: /private\n", ["https://example.com/private/x"]);
    expect(notGoogle.robotsFlags).not.toContain("robots-blocks-key-page");
    expect(notGoogle.flags.map((f) => f.url)).toEqual(["https://example.com/private/x"]);
    expect(notGoogle.flags[0]!.evidence).toMatch(/OAI-SearchBot \(group \*\)/);
  });

  it("counts key pages without the homepage, which has its own column", () => {
    const r = run("User-agent: OAI-SearchBot\nDisallow: /\n", [HOME, "https://example.com", "https://example.com/a"]);
    expect(r.aiCrawlers.keyPages).toBe(1);
    expect(r.by["OAI-SearchBot"]).toMatchObject({ homepage: "blocked", blockedKeyPages: ["https://example.com/a"] });
    expect(run("", [HOME], 404).aiCrawlers.keyPages).toBe(0);
  });

  it("a 5 MB robots.txt with 25,000 wildcard rules and long key-page paths finishes well under a second", () => {
    const lines = ["User-agent: *"];
    for (let i = 0; i < 25_000; i++) lines.push(`Disallow: /*abab${i}*zz${i}*q$`);
    let text = lines.join("\n");
    text += "\n#" + "x".repeat(5 * 1024 * 1024 - text.length);
    const keyPages = Array.from({ length: 20 }, (_, k) => `https://example.com/${"seg/".repeat(500)}${k}`);
    const t = performance.now();
    const r = run(text, keyPages);
    expect(performance.now() - t).toBeLessThan(1000);
    expect(r.aiCrawlers.crawlers.every((c) => c.access === "allowed")).toBe(true);
  });

  it("depends on the robots.txt check in the diff", () => {
    expect(siteCheckUrl("ai-search-crawler-blocked", "https://example.com/x")).toBe("site:robots");
  });
});

describe("AI crawlers in siteHygiene against a local site", () => {
  let server: Server;
  let base = "";
  let robots = { status: 200, body: "User-agent: OAI-SearchBot\nDisallow: /\n\nUser-agent: CCBot\nDisallow: /\n\nUser-agent: *\nDisallow:\n" };
  beforeAll(async () => {
    process.env.ALLOW_PRIVATE_URLS = "true";
    server = createServer((req, res) => {
      if (req.url === "/robots.txt") return void res.writeHead(robots.status, { "content-type": "text/plain" }).end(robots.body);
      res.writeHead(404, { "content-type": "text/html" }).end("<p>nope</p>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    delete process.env.ALLOW_PRIVATE_URLS;
    server.close();
  });
  const client = { slug: "127.0.0.1", domain: "127.0.0.1", keyPages: [] } as unknown as Client;

  it("adds the table and the finding to the hygiene result", async () => {
    const r = await siteHygiene(client, { origin: base, gscSitemapPaths: [], fresh: true });
    expect(r.aiCrawlers).toMatchObject({ robotsFound: true, homepage: `${base}/` });
    const crawlers = (r.aiCrawlers as { crawlers: { bot: string; access: string }[] }).crawlers;
    expect(crawlers.find((c) => c.bot === "CCBot")).toMatchObject({ access: "blocked" });
    expect(r.flags.filter((f) => f.rule === "ai-search-crawler-blocked").map((f) => f.url)).toEqual([`${base}/`]);
    expect(r.checked).toContain("site:robots");
  });

  it("a robots.txt that can't be read leaves the table unchecked", async () => {
    robots = { status: 503, body: "busy" };
    const r = await siteHygiene(client, { origin: base, gscSitemapPaths: [], fresh: true });
    expect(r.aiCrawlers).toEqual({ error: "robots.txt returned HTTP 503" });
    expect(r.checked).not.toContain("site:robots");
  });
});
