import puppeteer from "puppeteer";

/**
 * Chrome path shared by Lighthouse and axe. Uses CHROME_PATH if set,
 * otherwise the Chrome that puppeteer downloaded on install.
 */
export async function chromePath(): Promise<string> {
  return process.env.CHROME_PATH || (await puppeteer.executablePath());
}

export const CHROME_FLAGS = ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"];
