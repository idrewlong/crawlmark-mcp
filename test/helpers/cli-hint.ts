import { cliHint } from "../../src/lib/cli-hint.js";

/** A regex that matches `<this install's command prefix> <tail>`; `tail` is regex source. */
export function cliRe(tail: string, flags?: string): RegExp {
  return new RegExp(`${cliHint().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} ${tail}`, flags);
}

export { cliHint };
