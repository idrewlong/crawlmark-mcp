import { describe, expect, it } from "vitest";
import { groupHelp, HELP_GROUPS, programName, topHelp, type HelpGroup } from "../src/cli-help.js";

const plain = { prog: "crawlmark-mcp" as const, bold: false };
const width = (text: string) => Math.max(...text.replace(/\u001b\[[0-9;]*m/g, "").split("\n").map((l) => Array.from(l).length));

/** Every flag the Phase 6s USAGE text listed, by group (a fixture of the old text). */
const OLD_FLAGS: Record<Exclude<HelpGroup, "init" | "report" | "check-ranks" | "index-coverage" | "crawl" | "logs">, string[]> = {
  setup: ["--step", "--dry-run", "--yes", "--json", "--only", "--refresh", "--to", "--force"],
  auth: ["login", "status", "logout"],
  clients: ["--refresh", "--name", "--ignore", "--area", "--niche", "--brand-terms"],
  competitors: ["--note"],
  keywords: ["--note"],
  brand: ["--all", "--apply", "--min-confidence", "--paid", "--paid-sparse", "--no-paid"],
  audit: ["--client", "--all", "--urls", "--dry-run"],
  "check-traffic": ["--client", "--all", "--dry-run"],
};

describe("help", () => {
  it("top level is grouped, has examples and fits in 80 columns", () => {
    const text = topHelp(plain);
    expect(width(text)).toBeLessThanOrEqual(80);
    for (const s of ["Get started", "Google", "Clients", "Scheduled", "Examples", "npx crawlmark-mcp@latest init", "help <command>"]) expect(text).toContain(s);
    expect(text).toContain("(no command: start the MCP server)");
    expect(topHelp({ ...plain, prog: "crawlmark-cli" })).not.toContain("start the MCP server");
  });

  it("each group's help lists every flag the old text listed, within 80 columns", () => {
    for (const [group, flags] of Object.entries(OLD_FLAGS)) {
      const text = groupHelp(group as HelpGroup, plain);
      expect(width(text), group).toBeLessThanOrEqual(80);
      for (const f of flags) expect(text, `${group} ${f}`).toContain(f);
    }
  });

  it("report help lists its flags and subcommands within 80 columns (Phase 12)", () => {
    const text = groupHelp("report", plain);
    expect(width(text)).toBeLessThanOrEqual(80);
    for (const f of ["--client", "--all", "--template", "--month", "--quarter", "--start", "--end", "--format", "--include", "--paid", "--dry-run", "templates list|validate [file]|init"]) expect(text, f).toContain(f);
    expect(topHelp(plain)).toContain("report");
  });

  it("init shows the setup help; the program name comes from argv[1]", () => {
    expect(groupHelp("init", plain)).toBe(groupHelp("setup", plain));
    expect(HELP_GROUPS).toContain("init");
    expect(programName("/x/dist/index.js")).toBe("crawlmark-mcp");
    expect(programName("/usr/local/bin/crawlmark-mcp")).toBe("crawlmark-mcp");
    expect(programName("/x/dist/cli.js")).toBe("crawlmark-cli");
    expect(programName(undefined)).toBe("crawlmark-cli");
  });

  it("headings are bold only when asked", () => {
    expect(topHelp(plain)).not.toContain("\u001b[");
    expect(groupHelp("setup", { ...plain, bold: true })).toContain("\u001b[1m");
  });
});
