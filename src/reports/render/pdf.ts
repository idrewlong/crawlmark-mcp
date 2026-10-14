/**
 * PDF through the Chrome crawlmark already manages (D5): a fresh page with
 * JavaScript off and every request aborted except data: URLs, so the report
 * renders offline from toHtml's self-contained output. The printer is injected
 * (PdfPrinter) so unit tests never start Chrome; printOnPage takes a page-like
 * object so the offline rules are tested with a fake page.
 */
import type { Browser } from "puppeteer";
import { withBrowser } from "../../providers/browser.js";
import { escapeHtml } from "./escape.js";

export type Paper = "Letter" | "A4";
export interface PdfOptions {
  paper: Paper;
  /** Footer text left of "Page n of m". */
  footer: string;
  signal?: AbortSignal | undefined;
}
export type PdfPrinter = (html: string, opts: PdfOptions) => Promise<Buffer>;

/** The subset of puppeteer's Page that printing needs. */
export interface PdfPage {
  setJavaScriptEnabled(enabled: boolean): Promise<void>;
  setRequestInterception(on: boolean): Promise<void>;
  on(event: "request", handler: (req: PdfRequest) => void): unknown;
  setContent(html: string, opts: { waitUntil: "load"; timeout: number }): Promise<void>;
  pdf(opts: Record<string, unknown>): Promise<Uint8Array>;
}
export interface PdfRequest {
  url(): string;
  isInterceptResolutionHandled(): boolean;
  abort(reason?: string): Promise<void>;
  continue(): Promise<void>;
}

const MARGIN = "15mm";
const CONTENT_TIMEOUT_MS = 30_000;

const TEMPLATE_STYLE = "font-size:8px;width:100%;padding:0 15mm;color:#7b8794;font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;display:flex;justify-content:space-between;gap:12px";

export function footerTemplate(footer: string): string {
  return `<div style="${TEMPLATE_STYLE}"><span>${escapeHtml(footer)}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;
}

/** Print `html` on an open page: no JavaScript, no network (only data: URLs load). */
export async function printOnPage(page: PdfPage, html: string, opts: Omit<PdfOptions, "signal">): Promise<Buffer> {
  await page.setJavaScriptEnabled(false);
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (req.isInterceptResolutionHandled()) return;
    if (req.url().startsWith("data:")) void req.continue();
    else void req.abort("blockedbyclient");
  });
  await page.setContent(html, { waitUntil: "load", timeout: CONTENT_TIMEOUT_MS });
  const pdf = await page.pdf({
    format: opts.paper,
    printBackground: true,
    margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    displayHeaderFooter: true,
    // The running header is a CSS page-margin box in the HTML (so it can skip the first page).
    headerTemplate: "<span></span>",
    footerTemplate: footerTemplate(opts.footer),
  });
  return Buffer.from(pdf);
}

/** The real printer: puppeteer's guarded Chrome, closed afterwards (and on timeout or abort). */
export const chromePdfPrinter: PdfPrinter = (html, opts) =>
  withBrowser("PDF report", opts.signal, async (browser: Browser) => {
    const page = await browser.newPage();
    return printOnPage(page as unknown as PdfPage, html, opts);
  });

/** The hint for a failed PDF (usually Chrome not installed), as setup_status gives it. */
export const PDF_CHROME_HINT = "PDF needs Chrome: run `npx puppeteer browsers install chrome-headless-shell` or set CHROME_PATH (setup status shows the Chrome check).";
