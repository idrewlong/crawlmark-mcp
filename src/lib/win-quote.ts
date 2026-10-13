/**
 * Building a cmd.exe command line safely (Windows needs cmd.exe to run `.cmd`
 * shims such as npm.cmd and claude.cmd). The approach follows cross-spawn: each
 * argument is quoted for the MSVCRT parser, then every cmd.exe metacharacter
 * (including `%` and `!`, which cmd expands inside quotes) is `^`-escaped, and the
 * whole line is run as `cmd.exe /d /s /c "<line>"` with verbatim arguments.
 * Pure, so it is unit tested on any OS.
 */

const META = /([()\][%!^"`<>&|;, *?])/g;

/** Quote one argument: MSVCRT quoting, then caret-escape cmd.exe metacharacters. */
export function escapeWinArg(arg: string): string {
  let a = arg.replace(/(\\*)"/g, '$1$1\\"'); // backslashes before a quote double, the quote is escaped
  a = a.replace(/(\\*)$/, "$1$1"); // trailing backslashes double (they precede the closing quote)
  return `"${a}"`.replace(META, "^$1");
}

/** Escape the command itself (not quoted, so a bare `npm` still resolves through PATHEXT). */
export function escapeWinCommand(cmd: string): string {
  return cmd.replace(META, "^$1");
}

/** argv for spawn("cmd.exe", argv, { windowsVerbatimArguments: true }). */
export function winCmdArgs(cmd: string, args: readonly string[]): string[] {
  const line = [escapeWinCommand(cmd), ...args.map(escapeWinArg)].join(" ");
  return ["/d", "/s", "/c", `"${line}"`];
}
