/**
 * Human output for `setup status` (pure): one row per integration with an icon,
 * a fixed label column and the detail word-wrapped under it, `→ <next>` on its
 * own line for rows that need something, and a footer with the counts. The JSON
 * output (`--json`) is separate and unchanged.
 */
import { styleText } from "node:util";
import type { IntegrationState, SetupStatusReport } from "./status.js";

export interface RenderStatusOptions {
  /** Columns available; see statusWidth. */
  width: number;
  /** ANSI colour (a TTY without NO_COLOR). */
  color: boolean;
  /** Unicode icons; false gives `[ok] [!] [x] [ ]` (TERM=dumb or a non-UTF-8 locale). */
  unicode: boolean;
  /** The user's home directory: shown as `~` in the header and details. */
  userHome?: string | undefined;
  /** A source checkout's root: adds "Run commands from <root>", since `npm run cli` needs that directory. */
  checkoutRoot?: string | undefined;
}

const ANSI_RE = /\u001b\[[0-9;]*m/g;

/** Visible length of a line (ANSI codes don't count). */
export function visibleLength(s: string): number {
  return Array.from(s.replace(ANSI_RE, "")).length;
}

/** stdout.columns clamped to 60..100, or 80 when stdout isn't a TTY. */
export function statusWidth(columns: number | undefined, isTTY: boolean | undefined): number {
  if (!isTTY || !columns) return 80;
  return Math.max(60, Math.min(100, columns));
}

/** Unicode icons unless TERM=dumb or the locale isn't UTF-8 (Windows terminals are assumed to cope). */
export function supportsUnicode(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): boolean {
  if (env.TERM === "dumb") return false;
  if (platform === "win32") return true;
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  return /utf-?8/i.test(locale);
}

/** Colour only on a TTY, and never with a non-empty NO_COLOR or TERM=dumb. */
export function supportsColor(env: Record<string, string | undefined>, isTTY: boolean | undefined): boolean {
  return Boolean(isTTY) && !env.NO_COLOR && env.TERM !== "dumb";
}

/**
 * Word-wrap to `width` columns. Words are never broken: a token longer than the
 * width (a URL or a path) gets a line of its own and overflows it.
 */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (!line) line = word;
      else if (visibleLength(line) + 1 + visibleLength(word) <= width) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

const ICONS: Record<IntegrationState, { unicode: string; ascii: string; color: "green" | "yellow" | "red" | "gray" }> = {
  working: { unicode: "✔", ascii: "[ok]", color: "green" },
  configured: { unicode: "●", ascii: "[!]", color: "yellow" },
  error: { unicode: "✖", ascii: "[x]", color: "red" },
  missing: { unicode: "○", ascii: "[ ]", color: "gray" },
};

const SHORT_REASON: Record<SetupStatusReport["home"]["source"], string> = {
  env: "CRAWLMARK_HOME",
  project: "source checkout",
  user: "installed package",
};

/** `/Users/me/x` -> `~/x` for display. */
export function tildify(text: string, userHome: string | undefined): string {
  if (!userHome || userHome === "/" || userHome.length < 2) return text;
  const home = userHome.replace(/[\\/]+$/, "");
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Only the home itself or home + separator: /Users/drew2 is not under /Users/drew.
  // It must start a path (not sit inside /x/Users/drew) and end at a separator, the end, or punctuation.
  return text.replace(new RegExp(`(?<![\\w./\\\\-])${escaped}(?=[\\\\/]|$|[\\s"'),;:]|\\.(?:\\s|$))`, "g"), "~");
}

export function renderStatus(report: SetupStatusReport, opts: RenderStatusOptions): string[] {
  const paint = (format: Parameters<typeof styleText>[0], s: string) => (opts.color ? styleText(format, s, { validateStream: false }) : s);
  const tilde = (s: string) => tildify(s, opts.userHome);
  const iconWidth = opts.unicode ? 1 : 4;
  const labelWidth = Math.min(22, Math.max(16, ...report.integrations.map((i) => i.label.length + 2)));
  const indent = iconWidth + 1 + labelWidth;
  const detailWidth = Math.max(20, opts.width - indent);
  const pad = " ".repeat(indent);

  const lines: string[] = [];
  const home = `home ${tilde(report.home.dir)} (${SHORT_REASON[report.home.source]})`;
  // The home goes on its own line when it doesn't fit beside the title.
  if ("crawlmark status   ".length + visibleLength(home) <= opts.width) lines.push(`${paint("bold", "crawlmark status")}   ${home}`);
  else lines.push(paint("bold", "crawlmark status"), home);
  if (opts.checkoutRoot) lines.push(`Run commands from ${tilde(opts.checkoutRoot)}`);
  lines.push("");
  for (const i of report.integrations) {
    const icon = ICONS[i.state];
    const detail = wrapText(tilde(i.detail), detailWidth);
    lines.push(`${paint(icon.color, opts.unicode ? icon.unicode : icon.ascii)} ${i.label.padEnd(labelWidth)}${detail[0] ?? ""}`);
    for (const more of detail.slice(1)) lines.push(pad + more);
    if (i.next && i.state !== "working") {
      const arrow = opts.unicode ? "→" : "->";
      const next = wrapText(tilde(i.next), detailWidth - arrow.length - 1);
      next.forEach((n, k) => lines.push(pad + paint("cyan", `${k === 0 ? arrow : " ".repeat(arrow.length)} ${n}`)));
    }
  }
  const s = report.summary;
  const parts = [
    `${s.working} working`,
    `${s.configured} needs attention`,
    `${s.error} ${s.error === 1 ? "error" : "errors"}`,
    `${s.missing} not set up`,
  ];
  lines.push("");
  lines.push(parts.join(opts.unicode ? " · " : ", "));
  return lines;
}

/**
 * Phase 12: rows that human `setup status` shows only once set up (`--json` and setup_status always
 * include them), so the plain output of an existing setup is unchanged. The summary counts follow.
 */
export const HIDDEN_UNTIL_CONFIGURED: readonly string[] = ["crux"];

export function forHumans(report: SetupStatusReport): SetupStatusReport {
  const integrations = report.integrations.filter((i) => !(HIDDEN_UNTIL_CONFIGURED.includes(i.id) && i.state === "missing"));
  const summary: SetupStatusReport["summary"] = { working: 0, configured: 0, missing: 0, error: 0 };
  for (const i of integrations) summary[i.state]++;
  return { ...report, integrations, summary };
}
