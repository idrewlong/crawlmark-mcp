/**
 * Report branding setup (`setup --step branding`, `report preview-branding`): the settings file edit, logo
 * checks and import, the contrast suggestion, the sample-data preview, and the step's ask / preview / change
 * loop (cancel writes nothing, save writes once). Temp homes only; no network, no Chrome (a fake printer).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveClientOffline } from "../src/clients.js";
import { openPath } from "../src/lib/terminal-links.js";
import { previewBrandingCommand } from "../src/report-cli.js";
import { renderBrandingPreview, sampleReport } from "../src/reports/branding-preview.js";
import { asResolvedBranding, brandingConfigured, brandingFileText, checkLogoFile, currentBranding, importLogo, parseColor, primaryContrast, writeBranding } from "../src/reports/branding-settings.js";
import { contrast } from "../src/reports/render/color.js";
import { STARTER_YAML } from "../src/reports/templates/builtin.js";
import { loadTemplates } from "../src/reports/templates/load.js";
import { validateTemplateText } from "../src/reports/templates/schema.js";
import { stepBranding } from "../src/setup/branding-step.js";
import { PromptAbortedError, type Choice, type Prompter } from "../src/setup/prompter.js";
import { collectSetupStatus, type StatusProviders } from "../src/setup/status.js";
import { recordingUi } from "../src/setup/ui.js";
import type { WizardContext } from "../src/setup/wizard.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8DAwMDAwAAAD/0B/0JgTmQAAAAASUVORK5CYII=", "base64");
const home = () => realpathSync(mkdtempSync(join(tmpdir(), "crawlmark-branding-")));
const mode = (p: string) => statSync(p).mode & 0o777;

describe("branding settings", () => {
  it("writes branding and default formats into the starter, keeping its comments; a client file starts as version 1", () => {
    const text = brandingFileText(undefined, { agencyName: "Acme Agency", primaryColor: "#123456", hideCrawlmark: true, formats: ["pdf", "docx"] }, { client: false });
    expect(text).toContain("# crawlmark report templates. Docs: docs/reports.md");
    expect(text).toContain("agencyName: Acme Agency");
    expect(text).toContain("hideCrawlmark: true");
    expect(text).toContain("formats: [ pdf, docx ]");
    // Unset fields are removed, not left with the starter's example values.
    expect(text).not.toContain("Example Agency");
    expect(validateTemplateText(text).valid).toBe(true);
    const client = brandingFileText(undefined, { footer: "For Example Co" }, { client: true });
    expect(client).toBe("version: 1\nbranding:\n  footer: For Example Co\n");
    expect(validateTemplateText(client).valid).toBe(true);
  });

  it("writeBranding: 0600 file in a 0700 folder; loadTemplates reads it back; a client override merges over the global one", () => {
    const h = home();
    const file = writeBranding(h, { agencyName: "Acme Agency", primaryColor: "#123456", paper: "A4", formats: ["docx"] });
    expect(mode(file)).toBe(0o600);
    expect(loadTemplates({ homeDir: h }).branding).toMatchObject({ agencyName: "Acme Agency", primaryColor: "#123456", paper: "A4" });
    expect(loadTemplates({ homeDir: h }).defaults.formats).toEqual(["docx"]);
    writeBranding(h, { footer: "Prepared for Example Co" }, "example.com");
    expect(currentBranding(h, "example.com")).toMatchObject({ agencyName: "Acme Agency", footer: "Prepared for Example Co" });
    expect(brandingConfigured(h)).toEqual({ configured: true, agencyName: "Acme Agency", clientOverrides: 1 });
    // Comments a user added survive a rewrite.
    writeFileSync(file, `# my note\n${readFileSync(file, "utf8")}`);
    writeBranding(h, { agencyName: "Acme Two" });
    expect(readFileSync(file, "utf8")).toContain("# my note");
  });

  it("colours: #rrggbb only; white text below AA gets a darker suggestion that passes", () => {
    expect(parseColor("1F5EA8")).toBe("#1f5ea8");
    expect(parseColor("blue")).toBeUndefined();
    expect(primaryContrast("#1f5ea8").ok).toBe(true);
    const light = primaryContrast("#ffd400");
    expect(light.ok).toBe(false);
    expect(contrast("#ffffff", light.suggestion!)).toBeGreaterThanOrEqual(4.5);
  });

  it("logos: PNG/JPEG by their bytes, at most 512 KB; imported as a 0600 file in a 0700 branding folder", () => {
    const h = home();
    const good = join(h, "my logo.png");
    writeFileSync(good, PNG);
    const fake = join(h, "fake.png");
    writeFileSync(fake, "<svg/>");
    const big = join(h, "big.png");
    writeFileSync(big, Buffer.concat([PNG, Buffer.alloc(600 * 1024)]));
    expect(checkLogoFile(good)).toMatchObject({ ok: true, mime: "image/png" });
    expect(checkLogoFile(fake)).toMatchObject({ ok: false, problem: expect.stringContaining("isn't a PNG or JPEG") });
    expect(checkLogoFile(big)).toMatchObject({ ok: false, problem: expect.stringContaining("512 KB") });
    expect(checkLogoFile(join(h, "nope.png"))).toMatchObject({ ok: false });
    expect(importLogo(h, readFileSync(good), "image/png", { dryRun: true })).toBe("branding/logo.png");
    expect(existsSync(join(h, "branding"))).toBe(false);
    expect(importLogo(h, readFileSync(good), "image/png", { clientSlug: "example.com" })).toBe("branding/logo-example.com.png");
    expect(mode(join(h, "branding"))).toBe(0o700);
    expect(mode(join(h, "branding", "logo-example.com.png"))).toBe(0o600);
  });
});

describe("SEC-1: logo import never follows a symlink and writes the bytes it checked", () => {
  it("a dangling symlink at branding/logo.png is refused, and nothing is written where it points", () => {
    const h = home();
    mkdirSync(join(h, "branding"), { recursive: true });
    const target = join(h, "outside", "pwned.png");
    symlinkSync(target, join(h, "branding", "logo.png"));
    expect(() => importLogo(h, PNG, "image/png")).toThrow(/symlink/);
    expect(existsSync(target)).toBe(false);
  });

  it("a symlinked branding folder (even dangling) is refused", () => {
    const h = home();
    symlinkSync(join(h, "elsewhere"), join(h, "branding"));
    expect(() => importLogo(h, PNG, "image/png")).toThrow(/symlink/);
    expect(existsSync(join(h, "elsewhere"))).toBe(false);
  });

  it("writes exactly the checked bytes as 0600, not whatever the source file holds later", () => {
    const h = home();
    const src = join(h, "src.png");
    writeFileSync(src, PNG);
    const check = checkLogoFile(src);
    if (!check.ok) throw new Error("expected a valid logo");
    writeFileSync(src, "swapped after the check");
    const rel = importLogo(h, check.data, check.mime);
    expect(readFileSync(join(h, rel))).toEqual(PNG);
    expect(mode(join(h, rel))).toBe(0o600);
    expect(() => importLogo(h, Buffer.from("<svg/>"), "image/png")).toThrow(/PNG or JPEG/);
  });
});

describe("SEC-3: agency name and footer can't carry control characters", () => {
  it("the schema refuses them; the status row strips and caps the name", async () => {
    const bad = "Acme\u001b[31m\u202e Agency";
    expect(validateTemplateText(`version: 1\nbranding:\n  agencyName: ${JSON.stringify(bad)}\n`).errors).toContainEqual({ path: "branding.agencyName", message: "must not contain control or invisible characters" });
    expect(validateTemplateText(`version: 1\nbranding:\n  footer: "a\\u200bb"\n`).errors[0]).toMatchObject({ path: "branding.footer" });
    const providers = {
      cli: () => "crawlmark-cli",
      home: () => ({ info: { dir: "/h", source: "env", reason: "x" }, exists: true, envFile: "/h/.env", envFileExists: true, configuredByEnv: false }),
      googleStatus: () => ({ mode: "none", auto: true, configured: false, problem: "none" }),
      psiKeySet: () => false,
      chrome: async () => ({ ok: true, version: "1" }),
      clients: () => ({ count: 0, ignored: 0, file: "/h/c.yaml", exists: false }),
      branding: () => ({ configured: true, agencyName: `${bad}${"x".repeat(200)}`, clientOverrides: 0 }),
    } as unknown as StatusProviders;
    const r = await collectSetupStatus(providers, { only: ["branding"] });
    const detail = r.integrations.find((i) => i.id === "branding")!.detail;
    expect(detail).not.toMatch(/[\u001b\u202e]/);
    expect(detail).toMatch(/^Agency: Acme\[31m Agencyx+\./);
    expect(detail.indexOf(".")).toBeLessThanOrEqual("Agency: ".length + 80);
  });
});

describe("per-client overrides hold only what differs from the global branding", () => {
  it("changing only the logo writes only the logo; a later global footer change still reaches the client", () => {
    const h = home();
    writeBranding(h, { agencyName: "Acme Agency", footer: "Prepared by Acme", primaryColor: "#123456", formats: ["pdf"] });
    const logo = join(h, "client-logo.png");
    writeFileSync(logo, PNG);
    const rel = importLogo(h, readFileSync(logo), "image/png", { clientSlug: "example.com" });
    // The step starts from the merged values and changes only the logo.
    writeBranding(h, { ...currentBranding(h, "example.com"), logo: rel }, "example.com");
    const clientFile = join(h, "config", "report-templates", "example.com.yaml");
    expect(readFileSync(clientFile, "utf8")).toBe(`version: 1\nbranding:\n  logo: ${rel}\n`);
    writeBranding(h, { ...currentBranding(h), footer: "Prepared by Acme Agency" });
    expect(loadTemplates({ homeDir: h, clientSlug: "example.com" }).branding).toMatchObject({ footer: "Prepared by Acme Agency", agencyName: "Acme Agency", logo: { path: rel } });
  });

  it("a client can turn off the global white label and footer", () => {
    const h = home();
    writeBranding(h, { agencyName: "Acme Agency", footer: "Prepared by Acme", hideCrawlmark: true });
    writeBranding(h, { ...currentBranding(h, "example.com"), hideCrawlmark: undefined, footer: undefined }, "example.com");
    const text = readFileSync(join(h, "config", "report-templates", "example.com.yaml"), "utf8");
    expect(text).toContain("hideCrawlmark: false");
    expect(text).toContain('footer: ""');
    expect(text).not.toContain("agencyName");
    expect(loadTemplates({ homeDir: h, clientSlug: "example.com" }).branding).toMatchObject({ hideCrawlmark: false, footer: "" });
    expect(currentBranding(h, "example.com")).not.toHaveProperty("footer");
    // Saving again with nothing changed keeps the overrides (no reverting to the global values).
    writeBranding(h, currentBranding(h, "example.com"), "example.com");
    expect(loadTemplates({ homeDir: h, clientSlug: "example.com" }).branding).toMatchObject({ hideCrawlmark: false, footer: "" });
    // Formats aren't copied into the client file unless changed.
    expect(readFileSync(join(h, "config", "report-templates", "example.com.yaml"), "utf8")).not.toContain("formats");
  });
});

describe("--client is resolved to the client's slug (clients.yaml, offline)", () => {
  const withClients = () => {
    mkdirSync(join(process.env.CLIENTS_FILE!, ".."), { recursive: true });
    writeFileSync(process.env.CLIENTS_FILE!, "clients:\n  example.com:\n    domain: example.com\n    name: Example Co\n");
  };

  it("URL and www. forms resolve to the slug; an unknown client is refused, naming the known ones", () => {
    withClients();
    expect(resolveClientOffline("https://www.example.com/").slug).toBe("example.com");
    expect(resolveClientOffline("www.example.com").slug).toBe("example.com");
    expect(() => resolveClientOffline("exmaple.com")).toThrow(/example\.com/);
  });

  it("report preview-branding --client: the client's override is used; a typo exits 1 with the known clients", async () => {
    withClients();
    const h = home();
    writeBranding(h, { agencyName: "Acme Agency" });
    writeBranding(h, { ...currentBranding(h, "example.com"), footer: "For Example Co" }, "example.com");
    const render = vi.fn(async (_branding: unknown) => ({ path: join(h, "branding", "preview.pdf"), format: "pdf" as const }));
    const io = (errs: string[]) => ({ out: () => undefined, warn: (l: string) => errs.push(l), homeDir: h, cwd: h });
    expect(await previewBrandingCommand([], { client: "https://www.example.com" }, io([]), { render, resolveClient: resolveClientOffline })).toBe(0);
    expect(render.mock.calls[0]![0]).toMatchObject({ agencyName: "Acme Agency", footer: "For Example Co" });
    const errs: string[] = [];
    expect(await previewBrandingCommand([], { client: "exmaple.com" }, io(errs), { render, resolveClient: resolveClientOffline })).toBe(1);
    expect(errs.join(" ")).toMatch(/exmaple\.com.*example\.com/);
    expect(render).toHaveBeenCalledTimes(1);
  });
});

describe("branding preview", () => {
  it("uses only sample data: no client from clients.yaml appears; it's badged Sample data and written 0600", async () => {
    const h = home();
    // A real-looking client list in this home; the preview must never read it.
    mkdirSync(join(h, "config"), { recursive: true });
    writeFileSync(join(h, "config", "clients.yaml"), "clients:\n  - domain: secret-client.example\n    name: Secret Client Plumbing\n");
    const printed: string[] = [];
    const r = await renderBrandingPreview(h, { agencyName: "Acme Agency", primaryColor: "#123456", hideCrawlmark: true }, { printer: async (html) => (printed.push(html), Buffer.from("%PDF-1.7")), version: "0.1.0" });
    expect(r).toMatchObject({ format: "pdf", path: join(h, "branding", "preview.pdf") });
    expect(mode(r.path)).toBe(0o600);
    const html = printed[0]!;
    expect(html).toContain("Sample data");
    expect(html).toContain("example.com");
    expect(html).toContain("Acme Agency");
    expect(html).not.toMatch(/secret-client|Secret Client|crawlmark/i);
    expect(JSON.stringify(sampleReport())).not.toMatch(/secret-client/);
  });

  it("falls back to HTML without Chrome, with a warning", async () => {
    const h = home();
    const r = await renderBrandingPreview(h, {}, { printer: async () => { throw new Error("Could not find Chrome"); }, version: "0.1.0" });
    expect(r.format).toBe("html");
    expect(r.warning).toMatch(/couldn't be made.*Chrome/);
    expect(readFileSync(r.path, "utf8")).toContain("Sample data");
  });

  it("report preview-branding renders the saved branding and prints the path; it can open the file", async () => {
    const h = home();
    writeBranding(h, { agencyName: "Acme Agency" });
    const lines: string[] = [];
    const render = vi.fn(async (b) => ({ path: join(h, "branding", "preview.pdf"), format: "pdf" as const, b }));
    const open = vi.fn(async () => undefined);
    expect(await previewBrandingCommand([], {}, { out: (l = "") => lines.push(l), warn: () => undefined, homeDir: h, cwd: h }, { render, open, resolveClient: resolveClientOffline })).toBe(0);
    expect(render.mock.calls[0]![0]).toMatchObject({ agencyName: "Acme Agency" });
    expect(lines).toEqual([`Preview (sample data, not a client report): ${join(h, "branding", "preview.pdf")}`]);
    expect(open).toHaveBeenCalledWith(join(h, "branding", "preview.pdf"));
  });

  it("Ctrl-C at 'Press Enter to open': cancelled message, exit 130 (not an error)", async () => {
    const h = home();
    const errs: string[] = [];
    const render = async () => ({ path: join(h, "branding", "preview.pdf"), format: "pdf" as const });
    const open = async () => {
      throw new PromptAbortedError();
    };
    expect(await previewBrandingCommand([], {}, { out: () => undefined, warn: (l) => errs.push(l), homeDir: h, cwd: h }, { render, open, resolveClient: resolveClientOffline })).toBe(130);
    expect(errs).toEqual(["Cancelled; nothing else written."]);
  });

  it("openPath opens only an existing absolute .pdf or .html path, without a shell", () => {
    const spawn = vi.fn(() => ({ on: () => undefined, unref: () => undefined }));
    const yes = () => true;
    expect(openPath("/tmp/preview.pdf", { platform: "darwin", spawn, exists: yes })).toBe(true);
    expect(spawn).toHaveBeenCalledWith("open", ["/tmp/preview.pdf"], expect.objectContaining({ shell: false }));
    expect(openPath("preview.pdf", { spawn, exists: yes })).toBe(false);
    expect(openPath("/tmp/x.sh", { spawn, exists: yes })).toBe(false);
    expect(openPath("/tmp/a\u0007b.pdf", { spawn, exists: yes })).toBe(false);
    expect(openPath("/tmp/missing.pdf", { spawn, exists: () => false })).toBe(false);
  });
});

type Answer = string | boolean | string[];

/** Scripted answers in order; every question is recorded. */
function scripted(answers: Answer[]): Prompter & { asked: string[] } {
  const asked: string[] = [];
  const next = (q: string): Answer => {
    asked.push(q);
    if (!answers.length) throw new Error(`Unexpected question: ${q}`);
    return answers.shift()!;
  };
  return {
    asked,
    ask: async (q, o = {}) => {
      const a = next(q) as string;
      return a === "" ? (o.default ?? "") : a;
    },
    secret: async (q) => next(q) as string,
    confirm: async (q) => next(q) as boolean,
    choose: async <T extends string>(q: string, _c: readonly Choice<T>[], d: T) => ((next(q) as string) || d) as T,
    multiselect: async <T extends string>(q: string, _c: readonly Choice<T>[], d: readonly T[]) => {
      const a = next(q);
      return (Array.isArray(a) ? a : [...d]) as T[];
    },
    close() {},
  };
}

function ctxFor(h: string, answers: Answer[], opts: { dryRun?: boolean; yes?: boolean; preview?: boolean } = {}) {
  const prompt = scripted(answers);
  const lines: string[] = [];
  const previews: unknown[] = [];
  const ctx = {
    prompt,
    out: (l = "") => lines.push(l),
    ui: recordingUi(),
    paths: { home: h, homeSource: "project", projectRoot: h, envFile: join(h, ".env"), userHome: h, cwd: h, desktopConfig: undefined },
    cliDisplay: "crawlmark-cli",
    dryRun: opts.dryRun ?? false,
    yes: opts.yes,
    ...(opts.preview === false ? {} : { brandingPreview: async (s: unknown) => (previews.push(structuredClone(s)), { path: join(h, "branding", "preview.pdf"), format: "pdf" as const }) }),
  } as unknown as WizardContext;
  return { ctx, prompt, lines, previews };
}

/** Answers for the eight fields, in order: name, logo, primary, accent, footer, white label, paper, formats. */
const ALL = (logo: string): Answer[] => ["Acme Agency", logo, "#123456", "#2e8540", "Prepared by Acme", true, "A4", ["pdf", "docx"]];

describe("setup --step branding", () => {
  it("asks each field, previews, re-asks only the field chosen to change, re-renders, and saves once", async () => {
    const h = home();
    const logo = join(h, "logo.png");
    writeFileSync(logo, PNG);
    const { ctx, prompt, previews } = ctxFor(h, [...ALL(logo), "change", "footer", "Prepared by Acme Agency", "save"]);
    const r = await stepBranding(ctx);
    expect(r).toMatchObject({ step: "branding", outcome: "done" });
    // The change loop asked only the footer again.
    const after = prompt.asked.slice(prompt.asked.indexOf("Which one?") + 1);
    expect(after).toEqual([expect.stringMatching(/^Footer text/), "Save this branding?"]);
    expect(previews).toHaveLength(2);
    expect(previews[1]).toMatchObject({ footer: "Prepared by Acme Agency" });
    const loaded = loadTemplates({ homeDir: h });
    expect(loaded.branding).toMatchObject({ agencyName: "Acme Agency", primaryColor: "#123456", footer: "Prepared by Acme Agency", hideCrawlmark: true, paper: "A4", logo: { path: "branding/logo.png", exists: true } });
    expect(loaded.defaults.formats).toEqual(["pdf", "docx"]);
    expect(mode(join(h, "branding", "logo.png"))).toBe(0o600);
  });

  it("cancel writes nothing (not the templates file, not the logo)", async () => {
    const h = home();
    const logo = join(h, "logo.png");
    writeFileSync(logo, PNG);
    const { ctx } = ctxFor(h, [...ALL(logo), "cancel"]);
    expect(await stepBranding(ctx)).toMatchObject({ outcome: "skipped", message: expect.stringContaining("Nothing saved") });
    expect(existsSync(join(h, "config", "report-templates.yaml"))).toBe(false);
    expect(existsSync(join(h, "branding", "logo.png"))).toBe(false);
  });

  it("a light primary colour: warns and offers a darker shade that passes AA", async () => {
    const h = home();
    const { ctx, prompt } = ctxFor(h, ["", "", "#ffd400", true, "", "", false, "", ["pdf"], "save"], { preview: false });
    await stepBranding(ctx);
    expect(prompt.asked).toContainEqual(expect.stringMatching(/^Use the darker #[0-9a-f]{6} instead/));
    const primary = loadTemplates({ homeDir: h }).branding.primaryColor!;
    expect(primary).not.toBe("#ffd400");
    expect(contrast("#ffffff", primary)).toBeGreaterThanOrEqual(4.5);
  });

  it("--yes keeps the current values and asks nothing; --dry-run previews but writes nothing; --client writes the override file", async () => {
    const h = home();
    const yes = ctxFor(h, [], { yes: true });
    expect(await stepBranding(yes.ctx)).toMatchObject({ outcome: "skipped", message: "Kept the current branding." });
    expect(yes.prompt.asked).toEqual([]);

    const dry = ctxFor(h, [...ALL(""), "save"], { dryRun: true });
    expect(await stepBranding(dry.ctx)).toMatchObject({ outcome: "done", message: "Dry run: nothing saved." });
    expect(dry.previews).toHaveLength(1);
    expect(existsSync(join(h, "config", "report-templates.yaml"))).toBe(false);

    const client = ctxFor(h, [...ALL(""), "save"]);
    (client.ctx as { brandingClient?: string }).brandingClient = "example.com";
    await stepBranding(client.ctx);
    expect(existsSync(join(h, "config", "report-templates", "example.com.yaml"))).toBe(true);
    expect(existsSync(join(h, "config", "report-templates.yaml"))).toBe(false);
  });

  it("an invalid templates file stops the step before any question, and nothing is changed", async () => {
    const h = home();
    mkdirSync(join(h, "config"), { recursive: true });
    const bad = "version: 1\ntemplates: { t: { title: T, sections: [{ id: a, type: bogus }] } }\n";
    writeFileSync(join(h, "config", "report-templates.yaml"), bad);
    const { ctx, prompt } = ctxFor(h, []);
    expect(await stepBranding(ctx)).toMatchObject({ outcome: "failed", message: expect.stringMatching(/report-templates\.yaml first.*nothing was changed/) });
    expect(prompt.asked).toEqual([]);
    expect(readFileSync(join(h, "config", "report-templates.yaml"), "utf8")).toBe(bad);
  });

  it("a bad logo is refused with the reason and asked again", async () => {
    const h = home();
    writeFileSync(join(h, "fake.png"), "not an image");
    const { ctx, prompt } = ctxFor(h, ["Acme", "fake.png", "-", "", "", "", false, "", ["pdf"], "save"], { preview: false });
    await stepBranding(ctx);
    expect(prompt.asked.filter((q) => q.startsWith("Logo file"))).toHaveLength(2);
    expect((ctx.ui as ReturnType<typeof recordingUi>).events).toContainEqual(expect.stringMatching(/^fail: .*isn't a PNG or JPEG/));
    expect(loadTemplates({ homeDir: h }).branding.logo).toBeUndefined();
  });

  it("the starter file stays valid YAML for the step to edit", () => {
    expect(validateTemplateText(STARTER_YAML).valid).toBe(true);
    expect(asResolvedBranding("/h", { logo: "branding/logo.png" }).logo).toMatchObject({ path: "branding/logo.png", resolved: "/h/branding/logo.png" });
  });
});
