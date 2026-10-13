import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { BANNER_LINES, BANNER_WIDTH, printBanner } from "../src/setup/banner.js";
import { clackUi, type ClackUiFns } from "../src/setup/ui-clack.js";

function sink(extra: { isTTY?: boolean; columns?: number } = {}) {
  let text = "";
  const out = Object.assign(
    new Writable({
      write(chunk, _enc, cb) {
        text += chunk.toString();
        cb();
      },
    }),
    extra,
  );
  return { out, text: () => text };
}

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("banner", () => {
  it("is six lines that fit an 80-column terminal", () => {
    expect(BANNER_LINES).toHaveLength(6);
    expect(BANNER_WIDTH).toBeLessThanOrEqual(80);
    for (const l of BANNER_LINES) expect([...l].length).toBe(BANNER_WIDTH);
  });

  it("prints every line and a separator when the terminal is wide enough", () => {
    const s = sink({ columns: 100 });
    expect(printBanner(s.out, { animate: false })).toBe(true);
    const out = plain(s.text());
    for (const l of BANNER_LINES) expect(out).toContain(l);
    expect(out).toContain("─".repeat(BANNER_WIDTH - 2));
    expect(out).not.toContain("\r");
  });

  it("is skipped on a narrow terminal", () => {
    const s = sink({ columns: 60 });
    expect(printBanner(s.out, { animate: false })).toBe(false);
    expect(s.text()).toBe("");
  });

  it("animates only when asked or on a TTY", () => {
    const s = sink({ columns: 100, isTTY: true });
    printBanner(s.out);
    expect(s.text()).toContain("\r");
  });

  it("clackUi shows it before the intro only when enabled", () => {
    const calls: string[] = [];
    const fns = {
      intro: () => calls.push("intro"),
      outro: () => {},
      log: { info: () => {}, warn: () => {}, step: () => {}, error: () => {}, success: () => {}, message: () => {} },
      note: () => {},
      box: () => {},
      spinner: () => ({}),
    } as unknown as ClackUiFns;
    const info = { version: "0.0.0", home: "/tmp/h", command: "init" as const, dryRun: false };

    const on = sink({ columns: 100 });
    clackUi({ output: on.out, fns, banner: true }).intro(info);
    expect(plain(on.text())).toContain(BANNER_LINES[0]!);
    expect(calls).toEqual(["intro"]);

    const off = sink({ columns: 100 });
    clackUi({ output: off.out, fns }).intro(info);
    expect(off.text()).toBe("");
  });
});
