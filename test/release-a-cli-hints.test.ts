import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringLiterals } from "./helpers/string-literals.js";
import { cliHint, cliHintDeps, NPX_COMMAND, resetCliHint } from "../src/lib/cli-hint.js";

const SRC = join(import.meta.dirname, "..", "src");

/** Files where the literal name is the point: the program name and the prefix logic itself. */
const ALLOWED = new Set(["cli-help.ts", "lib/cli-hint.ts"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Literal text containing the name (comments and regex literals are not scanned). */
function literalHits(file: string): string[] {
  return stringLiterals(readFileSync(file, "utf8"))
    .filter((l) => l.raw.includes("crawlmark-cli"))
    .map((l) => `${relative(SRC, file)}:${l.line}`);
}

describe("D9a: command hints come from one helper", () => {
  it("no hardcoded crawlmark-cli in user-facing strings", () => {
    const hits = walk(SRC)
      .filter((f) => f.endsWith(".ts") && !ALLOWED.has(relative(SRC, f).split(sep).join("/")))
      .flatMap(literalHits);
    expect(hits).toEqual([]);
  });

  it("no bare `Run: <subcommand>` hints (a subcommand alone is not a runnable command; use cliHint())", () => {
    const bare = /\bRun:\s+`?(?:gsc-history|index-coverage|clients|auth|setup|report|audit|check-traffic|competitors|keywords|brand-terms)\b/;
    const hits = walk(SRC)
      .filter((f) => f.endsWith(".ts"))
      .flatMap((f) => stringLiterals(readFileSync(f, "utf8")).filter((l) => bare.test(l.raw)).map((l) => `${relative(SRC, f)}:${l.line}`));
    expect(hits).toEqual([]);
  });

  it("no bare `setup --step` or `clients set ` hints (they follow a ${cliHint()} interpolation)", () => {
    const bare = /setup --step|clients set /g;
    // Not runnable hints: usage errors naming the subcommand.
    const known = [/^clients set takes exactly one client/, /^clients set needs --area/];
    const hits = walk(SRC)
      .filter((f) => f.endsWith(".ts") && relative(SRC, f).split(sep).join("/") !== "cli-help.ts")
      .flatMap((f) =>
        stringLiterals(readFileSync(f, "utf8"))
          .filter((l) => !known.some((k) => k.test(l.raw)))
          .filter((l) => [...l.raw.matchAll(bare)].some((m) => !(l.afterInterpolation && l.raw.slice(0, m.index).trim() === "")))
          .map((l) => `${relative(SRC, f)}:${l.line}`),
      );
    expect(hits).toEqual([]);
  });

  it("no hardcoded crawlmark-cli in prompt templates (they use {{cli}})", () => {
    const dir = join(SRC, "prompts", "templates");
    const bad = readdirSync(dir).filter((f) => readFileSync(join(dir, f), "utf8").includes("crawlmark-cli"));
    expect(bad).toEqual([]);
  });
});

describe("cliHint", () => {
  const real = { ...cliHintDeps };
  afterEach(() => {
    Object.assign(cliHintDeps, real);
    resetCliHint();
  });

  it("is crawlmark-cli when it is on PATH", () => {
    cliHintDeps.isCheckout = () => false;
    cliHintDeps.onPath = () => true;
    resetCliHint();
    expect(cliHint()).toMatch(/crawlmark-cli$/);
  });

  it("is the npx form when it isn't", () => {
    cliHintDeps.isCheckout = () => false;
    cliHintDeps.onPath = () => false;
    resetCliHint();
    expect(NPX_COMMAND).toBe("npx -y crawlmark-mcp@latest");
    expect(cliHint()).toMatch(/npx -y crawlmark-mcp@latest$/);
  });

  it("is npm run cli -- in a source checkout", () => {
    cliHintDeps.isCheckout = () => true;
    resetCliHint();
    expect(cliHint()).toMatch(/npm run cli --$/);
  });
});
