import { createInterface, type Interface } from "node:readline/promises";

/**
 * Terminal input for the setup wizard, with no dependencies: node:readline/promises
 * for lines, and raw-mode reading for secrets so nothing is echoed (not even
 * asterisks). The wizard only sees the Prompter interface, so its steps are
 * tested with scripted answers and no TTY.
 */

export interface Choice<T extends string> {
  value: T;
  label: string;
  /** A short note shown next to the label (fancy: dimmed; plain: in parentheses). */
  hint?: string;
}

export interface Prompter {
  /** A line of text; Enter returns `default` (or "" when there is none). */
  ask(question: string, opts?: { default?: string | undefined }): Promise<string>;
  /** A secret: never echoed. Enter returns "". */
  secret(question: string): Promise<string>;
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  choose<T extends string>(question: string, choices: readonly Choice<T>[], defaultValue: T): Promise<T>;
  /**
   * Pick any number of choices; Enter keeps `defaults`. `summary` is the one-line
   * question a line-based prompter asks first ("Register with: A, B. Use these?");
   * answering no shows the numbered list. Optional: a prompter without it (an
   * older test double) takes the defaults.
   */
  multiselect?<T extends string>(question: string, choices: readonly Choice<T>[], defaults: readonly T[], opts?: { summary?: string }): Promise<T[]>;
  /**
   * Pick any number of choices shown under group headings (the template builder's sections). Optional; a
   * prompter without it falls back to `multiselect` with the group in each label.
   */
  groupMultiselect?<T extends string>(question: string, groups: readonly ChoiceGroup<T>[], defaults: readonly T[]): Promise<T[]>;
  close(): void;
}

export interface ChoiceGroup<T extends string> {
  label: string;
  choices: readonly Choice<T>[];
}

/** Parse a comma list of numbers or names against the choices (pure). Empty input is undefined (take the defaults). */
export function parseMultiSelect<T extends string>(answer: string, choices: readonly Choice<T>[]): { values: T[] } | { unknown: string[] } | undefined {
  const a = answer.trim().toLowerCase();
  if (a === "") return undefined;
  if (a === "none" || a === "-") return { values: [] };
  const values: T[] = [];
  const unknown: string[] = [];
  for (const raw of a.split(",").map((t) => t.trim()).filter(Boolean)) {
    const n = Number(raw);
    const hit = Number.isInteger(n) && n >= 1 && n <= choices.length ? choices[n - 1] : choices.find((c) => c.value.toLowerCase() === raw || c.label.toLowerCase() === raw);
    if (!hit) unknown.push(raw);
    else if (!values.includes(hit.value)) values.push(hit.value);
  }
  return unknown.length ? { unknown } : { values };
}

/** The user pressed Ctrl-C. */
export class PromptAbortedError extends Error {
  constructor() {
    super("Setup cancelled.");
    this.name = "PromptAbortedError";
  }
}

/** --yes: a question had no default to accept (a secret, or a value with no current setting). */
export class NeedsInputError extends Error {
  constructor(question: string) {
    super(`"${question.trim()}" needs an answer; run without --yes to enter it.`);
    this.name = "NeedsInputError";
  }
}

/** Raw line input and secret input; confirm/choose are built on top in createPrompter. */
export interface LineSource {
  line(prompt: string): Promise<string>;
  secret(prompt: string): Promise<string>;
  close(): void;
}

export function parseYesNo(answer: string, defaultYes: boolean): boolean | undefined {
  const a = answer.trim().toLowerCase();
  if (a === "") return defaultYes;
  if (a === "y" || a === "yes") return true;
  if (a === "n" || a === "no") return false;
  return undefined;
}

export function createPrompter(src: LineSource, out: (s: string) => void): Prompter {
  return {
    async ask(question, opts = {}) {
      const d = opts.default;
      const answer = (await src.line(`${question}${d ? ` [${d}]` : ""}: `)).trim();
      return answer === "" ? (d ?? "") : answer;
    },
    async secret(question) {
      return (await src.secret(`${question} (input hidden): `)).trim();
    },
    async confirm(question, defaultYes) {
      for (;;) {
        const v = parseYesNo(await src.line(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `), defaultYes);
        if (v !== undefined) return v;
        out("Please answer y or n.");
      }
    },
    async choose(question, choices, defaultValue) {
      out(question);
      choices.forEach((c, i) => out(`  ${i + 1}) ${c.label}${c.value === defaultValue ? " (default)" : ""}`));
      for (;;) {
        const a = (await src.line(`Choose 1-${choices.length} or a name [${defaultValue}]: `)).trim().toLowerCase();
        if (a === "") return defaultValue;
        const n = Number(a);
        if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1]!.value;
        const byName = choices.find((c) => c.value.toLowerCase() === a);
        if (byName) return byName.value;
        out("Not one of the options.");
      }
    },
    async multiselect(question, choices, defaults, opts = {}) {
      if (opts.summary && defaults.length) {
        for (;;) {
          const v = parseYesNo(await src.line(`${opts.summary} [Y/n] `), true);
          if (v === true) return [...defaults];
          if (v === false) break;
          out("Please answer y or n.");
        }
      }
      out(question);
      choices.forEach((c, i) => out(`  ${i + 1}) ${c.label}${c.hint ? ` (${c.hint})` : ""}${defaults.includes(c.value) ? " (default)" : ""}`));
      for (;;) {
        const parsed = parseMultiSelect(await src.line(`Choose numbers or names, comma-separated, or "none" [${defaults.join(",") || "none"}]: `), choices);
        if (parsed === undefined) return [...defaults];
        if ("values" in parsed) return parsed.values;
        out(`Not one of the options: ${parsed.unknown.join(", ")}.`);
      }
    },
    async groupMultiselect(question, groups, defaults) {
      const flat = groups.flatMap((g) => g.choices);
      out(question);
      let n = 0;
      for (const g of groups) {
        out(`  ${g.label}`);
        for (const c of g.choices) out(`    ${++n}) ${c.label}${c.hint ? ` (${c.hint})` : ""}${defaults.includes(c.value) ? " (default)" : ""}`);
      }
      for (;;) {
        const parsed = parseMultiSelect(await src.line(`Choose numbers or names, comma-separated, or "none" [${defaults.join(",") || "none"}]: `), flat);
        if (parsed === undefined) return [...defaults];
        if ("values" in parsed) return parsed.values;
        out(`Not one of the options: ${parsed.unknown.join(", ")}.`);
      }
    },
    close: () => src.close(),
  };
}

/** --yes: accept every default without reading input; questions with no default throw NeedsInputError. */
export function autoPrompter(out: (s: string) => void): Prompter {
  return {
    async ask(question, opts = {}) {
      if (opts.default === undefined || opts.default === "") throw new NeedsInputError(question);
      out(`${question}: ${opts.default} (--yes)`);
      return opts.default;
    },
    async secret(question) {
      throw new NeedsInputError(question);
    },
    async confirm(question, defaultYes) {
      out(`${question} ${defaultYes ? "yes" : "no"} (--yes)`);
      return defaultYes;
    },
    async choose(question, choices, defaultValue) {
      out(`${question} ${choices.find((c) => c.value === defaultValue)?.label ?? defaultValue} (--yes)`);
      return defaultValue;
    },
    async multiselect(question, choices, defaults) {
      const labels = defaults.map((d) => choices.find((c) => c.value === d)?.label ?? d);
      out(`${question} ${labels.length ? labels.join(", ") : "none"} (--yes)`);
      return [...defaults];
    },
    close() {},
  };
}

// ------------------------------------------------------------------ secrets

/** Apply one chunk of raw keyboard input to a secret being typed. Pure; never echoes. */
export function applySecretInput(buffer: string, chunk: string): { buffer: string; done?: "enter" | "abort" | "eof" } {
  let buf = buffer;
  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk[i]!;
    if (ch === "\r" || ch === "\n") return { buffer: buf, done: "enter" };
    if (ch === "\u0003") return { buffer: buf, done: "abort" };
    if (ch === "\u0004") return { buffer: buf, done: buf ? "enter" : "eof" };
    if (ch === "\u007f" || ch === "\b") {
      buf = Array.from(buf).slice(0, -1).join("");
      continue;
    }
    if (ch === "\u0015") {
      buf = "";
      continue;
    }
    if (ch === "\u001b") break; // an escape sequence (arrow keys): drop the rest of the chunk
    if (ch < " ") continue;
    buf += ch;
  }
  return { buffer: buf };
}

export interface RawInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
  on(event: "data", fn: (chunk: Buffer | string) => void): unknown;
  removeListener(event: "data", fn: (chunk: Buffer | string) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

/** Read a secret from a TTY in raw mode. Writes only the prompt and a final newline: no echo of any kind. */
export function readSecretFromTTY(input: RawInput, output: { write(s: string): unknown }, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    output.write(prompt);
    let buffer = "";
    const wasRaw = Boolean(input.isRaw);
    input.setRawMode?.(true);
    const finish = (err?: Error) => {
      input.removeListener("data", onData);
      input.setRawMode?.(wasRaw);
      input.pause();
      output.write("\n");
      if (err) reject(err);
      else resolve(buffer);
    };
    const onData = (chunk: Buffer | string) => {
      const r = applySecretInput(buffer, typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      buffer = r.buffer;
      if (r.done === "enter") finish();
      else if (r.done === "abort") finish(new PromptAbortedError());
      else if (r.done === "eof") finish(new Error("Input ended."));
    };
    input.on("data", onData);
    input.resume();
  });
}

/**
 * Input isn't a terminal (so it can't be hidden) but output is: the user may be
 * typing into something that echoes, so say so before reading a secret.
 */
export function pipedSecretWarning(input: { isTTY?: boolean }, output: { isTTY?: boolean }): string | undefined {
  return !input.isTTY && output.isTTY ? "Warning: input isn't a terminal, so this secret can't be hidden and may be visible as you type." : undefined;
}

/** stdin/stdout prompter. A TTY gets a readline per question and raw-mode secrets; piped input is read line by line. */
export function terminalPrompter(input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stdout): Prompter {
  const write = (s: string) => void output.write(s);
  let piped: { rl: Interface; lines: AsyncIterator<string> } | undefined;
  const nextPipedLine = async (prompt: string): Promise<string> => {
    write(prompt);
    if (!piped) {
      const rl = createInterface({ input, terminal: false });
      piped = { rl, lines: rl[Symbol.asyncIterator]() };
    }
    const r = await piped.lines.next();
    if (r.done) throw new Error("Input ended before setup finished.");
    write("\n");
    return r.value;
  };
  const src: LineSource = {
    async line(prompt) {
      if (!input.isTTY) return nextPipedLine(prompt);
      // Line editing (and its cursor escape codes) only when output is a terminal too:
      // `crawlmark-cli setup | cat -v` stays plain text. Ctrl-C then arrives as a signal.
      const terminal = Boolean(output.isTTY);
      const rl = createInterface({ input, output, terminal });
      const ac = new AbortController();
      const abort = () => ac.abort();
      if (terminal) rl.once("SIGINT", abort);
      else process.once("SIGINT", abort);
      try {
        return await rl.question(prompt, { signal: ac.signal });
      } catch (err) {
        if (ac.signal.aborted) throw new PromptAbortedError();
        throw err;
      } finally {
        process.removeListener("SIGINT", abort);
        rl.close();
      }
    },
    async secret(prompt) {
      if (input.isTTY) return readSecretFromTTY(input, output, prompt);
      const warning = pipedSecretWarning(input, output);
      if (warning) write(warning + "\n");
      return nextPipedLine(prompt);
    },
    close() {
      piped?.rl.close();
    },
  };
  return createPrompter(src, (s) => write(s + "\n"));
}
