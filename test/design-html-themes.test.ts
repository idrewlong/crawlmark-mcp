/**
 * Release 0.4.0 T1: the HTML and PDF themes. Cards is guarded by the byte-identity goldens (design-compat); every
 * other theme gets a CSS-block snapshot plus targeted assertions. Fixture data only (example.com).
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrast } from "../src/reports/render/color.js";
import { buildReportDoc } from "../src/reports/render/doc.js";
import { CSP, fontStacks, toHtml } from "../src/reports/render/html.js";
import { footerFont } from "../src/reports/render/pdf.js";
import { htmlTheme } from "../src/reports/render/themes/html-themes.js";
import { THEME_IDS, type ThemeId } from "../src/reports/templates/schema.js";
import { layoutReport, XSS } from "./fixtures/reports/release-b-render.js";
import { fixtureReport } from "./fixtures/reports/report.js";

const OTHERS = THEME_IDS.filter((t) => t !== "cards") as ThemeId[];
const DEFAULT_FOOTER_FONT = "system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const SNAP =join(import.meta.dirname, "fixtures", "reports", "__snapshots__", "themes");
const render = async (branding: Record<string, unknown>, theme?: ThemeId, layout = false) => {
  const report = layout ? await layoutReport() : await fixtureReport();
  return toHtml(buildReportDoc(report, { version: "0.4.0", branding: branding as never, ...(theme ? { theme } : {}) }));
};
/** The text from the theme marker to the end of <style>. */
const block = (html: string, id: string) => {
  const from = html.indexOf(`/* theme: ${id} */`);
  return html.slice(from, html.indexOf("</style>", from));
};

describe("theme CSS in the HTML", () => {
  it("bold through the branding emits its block and variables", async () => {
    const html = await render({ theme: "bold" });
    expect(html).toContain("/* theme: bold */");
    expect(html).toContain("--dark:");
  });

  it("cards (and no theme) adds nothing", async () => {
    for (const html of [await render({}), await render({}, "cards"), await render({ theme: "cards" })]) {
      expect(html).not.toContain("/* theme:");
    }
  });

  it("the block sits last in <style>, after the font block", async () => {
    const html = await render({ primaryColor: "#224466" }, "editorial", true);
    expect(html.indexOf("--font-body")).toBeGreaterThan(-1);
    expect(html.indexOf("--font-body")).toBeLessThan(html.indexOf("/* theme: editorial */"));
    expect(html.indexOf("/* theme: editorial */")).toBeGreaterThan(html.indexOf("@media print { .page-break"));
  });

  it.each(OTHERS)("%s: CSS-block snapshot", async (id) => {
    const html = await render({ primaryColor: "#224466", accentColor: "#cc6600" }, id, true);
    await expect(block(html, id)).toMatchFileSnapshot(join(SNAP, `${id}.css.txt`));
  });

  it("the onepage block is added for onepage layouts only", async () => {
    const report = await fixtureReport({ template: "executive", include: [] });
    for (const id of ["editorial", "bold", "consulting", "friendly"] as const) {
      const doc = buildReportDoc(report, { version: "0.4.0", theme: id });
      expect(doc.meta.layout).toBe("onepage");
      expect(block(toHtml(doc), id)).toContain(htmlTheme(id).onepageCss.trim().split("\n")[0]!);
      expect(block(await render({}, id), id)).not.toContain(htmlTheme(id).onepageCss.trim().split("\n")[0]!);
    }
  });
});

describe("theme CSS rules", () => {
  it("has no literal font names, imports, urls or hosts", () => {
    for (const id of OTHERS) {
      const t = htmlTheme(id);
      for (const css of [t.css, t.onepageCss]) {
        expect(css.match(/font-family:(?!\s*var\()/g), `${id} font-family`).toBeNull();
        expect(css, id).not.toMatch(/@import|url\(|https?:|\/\//);
      }
      if (t.fonts) {
        expect(t.fonts.body + t.fonts.heading, id).not.toMatch(/@import|url\(|http/);
      }
    }
  });

  it("the CSP meta is unchanged for every theme", async () => {
    const base = await render({});
    const csp = (h: string) => /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(h)![1];
    for (const id of THEME_IDS) expect(csp(await render({}, id))).toBe(csp(base));
    expect(csp(base)).toBe(CSP);
  });

  it("editorial and friendly contents items use padding, not margin, so both columns start level", () => {
    for (const id of ["editorial", "friendly"] as const) {
      const css = htmlTheme(id).css;
      const li = /\.contents li \{([^}]*)\}/.exec(css)![1]!;
      expect(li, id).toMatch(/margin: 0;/);
      expect(li, id).toMatch(/padding: 2\.5px 0;/);
      expect(css, id).toMatch(/\.contents ol \{[^}]*margin: 0;/);
      expect(css, id).toMatch(/@media \(max-width: 640px\)[^\n]*\.contents ol \{ columns: 1; \}/);
    }
  });

  it("editorial keeps tables, charts and sub-headings out of the summary's two columns", () => {
    expect(htmlTheme("editorial").css).toContain(".summary table, .summary figure, .summary .table-wrap, .summary h4 { column-span: all; }");
  });

  it("consulting's summary label spans any number of rows", () => {
    const css = htmlTheme("consulting").css;
    expect(css).toContain("grid-row: 1 / span 200");
    expect(css).toContain(".summary > :not(h2) { grid-column: 2; }");
    expect(css).not.toContain("span 9");
    expect(css).toMatch(/@media \(max-width: 640px\)[^\n]*\.summary \{ display: block; \}/);
  });

  it("friendly's headings on tinted fills use the tint ink", () => {
    const css = htmlTheme("friendly").css;
    expect(css).toMatch(/\.card h2 \{[^}]*color: var\(--tint-ink\)/);
    expect(css).toMatch(/\.contents h2, \.summary h2 \{ color: var\(--tint-ink\)/);
    expect(css).toMatch(/\.commentary \.label \{[^}]*color: var\(--tint-ink\)/);
  });
});

describe("palette-derived variables", () => {
  it("bold with a light primary keeps white text on the derived dark band", async () => {
    const html = await render({ primaryColor: "#ffd400" }, "bold");
    const v = (n: string) => new RegExp(`--${n}: (#[0-9a-f]{6})`).exec(block(html, "bold"))![1]!;
    expect(v("on-dark")).toBe("#ffffff");
    expect(contrast(v("on-dark"), v("dark"))).toBeGreaterThanOrEqual(12);
    expect(block(html, "bold")).toMatch(/\.cover \{[^}]*color: var\(--on-dark\)/);
  });

  it("friendly derives its tints from the primary colour", async () => {
    const a = block(await render({ primaryColor: "#2e7d32" }, "friendly"), "friendly");
    const b = block(await render({ primaryColor: "#7a1f1f" }, "friendly"), "friendly");
    expect(a).not.toBe(b);
    for (const n of ["surface", "zebra", "tint", "tint-ink", "warm", "chip-bg", "on-chip-soft"]) expect(a).toMatch(new RegExp(`--${n}: #[0-9a-f]{6}`));
  });
});

describe("fonts", () => {
  const FONTS = { body: null, heading: null, fallback: "sans-serif" } as const;

  it("cards keeps the 0.3.0 rules (null with no font setting)", () => {
    expect(fontStacks(FONTS)).toBeNull();
    expect(fontStacks(FONTS, "cards")).toBeNull();
    expect(fontStacks({ ...FONTS, body: "Inter" })!.body).toMatch(/^"Inter", system-ui/);
  });

  it("every other theme always has stacks, with the theme's own tails", () => {
    expect(fontStacks(FONTS, "editorial")!.body).toBe(htmlTheme("editorial").fonts!.body);
    expect(fontStacks(FONTS, "editorial")!.heading).toMatch(/^"Iowan Old Style"/);
    expect(fontStacks(FONTS, "friendly")!.body).toMatch(/^"Avenir Next", Nunito/);
    expect(fontStacks(FONTS, "minimal")!.body).toMatch(/^"Helvetica Neue", Helvetica/);
  });

  it("branding names go in front of the theme's tails; the heading falls back to the body name", () => {
    const s = fontStacks({ body: "Inter", heading: "Merriweather", fallback: "sans-serif" }, "editorial")!;
    expect(s.body).toMatch(/^"Inter", Georgia, /);
    expect(s.heading).toMatch(/^"Merriweather", "Iowan Old Style", /);
    const onlyBody = fontStacks({ body: "Inter", heading: null, fallback: "sans-serif" }, "editorial")!;
    expect(onlyBody.heading).toMatch(/^"Inter", "Iowan Old Style", /);
  });

  it("a serif fallback replaces both tails", () => {
    const s = fontStacks({ body: "Inter", heading: null, fallback: "serif" }, "bold")!;
    expect(s.body).toBe('"Inter", Georgia, Cambria, "Times New Roman", Times, serif');
    expect(s.heading).toBe(s.body);
  });

  it("the HTML carries the resolved stacks in the font block", async () => {
    const html = await render({ bodyFont: "Inter", headingFont: "Merriweather" }, "editorial");
    expect(html).toContain('--font-body: "Inter", Georgia, Cambria');
    expect(html).toContain('--font-heading: "Merriweather", "Iowan Old Style"');
  });

  it("hostile font names stay escaped", () => {
    const s = fontStacks({ body: 'x";}</style><script>', heading: null, fallback: "sans-serif" }, "bold")!;
    expect(s.body).not.toMatch(/<|>|;\}/);
  });
});

describe("PDF footer font", () => {
  const FONTS = { body: null, heading: null, fallback: "sans-serif" } as const;
  it("friendly starts with Avenir Next, in single quotes", () => {
    expect(footerFont(FONTS, "friendly")).toMatch(/^'Avenir Next', Nunito/);
  });
  it("cards with no fonts is the default footer stack", () => {
    expect(footerFont(FONTS, "cards")).toBe(DEFAULT_FOOTER_FONT);
    expect(footerFont(FONTS)).toBe(DEFAULT_FOOTER_FONT);
  });
  it("branding fonts lead the theme's stack", () => {
    expect(footerFont({ ...FONTS, body: "Inter" }, "editorial")).toMatch(/^'Inter', Georgia/);
  });
});

describe("hostile text is inert in every theme", () => {
  it.each(THEME_IDS as readonly ThemeId[])("%s", async (id) => {
    const report = await fixtureReport();
    report.client = { ...report.client, name: XSS };
    report.template.cover = { subtitle: XSS };
    const sec = report.sections[0]!;
    sec.title = XSS;
    const html = toHtml(buildReportDoc(report, { version: "0.4.0", theme: id }));
    expect(html).not.toContain(XSS);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});

describe("explicit sans-serif fallback", () => {
  it("switches a serif theme's tails to the sans stack only when branding sets fontFallback", async () => {
    const { fontStacks } = await import("../src/reports/render/html.js");
    const unset = fontStacks({ body: null, heading: null, fallback: "sans-serif" }, "editorial")!;
    const set = fontStacks({ body: null, heading: null, fallback: "sans-serif", fallbackSet: true }, "editorial")!;
    expect(unset.heading).toMatch(/serif$/);
    expect(unset.heading).not.toBe(set.heading);
    expect(set.body).toBe(set.heading);
    expect(set.body).toMatch(/sans-serif$/);
  });
});
