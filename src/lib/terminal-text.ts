/**
 * Text from outside crawlmark (container names, other servers' names, child
 * process output) can carry terminal escape sequences. Everything the setup
 * renderers print goes through stripControl: C0 and C1 control characters and
 * DEL are removed, except tab and newline. Normal text is unchanged.
 */
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function stripControl(text: string): string {
  return text.replace(CONTROL_RE, "");
}
