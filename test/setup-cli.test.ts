import { describe, expect, it } from "vitest";
import { appConfigPaths, buildChildEnv, shellOnlyEnv } from "../src/setup/cli-setup.js";

describe("child process env", () => {
  const env = { PATH: "/bin", DATAFORSEO_PASSWORD: "from-dotenv", SHELL_VAR: "x", CRAWLMARK_HOME: "/stale" };
  const fromFile = new Set(["DATAFORSEO_PASSWORD"]);

  it("drops variables loaded from .env so the child re-reads the edited file", () => {
    const e = buildChildEnv(env, fromFile, { dir: "/h", source: "env" });
    expect(e.DATAFORSEO_PASSWORD).toBeUndefined();
    expect(e.SHELL_VAR).toBe("x");
    expect(e.PATH).toBe("/bin");
  });

  it("passes CRAWLMARK_HOME only when the home isn't the project root", () => {
    expect(buildChildEnv(env, fromFile, { dir: "/h", source: "env" }).CRAWLMARK_HOME).toBe("/h");
    expect(buildChildEnv(env, fromFile, { dir: "/u/.crawlmark", source: "user" }).CRAWLMARK_HOME).toBe("/u/.crawlmark");
    expect("CRAWLMARK_HOME" in buildChildEnv(env, fromFile, { dir: "/repo", source: "project" })).toBe(false);
  });
});

describe("SEC-2: app config paths come from the shell env only", () => {
  const processEnv = { CODEX_HOME: "/from-dotenv/codex", XDG_CONFIG_HOME: "/from-dotenv/xdg", APPDATA: "C:\\from-dotenv", CRAWLMARK_CURSOR_CONFIG: "/from-dotenv/mcp.json", PATH: "/bin" };
  const envFileKeys = new Set(["CODEX_HOME", "XDG_CONFIG_HOME", "APPDATA", "CRAWLMARK_CURSOR_CONFIG"]);

  it("ignores CODEX_HOME, XDG_CONFIG_HOME, APPDATA and overrides that came from .env", () => {
    const shell = shellOnlyEnv(processEnv, envFileKeys);
    expect(shell).toEqual({ PATH: "/bin" });
    expect(appConfigPaths(shell, "/home/u", "linux")).toEqual({
      desktopConfig: "/home/u/.config/Claude/claude_desktop_config.json",
      cursorConfig: "/home/u/.cursor/mcp.json",
      codexConfig: "/home/u/.codex/config.toml",
    });
  });

  it("honours the same variables when the shell sets them", () => {
    const shell = shellOnlyEnv({ ...processEnv }, new Set());
    expect(appConfigPaths(shell, "/home/u", "linux")).toEqual({
      desktopConfig: "/from-dotenv/xdg/Claude/claude_desktop_config.json",
      cursorConfig: "/from-dotenv/mcp.json",
      codexConfig: "/from-dotenv/codex/config.toml",
    });
  });
});
