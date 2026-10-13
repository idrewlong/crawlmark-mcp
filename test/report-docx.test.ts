import JSZip from "jszip";
import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import { buildReportDoc } from "../src/reports/render/doc.js";
import { toDocx } from "../src/reports/render/docx.js";
import { fit, imageSize, sniffImage } from "../src/reports/render/image.js";
import { fakeDeps, client } from "./fixtures/reports/deps.js";
import { fixtureReport, TINY_PNG } from "./fixtures/reports/report.js";

/** Strict-enough well-formedness: balanced tags, valid entity references, no stray `<`. */
function assertWellFormed(xml: string, name: string) {
  const body = xml.replace(/^<\?xml[^?]*\?>/, "");
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>|<|&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    if (m[2] === undefined) throw new Error(`${name}: stray "${m[0]}" at ${m.index}: ${body.slice(m.index, m.index + 60)}`);
    if (m[4]) continue;
    if (m[1]) {
      const open = stack.pop();
      if (open !== m[2]) throw new Error(`${name}: </${m[2]}> closes <${open}>`);
    } else stack.push(m[2]);
  }
  expect(stack, name).toEqual([]);
}

async function unzip(buf: Buffer) {
  const zip = await JSZip.loadAsync(buf);
  const files = Object.keys(zip.files).filter((f) => !zip.files[f]!.dir);
  const text = async (f: string) => zip.file(f)!.async("string");
  return { zip, files, text };
}

describe("DOCX renderer", () => {
  it("writes a valid package: parts, content types, well-formed XML, headings, tables, lists, footer", async () => {
    const doc = buildReportDoc(await fixtureReport(), { version: "0.1.0", narrative: { summary: "Clicks grew **12%**.\n\n- One\n- Two", sections: { search: "Good month." } } });
    const buf = await toDocx(doc);
    expect(buf.subarray(0, 2).toString()).toBe("PK");
    const { files, text } = await unzip(buf);
    for (const part of ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml", "word/_rels/document.xml.rels", "word/numbering.xml", "docProps/core.xml"]) expect(files).toContain(part);
    const types = await text("[Content_Types].xml");
    for (const f of files.filter((f) => f.endsWith(".xml") && f !== "[Content_Types].xml")) {
      const ext = f.split(".").pop();
      expect(types.includes(`PartName="/${f}"`) || types.includes(`Extension="${ext}"`), f).toBe(true);
    }
    for (const f of files.filter((f) => f.endsWith(".xml") || f.endsWith(".rels"))) assertWellFormed(await text(f), f);
    const xml = await text("word/document.xml");
    const $ = cheerio.load(xml, { xml: true });
    expect($("w\\:pStyle[w\\:val='Heading2']").length).toBeGreaterThan(10);
    expect($("w\\:tbl").length).toBeGreaterThan(10);
    expect($("w\\:numPr").length).toBeGreaterThan(5);
    expect(xml).toContain("Commentary written with Claude; all figures come from the data below.");
    expect(xml).toContain("Clicks grew ");
    expect(files.some((f) => f.startsWith("word/media/"))).toBe(false);
    expect(files.some((f) => /^word\/footer\d*\.xml$/.test(f))).toBe(true);
    expect(xml).toContain('w:w="12240"');
  });

  it("puts the logo in word/media only when configured, and A4 when asked", async () => {
    const doc = buildReportDoc(await fixtureReport(), { version: "0.1.0", branding: { agencyName: "Example Agency", paper: "A4" }, logo: { mime: "image/png", data: TINY_PNG } });
    const { files, text } = await unzip(await toDocx(doc));
    expect(files.filter((f) => f.startsWith("word/media/"))).toHaveLength(1);
    expect(await text("word/document.xml")).toContain('w:w="11906"');
  });

  it("drops control characters and keeps markup from data as text", async () => {
    const deps = fakeDeps({
      gscQuery: async () => [
        { keys: ["<w:p>x</w:p> & <img src=x onerror=alert(1)>"], clicks: 5, impressions: 10, ctr: 50, position: 2 },
        { keys: ["bidi \u202eexe\u0007bell\u0000nul\ufffe"], clicks: 4, impressions: 10, ctr: 40, position: 3 },
      ],
    });
    const doc = buildReportDoc(await fixtureReport({ include: [] }, deps, { ...client, name: "Evil \u202e]]> Co" } as typeof client), { version: "0.1.0" });
    const { files, text } = await unzip(await toDocx(doc));
    for (const f of files.filter((f) => f.endsWith(".xml"))) {
      const x = await text(f);
      assertWellFormed(x, f);
      expect(x).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u202e\ufffe]/);
    }
    const xml = await text("word/document.xml");
    expect(xml).toContain("&lt;w:p&gt;x&lt;/w:p&gt; &amp; &lt;img src=x onerror=alert(1)&gt;");
    expect(xml).toContain("bidi exebellnul");
  });
});

describe("image helper", () => {
  it("detects PNG and JPEG and reads their size", () => {
    expect(sniffImage(TINY_PNG)).toBe("image/png");
    expect(imageSize(TINY_PNG)).toEqual({ width: 2, height: 1 });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x40, 0x03, 0, 0, 0, 0, 0, 0]);
    expect(sniffImage(jpeg)).toBe("image/jpeg");
    expect(imageSize(jpeg)).toEqual({ width: 64, height: 32 });
    expect(sniffImage(Buffer.from("GIF89a....................."))).toBeUndefined();
    expect(fit({ width: 1000, height: 100 }, 200, 56)).toEqual({ width: 200, height: 20 });
  });
});
