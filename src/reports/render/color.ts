/**
 * Colour helpers for the report files (pure). Branding colours are #rrggbb strings already checked by
 * safeColor; these make sure text drawn in or on them keeps WCAG AA contrast (4.5:1) whatever the
 * agency picked.
 */

export const DEFAULT_PRIMARY = "#1f5ea8";
export const DEFAULT_ACCENT = "#5b9bd5";

/** Neutral palette and delta colours (green/red are kept for deltas only). */
export const NEUTRAL = {
  ink: "#1f2933",
  muted: "#52606d",
  faint: "#7b8794",
  rule: "#e4e7eb",
  zebra: "#f7f8fa",
  surface: "#f4f6f9",
  previous: "#9aa5b1",
} as const;
export const TONE = {
  good: { fg: "#13723a", bg: "#e3f4e8" },
  bad: { fg: "#b42318", bg: "#fdecea" },
  neutral: { fg: "#52606d", bg: "#eef1f4" },
} as const;
/** Categorical series (fixed order, never cycled): blue, orange, aqua, violet, magenta. */
export const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#6250d6", "#e87ba4"] as const;

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
const toHex = (c: number[]) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;

/** WCAG relative luminance of a #rrggbb colour. */
export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** `t` of the way from `a` to `b`. */
export function mix(a: string, b: string, t: number): string {
  const [p, q] = [rgb(a), rgb(b)];
  return toHex(p.map((v, i) => v + (q[i]! - v) * t));
}

/** The colour darkened just enough to read as text on white (4.5:1). */
export function inkOn(color: string, background = "#ffffff", min = 4.5): string {
  let c = color;
  for (let i = 0; i < 20 && contrast(c, background) < min; i++) c = mix(c, "#000000", 0.1);
  return c;
}

/** White or near-black text for a filled background, whichever reads better. */
export function textOn(fill: string): string {
  return contrast("#ffffff", fill) >= 4.5 ? "#ffffff" : contrast("#ffffff", fill) >= contrast("#111827", fill) ? "#ffffff" : "#111827";
}
