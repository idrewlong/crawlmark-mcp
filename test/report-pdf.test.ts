import { describe, expect, it, vi } from "vitest";
import { footerTemplate, printOnPage, type PdfPage, type PdfRequest } from "../src/reports/render/pdf.js";

function fakePage() {
  let handler: ((r: PdfRequest) => void) | undefined;
  const page = {
    js: true,
    intercept: false,
    content: "",
    pdfOpts: undefined as Record<string, unknown> | undefined,
    setJavaScriptEnabled: vi.fn(async function (this: unknown, on: boolean) {
      page.js = on;
    }),
    setRequestInterception: vi.fn(async (on: boolean) => {
      page.intercept = on;
    }),
    on: vi.fn((_e: "request", h: (r: PdfRequest) => void) => {
      handler = h;
    }),
    setContent: vi.fn(async (html: string) => {
      page.content = html;
    }),
    pdf: vi.fn(async (o: Record<string, unknown>) => {
      page.pdfOpts = o;
      return new TextEncoder().encode("%PDF-1.7 fake");
    }),
    request(url: string) {
      const r = { url: () => url, isInterceptResolutionHandled: () => false, abort: vi.fn(async () => undefined), continue: vi.fn(async () => undefined) };
      handler!(r);
      return r;
    },
  };
  return page;
}

describe("PDF printing", () => {
  it("turns JavaScript off before loading, aborts every non-data: request, and follows the paper size", async () => {
    const page = fakePage();
    const pdf = await printOnPage(page as unknown as PdfPage, "<p>hi</p>", { paper: "A4", footer: "Prepared by <Example Agency>" });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(page.js).toBe(false);
    expect(page.setJavaScriptEnabled.mock.invocationCallOrder[0]!).toBeLessThan(page.setContent.mock.invocationCallOrder[0]!);
    expect(page.intercept).toBe(true);
    for (const url of ["https://example.com/x.png", "http://127.0.0.1/", "file:///etc/passwd", "ws://example.com/", "chrome://settings"]) {
      const r = page.request(url);
      expect(r.abort, url).toHaveBeenCalled();
      expect(r.continue, url).not.toHaveBeenCalled();
    }
    const data = page.request("data:image/png;base64,AAAA");
    expect(data.continue).toHaveBeenCalled();
    expect(page.pdfOpts).toMatchObject({ format: "A4", printBackground: true, displayHeaderFooter: true, margin: { top: "15mm" } });
    expect(String(page.pdfOpts!.footerTemplate)).toContain("Prepared by &lt;Example Agency&gt;");
    await printOnPage(page as unknown as PdfPage, "<p/>", { paper: "Letter", footer: "" });
    expect(page.pdfOpts).toMatchObject({ format: "Letter" });
  });

  it("the footer shows page n of m", () => {
    expect(footerTemplate("x")).toMatch(/page <span class="pageNumber"><\/span> of <span class="totalPages"><\/span>/);
  });
});
