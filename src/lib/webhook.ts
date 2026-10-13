import { assertSafeUrl } from "./url-guard.js";

export const WEBHOOK_TIMEOUT_MS = 10_000;

export type WebhookOutcome = { sent: true; status: number } | { sent: false; reason: string } | { sent: false; error: string };

type FetchLike = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;

/**
 * POST `{ "text": ... }` to an incoming webhook. Does nothing without a URL or
 * without text (no alerts). https only unless ALLOW_PRIVATE_URLS is set. Never
 * throws: a failed delivery is returned so the caller can report it. Error
 * messages leave out the URL, which usually embeds a secret token.
 */
export async function sendWebhook(
  url: string | undefined,
  text: string,
  opts: { fetch?: FetchLike; env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<WebhookOutcome> {
  if (!url) return { sent: false, reason: "ALERT_WEBHOOK_URL is not set" };
  if (!text) return { sent: false, reason: "no alerts" };
  const env = opts.env ?? process.env;
  try {
    const parsed = await assertSafeUrl(url, env);
    if (parsed.protocol !== "https:" && (env.ALLOW_PRIVATE_URLS ?? "").trim().toLowerCase() !== "true") {
      return { sent: false, error: "ALERT_WEBHOOK_URL must be https (set ALLOW_PRIVATE_URLS=true for local testing)." };
    }
    const doFetch: FetchLike = opts.fetch ?? ((u, init) => fetch(u, init));
    const res = await doFetch(parsed.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      redirect: "error",
      signal: AbortSignal.timeout(opts.timeoutMs ?? WEBHOOK_TIMEOUT_MS),
    });
    return res.ok ? { sent: true, status: res.status } : { sent: false, error: `Webhook returned HTTP ${res.status}.` };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") return { sent: false, error: "Webhook timed out." };
    // Fetch errors can embed the URL (and its token), so only url-guard messages are passed through.
    const m = err instanceof Error ? err.message : "";
    const msg = m.startsWith("Not a valid URL") ? "ALERT_WEBHOOK_URL is not a valid URL." : /^(Only http|Refusing)/.test(m) ? m : "Webhook request failed.";
    return { sent: false, error: msg };
  }
}
