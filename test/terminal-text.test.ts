import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stripControl } from "../src/lib/terminal-text.js";
import { redact } from "../src/providers/units-billing.js";

// Built from code points so this file holds no invisible characters itself.
const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

// SEC-5 (Phase 9 security review, extended in the Phase 10 review): bidi controls, zero-width and other
// format characters (Unicode category Cf) and the line/paragraph separators can make displayed text read
// differently from what it is, so they are removed along with the control characters.
const INVISIBLE = [
  ...range(0x200b, 0x200f),
  ...range(0x202a, 0x202e),
  ...range(0x2060, 0x2064),
  ...range(0x2066, 0x206f),
  0x00ad, // soft hyphen
  0x061c, // Arabic letter mark
  0x180e, // Mongolian vowel separator
  0xfeff, // BOM / zero-width no-break space
  ...range(0xfff9, 0xfffb), // interlinear annotation
  0xe0001,
  0xe0041, // tag characters
  0xe007f,
  0x2028, // line separator
  0x2029, // paragraph separator
];

describe("SEC-5: bidi, format and separator characters", () => {
  it("stripControl removes every one of them", () => {
    for (const c of INVISIBLE) expect(stripControl(`a${cp(c)}b`), `U+${c.toString(16).toUpperCase()}`).toBe("ab");
    expect(stripControl(`key${cp(0x202e)}txt.exe${cp(0x2066, 0xfeff)}`)).toBe("keytxt.exe");
  });

  it("still removes C0/C1 controls and DEL, keeping tab and newline", () => {
    expect(stripControl(`a${cp(0x1b)}[2J${cp(0x07, 0x9b, 0x7f)}b\tc\nd`)).toBe("a[2Jb\tc\nd");
  });

  it("leaves visible Unicode alone: accents, emoji, symbols, CJK, box drawing", () => {
    const text = `Café Example Co ✔ € — ‘quoted’ 東京 ╭─╮ │ ${cp(0x1f600)} ${cp(0x1f44d, 0x1f3fd)} 2010${cp(0x2010)}`;
    expect(stripControl(text)).toBe(text);
    expect(stripControl("crawlmark setup. Config home: /h")).toBe("crawlmark setup. Config home: /h");
  });

  it("redact strips them from vendor text too", () => {
    expect(redact(`bad${cp(0x202e)} key${cp(0x200b)} here`, ["secret-key"])).toBe("bad key here");
    expect(redact(`err secret-key${cp(0x2067)}`, ["secret-key"])).toBe("err <redacted>");
  });
});

describe("no invisible characters in the source", () => {
  // Format characters (Cf) and the separators can hide code from review ("Trojan Source"); escapes only.
  const HIDDEN = new RegExp(`[\\p{Cf}${cp(0x2028)}${cp(0x2029)}]`, "u");
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.(ts|md|json|ya?ml)$/.test(e.name) ? [join(dir, e.name)] : []));

  it("src/ and test/ contain none", () => {
    const root = resolve(import.meta.dirname, "..");
    const hits: string[] = [];
    for (const f of [...files(join(root, "src")), ...files(join(root, "test"))]) {
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          const m = HIDDEN.exec(line);
          if (m) hits.push(`${f.slice(root.length + 1)}:${i + 1} U+${m[0].codePointAt(0)!.toString(16).toUpperCase()}`);
        });
    }
    expect(hits).toEqual([]);
  });
});
