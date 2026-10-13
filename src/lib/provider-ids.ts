/**
 * The SEO data provider ids and the default-provider resolution (Phase 9).
 * Pure and dependency-free, so config.ts, clients.yaml parsing and report
 * sections can use it without importing the provider layer (src/providers/seo-data.ts
 * re-exports everything here).
 */
import { isUnsetValue } from "./env.js";

export const PROVIDER_IDS = ["dataforseo", "ahrefs", "semrush"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Display names, for messages and the wizard. */
export const PROVIDER_LABELS: Record<ProviderId, string> = { dataforseo: "DataForSEO", ahrefs: "Ahrefs", semrush: "Semrush" };

export const isProviderId = (v: unknown): v is ProviderId => typeof v === "string" && (PROVIDER_IDS as readonly string[]).includes(v);

/** Where the default provider's value came from: the process env (shell or a Claude Desktop bundle), the home's .env, or nothing. */
export type DefaultProviderSource = "env" | "envFile" | "default";

export type DefaultProvider =
  | { ok: true; provider: ProviderId; source: DefaultProviderSource }
  | {
      ok: false;
      /** Safe to show: the value itself only when it looks like a word (displayProviderValue), else "(hidden, N characters)". */
      invalidValue: string;
      message: string;
    };

const HIDDEN_RE = /^\(hidden, \d+ characters\)$/;

/**
 * An invalid SEO_DATA_PROVIDER as it may be shown (stderr, setup_status, tool errors, the model).
 * A key pasted into the bundle's provider field must not travel on, so only a short word-like value
 * (letters, digits, `_`, `-`, up to 20) is echoed; anything else is "(hidden, N characters)".
 */
export function displayProviderValue(value: string): string {
  // Idempotent: an already-hidden marker stays as it is.
  return /^[A-Za-z0-9_-]{1,20}$/.test(value) || HIDDEN_RE.test(value) ? value : `(hidden, ${Array.from(value).length} characters)`;
}

/** The displayed value quoted for a message: `"moz"`, or the hidden marker as is. */
export const quoteProviderValue = (shown: string): string => (HIDDEN_RE.test(shown) ? shown : JSON.stringify(shown));

/** The invalid-default message, from an already-displayable value. */
export function invalidProviderMessage(shown: string): string {
  return `SEO_DATA_PROVIDER is ${quoteProviderValue(shown)}, which isn't a provider crawlmark knows. Use dataforseo, ahrefs or semrush, or leave it blank for dataforseo.`;
}

/**
 * The default SEO data provider from the raw SEO_DATA_PROVIDER value (D11). Blank,
 * whitespace and a leftover `${user_config.x}` placeholder mean dataforseo (source
 * `default`). A known id matches ignoring case and surrounding spaces. Anything
 * else is `{ ok: false }` with a message naming the allowed values; it never throws,
 * so a typo in a bundle field can't stop the server.
 */
export function resolveDefaultProvider(input: { raw: string | undefined; source: DefaultProviderSource }): DefaultProvider {
  if (isUnsetValue(input.raw)) return { ok: true, provider: "dataforseo", source: "default" };
  const value = input.raw!.trim();
  const id = value.toLowerCase();
  if (isProviderId(id)) return { ok: true, provider: id, source: input.source };
  const shown = displayProviderValue(value);
  return { ok: false, invalidValue: shown, message: invalidProviderMessage(shown) };
}

/**
 * The chosen provider can't serve a capability (wrong key, no DataForSEO for SERPs,
 * an invalid default). Thrown before any request or budget check. Report sections
 * mark it `unavailable: true` (src/reports/section.ts).
 */
export class ProviderUnavailableError extends Error {
  override name = "ProviderUnavailableError";
  constructor(
    readonly capability: string,
    readonly chosen: ProviderId | null,
    message: string,
  ) {
    super(message);
  }
}
