import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { applySecretInput, autoPrompter, createPrompter, NeedsInputError, pipedSecretWarning, PromptAbortedError, readSecretFromTTY, type LineSource } from "../src/setup/prompter.js";

class FakeTTY extends EventEmitter {
  isTTY = true;
  isRaw = false;
  rawCalls: boolean[] = [];
  setRawMode(m: boolean) {
    this.isRaw = m;
    this.rawCalls.push(m);
  }
  resume() {}
  pause() {}
}

describe("secret input", () => {
  it("applySecretInput handles typing, backspace, Ctrl-U, escapes, enter, Ctrl-C and Ctrl-D", () => {
    expect(applySecretInput("", "abc")).toEqual({ buffer: "abc" });
    expect(applySecretInput("abc", "\u007f\u007fz")).toEqual({ buffer: "az" });
    expect(applySecretInput("abc", "\u0015x")).toEqual({ buffer: "x" });
    expect(applySecretInput("a", "\u001b[A")).toEqual({ buffer: "a" });
    expect(applySecretInput("pw", "d\r")).toEqual({ buffer: "pwd", done: "enter" });
    expect(applySecretInput("pw", "\u0003")).toMatchObject({ done: "abort" });
    expect(applySecretInput("", "\u0004")).toMatchObject({ done: "eof" });
    expect(applySecretInput("pw", "\u0004")).toMatchObject({ done: "enter" });
    // A pasted secret with a trailing newline.
    expect(applySecretInput("", "s3cr3t-paste\n")).toEqual({ buffer: "s3cr3t-paste", done: "enter" });
  });

  it("readSecretFromTTY writes no echo (only the prompt and a newline) and restores the terminal", async () => {
    const input = new FakeTTY();
    const written: string[] = [];
    const p = readSecretFromTTY(input, { write: (s: string) => written.push(s) }, "Password: ");
    input.emit("data", Buffer.from("hunt"));
    input.emit("data", Buffer.from("er2\r"));
    await expect(p).resolves.toBe("hunter2");
    expect(written).toEqual(["Password: ", "\n"]);
    expect(input.rawCalls).toEqual([true, false]);
    expect(input.listenerCount("data")).toBe(0);
  });

  it("warns when a secret can't be hidden: piped input, terminal output", () => {
    expect(pipedSecretWarning({ isTTY: false }, { isTTY: true })).toMatch(/can't be hidden/);
    expect(pipedSecretWarning({ isTTY: true }, { isTTY: true })).toBeUndefined();
    expect(pipedSecretWarning({ isTTY: false }, { isTTY: false })).toBeUndefined();
  });

  it("Ctrl-C while typing a secret aborts", async () => {
    const input = new FakeTTY();
    const p = readSecretFromTTY(input, { write: () => true }, "Key: ");
    input.emit("data", "ab\u0003");
    await expect(p).rejects.toBeInstanceOf(PromptAbortedError);
    expect(input.isRaw).toBe(false);
  });
});

function scripted(answers: string[]): LineSource & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    line: async (p) => {
      prompts.push(p);
      if (!answers.length) throw new Error("no more answers");
      return answers.shift()!;
    },
    secret: async (p) => {
      prompts.push(p);
      return answers.shift()!;
    },
    close() {},
  };
}

describe("createPrompter", () => {
  it("ask falls back to the default; confirm re-asks on junk; choose takes numbers or names", async () => {
    const lines: string[] = [];
    const src = scripted(["", "maybe", "y", "", "2", "live", "9", "1"]);
    const p = createPrompter(src, (s) => lines.push(s));
    expect(await p.ask("Login", { default: "a@example.com" })).toBe("a@example.com");
    expect(await p.confirm("Go?", false)).toBe(true);
    expect(await p.confirm("Again?", true)).toBe(true);
    const choices = [{ value: "sandbox", label: "sandbox" }, { value: "live", label: "live" }] as const;
    expect(await p.choose("Mode?", choices, "sandbox")).toBe("live");
    expect(await p.choose("Mode?", choices, "sandbox")).toBe("live");
    expect(await p.choose("Mode?", choices, "sandbox")).toBe("sandbox");
    expect(lines).toContain("Please answer y or n.");
    expect(lines).toContain("Not one of the options.");
    expect(src.prompts[0]).toBe("Login [a@example.com]: ");
  });

  it("secret prompts say the input is hidden", async () => {
    const src = scripted(["  k  "]);
    expect(await createPrompter(src, () => {}).secret("API key")).toBe("k");
    expect(src.prompts[0]).toBe("API key (input hidden): ");
  });
});

describe("autoPrompter (--yes)", () => {
  it("accepts defaults and refuses questions with no default", async () => {
    const out: string[] = [];
    const p = autoPrompter((s) => out.push(s));
    expect(await p.confirm("Change?", false)).toBe(false);
    expect(await p.confirm("Register?", true)).toBe(true);
    expect(await p.ask("Login", { default: "a@example.com" })).toBe("a@example.com");
    expect(await p.choose("Mode", [{ value: "sandbox", label: "sandbox" }], "sandbox")).toBe("sandbox");
    await expect(p.ask("Path")).rejects.toBeInstanceOf(NeedsInputError);
    await expect(p.secret("Password")).rejects.toBeInstanceOf(NeedsInputError);
    expect(out.every((l) => l.endsWith("(--yes)"))).toBe(true);
  });
});
