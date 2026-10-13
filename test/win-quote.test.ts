import { describe, expect, it } from "vitest";
import { escapeWinArg, escapeWinCommand, winCmdArgs } from "../src/lib/win-quote.js";

describe("Windows cmd.exe quoting", () => {
  it("quotes every argument and caret-escapes cmd.exe metacharacters, including % and !", () => {
    expect(escapeWinArg("plain")).toBe('^"plain^"');
    expect(escapeWinArg("C:\\Program Files\\x")).toBe('^"C:\\Program^ Files\\x^"');
    expect(escapeWinArg("a&b|c<d>e")).toBe('^"a^&b^|c^<d^>e^"');
    expect(escapeWinArg("%PATH%")).toBe('^"^%PATH^%^"');
    expect(escapeWinArg("!x!")).toBe('^"^!x^!^"');
    expect(escapeWinArg("^(x)")).toBe('^"^^^(x^)^"');
    expect(escapeWinArg("")).toBe('^"^"');
  });

  it("escapes embedded quotes and trailing backslashes for the MSVCRT parser", () => {
    expect(escapeWinArg('say "hi"')).toBe('^"say^ \\^"hi\\^"^"');
    expect(escapeWinArg("dir\\")).toBe('^"dir\\\\^"');
    expect(escapeWinArg('a\\"b')).toBe('^"a\\\\\\^"b^"');
  });

  it("an injection attempt stays one literal argument", () => {
    const evil = 'x" & calc.exe & "';
    const quoted = escapeWinArg(evil);
    // Every & and every quote is escaped, so cmd.exe never sees a command separator.
    expect(quoted).not.toMatch(/(^|[^^])&/);
    expect(quoted.replace(/\^./g, "")).not.toMatch(/[&"|<>%!]/);
  });

  it("builds `cmd.exe /d /s /c \"...\"` argv", () => {
    expect(winCmdArgs("claude", ["mcp", "add", "crawlmark", "-e", "CRAWLMARK_HOME=C:\\Users\\A B\\.crawlmark"])).toEqual([
      "/d",
      "/s",
      "/c",
      '"claude ^"mcp^" ^"add^" ^"crawlmark^" ^"-e^" ^"CRAWLMARK_HOME=C:\\Users\\A^ B\\.crawlmark^""',
    ]);
    expect(escapeWinCommand("C:\\Program Files\\nodejs\\npm.cmd")).toBe("C:\\Program^ Files\\nodejs\\npm.cmd");
  });
});
