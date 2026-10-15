/** Template file reads go through one no-follow handle with a size cap (load.ts, write.ts). */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// `fstatReports` makes fstat under-report the size, as if the file grew after it was checked.
const state = vi.hoisted(() => ({ fstatReports: null as number | null }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    fstatSync: (fd: number) => {
      const st = real.fstatSync(fd);
      return state.fstatReports === null ? st : Object.assign(Object.create(st), { size: state.fstatReports, isFile: () => true });
    },
  };
});

import { readTemplateFile } from "../src/reports/templates/load.js";
import { MAX_TEMPLATE_BYTES } from "../src/reports/templates/schema.js";
import { planTemplateWrite, readCurrent, TemplateWriteError } from "../src/reports/templates/write.js";

const today = new Date("2026-10-13T12:00:00Z");
const newHome = () => {
  const home = mkdtempSync(join(tmpdir(), "crawlmark-tfr-"));
  mkdirSync(join(home, "config"), { recursive: true });
  return home;
};
const globalFile = (home: string) => join(home, "config", "report-templates.yaml");
const board = { title: "Board pack", period: { range: "last_quarter" }, sections: [{ id: "search", type: "search_overview" }] };
const big = `version: 1\n# ${"x".repeat(MAX_TEMPLATE_BYTES)}\n`;

afterEach(() => {
  state.fstatReports = null;
});

describe("readTemplateFile", () => {
  it("reports an over-size file", () => {
    const home = newHome();
    writeFileSync(globalFile(home), big);
    const r = readTemplateFile(globalFile(home), home, today);
    expect(r.status.valid).toBe(false);
    expect(r.status.errors?.[0]?.message).toMatch(/larger than 256 KB/);
  });

  it("reports a file that grew past the cap after it was checked", () => {
    const home = newHome();
    writeFileSync(globalFile(home), big);
    state.fstatReports = 10;
    const r = readTemplateFile(globalFile(home), home, today);
    expect(r.status.valid).toBe(false);
    expect(r.status.errors?.[0]?.message).toMatch(/larger than 256 KB/);
  });

  it("still reads a normal file", () => {
    const home = newHome();
    writeFileSync(globalFile(home), "version: 1\n");
    expect(readTemplateFile(globalFile(home), home, today).status.valid).toBe(true);
  });
});

describe("planTemplateWrite reads the current file safely", () => {
  it("refuses an over-size file, including one that grew after fstat", () => {
    const home = newHome();
    writeFileSync(globalFile(home), big);
    expect(() => planTemplateWrite({ homeDir: home, file: "global", id: "board", mode: "create", template: board, today })).toThrowError(TemplateWriteError);
    state.fstatReports = 10;
    expect(() => planTemplateWrite({ homeDir: home, file: "global", id: "board", mode: "create", template: board, today })).toThrow(/larger than 256 KB/);
  });

  // O_NOFOLLOW does not exist on Windows, and creating symlinks there needs privileges.
  it.skipIf(process.platform === "win32")("refuses a symlink at the template path, so its target never reaches the diff", () => {
    const home = newHome();
    const target = join(home, "elsewhere.txt");
    writeFileSync(target, "version: 1\n# TOP SECRET TEXT\n");
    symlinkSync(target, globalFile(home));
    // planTemplateWrite stops at assertSafeTarget first; readCurrent is the second line of defence when a link
    // is swapped in between that lstat walk and the read.
    expect(() => readCurrent(globalFile(home))).toThrow(/isn't a regular file/);
    expect(() => planTemplateWrite({ homeDir: home, file: "global", id: "board", mode: "create", template: board, today })).toThrow(/symlink/);
  });
});
