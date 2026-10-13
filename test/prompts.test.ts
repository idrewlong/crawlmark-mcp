import { readdirSync, readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { registerPrompts, renderTemplate } from "../src/prompts/index.js";
import { registerBrandTools } from "../src/tools/brand.js";
import { registerCompetitorTools } from "../src/tools/competitors.js";
import { registerOpportunityTools } from "../src/tools/opportunities.js";
import { registerRawTools } from "../src/tools/raw.js";
import { registerReportTools } from "../src/tools/reports.js";

const TEMPLATE_DIR = new URL("../src/prompts/templates/", import.meta.url);
const templateFiles = readdirSync(TEMPLATE_DIR).filter((f) => f.endsWith(".md"));

async function connect() {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerReportTools(server);
  registerCompetitorTools(server);
  registerBrandTools(server);
  registerOpportunityTools(server);
  registerRawTools(server);
  registerPrompts(server);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const EXPECTED_PROMPTS: Record<string, { required: string[]; optional: string[] }> = {
  "find-competitors": { required: ["client"], optional: [] },
  "review-brand-terms": { required: [], optional: ["client"] },
  "monthly-report-writeup": { required: ["client"], optional: ["month"] },
  "audit-findings": { required: ["client"], optional: [] },
  "opportunity-review": { required: ["client"], optional: [] },
  "client-health-check": { required: ["client"], optional: [] },
};

describe("registered prompts", () => {
  it("registers every prompt with the right args", async () => {
    const client = await connect();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(Object.keys(EXPECTED_PROMPTS).sort());
    for (const p of prompts) {
      const want = EXPECTED_PROMPTS[p.name]!;
      const args = p.arguments ?? [];
      expect(args.filter((a) => a.required).map((a) => a.name).sort(), p.name).toEqual(want.required);
      expect(args.filter((a) => !a.required).map((a) => a.name).sort(), p.name).toEqual(want.optional);
      expect(p.description, p.name).toBeTruthy();
    }
  });

  it("every prompt renders with no unfilled placeholders and says to prefer free tools and not to guess", async () => {
    const client = await connect();
    for (const name of Object.keys(EXPECTED_PROMPTS)) {
      const r = await client.getPrompt({ name, arguments: { client: "example.com" } });
      const t = r.messages[0]!.content;
      expect(t.type).toBe("text");
      const text = (t as { text: string }).text;
      expect(text, name).not.toMatch(/\{\{\w+\}\}/);
      expect(text, name).toContain("example.com");
      expect(text.toLowerCase(), name).toContain("free");
      expect(text.toLowerCase(), name).toMatch(/unavailable/);
    }
  });

  it("monthly-report-writeup passes the month through and validates its format", async () => {
    const client = await connect();
    const withMonth = await client.getPrompt({ name: "monthly-report-writeup", arguments: { client: "example.com", month: "2026-09" } });
    expect((withMonth.messages[0]!.content as { text: string }).text).toContain('month: "2026-09"');
    const without = await client.getPrompt({ name: "monthly-report-writeup", arguments: { client: "example.com" } });
    expect((without.messages[0]!.content as { text: string }).text).toContain("no `month`");
    await expect(client.getPrompt({ name: "monthly-report-writeup", arguments: { client: "example.com", month: "last month" } })).rejects.toThrow();
  });

  it("every template file belongs to a registered prompt", () => {
    expect(templateFiles.map((f) => f.replace(/\.md$/, "")).sort()).toEqual(Object.keys(EXPECTED_PROMPTS).sort());
  });
});

describe("tool names mentioned in templates", () => {
  it("every snake_case name in backticks is a registered tool", async () => {
    const client = await connect();
    const tools = new Set((await client.listTools()).tools.map((t) => t.name));
    expect(tools.has("dataforseo_status")).toBe(true);
    for (const f of templateFiles) {
      const text = readFileSync(new URL(f, TEMPLATE_DIR), "utf8");
      const names = [...text.matchAll(/`([a-z]+(?:_[a-z0-9]+)+)`/g)].map((m) => m[1]!);
      for (const n of names) expect(tools.has(n), `${f}: \`${n}\` is not a registered tool`).toBe(true);
    }
  });

  it("the health check and audit/opportunity prompts name the tools they depend on", () => {
    const need: Record<string, string[]> = {
      "monthly-report-writeup": ["monthly_report"],
      "audit-findings": ["list_audits", "get_audit", "run_audit", "compare_audits"],
      "opportunity-review": ["striking_distance", "quick_wins", "low_ctr", "cannibalization", "declining_pages", "list_competitors", "ranked_keywords", "suggest_competitors"],
      "client-health-check": ["list_clients", "gsc_query", "ga4_report", "render_check", "dataforseo_status"],
    };
    for (const [file, names] of Object.entries(need)) {
      const text = readFileSync(new URL(`${file}.md`, TEMPLATE_DIR), "utf8");
      for (const n of names) expect(text, `${file} should mention ${n}`).toContain(`\`${n}\``);
    }
  });
});

describe("prompt templates", () => {
  it("fills placeholders and leaves unknown ones", () => {
    expect(renderTemplate("Client {{client}} / {{other}}", { client: "example.com" })).toBe("Client example.com / {{other}}");
  });

  it("find-competitors walks through profile, suggest, confirm, add", () => {
    const text = renderTemplate(readFileSync(new URL("../src/prompts/templates/find-competitors.md", import.meta.url), "utf8"), {
      client: "example.com",
    });
    expect(text).not.toContain("{{");
    const order = ["set_client_profile", "suggest_competitors", "Ask", "add_competitors"].map((t) => text.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain('source: "suggested"');
  });

  it("review-brand-terms suggests, asks, then adds with source suggested, never across clients", () => {
    const raw = readFileSync(new URL("../src/prompts/templates/review-brand-terms.md", import.meta.url), "utf8");
    const text = renderTemplate(raw, { scope: "the client `example.com`", client: "example.com" });
    expect(text).not.toContain("{{");
    const order = ["suggest_brand_terms", "Ask", "add_brand_terms"].map((t) => text.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain('source: "suggested"');
    expect(text).toContain("other-client-brand");
    expect(text).toContain("remove_brand_terms");
    // Paid fallback for sparse Search Console data only after the user agrees.
    expect(text.indexOf("ask me whether to spend")).toBeGreaterThan(-1);
    expect(text.indexOf("ask me whether to spend")).toBeLessThan(text.indexOf("allowPaid: true"));
  });
});
