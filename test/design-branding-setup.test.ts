/** Release 0.4.0 T4 (P-C8): the theme question in `setup --step branding`, the all-themes entry and `report preview-branding --all-themes`. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { currentBranding, writeBranding } from "../src/reports/branding-settings.js";
import type { ThemePreviewResult } from "../src/reports/branding-preview.js";
import { previewBrandingCommand } from "../src/report-cli.js";
import { loadTemplates } from "../src/reports/templates/load.js";
import { THEME_IDS } from "../src/reports/templates/schema.js";
import type { Choice, Prompter } from "../src/setup/prompter.js";
import { describeBranding, stepBranding } from "../src/setup/branding-step.js";
import { recordingUi } from "../src/setup/ui.js";
import type { WizardContext } from "../src/setup/wizard.js";

const home = () => mkdtempSync(join(tmpdir(), "crawlmark-t4-setup-"));
const globalFile = (h: string) => join(h, "config", "report-templates.yaml");

type Answer = string | boolean | string[];

function scripted(answers: Answer[]) {
  const asked: string[] = [];
  const choices: Record<string, readonly Choice<string>[]> = {};
  const defaults: Record<string, unknown> = {};
  const next = (q: string, d: unknown): Answer => {
    asked.push(q);
    defaults[q] = d;
    if (!answers.length) throw new Error(`Unexpected question: ${q}`);
    return answers.shift()!;
  };
  const prompt: Prompter = {
    ask: async (q, o = {}) => {
      const a = next(q, o.default) as string;
      return a === "" ? (o.default ?? "") : a;
    },
    secret: async (q) => next(q, undefined) as string,
    confirm: async (q, d) => next(q, d) as boolean,
    choose: async <T extends string>(q: string, c: readonly Choice<T>[], d: T) => {
      choices[q] = c;
      return ((next(q, d) as string) || d) as T;
    },
    multiselect: async <T extends string>(q: string, _c: readonly Choice<T>[], d: readonly T[]) => {
      const a = next(q, d);
      return (Array.isArray(a) ? a : [...d]) as T[];
    },
    close() {},
  };
  return { prompt, asked, choices, defaults };
}

function ctxFor(h: string, answers: Answer[], opts: { dryRun?: boolean; themes?: boolean; client?: string } = {}) {
  const s = scripted(answers);
  const themeCalls: unknown[] = [];
  const opened: string[] = [];
  const ctx = {
    prompt: s.prompt,
    out: () => undefined,
    ui: recordingUi(),
    paths: { home: h, homeSource: "project", projectRoot: h, envFile: join(h, ".env"), userHome: h, cwd: h, desktopConfig: undefined },
    cliDisplay: "crawlmark-cli",
    dryRun: opts.dryRun ?? false,
    ...(opts.client ? { brandingClient: opts.client } : {}),
    ...(opts.themes
      ? {
          brandingThemePreviews: async (settings: unknown): Promise<ThemePreviewResult> => {
            themeCalls.push(structuredClone(settings));
            return { dir: join(h, "branding", "themes"), files: THEME_IDS.map((t, i) => ({ theme: t, path: join(h, "branding", "themes", `${i + 1}-${t}.pdf`), format: "pdf" as const })), warnings: [] };
          },
        }
      : {}),
    openPath: (p: string) => (opened.push(p), true),
  } as unknown as WizardContext;
  return { ctx, ...s, themeCalls, opened };
}

// name, logo, primary, accent, THEME, body font, heading font, fallback, footer, white label, hide providers, note, paper, formats
const fields = (theme = ""): Answer[] => ["", "", "", "", theme, "", "", "", "", false, false, "", "", ["pdf"]];

describe("setup --step branding: the theme question", () => {
  it("asks after the colours, listing six labelled entries in order, default Cards", async () => {
    const h = home();
    const { ctx, choices, defaults, asked } = ctxFor(h, [...fields(), "save"]);
    await stepBranding(ctx);
    const q = asked.find((x) => x.startsWith("Report theme"))!;
    expect(asked.indexOf(q)).toBe(asked.findIndex((x) => x.startsWith("Accent colour")) + 1);
    expect(choices[q]!.map((c) => c.value)).toEqual([...THEME_IDS]);
    expect(choices[q]!.map((c) => c.label.split(":")[0])).toEqual(["Cards", "Minimal", "Editorial", "Bold", "Consulting", "Friendly"]);
    expect(choices[q]!.every((c) => /^[A-Z][a-z]+: \S/.test(c.label))).toBe(true);
    expect(defaults[q]).toBe("cards");
    // The accent question names the only theme that uses it.
    expect(asked.find((x) => x.startsWith("Accent colour"))).toContain("used by the Cards theme");
  });

  it("choosing Friendly writes branding.theme: friendly to the global templates file", async () => {
    const h = home();
    const { ctx } = ctxFor(h, [...fields("friendly"), "save"]);
    expect(await stepBranding(ctx)).toMatchObject({ outcome: "done" });
    expect(readFileSync(globalFile(h), "utf8")).toContain("theme: friendly");
    expect(loadTemplates({ homeDir: h }).branding.theme).toBe("friendly");
    expect(currentBranding(h).theme).toBe("friendly");
  });

  it("choosing Cards when nothing was saved leaves theme unset", async () => {
    const h = home();
    await stepBranding(ctxFor(h, [...fields("cards"), "save"]).ctx);
    expect(readFileSync(globalFile(h), "utf8")).not.toContain("theme:");
    expect(loadTemplates({ homeDir: h }).branding).not.toHaveProperty("theme");
  });

  it("Enter keeps a saved theme, and picking Cards after another theme writes cards", async () => {
    const h = home();
    writeBranding(h, { agencyName: "Example Agency", theme: "bold" });
    const keep = ctxFor(h, [...fields(""), "save"]);
    await stepBranding(keep.ctx);
    expect(keep.defaults[keep.asked.find((x) => x.startsWith("Report theme"))!]).toBe("bold");
    expect(loadTemplates({ homeDir: h }).branding.theme).toBe("bold");
    await stepBranding(ctxFor(h, [...fields("cards"), "save"]).ctx);
    expect(loadTemplates({ homeDir: h }).branding.theme).toBe("cards");
  });

  it("a client override writes the client file only", async () => {
    const h = home();
    await stepBranding(ctxFor(h, [...fields("consulting"), "save"], { client: "example.com" }).ctx);
    expect(readFileSync(join(h, "config", "report-templates", "example.com.yaml"), "utf8")).toContain("theme: consulting");
    expect(existsSync(globalFile(h))).toBe(false);
    expect(loadTemplates({ homeDir: h, clientSlug: "example.com" }).branding.theme).toBe("consulting");
  });

  it("a client file does not repeat the global theme when the client keeps it", async () => {
    const h = home();
    writeBranding(h, { theme: "minimal" });
    await stepBranding(ctxFor(h, [...fields(""), "save"], { client: "example.com" }).ctx);
    const f = join(h, "config", "report-templates", "example.com.yaml");
    expect(!existsSync(f) || !readFileSync(f, "utf8").includes("theme:")).toBe(true);
  });

  it("--dry-run writes nothing", async () => {
    const h = home();
    const r = await stepBranding(ctxFor(h, [...fields("bold"), "save"], { dryRun: true }).ctx);
    expect(r).toMatchObject({ outcome: "done", message: "Dry run: nothing saved." });
    expect(existsSync(globalFile(h))).toBe(false);
  });

  it("currentBranding and the current-values list show the theme", () => {
    const h = home();
    writeBranding(h, { theme: "editorial" });
    expect(currentBranding(h)).toMatchObject({ theme: "editorial" });
    expect(describeBranding(currentBranding(h))).toContain("Report theme: Editorial");
    expect(describeBranding({})).toContain("Report theme: Cards (default)");
  });

  it("Enter at every prompt leaves a file without a theme byte-identical", async () => {
    const h = home();
    mkdirSync(join(h, "config"), { recursive: true });
    const text = "version: 1\n# our branding\nbranding:\n  agencyName: Example Agency\n";
    writeFileSync(globalFile(h), text);
    await stepBranding(ctxFor(h, [...fields(""), "save"]).ctx);
    expect(readFileSync(globalFile(h), "utf8")).toBe(text);
  });
});

describe("setup --step branding: see all six themes", () => {
  it("is offered in the save menu, renders with the draft settings, prints the folder, offers the first file, then asks again", async () => {
    const h = home();
    const { ctx, choices, themeCalls, asked } = ctxFor(h, [...fields("bold"), "themes", "save"], { themes: true });
    const events = (ctx.ui as ReturnType<typeof recordingUi>).events;
    expect(await stepBranding(ctx)).toMatchObject({ outcome: "done" });
    expect(choices["Save this branding?"]!.map((c) => c.label)).toContain("See your branding in all six themes");
    expect(themeCalls).toEqual([expect.objectContaining({ theme: "bold" })]);
    expect(events).toContainEqual(expect.stringContaining(join(h, "branding", "themes")));
    expect(asked.filter((q) => q === "Save this branding?")).toHaveLength(2);
    expect(loadTemplates({ homeDir: h }).branding.theme).toBe("bold");
  });

  it("is left out of the menu when no renderer is wired", async () => {
    const h = home();
    const { ctx, choices } = ctxFor(h, [...fields(), "save"]);
    await stepBranding(ctx);
    expect(choices["Save this branding?"]!.map((c) => c.value)).toEqual(["save", "change", "cancel"]);
  });
});

describe("report preview-branding --all-themes", () => {
  const files = (h: string): ThemePreviewResult => ({ dir: join(h, "branding", "themes"), files: THEME_IDS.map((t, i) => ({ theme: t, path: join(h, "branding", "themes", `${i + 1}-${t}.pdf`), format: "pdf" as const })), warnings: ["The bold PDF preview couldn't be made (x), so it's HTML."] });
  const resolveClient = (id: string) => ({ slug: id });

  it("prints the six paths and the warnings, and never renders the single preview", async () => {
    const h = home();
    const out: string[] = [];
    const errs: string[] = [];
    let single = 0;
    const code = await previewBrandingCommand([], { "all-themes": true }, { out: (l = "") => out.push(l), warn: (l) => errs.push(l), homeDir: h, cwd: h }, {
      render: async () => (single++, { path: "x", format: "pdf" as const }),
      renderThemes: async () => files(h),
      resolveClient,
    });
    expect(code).toBe(0);
    expect(single).toBe(0);
    expect(out.filter((l) => l.includes(`${join(h, "branding", "themes")}`))).toHaveLength(6);
    expect(out.join("\n")).toContain("6-friendly.pdf");
    expect(errs).toEqual([expect.stringContaining("bold PDF preview")]);
  });

  it("uses the client's branding and offers to open the first file", async () => {
    const h = home();
    writeBranding(h, { theme: "minimal" });
    const seen: unknown[] = [];
    const opened: string[] = [];
    const code = await previewBrandingCommand([], { client: "example.com", "all-themes": true }, { out: () => undefined, warn: () => undefined, homeDir: h, cwd: h }, {
      render: async () => ({ path: "x", format: "pdf" as const }),
      renderThemes: async (b) => (seen.push(b), files(h)),
      open: async (p) => void opened.push(p),
      resolveClient,
    });
    expect(code).toBe(0);
    expect(seen).toEqual([expect.objectContaining({ theme: "minimal" })]);
    expect(opened).toEqual([join(h, "branding", "themes", "1-cards.pdf")]);
  });

  it("without --all-themes it still renders the single preview", async () => {
    const h = home();
    const out: string[] = [];
    await previewBrandingCommand([], {}, { out: (l = "") => out.push(l), warn: () => undefined, homeDir: h, cwd: h }, { render: async () => ({ path: "/p/preview.pdf", format: "pdf" as const }), renderThemes: async () => files(h), resolveClient });
    expect(out.join("\n")).toContain("/p/preview.pdf");
  });

  it("extra arguments are a usage error", async () => {
    const h = home();
    const errs: string[] = [];
    const code = await previewBrandingCommand(["--bogus"], { "all-themes": true }, { out: () => undefined, warn: (l) => errs.push(l), homeDir: h, cwd: h }, { render: async () => ({ path: "x", format: "pdf" as const }), renderThemes: async () => files(h), resolveClient });
    expect(code).not.toBe(0);
    expect(errs.join(" ")).toContain("--bogus");
  });
});
