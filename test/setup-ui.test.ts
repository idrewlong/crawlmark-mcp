import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { autoPrompter, createPrompter, parseMultiSelect, PromptAbortedError, type LineSource } from "../src/setup/prompter.js";
import { stripControl } from "../src/lib/terminal-text.js";
import { chooseRenderer, plainUi, recordingUi } from "../src/setup/ui.js";
import { clackPrompter, clackUi, SECRET_MASK, type ClackPromptFns } from "../src/setup/ui-clack.js";

const CANCEL = Symbol("clack:cancel");

function fakeClack(answers: unknown[]): ClackPromptFns & { calls: { fn: string; opts: Record<string, unknown> }[] } {
  const calls: { fn: string; opts: Record<string, unknown> }[] = [];
  const answer = (fn: string) => async (opts: Record<string, unknown>) => {
    calls.push({ fn, opts });
    return answers.shift();
  };
  return {
    calls,
    text: answer("text") as never,
    password: answer("password") as never,
    confirm: answer("confirm") as never,
    select: answer("select") as never,
    multiselect: answer("multiselect") as never,
    isCancel: ((v: unknown) => v === CANCEL) as never,
  };
}

function scriptedLines(answers: string[]): LineSource & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    line: async (p) => {
      prompts.push(p);
      if (!answers.length) throw new Error(`Unexpected prompt: ${p}`);
      return answers.shift()!;
    },
    secret: async () => "",
    close() {},
  };
}

const APPS = [
  { value: "claude-code", label: "Claude Code" },
  { value: "claude-desktop", label: "Claude Desktop" },
  { value: "cursor", label: "Cursor" },
  { value: "codex", label: "Codex" },
] as const;

describe("chooseRenderer", () => {
  const tty = { stdinTTY: true, stdoutTTY: true, yes: false };
  it("is fancy only with two TTYs and none of CI, TERM=dumb, NO_COLOR or --yes", () => {
    expect(chooseRenderer({ ...tty, env: {} })).toBe("fancy");
    expect(chooseRenderer({ ...tty, stdinTTY: false, env: {} })).toBe("plain");
    expect(chooseRenderer({ ...tty, stdoutTTY: false, env: {} })).toBe("plain");
    expect(chooseRenderer({ ...tty, yes: true, env: {} })).toBe("plain");
    expect(chooseRenderer({ ...tty, env: { CI: "true" } })).toBe("plain");
    expect(chooseRenderer({ ...tty, env: { CI: "1" } })).toBe("plain");
    expect(chooseRenderer({ ...tty, env: { TERM: "dumb" } })).toBe("plain");
    expect(chooseRenderer({ ...tty, env: { NO_COLOR: "1" } })).toBe("plain");
  });
  it("CI=false, CI=0 and an empty NO_COLOR don't count", () => {
    expect(chooseRenderer({ ...tty, env: { CI: "false" } })).toBe("fancy");
    expect(chooseRenderer({ ...tty, env: { CI: "0" } })).toBe("fancy");
    expect(chooseRenderer({ ...tty, env: { NO_COLOR: "" } })).toBe("fancy");
  });
});

describe("plainUi", () => {
  it("prints today's wizard text", async () => {
    const lines: string[] = [];
    const ui = plainUi((l = "") => lines.push(l));
    ui.intro({ command: "setup", version: "0.1.0", home: "/h", dryRun: true });
    ui.step("DataForSEO", { index: 2, total: 6 });
    ui.step("Google");
    expect(await ui.spin("Checking...", async () => 7)).toBe(7);
    await ui.spin("Reading status", async () => 0, { plain: false });
    ui.result("done", "ok.");
    ui.preview("Title", ["  a"]);
    ui.summary({ steps: [{ step: "node", outcome: "done" }], rows: [], next: [], rerun: "Re-run." });
    ui.outro("Done");
    expect(lines).toEqual([
      "crawlmark setup. Config home: /h",
      "Dry run: nothing will be written or registered. Free read-only checks still run.",
      "",
      "== 2/6 DataForSEO ==",
      "",
      "== Google ==",
      "Checking...",
      "-> done: ok.",
      "Title",
      "  a",
      "",
      "Summary:",
      "  node       done",
      "Re-run.",
    ]);
  });

  it("recordingUi records calls", async () => {
    const ui = recordingUi();
    ui.success("yes");
    await ui.spin("Checking", async () => 1);
    expect(ui.events).toEqual(["success: yes", "spin: Checking"]);
  });
});

describe("Prompter.multiselect", () => {
  it("parses comma lists of numbers and names", () => {
    expect(parseMultiSelect("", APPS)).toBeUndefined();
    expect(parseMultiSelect("1, codex", APPS)).toEqual({ values: ["claude-code", "codex"] });
    expect(parseMultiSelect("Claude Desktop", APPS)).toEqual({ values: ["claude-desktop"] });
    expect(parseMultiSelect("none", APPS)).toEqual({ values: [] });
    expect(parseMultiSelect("2,vim", APPS)).toEqual({ unknown: ["vim"] });
  });

  it("terminal: Enter on the summary takes the defaults", async () => {
    const out: string[] = [];
    const src = scriptedLines([""]);
    const p = createPrompter(src, (l) => out.push(l));
    expect(await p.multiselect!("Add crawlmark to which apps?", APPS, ["claude-code", "codex"], { summary: "Register with: Claude Code, Codex (detected). Use these?" })).toEqual(["claude-code", "codex"]);
    expect(src.prompts).toEqual(["Register with: Claude Code, Codex (detected). Use these? [Y/n] "]);
  });

  it("terminal: no shows the list; unknown names ask again; Enter there takes the defaults", async () => {
    const out: string[] = [];
    const p = createPrompter(scriptedLines(["n", "vim", "3,codex"]), (l) => out.push(l));
    expect(await p.multiselect!("Add crawlmark to which apps?", APPS, ["codex"], { summary: "Use these?" })).toEqual(["cursor", "codex"]);
    expect(out).toContain("  4) Codex (default)");
    expect(out).toContain("Not one of the options: vim.");
    const q = createPrompter(scriptedLines([""]), () => {});
    expect(await q.multiselect!("Apps?", APPS, ["cursor"])).toEqual(["cursor"]);
  });

  it("auto: the defaults", async () => {
    const out: string[] = [];
    expect(await autoPrompter((l) => out.push(l)).multiselect!("Add crawlmark to which apps?", APPS, ["claude-code"])).toEqual(["claude-code"]);
    expect(out).toEqual(["Add crawlmark to which apps? Claude Code (--yes)"]);
  });
});

describe("clackPrompter", () => {
  it("passes defaults, masks secrets and keeps initial values for multiselect", async () => {
    const fns = fakeClack(["", "s3cret ", true, "B", ["codex"]]);
    const p = clackPrompter(fns);
    expect(await p.ask("Login", { default: "you@example.com" })).toBe("you@example.com");
    expect(await p.secret("Password")).toBe("s3cret");
    expect(await p.confirm("OK?", false)).toBe(true);
    expect(await p.choose("Pick", [{ value: "A", label: "a" }, { value: "B", label: "b" }], "A")).toBe("B");
    expect(await p.multiselect!("Apps", APPS, ["claude-code", "codex"])).toEqual(["codex"]);
    expect(fns.calls.map((c) => c.fn)).toEqual(["text", "password", "confirm", "select", "multiselect"]);
    expect(fns.calls[1]!.opts).toMatchObject({ message: "Password", mask: SECRET_MASK });
    expect(fns.calls[2]!.opts).toMatchObject({ initialValue: false });
    expect(fns.calls[3]!.opts).toMatchObject({ initialValue: "A" });
    expect(fns.calls[4]!.opts).toMatchObject({ initialValues: ["claude-code", "codex"], required: false });
  });

  it("turns clack's cancel symbol into PromptAbortedError", async () => {
    for (const call of [(p: ReturnType<typeof clackPrompter>) => p.ask("x"), (p: ReturnType<typeof clackPrompter>) => p.secret("x"), (p: ReturnType<typeof clackPrompter>) => p.multiselect!("x", APPS, [])]) {
      await expect(call(clackPrompter(fakeClack([CANCEL])))).rejects.toBeInstanceOf(PromptAbortedError);
    }
  });
});

describe("clackUi", () => {
  it("renders through clack to the given stream: intro, spinner result, notes and the summary box", async () => {
    let text = "";
    const output = new Writable({
      write(chunk, _enc, cb) {
        text += chunk.toString();
        cb();
      },
    });
    const ui = clackUi({ output });
    ui.intro({ command: "init", version: "0.1.0", home: "/h", dryRun: false });
    ui.step("DataForSEO", { index: 2, total: 6 });
    const fn = vi.fn(async () => 42);
    expect(await ui.spin("Checking with DataForSEO...", fn)).toBe(42);
    ui.success("DataForSEO works");
    ui.preview("Claude Desktop", ["Adds this crawlmark entry:"]);
    ui.summary({ steps: [{ step: "node", outcome: "done" }], rows: [{ label: "Node", outcome: "done" }, { label: "PageSpeed", outcome: "skipped" }], next: ["Restart Claude Desktop"], rerun: "" });
    ui.outro("Done");
    const plain = text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
    expect(plain).toContain("crawlmark");
    expect(plain).toContain("Config home: /h");
    expect(plain).toContain("DataForSEO works");
    expect(plain).toContain("Adds this crawlmark entry:");
    expect(plain).toContain("crawlmark is ready");
    expect(plain).toContain("1. Restart Claude Desktop");
    expect(plain).toContain("Done");
    expect(fn).toHaveBeenCalledOnce();
  });
});

describe("SEC-3: control characters never reach the terminal", () => {
  const evil = "srv\u001b]0;pwned\u0007\u001b[2J\u009bname\u007f";

  it("stripControl removes C0, C1 and DEL but keeps tab and newline", () => {
    expect(stripControl(evil)).toBe("srv]0;pwned[2Jname");
    expect(stripControl("a\tb\nc ✔ €")).toBe("a\tb\nc ✔ €");
  });

  it("plainUi strips every line and leaves normal text byte-identical", async () => {
    const lines: string[] = [];
    const ui = plainUi((l = "") => lines.push(l));
    ui.line(evil);
    ui.preview(`Cursor config: ${evil}`, [`Other servers kept unchanged: ${evil}`]);
    ui.success("Saved X to /h/.env (mode 0600).");
    await ui.spin(evil, async () => 0);
    expect(lines.join("\n")).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(lines).toContain("Saved X to /h/.env (mode 0600).");
  });

  it("clackUi strips untrusted text in line, log, note and box", async () => {
    let text = "";
    const output = new Writable({
      write(chunk, _enc, cb) {
        text += chunk.toString();
        cb();
      },
    });
    const ui = clackUi({ output });
    ui.line(evil);
    ui.success(evil);
    ui.preview(`Cursor config: ${evil}`, [evil]);
    ui.summary({ steps: [], rows: [{ label: evil, outcome: "done" }], next: [evil], rerun: "" });
    await ui.spin(evil, async () => 0);
    expect(text).not.toContain("\u001b]0;pwned");
    expect(text).not.toContain("\u0007");
    expect(text).not.toContain("\u001b[2J");
    expect(text).not.toContain("\u009b");
    expect(text).toContain("]0;pwned");
  });
});

describe("clackUi keeps real colour codes intact (SEC-3 regression)", () => {
  it("with FORCE_COLOR every SGR code keeps its ESC, and injected escapes are still stripped", async () => {
    const before = process.env.FORCE_COLOR;
    process.env.FORCE_COLOR = "1";
    try {
      let text = "";
      const output = new Writable({
        write(chunk, _enc, cb) {
          text += chunk.toString();
          cb();
        },
      });
      const ui = clackUi({ output });
      ui.intro({ command: "init", version: "0.1.0", home: "/h\u001b[2J", dryRun: true });
      ui.step("DataForSEO", { index: 1, total: 6 });
      ui.result("skipped", "Skipped.");
      ui.result("done", "Done \u001b]0;pwned\u0007.");
      ui.success("ok");
      ui.preview("Cursor config: /x", ["line"]);
      ui.summary({ steps: [], rows: [{ label: "Node", outcome: "done" }], next: ["Restart"], rerun: "" });
      await ui.spin("Checking...", async () => 0);
      ui.outro("Done");
      // Real styling is present...
      expect(text).toMatch(/\u001b\[1m/);
      expect(text).toMatch(/\u001b\[2m/);
      // ...and no SGR code ever appears without its ESC (the regression printed literal "[1m").
      expect(text).not.toMatch(/(?<!\u001b)\[\d+(?:;\d+)*m/);
      expect(text).not.toContain("\u001b[2J");
      expect(text).not.toContain("\u001b]0;pwned");
      expect(text).toContain("]0;pwned");
    } finally {
      if (before === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = before;
    }
  });
});
