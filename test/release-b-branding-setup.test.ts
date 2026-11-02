/**
 * Release B (B3): branding setup for fonts, provider names and the commentary note (`setup --step branding`).
 * Scripted answers, temp homes, example.com only.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { asResolvedBranding, brandingFileText, currentBranding, parseFontName, writeBranding } from "../src/reports/branding-settings.js";
import { renderBrandingPreview, sampleReport } from "../src/reports/branding-preview.js";
import { buildReportDoc } from "../src/reports/render/doc.js";
import { loadTemplates } from "../src/reports/templates/load.js";
import type { Choice, Prompter } from "../src/setup/prompter.js";
import { describeBranding, stepBranding } from "../src/setup/branding-step.js";
import { recordingUi } from "../src/setup/ui.js";
import type { WizardContext } from "../src/setup/wizard.js";

const home = () => mkdtempSync(join(tmpdir(), "crawlmark-rb-brand-"));
const globalFile = (h: string) => join(h, "config", "report-templates.yaml");

type Answer = string | boolean | string[];

/** Scripted answers in order; questions and the defaults offered are recorded. */
function scripted(answers: Answer[]): Prompter & { asked: string[]; defaults: Record<string, unknown> } {
  const asked: string[] = [];
  const defaults: Record<string, unknown> = {};
  const next = (q: string, d: unknown): Answer => {
    asked.push(q);
    defaults[q] = d;
    if (!answers.length) throw new Error(`Unexpected question: ${q}`);
    return answers.shift()!;
  };
  return {
    asked,
    defaults,
    ask: async (q, o = {}) => {
      const a = next(q, o.default) as string;
      return a === "" ? (o.default ?? "") : a;
    },
    secret: async (q) => next(q, undefined) as string,
    confirm: async (q, d) => next(q, d) as boolean,
    choose: async <T extends string>(q: string, _c: readonly Choice<T>[], d: T) => ((next(q, d) as string) || d) as T,
    multiselect: async <T extends string>(q: string, _c: readonly Choice<T>[], d: readonly T[]) => {
      const a = next(q, d);
      return (Array.isArray(a) ? a : [...d]) as T[];
    },
    close() {},
  };
}

function ctxFor(h: string, answers: Answer[]) {
  const prompt = scripted(answers);
  const previews: unknown[] = [];
  const ctx = {
    prompt,
    out: () => undefined,
    ui: recordingUi(),
    paths: { home: h, homeSource: "project", projectRoot: h, envFile: join(h, ".env"), userHome: h, cwd: h, desktopConfig: undefined },
    cliDisplay: "crawlmark-cli",
    dryRun: false,
    brandingPreview: async (s: unknown) => (previews.push(structuredClone(s)), { path: join(h, "branding", "preview.pdf"), format: "pdf" as const }),
  } as unknown as WizardContext;
  return { ctx, prompt, previews };
}

// name, logo, primary, accent, body font, heading font, fallback, footer, white label, hide providers, note, paper, formats
const fields = (o: { body?: string; heading?: string; fallback?: string; whiteLabel?: boolean; providers?: boolean; note?: string } = {}): Answer[] => [
  "",
  "",
  "",
  "",
  o.body ?? "",
  o.heading ?? "",
  o.fallback ?? "",
  "",
  o.whiteLabel ?? false,
  o.providers ?? false,
  o.note ?? "",
  "",
  ["pdf"],
];

describe("font names", () => {
  it("accepts family names and refuses anything that could break CSS, XML or point at a file", () => {
    expect(parseFontName("  Open   Sans ")).toBe("Open Sans");
    expect(parseFontName("Source-Serif 4")).toBe("Source-Serif 4");
    for (const bad of ["", "Inter;", "a}b", "a/b", "Inter.ttf", "https://example.com/f", "x".repeat(61), "-Inter", "Inter\"x", "a<b"]) expect(parseFontName(bad)).toBeUndefined();
  });
});

describe("setup --step branding: fonts, providers and the commentary note", () => {
  it("writes the fonts, fallback, provider choice and note to the templates file", async () => {
    const h = home();
    const { ctx } = ctxFor(h, [...fields({ body: "Inter", heading: "Merriweather", fallback: "serif", whiteLabel: true, providers: false, note: "Written by our team." }), "save"]);
    expect(await stepBranding(ctx)).toMatchObject({ outcome: "done" });
    const text = readFileSync(globalFile(h), "utf8");
    expect(text).toContain("bodyFont: Inter");
    expect(text).toContain("headingFont: Merriweather");
    expect(text).toContain("fontFallback: serif");
    // White label is on but the user said to keep provider names: an explicit false is saved.
    expect(text).toContain("hideProviders: false");
    expect(text).toContain("commentaryNote: Written by our team.");
    expect(loadTemplates({ homeDir: h }).branding).toMatchObject({ bodyFont: "Inter", headingFont: "Merriweather", fontFallback: "serif", hideCrawlmark: true, hideProviders: false, commentaryNote: "Written by our team." });
  });

  it('"same as body" leaves headingFont unset, and "-" clears one that was saved', async () => {
    const h = home();
    await stepBranding(ctxFor(h, [...fields({ body: "Inter" }), "save"]).ctx);
    let b = loadTemplates({ homeDir: h }).branding;
    expect(b.bodyFont).toBe("Inter");
    expect(b).not.toHaveProperty("headingFont");
    expect(b).not.toHaveProperty("fontFallback"); // sans-serif stays implicit
    await stepBranding(ctxFor(h, [...fields({ heading: "Merriweather" }), "save"]).ctx);
    expect(loadTemplates({ homeDir: h }).branding.headingFont).toBe("Merriweather");
    await stepBranding(ctxFor(h, [...fields({ heading: "-" }), "save"]).ctx);
    b = loadTemplates({ homeDir: h }).branding;
    expect(b).not.toHaveProperty("headingFont");
    expect(b.bodyFont).toBe("Inter"); // Enter kept it
  });

  it("asks a bad font name again with the reason, and never saves it", async () => {
    const h = home();
    const { ctx, prompt } = ctxFor(h, [...fields({ body: "Inter;" }).slice(0, 4), "Inter;", "Inter", ...fields().slice(5), "save"]);
    await stepBranding(ctx);
    expect(prompt.asked.filter((q) => q.startsWith("Body font"))).toHaveLength(2);
    expect((ctx.ui as ReturnType<typeof recordingUi>).events).toContainEqual(expect.stringMatching(/^fail: .*isn't a font family name/));
    expect(readFileSync(globalFile(h), "utf8")).not.toContain("Inter;");
    expect(loadTemplates({ homeDir: h }).branding.bodyFont).toBe("Inter");
  });

  it("the hide-providers question defaults to the white label answer, and stays unset when it matches", async () => {
    const h = home();
    const { ctx, prompt } = ctxFor(h, [...fields({ whiteLabel: true, providers: true }), "save"]);
    await stepBranding(ctx);
    const q = prompt.asked.find((x) => x.startsWith("Hide data provider names"))!;
    expect(prompt.defaults[q]).toBe(true);
    const b = loadTemplates({ homeDir: h }).branding;
    expect(b.hideCrawlmark).toBe(true);
    expect(b).not.toHaveProperty("hideProviders"); // still follows white label

    const h2 = home();
    const second = ctxFor(h2, [...fields({ whiteLabel: false, providers: false }), "save"]);
    await stepBranding(second.ctx);
    expect(second.prompt.defaults[second.prompt.asked.find((x) => x.startsWith("Hide data provider names"))!]).toBe(false);

    // Hiding provider names without white label is saved explicitly.
    const h3 = home();
    await stepBranding(ctxFor(h3, [...fields({ whiteLabel: false, providers: true }), "save"]).ctx);
    expect(loadTemplates({ homeDir: h3 }).branding.hideProviders).toBe(true);
  });

  it('commentary note: "none" saves an empty string (no line), "-" returns to the default wording', async () => {
    const h = home();
    await stepBranding(ctxFor(h, [...fields({ note: "none" }), "save"]).ctx);
    expect(readFileSync(globalFile(h), "utf8")).toMatch(/commentaryNote: ""/);
    expect(loadTemplates({ homeDir: h }).branding.commentaryNote).toBe("");
    await stepBranding(ctxFor(h, [...fields({ note: "-" }), "save"]).ctx);
    expect(loadTemplates({ homeDir: h }).branding).not.toHaveProperty("commentaryNote");
  });

  it("keeps allowTerms and blockTerms the user wrote by hand", async () => {
    const h = home();
    writeBranding(h, { agencyName: "Example Agency" });
    const path = globalFile(h);
    const text = readFileSync(path, "utf8").replace("branding:\n", "branding:\n  allowTerms: [Claude]\n  blockTerms: [Acme]\n");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, text);
    await stepBranding(ctxFor(h, [...fields({ body: "Inter" }), "save"]).ctx);
    expect(loadTemplates({ homeDir: h }).branding).toMatchObject({ bodyFont: "Inter", allowTerms: ["Claude"], blockTerms: ["Acme"] });
  });

  it("shows the new values in the current-values list", () => {
    const lines = describeBranding({ bodyFont: "Inter", fontFallback: "serif", hideCrawlmark: true, commentaryNote: "" });
    expect(lines).toContain("Body font: Inter");
    expect(lines).toContain("Heading font: same as the body font");
    expect(lines).toContain("Font fallback: serif");
    expect(lines).toContain("Hide data provider names: yes (follows white label)");
    expect(lines).toContain("Commentary note: none (the line is left out)");
  });
});

describe("client override and the preview", () => {
  it("a client file holds only the fonts that differ from the global branding", () => {
    const global = { bodyFont: "Inter", headingFont: "Merriweather" };
    const text = brandingFileText(undefined, { ...global, headingFont: "Lora" }, { client: true, global });
    expect(text).toContain("headingFont: Lora");
    expect(text).not.toContain("bodyFont");
  });

  it("currentBranding reads the merged fonts, and the resolved branding carries them to the renderers", () => {
    const h = home();
    writeBranding(h, { bodyFont: "Inter", headingFont: "Merriweather", fontFallback: "serif", hideProviders: true, commentaryNote: "" });
    const cur = currentBranding(h);
    expect(cur).toMatchObject({ bodyFont: "Inter", headingFont: "Merriweather", fontFallback: "serif", hideProviders: true, commentaryNote: "" });
    const resolved = asResolvedBranding(h, cur);
    expect(resolved).toMatchObject({ bodyFont: "Inter", headingFont: "Merriweather", fontFallback: "serif", hideProviders: true, commentaryNote: "" });
    const doc = buildReportDoc(sampleReport(), { branding: resolved, logo: undefined, version: "0.0.0", sample: true });
    expect(doc.branding.fonts).toEqual({ body: "Inter", heading: "Merriweather", fallback: "serif" });
  });

  it("the preview names the fonts on the page, and says nothing about fonts when none are set", async () => {
    const h = home();
    const html: string[] = [];
    const printer = async (page: string) => {
      html.push(page);
      throw new Error("no Chrome in tests");
    };
    const branding = asResolvedBranding(h, { bodyFont: "Inter", headingFont: "Merriweather" });
    const r = await renderBrandingPreview(h, branding, { printer, version: "0.0.0" });
    expect(r.format).toBe("html");
    expect(readFileSync(r.path, "utf8")).toContain("Body text is set in Inter and headings in Merriweather.");
    await renderBrandingPreview(h, asResolvedBranding(h, {}), { printer, version: "0.0.0" });
    expect(html[1]).not.toContain("Body text is set in");
    expect(sampleReport().sections.some((s) => s.id === "fonts")).toBe(false);
  });
});
