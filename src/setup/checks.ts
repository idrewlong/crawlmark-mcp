/** Live credential checks the wizard runs before saving anything. */

export const PSI_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
/** PageSpeed runs a real Lighthouse on Google's side, which can take a while. */
const PSI_TIMEOUT_MS = 90_000;

export type PsiCheck = { ok: true; note?: string } | { ok: false; problem: string };

/** Classify a PageSpeed response. Pure. Only a key problem fails: a 5xx means the key was accepted but the test page failed. */
export function classifyPsiResponse(status: number, body: string): PsiCheck {
  if (status >= 200 && status < 300) return { ok: true };
  let message = "";
  let reason = "";
  try {
    const j = JSON.parse(body) as { error?: { message?: string; status?: string; details?: { reason?: string }[]; errors?: { reason?: string }[] } };
    message = j.error?.message ?? "";
    reason = [j.error?.status, ...(j.error?.details ?? []).map((d) => d.reason), ...(j.error?.errors ?? []).map((e) => e.reason)].filter(Boolean).join(" ");
  } catch {
    /* not JSON */
  }
  const text = `${reason} ${message}`;
  if (/API_KEY_INVALID|API key not valid|keyInvalid/i.test(text)) return { ok: false, problem: "Google says the API key isn't valid. Copy it again from APIs & Services > Credentials." };
  if (/SERVICE_DISABLED|accessNotConfigured|has not been used|is disabled/i.test(text)) {
    return { ok: false, problem: "The PageSpeed Insights API isn't enabled for the key's project. Enable it at https://console.cloud.google.com/apis/library/pagespeedonline.googleapis.com and try again." };
  }
  if (/API_KEY_SERVICE_BLOCKED|API_KEY_HTTP_REFERRER_BLOCKED|API_KEY_IP_ADDRESS_BLOCKED|blocked/i.test(text)) {
    return { ok: false, problem: "The key's restrictions block PageSpeed Insights from this machine. Edit the key under APIs & Services > Credentials (allow the PageSpeed Insights API; no referrer restriction)." };
  }
  if (status === 429) return { ok: false, problem: "PageSpeed Insights quota exceeded for this key. Try again later." };
  if (status >= 500) return { ok: true, note: `The key was accepted, but the test run failed on Google's side (HTTP ${status}).` };
  return { ok: false, problem: `PageSpeed Insights returned HTTP ${status}${message ? `: ${message.slice(0, 200)}` : ""}.` };
}

/** One PageSpeed request for https://example.com/ with the key. The key is sent only in the query string and never printed. */
export async function checkPsiKey(key: string, fetchImpl: typeof fetch = fetch): Promise<PsiCheck> {
  const qs = new URLSearchParams({ url: "https://example.com/", category: "PERFORMANCE", strategy: "MOBILE", key });
  try {
    const res = await fetchImpl(`${PSI_ENDPOINT}?${qs}`, { signal: AbortSignal.timeout(PSI_TIMEOUT_MS) });
    return classifyPsiResponse(res.status, await res.text());
  } catch (err) {
    // Network errors from fetch don't include the URL, but don't risk it: report the error class only.
    const name = err instanceof Error ? err.name : "Error";
    return { ok: false, problem: `Couldn't reach PageSpeed Insights (${name === "TimeoutError" ? "timed out" : name}). Check your connection and try again.` };
  }
}
