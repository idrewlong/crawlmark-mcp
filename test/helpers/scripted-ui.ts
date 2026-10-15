import type { Choice, Prompter } from "../../src/setup/prompter.js";
import { PromptAbortedError } from "../../src/setup/prompter.js";
import { recordingUi, type Ui } from "../../src/setup/ui.js";

/** What a scripted answer can be. ABORT is Ctrl-C. */
export const ABORT = Symbol("ctrl-c");
export type Answer = string | boolean | string[] | typeof ABORT;

export interface Step {
  /** The question this step expects next (substring or regex). A different question fails the test. */
  q: string | RegExp;
  a: Answer;
  /** Skip this step silently when the next question is something else (a prompt that only appears on some machines). */
  optional?: boolean;
}

/** A scripted answer. `a("Set up Google", false)`. */
export const a = (q: string | RegExp, answer: Answer, optional = false): Step => ({ q, a: answer, optional });

export interface Asked {
  kind: "ask" | "secret" | "confirm" | "choose" | "multiselect";
  question: string;
  /** For choose and multiselect: the values on offer. */
  options?: string[];
  /** For choose and multiselect: the default. */
  def?: string | string[];
}

export interface Script {
  prompt: Prompter & { closed: boolean };
  /** A recording Ui (kind: text per call). */
  ui: Ui & { events: string[] };
  asked: Asked[];
  /** Steps not consumed yet (optional ones included). */
  remaining(): Step[];
  /** Fails if a required step was never reached. */
  assertDrained(): void;
}

const matches = (q: string | RegExp, question: string) => (typeof q === "string" ? question.includes(q) : q.test(question));

/**
 * A fake terminal: answers prompts from a queue and checks each question against the one the script
 * expects, so a wizard that asks something new (or asks in a different order) fails the test with the
 * question in the message. Output goes to a recording Ui. Running out of answers fails too.
 */
export function script(steps: Step[], opts: { fancy?: boolean } = {}): Script {
  const queue = [...steps];
  const asked: Asked[] = [];
  const next = (rec: Asked): Answer => {
    asked.push(rec);
    for (;;) {
      const s = queue.shift();
      if (!s) throw new Error(`Unexpected question (script exhausted): [${rec.kind}] ${rec.question}`);
      if (matches(s.q, rec.question)) {
        if (s.a === ABORT) throw new PromptAbortedError();
        return s.a;
      }
      if (!s.optional) throw new Error(`Expected a question matching ${String(s.q)} but got [${rec.kind}] ${rec.question}`);
    }
  };
  const prompt: Prompter & { closed: boolean } = {
    closed: false,
    async ask(question, o = {}) {
      const ans = next({ kind: "ask", question, ...(o.default !== undefined ? { def: o.default } : {}) }) as string;
      return ans === "" ? (o.default ?? "") : ans;
    },
    async secret(question) {
      return next({ kind: "secret", question }) as string;
    },
    async confirm(question) {
      return next({ kind: "confirm", question }) as boolean;
    },
    async choose<T extends string>(question: string, choices: readonly Choice<T>[], def: T) {
      const ans = (next({ kind: "choose", question, options: choices.map((c) => c.value), def }) as string) || def;
      if (!choices.some((c) => c.value === ans)) throw new Error(`Script answered "${ans}" which isn't a choice for: ${question}`);
      return ans as T;
    },
    async multiselect<T extends string>(question: string, choices: readonly Choice<T>[], defaults: readonly T[]) {
      const ans = next({ kind: "multiselect", question, options: choices.map((c) => c.value), def: [...defaults] });
      return (ans === "" ? [...defaults] : ans) as T[];
    },
    close() {
      prompt.closed = true;
    },
  };
  return {
    prompt,
    ui: recordingUi({ fancy: opts.fancy ?? true }),
    asked,
    remaining: () => [...queue],
    assertDrained() {
      const left = queue.filter((s) => !s.optional);
      if (left.length) throw new Error(`Script not finished; still expected: ${left.map((s) => String(s.q)).join(", ")}`);
    },
  };
}
