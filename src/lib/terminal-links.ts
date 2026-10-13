/**
 * Clickable links (OSC 8) and "open in your browser" for the fancy installer.
 *
 * Safety rules:
 * - Text is run through stripControl BEFORE any link escape is added, so an
 *   escape sequence in untrusted text can never survive, and the only escapes
 *   in the output are the ones built here.
 * - Only URLs that pass safeLinkUrl (https, printable ASCII, bounded length) are
 *   wrapped or opened, and the visible text is always the URL itself, so a link
 *   can't point somewhere other than what it says.
 * - The browser opener is spawned without a shell.
 */
import { spawn, type SpawnOptions } from "node:child_process";
import { stripControl } from "./terminal-text.js";

const MAX_URL_LENGTH = 2048;

/**
 * Whether the terminal renders OSC 8 hyperlinks (pure). FORCE_HYPERLINK=1/0 wins;
 * otherwise only a TTY whose terminal is known to support them.
 */
export function supportsHyperlinks(env: Record<string, string | undefined>, isTTY: boolean | undefined): boolean {
  const force = env.FORCE_HYPERLINK;
  if (force === "1" || force === "true") return true;
  if (force === "0" || force === "false") return false;
  if (!isTTY) return false;
  if (env.TERM === "dumb") return false;
  const program = env.TERM_PROGRAM;
  if (program === "iTerm.app" || program === "WezTerm" || program === "vscode" || program === "ghostty") return true;
  // Apple's Terminal.app prints the escape's text instead of a link.
  if (program === "Apple_Terminal") return false;
  const vte = Number(env.VTE_VERSION);
  if (Number.isFinite(vte) && vte >= 5000) return true;
  if (env.WT_SESSION) return true;
  if (env.KITTY_WINDOW_ID) return true;
  return false;
}

/**
 * The normalised URL (WHATWG `href`) when it is safe to wrap in a link or open: https, printable
 * ASCII only, at most 2048 characters, checked on both the input and the normalised form. Else
 * undefined. Callers use the returned href, never the raw input, so a quirky spelling such as
 * `https:\\host\path` or `HTTPS://host` can't reach the opener unparsed.
 */
export function safeLinkUrl(url: string): string | undefined {
  if (url.length === 0 || url.length > MAX_URL_LENGTH) return undefined;
  // Printable ASCII only: no spaces, control, bidi or other invisible characters, no homoglyphs.
  if (!/^[\x21-\x7e]+$/.test(url)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" || !parsed.hostname) return undefined;
  if (parsed.username || parsed.password) return undefined;
  const href = parsed.href;
  if (!href.startsWith("https://") || href.length > MAX_URL_LENGTH || !/^[\x21-\x7e]+$/.test(href)) return undefined;
  return href;
}

const OSC8 = "\u001b]8;;";
const BEL = "\u0007";

/** An OSC 8 link whose visible text is the normalised URL itself (BEL-terminated, which clack's wrapper understands). Unsafe URLs come back as plain text. */
export function hyperlink(url: string): string {
  const safe = safeLinkUrl(url);
  return safe ? `${OSC8}${safe}${BEL}${safe}${OSC8}${BEL}` : url;
}

// An https URL up to whitespace; trailing sentence punctuation is split off below.
const URL_TOKEN = /https:\/\/[^\s<>"'`]+/g;

/**
 * Control characters stripped first, then every safe https URL wrapped as a link
 * (when `enabled`). Trailing punctuation (".", ",", ")" and so on) stays outside the link.
 */
export function linkify(text: string, enabled: boolean): string {
  const clean = stripControl(text);
  if (!enabled) return clean;
  return clean.replace(URL_TOKEN, (token) => {
    const m = /^(.*?)([.,;:!?)\]]*)$/.exec(token)!;
    const url = m[1]!;
    const tail = m[2]!;
    // Only link a URL that reads the same as where it goes (its href, give or take a trailing slash).
    const href = safeLinkUrl(url);
    return href && (href === url || href === `${url}/`) ? `${OSC8}${href}${BEL}${url}${OSC8}${BEL}${tail}` : token;
  });
}

/** The program and arguments that open a URL in the default browser (pure). No shell is involved on any platform. */
export function openerCommand(url: string, platform: NodeJS.Platform): { cmd: string; args: string[] } {
  if (platform === "darwin") return { cmd: "open", args: [url] };
  // `start` is a cmd.exe built-in, and cmd.exe would interpret `&` in a URL; rundll32 takes it as one argument.
  if (platform === "win32") return { cmd: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  return { cmd: "xdg-open", args: [url] };
}

type Spawner = (cmd: string, args: string[], opts: SpawnOptions) => { on(event: "error", cb: (err: Error) => void): unknown; unref(): void };

/**
 * Open a safe https URL in the browser without waiting for it. Returns false
 * (and opens nothing) for an unsafe URL or when the opener can't be started.
 */
export function openUrl(url: string, opts: { platform?: NodeJS.Platform; spawn?: Spawner } = {}): boolean {
  const safe = safeLinkUrl(url);
  if (!safe) return false;
  const { cmd, args } = openerCommand(safe, opts.platform ?? process.platform);
  try {
    const child = (opts.spawn ?? (spawn as unknown as Spawner))(cmd, args, { shell: false, detached: true, stdio: "ignore" });
    // A missing opener (no xdg-open) is reported asynchronously; the URL is on screen anyway.
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
