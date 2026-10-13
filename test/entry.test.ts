import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLI_SUBCOMMANDS, entryAction, packageVersion } from "../src/lib/entry.js";

describe("entryAction", () => {
  it("starts the stdio server when there are no arguments (MCP clients launch it that way)", () => {
    expect(entryAction([])).toBe("server");
  });

  it("hands every CLI subcommand to the CLI, so `npx crawlmark-mcp setup` runs the wizard", () => {
    for (const cmd of ["setup", "auth", "clients", "competitors", "keywords", "brand", "audit", "check-traffic", "help"]) {
      expect(CLI_SUBCOMMANDS).toContain(cmd);
      expect(entryAction([cmd, "x"])).toBe("cli");
    }
  });

  it("answers --version itself and sends --help (and typos) to the CLI instead of starting a server", () => {
    expect(entryAction(["--version"])).toBe("version");
    expect(entryAction(["-v"])).toBe("version");
    expect(entryAction(["--help"])).toBe("cli");
    expect(entryAction(["-h"])).toBe("cli");
    expect(entryAction(["stp"])).toBe("cli");
  });

  it("reads the version from package.json", () => {
    expect(packageVersion(new URL("../src/index.ts", import.meta.url).href)).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("crawlmark-mcp entry point", () => {
  const root = join(import.meta.dirname, "..");
  const home = mkdtempSync(join(tmpdir(), "crawlmark-entry-"));
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", join(root, "src", "index.ts"), ...args], {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, CRAWLMARK_HOME: home },
    });

  it("--version prints the package version and exits", () => {
    const r = run(["--version"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("--help prints the CLI usage and exits without starting the server", () => {
    const r = run(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage: crawlmark-cli");
    expect(r.stdout).toContain("setup");
  });

  it("an unknown word is a usage error, not a hung server", () => {
    const r = run(["stp"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Unknown command");
  });
});
