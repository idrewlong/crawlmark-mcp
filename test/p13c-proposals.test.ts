/**
 * Phase 13 C: create_report_template / update_report_template. Proposals write nothing; saving needs the
 * single-use token, the same arguments, an unchanged file, paidAcknowledged for paid sections, and (when the
 * MCP client supports it) the user's yes through elicitation.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../src/lib/clients.js";
import { argumentsHash, canonicalJson, newToken, TOKEN_RE } from "../src/reports/templates/proposals.js";
import { registerTemplateWriteTools, templateWriteCall, type TemplateWriteArgs, type TemplateWriteDeps } from "../src/tools/report-template-write.js";

const today = new Date("2026-10-13T12:00:00Z");
const newHome = () => mkdtempSync(join(tmpdir(), "crawlmark-p13c-tool-"));
const globalFile = (home: string) => join(home, "config", "report-templates.yaml");
const EXISTING = "# keep me\nversion: 1\ntemplates:\n  short:\n    title: Short\n    sections:\n      - { id: search, type: search_overview }\n";
const free = { title: "Board pack", period: { range: "last_quarter" }, sections: [{ id: "search", type: "search_overview" }, { id: "issues", type: "technical_issues" }] };
const paid = { title: "Board pack", sections: [{ id: "search", type: "search_overview" }, { id: "backlinks", type: "backlinks", paid: true, optional: true }] };
const exampleClient = { slug: "example.com", domain: "example.com", name: "Example" } as unknown as Client;

function deps(home: string, extra: Partial<TemplateWriteDeps> = {}): TemplateWriteDeps {
  return {
    homeDir: home,
    today,
    resolveClient: async (id) => {
      if (id !== "example.com") throw new Error(`Unknown client ${id}`);
      return exampleClient;
    },
    estimate: async () => new Map([["backlinks", [{ id: "backlinks", type: "backlinks", provider: "dataforseo", usd: 0.025, units: 0, requests: 1, reused: false }]]]),
    ...extra,
  };
}

function homeWithFile() {
  const home = newHome();
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(globalFile(home), EXISTING, { mode: 0o600 });
  return home;
}

type Proposal = { proposal: true; valid: boolean; confirmToken: string; diff: string; yaml: string; path: string; paidSections: { id: string; estimate: { usd: number; text: string } | null }[]; errors?: { path: string }[]; message: string };
const propose = async (tool: "create_report_template" | "update_report_template", args: TemplateWriteArgs, d: TemplateWriteDeps) => (await templateWriteCall(tool, args, d)) as Proposal;

afterEach(() => {
  vi.useRealTimers();
});

describe("tokens", () => {
  it("are tpl_ + 26 Crockford base32 characters, all different", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const t = newToken();
      expect(t).toMatch(TOKEN_RE);
      seen.add(t);
    }
    expect(seen.size).toBe(200);
  });

  it("the arguments hash ignores key order, confirmToken and paidAcknowledged, but not the tool", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe('{"a":{"d":[1,{"x":1,"y":2}]},"b":1}');
    const a = argumentsHash("create_report_template", { id: "x", template: { title: "T", sections: [] } });
    expect(argumentsHash("create_report_template", { template: { sections: [], title: "T" }, id: "x", confirmToken: "tpl_1", paidAcknowledged: true })).toBe(a);
    expect(argumentsHash("update_report_template", { id: "x", template: { title: "T", sections: [] } })).not.toBe(a);
  });
});

describe("create_report_template", () => {
  it("proposes without writing anything, then saves with the token; the token is single use", async () => {
    const home = homeWithFile();
    const mtime = statSync(globalFile(home)).mtimeMs;
    const d = deps(home);
    const p = await propose("create_report_template", { id: "board", template: free }, d);
    expect(p).toMatchObject({ proposal: true, valid: true, path: globalFile(home), exists: true, replaces: false, shadowsBuiltin: false, paidSections: [] });
    expect(p.confirmToken).toMatch(TOKEN_RE);
    expect(p.yaml).toContain("board:");
    expect(p.diff).toContain("+  board:");
    expect(readFileSync(globalFile(home), "utf8")).toBe(EXISTING);
    expect(statSync(globalFile(home)).mtimeMs).toBe(mtime);
    expect(existsSync(`${globalFile(home)}.bak`)).toBe(false);

    const saved = await templateWriteCall("create_report_template", { id: "board", template: free, confirmToken: p.confirmToken }, d);
    expect(saved).toEqual({ saved: true, path: globalFile(home), backup: `${globalFile(home)}.bak`, template: "board", validate: { valid: true, warnings: [] } });
    const text = readFileSync(globalFile(home), "utf8");
    expect(text.startsWith(EXISTING)).toBe(true);
    expect(text).toContain("  board:\n    title: Board pack\n");
    expect(statSync(globalFile(home)).mode & 0o777).toBe(0o600);

    await expect(templateWriteCall("create_report_template", { id: "board", template: free, confirmToken: p.confirmToken, replace: true }, d)).rejects.toThrow(/already used/);
    await expect(templateWriteCall("create_report_template", { id: "board", template: free, confirmToken: p.confirmToken }, d)).rejects.toThrow(/already in the global template file/);
  });

  it("a used token can't be used again", async () => {
    const home = newHome();
    const d = deps(home);
    const p = await propose("create_report_template", { id: "board", template: free }, d);
    await templateWriteCall("create_report_template", { id: "board", template: free, confirmToken: p.confirmToken }, d);
    // Same arguments again would now be a replace; even with the old token it's refused as used.
    writeFileSync(globalFile(home), "version: 1\n");
    await expect(templateWriteCall("create_report_template", { id: "board", template: free, confirmToken: p.confirmToken }, d)).rejects.toThrow(/Unknown or already used/);
  });

  it("refuses an expired token (15 minutes)", async () => {
    const home = newHome();
    const d = deps(home);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
    const p = await propose("create_report_template", { id: "board", template: free }, d);
    vi.setSystemTime(new Date("2026-10-13T12:16:00Z"));
    await expect(templateWriteCall("create_report_template", { id: "board", template: free, confirmToken: p.confirmToken }, d)).rejects.toThrow(/expired/);
    expect(existsSync(globalFile(home))).toBe(false);
  });

  it("refuses different arguments, an unknown token, and another tool's token", async () => {
    const home = newHome();
    const d = deps(home);
    const p = await propose("create_report_template", { id: "board", template: free }, d);
    await expect(templateWriteCall("create_report_template", { id: "board", template: { ...free, title: "Other" }, confirmToken: p.confirmToken }, d)).rejects.toThrow(/arguments differ/);
    await expect(templateWriteCall("create_report_template", { id: "board", template: free, confirmToken: newToken() }, d)).rejects.toThrow(/Unknown or already used/);
    await expect(templateWriteCall("create_report_template", { id: "board", template: free, confirmToken: "not-a-token" }, d)).rejects.toThrow(/isn't one this server issued/);
    expect(existsSync(globalFile(home))).toBe(false);
    // The token still works with the right arguments.
    await templateWriteCall("create_report_template", { id: "board", template: free, confirmToken: p.confirmToken }, d);
    expect(existsSync(globalFile(home))).toBe(true);
  });

  it("refuses when the file was edited between proposal and confirm", async () => {
    const home = homeWithFile();
    const d = deps(home);
    const p = await propose("create_report_template", { id: "board", template: free }, d);
    writeFileSync(globalFile(home), `${EXISTING}# hand edit\n`);
    await expect(templateWriteCall("create_report_template", { id: "board", template: free, confirmToken: p.confirmToken }, d)).rejects.toThrow(/changed since the proposal/);
    expect(readFileSync(globalFile(home), "utf8")).toBe(`${EXISTING}# hand edit\n`);
  });

  it("paid sections: listed with this client's estimate, and the save needs paidAcknowledged: true", async () => {
    const home = newHome();
    const d = deps(home);
    const p = await propose("create_report_template", { client: "example.com", id: "board", template: paid }, d);
    expect(p.paidSections).toEqual([{ id: "backlinks", type: "backlinks", estimate: { usd: 0.025, units: 0, provider: "dataforseo", text: "about $0.025 (DataForSEO)" } }]);
    expect(p.message).toMatch(/paidAcknowledged: true only after the user explicitly agreed/);
    await expect(templateWriteCall("create_report_template", { client: "example.com", id: "board", template: paid, confirmToken: p.confirmToken }, d)).rejects.toThrow(/paid section/);
    await expect(templateWriteCall("create_report_template", { client: "example.com", id: "board", template: paid, confirmToken: p.confirmToken, paidAcknowledged: false }, d)).rejects.toThrow(/paid section/);
    expect(existsSync(globalFile(home))).toBe(false);
    // Paid sections also need the user's own answer (SEC-1): an app with elicitation.
    const saved = await templateWriteCall("create_report_template", { client: "example.com", id: "board", template: paid, confirmToken: p.confirmToken, paidAcknowledged: true }, deps(home, { elicit: async () => true }));
    expect(saved).toMatchObject({ saved: true });
    // Without a client there is no number.
    const p2 = await propose("create_report_template", { id: "board2", template: paid }, d);
    expect(p2.paidSections).toEqual([{ id: "backlinks", type: "backlinks", estimate: null }]);
  });

  it("an invalid template returns valid: false with YAML paths and no token", async () => {
    const home = newHome();
    const r = (await templateWriteCall("create_report_template", { id: "board", template: { title: "X", sections: [{ id: "b", type: "backlinks" }] } }, deps(home))) as Proposal;
    expect(r.valid).toBe(false);
    expect(r.errors!.map((e) => e.path)).toContain("templates.board.sections[0].paid");
    expect("confirmToken" in r).toBe(false);
    expect(existsSync(globalFile(home))).toBe(false);
  });

  it("writes a client's own file with file: client, and never anything but template files", async () => {
    const home = newHome();
    const d = deps(home);
    const p = await propose("create_report_template", { client: "example.com", file: "client", id: "board", template: free }, d);
    expect(p.path).toBe(join(home, "config", "report-templates", "example.com.yaml"));
    await templateWriteCall("create_report_template", { client: "example.com", file: "client", id: "board", template: free, confirmToken: p.confirmToken }, d);
    expect(existsSync(p.path)).toBe(true);
    await expect(templateWriteCall("create_report_template", { file: "client", id: "board", template: free }, d)).rejects.toThrow(/needs a client/);
    // Branding (or anything else outside a template) is refused by the strict schema.
    const bad = (await templateWriteCall("create_report_template", { id: "x", template: { ...free, branding: { agencyName: "Evil" } } }, d)) as Proposal;
    expect(bad.valid).toBe(false);
  });

  it("replacing a template used through an alias returns valid: false, not a crash", async () => {
    const home = newHome();
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(globalFile(home), "version: 1\ntemplates:\n  base: &base\n    title: Base\n    sections:\n      - { id: search, type: search_overview }\n  copy: *base\n");
    const r = (await templateWriteCall("create_report_template", { id: "base", template: free, replace: true }, deps(home))) as Proposal;
    expect(r.valid).toBe(false);
    expect(r.errors!.map((e) => e.path)).toEqual(["templates.base"]);
  });

  it("shadowing a builtin needs replace and says so", async () => {
    const home = newHome();
    const d = deps(home);
    const r = (await templateWriteCall("create_report_template", { id: "monthly", template: free }, d)) as Proposal;
    expect(r.valid).toBe(false);
    const p = await propose("create_report_template", { id: "monthly", template: free, replace: true }, d);
    expect(p).toMatchObject({ valid: true, shadowsBuiltin: true });
    expect(p.message).toMatch(/hides the builtin "monthly"/);
  });

  it("tool results carry only the template file's content (the diff of that file, never another file)", async () => {
    const home = homeWithFile();
    mkdirSync(join(home, "config", "report-templates"), { recursive: true });
    writeFileSync(join(home, "config", "report-templates", "example.com.yaml"), "# CLIENT-SECRET-MARKER\nversion: 1\n");
    writeFileSync(join(home, "config", "clients.yaml"), "# CLIENTS-MARKER\n");
    const p = await propose("create_report_template", { client: "example.com", id: "board", template: free }, deps(home));
    const text = JSON.stringify(p);
    expect(text).not.toContain("CLIENT-SECRET-MARKER");
    expect(text).not.toContain("CLIENTS-MARKER");
  });
});

describe("update_report_template", () => {
  it("patches a template in the file through the same propose and confirm steps", async () => {
    const home = homeWithFile();
    const d = deps(home);
    const args: TemplateWriteArgs = { id: "short", patch: { addSections: [{ id: "issues", type: "technical_issues", optional: true }], set: { title: "Short monthly" } } };
    const p = await propose("update_report_template", args, d);
    expect(p.valid).toBe(true);
    expect(readFileSync(globalFile(home), "utf8")).toBe(EXISTING);
    // A create token can't save an update.
    const c = await propose("create_report_template", { id: "board", template: free }, d);
    await expect(templateWriteCall("update_report_template", { ...args, confirmToken: c.confirmToken }, d)).rejects.toThrow(/arguments differ|is for create_report_template/);
    // Changing an existing template needs the user's own answer (SEC-1).
    await templateWriteCall("update_report_template", { ...args, confirmToken: p.confirmToken }, deps(home, { elicit: async () => true }));
    const text = readFileSync(globalFile(home), "utf8");
    expect(text).toContain("# keep me");
    expect(text).toContain("title: Short monthly");
    expect(text).toContain("- { id: issues, type: technical_issues, optional: true }");
  });

  it("needs the id in that file, and exactly one of template or patch", async () => {
    const home = homeWithFile();
    const d = deps(home);
    expect(((await templateWriteCall("update_report_template", { id: "nope", patch: { set: { title: "x" } } }, d)) as Proposal).valid).toBe(false);
    expect(((await templateWriteCall("update_report_template", { id: "short" }, d)) as Proposal).valid).toBe(false);
    expect(((await templateWriteCall("update_report_template", { id: "short", template: free, patch: { set: { title: "x" } } }, d)) as Proposal).valid).toBe(false);
  });
});

describe("elicitation", () => {
  it("declined: not saved (and the token is used up)", async () => {
    const home = newHome();
    const asked: string[] = [];
    const d = deps(home, { elicit: async (m) => (asked.push(m), false) });
    const p = await propose("create_report_template", { client: "example.com", id: "board", template: paid }, d);
    await expect(templateWriteCall("create_report_template", { client: "example.com", id: "board", template: paid, confirmToken: p.confirmToken, paidAcknowledged: true }, d)).rejects.toThrow(/the user declined/);
    expect(asked[0]).toBe(`Save template "board" to ${globalFile(home)}? It includes 1 paid section (backlinks). Sections: search (search_overview), backlinks (backlinks).`);
    expect(existsSync(globalFile(home))).toBe(false);
    await expect(templateWriteCall("create_report_template", { client: "example.com", id: "board", template: paid, confirmToken: p.confirmToken, paidAcknowledged: true }, deps(home))).rejects.toThrow(/already used/);
  });

  it("accepted with the token: saved; without elicitation support the token flow alone applies", async () => {
    const home = newHome();
    const p = await propose("create_report_template", { id: "board", template: free }, deps(home));
    await templateWriteCall("create_report_template", { id: "board", template: free, confirmToken: p.confirmToken }, deps(home, { elicit: async () => true }));
    expect(existsSync(globalFile(home))).toBe(true);
  });
});

describe("over MCP", () => {
  async function connect(home: string, answer?: { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }) {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerTemplateWriteTools(server, { homeDir: home });
    const client = new McpClient({ name: "t", version: "0.0.0" }, answer ? { capabilities: { elicitation: {} } } : {});
    const asked: string[] = [];
    if (answer) {
      client.setRequestHandler(ElicitRequestSchema, async (req) => {
        asked.push(req.params.message);
        return answer;
      });
    }
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args });
      const text = (r.content as { text: string }[])[0]!.text;
      return { isError: Boolean(r.isError), text, json: r.isError ? undefined : JSON.parse(text) };
    };
    return { client, call, asked };
  }

  it("registers both tools as local writes that are not destructive", async () => {
    const { client } = await connect(newHome());
    const tools = (await client.listTools()).tools.filter((t) => t.name.endsWith("_report_template"));
    expect(tools.map((t) => t.name).sort()).toEqual(["create_report_template", "update_report_template"]);
    for (const t of tools) expect(t.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it("an elicitation-capable client is asked before saving; decline writes nothing, accept saves", async () => {
    const home = newHome();
    const declined = await connect(home, { action: "decline" });
    const p = await declined.call("create_report_template", { id: "board", template: free });
    expect(p.json.proposal).toBe(true);
    expect(declined.asked).toEqual([]);
    const r = await declined.call("create_report_template", { id: "board", template: free, confirmToken: p.json.confirmToken });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/the user declined/);
    expect(declined.asked).toHaveLength(1);
    expect(existsSync(globalFile(home))).toBe(false);

    const accepted = await connect(home, { action: "accept", content: { save: true } });
    const p2 = await accepted.call("create_report_template", { id: "board", template: free });
    const ok = await accepted.call("create_report_template", { id: "board", template: free, confirmToken: p2.json.confirmToken });
    expect(ok.json).toMatchObject({ saved: true, template: "board" });
    expect(accepted.asked[0]).toMatch(/^Save template "board" to /);

    // Accept with save: false is not a yes.
    const unticked = await connect(home, { action: "accept", content: { save: false } });
    const p3 = await unticked.call("create_report_template", { id: "board2", template: free });
    const no = await unticked.call("create_report_template", { id: "board2", template: free, confirmToken: p3.json.confirmToken });
    expect(no.text).toMatch(/declined/);
  });

  it("a client without elicitation saves on the token alone", async () => {
    const home = newHome();
    const { call } = await connect(home);
    const p = await call("create_report_template", { id: "board", template: free });
    const ok = await call("create_report_template", { id: "board", template: free, confirmToken: p.json.confirmToken });
    expect(ok.json.saved).toBe(true);
  });
});

describe("without elicitation, risky saves need the user's own answer (SEC-1)", () => {
  async function connectNoElicit(home: string) {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerTemplateWriteTools(server, { homeDir: home });
    const client = new McpClient({ name: "t", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    return async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args });
      const text = (r.content as { text: string }[])[0]!.text;
      return { isError: Boolean(r.isError), text, json: r.isError ? undefined : JSON.parse(text) };
    };
  }
  const withText = { title: "Notes", sections: [{ id: "search", type: "search_overview" }, { id: "note", type: "text", text: "Visit https://example.com/login to renew." }] };
  const cases: [string, string, Record<string, unknown>, RegExp][] = [
    ["shadows a builtin", "create_report_template", { id: "monthly", template: free, replace: true }, /hides the builtin "monthly"/],
    ["replaces a template in the file", "create_report_template", { id: "short", template: free, replace: true }, /changes the existing template "short"/],
    ["has paid sections", "create_report_template", { id: "board", template: paid, paidAcknowledged: true }, /paid sections \(backlinks\)/],
    ["has a text section", "create_report_template", { id: "board", template: withText }, /free-text sections \(note\)/],
    ["updates a template", "update_report_template", { id: "short", patch: { set: { title: "New" } } }, /changes the existing template "short"/],
  ];
  for (const [name, tool, args, why] of cases) {
    it(`refuses a save that ${name}, and the proposal says so up front`, async () => {
      const home = homeWithFile();
      const call = await connectNoElicit(home);
      const { paidAcknowledged, ...proposeArgs } = args;
      const p = await call(tool, proposeArgs);
      expect(p.json.proposal).toBe(true);
      expect(p.json.message).toMatch(/will be refused/);
      const r = await call(tool, { ...proposeArgs, ...(paidAcknowledged !== undefined ? { paidAcknowledged } : {}), confirmToken: p.json.confirmToken });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(why);
      expect(r.text).toMatch(/crawlmark-cli report templates new/);
      expect(readFileSync(globalFile(home), "utf8")).toBe(EXISTING);
    });
  }

  it("still saves a simple additive template without text on the token alone", async () => {
    const home = homeWithFile();
    const call = await connectNoElicit(home);
    const p = await call("create_report_template", { id: "board", template: free });
    expect(p.json.message).not.toMatch(/will be refused/);
    const ok = await call("create_report_template", { id: "board", template: free, confirmToken: p.json.confirmToken });
    expect(ok.json.saved).toBe(true);
  });

  it("the dialog names a hidden builtin (for this client) and shows the sections and the start of each text section, control characters stripped", async () => {
    const home = newHome();
    const asked: string[] = [];
    const d = deps(home, { elicit: async (m) => (asked.push(m), true) });
    const long = { title: "Notes", sections: [{ id: "note", type: "text", text: `Hello ${"x".repeat(300)}` }] };
    const p = await propose("create_report_template", { client: "example.com", file: "client", id: "monthly", template: long, replace: true }, d);
    await templateWriteCall("create_report_template", { client: "example.com", file: "client", id: "monthly", template: long, replace: true, confirmToken: p.confirmToken }, d);
    expect(asked[0]).toContain('It hides the builtin "monthly" template for this client.');
    expect(asked[0]).toContain("Sections: note (text).");
    expect(asked[0]).toMatch(/Text in "note": "Hello x{194}\.\.\."$/);
  });
});

describe("a client template that hides the global one (SEC-1b)", () => {
  // The tool call path without elicitation (the MCP layer passes no elicit then); client resolution is a fixture.
  it("is refused without elicitation, and the files are unchanged", async () => {
    const home = newHome();
    mkdirSync(join(home, "config"), { recursive: true });
    const globalText = "version: 1\ndefaults:\n  template: board\ntemplates:\n  board:\n    title: Board\n    sections:\n      - { id: search, type: search_overview }\n";
    writeFileSync(globalFile(home), globalText);
    const clientFile = join(home, "config", "report-templates", "example.com.yaml");
    const d = deps(home);
    const evil = { title: "Call 555-0100", sections: [{ id: "search", type: "search_overview", title: "Pay invoices to example.net" }] };
    const p = await propose("create_report_template", { client: "example.com", file: "client", id: "board", template: evil }, d);
    expect(p.valid).toBe(true);
    expect((p as unknown as { shadowsGlobal: boolean }).shadowsGlobal).toBe(true);
    expect(p.message).toMatch(/hides the global "board" template for this client/);
    expect(p.message).toMatch(/will be refused/);
    await expect(templateWriteCall("create_report_template", { client: "example.com", file: "client", id: "board", template: evil, confirmToken: p.confirmToken }, d)).rejects.toThrow(/hides the global "board" template for this client/);
    expect(existsSync(clientFile)).toBe(false);
    expect(readFileSync(globalFile(home), "utf8")).toBe(globalText);

    // With a dialog, the user is told and can say yes.
    const asked: string[] = [];
    const withDialog = deps(home, { elicit: async (m) => (asked.push(m), true) });
    const p2 = await propose("create_report_template", { client: "example.com", file: "client", id: "board", template: evil }, withDialog);
    await templateWriteCall("create_report_template", { client: "example.com", file: "client", id: "board", template: evil, confirmToken: p2.confirmToken }, withDialog);
    expect(asked[0]).toContain('It hides the global "board" template for this client.');
    expect(existsSync(clientFile)).toBe(true);
  });

  // L-1: the global file exists but is invalid, so it loads as no templates; its raw ids still count.
  const INVALID_GLOBAL = "version: 1\ntemplates:\n  board:\n    title: Board\n    sections:\n      - { id: search, type: not_a_section_type }\n";
  const SAFE = { title: "Plain", sections: [{ id: "search", type: "search_overview" }] };

  it("still sees a global template id when the global file is invalid, and refuses without a dialog", async () => {
    const home = newHome();
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(globalFile(home), INVALID_GLOBAL);
    const d = deps(home);
    const p = await propose("create_report_template", { client: "example.com", file: "client", id: "board", template: SAFE }, d);
    expect(p.valid).toBe(true);
    expect((p as unknown as { shadowsGlobal: boolean; globalFileInvalid: boolean })).toMatchObject({ shadowsGlobal: true, globalFileInvalid: false });
    await expect(templateWriteCall("create_report_template", { client: "example.com", file: "client", id: "board", template: SAFE, confirmToken: p.confirmToken }, d)).rejects.toThrow(/hides the global "board" template/);
    // A different id is not hidden, and needs no dialog.
    const other = await propose("create_report_template", { client: "example.com", file: "client", id: "other", template: SAFE }, d);
    expect((other as unknown as { shadowsGlobal: boolean }).shadowsGlobal).toBe(false);
    await templateWriteCall("create_report_template", { client: "example.com", file: "client", id: "other", template: SAFE, confirmToken: other.confirmToken }, d);
    expect(existsSync(join(home, "config", "report-templates", "example.com.yaml"))).toBe(true);
  });

  it("treats an unreadable global file as a dialog reason for client-file saves only", async () => {
    const home = newHome();
    mkdirSync(join(home, "config"), { recursive: true });
    const broken = "version: 1\ntemplates: [unclosed\n  board: {\n";
    writeFileSync(globalFile(home), broken);
    const d = deps(home);
    const p = await propose("create_report_template", { client: "example.com", file: "client", id: "board", template: SAFE }, d);
    expect(p).toMatchObject({ shadowsGlobal: false, globalFileInvalid: true });
    expect(p.message).toMatch(/global template file is invalid/);
    await expect(templateWriteCall("create_report_template", { client: "example.com", file: "client", id: "board", template: SAFE, confirmToken: p.confirmToken }, d)).rejects.toThrow(/global template file is invalid/);
    expect(existsSync(join(home, "config", "report-templates", "example.com.yaml"))).toBe(false);
    expect(readFileSync(globalFile(home), "utf8")).toBe(broken);

    // With a dialog, the user is told.
    const asked: string[] = [];
    const withDialog = deps(home, { elicit: async (m) => (asked.push(m), true) });
    const p2 = await propose("create_report_template", { client: "example.com", file: "client", id: "board", template: SAFE }, withDialog);
    await templateWriteCall("create_report_template", { client: "example.com", file: "client", id: "board", template: SAFE, confirmToken: p2.confirmToken }, withDialog);
    expect(asked[0]).toContain("The global template file is invalid");

    // Saving to the global file itself is unaffected by this check (it is invalid YAML there, a different error).
    const g = await propose("create_report_template", { client: "example.com", file: "global", id: "board", template: SAFE }, deps(home));
    expect(g.valid).toBe(false);
    expect(g).not.toHaveProperty("globalFileInvalid");
  });
});
