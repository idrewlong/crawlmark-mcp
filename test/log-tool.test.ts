/**
 * Phase 12 C2: the log_analysis tool reads only inside LOG_DIRS or <home>/logs, and is unavailable with a setup hint
 * when neither exists. LOG_DIRS is set for this file only (test/setup.ts clears it); verify: false, so no network.
 */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const root = mkdtempSync(join(tmpdir(), "crawlmark-log-tool-"));
const logs = join(root, "var-log");
const outside = join(root, "elsewhere");
mkdirSync(logs);
mkdirSync(outside);
writeFileSync(join(logs, "access.log"), '192.0.2.10 - - [10/Oct/2026:13:55:36 +0000] "GET /a?x=1 HTTP/1.1" 200 5 "-" "GPTBot/1.2"\n');
writeFileSync(join(outside, "other.log"), "x\n");
symlinkSync(join(outside, "other.log"), join(logs, "link.log"));

vi.mock("../src/clients.js", () => ({ resolveClient: vi.fn(async (c: string) => ({ slug: c, domain: c })) }));

type Cb = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
async function loadTool(logDirs: string | undefined): Promise<Cb> {
  vi.resetModules();
  if (logDirs === undefined) delete process.env.LOG_DIRS;
  else process.env.LOG_DIRS = logDirs;
  const { registerLogTools } = await import("../src/tools/logs.js");
  let cb: Cb | undefined;
  registerLogTools({ registerTool: (_n: string, _d: unknown, c: Cb) => void (cb = c) } as never);
  return cb!;
}

describe("log_analysis tool", () => {
  it("without LOG_DIRS (and no <home>/logs) it is unavailable with the setup hint", async () => {
    const r = await (await loadTool(undefined))({ client: "example.com", files: ["access.log"] });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Set LOG_DIRS to one or more absolute directories/);
  });

  it("reads files inside LOG_DIRS and refuses paths outside", async () => {
    const tool = await loadTool(`${logs}, not/absolute`);
    const ok = await tool({ client: "example.com", files: ["access.*"], verify: false });
    expect(ok.isError).toBeUndefined();
    const data = JSON.parse(ok.content[0]!.text);
    expect(data).toMatchObject({ client: "example.com", files: [{ name: "access.log", parsed: 1 }], bots: [{ bot: "GPTBot", hits: 1, parameterShare: 1 }] });
    expect(data.notes.join(" ")).toMatch(/"not\/absolute" isn't an absolute path/);
    expect(ok.content[0]!.text).not.toMatch(/192\.0\.2\.10|x=1/);

    for (const files of [[join(outside, "other.log")], ["../elsewhere/other.log"], ["link.log"]]) {
      const r = await tool({ client: "example.com", files, verify: false });
      expect(r.isError, files[0]).toBe(true);
      expect(r.content[0]!.text).toMatch(/outside the allowed log directories|can't contain|No readable log file/);
    }
    const none = await tool({ client: "example.com", files: ["nothing-*.log"], verify: false });
    expect(none.content[0]!.text).toMatch(/No log file matched/);
  });
});
