/**
 * Theme palette (pure): every colour a report theme derives from the branding's primary and accent colours.
 * The rules and the fixed neutrals are in specs/2026-11-02-0900-release-0.4.0-themes-deck.md (P-C3). All values
 * are #rrggbb strings. Text colours reach 4.5:1 (WCAG AA) on the fill they sit on, whatever colour the agency picked.
 */
import { contrast, inkOn, mix, softTextOn, textOn } from "../color.js";

/**
 * A colour reference in the Word and PowerPoint theme tables: a palette role, or a fixed #rrggbb.
 * `onFill` and `onFillSoft` are the text colours on the cover fill (onPrimary / onPrimarySoft for a primary fill,
 * onDark / onDarkSoft for the dark fill).
 */
export type Colour =
  | "primary"
  | "primaryInk"
  | "accent"
  | "ink"
  | "muted"
  | "dark"
  | "onDark"
  | "onDarkSoft"
  | "onFill"
  | "onFillSoft"
  | "tint"
  | "tintInk"
  | "warm"
  | "wash"
  | `#${string}`;

export interface ThemePalette {
  primary: string;
  primaryInk: string;
  accent: string;
  onPrimary: string;
  onPrimarySoft: string;
  // bold
  dark: string;
  onDark: string;
  onDarkSoft: string;
  onDarkSubtle: string;
  darkRule: string;
  // friendly
  tint: string;
  tintInk: string;
  warm: string;
  wash: string;
  chipBg: string;
  onChipSoft: string;
}

const NAVY = "#0b1220";
const WHITE = "#ffffff";

export function themePalette(primary: string, accent: string): ThemePalette {
  const onPrimary = textOn(primary);
  // A dark brand-derived colour with at least 12:1 against white text (the mockup's #14213d for the default blue).
  let dark = mix(primary, NAVY, 0.72);
  for (let i = 0; i < 10 && contrast(WHITE, dark) < 12; i++) dark = mix(dark, NAVY, 0.25);
  const tint = mix(primary, WHITE, 0.9);
  // The cover chips: a faint wash of the cover text colour over the primary, as dark as needed to keep their own text readable.
  let chipBg = primary;
  for (let t = 0.14; t > 0; t = Math.round((t - 0.02) * 100) / 100) {
    const c = mix(primary, onPrimary, t);
    if (contrast(onPrimary, c) >= 4.5) {
      chipBg = c;
      break;
    }
  }
  return {
    primary,
    primaryInk: inkOn(primary),
    accent,
    onPrimary,
    onPrimarySoft: softTextOn(onPrimary, primary),
    dark,
    onDark: WHITE,
    onDarkSoft: softTextOn(WHITE, dark, 0.35),
    onDarkSubtle: softTextOn(WHITE, dark, 0.2),
    darkRule: mix(dark, WHITE, 0.15),
    tint,
    tintInk: inkOn(primary, tint),
    warm: mix(primary, WHITE, 0.93),
    wash: mix(primary, WHITE, 0.96),
    chipBg,
    onChipSoft: softTextOn(onPrimary, chipBg),
  };
}
