/**
 * `setup --step branding [--client <domain>]`: the agency's report branding. Shows the current values, asks
 * for each one (Enter keeps it), renders a one-page preview with sample data, and loops "change something"
 * until the user saves or cancels. Nothing is written to the templates file until they choose save; a dry
 * run may render the preview but writes no settings; --yes keeps the current values and shows no preview.
 */
import { DEFAULT_ACCENT, DEFAULT_PRIMARY } from "../reports/render/color.js";
import {
  brandingFile,
  checkLogoFile,
  cleanText,
  currentBranding,
  importLogo,
  logoSourcePath,
  MAX_AGENCY_NAME,
  MAX_COMMENTARY_NOTE,
  MAX_FOOTER,
  parseColor,
  parseFontName,
  primaryContrast,
  writeBranding,
  type BrandingSettings,
  type SettingField,
} from "../reports/branding-settings.js";
import type { PreviewResult } from "../reports/branding-preview.js";
import { loadTemplates } from "../reports/templates/load.js";
import type { Format } from "../reports/templates/schema.js";
import type { Choice } from "./prompter.js";
import { uiFor } from "./ui.js";
import type { StepResult, WizardContext } from "./wizard.js";

const MAX_ATTEMPTS = 3;

export const FIELD_LABELS: Record<SettingField, string> = {
  agencyName: "Agency name",
  logo: "Logo",
  primaryColor: "Primary colour",
  accentColor: "Accent colour",
  bodyFont: "Body font",
  headingFont: "Heading font",
  fontFallback: "Font fallback",
  footer: "Footer text",
  hideCrawlmark: "White label (hide crawlmark)",
  hideProviders: "Hide data provider names",
  commentaryNote: "Commentary note",
  paper: "Paper size",
  formats: "Default report format(s)",
};
const FORMAT_LABELS: Record<Format, string> = { pdf: "PDF", docx: "Word (.docx)", html: "HTML", md: "Markdown" };
const FORMATS_ORDER: Format[] = ["pdf", "docx", "html", "md"];

/** The branding session: the settings so far, and a logo file the user picked that isn't copied yet. */
export interface BrandingDraft {
  s: BrandingSettings;
  /** Absolute path of a newly picked logo (copied into <home>/branding/ only on save). */
  logoSource?: string | undefined;
}

/** One line per setting (pure), for "current values" and the preview summary. */
export function describeBranding(s: BrandingSettings): string[] {
  return [
    `${FIELD_LABELS.agencyName}: ${s.agencyName ?? "not set"}`,
    `${FIELD_LABELS.logo}: ${s.logo ?? "none"}`,
    `${FIELD_LABELS.primaryColor}: ${s.primaryColor ?? `not set (default ${DEFAULT_PRIMARY})`}`,
    `${FIELD_LABELS.accentColor}: ${s.accentColor ?? `not set (default ${DEFAULT_ACCENT})`}`,
    `${FIELD_LABELS.bodyFont}: ${s.bodyFont ?? "not set (the report's own font)"}`,
    `${FIELD_LABELS.headingFont}: ${s.headingFont ?? "same as the body font"}`,
    `${FIELD_LABELS.fontFallback}: ${s.fontFallback ?? "sans-serif"}`,
    `${FIELD_LABELS.footer}: ${s.footer ?? "not set"}`,
    `${FIELD_LABELS.hideCrawlmark}: ${s.hideCrawlmark ? "yes" : "no"}`,
    `${FIELD_LABELS.hideProviders}: ${(s.hideProviders ?? s.hideCrawlmark ?? false) ? "yes" : "no"}${s.hideProviders === undefined ? " (follows white label)" : ""}`,
    `${FIELD_LABELS.commentaryNote}: ${s.commentaryNote === undefined ? "default wording" : s.commentaryNote === "" ? "none (the line is left out)" : s.commentaryNote}`,
    `${FIELD_LABELS.paper}: ${s.paper ?? "Letter"}`,
    `${FIELD_LABELS.formats}: ${(s.formats?.length ? s.formats : (["pdf"] as Format[])).map((f) => FORMAT_LABELS[f]).join(", ")}`,
  ];
}

/** A font family name, or undefined for "none". Enter keeps the current one; "-" clears it. */
async function askFont(ctx: WizardContext, question: string, current: string | undefined): Promise<string | undefined> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const a = (await ctx.prompt.ask(question, { default: current })).trim();
    if (a === "-") return undefined;
    if (a === "") return current;
    const f = parseFontName(a);
    if (f) return f;
    uiFor(ctx).fail(`"${cleanText(a, 40)}" isn't a font family name: use letters, digits, spaces and hyphens (for example Inter or Open Sans).`);
  }
  return current;
}

/** A #rrggbb colour. Enter keeps the current one, and keeps "not set" as not set (the report's default); "-" clears it. */
async function askColor(ctx: WizardContext, question: string, current: string | undefined, fallback: string): Promise<string | undefined> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const a = (await ctx.prompt.ask(`${question} (#rrggbb; Enter keeps${current ? "" : ` the default ${fallback}`}, - for the default)`, { default: current })).trim();
    if (a === "-") return undefined;
    if (a === "") return current;
    const c = parseColor(a);
    if (c) return c;
    uiFor(ctx).fail(`"${cleanText(a, 20)}" isn't a #rrggbb colour (for example ${fallback}).`);
  }
  return current;
}

/** Ask one setting again (showing its current value) and return the updated draft. */
export async function askField(ctx: WizardContext, field: SettingField, draft: BrandingDraft): Promise<BrandingDraft> {
  const ui = uiFor(ctx);
  const s = { ...draft.s };
  let logoSource = draft.logoSource;
  switch (field) {
    case "agencyName": {
      const a = await ctx.prompt.ask("Agency name, shown on the report cover (Enter keeps, - for none)", { default: s.agencyName });
      s.agencyName = a.trim() === "-" ? undefined : cleanText(a, MAX_AGENCY_NAME) || undefined;
      break;
    }
    case "logo": {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const a = (await ctx.prompt.ask("Logo file, PNG or JPEG up to 512 KB (Enter keeps, - for none)", { default: s.logo })).trim();
        if (a === "" || a === s.logo) break;
        if (a === "-") {
          s.logo = undefined;
          logoSource = undefined;
          break;
        }
        const path = logoSourcePath(ctx.paths.home, a, ctx.paths.cwd, ctx.paths.userHome);
        const check = checkLogoFile(path);
        if (check.ok) {
          logoSource = path;
          s.logo = path;
          break;
        }
        ui.fail(check.problem);
      }
      break;
    }
    case "primaryColor": {
      let c = await askColor(ctx, "Primary colour: the cover band, headings and the main chart line", s.primaryColor, DEFAULT_PRIMARY);
      if (c) {
        const check = primaryContrast(c);
        if (!check.ok && check.suggestion) {
          ui.warn(`White text on ${c} has a contrast of ${check.ratio.toFixed(2)}:1; WCAG AA needs 4.5:1. The report would switch the cover to dark text.`);
          if (await ctx.prompt.confirm(`Use the darker ${check.suggestion} instead (passes AA with white text)?`, true)) c = check.suggestion;
        }
      }
      s.primaryColor = c;
      break;
    }
    case "accentColor":
      s.accentColor = await askColor(ctx, "Accent colour: the stripe under the cover band", s.accentColor, DEFAULT_ACCENT);
      break;
    case "bodyFont":
      s.bodyFont = await askFont(ctx, "Body font: a font family name (Enter keeps, - for the report's own font). It shows only where it is installed; Word and Google Docs swap in another when it isn't", s.bodyFont);
      break;
    case "headingFont":
      s.headingFont = await askFont(ctx, "Heading font (Enter keeps, - for the same as the body font)", s.headingFont);
      break;
    case "fontFallback": {
      const pick = await ctx.prompt.choose("Fallback when a font isn't installed", [{ value: "sans-serif", label: "Sans-serif" }, { value: "serif", label: "Serif" }] as const, s.fontFallback ?? "sans-serif");
      s.fontFallback = pick === "sans-serif" && s.fontFallback === undefined ? undefined : pick;
      break;
    }
    case "footer": {
      const a = await ctx.prompt.ask(`Footer text on every page, at most ${MAX_FOOTER} characters (Enter keeps, - for none)`, { default: s.footer });
      s.footer = a.trim() === "-" ? undefined : cleanText(a, MAX_FOOTER) || undefined;
      break;
    }
    case "hideCrawlmark":
      s.hideCrawlmark = (await ctx.prompt.confirm("White label: leave crawlmark's name and version out of client reports?", s.hideCrawlmark ?? false)) || undefined;
      break;
    case "hideProviders": {
      const follows = s.hideCrawlmark ?? false;
      const yes = await ctx.prompt.confirm("Hide data provider names like DataForSEO (Ahrefs and Semrush source lines stay)?", s.hideProviders ?? follows);
      // The same answer as white label, with nothing saved before, stays unset so it keeps following white label.
      s.hideProviders = yes === follows && s.hideProviders === undefined ? undefined : yes;
      break;
    }
    case "commentaryNote": {
      const a = await ctx.prompt.ask(`Commentary note: the line that says how the written commentary was made, at most ${MAX_COMMENTARY_NOTE} characters (Enter keeps, - for the default wording, none for no line)`, { default: s.commentaryNote || undefined });
      const t = a.trim();
      if (t === "-") s.commentaryNote = undefined;
      else if (t.toLowerCase() === "none") s.commentaryNote = "";
      else if (t !== "") s.commentaryNote = cleanText(t, MAX_COMMENTARY_NOTE);
      break;
    }
    case "paper": {
      const pick = await ctx.prompt.choose("Paper size for PDF and Word", [{ value: "Letter", label: "US Letter" }, { value: "A4", label: "A4" }] as const, s.paper ?? "Letter");
      // Keeping the default with nothing saved stays unset (Q2).
      s.paper = pick === "Letter" && s.paper === undefined ? undefined : pick;
      break;
    }
    case "formats": {
      const choices: Choice<Format>[] = FORMATS_ORDER.map((f) => ({ value: f, label: FORMAT_LABELS[f] }));
      const current = s.formats?.length ? s.formats : (["pdf"] as Format[]);
      const picked = ctx.prompt.multiselect
        ? await ctx.prompt.multiselect("Default report format(s)", choices, current, { summary: `Default report format: ${current.map((f) => FORMAT_LABELS[f]).join(", ")}. Keep it?` })
        : current;
      const next: Format[] = picked.length ? picked : ["pdf"];
      // Keeping the default (PDF) with nothing saved stays unset (Q2).
      s.formats = s.formats === undefined && next.join() === "pdf" ? undefined : next;
      break;
    }
  }
  return { s, logoSource };
}

const FIELD_CHOICES: readonly Choice<SettingField>[] = (Object.keys(FIELD_LABELS) as SettingField[]).map((f) => ({ value: f, label: FIELD_LABELS[f] }));

export async function stepBranding(ctx: WizardContext): Promise<StepResult> {
  const step = "branding";
  const ui = uiFor(ctx);
  const home = ctx.paths.home;
  const client = ctx.brandingClient;
  const file = brandingFile(home, client);
  // An invalid templates file would be ignored by reports: stop before asking anything rather than edit around it.
  const loaded = loadTemplates({ homeDir: home, clientSlug: client });
  const invalid = [loaded.files.global, loaded.files.client].filter((f) => f && f.exists && !f.valid).map((f) => f!.path);
  if (invalid.length) {
    return { step, outcome: "failed", message: `Fix ${invalid.join(" and ")} first (${ctx.cliDisplay} report templates validate); nothing was changed.` };
  }
  const current = currentBranding(home, client);
  ctx.out(client ? `Report branding for ${client} (overrides the global branding), saved in ${file}.` : `Report branding for every client, saved in ${file}.`);
  ctx.out("Current values:");
  for (const l of describeBranding(current)) ctx.out(`  ${l}`);
  if (ctx.yes) return { step, outcome: "skipped", message: "Kept the current branding." };

  let draft: BrandingDraft = { s: { ...current } };
  for (const f of Object.keys(FIELD_LABELS) as SettingField[]) draft = await askField(ctx, f, draft);

  for (;;) {
    if (ctx.brandingPreview) {
      let preview: PreviewResult | undefined;
      try {
        preview = await ui.spin("Making a one-page preview with sample data...", () => ctx.brandingPreview!(draft.s));
      } catch (err) {
        ui.warn(`The preview couldn't be made: ${cleanText((err as Error).message, 300)}`);
      }
      if (preview) {
        if (preview.warning) ui.warn(preview.warning);
        if (preview.logoWarning) ui.warn(preview.logoWarning);
        ui.info(`Preview (sample data, not a client report): ${preview.path}`);
        if (ctx.openPath && ui.fancy && !ctx.dryRun && !ctx.yes) {
          const a = await ctx.prompt.ask("Press Enter to open the preview (or s to skip)");
          if (a.trim() === "" && !ctx.openPath(preview.path)) ui.info(`Couldn't open it. The preview is ${preview.path}`);
        }
      }
    }
    const next = await ctx.prompt.choose(
      "Save this branding?",
      [
        { value: "save", label: "Looks good, save" },
        { value: "change", label: "Change something" },
        { value: "cancel", label: "Cancel (save nothing)" },
      ] as const,
      "save",
    );
    if (next === "cancel") return { step, outcome: "skipped", message: "Nothing saved; the branding is unchanged." };
    if (next === "save") break;
    const field = await ctx.prompt.choose("Which one?", FIELD_CHOICES, "agencyName");
    draft = await askField(ctx, field, draft);
  }

  if (ctx.dryRun) {
    ui.info(`Dry run: would write the branding${draft.logoSource ? " and copy the logo into the branding folder" : ""} to ${file}.`);
    return { step, outcome: "done", message: "Dry run: nothing saved." };
  }
  const settings = { ...draft.s };
  if (draft.logoSource) {
    const check = checkLogoFile(draft.logoSource);
    if (!check.ok) return { step, outcome: "failed", message: check.problem };
    settings.logo = importLogo(home, check.data, check.mime, { clientSlug: client });
  }
  const written = writeBranding(home, settings, client);
  ui.success(`Saved the branding to ${written} (mode 0600).`);
  return { step, outcome: "done", message: `Branding saved${settings.agencyName ? ` for ${settings.agencyName}` : ""}. Preview it any time: ${ctx.cliDisplay} report preview-branding${client ? ` --client ${client}` : ""}` };
}
