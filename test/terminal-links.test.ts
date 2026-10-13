import { describe, expect, it, vi } from "vitest";
import { hyperlink, linkify, openerCommand, openUrl, safeLinkUrl, supportsHyperlinks } from "../src/lib/terminal-links.js";

const ESC = "\u001b";
const BEL = "\u0007";
const link = (url: string) => `${ESC}]8;;${url}${BEL}${url}${ESC}]8;;${BEL}`;

describe("supportsHyperlinks", () => {
  it("knows the terminals that render OSC 8, on a TTY only", () => {
    for (const p of ["iTerm.app", "WezTerm", "vscode", "ghostty"]) expect(supportsHyperlinks({ TERM_PROGRAM: p }, true)).toBe(true);
    expect(supportsHyperlinks({ TERM_PROGRAM: "Apple_Terminal" }, true)).toBe(false);
    expect(supportsHyperlinks({ TERM_PROGRAM: "iTerm.app" }, false)).toBe(false);
    expect(supportsHyperlinks({ WT_SESSION: "x" }, true)).toBe(true);
    expect(supportsHyperlinks({ KITTY_WINDOW_ID: "1" }, true)).toBe(true);
    expect(supportsHyperlinks({ VTE_VERSION: "5000" }, true)).toBe(true);
    expect(supportsHyperlinks({ VTE_VERSION: "4999" }, true)).toBe(false);
    expect(supportsHyperlinks({}, true)).toBe(false);
    expect(supportsHyperlinks({ TERM_PROGRAM: "iTerm.app", TERM: "dumb" }, true)).toBe(false);
  });

  it("FORCE_HYPERLINK=1 / 0 overrides detection", () => {
    expect(supportsHyperlinks({ FORCE_HYPERLINK: "1" }, false)).toBe(true);
    expect(supportsHyperlinks({ FORCE_HYPERLINK: "0", TERM_PROGRAM: "iTerm.app" }, true)).toBe(false);
  });
});

describe("safeLinkUrl", () => {
  it("accepts plain https URLs", () => {
    expect(safeLinkUrl("https://app.dataforseo.com/api-access")).toBe("https://app.dataforseo.com/api-access");
    expect(safeLinkUrl("https://analytics.google.com/analytics/web/#/admin")).toBeDefined();
  });

  it("refuses other schemes, control, bidi and non-ASCII characters, credentials and long URLs", () => {
    for (const bad of [
      "http://example.com/",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "https://example.com/\u0007",
      "https://example.com/\u001b]8;;https://evil.example/",
      "https://example.com/\u202E",
      "https://exämple.com/",
      "https://example.com/a b",
      "https://user:pw@example.com/",
      `https://example.com/${"a".repeat(2100)}`,
      "https://",
      "",
    ]) {
      expect(safeLinkUrl(bad), bad).toBeUndefined();
    }
  });
});

describe("hyperlink and linkify", () => {
  it("wraps a safe URL with the URL itself as the visible text", () => {
    expect(hyperlink("https://example.com/")).toBe(link("https://example.com/"));
    expect(hyperlink("http://example.com/")).toBe("http://example.com/");
  });

  it("links each safe https token, keeping trailing punctuation outside", () => {
    expect(linkify("Open https://example.com/a. Then https://example.org/b, done", true)).toBe(
      `Open ${link("https://example.com/a")}. Then ${link("https://example.org/b")}, done`,
    );
    expect(linkify("(see https://example.com/x)", true)).toBe(`(see ${link("https://example.com/x")})`);
    expect(linkify("plain http://example.com/ stays", true)).toBe("plain http://example.com/ stays");
  });

  it("strips control characters before adding links, so input escapes never survive", () => {
    const evil = `name \u001b]8;;https://evil.example/\u0007https://example.com/\u001b]8;;\u0007 \u202Eend`;
    const out = linkify(evil, true);
    // The only escapes left are the ones linkify built around a URL that is also the visible text.
    expect(out.replace(/\u001b\]8;;(https:\/\/[^\u0007]+)\u0007\1\u001b\]8;;\u0007/g, "<link>")).not.toMatch(/[\u001b\u0007\u202E]/);
    expect(linkify("a\u001b[31mb https://example.com/", false)).toBe("a[31mb https://example.com/");
  });

  it("leaves text unchanged (apart from stripping) when links are off", () => {
    expect(linkify("Find it at https://example.com/", false)).toBe("Find it at https://example.com/");
  });
});

describe("browser opener", () => {
  it("uses open, xdg-open, or rundll32 on Windows (never a shell)", () => {
    expect(openerCommand("https://example.com/", "darwin")).toEqual({ cmd: "open", args: ["https://example.com/"] });
    expect(openerCommand("https://example.com/", "linux")).toEqual({ cmd: "xdg-open", args: ["https://example.com/"] });
    expect(openerCommand("https://example.com/?a=1&b=2", "win32")).toEqual({ cmd: "rundll32.exe", args: ["url.dll,FileProtocolHandler", "https://example.com/?a=1&b=2"] });
  });

  it("spawns detached with no shell, and refuses unsafe URLs", () => {
    const child = { on: vi.fn(), unref: vi.fn() };
    const spawn = vi.fn(() => child);
    expect(openUrl("https://example.com/", { platform: "linux", spawn })).toBe(true);
    expect(spawn).toHaveBeenCalledWith("xdg-open", ["https://example.com/"], { shell: false, detached: true, stdio: "ignore" });
    expect(child.unref).toHaveBeenCalled();
    expect(openUrl("http://example.com/", { platform: "linux", spawn })).toBe(false);
    expect(openUrl("https://example.com/;rm -rf", { platform: "linux", spawn })).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("returns false when the opener can't start", () => {
    const spawn = vi.fn(() => {
      throw new Error("ENOENT");
    });
    expect(openUrl("https://example.com/", { platform: "linux", spawn })).toBe(false);
  });
});

describe("SEC-2: the normalised URL, never the raw input", () => {
  it("returns the WHATWG href for quirky spellings, or refuses them", () => {
    const bs = String.fromCharCode(92);
    expect(safeLinkUrl(`https:${bs}${bs}evil.example${bs}a`)).toBe("https://evil.example/a");
    expect(safeLinkUrl("https:evil.example")).toBe("https://evil.example/");
    expect(safeLinkUrl("HTTPS://x.example")).toBe("https://x.example/");
    expect(safeLinkUrl("https://app.dataforseo.com/api-access")).toBe("https://app.dataforseo.com/api-access");
  });

  it("the opener only ever gets the normalised href", () => {
    const bs = String.fromCharCode(92);
    const child = { on: vi.fn(), unref: vi.fn() };
    const spawn = vi.fn(() => child);
    for (const raw of [`https:${bs}${bs}evil.example${bs}a`, "https:evil.example", "HTTPS://x.example"]) openUrl(raw, { platform: "darwin", spawn });
    expect(spawn.mock.calls.map((c) => (c as unknown as [string, string[]])[1][0])).toEqual(["https://evil.example/a", "https://evil.example/", "https://x.example/"]);
  });

  it("linkify links only URLs that read the same as their href (a trailing slash aside)", () => {
    const bs = String.fromCharCode(92);
    expect(linkify("see https://example.com now", true)).toBe(`see ${ESC}]8;;https://example.com/${BEL}https://example.com${ESC}]8;;${BEL} now`);
    for (const odd of [`https:${bs}${bs}evil.example${bs}a`, "HTTPS://x.example/"]) expect(linkify(`see ${odd} now`, true)).toBe(`see ${odd} now`);
    expect(hyperlink("HTTPS://x.example")).toBe(link("https://x.example/"));
  });
});
