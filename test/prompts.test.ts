import { readdirSync, readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { registerPrompts, renderTemplate } from "../src/prompts/index.js";
import { registerAiVisibilityTools } from "../src/tools/ai-visibility.js";
import { registerBrandTools } from "../src/tools/brand.js";
import { registerCompetitorTools } from "../src/tools/competitors.js";
import { registerOpportunityTools } from "../src/tools/opportunities.js";
import { registerRankTools } from "../src/tools/ranks.js";
import { registerRawTools } from "../src/tools/raw.js";
import { registerGtmTools } from "../src/tools/gtm.js";
import { registerReportTools } from "../src/tools/reports.js";
import { registerSetupTools } from "../src/tools/setup.js";

const TEMPLATE_DIR = new URL("../src/prompts/templates/", import.meta.url);
const templateFiles = readdirSync(TEMPLATE_DIR).filter((f) => f.endsWith(".md"));

async function connect() {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerReportTools(server);
  registerCompetitorTools(server);
  registerBrandTools(server);
  registerOpportunityTools(server);
  registerRankTools(server);
  registerRawTools(server);
  registerGtmTools(server);
  registerSetupTools(server);
  registerAiVisibilityTools(server);
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
  "getting-started": { required: [], optional: [] },
  "template-report": { required: ["client"], optional: ["period", "template"] },
  "keyword-research": { required: ["client"], optional: ["seeds"] },
};

/** Prompts with no client argument. */
const NO_CLIENT = new Set(["getting-started"]);

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
      const r = await client.getPrompt({ name, arguments: NO_CLIENT.has(name) ? {} : { client: "example.com" } });
      const t = r.messages[0]!.content;
      expect(t.type).toBe("text");
      const text = (t as { text: string }).text;
      expect(text, name).not.toMatch(/\{\{\w+\}\}/);
      if (!NO_CLIENT.has(name)) expect(text, name).toContain("example.com");
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
      "monthly-report-writeup": ["monthly_report", "export_report"],
      "template-report": ["list_report_templates", "run_report_template", "export_report"],
      "audit-findings": ["list_audits", "get_audit", "run_audit", "compare_audits"],
      "opportunity-review": ["striking_distance", "quick_wins", "low_ctr", "cannibalization", "declining_pages", "list_competitors", "ranked_keywords", "suggest_competitors"],
      "client-health-check": ["list_clients", "gsc_query", "ga4_report", "render_check", "dataforseo_status"],
      "getting-started": ["setup_status", "list_clients", "gsc_query", "striking_distance", "monthly_report"],
      "keyword-research": ["keyword_ideas", "keyword_gap", "list_keywords", "list_competitors", "add_keywords"],
    };
    for (const [file, names] of Object.entries(need)) {
      const text = readFileSync(new URL(`${file}.md`, TEMPLATE_DIR), "utf8");
      for (const n of names) expect(text, `${file} should mention ${n}`).toContain(`\`${n}\``);
    }
  });
});

describe("getting-started", () => {
  it("checks setup first, never asks for secrets in chat, and offers the two free first flows", () => {
    const text = readFileSync(new URL("getting-started.md", TEMPLATE_DIR), "utf8");
    expect(text.indexOf("`setup_status`")).toBeLessThan(text.indexOf("`list_clients`"));
    expect(text).toMatch(/Never ask me to paste a password, API key/);
    expect(text).toContain("crawlmark-cli setup");
    expect(text).toContain("`opportunity-review`");
    expect(text).toContain("`monthly-report-writeup`");
    expect(text).toMatch(/most Search Console data/);
  });

  it("setup_status is registered as a read-only tool", async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === "setup_status");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.description).toMatch(/Never ask the user to paste/);
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

describe("report prompts (Phase 12)", () => {
  const textOf = async (name: string, args: Record<string, string>) => ((await (await connect()).getPrompt({ name, arguments: args })).messages[0]!.content as { text: string }).text;

  it("template-report: asks for the template when none is given, passes the period, never allowPaid unasked", async () => {
    const pick = await textOf("template-report", { client: "example.com" });
    expect(pick).toContain("`list_report_templates`");
    expect(pick).toContain("ask which one to use");
    expect(pick).toContain("never pass `allowPaid` unless I asked");
    const q = await textOf("template-report", { client: "example.com", template: "quarterly", period: "2026-q3" });
    expect(q).toContain('`template: "quarterly"`, `quarter: "2026-Q3"`');
    expect(q).not.toContain("ask which one to use");
    expect(await textOf("template-report", { client: "example.com", period: "2026-09" })).toContain('`month: "2026-09"`');
    expect(await textOf("template-report", { client: "example.com", period: "2026-07-01..2026-09-30" })).toContain('`startDate: "2026-07-01"`, `endDate: "2026-09-30"`');
    await expect(textOf("template-report", { client: "example.com", period: "last month" })).rejects.toThrow();
    expect(q).toContain("default Markdown and PDF");
    expect(q).toContain("`export_report`");
  });

  it("both report prompts share one copy of the number rules and the Docs offer, which is conditional and consent-first", async () => {
    const { NUMBER_RULES, DOCS_OFFER } = await import("../src/prompts/index.js");
    const monthly = await textOf("monthly-report-writeup", { client: "example.com" });
    const tpl = await textOf("template-report", { client: "example.com", template: "monthly" });
    for (const t of [monthly, tpl]) {
      expect(t).toContain(NUMBER_RULES);
      expect(t).toContain(DOCS_OFFER);
    }
    expect(DOCS_OFFER).toMatch(/^\*\*Google Docs \(only if available\)\.\*\* Only if this conversation has a Google Drive tool that can create files/);
    expect(DOCS_OFFER).toContain("Only after a yes");
    expect(DOCS_OFFER).toContain("If no such tool is available, don't mention Google Docs.");
    expect(DOCS_OFFER).toContain("Don't share the file or change its permissions.");
    expect(DOCS_OFFER).toContain('`inline: "html"`');
    // R-2: the Docs export writes no files (without formats, export_report would fall back to the default formats).
    expect(DOCS_OFFER).toContain("`formats: []`");
  });

  it("monthly-report-writeup keeps steps 1 to 5 and adds the export and Docs steps", async () => {
    const t = await textOf("monthly-report-writeup", { client: "example.com", month: "2026-09" });
    for (const h of ["1. **Get the data.**", "2. **Read the numbers correctly.**", "3. **Write the report**", "4. **Style rules.**", "5. **Unavailable data.**", "6. **Offer to save it.**", "7. **Google Docs (only if available).**"]) expect(t).toContain(h);
    expect(t.indexOf("5. **Unavailable data.**")).toBeLessThan(t.indexOf("6. **Offer to save it.**"));
    expect(t).toContain('`template: "monthly"`, `month: "2026-09"`');
  });
});

describe("keyword-research (Phase 12 B)", () => {
  it("always estimates first, asks before the paid call, and passes seeds through", async () => {
    const client = await connect();
    const r = await client.getPrompt({ name: "keyword-research", arguments: { client: "example.com", seeds: "emergency plumber, water heater repair" } });
    const text = (r.messages[0]!.content as { text: string }).text;
    expect(text).toContain('"emergency plumber", "water heater repair"');
    expect(text).toContain("`estimateOnly: true`");
    expect(text.indexOf("estimateOnly: true")).toBeLessThan(text.indexOf("**Ask.**"));
    expect(text).toMatch(/Don't call the tool without `estimateOnly` until I say yes/);
    expect(text).toMatch(/never raise a cap yourself/);
    expect(text).toMatch(/never compare them/);
    const none = await client.getPrompt({ name: "keyword-research", arguments: { client: "example.com" } });
    expect((none.messages[0]!.content as { text: string }).text).toMatch(/propose 3-5 non-branded seed keywords/);
  });
});

