/**
 * The fancy renderer: @clack/prompts for prompts, spinners, notes and the summary
 * box. This is the only module that imports clack, so the plain path and the
 * tests that don't need it never load it. Clack's functions and the output
 * stream are injectable, so both halves are tested without a TTY.
 */
import type { Writable } from "node:stream";
import { styleText } from "node:util";
import * as clack from "@clack/prompts";
import { PromptAbortedError, type Choice, type ChoiceGroup, type Prompter } from "./prompter.js";
import { formatElapsed, formatTotal, type Outcome, type Ui } from "./ui.js";
import { stripControl } from "../lib/terminal-text.js";
import { linkify, supportsHyperlinks } from "../lib/terminal-links.js";
import { printBanner } from "./banner.js";

/** The clack prompt functions the prompter uses (injected in tests). */
export interface ClackPromptFns {
  text: typeof clack.text;
  password: typeof clack.password;
  confirm: typeof clack.confirm;
  select: typeof clack.select;
  multiselect: typeof clack.multiselect;
  /** Optional so older test doubles still fit; without it groups fall back to a flat multiselect. */
  groupMultiselect?: typeof clack.groupMultiselect;
  isCancel: typeof clack.isCancel;
}

const realPromptFns: ClackPromptFns = {
  text: clack.text,
  password: clack.password,
  confirm: clack.confirm,
  select: clack.select,
  multiselect: clack.multiselect,
  groupMultiselect: clack.groupMultiselect,
  isCancel: clack.isCancel,
};

/** The mask for secrets. It shows how many characters were typed and nothing else. */
export const SECRET_MASK = "•";

const options = <T extends string>(choices: readonly Choice<T>[]) =>
  choices.map((c) => ({ value: c.value, label: c.label, ...(c.hint ? { hint: c.hint } : {}) })) as { value: T; label: string; hint?: string }[];

/** Arrow-key prompts. Ctrl-C (clack's cancel symbol) becomes PromptAbortedError. */
export function clackPrompter(fns: ClackPromptFns = realPromptFns): Prompter {
  const unwrap = <T>(v: T | symbol): Exclude<T, symbol> => {
    if (fns.isCancel(v) || typeof v === "symbol") throw new PromptAbortedError();
    return v as Exclude<T, symbol>;
  };
  return {
    async ask(question, opts = {}) {
      const d = opts.default;
      const v = unwrap(await fns.text({ message: question, ...(d ? { placeholder: d, defaultValue: d } : {}) }));
      const answer = (v ?? "").trim();
      return answer === "" ? (d ?? "") : answer;
    },
    async secret(question) {
      return (unwrap(await fns.password({ message: question, mask: SECRET_MASK })) ?? "").trim();
    },
    async confirm(question, defaultYes) {
      return unwrap(await fns.confirm({ message: question, initialValue: defaultYes }));
    },
    async choose<T extends string>(question: string, choices: readonly Choice<T>[], defaultValue: T): Promise<T> {
      return unwrap(await fns.select<T>({ message: question, options: options(choices) as never, initialValue: defaultValue }));
    },
    async multiselect<T extends string>(question: string, choices: readonly Choice<T>[], defaults: readonly T[]): Promise<T[]> {
      return unwrap(await fns.multiselect<T>({ message: question, options: options(choices) as never, initialValues: [...defaults], required: false }));
    },
    async groupMultiselect<T extends string>(question: string, groups: readonly ChoiceGroup<T>[], defaults: readonly T[]): Promise<T[]> {
      if (!fns.groupMultiselect) {
        const flat = groups.flatMap((g) => g.choices.map((c) => ({ ...c, label: `${g.label}: ${c.label}` })));
        return unwrap(await fns.multiselect<T>({ message: question, options: options(flat) as never, initialValues: [...defaults], required: false }));
      }
      const grouped = Object.fromEntries(groups.map((g) => [g.label, options(g.choices)]));
      return unwrap(await fns.groupMultiselect<T>({ message: question, options: grouped as never, initialValues: [...defaults], required: false, selectableGroups: false }));
    },
    close() {},
  };
}

/** The clack display functions the Ui uses (injected in tests). */
export interface ClackUiFns {
  intro: typeof clack.intro;
  outro: typeof clack.outro;
  log: typeof clack.log;
  note: typeof clack.note;
  box: typeof clack.box;
  spinner: typeof clack.spinner;
}

const realUiFns: ClackUiFns = { intro: clack.intro, outro: clack.outro, log: clack.log, note: clack.note, box: clack.box, spinner: clack.spinner };

const ICON: Record<Outcome, string> = { done: "✔", skipped: "○", failed: "✖", "needs-input": "●" };

export const CANCELLED_MESSAGE = "Setup cancelled. Anything already saved stays saved; re-run setup any time.";

/**
 * @param opts.onInterrupt Ctrl-C while a spinner runs (prompts turn Ctrl-C into
 *   PromptAbortedError instead). Clack's spinner reads the keyboard in raw mode
 *   and exits with code 0 on Ctrl-C, or reports SIGINT through onCancel; either
 *   way the default prints the cancel message once and makes the exit code 130.
 * @param opts.now The clock for spinner timings and the outro's "Done in Ns" (milliseconds; injected in tests).
 * @param opts.hyperlinks Wrap https URLs as OSC 8 links. Default: what the terminal supports (src/lib/terminal-links.ts).
 */
export function clackUi(
  opts: { output?: Writable; fns?: ClackUiFns; onInterrupt?: () => void; banner?: boolean; now?: () => number; hyperlinks?: boolean } = {},
): Ui {
  const output = opts.output ?? process.stdout;
  const now = opts.now ?? (() => performance.now());
  const started = now();
  const links = opts.hyperlinks ?? supportsHyperlinks(process.env, (output as Writable & { isTTY?: boolean }).isTTY);
  let interrupted = false;
  const onInterrupt =
    opts.onInterrupt ??
    (() => {
      if (interrupted) return;
      interrupted = true;
      output.write(`\n${CANCELLED_MESSAGE}\n`);
      process.exitCode = 130;
    });
  const fns = opts.fns ?? realUiFns;
  // Untrusted text is cleaned on the way in, before any styling: our styleText codes
  // and clack's own colours are added afterwards and must never be stripped.
  const c = stripControl;
  // Untrusted text stripped first, then links added (linkify does both in that order).
  const L = (t: string) => linkify(t, links);
  const common = { output };
  const write = (s: string) => void output.write(s);
  const dim = (s: string) => styleText("dim", s);
  const bar = () => styleText("gray", "│");
  return {
    fancy: true,
    intro(info) {
      if (opts.banner ?? opts.output === undefined) printBanner(output);
      fns.intro(`${styleText(["bold", "cyan"], "crawlmark")} ${c(info.version)}  ${dim(info.command === "init" ? "SEO audits for Claude, Cursor and Codex" : "setup")}`, common);
      fns.log.info(`Config home: ${c(info.home)}`, common);
      if (info.dryRun) fns.log.warn("Dry run: nothing will be written or registered. Free read-only checks still run.", common);
    },
    step(title, position) {
      write(`${bar()}\n`);
      fns.log.step(`${styleText("bold", c(title))}${position ? dim(`  ${position.index}/${position.total}`) : ""}`, { ...common, spacing: 0 });
    },
    line(text = "") {
      for (const l of stripControl(text).split("\n")) write(l ? `${bar()}  ${L(l)}\n` : `${bar()}\n`);
    },
    async spin(label, fn) {
      const s = fns.spinner({
        ...common,
        cancelMessage: "Cancelled",
        onCancel: () => {
          onInterrupt();
          process.exit(130);
        },
      });
      // Clack's raw-mode Ctrl-C handler calls process.exit(0) while the spinner runs.
      process.once("exit", onInterrupt);
      const clean = c(label);
      const t0 = now();
      const took = () => dim(`[${formatElapsed(now() - t0)}]`);
      s.start(clean.replace(/\.\.\.$/, "…"));
      try {
        const r = await fn();
        s.stop(`${clean.replace(/\s*\.\.\.$|…$/, "")} ${took()}`);
        return r;
      } catch (err) {
        s.error(`${clean.replace(/\s*\.\.\.$|…$/, "")}: ${c((err as Error).message)} ${took()}`);
        throw err;
      } finally {
        process.removeListener("exit", onInterrupt);
      }
    },
    success: (t) => fns.log.success(L(t), common),
    fail: (t) => fns.log.error(L(t), common),
    warn: (t) => fns.log.warn(L(t), common),
    info: (t) => fns.log.info(L(t), common),
    preview(title, lines) {
      // "<App> config: <path>": the app as the title, the path inside, so a long path doesn't stretch the frame.
      const t = c(title);
      const body = lines.map(c);
      const m = /^(.*?) config: (.+)$/.exec(t);
      fns.note((m ? [m[2]!, "", ...body] : body).join("\n"), m ? m[1] : t, common);
    },
    result(outcome, message) {
      const text = `${ICON[outcome]} ${L(message)}`;
      if (outcome === "done") fns.log.success(text, common);
      else if (outcome === "failed") fns.log.error(text, common);
      else if (outcome === "needs-input") fns.log.warn(text, common);
      else fns.log.info(dim(text), common);
    },
    tip(text) {
      write(`${bar()}  ${dim(`> ${L(text)}`)}\n`);
    },
    summary(info) {
      const cells = info.rows.map((r) => `${ICON[r.outcome]} ${c(r.label)}${r.note ? ` ${c(r.note)}` : ""}`);
      const rows: string[] = [];
      let row = "";
      for (const cell of cells) {
        if (row && row.length + 3 + cell.length > 62) {
          rows.push(row);
          row = cell;
        } else row = row ? `${row}   ${cell}` : cell;
      }
      if (row) rows.push(row);
      const next = info.next.length ? ["", "Next:", ...info.next.map((n, i) => `  ${i + 1}. ${c(n)}`)] : [];
      const t = info.tryAsking;
      const tryAsking = t?.prompts.length ? ["", "Try asking Claude:", ...t.prompts.map((p) => `  "${c(p)}"`), ...(t.hint ? [dim(`  ${c(t.hint)}`)] : [])] : [];
      const failed = info.steps.some((s) => s.outcome === "failed");
      write(`${bar()}\n`);
      const title = failed ? " crawlmark setup finished, with problems " : " crawlmark is ready ";
      try {
        fns.box([...rows, ...next, ...tryAsking].join("\n"), title, { ...common, rounded: true, width: "auto" });
      } catch {
        // A terminal too narrow for the box: the same content without the frame.
        for (const l of [title.trim(), ...rows, ...next, ...tryAsking]) write(`${bar()}  ${l}\n`);
      }
    },
    outro(t) {
      // "Done in 14s"; any other closing line keeps its words and gets the time in brackets.
      const total = formatTotal(now() - started);
      const text = c(t);
      if (text === "Done") fns.outro(`Done in ${total}`, common);
      else if (text === "Finished, with problems above") fns.outro(`Finished in ${total}, with problems above`, common);
      else fns.outro(`${text} ${dim(`[${total}]`)}`, common);
    },
  };
}
