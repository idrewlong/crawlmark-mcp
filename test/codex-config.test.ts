import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import {
  codexAddArgs,
  codexAddDisplay,
  codexConfigPath,
  codexEntry,
  codexGetSaysNotFound,
  readCodexTomlEntry,
  describeCodexChange,
  parseCodexMcpGet,
  planCodexTomlEdit,
  sameCodexEntry,
  verifyCodexEdit,
  type CodexEntry,
} from "../src/lib/codex-config.js";

const SENTINEL = "sk-SENTINEL-do-not-print-1234";
const entry: CodexEntry = { command: "/usr/local/bin/node", args: ["--disable-warning=ExperimentalWarning", "/opt/cm/dist/index.js"], env: { CRAWLMARK_HOME: "/home/u/.crawlmark" } };
const bare: CodexEntry = { command: "/usr/local/bin/node", args: ["/opt/cm/dist/index.js"] };

const fixture = [
  "# Codex settings, edited by hand",
  'model = "o4"',
  "",
  "[mcp_servers.other]",
  'command = "other-server"',
  "# keep this comment",
  `env = { API_KEY = "${SENTINEL}" }`,
  "",
].join("\n");

const ok = (p: ReturnType<typeof planCodexTomlEdit>) => {
  if (!p.ok) throw new Error(`refused: ${p.reason}`);
  return p;
};

describe("Codex config paths and CLI", () => {
  it("uses CODEX_HOME, else ~/.codex", () => {
    expect(codexConfigPath({ CODEX_HOME: "/x/codex" }, "/home/u")).toBe(join("/x/codex", "config.toml"));
    expect(codexConfigPath({}, "/home/u")).toBe(join("/home/u", ".codex", "config.toml"));
  });

  it("codexAddArgs puts the name first, then --env pairs, then --", () => {
    expect(codexAddArgs({ command: "node", args: ["a.js"], env: { CRAWLMARK_HOME: "/h", X: "1" } })).toEqual([
      "mcp", "add", "crawlmark", "--env", "CRAWLMARK_HOME=/h", "--env", "X=1", "--", "node", "a.js",
    ]);
    expect(codexAddDisplay({ command: "node", args: ["a.js"], env: { CRAWLMARK_HOME: "/secret/place" } })).toBe("codex mcp add crawlmark --env CRAWLMARK_HOME=<hidden> -- node a.js");
  });

  it("parses `codex mcp get --json` (transport object or flat), and treats other shapes as unreadable", () => {
    const sample = JSON.stringify({ name: "crawlmark", enabled: true, transport: { type: "stdio", command: "node", args: ["a.js"], env: { CRAWLMARK_HOME: "/h" }, env_vars: [], cwd: null } });
    expect(parseCodexMcpGet(sample)).toEqual({ command: "node", args: ["a.js"], env: { CRAWLMARK_HOME: "/h" } });
    expect(parseCodexMcpGet(JSON.stringify({ command: "node", args: ["a.js"] }))).toEqual({ command: "node", args: ["a.js"] });
    expect(parseCodexMcpGet(JSON.stringify({ transport: { type: "streamable_http", url: "https://example.com/mcp" } }))).toBeUndefined();
    expect(parseCodexMcpGet("crawlmark\n  command: node")).toBeUndefined();
    expect(sameCodexEntry({ command: "node", args: ["a.js"], env: {} }, { command: "node", args: ["a.js"] })).toBe(true);
    expect(sameCodexEntry({ command: "node", args: ["a.js"] }, { command: "node", args: ["b.js"] })).toBe(false);
    expect(codexEntry({ command: "n", args: ["x"], env: {} })).toEqual({ command: "n", args: ["x"] });
  });
});

describe("planCodexTomlEdit", () => {
  it("appends to a file after one blank line, keeping every other byte", () => {
    const p = ok(planCodexTomlEdit(fixture, entry));
    expect(p.changed).toBe(true);
    expect(p.replaced).toBe(false);
    expect(p.otherServers).toEqual(["other"]);
    expect(p.text.startsWith(fixture)).toBe(true);
    expect(p.text.slice(fixture.length)).toBe(
      '\n[mcp_servers.crawlmark]\ncommand = "/usr/local/bin/node"\nargs = ["--disable-warning=ExperimentalWarning", "/opt/cm/dist/index.js"]\n\n[mcp_servers.crawlmark.env]\nCRAWLMARK_HOME = "/home/u/.crawlmark"\n',
    );
    expect((parse(p.text) as { mcp_servers: Record<string, unknown> }).mcp_servers.crawlmark).toEqual(entry);
  });

  it("creates a file from nothing", () => {
    const p = ok(planCodexTomlEdit(undefined, bare));
    expect(p.text).toBe('[mcp_servers.crawlmark]\ncommand = "/usr/local/bin/node"\nargs = ["/opt/cm/dist/index.js"]\n');
  });

  it("handles a missing trailing newline and CRLF line endings", () => {
    const noNl = 'model = "o4"';
    expect(ok(planCodexTomlEdit(noNl, bare)).text).toBe(`${noNl}\n\n[mcp_servers.crawlmark]\ncommand = "/usr/local/bin/node"\nargs = ["/opt/cm/dist/index.js"]\n`);
    const crlf = fixture.replace(/\n/g, "\r\n");
    const p = ok(planCodexTomlEdit(crlf, bare));
    expect(p.text.startsWith(crlf)).toBe(true);
    expect(p.text.slice(crlf.length)).toBe('\r\n[mcp_servers.crawlmark]\r\ncommand = "/usr/local/bin/node"\r\nargs = ["/opt/cm/dist/index.js"]\r\n');
  });

  it("replaces an entry with an env sub-table followed by another server, preserving comments exactly", () => {
    const head = "# top comment\n";
    const crawl = '[mcp_servers.crawlmark]\ncommand = "node"\nargs = ["old.js"]\n\n[mcp_servers.crawlmark.env]\nCRAWLMARK_HOME = "/old"\n';
    const tail = "\n# about the next server\n[mcp_servers.other]\ncommand = \"x\"\n";
    const p = ok(planCodexTomlEdit(head + crawl + tail, bare));
    expect(p.replaced).toBe(true);
    expect(p.text).toBe(head + '[mcp_servers.crawlmark]\ncommand = "/usr/local/bin/node"\nargs = ["/opt/cm/dist/index.js"]\n' + tail);
  });

  it("replaces an entry without a sub-table, at the end of a file with no final newline", () => {
    const text = 'a = 1\n\n[mcp_servers.crawlmark]\ncommand = "node"\nargs = ["old.js"]';
    const p = ok(planCodexTomlEdit(text, entry));
    expect(p.text).toBe('a = 1\n\n[mcp_servers.crawlmark]\ncommand = "/usr/local/bin/node"\nargs = ["--disable-warning=ExperimentalWarning", "/opt/cm/dist/index.js"]\n\n[mcp_servers.crawlmark.env]\nCRAWLMARK_HOME = "/home/u/.crawlmark"');
  });

  it("reports no change for an identical entry and returns the text untouched", () => {
    const once = ok(planCodexTomlEdit(fixture, entry)).text;
    const again = ok(planCodexTomlEdit(once, entry));
    expect(again.changed).toBe(false);
    expect(again.text).toBe(once);
  });

  it("refuses invalid TOML and every unsupported spelling", () => {
    expect(planCodexTomlEdit("this is = = not toml", entry)).toMatchObject({ ok: false, reason: expect.stringContaining("isn't valid TOML") });
    const spellings = [
      '[mcp_servers]\ncrawlmark = { command = "node", args = [] }\n',
      '[mcp_servers]\ncrawlmark.command = "node"\ncrawlmark.args = []\n',
      '[mcp_servers."crawlmark"]\ncommand = "node"\nargs = []\n',
      '[[mcp_servers.crawlmark]]\ncommand = "node"\n',
      '[mcp_servers.crawlmark]\ncommand = "node"\nargs = []\n[mcp_servers.other]\ncommand = "x"\n[mcp_servers.crawlmark.env]\nX = "1"\n',
      'mcp_servers = "not a table"\n',
    ];
    for (const s of spellings) expect(planCodexTomlEdit(s, entry).ok, s).toBe(false);
  });

  it("the post-parse guard catches a change to another server or a top-level key", () => {
    const before = { model: "o4", mcp_servers: { other: { command: "x" } } };
    expect(verifyCodexEdit(before, { model: "o4", mcp_servers: { other: { command: "x" }, crawlmark: bare } }, bare)).toBe(true);
    expect(verifyCodexEdit(before, { model: "o5", mcp_servers: { other: { command: "x" }, crawlmark: bare } }, bare)).toBe(false);
    expect(verifyCodexEdit(before, { model: "o4", mcp_servers: { other: { command: "y" }, crawlmark: bare } }, bare)).toBe(false);
    expect(verifyCodexEdit(before, { model: "o4", mcp_servers: { other: { command: "x" }, crawlmark: entry } }, bare)).toBe(false);
  });

  it("describes the change with env values hidden and no other server's values", () => {
    const p = ok(planCodexTomlEdit(fixture, entry));
    const text = describeCodexChange(p, entry).join("\n");
    expect(text).toContain("Other servers kept unchanged: other");
    expect(text).toContain("CRAWLMARK_HOME = <hidden>");
    expect(text).not.toContain("/home/u/.crawlmark");
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain("other-server");
  });
});

describe("R-2: only crawlmark's own mcp_servers key blocks the edit", () => {
  const neighbours = '[projects."/x/crawlmark-mcp"]\ntrust_level = "trusted"\n\n[mcp_servers.crawlmark_old]\ncommand = "old"\n\n[mcp_servers.crawlmark-beta]\ncommand = "beta"\n';

  it("appends next to a crawlmark-mcp trust table and crawlmark_old / crawlmark-beta servers", () => {
    const p = ok(planCodexTomlEdit(neighbours, bare));
    expect(p.text.startsWith(neighbours)).toBe(true);
    expect(p.otherServers).toEqual(["crawlmark_old", "crawlmark-beta"]);
    const parsed = parse(p.text) as { projects: Record<string, unknown>; mcp_servers: Record<string, unknown> };
    expect(parsed.projects["/x/crawlmark-mcp"]).toEqual({ trust_level: "trusted" });
    expect(parsed.mcp_servers.crawlmark_old).toEqual({ command: "old" });
  });

  it("replaces an entry that sits between them, leaving them byte for byte", () => {
    const text = `${neighbours}\n[mcp_servers.crawlmark]\ncommand = "node"\nargs = []\n\n[mcp_servers.crawlmark_old.env]\nX = "1"\n`;
    const p = ok(planCodexTomlEdit(text, bare));
    expect(p.text).toBe(`${neighbours}\n[mcp_servers.crawlmark]\ncommand = "/usr/local/bin/node"\nargs = ["/opt/cm/dist/index.js"]\n\n[mcp_servers.crawlmark_old.env]\nX = "1"\n`);
  });

  it("still refuses other spellings of the crawlmark key", () => {
    for (const s of ["[mcp_servers.'crawlmark']\ncommand = \"x\"\nargs = []\n", '["mcp_servers".crawlmark]\ncommand = "x"\nargs = []\n', '[ mcp_servers . "crawlmark" . env ]\nX = "1"\n']) {
      expect(planCodexTomlEdit(s, bare).ok, s).toBe(false);
    }
  });
});

describe("R-4 helpers", () => {
  it("codexGetSaysNotFound only trusts a clear not-found message", () => {
    expect(codexGetSaysNotFound("No MCP server named 'crawlmark' found.")).toBe(true);
    expect(codexGetSaysNotFound("Error: server crawlmark not found")).toBe(true);
    expect(codexGetSaysNotFound("error: unexpected argument '--json' found")).toBe(false);
    expect(codexGetSaysNotFound("permission denied")).toBe(false);
    // Not-found phrases that don't name the server prove nothing.
    expect(codexGetSaysNotFound("Error: config file not found")).toBe(false);
    expect(codexGetSaysNotFound("No such file or directory (os error 2)")).toBe(false);
    expect(codexGetSaysNotFound("crawlmark\nError: profile not found")).toBe(false);
    expect(codexGetSaysNotFound("No MCP server named 'crawlmark_old' found.")).toBe(false);
  });

  it("readCodexTomlEntry reads mcp_servers.crawlmark without writing anything", () => {
    expect(readCodexTomlEntry(undefined)).toEqual({ kind: "absent" });
    expect(readCodexTomlEntry(fixture)).toEqual({ kind: "absent" });
    expect(readCodexTomlEntry('[mcp_servers.crawlmark]\ncommand = "n"\nargs = ["a"]\n[mcp_servers.crawlmark.env]\nK = "v"\n')).toEqual({ kind: "entry", entry: { command: "n", args: ["a"], env: { K: "v" } } });
    expect(readCodexTomlEntry("x = = 1")).toEqual({ kind: "unreadable" });
    expect(readCodexTomlEntry('[mcp_servers.crawlmark]\nurl = "https://example.com/mcp"\n')).toEqual({ kind: "unreadable" });
  });
});
