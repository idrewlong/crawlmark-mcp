import { stripControl } from "../lib/terminal-text.js";

/**
 * How the wizard shows progress, separate from how it asks questions (Prompter).
 * Two renderers sit behind one interface: plainUi prints today's line-by-line
 * text exactly (pipes, CI, NO_COLOR, --yes), and clackUi (./ui-clack.ts, the only
 * module that imports @clack/prompts) draws the fancy TTY version. Every method
 * takes the plain wording, so the plain output never depends on the fancy one.
 */

export type Outcome = "done" | "skipped" | "failed" | "needs-input";

export interface IntroInfo {
  /** The command the user ran: `setup` or `init`. */
  command: "setup" | "init";
  version: string;
  home: string;
  dryRun: boolean;
}

export interface SummaryRow {
  label: string;
  outcome: Outcome;
  /** A short note for the fancy summary, e.g. "11" clients or "skipped". */
  note?: string | undefined;
}

export interface SummaryInfo {
  /** Every step, in order (plain prints `  <step> <outcome>`). */
  steps: { step: string; outcome: Outcome }[];
  /** Rows for the fancy box: integrations and apps. */
  rows: SummaryRow[];
  /** Numbered next steps for the fancy box. */
  next: string[];
  /** The plain closing line (re-run hint). */
  rerun: string;
  /** "Try asking Claude" prompts for the fancy box (Phase 10). Plain mode never shows them. */
  tryAsking?: { prompts: string[]; hint?: string | undefined } | undefined;
}

export interface Ui {
  readonly fancy: boolean;
  intro(info: IntroInfo): void;
  /** A step heading. Plain: a blank line, then `== i/n Title ==` (or `== Title ==` for one step). */
  step(title: string, position?: { index: number; total: number }): void;
  /** A line of narrative. */
  line(text?: string): void;
  /**
   * A live check. Plain prints `plain` (default: the label) as one line, or nothing
   * when `plain` is false; fancy shows a spinner while `fn` runs.
   */
  spin<T>(label: string, fn: () => Promise<T>, opts?: { plain?: string | false }): Promise<T>;
  success(text: string): void;
  fail(text: string): void;
  warn(text: string): void;
  info(text: string): void;
  /** A change about to be made (a config diff). Plain: the title, then each line. */
  preview(title: string, lines: string[]): void;
  /** A step's result. Plain: `-> <outcome>: <message>`. */
  result(outcome: Outcome, message: string): void;
  /** A dim `> ` hint under a result (Phase 10). Plain prints nothing, so its output is unchanged. */
  tip(text: string): void;
  summary(info: SummaryInfo): void;
  /** The end of the run. Plain prints nothing (today's output ends with the summary). */
  outro(text: string): void;
}

/** Today's text, line by line, through `out`. No colour, no cursor movement. Control characters are stripped. */
export function plainUi(rawOut: (line?: string) => void): Ui {
  const out = (line = "") => rawOut(stripControl(line));
  return {
    fancy: false,
    intro(info) {
      out(`crawlmark ${info.command}. Config home: ${info.home}`);
      if (info.dryRun) out("Dry run: nothing will be written or registered. Free read-only checks still run.");
    },
    step(title, position) {
      out("");
      out(`== ${position ? `${position.index}/${position.total} ` : ""}${title} ==`);
    },
    line: (text = "") => out(text),
    async spin(label, fn, opts = {}) {
      if (opts.plain !== false) out(opts.plain ?? label);
      return fn();
    },
    success: (t) => out(t),
    fail: (t) => out(t),
    warn: (t) => out(t),
    info: (t) => out(t),
    preview(title, lines) {
      out(title);
      for (const l of lines) out(l);
    },
    result: (outcome, message) => out(`-> ${outcome}: ${message}`),
    tip() {},
    summary(info) {
      out("");
      out("Summary:");
      for (const r of info.steps) out(`  ${r.step.padEnd(10)} ${r.outcome}`);
      out(info.rerun);
    },
    outro() {},
  };
}

export type Renderer = "fancy" | "plain";

/**
 * Fancy only when stdin and stdout are both TTYs and none of these applies: CI set
 * (to anything but "", "false" or "0"), TERM=dumb, a non-empty NO_COLOR, or --yes.
 */
export function chooseRenderer(i: { stdinTTY: boolean | undefined; stdoutTTY: boolean | undefined; env: Record<string, string | undefined>; yes: boolean }): Renderer {
  if (!i.stdinTTY || !i.stdoutTTY || i.yes) return "plain";
  const ci = i.env.CI;
  if (ci !== undefined && ci !== "" && ci !== "false" && ci !== "0") return "plain";
  if (i.env.TERM === "dumb") return "plain";
  if (i.env.NO_COLOR) return "plain";
  return "fancy";
}

/** A Ui for tests: records every call as `kind: text`. */
export function recordingUi(opts: { fancy?: boolean } = {}): Ui & { events: string[] } {
  const events: string[] = [];
  const rec = (kind: string, text = "") => void events.push(`${kind}: ${text}`);
  return {
    events,
    fancy: opts.fancy ?? false,
    intro: (i) => rec("intro", `${i.command} ${i.home}${i.dryRun ? " (dry run)" : ""}`),
    step: (t) => rec("step", t),
    line: (t) => rec("line", t),
    async spin(label, fn) {
      rec("spin", label);
      return fn();
    },
    success: (t) => rec("success", t),
    fail: (t) => rec("fail", t),
    warn: (t) => rec("warn", t),
    info: (t) => rec("info", t),
    preview: (title, lines) => rec("preview", [title, ...lines].join("\n")),
    result: (o, m) => rec("result", `${o}: ${m}`),
    tip: (t) => rec("tip", t),
    summary: (s) => {
      rec("summary", [...s.rows.map((r) => `${r.label}=${r.outcome}`), ...s.next].join("; "));
      if (s.tryAsking) rec("try", [...s.tryAsking.prompts, ...(s.tryAsking.hint ? [s.tryAsking.hint] : [])].join("; "));
    },
    outro: (t) => rec("outro", t),
  };
}

const plainCache = new WeakMap<object, Ui>();

/** The context's Ui, or a plainUi over its `out` (contexts built before the Ui existed, e.g. in tests). */
export function uiFor(ctx: { ui?: Ui | undefined; out(line?: string): void }): Ui {
  if (ctx.ui) return ctx.ui;
  let ui = plainCache.get(ctx);
  if (!ui) {
    ui = plainUi((l) => ctx.out(l));
    plainCache.set(ctx, ui);
  }
  return ui;
}

/** Elapsed time, Vercel style (pure): `340ms` under a second, `1.2s` under a minute, then `1m 5s`. */
export function formatElapsed(ms: number): string {
  const t = Math.max(0, ms);
  if (t < 1000) return `${Math.floor(t)}ms`;
  if (t < 60_000) {
    const s = Math.floor(t / 100) / 10;
    return `${s.toFixed(1)}s`;
  }
  const total = Math.floor(t / 1000);
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

/** A whole run's duration for the outro (pure): one decimal under 10 s, whole seconds to a minute, then `1m 5s`. */
export function formatTotal(ms: number): string {
  const t = Math.max(0, ms);
  if (t < 10_000) return `${(Math.floor(t / 100) / 10).toFixed(1)}s`;
  if (t < 60_000) return `${Math.floor(t / 1000)}s`;
  return formatElapsed(t);
}
