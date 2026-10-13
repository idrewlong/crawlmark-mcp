/**
 * Text from outside crawlmark (container names, other servers' names, child
 * process output, vendor error text) can carry terminal escape sequences or
 * invisible characters that change how it reads. Everything the setup renderers
 * print goes through stripControl, which removes:
 * - C0 and C1 control characters and DEL, except tab and newline;
 * - every Unicode format character (general category Cf: bidi embeddings,
 *   overrides and isolates, zero-width characters, the BOM, the Arabic letter
 *   mark, soft hyphens, interlinear annotation marks, tag characters and so on);
 * - the line and paragraph separators U+2028 and U+2029 (SEC-5).
 * Visible text (accents, emoji, symbols, CJK, box drawing) is unchanged.
 *
 * The pattern uses ASCII escapes only, so this file has no invisible characters in it.
 */
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\p{Cf}\u{2028}\u{2029}]/gu;

export function stripControl(text: string): string {
  return text.replace(CONTROL_RE, "");
}
