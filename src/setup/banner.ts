/**
 * The block-letter "CRAWLMARK" banner shown at the top of the fancy installer.
 * Fancy mode only: plain mode (pipes, CI, NO_COLOR, --yes) never prints it, so
 * its output stays unchanged. On a TTY each line drops in with a short delay and
 * a separator draws across underneath; elsewhere it prints in one go.
 */
import type { Writable } from "node:stream";
import { styleText } from "node:util";

// ANSI Shadow font, 79 columns wide including the two-space indent.
export const BANNER_LINES: readonly string[] = [
  "   ██████╗██████╗  █████╗ ██╗    ██╗██╗     ███╗   ███╗ █████╗ ██████╗ ██╗  ██╗",
  "  ██╔════╝██╔══██╗██╔══██╗██║    ██║██║     ████╗ ████║██╔══██╗██╔══██╗██║ ██╔╝",
  "  ██║     ██████╔╝███████║██║ █╗ ██║██║     ██╔████╔██║███████║██████╔╝█████╔╝ ",
  "  ██║     ██╔══██╗██╔══██║██║███╗██║██║     ██║╚██╔╝██║██╔══██║██╔══██╗██╔═██╗ ",
  "  ╚██████╗██║  ██║██║  ██║╚███╔███╔╝███████╗██║ ╚═╝ ██║██║  ██║██║  ██║██║  ██╗",
  "   ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚══╝╚══╝ ╚══════╝╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝",
];

/** Widest banner line, in terminal columns (every glyph is one column). */
export const BANNER_WIDTH = Math.max(...BANNER_LINES.map((l) => [...l].length));

// Top-to-bottom gradient, one colour per line.
const GRADIENT = ["cyanBright", "cyanBright", "cyan", "cyan", "blueBright", "blueBright"] as const;

const SEPARATOR_WIDTH = BANNER_WIDTH - 2;

function sleep(ms: number): void {
  // The Ui's intro is synchronous; a short blocking pause keeps it that way.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Prints the banner when the terminal is wide enough for it, and returns whether
 * it did. `animate` defaults to whether the output is a TTY.
 */
export function printBanner(output: Writable & { isTTY?: boolean; columns?: number }, opts: { animate?: boolean; columns?: number } = {}): boolean {
  const columns = opts.columns ?? output.columns ?? 80;
  if (columns < BANNER_WIDTH) return false;
  const animate = opts.animate ?? output.isTTY === true;
  output.write("\n");
  BANNER_LINES.forEach((line, i) => {
    output.write(`${styleText(["bold", GRADIENT[i % GRADIENT.length]!], line)}\n`);
    if (animate) sleep(45);
  });
  const indent = "  ";
  if (animate) {
    for (let i = 1; i <= SEPARATOR_WIDTH; i += 2) {
      output.write(`\r${indent}${styleText("dim", "─".repeat(i))}`);
      sleep(4);
    }
    output.write(`\r${indent}${styleText("dim", "─".repeat(SEPARATOR_WIDTH))}\n\n`);
  } else {
    output.write(`${indent}${styleText("dim", "─".repeat(SEPARATOR_WIDTH))}\n\n`);
  }
  return true;
}
