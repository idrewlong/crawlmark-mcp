import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// `fstatReports` lets a test make fstat under-report the size, as if the file grew after it was checked.
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

import { RegularFileError, readRegularFileCapped } from "../src/lib/read-regular-file.js";
import { loadLogo } from "../src/reports/export.js";
import { MAX_LOGO_BYTES } from "../src/reports/render/image.js";
import type { ResolvedBranding } from "../src/reports/templates/load.js";

const dir = () => mkdtempSync(join(tmpdir(), "crawlmark-rrf-"));
afterEach(() => {
  state.fstatReports = null;
});

describe("readRegularFileCapped", () => {
  it("reads a file within the cap", () => {
    const f = join(dir(), "a.txt");
    writeFileSync(f, "hello");
    expect(readRegularFileCapped(f, 10).toString()).toBe("hello");
  });

  it("refuses a file over the cap, and a directory", () => {
    const d = dir();
    const f = join(d, "big.txt");
    writeFileSync(f, "x".repeat(11));
    expect(() => readRegularFileCapped(f, 10)).toThrowError(expect.objectContaining({ reason: "too-large" }));
    mkdirSync(join(d, "sub"));
    // A directory opens read-only on POSIX but is not a regular file; Windows can't open it at all.
    expect(() => readRegularFileCapped(join(d, "sub"), 10)).toThrow();
  });

  it("re-checks the length actually read when the file grew after fstat", () => {
    const f = join(dir(), "grown.txt");
    writeFileSync(f, "x".repeat(5000));
    state.fstatReports = 1;
    expect(() => readRegularFileCapped(f, 100)).toThrowError(RegularFileError);
    expect(() => readRegularFileCapped(f, 100)).toThrowError(expect.objectContaining({ reason: "too-large" }));
  });

  // O_NOFOLLOW does not exist on Windows (and creating symlinks there needs privileges).
  it.skipIf(process.platform === "win32")("refuses a symlink", () => {
    const d = dir();
    writeFileSync(join(d, "real.txt"), "secret");
    symlinkSync(join(d, "real.txt"), join(d, "link.txt"));
    expect(() => readRegularFileCapped(join(d, "link.txt"), 100)).toThrow(/ELOOP|symbolic|symlink/i);
  });
});

describe("loadLogo size re-check", () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const branding = (resolved: string): ResolvedBranding => ({ logo: { path: "logo.png", resolved, exists: true } }) as ResolvedBranding;

  it("accepts a small PNG", () => {
    const f = join(dir(), "logo.png");
    writeFileSync(f, PNG);
    expect(loadLogo(branding(f)).logo?.mime).toBe("image/png");
  });

  it("drops a logo over 512 KB found by the size check", () => {
    const f = join(dir(), "logo.png");
    writeFileSync(f, Buffer.concat([PNG, Buffer.alloc(MAX_LOGO_BYTES)]));
    expect(loadLogo(branding(f)).warning).toMatch(/larger than 512 KB/);
  });

  it("drops a logo that grew past 512 KB after it was checked", () => {
    const f = join(dir(), "logo.png");
    writeFileSync(f, Buffer.concat([PNG, Buffer.alloc(MAX_LOGO_BYTES)]));
    state.fstatReports = 100;
    const r = loadLogo(branding(f));
    expect(r.logo).toBeUndefined();
    expect(r.warning).toMatch(/larger than 512 KB/);
  });
});
