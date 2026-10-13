import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeCodeAddArgs, claudeDesktopConfigPath, describeDesktopChange, describeRegistration, desktopEntry, maskEntry, mergeDesktopConfig, parseClaudeMcpGet, sameRegistration, shellQuote, writeDesktopConfig } from "../src/lib/claude-config.js";

const launch = { command: "/usr/bin/node", args: ["--disable-warning=ExperimentalWarning", "/opt/cm/dist/index.js"], env: { CRAWLMARK_HOME: "/home/u/.crawlmark" } };

describe("Claude config", () => {
  it("finds Claude Desktop's config on each OS", () => {
    expect(claudeDesktopConfigPath("darwin", "/Users/u", {})).toBe("/Users/u/Library/Application Support/Claude/claude_desktop_config.json");
    expect(claudeDesktopConfigPath("win32", "C:/Users/u", { APPDATA: "C:/Users/u/AppData/Roaming" })).toBe(join("C:/Users/u/AppData/Roaming", "Claude", "claude_desktop_config.json"));
    expect(claudeDesktopConfigPath("linux", "/home/u", {})).toBe("/home/u/.config/Claude/claude_desktop_config.json");
    expect(claudeDesktopConfigPath("linux", "/home/u", { XDG_CONFIG_HOME: "/x" })).toBe("/x/Claude/claude_desktop_config.json");
    expect(claudeDesktopConfigPath("aix", "/home/u", {})).toBeUndefined();
  });

  it("builds `claude mcp add` with the name before -e and the env passed", () => {
    expect(claudeCodeAddArgs({ ...launch, command: "node" })).toEqual([
      "mcp", "add", "crawlmark", "-s", "user", "-e", "CRAWLMARK_HOME=/home/u/.crawlmark", "--", "node", "--disable-warning=ExperimentalWarning", "/opt/cm/dist/index.js",
    ]);
    expect(claudeCodeAddArgs({ command: "node", args: ["x.js"] })).toEqual(["mcp", "add", "crawlmark", "-s", "user", "--", "node", "x.js"]);
    expect(shellQuote("/a b/c")).toBe("'/a b/c'");
  });

  it("merges into an existing config, keeping other servers and keys", () => {
    const existing = JSON.stringify({ globalShortcut: "x", mcpServers: { other: { command: "other" } } }, null, 2);
    const r = mergeDesktopConfig(existing, desktopEntry(launch));
    const parsed = JSON.parse(r.text);
    expect(parsed.globalShortcut).toBe("x");
    expect(parsed.mcpServers.other).toEqual({ command: "other" });
    expect(parsed.mcpServers.crawlmark).toEqual({ command: "/usr/bin/node", args: launch.args, env: launch.env });
    expect(r).toMatchObject({ changed: true, replaced: false });
    expect(mergeDesktopConfig(r.text, desktopEntry(launch))).toMatchObject({ changed: false, replaced: true });
  });

  it("creates a config from nothing and refuses to clobber invalid files", () => {
    expect(JSON.parse(mergeDesktopConfig(undefined, { command: "n" }).text)).toEqual({ mcpServers: { crawlmark: { command: "n" } } });
    expect(() => mergeDesktopConfig("{ not json", {})).toThrow(/isn't valid JSON/);
    expect(() => mergeDesktopConfig("[]", {})).toThrow(/isn't a JSON object/);
    expect(() => mergeDesktopConfig('{"mcpServers": []}', {})).toThrow(/mcpServers/);
  });

  it("describes the change without ever showing other servers' config or any env value", () => {
    const existing = JSON.stringify({
      mcpServers: {
        github: { command: "gh-mcp", env: { GITHUB_TOKEN: "ghp_SECRET_other_server" } },
        slack: { command: "slack", args: ["--token", "xoxb-SECRET-in-args"] },
        crawlmark: { command: "node", args: ["old.js"], env: { CRAWLMARK_HOME: "/old", DATAFORSEO_PASSWORD: "SECRET_dfs" } },
      },
    });
    const entry = desktopEntry(launch);
    const merge = mergeDesktopConfig(existing, entry);
    const text = describeDesktopChange(merge, entry).join("\n");
    expect(text).not.toMatch(/SECRET/);
    expect(text).not.toContain("gh-mcp");
    expect(text).toContain("Other servers kept unchanged: github, slack");
    expect(text).toContain('"CRAWLMARK_HOME": "<hidden>"');
    expect(text).toContain('"DATAFORSEO_PASSWORD": "<hidden>"');
    expect(text).toContain("/opt/cm/dist/index.js");
    expect(text).toMatch(/env key DATAFORSEO_PASSWORD will be removed \(they stay in the \.bak copy\)/);
    // The new entry is still written in full.
    expect(JSON.parse(merge.text).mcpServers.github.env.GITHUB_TOKEN).toBe("ghp_SECRET_other_server");
  });

  it("a fresh add says so and warns about nothing", () => {
    const merge = mergeDesktopConfig(undefined, { command: "n" });
    expect(describeDesktopChange(merge, { command: "n" })).toEqual(["No other servers in the file.", "Adds this crawlmark entry:", "    {", '      "command": "n"', "    }"]);
    expect(maskEntry("x")).toBe("x");
  });

  it("maskEntry hides a non-object env and secret-looking args", () => {
    expect(maskEntry({ command: "n", env: ["hunter2FAKE"] })).toEqual({ command: "n", env: "<hidden>" });
    const masked = JSON.stringify(maskEntry({ command: "n", args: ["x.js", "--api-key=sk-FAKE", "--verbose"] }));
    expect(masked).not.toContain("sk-FAKE");
    expect(masked).toContain("--api-key=<hidden>");
    expect(masked).toContain("--verbose");
  });

  it("parses `claude mcp get` and compares it with the launch", () => {
    const out = `crawlmark:
  Scope: User config (available in all your projects)
  Status: \u001b[32m✓ Connected\u001b[39m
  Type: stdio
  Command: node
  Args: --disable-warning=ExperimentalWarning /opt/cm/dist/index.js
  Environment:
    CRAWLMARK_HOME=/home/u/.crawlmark

To remove this server, run: claude mcp remove "crawlmark" -s user
`;
    const reg = parseClaudeMcpGet(out)!;
    expect(reg).toEqual({ scope: "user", command: "node", args: "--disable-warning=ExperimentalWarning /opt/cm/dist/index.js", env: { CRAWLMARK_HOME: "/home/u/.crawlmark" } });
    expect(sameRegistration(reg, { ...launch, command: "node" })).toBe(true);
    expect(sameRegistration(reg, { ...launch, command: "node", env: {} })).toBe(false);
    expect(sameRegistration({ ...reg, args: "other.js" }, { ...launch, command: "node" })).toBe(false);
    expect(parseClaudeMcpGet("No MCP server found with name: crawlmark")).toBeUndefined();
    expect(parseClaudeMcpGet("x:\n  Scope: Local config\n  Command: npx\n  Args: -y crawlmark-mcp\n")).toEqual({ scope: "local", command: "npx", args: "-y crawlmark-mcp", env: {} });
    expect(describeRegistration({ ...reg, env: { TOKEN: "SECRET" } })).toBe("node --disable-warning=ExperimentalWarning /opt/cm/dist/index.js  (env: TOKEN=<hidden>)  [scope: user]");
  });

  it("writes atomically, keeps a .bak of the previous file and its mode", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "crawlmark-claude-")));
    const path = join(dir, "Claude", "claude_desktop_config.json");
    expect(writeDesktopConfig(path, '{"a":1}\n')).toBeUndefined();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    writeFileSync(path, '{"old":true}\n');
    chmodSync(path, 0o644);
    const backup = writeDesktopConfig(path, '{"new":true}\n');
    expect(backup).toBe(`${path}.bak`);
    expect(readFileSync(backup!, "utf8")).toBe('{"old":true}\n');
    expect(statSync(backup!).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe('{"new":true}\n');
    expect(statSync(path).mode & 0o777).toBe(0o644);
    expect(readdirSync(join(dir, "Claude")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
