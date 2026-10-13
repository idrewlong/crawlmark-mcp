import { describe, expect, it } from "vitest";
import type { SetupStatusReport } from "../src/setup/status.js";
import { commandPrefix } from "../src/setup/status-providers.js";
import { renderStatus, statusWidth, supportsColor, supportsUnicode, tildify, visibleLength, wrapText } from "../src/setup/status-render.js";

const longPath = "/Users/someone/Library/Application Support/Some Very Long Folder Name/With/Many/Nested/Directories/config/clients.yaml";
const longUrl = "https://console.cloud.google.com/apis/library/analyticsadmin.googleapis.com?project=an-extremely-long-project-identifier-for-testing";

function report(): SetupStatusReport {
  return {
    home: { dir: "/home/u/.crawlmark", source: "user", reason: "installed package (no CRAWLMARK_HOME, not a source checkout)", envFile: "/home/u/.crawlmark/.env", envFileExists: true },
    cli: "npx crawlmark-mcp",
    integrations: [
      { id: "home", label: "Config home", state: "working", detail: "/home/u/.crawlmark (installed package).", next: null },
      { id: "dataforseo", label: "DataForSEO", state: "working", detail: "Credentials work (sandbox, balance $1.00).", next: null },
      { id: "google", label: "Google", state: "error", detail: "Google rejected the key: invalid_grant. " + "The key may have been deleted in Google Cloud. ".repeat(6), next: "npx crawlmark-mcp setup --step google" },
      { id: "ga4", label: "GA4", state: "error", detail: "The GA4 API isn't enabled.", next: longUrl },
      { id: "tagmanager", label: "Tag Manager", state: "configured", detail: "Signed in, but no containers are visible.", next: "https://tagmanager.google.com/" },
      { id: "psi", label: "PageSpeed Insights", state: "missing", detail: "Optional.", next: "npx crawlmark-mcp setup --step psi" },
      { id: "clients", label: "Clients", state: "working", detail: `3 client(s) in ${longPath}.`, next: null },
    ],
    summary: { working: 3, configured: 1, error: 2, missing: 1 },
    checkedAt: "2026-10-13T00:00:00.000Z",
    fromCache: false,
    costUsd: 0,
  };
}

const opts = { width: 80, color: false, unicode: true };

describe("renderStatus", () => {
  it("keeps every line within 80 columns, except a single token longer than the column", () => {
    const r = report();
    r.integrations[1]!.detail = "x ".repeat(150).trim(); // 300 characters
    const lines = renderStatus(r, { ...opts, color: true });
    for (const line of lines) {
      if (visibleLength(line) <= 80) continue;
      // Only an unbreakable token (the long URL) may overflow, alone on its line after the indent.
      expect(line.replace(/\u001b\[[0-9;]*m/g, "").trim().replace(/^→ /, "").split(" ").length).toBe(1);
    }
    expect(lines.filter((l) => visibleLength(l) > 80).length).toBeLessThanOrEqual(1);
    expect(lines.some((l) => l.includes(longUrl))).toBe(true);
    expect(lines.some((l) => l.includes(longPath.split("/").pop()!))).toBe(true);
  });

  it("has no colour codes when color is false, and some when true", () => {
    expect(renderStatus(report(), opts).join("\n")).not.toContain("\u001b[");
    expect(renderStatus(report(), { ...opts, color: true }).join("\n")).toContain("\u001b[");
  });

  it("uses ASCII icons when unicode is off", () => {
    const text = renderStatus(report(), { ...opts, unicode: false }).join("\n");
    for (const icon of ["[ok] Config home", "[x] Google", "[!] Tag Manager", "[ ] PageSpeed Insights"]) expect(text).toContain(icon);
    expect(text).not.toMatch(/[✔●✖○→·]/);
    expect(text).toContain("-> npx crawlmark-mcp setup --step google");
  });

  it("shows → only on rows that aren't working", () => {
    const lines = renderStatus(report(), opts);
    const arrows = lines.filter((l) => l.trim().startsWith("→")).map((l) => l.trim());
    expect(arrows).toEqual([
      "→ npx crawlmark-mcp setup --step google",
      `→ ${longUrl}`,
      "→ https://tagmanager.google.com/",
      "→ npx crawlmark-mcp setup --step psi",
    ]);
  });

  it("aligns details under a fixed label column and prints the header and footer", () => {
    const lines = renderStatus(report(), { ...opts, userHome: "/home/u" });
    expect(lines[0]).toBe("crawlmark status   home ~/.crawlmark (installed package)");
    const col = lines.find((l) => l.startsWith("✔ Config home"))!.indexOf("~/.crawlmark");
    expect(lines.find((l) => l.startsWith("✖ Google"))!.indexOf("Google rejected")).toBe(col);
    expect(lines.at(-1)).toBe("3 working · 1 needs attention · 2 errors · 1 not set up");
  });

  it("adds where to run commands for a checkout", () => {
    expect(renderStatus(report(), { ...opts, checkoutRoot: "/src/crawlmark" })[1]).toBe("Run commands from /src/crawlmark");
  });
});

describe("wrapText", () => {
  it("wraps on spaces and never breaks a long token", () => {
    expect(wrapText("aaa bbb ccc", 7)).toEqual(["aaa bbb", "ccc"]);
    expect(wrapText(`see ${longUrl} now`, 20)).toEqual(["see", longUrl, "now"]);
  });
});

describe("terminal capability helpers", () => {
  it("clamps the width to 60..100, or 80 off a TTY", () => {
    expect(statusWidth(40, true)).toBe(60);
    expect(statusWidth(200, true)).toBe(100);
    expect(statusWidth(90, true)).toBe(90);
    expect(statusWidth(200, false)).toBe(80);
  });
  it("detects unicode and colour support", () => {
    expect(supportsUnicode({ LANG: "en_US.UTF-8" }, "darwin")).toBe(true);
    expect(supportsUnicode({ LANG: "C" }, "linux")).toBe(false);
    expect(supportsUnicode({ LANG: "en_US.UTF-8", TERM: "dumb" }, "linux")).toBe(false);
    expect(supportsColor({}, true)).toBe(true);
    expect(supportsColor({ NO_COLOR: "1" }, true)).toBe(false);
    expect(supportsColor({}, false)).toBe(false);
  });
});

describe("commandPrefix", () => {
  const base = { cliOnPath: false, homeSource: "project" as const, homeDir: "/src/crawlmark", defaultHomeDir: "/src/crawlmark", userHome: "/home/u" };

  it("checkout, global install and npx", () => {
    expect(commandPrefix({ ...base, checkout: true })).toBe("npm run cli --");
    expect(commandPrefix({ ...base, checkout: false, cliOnPath: true, homeSource: "user", homeDir: "/home/u/.crawlmark", defaultHomeDir: "/home/u/.crawlmark" })).toBe("crawlmark-cli");
    expect(commandPrefix({ ...base, checkout: false, homeSource: "user", homeDir: "/home/u/.crawlmark", defaultHomeDir: "/home/u/.crawlmark" })).toBe("npx crawlmark-mcp");
  });

  it("adds CRAWLMARK_HOME only when it isn't this install's default, with ~ substituted", () => {
    expect(commandPrefix({ ...base, checkout: true, homeSource: "env", homeDir: "/src/crawlmark" })).toBe("npm run cli --");
    expect(commandPrefix({ ...base, checkout: false, homeSource: "env", homeDir: "/home/u/.crawlmark", defaultHomeDir: "/home/u/.crawlmark" })).toBe("npx crawlmark-mcp");
    expect(commandPrefix({ ...base, checkout: false, homeSource: "env", homeDir: "/home/u/work/crawlmark", defaultHomeDir: "/home/u/.crawlmark" })).toBe("CRAWLMARK_HOME=~/work/crawlmark npx crawlmark-mcp");
    expect(commandPrefix({ ...base, checkout: true, homeSource: "env", homeDir: "/srv/data" })).toBe("CRAWLMARK_HOME=/srv/data npm run cli --");
    expect(commandPrefix({ ...base, checkout: true, homeSource: "env", homeDir: "/home/u/my data" })).toBe("CRAWLMARK_HOME='/home/u/my data' npm run cli --");
  });
});

describe("renderStatus header", () => {
  it("puts a long home on its own line", () => {
    const r = report();
    r.home.dir = `/srv/${"x".repeat(70)}`;
    const lines = renderStatus(r, opts);
    expect(lines[0]).toBe("crawlmark status");
    expect(lines[1]).toBe(`home ${r.home.dir} (installed package)`);
  });
});

describe("R-3: tildify", () => {
  it("replaces only the home itself or home + separator", () => {
    expect(tildify("/Users/drew/.crawlmark/.env", "/Users/drew")).toBe("~/.crawlmark/.env");
    expect(tildify("/Users/drew2/.crawlmark", "/Users/drew")).toBe("/Users/drew2/.crawlmark");
    expect(tildify("/Users/drew.old/x", "/Users/drew")).toBe("/Users/drew.old/x");
    expect(tildify("home /Users/drew (installed)", "/Users/drew")).toBe("home ~ (installed)");
    expect(tildify("in /Users/drew.", "/Users/drew/")).toBe("in ~.");
    expect(tildify("/a+b/x and /a+b2", "/a+b")).toBe("~/x and /a+b2");
    expect(tildify("/mnt/Users/drew/x", "/Users/drew")).toBe("/mnt/Users/drew/x");
  });
});
